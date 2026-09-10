"""Pure business replay: frozen reads, no production repository/worker writes."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

from ..ai_service import ActivationOutput, PersonaAIService
from ..conversation_learning.contracts import (
    CandidateOutput,
    ConversationEvent,
    LearningSettings,
    SignalOutput,
    SourceConnection,
)
from ..conversation_learning.input_text import INPUT_TEXT_VERSION, learning_text
from ..conversation_learning.pipeline import LearningPipeline
from ..conversation_learning.policy import authorized, origin_basis
from ..material_analysis import compact_schema
from .business import restore_persona
from .contracts import EvaluationError, activation_decisions, digest, learning_gate


def replay(case, mode, call):
    """call(prompt_id, payload, output_model, max_tokens) is the sole external port."""
    result = case["result"]
    if mode not in result_modes(case):
        raise EvaluationError("此样例缺少所选模式的必要快照。", "missing_snapshot", 409)
    if mode == "activation":
        payload = result["input"]
        output = call(
            "ai-persona.activation",
            payload,
            ActivationOutput,
            min(16000, max(2048, len(payload["catalog"]) * 160)),
        )
        return {"decisions": activation_decisions(output, payload["catalog"]), "generation": []}

    event = ConversationEvent.model_validate(result["input"]["event"])
    row = {
        "snapshot": json.dumps(result["input"]["snapshot"])
        if result["input"].get("snapshot")
        else None
    }
    if mode == "learning_content":
        original = result.get("candidate_input")
        if not original:
            raise EvaluationError("原候选阶段输入已缺失。", "missing_snapshot", 409)
        original = {**original, "current_user_prompt": event.message.learning_text}
        signal = SignalOutput(decision="observe", signals=original["observations"])
        gate = None  # A candidate-only experiment does not evaluate the gate.
    else:
        payload = {
            "current_user_prompt": event.message.learning_text,
            "context": LearningPipeline.context_messages(row, event),
            "output_schema": compact_schema(SignalOutput.model_json_schema()),
        }
        signal = (
            call("ai-persona.conversation-signal", payload, SignalOutput, 1500)
            if event.message.learning_text.strip()
            else SignalOutput(decision="ignore", reason_code="empty_user_input")
        )
        if signal.decision == "needs_context":
            expanded = result.get("expanded_context")
            if (
                expanded is not None
                and result["input"].get("input_text_version") != INPUT_TEXT_VERSION
            ):
                expanded = [
                    {**message, "text": text}
                    for message in expanded
                    if (text := learning_text(message["text"], role=message["role"])).strip()
                ]
            if expanded is not None and expanded != payload["context"]:
                signal = call(
                    "ai-persona.conversation-signal",
                    {**payload, "context": expanded},
                    SignalOutput,
                    1500,
                )
        gate = learning_gate(signal)
    decisions = (
        []
        if mode == "learning_content"
        else [
            {
                "subject": {"kind": "learning_gate"},
                "name": "对话学习",
                "triggered": gate,
                "processing_state": "waiting_context" if gate is None else "completed",
            }
        ]
    )
    value = {"decisions": decisions, "generation": [], "signal": signal.model_dump(mode="json")}
    if mode == "learning_trigger" or (mode != "learning_content" and gate is not True):
        return value
    environment = result["environment"]
    settings = LearningSettings.model_validate(environment["settings"])
    connection = SourceConnection.model_validate(environment["connection"])
    if not authorized(connection, event) or not origin_basis(
        connection, event, human_confirmed=environment.get("human_confirmed", False)
    ):
        return {**value, "policy_state": "waiting_source", "generation": []}
    store, history = restore_persona(environment)
    # Construct only the pure planning surface: no live queue, model client,
    # proposal repository or context provider is available to this instance.
    pipeline = object.__new__(LearningPipeline)
    pipeline.frozen_history = history
    pipeline.frozen_history_order = environment.get("history_order")

    def request(payload):
        return call("ai-persona.conversation-candidate", payload, CandidateOutput, 6000)

    with tempfile.TemporaryDirectory(prefix="ai-persona-replay-queries-") as query_directory:
        pipeline.service = SimpleNamespace(
            data_root=Path(query_directory) / "data", state_root=Path(query_directory) / "state"
        )
        pipeline.query_snapshot = store
        if mode == "learning_content":
            # Frozen candidate input with the current user-text projection; additional
            # reads use the frozen corpus. Review gold never invents signals.
            selected_ids = {r["id"] for r in original["records"]}
            selected = [store.records[i] for i in selected_ids if i in store.records]
            output, selected = pipeline.candidate_rounds(
                event, signal, store, request, selected, original
            )
        else:
            output, selected = pipeline.candidate_rounds(event, signal, store, request)
        changes = pipeline.validate_changes(output, signal.signals, store, selected, settings)
        serialized = [c.model_dump(mode="json") for c in changes]
        # The application's in-memory validation is reused; its repositories are
        # rooted in a fresh temporary directory, not the user's Persona.
        with tempfile.TemporaryDirectory(prefix="ai-persona-evaluation-") as directory:
            validator = object.__new__(PersonaAIService)
            validator.data_root = Path(directory) / "data"
            validator.state_root = Path(directory) / "state"
            validator._validate_candidates(serialized, store)
        return {
            **value,
            "generation": serialized,
            "validation": {
                "issues": [],
                "coverage": ["候选结构", "业务引用", "范围", "去重", "关系约束"],
            },
        }


def result_modes(case):
    return case.get("replay_capabilities", [])


def score(case, output, mode):
    actual = {digest(d["subject"]): d["triggered"] for d in output.get("decisions", [])}
    labels = [] if mode == "learning_content" else case["trigger_labels"]
    units = []
    for label in labels:
        predicted = actual.get(digest(label["subject"]))
        units.append(
            {
                "subject": label["subject"],
                "expected": label["expected_trigger"],
                "actual": predicted,
                "completed": type(predicted) is bool,
                "correct": type(predicted) is bool and predicted == label["expected_trigger"],
            }
        )
    gold = case["content_gold"]
    content_allowed = mode == "learning_content" or any(
        label["expected_trigger"] for label in labels
    )
    return {
        "units": units,
        "content": {
            "reference_count": len(gold) if content_allowed else 0,
            "generated_count": len(output.get("generation", [])),
            "scope": "approved_items_only",
            "semantic_status": "pending_review"
            if gold and content_allowed and mode in {"learning_content", "learning_pipeline"}
            else "not_scored",
        },
        "validation": output.get("validation", {"issues": [], "coverage": ["触发契约"]}),
    }


def summarize(items):
    """Count explicit judgments, keeping missing results and repeated trials separate."""

    def fraction(n, d):
        return {"numerator": n, "denominator": d, "rate": n / d if d else None}

    summaries = {}
    for label in dict.fromkeys(i.get("variant") for i in items if i.get("variant")):
        values = [i for i in items if i.get("variant") == label and i.get("status") != "deleted"]
        units = [u for i in values for u in i.get("score", {}).get("units", [])]
        completed = [u for u in units if u["completed"]]
        correct = sum(u["correct"] for u in completed)
        negative = [u for u in completed if not u["expected"]]
        positive = [u for u in completed if u["expected"]]
        trials = {}
        for item in values:
            for unit in item.get("score", {}).get("units", []):
                key = (item["case_id"], digest(unit["subject"]))
                trials.setdefault(key, []).append(unit)
        repeated = [trial for trial in trials.values() if len(trial) > 1]
        stable_ready = [trial for trial in repeated if all(u["completed"] for u in trial)]
        summaries[label] = {
            "cases": len({i["case_id"] for i in values}),
            "replays": len(values),
            "groups": len({i.get("group_id") for i in values}),
            "failures": sum(i["status"] == "failed" for i in values),
            "pending": sum(i["status"] in {"queued", "running"} for i in values),
            "not_run": sum(i["status"] == "not_run" for i in values),
            "undecided": sum(
                not u["completed"]
                for i in values
                if i["status"] == "succeeded"
                for u in i.get("score", {}).get("units", [])
            ),
            "accuracy": fraction(correct, len(completed)),
            "completion": fraction(len(completed), len(units)),
            "all_success": fraction(correct, len(units)),
            "should_not_trigger": fraction(sum(u["correct"] for u in negative), len(negative)),
            "should_trigger": fraction(sum(u["correct"] for u in positive), len(positive)),
            "coverage": {
                "should_trigger": sum(u["expected"] for u in units),
                "should_not_trigger": sum(not u["expected"] for u in units),
            },
            "stability": fraction(
                sum(len({u["actual"] for u in trial}) == 1 for trial in stable_ready),
                len(stable_ready),
            ),
            "stability_incomplete": len(repeated) - len(stable_ready),
            "false_positive": fraction(sum(u["actual"] for u in negative), len(negative)),
            "false_negative": fraction(sum(not u["actual"] for u in positive), len(positive)),
        }
    pairs = []
    by_trial = {}
    for item in items:
        by_trial.setdefault((item.get("case_id"), item.get("repeat_index", 1)), {})[
            item.get("variant")
        ] = item
    for (key, repeat_index), pair in by_trial.items():
        a, b = pair.get("A"), pair.get("B")
        if not a or not b:
            continue
        if a["status"] != "succeeded" or b["status"] != "succeeded":
            state = "not_comparable"
        else:
            a_units = a.get("score", {}).get("units", [])
            b_units = b.get("score", {}).get("units", [])
            if (
                not a_units
                or len(a_units) != len(b_units)
                or not all(u["completed"] for u in [*a_units, *b_units])
            ):
                state = "needs_review"
            else:
                av, bv = sum(u["correct"] for u in a_units), sum(u["correct"] for u in b_units)
                state = "improved" if bv > av else "regressed" if bv < av else "unchanged"
        pairs.append({"case_id": key, "repeat_index": repeat_index, "change": state})
    return {"variants": summaries, "comparison": pairs}
