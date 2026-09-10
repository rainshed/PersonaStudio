"""Behavioral checks for independent repeated experiments; no provider requests."""

import copy
import threading

import pytest
from fastapi.testclient import TestClient
from test_evaluations import Model, activation_trace, click
from test_evaluations import work as work

from ai_persona.evaluations.contracts import EvaluationError
from ai_persona.evaluations.planning import prepare, public_preview
from ai_persona.evaluations.replay import summarize
from ai_persona.evaluations.runner import EvaluationRunner
from ai_persona.evaluations.store import EvaluationStore
from ai_persona.prompt_store import PromptStore
from ai_persona.web import create_app


class RepeatedModel(Model):
    def __init__(self, *outputs):
        super().__init__(*outputs)
        self.requests = []
        self.revision = "1"

    def request(self, route, raw=None):
        if route == "config":
            config = super().request(route, raw)
            config["capabilities"]["evaluationReasoning"] = 1
            config["settings"]["connections"][0]["revision"] = self.revision
            config["settings"]["connections"].append(
                {
                    "id": "second",
                    "name": "Second",
                    "modelId": "other",
                    "revision": "2",
                    "providerId": "mock",
                }
            )
            config["providers"] = [
                {
                    "id": "mock",
                    "models": [
                        {"id": "mock", "reasoningLevels": ["low", "high"]},
                        {"id": "other", "reasoningLevels": ["medium"]},
                    ],
                }
            ]
            return config
        self.requests.append(copy.deepcopy(raw))
        return super().request(route, raw)


def answer(trigger=True):
    return {
        "contexts": [
            {"key": "note.write", "matched": trigger, "reason": "fixture"},
            {"key": "draw", "matched": False, "reason": "fixture"},
        ]
    }


def configuration(store, **extra):
    case = click(store, activation_trace(store), reason="PRIVATE_REASON")
    return {
        "cases": [{"case_id": case["case_id"]}],
        "mode": "activation",
        "variants": [
            {"source": "active"},
            {
                "source": "active",
                "connection_id": "second",
                "model_id": "other",
                "reasoning": "medium",
            },
        ],
        "repeat_count": 3,
        "confirmed_model_calls": True,
        **extra,
    }


def finish(runner, raw):
    initial = runner.start(raw)
    runner.pool.shutdown(wait=True)
    result = runner.store.document("runs", initial["id"])
    runner.close()
    return result


def test_repeat_schedule_models_prompts_metrics_and_idempotency(work):
    store = EvaluationStore(*work)
    model = RepeatedModel(
        answer(True), answer(False), answer(True), answer(True), answer(True), answer(False)
    )
    raw = configuration(store, request_id="once")
    prompts = PromptStore(work[1] / "prompts")
    active = prompts.version("ai-persona.activation")
    candidate = prompts.save_version(
        "ai-persona.activation",
        {**active["templates"], "system": active["templates"]["system"] + "\nCANDIDATE_MARKER"},
        "candidate",
    )
    raw["variants"][1]["versions"] = {"ai-persona.activation": candidate["id"]}
    preview = public_preview(prepare(store, model, raw))
    assert model.requests == []
    raw["expected_plan"] = preview["fingerprint"]
    runner = EvaluationRunner(store, model)
    run = finish(runner, raw)
    assert run["status"] == "succeeded"
    assert len(run["results"]) == len({r["id"] for r in run["results"]}) == 6
    assert [(r["variant"], r["repeat_index"]) for r in run["results"]] == [
        ("A", 1),
        ("B", 1),
        ("B", 2),
        ("A", 2),
        ("A", 3),
        ("B", 3),
    ]
    assert [r["experimentSelection"]["modelId"] for r in model.requests] == [
        "mock",
        "other",
        "other",
        "mock",
        "mock",
        "other",
    ]
    assert ["CANDIDATE_MARKER" in r["systemPrompt"] for r in model.requests] == [
        False,
        True,
        True,
        False,
        False,
        True,
    ]
    assert all(
        r.get("reasoning") == ("medium" if r["experimentSelection"]["modelId"] == "other" else None)
        for r in model.requests
    )
    assert "PRIVATE_REASON" not in str(model.requests) + str(run)
    a, b = run["report"]["variants"]["A"], run["report"]["variants"]["B"]
    assert a["cases"] == 1 and a["replays"] == 3
    assert a["should_trigger"]["rate"] == 1
    assert b["should_trigger"]["numerator"] == 1
    assert b["should_trigger"]["denominator"] == 3
    assert a["should_not_trigger"]["rate"] is None
    assert a["stability"]["rate"] == 1 and b["stability"]["rate"] == 0
    assert len(run["report"]["comparison"]) == 3
    assert runner.start(raw)["id"] == run["id"]  # a retry cannot dispatch another job
    assert prompts.version("ai-persona.activation")["id"] == active["id"]
    assert len(store.cases()) == 1


def test_preview_detects_changed_current_plan_and_rejects_unsupported_effort(work):
    store, model = EvaluationStore(*work), RepeatedModel()
    raw = configuration(store)
    before = public_preview(prepare(store, model, raw))
    model.revision = "changed"
    with pytest.raises(EvaluationError, match="已变化"):
        prepare(store, model, {**raw, "expected_plan": before["fingerprint"]})
    raw["variants"][1]["reasoning"] = "high"
    with pytest.raises(EvaluationError, match="不支持"):
        prepare(store, model, raw)
    assert model.requests == []


