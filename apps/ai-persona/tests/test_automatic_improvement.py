"""Exercise the actual orchestration with deterministic local model doubles."""

import copy
import json
import threading
import uuid

import pytest
from test_evaluation_workflow import RepeatedModel
from test_evaluations import click
from test_evaluations import work as work

from ai_persona.evaluations.contracts import ACTIVATION, EvaluationError
from ai_persona.evaluations.optimization import start_optimization
from ai_persona.evaluations.optimization_plan import prepare_optimization, split_cases
from ai_persona.evaluations.publication import promote, undo
from ai_persona.evaluations.runner import EvaluationRunner
from ai_persona.evaluations.store import EvaluationStore
from ai_persona.prompt_store import PromptStore
from ai_persona.trigger_plans import effective_config, generation_options


def examples(store, count=4):
    result = []
    for i in range(count):
        trace = store.create_result(
            ACTIVATION,
            input_data={
                "user_prompt": f"独立样例 {i} 写 note",
                "catalog": [{"key": "note"}, {"key": "draw"}],
                "output_schema": {},
            },
            prompt_snapshot=PromptStore(store.state_root / "prompts").snapshot(),
        )
        trace = store.complete_result(
            trace["id"],
            state="completed",
            decisions=[
                {
                    "subject": {"kind": "activation_context", "context_key": key},
                    "name": key,
                    "triggered": False,
                    "processing_state": "completed",
                }
                for key in ("note", "draw")
            ],
        )
        click(store, trace, "unsatisfied", f"PRIVATE_REASON_{i}")
        case = click(store, trace, subject=trace["decisions"][1]["subject"])
        result.append(
            {"case_id": case["case_id"], "benchmark_revision": case["benchmark_revision"]}
        )
    return result


class OptimizerModel(RepeatedModel):
    def request(self, route, raw=None):
        if route == "config":
            return super().request(route, raw)
        self.requests.append(copy.deepcopy(raw))
        if raw["stage"] == "prompt_optimization":
            payload = json.loads(raw["prompt"])
            value = {
                "templates": {
                    **payload["templates"],
                    "system": "GENERAL_BOUNDARY: 对所有场景独立判断，按输入协议返回 JSON。",
                },
                "summary": "合并重复边界",
                "hypothesis": "减少漏触发",
            }
        else:
            payload = json.loads(raw["prompt"])
            value = {
                "contexts": [
                    {
                        "key": c["key"],
                        "matched": c["key"] == "note" and "GENERAL_BOUNDARY" in raw["systemPrompt"],
                        "reason": "模拟判断",
                    }
                    for c in payload["catalog"]
                ]
            }
        return {"text": json.dumps(value, ensure_ascii=False), "usage": {"totalTokens": 17}}


def setup(work, **options):
    store = EvaluationStore(*work)
    model = OptimizerModel()
    raw = {
        "mode": "activation",
        "cases": examples(store),
        "variants": [
            {"source": "active"},
            {
                "source": "active",
                "connection_id": "second",
                "model_id": "other",
                "reasoning": "medium",
            },
        ],
        "repeat_count": 1,
        "max_calls": 100,
        "max_tokens": 5000000,
        "timeout_seconds": 90,
        "optimization": {
            "optimizer": {"connection_id": "fake", "model_id": "mock", "reasoning": "high"},
            "max_rounds": 1,
        },
        "request_id": str(uuid.uuid4()),
        "confirmed_model_calls": True,
        **options,
    }
    return store, model, raw


def finish(store, model, raw):
    runner = EvaluationRunner(store, model)
    initial = start_optimization(runner, raw)
    runner.pool.shutdown(wait=True)
    return runner, store.document("runs", initial["id"])


def test_search_withholds_validation_and_preserves_roles_and_current_plan(work):
    store, model, raw = setup(work)
    before = PromptStore(store.state_root / "prompts").snapshot()
    plan = prepare_optimization(store, model, raw)
    assert model.requests == []
    assert plan["optimization"]["split"]["independent_validation"]
    final = plan["optimization"]["split"]["validation"]
    runner, run = finish(store, model, raw)
    assert run["status"] == "succeeded", run.get("error")
    assert run["outcome"] == "improved"
    assert run["calls"] == len(model.requests)
    assert run["actual_tokens"] == run["calls"] * 17
    assert len(run["results"]) == len(final) * 2
    optimizer = next(r for r in model.requests if r["stage"] == "prompt_optimization")
    for key in final:
        assert store.input_text(store.projection(key)["result"]) not in optimizer["prompt"]
    assert optimizer["experimentSelection"]["connectionId"] == "fake"
    assert optimizer["reasoning"] == "high"
    for request in model.requests:
        if request["stage"] == "benchmark":
            assert "PRIVATE_REASON" not in request["prompt"]
            assert "expected_trigger" not in request["prompt"]
            if request["experimentSelection"]["connectionId"] == "second":
                assert request["reasoning"] == "medium"
    assert runner.prompts.snapshot() == before
    assert not list((store.local / "traces").glob("*.json")) or all(
        "evaluation:" not in p.read_text() for p in (store.local / "traces").glob("*.json")
    )
    run_id = run["id"]
    record = promote(runner, run_id, apply=True)
    active = runner.prompts.snapshot()
    assert active["versions"]["ai-persona.activation"]["templates"]["system"].startswith(
        "GENERAL_BOUNDARY"
    )
    assert generation_options(active, "ai-persona.activation") == {
        "experiment_selection": run["variants"][1]["selection"],
        "reasoning": "medium",
    }
    projected = effective_config(model.request("config"), active)
    assert projected["settings"]["overrides"]["activation"] == "second"
    assert generation_options(active, "ai-persona.conversation-signal") == {}
    assert record["before"]["model"]["selection"]["connectionId"] == "fake"
    undo(runner, run_id)
    restored = runner.prompts.snapshot()
    assert restored["versions"] == before["versions"]
    assert (
        generation_options(restored, "ai-persona.activation")["experiment_selection"][
            "connectionId"
        ]
        == "fake"
    )
    runner.close()


