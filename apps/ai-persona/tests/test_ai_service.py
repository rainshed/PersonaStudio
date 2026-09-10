from __future__ import annotations

import asyncio
import copy
import json
import shutil
import threading
import time

import pytest
from fastapi.testclient import TestClient
from mcp import Client
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError, PersonaQueryService
from ai_persona.ai_service import PersonaAIService
from ai_persona.compiler import PersonaCompiler
from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.inbox import InboxService
from ai_persona.mcp_server import create_mcp_server
from ai_persona.models import PreferenceContext
from ai_persona.proposals import ProposalDependencyError, ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


class FakeModel:
    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.cancelled = []

    def generate(self, task, system, payload, **kwargs):
        self.calls.append((task, system, copy.deepcopy(payload), kwargs))
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        if callable(output):
            output = output(payload)
        return {"text": json.dumps(output), "modelId": "mock-model", "connectionId": "test"}

    def cancel(self, run_id):
        self.cancelled.append(run_id)


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state


def change(entity_type="preference", operation="create", **kwargs):
    return {
        "entity_type": entity_type,
        "operation": operation,
        "reason": "根据明确的用户维护要求。",
        "confidence": 0.9,
        **kwargs,
    }


def output(*changes, **kwargs):
    return {"reply": "已准备候选，请检查后提交审核。", "changes": list(changes), **kwargs}


def run(service, message="写作时先给结论。", **scope):
    session = service.create_session(**scope)
    running = service.begin(session["id"], message, session["version"])
    return service.generate(session["id"], running["run_id"])


def create_contexts(data, state):
    proposals = ProposalService(data, state)
    for key in ["research.writing", "software.design", "paused.context"]:
        proposed = proposals.create_record(
            "preference_context",
            {
                "key": key,
                "name": key,
                "description": "测试场景 " + key,
                "activation": {"intents": ["完成特定任务"], "excludes": ["只是讨论"]},
            },
        )
        proposals.accept(proposed.id)
        if key == "paused.context":
            proposals.accept(proposals.create_update(proposed.target_id, {"status": "paused"}).id)


def test_activation_full_catalog_multi_match_and_no_full_preferences(workspace):
    data, state = workspace
    create_contexts(data, state)
    fake = FakeModel(
        {
            "contexts": [
                {"key": "research.writing", "matched": True, "reason": "需要完成论文写作"},
                {
                    "key": "software.design",
                    "matched": False,
                    "reason": "本轮没有软件设计任务",
                },
            ]
        }
    )
    service = PersonaAIService(data, state, fake)
    result = service.resolve_persona_activation(
        "帮我完成软件研究的论文",
        task_summary="设计研究",
        recent_messages=[{"role": "user", "content": "接着做"}],
    )
    assert result["decision"] == "match"
    assert result["evaluated_context_count"] == 2
    assert len(result["matched_contexts"]) == 1
    assert "uncertain_contexts" not in result
    assert result["schema_version"] == "ai-persona.activation/v2"
    assert "preferences" not in result and "text" not in result["model_run"]
    assert fake.calls[0][0] == "activation"
    assert len(fake.calls[0][2]["catalog"]) == 2
    assert "paused.context" not in json.dumps(fake.calls[0][2])
    fake.outputs.append(
        {
            "contexts": [
                {"key": c["key"], "matched": False, "reason": "只是询问而非执行"}
                for c in fake.calls[0][2]["catalog"]
            ]
        }
    )
    assert (
        service.resolve_persona_activation("不是让你写论文，只问一个概念")["decision"] == "no_match"
    )
    context = PersonaStore(data).load().of_type(PreferenceContext, active_only=True)[0]
    p = ProposalService(data, state)
    p.accept(p.create_update(context.id, {"description": "已修改触发说明"}).id)
    fake.outputs.append(
        {
            "contexts": [
                {"key": c["key"], "matched": True, "reason": "匹配"}
                for c in fake.calls[0][2]["catalog"]
            ]
        }
    )
    updated = service.resolve_persona_activation("继续")
    assert updated["catalog_version"] != result["catalog_version"]
    assert len(updated["matched_contexts"]) == 2


