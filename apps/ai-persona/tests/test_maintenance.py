"""Unified maintenance boundaries and real proposal publication, without provider calls."""

from __future__ import annotations

import copy
import json
import shutil

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError
from ai_persona.ai_service import PersonaAIService
from ai_persona.compiler import PersonaCompiler
from ai_persona.maintenance.compiler import compile_candidates
from ai_persona.maintenance.contracts import Finish, MaintenanceInput
from ai_persona.maintenance.runner import MaintenanceReader, loop
from ai_persona.maintenance.service import attach, update_input
from ai_persona.maintenance.tools import ToolRegistry
from ai_persona.models import Evidence, Material
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state


class Model:
    def __init__(self, *outputs):
        self.outputs, self.calls = list(outputs), []

    def generate(self, task, system, payload, **kwargs):
        self.calls.append(copy.deepcopy(payload))
        result = self.outputs.pop(0)
        if isinstance(result, Exception):
            raise result
        result = result(payload) if callable(result) else result
        return {"text": json.dumps(result)}


def candidate(payload, *, entity_type="preference", values=None, **kwargs):
    basis = payload["source_content"][-1]["data"]["basis_ref"]
    return dict(
        client_ref="p1",
        operation="create",
        entity_type=entity_type,
        values=values
        or {"instruction": "解释公式时先定义符号。", "scope": "global", "behavior": "preferred"},
        reason="用户明确要求",
        basis=[{"ref": basis}],
        **kwargs,
    )


def proposed(*changes):
    return {
        "result": {
            "kind": "propose",
            "summary": "已准备候选，等待人工审核。",
            "changes": list(changes),
        }
    }


def start(service, spec, message="解释公式时先定义符号。"):
    value = service.create_session(maintenance=spec)
    value = service.begin(value["id"], message, value["version"])
    return service.generate(value["id"], value["run_id"])


def test_proposal_evidence_and_publication_only_after_review(workspace):
    data, state = workspace
    before = PersonaStore(data).load()
    service = PersonaAIService(data, state, Model(lambda p: proposed(candidate(p))))
    value = start(service, {"target_types": ["preference"]})
    assert value["status"] == "submitted", value.get("error")
    proposal = ProposalRepository(data).get(value["submission"]["proposals"][0]["proposal_id"])
    assert proposal.confidence is None
    assert proposal.proposal_context.kind == "maintenance"
    assert proposal.evidence_candidates[0].evidence_kind == "explicit_user_statement"
    current = PersonaStore(data).load()
    assert current.config.revision == before.config.revision
    assert set(current.records) == set(before.records)
    app = create_app(data, state)
    with TestClient(app) as client:
        assert client.get("/review/" + proposal.id).status_code == 200
    ProposalService(data, state).accept(proposal.id)
    published = PersonaStore(data).load()
    assert proposal.target_id in published.records
    assert any(proposal.target_id in e.supports for e in published.of_type(Evidence))
    assert service.get_session(value["id"])["can_refine"] is False


