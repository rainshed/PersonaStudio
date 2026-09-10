"""Offline pipeline, recovery, context budgets and source-grounding regression tests."""

import copy
import json

import pytest
from fastapi.testclient import TestClient
from test_ai_service import (
    FakeModel,
    change,
    evidence,
    material_knowledge,
    output,
    run,
)
from test_ai_service import (
    workspace as workspace_fixture,
)

import ai_persona.ai_service as ai_module
import ai_persona.material_analysis as analysis_module
from ai_persona.agent import AgentServiceError
from ai_persona.ai_service import PersonaAIService, encoded
from ai_persona.material_analysis import (
    MaterialAnalysis,
    check_analysis,
    compact_schema,
    excerpts,
    field_contracts,
    source_chunks,
)
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.web import create_app

workspace = workspace_fixture


def analysis(payload):
    start = payload["segment"]["line_start"]
    return {
        "overview": "本段介绍矩阵乘积态的方法与适用范围。",
        "concepts": [
            {
                "name": "MPS",
                "aliases": ["矩阵乘积态"],
                "meaning": "量子态的一种张量网络表示。",
                "evidence": [{"line_start": start, "line_end": start}],
            }
        ],
        "claims": [
            {
                "kind": "limitation",
                "statement": "结果仅适用于材料所述的设置。",
                "evidence": [{"line_start": start, "line_end": start}],
            }
        ],
        "uncertainties": ["尚未验证其他设置。"],
    }


@pytest.fixture
def staged(monkeypatch):
    monkeypatch.setattr(ai_module, "SHORT_TEXT_CHARS", 0)


def resume(service, value):
    running = service.resume(value["id"], value["version"])
    return service.generate(value["id"], running["run_id"])


def test_task_contracts_keep_field_names_constraints_and_drop_database_metadata():
    contracts = field_contracts(True, False)
    assert set(contracts) == {"knowledge_node", "material", "relation"}
    knowledge = contracts["knowledge_node"]
    assert "title" in knowledge["properties"] and "title" in knowledge["required_on_create"]
    assert "knowledge_level" not in knowledge["create"]
    assert "body" not in knowledge["properties"]
    assert "created_at" not in encoded(contracts) and "schema_id" not in encoded(contracts)
    assert contracts["material"]["create"] == []
    assert "abstract" not in contracts["material"]["update"]
    assert "requires" in contracts["relation"]["properties"]["relation_type"]["enum"]
    assert "preference" in field_contracts(True, True)
    assert "body" in field_contracts(False, False)["knowledge_node"]["properties"]
    assert "title" not in compact_schema(MaterialAnalysis.model_json_schema())


def test_short_material_one_call_has_small_contract_and_safe_records(workspace):
    fake = FakeModel(output())
    result = run(PersonaAIService(*workspace, fake), material_id="mat_demo_tebd_note")
    assert result["status"] == "ready"
    assert len(fake.calls) == 1
    payload = fake.calls[0][2]
    assert "record_schemas" not in payload and "source_text" in payload
    assert all("body" not in r and "knowledge_level" not in r for r in payload["records"])
    assert result["coverage"]["chunks_done"] == 1
    assert result["model_runs"][0]["inputChars"] > 0
    assert result["model_runs"][0]["status"] == "succeeded"


def test_two_stage_separates_understanding_from_persona_and_reuses_known_concepts(
    workspace, staged
):
    fake = FakeModel(analysis, output())
    result = run(PersonaAIService(*workspace, fake), material_id="mat_demo_tebd_note")
    assert result["status"] == "ready", result["error"]
    first, second = [call[2] for call in fake.calls]
    assert not {"catalog", "records", "field_contracts", "previous_draft"} & first.keys()
    assert "source_text" not in second and second["source_excerpts"]
    assert second["analysis_parts"][0]["claims"][0]["kind"] == "limitation"
    assert "kn_demo_mps" in {r["id"] for r in second["records"]}
    assert len(result["checkpoint"]["parts"]) == 1
    assert result["coverage"]["complete"]
    assert ProposalRepository(workspace[0]).list_pending() == []


def test_failed_candidate_continues_after_saved_analysis_without_duplicate_message(
    workspace, staged
):
    fake = FakeModel(analysis, AgentServiceError("timeout", "超时"), output())
    service = PersonaAIService(*workspace, fake)
    failed = run(service, material_id="mat_demo_tebd_note")
    assert failed["status"] == "failed" and failed["coverage"]["complete"]
    assert [r["status"] for r in failed["model_runs"]] == ["succeeded", "timeout"]
    other = PersonaAIService(*workspace, fake)
    ready = resume(other, failed)
    assert ready["status"] == "ready"
    assert len(fake.calls) == 3 and "segment" not in fake.calls[-1][2]
    assert len([m for m in ready["messages"] if m["role"] == "user"]) == 1