def test_empty_catalog_does_not_call_model_or_create_draft_database(workspace):
    service = PersonaAIService(*workspace, FakeModel())
    assert service.resolve_persona_activation("hello")["decision"] == "no_match"
    assert not service.model.calls
    assert not (workspace[1] / "ai-assistant.sqlite3").exists()


@pytest.mark.parametrize("request_examples", [[], ["请把这段讨论整理成学术 note。"]])
def test_description_and_request_examples_reach_semantic_routing_without_keyword_gate(
    workspace, request_examples
):
    data, state = workspace
    reviewer = ProposalService(data, state)
    description = "为我撰写或实质性修改学术笔记，包含概念解释和推导。"
    context = reviewer.create_record("preference_context", {
        "key": "note.write", "name": "学术笔记", "description": description,
        "activation": {"intents": request_examples},
    })
    reviewer.accept(context.id)
    fake = FakeModel({"contexts": [
        {"key": "note.write", "matched": True, "reason": "属于研究笔记写作"}
    ]})
    service = PersonaAIService(data, state, fake)
    result = service.resolve_persona_activation("将上述内容编写为可供日后复习的研究札记。")
    assert result["decision"] == "match"
    supplied = fake.calls[0][2]["catalog"][0]
    assert supplied["description"] == description
    assert supplied["activation"]["intents"] == request_examples


@pytest.mark.parametrize("task", [
    "请把这段讨论整理成学术 note。",
    "不要执行‘请把这段讨论整理成学术 note。’，只解释这句话。",
    "将上述内容编写为可供日后复习的研究札记。",
])
def test_read_only_preference_queries_do_not_treat_request_examples_as_keywords(workspace, task):
    data, state = workspace
    reviewer = ProposalService(data, state)
    context = reviewer.create_record("preference_context", {
        "key": "note.write", "name": "学术笔记", "description": "撰写学术笔记。",
        "activation": {
            "intents": ["请把这段讨论整理成学术 note。"],
            "artifact_types": ["research_note"],
        },
    })
    reviewer.accept(context.id)
    global_pref = reviewer.create_record("preference", {
        "scope": "global", "behavior": "preferred", "instruction": "清晰表达。",
    })
    reviewer.accept(global_pref.id)
    scoped_pref = reviewer.create_record("preference", {
        "scope": "contexts", "context_refs": [context.target_id],
        "behavior": "required", "instruction": "首次出现时定义符号。",
    })
    reviewer.accept(scoped_pref.id)
    query = PersonaQueryService(data, state)
    direct = query.search_preferences(task=task)
    assert direct.matched_contexts == []
    assert [p.id for p in direct.preferences] == [global_pref.target_id]
    assert any("resolve_persona_activation" in note for note in direct.conflict_notes)
    prepared = query.prepare_persona_context(task=task)
    assert [p.id for p in prepared.preferences] == [global_pref.target_id]
    assert any("resolve_persona_activation" in item.subject for item in prepared.unknowns)
    explicit = query.search_preferences(task=task, context_key="note.write")
    assert {p.id for p in explicit.preferences} == {global_pref.target_id, scoped_pref.target_id}
    assert not explicit.conflict_notes
    structured = query.search_preferences(task=task, artifact_type="research_note")
    assert [c.key for c in structured.matched_contexts] == ["note.write"]


@pytest.mark.parametrize("decisions", [[], [{"key": "fake", "matched": True, "reason": "x"}]])
def test_activation_rejects_incomplete_or_invented_keys(workspace, decisions):
    create_contexts(*workspace)
    service = PersonaAIService(*workspace, FakeModel({"contexts": decisions}))
    with pytest.raises(AgentServiceError, match="所有场景"):
        service.resolve_persona_activation("do work")


def test_model_failure_is_not_no_match(workspace):
    create_contexts(*workspace)
    service = PersonaAIService(*workspace, FakeModel(AgentServiceError("timeout", "超时")))
    with pytest.raises(AgentServiceError) as error:
        service.resolve_persona_activation("task")
    assert error.value.code == "timeout"