def test_multiple_sources_can_remain_independent_of_material(workspace):
    data, state = workspace
    model = Model(
        lambda p: {"calls": [{"name": "read_source", "arguments": {"source_id": source["source_id"], "file_id": source["file_id"], "view":"text", "selector":{"lines":{"start":1,"end":1}}, "max_chars":12000}} for source in p["sources"] if source["origin"]["kind"] != "user_statement"]},
        lambda p: proposed(
            candidate(
                p,
                entity_type="knowledge_node",
                values={
                    "title": "New maintenance concept",
                    "summary": "A scoped definition.",
                    "semantic_role": "concept",
                },
            )
            | {"basis": [{"ref": r["data"]["basis_ref"]} for r in [json.loads(m["content"])["result"] for m in p["tool_results"]]]}
        )
    )
    service = PersonaAIService(data, state, model)
    value = service.create_session(maintenance={"target_types": ["knowledge_node"]})
    for text, title in [
        ("Definition of a concept.", "first.md"),
        ("Limitations of that concept.", "second.txt"),
    ]:
        value = attach(service, value["id"], text, title, value["version"])
    ids = [a["id"] for a in value["attachments"]]
    value = update_input(
        service,
        value["id"],
        {"target_types": ["knowledge_node"], "attachment_ids": ids},
        value["version"],
    )
    before = PersonaStore(data).load()
    value = service.begin(value["id"], "整合参考内容中的概念。", value["version"])
    value = service.generate(value["id"], value["run_id"])
    assert value["status"] == "submitted", value.get("error")
    prop = ProposalRepository(data).get(value["submission"]["proposals"][0]["proposal_id"])
    assert {e.source_id for e in prop.evidence_candidates} == set(ids)
    ProposalService(data, state).accept(prop.id)
    after = PersonaStore(data).load()
    assert len(after.of_type(Material)) == len(before.of_type(Material))
    assert all(e.evidence_kind == "read_signal" for e in prop.evidence_candidates)
    with TestClient(create_app(data, state)) as client:
        assert client.get("/knowledge/" + prop.target_id).status_code == 200


def test_refinement_and_edit_keep_group_and_client_identity(workspace):
    data, state = workspace
    model = Model(
        lambda p: proposed(candidate(p)),
        lambda p: proposed(
            candidate(
                p,
                values={
                    "instruction": "先定义符号，再解释公式。",
                    "scope": "global",
                    "behavior": "preferred",
                },
            )
        ),
    )
    service = PersonaAIService(data, state, model)
    value = start(service, {"target_types": ["preference"]})
    old = value["submission"]
    draft = copy.deepcopy(value["draft"])
    draft["changes"][0]["values"]["instruction"] = "先列出符号定义。"
    value = service.edit(value["id"], draft, value["version"])
    assert value["status"] == "submitted", value.get("error")
    value = service.begin(value["id"], "再补充公式解释。", value["version"])
    value = service.generate(value["id"], value["run_id"])
    assert value["status"] == "submitted", value.get("error")
    assert value["submission"]["change_set_id"] == old["change_set_id"]
    assert value["submission"]["proposals"][0]["client_ref"] == old["proposals"][0]["client_ref"]
    assert (
        model.calls[-1]["previous_draft"]["changes"][0]["values"]["instruction"]
        == "先列出符号定义。"
    )
    assert len(
        [
            p
            for p in ProposalRepository(data).list_pending()
            if p.proposal_context.kind == "maintenance"
        ]
    ) == len(old["proposals"])  # demo pending + same group


def test_scope_and_source_cannot_be_expanded_through_edit(workspace):
    data, state = workspace
    service = PersonaAIService(data, state, Model(lambda p: proposed(candidate(p))))
    value = start(service, {"target_types": ["preference"]})
    draft = copy.deepcopy(value["draft"])
    draft["changes"][0]["entity_type"] = "knowledge_node"
    with pytest.raises(AgentServiceError, match="未选择的类型"):
        service.edit(value["id"], draft, value["version"])
    draft = copy.deepcopy(value["draft"])
    draft["changes"][0]["evidence"][0]["source_id"] = "src_fake"
    with pytest.raises(AgentServiceError, match="未读取"):
        service.edit(value["id"], draft, value["version"])


def test_external_reference_does_not_establish_personal_status(workspace):
    data, state = workspace
    store = PersonaStore(data).load()
    spec = MaintenanceInput(target_types=["preference"])
    result = Finish.model_validate(
        proposed(
            dict(
                client_ref="p",
                operation="create",
                entity_type="preference",
                values={"instruction": "示例偏好"},
                reason="纸面资料",
                basis=[{"ref": "external"}],
            )
        )["result"]
    )
    ledger = {
        "records": {},
        "basis": {
            "external": dict(
                source_id="src_demo_note", file="x.md", line_start=1, line_end=2, kind="attachment"
            )
        },
    }
    with pytest.raises(AgentServiceError, match="偏好需要用户明确"):
        compile_candidates(result, spec, store, ledger)