@pytest.mark.parametrize("changed", ["source", "model", "persona", "goal"])
def test_checkpoint_invalidation_rules(workspace, staged, monkeypatch, changed):
    fake = FakeModel(analysis, AgentServiceError("timeout", "超时"))
    fake.configuration_signature = lambda task: "model-one"
    service = PersonaAIService(*workspace, fake)
    failed = run(service, material_id="mat_demo_tebd_note")
    if changed == "source":
        original = service._source

        def source(identifier):
            metadata, coverage, text = original(identifier)
            metadata["file_hash"] = "changed-fixture-hash"
            return metadata, coverage, text

        monkeypatch.setattr(service, "_source", source)
    elif changed == "model":
        fake.configuration_signature = lambda task: "model-two"
    elif changed == "persona":
        reviewer = ProposalService(*workspace)
        reviewer.accept(reviewer.create_update("kn_demo_mps", {"summary": "已更新定义"}).id)
    fake.outputs.extend([analysis, output()] if changed != "persona" else [output()])
    if changed == "goal":
        running = service.begin(failed["id"], "只关注方法的限制", failed["version"])
        ready = service.generate(failed["id"], running["run_id"])
    else:
        ready = resume(service, failed)
    assert ready["status"] == "ready", ready["error"]
    assert len(fake.calls) == (3 if changed == "persona" else 4)


def test_chunking_preserves_every_original_line_and_enforces_limits(monkeypatch):
    monkeypatch.setattr(analysis_module, "CHUNK_CHARS", 80)
    text = "\n".join(f"{i}: 正文第 {i} 行。" for i in range(1, 30))
    chunks = source_chunks(text)
    assert len(chunks) > 1
    assert "\n".join(c["text"] for c in chunks) == text
    assert [c["line_start"] for c in chunks][1:] == [c["line_end"] + 1 for c in chunks][:-1]
    assert chunks[-1]["line_end"] == 29
    with pytest.raises(AgentServiceError, match="长行"):
        source_chunks("1: " + "x" * 81)
    monkeypatch.setattr(analysis_module, "MAX_CHUNKS", 1)
    with pytest.raises(AgentServiceError, match="段分析预算"):
        source_chunks(text)


def test_partial_segment_failure_resumes_at_next_segment(workspace, staged, monkeypatch):
    monkeypatch.setattr(analysis_module, "CHUNK_CHARS", 120)
    fake = FakeModel(analysis, AgentServiceError("timeout", "超时"))
    service = PersonaAIService(*workspace, fake)
    original = service._source

    def source(identifier):
        metadata, coverage, _ = original(identifier)
        text = "\n".join(f"{i}: Some matrix product state content." for i in range(1, 13))
        coverage.update(total_lines=12)
        return metadata, coverage, text

    monkeypatch.setattr(service, "_source", source)
    failed = run(service, material_id="mat_demo_tebd_note")
    assert failed["coverage"]["chunks_done"] == 1 and not failed["coverage"]["complete"]
    assert failed["coverage"]["line_end"] == 3
    assert "已保存 1 段完整分析" in failed["error"]["message"]
    fake.outputs.extend([analysis, analysis, analysis, output()])
    ready = resume(service, failed)
    assert ready["status"] == "ready", ready["error"]
    assert ready["coverage"]["line_end"] == 12
    starts = [c[2]["segment"]["line_start"] for c in fake.calls if "segment" in c[2]]
    assert starts == [1, 4, 4, 7, 10]


def test_extraction_invalid_evidence_is_not_checkpointed(workspace, staged):
    invalid = {
        "overview": "bad",
        "concepts": [
            {"name": "x", "meaning": "x", "evidence": [{"line_start": 999, "line_end": 999}]}
        ],
    }
    service = PersonaAIService(*workspace, FakeModel(invalid))
    failed = run(service, material_id="mat_demo_tebd_note")
    assert failed["error"]["code"] == "invalid_evidence"
    assert failed["checkpoint"]["parts"] == []
    assert failed["coverage"]["line_end"] == 0


def test_excerpt_budget_and_out_of_bounds_are_explicit():
    text = "\n".join(f"{i}: text" for i in range(1, 20))
    blocks, missing = excerpts(
        text, [{"line_start": 2, "line_end": 3}, {"line_start": 15, "line_end": 15}], budget=50
    )
    assert blocks[0]["line_start"] == 1 and missing[0]["line_start"] == 13
    with pytest.raises(AgentServiceError, match="超出原文"):
        excerpts(text, [{"line_start": 999, "line_end": 999}])
    chunk = {"line_start": 4, "line_end": 6}
    with pytest.raises(AgentServiceError):
        check_analysis(
            MaterialAnalysis.model_validate(
                {
                    "overview": "x",
                    "concepts": [
                        {
                            "name": "x",
                            "meaning": "x",
                            "evidence": [{"line_start": 3, "line_end": 4}],
                        }
                    ],
                }
            ),
            chunk,
        )


