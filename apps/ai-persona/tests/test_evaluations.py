from __future__ import annotations

import copy
import json
import re
import shutil
import threading
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.ai_service import PersonaAIService
from ai_persona.compiler import PersonaCompiler
from ai_persona.conversation_learning.contracts import (
    Capabilities,
    ConversationEvent,
    LearningSettings,
    SourceConnection,
)
from ai_persona.conversation_learning.pipeline import LearningPipeline
from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.evaluations.business import restore_persona, snapshot_persona, sync_review_gold
from ai_persona.evaluations.contracts import ACTIVATION, EvaluationError, digest
from ai_persona.evaluations.replay import replay, score
from ai_persona.evaluations.runner import EvaluationRunner
from ai_persona.evaluations.store import EvaluationStore
from ai_persona.prompt_store import PromptStore
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def work(tmp_path, monkeypatch):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "queue"))
    return data, state


class Model:
    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.cancelled = []

    def configuration_signature(self, task):
        return "fake-configuration-v1"

    def generate(self, task, system, payload, **kwargs):
        self.calls.append({"task": task, "system": system, "payload": copy.deepcopy(payload)})
        output = self.outputs.pop(0)
        if callable(output):
            output = output(payload)
        if isinstance(output, Exception):
            raise output
        return {"text": json.dumps(output), "modelId": "mock", "usage": {"totalTokens": 100}}

    def request(self, route, raw=None):
        if route == "config":
            return {
                "capabilities": {"promptExperiments": 1},
                "settings": {
                    "connections": [
                        {"id": "fake", "modelId": "mock", "revision": "1", "providerId": "mock"}
                    ],
                    "overrides": {},
                    "defaultConnectionId": "fake",
                    "defaultModelId": "mock",
                },
            }
        assert route == "generate"
        # Match the real daemon contract, not just the service's in-memory API.
        assert re.fullmatch(r"[a-zA-Z0-9-]{1,80}", raw["runId"])
        return self.generate(raw["task"], raw["systemPrompt"], json.loads(raw["prompt"]))

    def cancel(self, run_id):
        self.cancelled.append(run_id)


def activation_trace(store, actual=True, other=False):
    payload = {
        "user_prompt": "写一份 note",
        "catalog": [{"key": "note.write", "name": "写作 note"}, {"key": "draw", "name": "绘图"}],
        "output_schema": {},
    }
    result = store.create_result(
        ACTIVATION,
        input_data=payload,
        prompt_snapshot=PromptStore(store.state_root / "prompts").snapshot(),
    )
    return store.complete_result(
        result["id"],
        state="completed",
        decisions=[
            {
                "subject": {"kind": "activation_context", "context_key": key},
                "name": key,
                "triggered": value,
                "processing_state": "completed" if value is not None else "waiting_context",
            }
            for key, value in (("note.write", actual), ("draw", other))
        ],
    )


def click(store, result, rating="satisfied", reason="", subject=None):
    current = store.result(result["id"])
    return store.feedback(
        result["id"],
        {
            "subject": subject or result["decisions"][0]["subject"],
            "rating": rating,
            "reason": reason,
            "expected_feedback_revision": current["feedback"]["revision"],
            "idempotency_key": uuid.uuid4().hex,
        },
    )


def test_inbox_summary_cache_refreshes_after_other_store_writes(work, monkeypatch):
    first = EvaluationStore(*work)
    second = EvaluationStore(*work)
    result = first.create_result(ACTIVATION, task_ref="application:cache-test", input_data={"user_prompt": "测试缓存"})
    assert first.inbox_summaries()[result["id"]]["state"] == "running"

    from ai_persona.evaluations import store as store_module

    original = store_module.read_json
    trace_reads = []

    def counted(path, default=None):
        if path.name == result["id"] + ".json":
            trace_reads.append(path)
        return original(path, default)

    monkeypatch.setattr(store_module, "read_json", counted)
    assert first.inbox_summaries()[result["id"]]["state"] == "running"
    assert not trace_reads

    second.complete_result(result["id"], state="completed", decisions=[{
        "subject": {"kind": "activation_context", "context_key": "test"},
        "name": "test", "triggered": True, "processing_state": "completed",
    }])
    trace_reads.clear()
    updated = first.inbox_summaries()[result["id"]]
    assert updated["state"] == "completed" and updated["decisions"][0]["triggered"]
    assert trace_reads

    click(second, second.result(result["id"]))
    promoted = first.inbox_summaries()[result["id"]]
    assert promoted["feedback"]["revision"] == 1
    second.delete(promoted["case_id"])
    assert result["id"] not in first.inbox_summaries()