def test_natural_language_draft_is_persistent_editable_and_review_gated(workspace):
    data, state = workspace
    initial = PersonaStore(data).load().config.revision
    proposal = change(values={"behavior": "preferred", "instruction": "先给结论"})
    fake = FakeModel(output(proposal), output(proposal))
    service = PersonaAIService(data, state, fake)
    draft = run(service)
    assert draft["status"] == "submitted", draft
    assert len(ProposalRepository(data).list_pending()) == 1
    assert PersonaStore(data).load().config.revision == initial
    other = PersonaAIService(data, state, fake)
    assert other.get_session(draft["id"])["draft"] == draft["draft"]
    edited = copy.deepcopy(draft["draft"])
    edited["changes"][0]["values"]["instruction"] = "先给结论，再解释依据。"
    saved = other.edit(draft["id"], edited, draft["version"])
    with pytest.raises(AgentServiceError):
        other.edit(draft["id"], edited, draft["version"])
    running = other.begin(saved["id"], "保留我的修改，只补充措辞", saved["version"])
    inbox = InboxService(data, state, ConversationLearningService(data, state))
    original = inbox.detail("assistant:" + draft["id"])
    assert original["input_text"] == "写作时先给结论。"
    assert all(m["content"] != "保留我的修改，只补充措辞" for m in original["context"])
    assert draft["review_origin"]["message_count"] < len(running["messages"])
    continued = other.generate(saved["id"], running["run_id"])
    assert (
        fake.calls[-1][2]["previous_draft"]["changes"][0]["values"]["instruction"]
        == "先给结论，再解释依据。"
    )
    submitted = other.submit(saved["id"], continued["version"])
    assert submitted["status"] == "submitted"
    assert submitted["submission"]["effective_change"] is False
    assert other.submit(saved["id"], continued["version"])["submission"] == submitted["submission"]
    assert PersonaStore(data).load().config.revision == initial
    assert len(ProposalRepository(data).list_pending()) == 1
    assert submitted["submission"]["change_set_id"] == draft["submission"]["change_set_id"]
    ProposalService(data, state).accept(submitted["submission"]["proposals"][0]["proposal_id"])
    assert PersonaStore(data).load().config.revision == initial + 1


def test_new_context_dependency_is_supported_even_when_listed_after_preference(workspace):
    preference = change(
        client_ref="rule",
        values={
            "scope": "contexts",
            "context_client_refs": ["scene"],
            "behavior": "required",
            "instruction": "先给结论",
        },
    )
    context = change(
        "preference_context",
        client_ref="scene",
        values={
            "name": "科研写作",
            "key": "research.writing",
            "activation": {"intents": ["写论文"]},
        },
    )
    service = PersonaAIService(*workspace, FakeModel(output(preference, context)))
    draft = run(service)
    submitted = service.submit(draft["id"], draft["version"])
    rule, scene = submitted["submission"]["proposals"]
    assert rule["dependencies"] == [scene["proposal_id"]]
    reviewer = ProposalService(*workspace)
    with pytest.raises(ProposalDependencyError):
        reviewer.accept(rule["proposal_id"])
    reviewer.accept(scene["proposal_id"])
    reviewer.accept(rule["proposal_id"])
    record = PersonaStore(workspace[0]).load().records[rule["candidate_record_id"]].record
    assert record.context_refs == [scene["candidate_record_id"]]


def test_editing_out_dependency_is_rejected(workspace):
    service = PersonaAIService(
        *workspace,
        FakeModel(
            output(
                change("preference_context", client_ref="scene", values={"name": "x", "key": "x"}),
                change(
                    values={
                        "scope": "contexts",
                        "context_client_refs": ["scene"],
                        "behavior": "preferred",
                        "instruction": "x",
                    }
                ),
            )
        ),
    )
    draft = run(service)
    edited = copy.deepcopy(draft["draft"])
    edited["changes"] = edited["changes"][1:]
    with pytest.raises(AgentServiceError, match="场景候选不存在"):
        service.edit(draft["id"], edited, draft["version"])


def test_existing_record_is_loaded_before_model_changes_it(workspace):
    update = change(
        "knowledge_node",
        "update",
        target_id="kn_demo_mps",
        expected_record_revision=1,
        values={"summary": "新的客观定义"},
    )
    fake = FakeModel(output(update), output(update))
    service = PersonaAIService(*workspace, fake)
    draft = run(service, "更新 MPS 的定义")
    assert draft["status"] == "submitted"
    assert len(fake.calls) == 2
    assert not fake.calls[0][2]["records"]
    assert fake.calls[1][2]["records"][0]["id"] == "kn_demo_mps"
    assert "summary" in draft["draft"]["changes"][0]["before"]