def test_read_checkpoints_survive_later_failure_for_maintenance(workspace):
    fake = FakeModel(
        output(read_ids=["kn_demo_mps"]), AgentServiceError("timeout", "超时"), output()
    )
    service = PersonaAIService(*workspace, fake)
    failed = run(service)
    assert failed["checkpoint"]["read_ids"] == ["kn_demo_mps"]
    assert "本轮尚无完整材料分段分析可保存" in failed["error"]["message"]
    ready = resume(service, failed)
    assert ready["status"] == "ready"
    assert "kn_demo_mps" in {r["id"] for r in fake.calls[-1][2]["records"]}


def test_exact_duplicate_names_and_aliases_cannot_be_created_from_material(workspace):
    candidate = material_knowledge()
    candidate["values"]["aliases"] = ["MPS"]
    failed = run(
        PersonaAIService(*workspace, FakeModel(output(candidate))), material_id="mat_demo_tebd_note"
    )
    assert failed["error"]["code"] == "duplicate_concept"


def test_persona_changed_mid_generation_can_continue_but_not_deliver_stale_draft(workspace, staged):
    def changed(payload):
        reviewer = ProposalService(*workspace)
        reviewer.accept(reviewer.create_update("kn_demo_mps", {"summary": "并发编辑"}).id)
        return output()

    service = PersonaAIService(*workspace, FakeModel(analysis, changed, output()))
    failed = run(service, material_id="mat_demo_tebd_note")
    assert failed["error"]["code"] == "stale_record"
    assert resume(service, failed)["status"] == "ready"
    assert len(service.model.calls) == 3


def test_replacement_prompt_preserves_manual_draft_values(workspace, staged):
    candidate = material_knowledge()
    service = PersonaAIService(
        *workspace, FakeModel(analysis, output(candidate), analysis, output())
    )
    ready = run(service, material_id="mat_demo_tebd_note")
    edited = copy.deepcopy(ready["draft"])
    edited["changes"][0]["values"]["summary"] = "用户手动改过的摘要。"
    saved = service.edit(ready["id"], edited, ready["version"])
    running = service.begin(saved["id"], "保留手工编辑再检查", saved["version"])
    result = service.generate(saved["id"], running["run_id"])
    assert result["status"] == "ready"
    assert (
        service.model.calls[-1][2]["previous_draft"]["changes"][0]["values"]["summary"]
        == "用户手动改过的摘要。"
    )


def test_resume_endpoint_and_old_failed_session(workspace):
    app = create_app(*workspace)
    service = app.state.ai_service
    service.model = FakeModel(AgentServiceError("timeout", "超时"), output())
    failed = run(service)
    service.repository.update(failed["id"], {"checkpoint": None})
    failed = service.get_session(failed["id"])
    path = "/api/ai/sessions/" + failed["id"]
    with TestClient(app) as client:
        assert "ai-resume" in client.get("/ai").text
        assert client.post(path + "/resume", json={"version": failed["version"]}).status_code == 403
        assert (
            client.post(
                path + "/resume",
                headers={"X-AI-Persona": "1"},
                json={"version": failed["version"] - 1},
            ).status_code
            == 400
        )
        response = client.post(
            path + "/resume", headers={"X-AI-Persona": "1"}, json={"version": failed["version"]}
        )
        assert response.status_code == 200
        assert len(response.json()["messages"]) == 1


def test_invalid_json_run_metadata_survives_without_raw_response(workspace):
    service = PersonaAIService(*workspace, FakeModel({"secret_raw": "invalid shape"}))
    failed = run(service)
    assert failed["model_runs"][0]["status"] == "invalid_model_output"
    assert "secret_raw" not in json.dumps(failed)


def test_server_supplies_unknown_personal_defaults_and_rejects_out_of_scope_types(workspace):
    candidate = material_knowledge()
    del candidate["values"]["interest_level"]
    del candidate["values"]["knowledge_level"]
    ready = run(
        PersonaAIService(*workspace, FakeModel(output(candidate))), material_id="mat_demo_tebd_note"
    )
    assert ready["status"] == "submitted", ready["error"]
    assert ready["draft"]["changes"][0]["values"]["interest_level"] == "unspecified"
    invalid = change(
        "course", values={"title": "不在材料整理范围", "interest_level": "unspecified"}
    )
    failed = run(
        PersonaAIService(*workspace, FakeModel(output(invalid))), material_id="mat_demo_tebd_note"
    )
    assert failed["error"]["code"] == "invalid_model_output"