@pytest.mark.parametrize(
    "actual,rating,expected",
    [
        (True, "satisfied", True),
        (True, "unsatisfied", False),
        (False, "satisfied", False),
        (False, "unsatisfied", True),
    ],
)
def test_click_is_only_case_creation_and_binary_mapping(work, actual, rating, expected):
    store = EvaluationStore(*work)
    result = activation_trace(store, actual)
    assert store.cases() == []
    value = click(store, result, rating)
    assert len(store.cases()) == 1
    assert value["trigger_labels"][0]["expected_trigger"] is expected
    assert len(value["trigger_labels"]) == 1  # unclicked draw is not a negative label
    assert not value["content_gold"]


def test_reasons_never_change_projection_fingerprint_or_score(work):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    case = click(store, result, "unsatisfied", "SECRET_REASON_NOT_FOR_MODEL")
    before = store.projection(case["case_id"])
    previous_score = score(before, {"decisions": result["decisions"]}, "activation")
    store.reason(
        case["case_id"],
        result["decisions"][0]["subject"],
        "different secret",
        case["feedback"]["revision"],
    )
    after = store.projection(case["case_id"])
    assert after == before
    assert digest(after) == digest(before)
    assert score(after, {"decisions": result["decisions"]}, "activation") == previous_score
    assert "SECRET_REASON" not in json.dumps(after)
    assert "different secret" not in json.dumps(store.export("benchmark"))
    assert "different secret" in json.dumps(store.export("backup"))


def test_idempotency_concurrency_and_rating_always_inverts_original(work):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    request = {
        "subject": result["decisions"][0]["subject"],
        "rating": "unsatisfied",
        "expected_feedback_revision": 0,
        "idempotency_key": "same",
    }
    first = store.feedback(result["id"], request)
    assert store.feedback(result["id"], request)["benchmark_revision"] == 1
    with pytest.raises(EvaluationError):
        store.feedback(result["id"], {**request, "rating": "satisfied"})
    with pytest.raises(EvaluationError, match="已更新"):
        store.feedback(result["id"], {**request, "idempotency_key": "stale"})
    assert click(store, result, "satisfied")["trigger_labels"][0]["expected_trigger"] is True
    assert click(store, result, "unsatisfied")["trigger_labels"][0]["expected_trigger"] is False
    assert len(store.cases()) == 1
    assert first["benchmark_revision"] == 1


def test_unknown_subject_and_undecided_cannot_create_case(work):
    store = EvaluationStore(*work)
    result = activation_trace(store, None)
    with pytest.raises(EvaluationError, match="尚无"):
        click(store, result)
    with pytest.raises(EvaluationError):
        click(store, result, subject={"kind": "learning_gate"})
    assert store.cases() == []


def test_withdrawal_revokes_old_suite_without_relabeling_other_context(work):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    first = click(store, result)
    second = click(store, result, subject=result["decisions"][1]["subject"])
    suite = store.save_suite("回归", [{"case_id": first["case_id"]}])
    store.withdraw(
        first["case_id"], result["decisions"][0]["subject"], second["feedback"]["revision"]
    )
    projection = store.projection(first["case_id"], suite["cases"][0]["benchmark_revision"])
    assert len(projection["trigger_labels"]) == 1
    assert projection["trigger_labels"][0]["subject"]["context_key"] == "draw"
    current = store.case(first["case_id"])
    store.withdraw(first["case_id"], None, current["feedback"]["revision"])
    with pytest.raises(EvaluationError, match="撤回"):
        store.projection(first["case_id"], 1)
    assert click(store, result)["status"] == "active"