def test_budget_and_undecided_preserve_planned_denominators(work):
    store, model = EvaluationStore(*work), RepeatedModel(answer())
    run = finish(EvaluationRunner(store, model), configuration(store, max_calls=1))
    assert len(model.requests) == 1
    assert len(run["results"]) == 6
    assert sum(r["status"] == "not_run" for r in run["results"]) == 5
    stats = run["report"]["variants"]["B"]
    assert stats["failures"] == 0 and stats["not_run"] == 3
    assert stats["should_trigger"]["rate"] is None
    assert stats["completion"]["denominator"] == 3
    assert stats["stability"]["rate"] is None
    unknown = {
        "case_id": "c",
        "variant": "A",
        "status": "succeeded",
        "score": {
            "units": [
                {
                    "subject": {},
                    "expected": False,
                    "actual": None,
                    "completed": False,
                    "correct": False,
                }
            ]
        },
    }
    stats = summarize([unknown])["variants"]["A"]
    assert stats["undecided"] == 1 and stats["should_not_trigger"]["rate"] is None


def test_cancel_and_restart_keep_completed_results_and_unfinished_slots(work):
    store = EvaluationStore(*work)
    entered, release = threading.Event(), threading.Event()

    def blocking(_):
        entered.set()
        assert release.wait(5)
        return answer()

    model = RepeatedModel(answer(), blocking)
    runner = EvaluationRunner(store, model)
    try:
        run = runner.start(configuration(store))
        assert entered.wait(5)
        runner.cancel(run["id"])
        release.set()
        runner.pool.shutdown(wait=True)
        saved = store.document("runs", run["id"])
        assert saved["status"] == "cancelled"
        assert [r["status"] for r in saved["results"]].count("succeeded") == 1
        assert [r["status"] for r in saved["results"]].count("not_run") == 5
    finally:
        release.set()
        runner.close()
    saved["id"] = "eval_restart"
    saved["status"] = "running"
    saved["results"][1]["status"] = "running"
    store.save_run(saved)
    app = create_app(*work)
    assert app.state.evaluations._runner is None
    restarted = app.state.evaluations.store.document("runs", saved["id"])
    assert restarted["status"] == "interrupted"
    assert restarted["results"][0]["status"] == "succeeded"
    assert restarted["results"][1]["status"] == "not_run"


def test_preview_endpoint_is_read_only_and_classifies_each_reviewed_scenario(work):
    app = create_app(*work)
    model = RepeatedModel()
    app.state.ai_service.model = model
    store = app.state.evaluations.store
    trace = activation_trace(store)
    first = click(store, trace)
    case = click(store, trace, subject=trace["decisions"][1]["subject"])
    raw = {
        "cases": [{"case_id": first["case_id"]}],
        "mode": "activation",
        "variants": [{"source": "active"}],
        "repeat_count": 5,
    }
    with TestClient(app) as client:
        response = client.post(
            "/api/evaluations/v1/preview", json=raw, headers={"X-AI-Persona": "1"}
        )
        assert response.status_code == 200, response.text
        assert response.json()["coverage"] == {"should_trigger": 1, "should_not_trigger": 1}
        assert len(case["trigger_labels"]) == 2
        assert app.state.evaluations._runner is None
        assert store.documents("runs") == store.documents("suites") == []
        assert not model.requests


def test_storage_failure_finishes_from_last_durable_report(work, monkeypatch):
    store, model = EvaluationStore(*work), RepeatedModel(answer(), answer())
    raw = configuration(store, repeat_count=1)
    save = store.save_run
    rejected = False

    def limited(run):
        nonlocal rejected
        if not rejected and any(r["status"] == "succeeded" for r in run["results"]):
            rejected = True
            raise EvaluationError("保存空间不足。", "too_large", 413)
        return save(run)

    monkeypatch.setattr(store, "save_run", limited)
    run = finish(EvaluationRunner(store, model), raw)
    assert run["status"] == "failed"
    assert run["error"]["code"] == "too_large"
    assert all(r["status"] == "not_run" for r in run["results"])
    assert run["results"][0][
        "calls"
    ]  # Keep the previously saved output even if scoring could not be saved.


def test_repeated_records_survive_backup_and_deletion_keeps_only_identity(work, tmp_path):
    store, model = EvaluationStore(*work), RepeatedModel(answer(), answer())
    run = finish(EvaluationRunner(store, model), configuration(store, repeat_count=1))
    restored = EvaluationStore(tmp_path / "restored-data", tmp_path / "restored-state")
    restored.import_data(store.export())
    copied = restored.document("runs", run["id"])
    identities = [(r["id"], r["variant"], r["repeat_index"]) for r in run["results"]]
    assert [(r["id"], r["variant"], r["repeat_index"]) for r in copied["results"]] == identities
    restored.delete(run["suite"]["cases"][0]["case_id"])
    deleted = restored.document("runs", run["id"])
    assert [(r["id"], r["variant"], r["repeat_index"]) for r in deleted["results"]] == identities
    assert all(
        set(r) == {"id", "case_id", "variant", "repeat_index", "status"} for r in deleted["results"]
    )
    assert all(r["status"] == "deleted" for r in deleted["results"])