def test_scoped_entry_reads_record_immediately_and_stale_persona_cannot_submit(workspace):
    fake = FakeModel(
        output(
            change(
                "knowledge_node",
                "update",
                target_id="kn_demo_mps",
                expected_record_revision=1,
                values={"summary": "新摘要"},
            )
        )
    )
    service = PersonaAIService(*workspace, fake)
    draft = run(service, record_id="kn_demo_mps")
    assert len(fake.calls) == 1
    reviewer = ProposalService(*workspace)
    reviewer.accept(reviewer.create_update("kn_demo_mps", {"summary": "用户已经改了"}).id)
    with pytest.raises(AgentServiceError, match="Persona 已更新"):
        service.edit(draft["id"], draft["draft"], draft["version"])
    assert service.get_session(draft["id"])["status"] == "submitted"


def evidence(line_end=3, **overrides):
    return {
        "file": "original.md",
        "line_start": 1,
        "line_end": line_end,
        "evidence_kind": "read_signal",
        "confidence": 0.8,
        **overrides,
    }


def material_knowledge(**overrides):
    return change(
        "knowledge_node",
        client_ref="new-concept",
        values={
            "title": "材料中的新概念",
            "semantic_role": "topic",
            "interest_level": "unspecified",
            "knowledge_level": "unspecified",
            "summary": "客观概念定义",
        },
        evidence=[evidence()],
        **overrides,
    )


def test_material_analysis_evidence_summary_and_relations_remain_pending(workspace):
    summary = change(
        "material",
        "update",
        target_id="mat_demo_tebd_note",
        expected_record_revision=1,
        values={"summary": "根据原文整理的摘要。"},
    )
    relation = change(
        "relation",
        "relate",
        values={
            "source_id": "mat_demo_tebd_note",
            "target_ref": "new-concept",
            "relation_type": "covers",
            "knowledge_role": "topic",
            "salience": "secondary",
            "statement": "材料介绍了这个概念。",
        },
        evidence=[evidence()],
    )
    fake = FakeModel(output(summary, material_knowledge(), relation))
    service = PersonaAIService(*workspace, fake)
    draft = run(service, material_id="mat_demo_tebd_note")
    assert draft["status"] == "submitted", draft
    assert fake.calls[0][0] == "material"
    assert fake.calls[0][2]["source_text"].startswith("1: ")
    assert draft["coverage"]["complete"]
    submitted = service.submit(draft["id"], draft["version"])
    proposals = submitted["submission"]["proposals"]
    assert len(proposals) == 3 and proposals[2]["dependencies"] == [proposals[1]["proposal_id"]]
    stored = ProposalRepository(workspace[0]).get(proposals[1]["proposal_id"])
    assert stored.proposal_context.source_id == "src_demo_note"
    assert stored.evidence_candidates[0].locator["line_start"] == 1
    assert stored.evidence_candidates[0].body


@pytest.mark.parametrize(
    "candidate,code",
    [
        (
            change(
                "knowledge_node",
                values={"title": "bad", "semantic_role": "topic", "interest_level": "unspecified"},
            ),
            "evidence_required",
        ),
        (
            change(
                "knowledge_node",
                values={"title": "bad", "semantic_role": "topic", "interest_level": "unspecified"},
                evidence=[evidence(999999, line_start=999999)],
            ),
            "invalid_evidence",
        ),
        (
            change(values={"behavior": "preferred", "instruction": "猜测的偏好"}),
            "personal_scope_required",
        ),
        (
            change(
                "material",
                "update",
                target_id="mat_demo_tebd_note",
                expected_record_revision=1,
                values={"knowledge_level": "unspecified"},
            ),
            "personal_scope_required",
        ),
        (
            change(
                "material",
                "update",
                target_id="mat_demo_tebd_note",
                expected_record_revision=1,
                values={"abstract": "覆盖原文"},
            ),
            "protected_source",
        ),
    ],
)
def test_material_guards(workspace, candidate, code):
    service = PersonaAIService(*workspace, FakeModel(output(candidate)))
    draft = run(service, material_id="mat_demo_tebd_note")
    assert draft["status"] == "failed"
    assert draft["error"]["code"] == code
    assert ProposalRepository(workspace[0]).list_pending() == []