def test_cleanup_backup_restore_and_delete(work, tmp_path):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    case = click(store, result)
    store.cleanup(retention_days=-1)
    assert store.projection(case["case_id"])["result"]["input"]["user_prompt"]
    backup = store.export()
    restored = EvaluationStore(tmp_path / "restored", tmp_path / "restored-state")
    assert restored.import_data(backup)["imported"] == 1
    assert restored.projection(case["case_id"]) == store.projection(case["case_id"])
    with pytest.raises(EvaluationError):
        restored.import_data(backup)
    store.delete(case["case_id"])
    assert store.cases() == []
    with pytest.raises(EvaluationError):
        store.projection(case["case_id"])
    with pytest.raises(EvaluationError):
        click(store, result)


def test_transaction_recovers_interrupted_feedback_promotion(work, monkeypatch):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    apply = store._apply
    monkeypatch.setattr(store, "_apply", lambda _: (_ for _ in ()).throw(OSError("crash")))
    with pytest.raises(OSError):
        click(store, result)
    monkeypatch.setattr(store, "_apply", apply)
    reopened = EvaluationStore(*work)
    assert len(reopened.cases()) == 1
    assert reopened.projection(reopened.case_id(result["id"]))["trigger_labels"]


def make_learning(work, outputs):
    service = ConversationLearningService(*work)
    service.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
    service.repository.save_connection(
        SourceConnection(
            id="test",
            name="Test",
            enabled=True,
            allowed_scopes=["project"],
            capabilities=Capabilities(verified_human_origin=True),
        )
    )
    event = ConversationEvent.model_validate(
        {
            "schema": "ai-persona.conversation-event/v1",
            "event_id": "test-event",
            "source_connection_id": "test",
            "event_type": "message.submitted",
            "conversation_id": "chat",
            "scope_ref": "project",
            "message": {
                "id": "message",
                "revision": "1",
                "role": "user",
                "origin": "human",
                "content": [{"type": "text", "text": "给我讲讲测试知识"}],
            },
        }
    )
    receipt = service.ingest_event(event, "test")
    service.repository.claim("lease")
    model = Model(*outputs)
    LearningPipeline(service, model).process(receipt["event_id"], "lease")
    result_id = service.get_event_status(receipt["event_id"], "test")["evaluation_result_id"]
    store = EvaluationStore(*work)
    return service, store, store.result(result_id), model


SIGNAL = {
    "decision": "observe",
    "signals": [
        {
            "id": "s",
            "kind": "knowledge_explanation_request",
            "target_type": "knowledge_node",
            "statement": "用户要求讲解测试知识",
            "topic": "测试知识",
            "scope": "",
        }
    ],
}
CANDIDATE = {
    "changes": [
        {
            "client_ref": "new",
            "operation": "create",
            "entity_type": "knowledge_node",
            "signal_ids": ["s"],
            "note": "用户请求讲解。",
            "values": {"title": "测试知识", "semantic_role": "concept", "summary": "原摘要"},
        }
    ]
}


@pytest.mark.parametrize("before_review", [True, False])
def test_review_automatically_supplies_gold_only_for_clicked_cases(work, before_review):
    service, store, result, _ = make_learning(work, [SIGNAL, CANDIDATE])
    assert result["decisions"][0]["triggered"] is True
    assert result["proposal_bindings"]
    assert store.cases() == []
    if before_review:
        case = click(store, result)
        assert case["content_gold"] == []
    proposal = ProposalRepository(work[0]).list_pending()[0]
    accepted = ProposalService(*work).accept(
        proposal.id,
        review_updates={"summary": "审核确认的摘要"},
        decision_reason="REVIEW_REASON_NOT_GOLD",
    )
    if not before_review:
        assert store.cases() == []
        case = click(store, result)
        sync_review_gold(store, case["case_id"])
    projection = store.projection(case["case_id"])
    assert len(projection["content_gold"]) == 1
    gold = projection["content_gold"][0]
    assert gold["content"]["values"]["summary"] == "审核确认的摘要"
    assert "REVIEW_REASON_NOT_GOLD" not in json.dumps(projection)
    assert projection["result"]["generation"][0]["values"]["summary"] == "原摘要"
    assert sync_review_gold(store) == 0
    edits = ProposalService(*work)
    changed = edits.create_update(accepted.record.id, {"summary": "后来修改的内容"})
    edits.accept(changed.id)
    sync_review_gold(store)
    assert store.projection(case["case_id"])["content_gold"] == projection["content_gold"]


