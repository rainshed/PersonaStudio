from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace
from test_ai_service import FakeModel
from test_model_bridge import configure, local_upstream, stop
from test_preference_folders import upload_folder

from ai_persona.ai_service import ActivationOutput, PersonaAIService
from ai_persona.conversation_learning.contracts import SourceConnection
from ai_persona.human_edits import HumanEditService
from ai_persona.model_bridge import ModelClient
from ai_persona.models import Preference, PreferenceExample
from ai_persona.preference_application.cli import hook_config, run_hook
from ai_persona.preference_application.context import build_context, prepare_saved_context
from ai_persona.preference_application.repository import ApplicationSettings
from ai_persona.preference_application.service import ApplicationService
from ai_persona.prompt_store import PromptStore
from ai_persona.store import PersonaStore, StoreValidationError
from ai_persona.web import create_app


def decisions(payload, matched=True):
    return {"contexts": [{"key": c["key"], "matched": matched, "reason": "本轮任务判断"}
                         for c in payload["catalog"]]}


@pytest.fixture
def work(tmp_path, monkeypatch):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    model = FakeModel(decisions)
    service = ApplicationService(data, state, ai_service=PersonaAIService(data, state, model))
    connection = SourceConnection(id="test_codex", name="本机 Codex", adapter="codex",
                                  enabled=False, scope_mode="restricted", allowed_scopes=["project"],
                                  adapter_config={"project_scopes": {str(tmp_path): "project"}})
    service.connections.save_connection(connection)
    service.repository.save_settings(ApplicationSettings(enabled=True, connection_ids=[connection.id]))
    edits = HumanEditService(data, state)
    edits.create_record("preference", {
        "scope": "global", "behavior": "preferred", "instruction": "使用简洁的中文。",
    })
    contexts = [edits.create_record("preference_context", {
        "name": name, "key": key, "description": description,
    }).target_id for name, key, description in [
        ("科研绘图", "research.plotting", "将实验数据可视化"),
        ("学术笔记", "academic.note", "撰写带推导的学术笔记"),
    ]]
    preference = edits.create_record("preference", {
        "scope": "contexts", "context_refs": contexts, "behavior": "preferred",
        "instruction": "完整保留公式与推导。", "condition": "用户需要解释时。",
        "rationale": "便于复习。",
    }).target_id
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "session_test",
               "turn_id": "turn_1", "cwd": str(tmp_path), "prompt": "帮我画图并整理笔记"}
    return service, payload, contexts, preference


def process(work):
    service, payload, _, _ = work
    row, created = service.begin("test_codex", payload)
    assert created
    return service.process(row["id"])


def test_complete_multi_context_package_preserves_conditions_and_global_preferences(work):
    service, _, contexts, preference = work
    row = process(work)
    assert row["status"] == "prepared", row
    assert row["decision_state"] == "completed"
    payload = json.loads(service.output(row["id"])["hookSpecificOutput"]["additionalContext"])
    assert {c["id"] for c in payload["matched_contexts"]} == set(contexts)
    assert len([p for p in payload["preferences"] if p["id"] == preference]) == 1
    assert next(p for p in payload["preferences"] if p["id"] == preference)["condition"] == "用户需要解释时。"
    assert any(p["scope"] == "global" for p in payload["preferences"])
    assert payload["source"]["time_scope"] == "long_term"
    assert "本次明确要求优先" in payload["source"]["usage"]
    assert len(service.ai.model.calls) == 1
    sent = service.ai.model.calls[0][2]
    assert "完整保留公式与推导" not in json.dumps(sent, ensure_ascii=False)
    result = service.ai.evaluations.result(row["result_id"])
    assert len(result["decisions"]) == 2
    assert all(type(c["triggered"]) is bool for c in result["decisions"])
    assert service.connections.settings().enabled is False


@pytest.mark.parametrize("output", [
    RuntimeError("fixture failure"),
    {"contexts": []},
    {"contexts": [{"key": "research.plotting", "matched": True, "reason": "x"}]},
    {"contexts": [{"key": "research.plotting", "decision": "uncertain", "reason": "x"},
                  {"key": "academic.note", "matched": True, "reason": "x"}]},
    lambda payload: {"contexts": [{"key": c["key"], "matched": "true", "reason": "x"}
                                  for c in payload["catalog"]]},
])
def test_unfinished_judgment_never_falls_back_to_global(work, output):
    service = work[0]
    service.ai.model.outputs = [output]
    row = process(work)
    assert row["status"] == "failed"
    assert row["decision_state"] == "failed" and row["payload"] is None
    assert service.output(row["id"]) is None
    result = service.ai.evaluations.result(row["result_id"])
    assert result["state"] == "failed" and result["decisions"] == []
    assert service.ai.evaluations.cases() == []


def test_valid_no_match_provides_only_global(work):
    service = work[0]
    service.ai.model.outputs = [lambda p: decisions(p, False)]
    row = process(work)
    assert row["status"] == "prepared"
    assert not row["payload"]["matched_contexts"]
    assert all(p["scope"] == "global" for p in row["payload"]["preferences"])