def test_full_record_reads_and_revision_are_application_owned(workspace):
    data, state = workspace
    store = PersonaStore(data).load()
    reader = MaintenanceReader(data, state, store, {})
    result, _ = reader.call(
        "get_persona_records", {"record_ids": ["kn_demo_tebd"], "fields": ["title"]}
    )
    assert result["ok"] and "kn_demo_tebd" not in reader.ledger["records"]
    result = reader.full_record("kn_demo_tebd")
    assert (
        result["ok"]
        and reader.ledger["records"]["kn_demo_tebd"]
        == store.records["kn_demo_tebd"].record.revision
    )
    with pytest.raises(AgentServiceError, match="本轮 Persona"):
        reader.call("search_preferences", {"expected_persona_revision": 999})
    with pytest.raises(AgentServiceError, match="未知查询工具"):
        ToolRegistry(data, state).call("propose_change_set", {})


def test_resume_reuses_task_sources_after_provider_error(workspace):
    data, state = workspace
    model = Model(AgentServiceError("timeout", "超时"), lambda p: proposed(candidate(p)))
    service = PersonaAIService(data, state, model)
    value = start(service, {"target_types": ["preference"]})
    assert value["status"] == "failed"
    sources = value["message_sources"]
    before_messages = value["messages"]
    value = service.resume(value["id"], value["version"])
    value = service.generate(value["id"], value["run_id"])
    assert value["status"] == "submitted", value.get("error")
    assert value["message_sources"] == sources
    assert value["messages"][:-1] == before_messages


def test_native_loop_preserves_call_id_and_image_in_followup():
    states = []

    def request(state):
        states.append(copy.deepcopy(state))
        if len(states) == 1:
            return {
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolCall",
                            "id": "call123",
                            "name": "read_source",
                            "arguments": {},
                        }
                    ],
                },
                "text": "",
            }
        return {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "finish123",
                        "name": "finish_maintenance",
                        "arguments": {"kind": "no_change", "summary": "无需变化"},
                    }
                ],
            },
            "text": "",
        }

    result = loop(
        request,
        lambda n, a: ({"ok": True}, [{"data": "aW1hZ2U=", "mimeType": "image/png"}]),
        lambda r: r,
    )
    assert result.kind == "no_change"
    tool_result = states[1]["messages"][1]
    assert tool_result["toolCallId"] == "call123" and tool_result["toolName"] == "read_source"
    assert tool_result["content"][1]["type"] == "image"


def test_three_inputs_page_and_attachment_api(workspace):
    data, state = workspace
    app = create_app(data, state)
    headers = {"x-ai-persona": "1"}
    with TestClient(app) as client:
        page = client.get("/ai?material_id=mat_demo_tebd").text
        assert "ai-target-types" in page and "ai-paste" in page and "ai-files" in page
        assert 'id="ai-personal"' not in page
        value = client.post(
            "/api/ai/sessions",
            headers=headers,
            json={"maintenance": {"target_types": ["knowledge_node"]}},
        ).json()
        result = client.post(
            f"/api/ai/sessions/{value['id']}/attachment",
            headers=headers,
            json={"version": value["version"], "text": "A reference", "title": "ref.md"},
        )
        assert result.status_code == 200 and len(result.json()["attachments"]) == 1
        assert client.get("/api/ai/options").status_code == 200


def test_explicit_attachment_collection_requires_material_candidate(workspace):
    data, state = workspace
    service = PersonaAIService(data, state, Model())
    value = service.create_session(maintenance={"target_types": ["knowledge_node", "material"]})
    value = attach(service, value["id"], "Source body.", "source.txt", value["version"])
    sid = value["attachments"][0]["id"]
    spec = MaintenanceInput(
        target_types=["material"], attachment_ids=[sid], collect_attachment_ids=[sid]
    )
    with pytest.raises(AgentServiceError, match="每份选定收录"):
        compile_candidates(
            Finish(kind="no_change", summary="无需变化"),
            spec,
            PersonaStore(data).load(),
            {"records": {}, "basis": {}},
        )