def test_ignored_learning_still_has_feedback_and_no_candidate_gold(work):
    _, store, result, _ = make_learning(work, [{"decision": "ignore", "signals": []}])
    assert result["decisions"][0]["triggered"] is False
    case = click(store, result, "unsatisfied")
    assert case["trigger_labels"][0]["expected_trigger"] is True
    assert not case["content_gold"]


def test_full_pipeline_replay_uses_snapshot_without_production_writes(work):
    _, store, result, _ = make_learning(work, [SIGNAL, CANDIDATE])
    case = click(store, result)
    projection = store.projection(case["case_id"])
    before = {
        str(p.relative_to(work[0])): p.read_bytes()
        for p in work[0].rglob("*")
        if p.is_file() and "evaluations" not in p.parts
    }
    outputs = iter([SIGNAL, CANDIDATE])
    calls = []

    def request(prompt_id, payload, model, tokens):
        calls.append(payload)
        return model.model_validate(next(outputs))

    output = replay(projection, "learning_pipeline", request)
    assert output["decisions"][0]["triggered"] is True
    assert output["generation"][0]["values"]["summary"] == "原摘要"
    assert len(calls) == 2
    after = {
        str(p.relative_to(work[0])): p.read_bytes()
        for p in work[0].rglob("*")
        if p.is_file() and "evaluations" not in p.parts
    }
    assert after == before


def test_runner_uses_labels_not_reasons_and_counts_failures(work):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    case = click(store, result, "unsatisfied", "REASON_NEVER_IN_MODEL")
    suite = store.save_suite("触发测试", [{"case_id": case["case_id"]}])
    model = Model(
        {
            "contexts": [
                {"key": "note.write", "matched": False, "reason": "不匹配"},
                {"key": "draw", "matched": False, "reason": "不匹配"},
            ]
        },
        ValueError("fake failure"),
    )
    runner = EvaluationRunner(store, model)
    run = runner.start(
        {"suite_id": suite["id"], "mode": "activation", "confirmed_model_calls": True}
    )
    for _ in range(100):
        value = store.document("runs", run["id"])
        if value["status"] not in {"queued", "running"}:
            break
        time.sleep(0.01)
    runner.close()
    assert value["status"] == "completed_with_errors"
    assert value["report"]["variants"]["A"]["accuracy"]["rate"] == 1
    assert value["report"]["variants"]["B"]["all_success"]["rate"] == 0
    assert value["report"]["variants"]["B"]["completion"]["rate"] == 0
    assert "REASON_NEVER_IN_MODEL" not in json.dumps(model.calls)
    assert "REASON_NEVER_IN_MODEL" not in json.dumps(value)
    assert len(store.cases()) == 1  # replay did not create cases


def test_api_page_feedback_and_origin_guard_do_not_call_model(work):
    app = create_app(*work)
    model = Model()
    app.state.ai_service.model = model
    store = app.state.evaluations.store
    result = activation_trace(store, False)
    with TestClient(app) as client:
        assert client.get("/evaluations").status_code == 200
        assert "evaluation-embedded" in client.get("/evaluations?embedded=1").text
        assert client.get("/static/evaluations.js").status_code == 200
        assert len(client.get("/api/evaluations/v1/capabilities").json()["capabilities"]) == 2
        assert client.get("/api/evaluations/v1/cases").json()["items"] == []
        payload = {
            "subject": result["decisions"][0]["subject"],
            "rating": "unsatisfied",
            "expected_feedback_revision": 0,
            "idempotency_key": "api-explicit",
        }
        path = f"/api/evaluations/v1/results/{result['id']}/feedback"
        assert client.post(path, json=payload).status_code == 403
        assert (
            client.post(
                path,
                json=payload,
                headers={"X-AI-Persona": "1", "Origin": "https://external.invalid"},
            ).status_code
            == 403
        )
        response = client.post(path, json=payload, headers={"X-AI-Persona": "1"})
        assert response.status_code == 200, response.text
        assert response.json()["trigger_labels"][0]["expected_trigger"] is True
        assert (
            client.post(
                "/api/evaluations/v1/runs", json={}, headers={"X-AI-Persona": "1"}
            ).status_code
            == 400
        )
        assert not model.calls