def test_budget_failure_preserves_judgment_but_does_not_emit_partial_json(work):
    service, _, contexts, _ = work
    HumanEditService(service.data_root, service.state_root).create_record("preference", {
        "scope": "contexts", "context_refs": contexts, "behavior": "required",
        "instruction": "很长的用户原始要求" * 1500,
    })
    row = process(work)
    assert row["status"] == "failed" and row["error_code"] == "context_budget_exceeded"
    assert row["decision_state"] == "completed" and row["payload"] is None
    assert service.output(row["id"]) is None
    assert service.ai.evaluations.result(row["result_id"])["decisions"]


def test_same_event_deduplicates_and_new_turn_rejudges(work):
    service, payload, _, _ = work
    first = process(work)
    again, created = service.begin("test_codex", payload)
    assert not created and again["id"] == first["id"]
    assert len(service.ai.model.calls) == 1
    service.ai.model.outputs = [lambda p: decisions(p, False)]
    next_row, created = service.begin("test_codex", {**payload, "turn_id": "turn_2"})
    assert created
    second = service.process(next_row["id"])
    assert not second["payload"]["matched_contexts"]
    assert len(service.ai.model.calls) == 2


def test_deadline_cannot_be_overwritten_by_late_result(work):
    service, payload, _, _ = work
    row, _ = service.begin("test_codex", payload)
    service.repository.update(row["id"], {"deadline": time.time() - 1})
    assert service.process(row["id"])["error_code"] == "timeout"
    assert not service.ai.model.calls
    service.repository.update(row["id"], {"status": "prepared", "payload": {"fake": True}})
    assert service.repository.get(row["id"])["payload"] is None
    assert service.output(row["id"]) is None


def test_disabled_scope_and_policy_changes_prevent_delivery(work):
    service, payload, _, _ = work
    assert service.begin("test_codex", {**payload, "cwd": "/not/allowed"}) == (None, False)
    row = process(work)
    service.repository.save_settings(ApplicationSettings())
    assert service.output(row["id"]) is None
    assert service.repository.get(row["id"])["error_code"] == "disabled"


def test_record_change_before_output_prevents_stale_preferences(work):
    service = work[0]
    row = process(work)
    HumanEditService(service.data_root, service.state_root).create_record("preference", {
        "scope": "global", "behavior": "preferred", "instruction": "新偏好",
    })
    assert service.output(row["id"]) is None
    assert service.repository.get(row["id"])["error_code"] == "context_changed"


def test_folder_resource_and_more_than_ten_samples_are_preserved(work):
    service, _, contexts, _ = work
    with TestClient(create_app(service.data_root, service.state_root)) as client:
        for i in range(11):
            response = upload_folder(client, contexts[0], {f"示例{i}/note.md": f"原文{i}".encode()},
                                     title=f"样本{i}")
            assert response.status_code == 303
    row = process(work)
    samples = row["payload"]["reference_samples"]
    assert len(samples) == 11
    assert all(s["resource"]["kind"] == "folder" and s["resource"]["available"] for s in samples)
    assert all(Path(s["resource"]["location"]).is_dir() for s in samples)
    assert "原文0" not in json.dumps(row["payload"], ensure_ascii=False)


def test_unavailable_sample_does_not_prevent_other_preferences(work):
    service, _, contexts, _ = work
    with TestClient(create_app(service.data_root, service.state_root)) as client:
        assert upload_folder(client, contexts[0], {"样本/note.md": b"text"}).status_code == 303
    store = PersonaStore(service.data_root).load()
    sample = store.of_type(PreferenceExample)[0]
    source = store.sources[sample.source_ref]
    store.source_file_path(source.id, source.canonical_file).unlink()
    with pytest.raises(StoreValidationError):
        PersonaStore(service.data_root).load()
    row = process(work)
    assert row["status"] == "prepared"
    assert row["payload"]["preferences"]
    assert row["payload"]["reference_samples"][0]["resource"]["available"] is False
    app = create_app(service.data_root, service.state_root)
    app.state.preference_application = service
    with TestClient(app) as client:
        assert client.get("/preferences/applications").status_code == 200


def test_api_history_feedback_and_configuration_are_independent(work):
    service = work[0]
    row = process(work)
    app = create_app(service.data_root, service.state_root)
    app.state.preference_application = service
    headers = {"X-AI-Persona": "1"}
    with TestClient(app) as client:
        assert client.get("/preferences/applications").status_code == 200
        assert "/settings?tab=capabilities" in client.get("/preferences").text
        records = client.get("/api/preferences/application/records").json()
        assert records["total"] == 1 and records["items"][0]["id"] == row["id"]
        assert client.get("/api/preferences/application/records/" + row["id"]).json()["payload"]
        result = service.ai.evaluations.result(row["result_id"])
        feedback = client.post(f"/api/evaluations/v1/results/{row['result_id']}/feedback", json={
            "subject": result["decisions"][0]["subject"], "rating": "unsatisfied", "reason": "",
            "idempotency_key": "test-user-click", "expected_feedback_revision": 0,
        }, headers=headers)
        assert feedback.status_code == 200
        assert feedback.json()["trigger_labels"][0]["expected_trigger"] is False
        url = "/api/preferences/application/config"
        assert client.post(url, json={"enabled": False}).status_code == 403
        assert client.post(url, json={"enabled": False}, headers=headers).status_code == 200
        assert not service.repository.settings().enabled
        assert client.get(url, headers={"Origin": "https://example.com"}).status_code == 403
    assert len(service.ai.model.calls) == 1


