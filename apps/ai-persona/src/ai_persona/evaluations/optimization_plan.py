"""Freeze optimization inputs and keep related/exposed examples out of validation."""

from __future__ import annotations

import copy
import itertools

from ..trigger_plans import effective_config
from .contracts import EvaluationError, digest
from .planning import prepare, public_preview, resolve_reasoning, resolve_selection


def group_keys(case):
    result = case["result"]
    keys = ["group:" + case["group_id"], "input:" + digest(result["input"])]
    from .store import EvaluationStore

    text = " ".join(EvaluationStore.input_text(result).split()).casefold()
    if text:
        keys.append("text:" + digest(text))
    event = result["input"].get("event", {})
    if event.get("conversation_id"):
        keys.append(
            "conversation:" + digest([event.get("source_connection_id"), event["conversation_id"]])
        )
    task = result.get("task_ref")
    if task and not task.startswith("evaluation:"):
        keys.append("task:" + task)
    return keys


def split_cases(store, cases):
    # Conservatively treat any previously evaluated case as exposed. This also
    # covers manual edits informed by a previous report, not just optimizer calls.
    exposed = set()
    for run in store.documents("runs"):
        exposed.update(run.get("exposed_groups", []))
        for item in run.get("results", []):
            if item.get("calls") or item.get("status") == "succeeded":
                try:
                    exposed.update(group_keys(store.projection(item["case_id"])))
                except EvaluationError:
                    pass
    groups = []
    for case in cases:
        keys = set(group_keys(case))
        matches = [g for g in groups if g["keys"] & keys]
        group = {"keys": keys, "cases": [case]}
        for old in matches:
            group["keys"].update(old["keys"])
            group["cases"].extend(old["cases"])
            groups.remove(old)
        groups.append(group)
    groups.sort(key=lambda g: digest(sorted(g["keys"])))

    def covered(items):
        return {
            v["expected_trigger"] for g in items for c in g["cases"] for v in c["trigger_labels"]
        } == {True, False}

    eligible = [g for g in groups if not g["keys"] & exposed]
    # One mixed group or two complementary groups suffice for final validation;
    # retain both classes in development. No arbitrary percentage for tiny sets.
    validation = []
    for count in (1, 2):
        for candidate in itertools.combinations(eligible, count):
            remaining = [g for g in groups if g not in candidate]
            if covered(candidate) and covered(remaining):
                validation = list(candidate)
                break
        if validation:
            break
    final_ids = {c["case_id"] for g in validation for c in g["cases"]}
    return {
        "development": [c["case_id"] for c in cases if c["case_id"] not in final_ids],
        "validation": sorted(final_ids),
        "groups": len(groups),
        "previously_exposed": sum(bool(g["keys"] & exposed) for g in groups),
        "independent_validation": bool(validation),
        "grouping_note": "按已有会话、任务及相同输入分组；来源记录不完整或语义相近时，仍不能保证完全独立。",
        "limitation": ""
        if validation
        else "缺少同时覆盖两类判断的独立验收样例；结果仅用于探索，不能证明泛化改善。",
    }


def prepare_optimization(store, model, raw):
    raw = copy.deepcopy(raw)
    options = raw.pop("optimization", {})
    expected = raw.pop("expected_plan", None)
    if not isinstance(options, dict) or set(options) - {"optimizer", "max_rounds"}:
        raise EvaluationError("自动改进配置无效。")
    rounds = options.get("max_rounds", 3)
    if type(rounds) is not int or not 1 <= rounds <= 10:
        raise EvaluationError("最多改进轮数应为 1–10。")
    base = prepare(store, model, raw)
    if base["mode"] not in {"activation", "learning_trigger"}:
        raise EvaluationError("自动改进仅支持两种触发判断。")
    if len(base["variants"]) != 2 or raw["variants"][0] != {"source": "active"}:
        raise EvaluationError("自动改进需以当前方案作为固定基准。")
    from ..prompt_store import PromptStore

    config = effective_config(
        model.request("config"), PromptStore(store.state_root / "prompts").snapshot()
    )
    optimizer = options.get("optimizer", {})
    if not isinstance(optimizer, dict) or set(optimizer) - {
        "connection_id",
        "model_id",
        "reasoning",
    }:
        raise EvaluationError("改进模型配置无效。")
    if not optimizer.get("connection_id") or not optimizer.get("model_id"):
        raise EvaluationError("请选择改进模型。")
    selection, connection = resolve_selection(config, base["mode"], optimizer)
    optimizer = {
        "selection": selection,
        "reasoning": resolve_reasoning(config, base["mode"], optimizer, selection, connection),
        "connection_name": connection.get("name", connection["id"]),
        "provider_id": connection["providerId"],
    }
    split = split_cases(store, base["cases"])
    feedback = {}
    for key in split["development"]:
        value = store.case(key)["feedback"]
        feedback[key] = {
            "revision": value["revision"],
            "reasons": [
                {"subject": f["subject"], "reason": f["reason"]}
                for f in value["subjects"].values()
                if f["active"] and f["rating"] == "unsatisfied" and f.get("reason")
            ],
        }
    base["optimization"] = {
        "optimizer": optimizer,
        "max_rounds": rounds,
        "split": split,
        "feedback": feedback,
    }
    base["fingerprint"] = digest(
        {"base": base["fingerprint"], "optimization": base["optimization"]}
    )
    if expected and expected != base["fingerprint"]:
        raise EvaluationError("样例、反馈理由或方案已变化，请重新确认。", "plan_changed", 409)
    return base


def optimization_preview(plan):
    value = public_preview(plan)
    opt = plan["optimization"]
    unit = 1 if plan["mode"] == "activation" else 2
    repeats = plan["repeat_count"]
    dev, final = len(opt["split"]["development"]), len(opt["split"]["validation"])
    value["maximum_calls"] = (2 * dev * (1 + opt["max_rounds"]) + 2 * final) * repeats * unit + opt[
        "max_rounds"
    ]
    value["budget_may_limit_run"] = value["maximum_calls"] > plan["budget"]["max_calls"]
    value["optimization"] = {k: v for k, v in opt.items() if k != "feedback"}
    value["optimization"]["final_reserved_calls"] = 2 * final * repeats * unit
    return value


def compare(run, shorter=False):
    """Pareto decision; missing judgments cannot improve a score by shrinking its denominator."""
    variants = run.get("report", {}).get("variants", {})
    if not all(k in variants for k in ("A", "B")):
        return "insufficient"
    a, b = variants["A"], variants["B"]
    keys = ("should_not_trigger", "should_trigger")
    if any(
        v["completion"]["rate"] != 1 or v["failures"] or v["not_run"] or v["pending"]
        for v in (a, b)
    ):
        return "insufficient"
    if any(not a[k]["denominator"] or a[k]["denominator"] != b[k]["denominator"] for k in keys):
        return "insufficient"
    deltas = [b[k]["numerator"] - a[k]["numerator"] for k in keys]
    if min(deltas) >= 0 and max(deltas) > 0:
        return "improved"
    if min(deltas) < 0:
        return "tradeoff" if max(deltas) > 0 else "regressed"
    return "simplified" if shorter else "unchanged"