def test_failed_activation_does_not_become_negative_label(work):
    reviewer = ProposalService(*work)
    reviewer.accept(
        reviewer.create_record("preference_context", {"key": "note", "name": "Note"}).id
    )
    service = PersonaAIService(*work)
    service.model = Model(ValueError("model failed"))
    with pytest.raises(ValueError):
        service.resolve_persona_activation("请解释测试知识")
    result = service.evaluations.results()[0]
    assert result["state"] == "failed"
    assert result["decisions"] == []
    assert not service.evaluations.cases()


@pytest.mark.parametrize("action", ["reject", "defer"])
def test_nonapproval_does_not_create_gold_or_flip_gate(work, action):
    _, store, result, _ = make_learning(work, [SIGNAL, CANDIDATE])
    case = click(store, result)
    proposal = ProposalRepository(work[0]).list_pending()[0]
    getattr(ProposalService(*work), action)(proposal.id)
    sync_review_gold(store)
    assert store.case(case["case_id"])["trigger_labels"][0]["expected_trigger"] is True
    assert not store.case(case["case_id"])["content_gold"]


def test_rejected_candidate_version_cannot_supply_gold_to_other_result(work):
    _, store, result, _ = make_learning(work, [SIGNAL, CANDIDATE])
    case = click(store, result)
    proposal = ProposalRepository(work[0]).list_pending()[0]
    store.complete_result(
        result["id"],
        proposal_bindings=[
            {"proposal_id": proposal.id, "candidate_version_ref": "different-version"}
        ],
    )
    ProposalService(*work).accept(proposal.id)
    sync_review_gold(store)
    assert not store.case(case["case_id"])["content_gold"]


def test_review_rollback_does_not_publish_gold(work, monkeypatch):
    _, store, result, _ = make_learning(work, [SIGNAL, CANDIDATE])
    case = click(store, result)
    proposal = ProposalRepository(work[0]).list_pending()[0]
    reviewer = ProposalService(*work)
    monkeypatch.setattr(
        reviewer.repository, "complete", lambda _: (_ for _ in ()).throw(OSError("commit failure"))
    )
    with pytest.raises(OSError):
        reviewer.accept(proposal.id)
    sync_review_gold(store)
    assert not store.case(case["case_id"])["content_gold"]
    assert ProposalRepository(work[0]).get(proposal.id).status == "pending_review"


def test_delete_scrubs_reports_and_late_writes_and_derived_traces(work):
    store = EvaluationStore(*work)
    result = activation_trace(store)
    case = click(store, result)
    derived = store.create_result(
        ACTIVATION, input_data={"secret": "parent input"}, parent_case_id=case["case_id"]
    )
    old_run = {
        "id": "eval_test",
        "status": "running",
        "suite": {"cases": [{"case_id": case["case_id"], "benchmark_revision": 1}]},
        "results": [
            {
                "case_id": case["case_id"],
                "variant": "A",
                "input": "private copy",
                "status": "succeeded",
            }
        ],
        "variants": [{"snapshots": {case["case_id"]: {"input": "private copy"}}}],
    }
    store.save_run(old_run)
    store.delete(case["case_id"])
    store.save_run({**old_run, "status": "succeeded"})
    assert "private copy" not in json.dumps(store.document("runs", old_run["id"]))
    with pytest.raises(EvaluationError):
        store.result(derived["id"])
    with pytest.raises(EvaluationError):
        store.create_result(ACTIVATION, parent_case_id=case["case_id"])


def test_import_rejects_extra_scoring_fields_and_unbacked_labels(work, tmp_path):
    store = EvaluationStore(*work)
    click(store, activation_trace(store))
    backup = store.export()
    restored = EvaluationStore(tmp_path / "restore", tmp_path / "restore-state")
    broken = copy.deepcopy(backup)
    broken["cases"][0]["revisions"][0]["reason"] = "not a scorer input"
    with pytest.raises(EvaluationError):
        restored.import_data(broken)
    broken = copy.deepcopy(backup)
    label = broken["cases"][0]["revisions"][0]["trigger_labels"][0]
    label["rating"], label["expected_trigger"] = "unsatisfied", False
    with pytest.raises(EvaluationError):
        restored.import_data(broken)
    assert not restored.cases()