def test_cancel_discards_late_results_and_does_not_overwrite_new_run(workspace):
    entered, release = threading.Event(), threading.Event()

    def slow(payload):
        entered.set()
        assert release.wait(5)
        return output(change(values={"behavior": "preferred", "instruction": "old"}))

    fake = FakeModel(slow, output())
    service = PersonaAIService(*workspace, fake)
    initial = service.create_session()
    running = service.begin(initial["id"], "旧任务", initial["version"])
    worker = threading.Thread(target=service.generate, args=(initial["id"], running["run_id"]))
    worker.start()
    assert entered.wait(5)
    cancelled = service.cancel(initial["id"], running["version"])
    assert fake.cancelled == [running["run_id"]]
    fresh = service.begin(initial["id"], "新任务", cancelled["version"])
    release.set()
    worker.join(5)
    current = service.get_session(initial["id"])
    assert current["status"] == "running" and current["run_id"] == fresh["run_id"]
    service.generate(initial["id"], fresh["run_id"])
    assert not service.get_session(initial["id"])["draft"]["changes"]


def test_studio_pages_and_local_only_api(workspace):
    app = create_app(*workspace)
    app.state.ai_service.model = FakeModel(output())
    headers = {"X-AI-Persona": "1"}
    with TestClient(app) as client:
        for path in [
            "/ai",
            "/ai?record_id=kn_demo_mps",
            "/ai?material_id=mat_demo_tebd_note",
            "/settings/models",
        ]:
            response = client.get(path)
            assert response.status_code == 200, response.text
            assert "ai-common.js" in response.text
        assert client.post("/api/ai/sessions", json={}).status_code == 403
        assert (
            client.post(
                "/api/ai/sessions", headers={**headers, "Origin": "https://evil.example"}, json={}
            ).status_code
            == 403
        )
        assert client.get("/api/ai/sessions", headers={"Host": "evil.example"}).status_code == 403
        draft = client.post("/api/ai/sessions", headers=headers, json={}).json()
        path = "/api/ai/sessions/" + draft["id"]
        response = client.post(
            path + "/message",
            headers=headers,
            json={"version": draft["version"], "message": "这里只是提问"},
        )
        assert response.status_code == 200
        for _ in range(50):
            result = client.get(path).json()
            if result["status"] != "running":
                break
            time.sleep(0.01)
        assert result["status"] == "ready"
        assert not result["draft"]["changes"]
        assert client.post("/api/models/generate", headers=headers, json={}).status_code == 400


def test_mcp_activation_works_without_model_when_no_context_exists(workspace):
    async def scenario():
        async with Client(create_mcp_server(*workspace)) as client:
            result = await client.call_tool("resolve_persona_activation", {"user_prompt": "hello"})
            assert result.structured_content["result"]["decision"] == "no_match"

    asyncio.run(scenario())


def test_material_personal_opt_in_preserves_source_evidence_on_preference_proposal(workspace):
    proposal = change(
        values={"behavior": "preferred", "instruction": "参考此笔记的结论优先结构"},
        evidence=[evidence()],
    )
    service = PersonaAIService(*workspace, FakeModel(output(proposal)))
    draft = run(
        service,
        "将这篇笔记作为表达方式参考样本",
        material_id="mat_demo_tebd_note",
        allow_personal=True,
    )
    assert draft["status"] == "submitted", draft
    submitted = service.submit(draft["id"], draft["version"])
    stored = ProposalRepository(workspace[0]).get(
        submitted["submission"]["proposals"][0]["proposal_id"]
    )
    assert stored.evidence_candidates[0].source_id == "src_demo_note"
    published = ProposalService(*workspace).accept(stored.id)
    assert published.record.instruction == "参考此笔记的结论优先结构"