def test_mid_stage_model_change_does_not_cache_a_mixed_model_result(workspace, staged):
    fake = FakeModel()
    fake.configuration_signature = lambda task: "first"

    def changed(payload):
        fake.configuration_signature = lambda task: "changed"
        return analysis(payload)

    fake.outputs.append(changed)
    failed = run(PersonaAIService(*workspace, fake), material_id="mat_demo_tebd_note")
    assert failed["error"]["code"] == "connection_changed"
    assert failed["checkpoint"]["parts"] == []


def test_source_excerpt_expansion_and_search_are_checkpointed(workspace, staged, monkeypatch):
    fake = FakeModel(
        analysis,
        output(source_reads=[{"line_start": 80, "line_end": 82}], search_queries=["MPS"]),
        AgentServiceError("timeout", "超时"),
        output(),
    )
    service = PersonaAIService(*workspace, fake)
    original = service._source

    def source(identifier):
        metadata, coverage, _ = original(identifier)
        coverage["total_lines"] = 100
        return (
            metadata,
            coverage,
            "\n".join(f"{i}: matrix product state content." for i in range(1, 101)),
        )

    monkeypatch.setattr(service, "_source", source)
    failed = run(service, material_id="mat_demo_tebd_note")
    assert failed["status"] == "failed"
    assert failed["checkpoint"]["source_reads"] == [{"line_start": 80, "line_end": 82}]
    assert failed["checkpoint"]["search_queries"] == ["MPS"]
    ready = resume(service, failed)
    assert ready["status"] == "ready", ready["error"]
    last = fake.calls[-1][2]
    assert any(b["line_start"] <= 80 <= 82 <= b["line_end"] for b in last["source_excerpts"])
    assert last["search_results"][0]["query"] == "MPS"
    assert len(fake.calls) == 4


def test_unseen_candidate_evidence_requires_reading_before_acceptance(
    workspace, staged, monkeypatch
):
    candidate = material_knowledge()
    candidate["evidence"] = [evidence(line_start=80, line_end=80)]
    fake = FakeModel(analysis, output(candidate), output(candidate))
    service = PersonaAIService(*workspace, fake)
    original = service._source

    def source(identifier):
        metadata, coverage, _ = original(identifier)
        coverage["total_lines"] = 100
        return metadata, coverage, "\n".join(f"{i}: paper content." for i in range(1, 101))

    monkeypatch.setattr(service, "_source", source)
    ready = run(service, material_id="mat_demo_tebd_note")
    # The mock expands only the model view, not the real source. Auto-submission
    # must still reject evidence beyond the actual file after the bounded reread.
    assert ready["status"] == "submission_failed", ready["error"]
    assert ready["error"]["code"] == "invalid_reference"
    assert len(fake.calls) == 3
    assert any(b["line_start"] <= 80 <= b["line_end"] for b in fake.calls[-1][2]["source_excerpts"])


@pytest.mark.parametrize("size", [2000, 30000, 120000])
def test_fixture_prompt_budgets(workspace, monkeypatch, size):
    """Run with -s for reproducible input-size measurements, not provider latency claims."""
    text = "\n".join(
        f"{i}: " + "matrix product states with bounded assumptions. " * 3
        for i in range(1, size // 145 + 1)
    )
    chunks = source_chunks(text)
    staged = len(text) > ai_module.SHORT_TEXT_CHARS
    fake = FakeModel(*([analysis] * len(chunks) if staged else []), output())
    service = PersonaAIService(*workspace, fake)
    original = service._source

    def source(identifier):
        metadata, coverage, _ = original(identifier)
        coverage["total_lines"] = len(text.splitlines())
        return metadata, coverage, text

    monkeypatch.setattr(service, "_source", source)
    ready = run(service, material_id="mat_demo_tebd_note")
    assert ready["status"] == "ready", ready["error"]
    assert len(fake.calls) == (len(chunks) + 1 if staged else 1)
    budgets = [len(encoded(c[2])) + len(c[1]) for c in fake.calls]
    assert max(budgets) < 220000
    contract_chars = len(encoded(fake.calls[-1][2]["output_schema"])) + len(
        encoded(fake.calls[-1][2]["field_contracts"])
    )
    assert contract_chars < 8000
    print(
        json.dumps(
            {
                "source_chars": len(text),
                "calls": len(fake.calls),
                "input_chars_per_call": budgets,
                "candidate_contract_chars": contract_chars,
            }
        )
    )