def test_hook_runs_real_subprocess_and_pi_bridge_without_real_account(work, monkeypatch, capsys, tmp_path):
    service, payload, _, _ = work
    client = ModelClient(tmp_path / "models")
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(client.directory))
    with local_upstream() as (url, calls):
        try:
            configure(client, url)
            run_hook(service, "test_codex", payload)
            stdout = capsys.readouterr().out
            output = json.loads(stdout)
            context = json.loads(output["hookSpecificOutput"]["additionalContext"])
            assert context["type"] == "user_preference_context"
            rows, _ = service.repository.recent()
            assert rows[0]["status"] == "returned", rows
            assert len(calls) == 1
            run_hook(service, "test_codex", payload)
            assert capsys.readouterr().out == "" and len(calls) == 1
        finally:
            stop(client)


def test_hook_enforces_outer_timeout_and_no_stdout(work, monkeypatch, capsys):
    service, payload, _, _ = work
    service.repository.save_settings(ApplicationSettings(enabled=True, connection_ids=["test_codex"], timeout_seconds=1.0))
    monkeypatch.setattr("ai_persona.preference_application.cli.command",
                        lambda *a, **kw: [sys.executable, "-c", "import time; time.sleep(20)"])
    started = time.monotonic()
    run_hook(service, "test_codex", payload)
    assert time.monotonic() - started < 2.5
    assert capsys.readouterr().out == ""
    rows, _ = service.repository.recent()
    assert rows[0]["error_code"] == "timeout" and rows[0]["payload"] is None


def test_hook_configuration_and_malformed_cli_never_emit_context(work):
    service = work[0]
    config = hook_config(service, "test_codex")["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert config["additionalContextLimit"] == 0 and config["timeout"] == 62
    service.repository.save_settings(ApplicationSettings(
        enabled=True, connection_ids=["test_codex"], timeout_seconds=30,
    ))
    assert hook_config(service, "test_codex")["hooks"]["UserPromptSubmit"][0]["hooks"][0] == config
    result = subprocess.run([sys.executable, "-m", "ai_persona", "preferences-apply", "hook",
                             "--data", str(service.data_root), "--state", str(service.state_root),
                             "--connection", "test_codex"], input="not json", capture_output=True, text=True)
    assert result.returncode == 0 and result.stdout == ""


def test_activation_prompt_migration_preserves_old_custom_text(tmp_path):
    definitions = json.loads((Path(__file__).parents[1] / "src/ai_persona/prompts/catalog.json").read_text())
    definitions[0]["schema_version"] = "1"
    definitions[0]["templates"]["system"] = "User custom v1 prompt with uncertain"
    old = PromptStore(tmp_path / "prompts", catalog=definitions)
    version = old.version("ai-persona.activation")
    old.activate([{"prompt_id": "ai-persona.activation", "version": version["id"], "expected_active": version["id"]}])
    snapshot = old.snapshot()
    current = PromptStore(tmp_path / "prompts")
    assert current.version("ai-persona.activation")["signature"] == current.signature("ai-persona.activation")
    assert current.version("ai-persona.activation", version["id"])["templates"] == version["templates"]
    replay = current.preview("ai-persona.activation", {"payload": {}}, snapshot=snapshot, legacy_activation=True)
    assert replay["rendered"]["system"] == version["templates"]["system"]
    assert "matched" in ActivationOutput.model_json_schema()["$defs"]["ContextDecision"]["properties"]


def test_empty_catalog_is_completed_without_llm(work):
    service = work[0]
    store = PersonaStore(service.data_root).load()
    store.records = {k: v for k, v in store.records.items() if isinstance(v.record, Preference) and v.record.scope == "global"}
    result = service.ai.resolve_persona_activation("你好", store=store)
    assert result["decision"] == "no_match" and not service.ai.model.calls
    assert build_context(store, [], "turn_empty", 24000)["preferences"]


def test_mcp_builder_uses_same_package_and_rejects_failed_or_stale_results(work):
    service = work[0]
    row = process(work)
    package = prepare_saved_context(service.data_root, service.state_root,
                                    row["result_id"], row["request"]["turn_id"])
    assert package["context"] == row["payload"]
    with pytest.raises(ValueError):
        prepare_saved_context(service.data_root, service.state_root, None, "turn")
    HumanEditService(service.data_root, service.state_root).create_record("preference_context", {
        "key": "new.scene", "name": "新场景", "description": "新的任务类型",
    })
    with pytest.raises(ValueError):
        prepare_saved_context(service.data_root, service.state_root, row["result_id"], "turn")