def test_persisted_submission_reservation_recovers_without_duplicate_proposals(workspace):
    service = PersonaAIService(
        *workspace,
        FakeModel(
            output(
                change(
                    values={
                        "behavior": "preferred",
                        "instruction": "可以恢复的草稿",
                    }
                )
            )
        ),
    )
    draft = run(service)
    submitted = service.submit(draft["id"], draft["version"])
    # Simulate losing the final draft-state write after the idempotent ChangeSet was saved.
    service.repository.update(
        draft["id"], {"status": "submitting", "submission": None}, submitted["version"]
    )
    recovered = service.get_session(draft["id"])
    assert recovered["status"] == "submitted"
    assert recovered["submission"]["change_set_id"] == submitted["submission"]["change_set_id"]
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1


def test_review_form_uses_canonical_defaults_for_ai_created_preferences(workspace):
    from ai_persona.review import review_values

    service = PersonaAIService(
        *workspace,
        FakeModel(
            output(
                change(
                    values={
                        "behavior": "preferred",
                        "instruction": "默认范围和状态可直接审核",
                    }
                )
            )
        ),
    )
    draft = run(service)
    submitted = service.submit(draft["id"], draft["version"])
    proposal = ProposalRepository(workspace[0]).get(
        submitted["submission"]["proposals"][0]["proposal_id"]
    )
    values = review_values(proposal, PersonaStore(workspace[0]).load())
    assert values["scope"] == "global"
    assert values["status"] == "active"
    assert values["context_refs"] == []


def test_invalid_draft_fields_are_rejected_before_review_submission(workspace):
    service = PersonaAIService(
        *workspace,
        FakeModel(
            output(
                change(
                    values={
                        "behavior": "not-an-enum",
                        "instruction": "不应进入有效草稿",
                    }
                )
            )
        ),
    )
    draft = run(service)
    assert draft["status"] == "failed"
    assert draft["error"]["code"] == "invalid_model_output"
    assert not ProposalRepository(workspace[0]).list_pending()


def test_personal_opt_in_requires_an_actual_boolean(workspace):
    service = PersonaAIService(*workspace, FakeModel())
    with pytest.raises(AgentServiceError, match="选项格式"):
        service.create_session(material_id="mat_demo_tebd_note", allow_personal="false")


def test_prompt_activation_affects_new_runs_and_real_inputs_are_captured(workspace):
    data, state = workspace
    fake = FakeModel(output(), output())
    service = PersonaAIService(data, state, fake)
    session = service.create_session()
    first = service.begin(session['id'], '解释概念即可', session['version'])
    original = service.prompts.version('ai-persona.maintenance')
    custom = service.prompts.save_version('ai-persona.maintenance', {**original['templates'], 'system': 'TEST CUSTOM RULES'})
    service.prompts.activate([{'prompt_id': custom['prompt_id'], 'version': custom['id'], 'expected_active': original['id']}])
    service.generate(session['id'], first['run_id'])
    assert fake.calls[0][1] == original['templates']['system']
    run(service)
    assert fake.calls[1][1] == 'TEST CUSTOM RULES'
    captures = service.prompts.records('captures', 'ai-persona.maintenance')
    assert len(captures) == 2
    assert captures[0]['variables']['payload'] == fake.calls[1][2]
    assert captures[0]['snapshot']['versions']['ai-persona.maintenance']['id'] == custom['id']


def test_model_settings_reasoning_test_requires_runtime_support(workspace):
    class SettingsModel:
        def __init__(self):
            self.supported = False
            self.tests = []

        def request(self, route, payload=None):
            if route == "config":
                return {"capabilities": {"reasoningTests": int(self.supported)}}
            assert route == "test"
            self.tests.append(payload)
            return {"ok": True, "reasoning": payload.get("reasoning")}

    app = create_app(*workspace)
    model = SettingsModel()
    app.state.ai_service.model = model
    with TestClient(app, base_url="http://localhost") as client:
        raw = {"id": "fixture", "modelId": "fixture", "reasoning": "high"}
        headers = {"X-AI-Persona": "1"}
        result = client.post("/api/models/test", json=raw, headers=headers)
        assert result.status_code == 400
        assert result.json()["error"]["code"] == "runtime_incompatible"
        assert not model.tests
        model.supported = True
        result = client.post("/api/models/test", json=raw, headers=headers)
        assert result.status_code == 200
        assert result.json()["reasoning"] == "high"
        assert model.tests == [raw]