def test_native_provider_without_tools_uses_same_json_loop(workspace):
    class CompatibleModel(Model):
        def step(self, *args, **kwargs):
            raise AgentServiceError("tools_unsupported", "tools not supported")

    service = PersonaAIService(*workspace, CompatibleModel(lambda p: proposed(candidate(p))))
    value = start(service, {"target_types": ["preference"]})
    assert value["status"] == "submitted", value.get("error")
    assert value["checkpoint"]["transport"] == "json"


def test_query_returns_paused_contexts_without_activating_them(workspace):
    data, state = workspace
    proposals = ProposalService(data, state)
    context = proposals.create_record(
        "preference_context",
        {
            "key": "math.explanations",
            "name": "数学解释",
            "description": "解释数学概念和符号。",
            "activation": {"intents": ["解释数学概念"], "excludes": []},
        },
    )
    proposals.accept(context.id)
    proposals.accept(proposals.create_update(context.target_id, {"status": "paused"}).id)
    registry = ToolRegistry(data, state)
    result, _ = registry.call("search_preferences", {"query": "数学符号"})
    assert any(r["id"] == context.target_id for r in result["data"]["items"])
    detail, _ = registry.call("get_preference_records", {"record_ids": [context.target_id]})
    assert detail["data"]["items"][0]["record"]["status"] == "paused"
    assert detail["data"]["items"][0]["completeness"] == "complete"


def test_validation_feedback_can_be_repaired_in_same_loop():
    calls = []

    def request(state):
        calls.append(copy.deepcopy(state))
        return {"terminal": {"kind": "no_change", "summary": "无需变化"}}

    def finish(result):
        if len(calls) == 1:
            raise AgentServiceError("invalid_evidence", "请补充依据")
        return result

    assert loop(request, lambda *a: None, finish).kind == "no_change"
    assert "invalid_evidence" in calls[1]["messages"][0]["content"]


def test_collected_attachment_is_still_review_gated(workspace):
    data, state = workspace

    def material_candidate(payload):
        source = payload["sources"][0]
        return proposed(
            candidate(
                payload,
                entity_type="material",
                values={
                    "title": "Imported reference",
                    "material_type": "note",
                    "source_ref": source["source_id"],
                    "summary": "Reference summary.",
                },
            )
        )

    service = PersonaAIService(data, state, Model(material_candidate))
    value = service.create_session(maintenance={"target_types": ["material"]})
    value = attach(service, value["id"], "Reference text.", "reference.md", value["version"])
    sid = value["attachments"][0]["id"]
    value = update_input(
        service,
        value["id"],
        {
            "target_types": ["material"],
            "attachment_ids": [sid],
            "collect_attachment_ids": [sid],
            "attachment_relationships": {sid: "read"},
        },
        value["version"],
    )
    before = len(PersonaStore(data).load().of_type(Material))
    value = service.begin(value["id"], "同时收录这份参考材料。", value["version"])
    value = service.generate(value["id"], value["run_id"])
    assert value["status"] == "submitted", value.get("error")
    assert len(PersonaStore(data).load().of_type(Material)) == before
    proposal = value["submission"]["proposals"][0]
    ProposalService(data, state).accept(proposal["proposal_id"])
    assert len(PersonaStore(data).load().of_type(Material)) == before + 1


def test_nullable_tool_defaults_are_pinned_by_application(workspace):
    data, state = workspace
    store = PersonaStore(data).load()
    reader = MaintenanceReader(data, state, store, {})
    result, _ = reader.call("search_preferences", {"expected_persona_revision": None})
    assert result["ok"] and result["persona_revision"] == store.config.revision