def test_exposed_groups_cannot_be_reused_for_independent_validation(work):
    store, model, raw = setup(work)
    runner, run = finish(store, model, raw)
    split = split_cases(store, [store.projection(r["case_id"]) for r in raw["cases"]])
    assert not split["independent_validation"]
    assert len(split["development"]) == 4
    runner.close()


def test_deleted_source_scrubs_all_derived_text_and_late_writes(work):
    store, model, raw = setup(work)
    runner, run = finish(store, model, raw)
    backup = store.export("backup")
    assert any(r.get("kind") == "optimization" for r in backup["runs"])
    assert not any(
        r.get("kind") == "optimization" or r.get("parent_id")
        for r in store.export("benchmark")["runs"]
    )
    key = run["optimization"]["split"]["development"][0]
    store.delete(key)
    store.save_run(run)
    for document in store.documents("runs"):
        assert document["private_content_deleted"]
        assert "GENERAL_BOUNDARY" not in json.dumps(document)
        assert "PRIVATE_REASON" not in json.dumps(document)
    with pytest.raises(EvaluationError):
        promote(runner, run["id"], apply=True)
    runner.close()


def test_stale_feedback_preview_and_connection_cannot_publish(work):
    store, model, raw = setup(work)
    plan = prepare_optimization(store, model, raw)
    dev = plan["optimization"]["split"]["development"][0]
    case = store.case(dev)
    reason = next(f for f in case["feedback"]["subjects"].values() if f["rating"] == "unsatisfied")
    store.reason(dev, reason["subject"], "changed", case["feedback"]["revision"])
    with pytest.raises(EvaluationError, match="理由"):
        prepare_optimization(store, model, {**raw, "expected_plan": plan["fingerprint"]})
    runner, run = finish(store, model, raw)
    model.revision = "updated"
    with pytest.raises(EvaluationError, match="当前提示词或模型"):
        promote(runner, run["id"], apply=True)
    runner.close()


def test_call_budget_reserves_final_validation(work):
    store, model, raw = setup(work, max_calls=9)
    runner, run = finish(store, model, raw)
    # 6 development calls + 1 optimizer call leaves only the reserved final pair.
    assert run["calls"] <= 9
    assert run["final_run_id"]
    assert run["stages"][-1]["name"] == "validation"
    assert run["outcome"] == "unchanged"
    runner.close()


def test_cancellation_is_durable_for_parent_and_children_and_idempotent(work):
    store, model, raw = setup(work)
    reached, release = threading.Event(), threading.Event()
    original = model.request

    def blocked(route, payload=None):
        if route == "generate":
            reached.set()
            release.wait(10)
        return original(route, payload)

    model.request = blocked
    runner = EvaluationRunner(store, model)
    initial = start_optimization(runner, raw)
    assert reached.wait(10)
    assert start_optimization(runner, raw)["id"] == initial["id"]
    runner.cancel(initial["id"])
    release.set()
    runner.pool.shutdown(wait=True)
    assert all(r["status"] == "cancelled" for r in store.documents("runs"))
    assert len(model.requests) == 1
    assert model.cancelled
    runner.close()