def test_backup_includes_frozen_suites_and_reports(work, tmp_path):
    store = EvaluationStore(*work)
    case = click(store, activation_trace(store))
    suite = store.save_suite("suite", [{"case_id": case["case_id"]}])
    store.save_run({"id": "eval_test", "status": "running", "suite": suite, "results": []})
    restored = EvaluationStore(tmp_path / "restore", tmp_path / "restore-state")
    restored.import_data(store.export())
    assert restored.documents("suites")[0] == suite
    assert restored.documents("runs")[0]["status"] == "interrupted"


def test_budget_exhaustion_has_denominator_and_no_extra_calls(work):
    store = EvaluationStore(*work)
    case = click(store, activation_trace(store))
    suite = store.save_suite("suite", [{"case_id": case["case_id"]}])
    model = Model(
        {
            "contexts": [
                {"key": key, "matched": False, "reason": ""} for key in ["note.write", "draw"]
            ]
        }
    )
    runner = EvaluationRunner(store, model)
    run = runner.start(
        {
            "suite_id": suite["id"],
            "mode": "activation",
            "confirmed_model_calls": True,
            "max_calls": 1,
        }
    )
    for _ in range(200):
        value = store.document("runs", run["id"])
        if value["status"] not in {"queued", "running"}:
            break
        time.sleep(0.01)
    runner.close()
    assert len(model.calls) == 1
    assert value["results"][1]["error"]["code"] == "budget_exhausted"
    assert value["report"]["variants"]["B"]["completion"]["denominator"] == 1


def test_withdraw_during_model_call_cancels_and_does_not_save_output(work):
    store = EvaluationStore(*work)
    case = click(store, activation_trace(store))
    suite = store.save_suite("suite", [{"case_id": case["case_id"]}])
    entered, release = threading.Event(), threading.Event()

    def blocking(_):
        entered.set()
        assert release.wait(5)
        return {
            "contexts": [
                {"key": key, "matched": False, "reason": ""} for key in ["note.write", "draw"]
            ]
        }

    model = Model(blocking)
    runner = EvaluationRunner(store, model)
    try:
        run = runner.start(
            {"suite_id": suite["id"], "mode": "activation", "confirmed_model_calls": True}
        )
        assert entered.wait(5)
        runner.cancel_case(case["case_id"])
        store.withdraw(case["case_id"], None, case["feedback"]["revision"])
        release.set()
        runner.pool.shutdown(wait=True)
        value = store.document("runs", run["id"])
        assert value["status"] == "cancelled"
        assert value["results"] == []
        assert len(model.calls) == 1 and len(model.cancelled) == 1
    finally:
        release.set()
        runner.close()


def test_filtered_snapshot_preserves_global_proposal_history_limit(work):
    reviewer = ProposalService(*work)
    pending = reviewer.create_record(
        "knowledge_node",
        {"title": "pending", "semantic_role": "concept", "interest_level": "unspecified"},
    )
    # The unrelated material history must consume the same slots as in production,
    # without saving its unrelated source/body in the replay corpus.
    excluded = [
        pending.model_copy(
            update={"id": f"excluded_{i}", "status": "rejected", "target_entity_type": "material"}
        )
        for i in range(30)
    ]
    older = pending.model_copy(update={"id": "prop_old_knowledge", "status": "rejected"})
    snapshot = snapshot_persona(PersonaStore(work[0]).load(), [pending, *excluded, older])
    _, history = restore_persona(snapshot)
    pipeline = object.__new__(LearningPipeline)
    pipeline.frozen_history = history
    pipeline.frozen_history_order = snapshot["history_order"]
    assert [p.id for p in pipeline.proposal_history(30)] == [pending.id]
    assert [p.id for p in pipeline.proposal_history()] == [pending.id, "prop_old_knowledge"]
    assert "excluded_0" not in json.dumps(snapshot)


def test_learning_result_preview_uses_content_parts(work):
    _, store, result, _ = make_learning(work, [{"decision": "ignore", "signals": []}])
    assert store.results()[0]["input_preview"] == "给我讲讲测试知识"
    click(store, result)
    assert store.cases()[0]["input_preview"] == "给我讲讲测试知识"