def test_learning_trigger_uses_same_search_without_candidate_generation(work):
    from test_evaluations import CANDIDATE, SIGNAL, make_learning

    from ai_persona.evaluations.contracts import LEARNING

    _service, store, original, _ = make_learning(work, [SIGNAL, CANDIDATE])
    refs = []
    for index in range(4):
        payload = copy.deepcopy(original["input"])
        payload["event"]["conversation_id"] = f"conversation-{index // 2}"
        payload["event"]["message"]["content"] = [
            {
                "type": "text",
                "text": f"学习样例 {index} " + ("应该学习" if index % 2 == 0 else "临时请求"),
            }
        ]
        trace = store.create_result(
            LEARNING,
            input_data=payload,
            environment=original["environment"],
            prompt_snapshot=original["prompt_snapshot"],
        )
        trace = store.complete_result(
            trace["id"],
            state="completed",
            decisions=[
                {
                    "subject": {"kind": "learning_gate"},
                    "name": "学习",
                    "triggered": False,
                    "processing_state": "completed",
                }
            ],
        )
        case = click(store, trace, "unsatisfied" if index % 2 == 0 else "satisfied")
        refs.append({"case_id": case["case_id"], "benchmark_revision": case["benchmark_revision"]})
    model = OptimizerModel()
    original_request = model.request

    def request(route, raw=None):
        if route == "generate" and raw["task"] == "conversation_signal":
            model.requests.append(copy.deepcopy(raw))
            trigger = (
                "GENERAL_BOUNDARY" in raw["systemPrompt"]
                and "应该学习" in json.loads(raw["prompt"])["current_user_prompt"]
            )
            return {
                "text": json.dumps(
                    SIGNAL
                    if trigger
                    else {"decision": "ignore", "signals": [], "reason_code": "temporary"}
                ),
                "usage": {"totalTokens": 17},
            }
        return original_request(route, raw)

    model.request = request
    raw = {
        "mode": "learning_trigger",
        "cases": refs,
        "variants": [{"source": "active"}, {"source": "active"}],
        "repeat_count": 1,
        "max_calls": 100,
        "max_tokens": 5000000,
        "timeout_seconds": 90,
        "optimization": {
            "optimizer": {"connection_id": "fake", "model_id": "mock"},
            "max_rounds": 1,
        },
        "request_id": str(uuid.uuid4()),
        "confirmed_model_calls": True,
    }
    runner, run = finish(store, model, raw)
    assert run["status"] == "succeeded", run.get("error")
    assert run["outcome"] == "improved"
    assert len(run["optimization"]["split"]["validation"]) == 2
    assert all(r["task"] in {"conversation_signal", "maintenance"} for r in model.requests)
    assert all(
        "expected_trigger" not in r["prompt"]
        for r in model.requests
        if r["task"] == "conversation_signal"
    )
    runner.close()


def test_apply_recovers_transaction_history_after_report_write_failure(work, monkeypatch):
    from ai_persona.trigger_plans import publication_record

    store, model, raw = setup(work)
    runner, run = finish(store, model, raw)
    save = store.save_run
    monkeypatch.setattr(
        store, "save_run", lambda _value: (_ for _ in ()).throw(OSError("simulated interruption"))
    )
    record = promote(runner, run["id"], apply=True)
    assert publication_record(runner.prompts, run["id"])["id"] == record["id"]
    assert not store.document("runs", run["id"]).get("publication")
    monkeypatch.setattr(store, "save_run", save)
    restored = undo(runner, run["id"])
    assert restored["rolled_back_at"]
    assert (
        runner.prompts.snapshot()["versions"]["ai-persona.activation"]["id"]
        == run["current_plan"]["versions"]["ai-persona.activation"]
    )
    runner.close()


def test_import_keeps_history_without_starting_or_applying_and_can_copy(work, tmp_path):
    store, model, raw = setup(work)
    runner, run = finish(store, model, raw)
    backup = store.export("backup")
    restored = EvaluationStore(tmp_path / "restored-data", tmp_path / "restored-state")
    restored.import_data(backup)
    replay = EvaluationRunner(restored, model)
    calls = len(model.requests)
    with pytest.raises(EvaluationError, match="仅供查看"):
        promote(replay, run["id"], apply=True)
    copied = promote(replay, run["id"])
    assert copied["version"]["templates"]["system"].startswith("GENERAL_BOUNDARY")
    assert replay.prompts.snapshot()["trigger_models"] == {}
    assert len(model.requests) == calls
    assert not replay.active
    replay.close()
    runner.close()


def test_live_learning_uses_published_selection_effort_and_frozen_signature(work, monkeypatch):
    from test_evaluations import CANDIDATE, SIGNAL, Model, make_learning

    from ai_persona.evaluations.contracts import digest
    from ai_persona.trigger_plans import publish, signature

    prompts = PromptStore(work[1] / "prompts")
    snapshot = prompts.snapshot()
    key = "ai-persona.conversation-signal"
    selection = {"connectionId": "fake", "modelId": "mock", "revision": "1"}
    publish(
        prompts,
        key,
        snapshot["versions"][key]["id"],
        selection,
        "high",
        signature(snapshot, key),
        origin="test",
        previous_selection=selection,
    )
    sent = []
    original = Model.generate

    def generate(self, task, system, payload, **kwargs):
        sent.append((task, kwargs))
        return original(self, task, system, payload, **kwargs)

    monkeypatch.setattr(Model, "generate", generate)
    service, _store, result, _model = make_learning(work, [SIGNAL, CANDIDATE])
    signal = next(args for task, args in sent if task == "conversation_signal")
    assert signal["experiment_selection"] == selection
    assert signal["reasoning"] == "high"
    candidate = next(args for task, args in sent if task == "conversation_candidate")
    assert "experiment_selection" not in candidate
    checkpoint = json.loads(service.repository.get(result["task_ref"])["checkpoint"])
    assert checkpoint["model_signatures"]["conversation_signal"] == digest(
        snapshot_model := prompts.snapshot()["trigger_models"][key]
    )
    assert snapshot_model["selection"] == selection
