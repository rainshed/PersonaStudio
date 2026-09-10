"""Freeze and preview an evaluation without calling a model or publishing settings."""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path

from ..model_routing import model_task
from ..prompt_store import PromptStore
from ..trigger_plans import effective_config
from ..trigger_plans import signature as plan_signature
from .contracts import CAPABILITIES, EvaluationError, digest


def build_signature():
    root = Path(__file__).parents[1]
    paths = [
        *Path(__file__).parent.glob("*.py"),
        root / "ai_service.py",
        root / "conversation_learning/pipeline.py",
        root / "conversation_learning/input_text.py",
        root / "proposals.py",
    ]
    hasher = hashlib.sha256()
    for path in sorted(paths):
        hasher.update(path.name.encode())
        hasher.update(path.read_bytes())
    return hasher.hexdigest()


LEVELS = {"minimal", "low", "medium", "high", "xhigh", "max"}


def resolve_selection(config, mode, raw):
    if config.get("capabilities", {}).get("promptExperiments") != 1:
        raise EvaluationError("模型运行时需更新后才能固定实验模型。", "runtime_incompatible", 409)
    settings = config["settings"]
    task = (
        "activation"
        if mode == "activation"
        else "conversation_candidate"
        if mode == "learning_content"
        else "conversation_signal"
    )
    task = model_task(settings, task)
    configured = settings["overrides"].get(task) or settings["defaultConnectionId"]
    connection_id = raw.get("connection_id") or configured
    connection = next((c for c in settings["connections"] if c["id"] == connection_id), None)
    if not connection:
        raise EvaluationError("请先在模型设置配置连接。", "not_configured", 409)
    model_id = (
        raw.get("model_id")
        or (
            connection["modelId"]
            if raw.get("connection_id") and connection_id != configured
            else None
        )
        or (
            settings.get("overrideModelIds", {}).get(task)
            if settings["overrides"].get(task)
            else settings.get("defaultModelId")
        )
        or connection["modelId"]
    )
    if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 200:
        raise EvaluationError("请选择有效的模型。")
    return {
        "connectionId": connection_id,
        "modelId": model_id.strip(),
        "revision": connection["revision"],
    }, connection


def resolve_reasoning(config, mode, raw, selection, connection):
    task = model_task(config["settings"], "activation" if mode == "activation" else "conversation_candidate" if mode == "learning_content" else "conversation_signal")
    reasoning = raw.get("reasoning")
    if "reasoning" not in raw and not raw.get("connection_id") and not raw.get("model_id"):
        reasoning = config["settings"].get("overrideReasoning", {}).get(task)
    if reasoning is None:
        return None
    provider = next((p for p in config.get("providers", []) if p["id"] == connection["providerId"]), {})
    entry = next((m for m in provider.get("models", []) if m["id"] == selection["modelId"]), {})
    if config.get("capabilities", {}).get("evaluationReasoning") != 1:
        raise EvaluationError("请更新模型服务后设置思考强度。", "runtime_incompatible", 409)
    if not isinstance(reasoning, str) or reasoning not in entry.get("reasoningLevels", []):
        raise EvaluationError("当前模型不支持所选思考强度，请重新选择。", "invalid_reasoning", 409)
    return reasoning


def prepare(store, model, raw):
    allowed = {
        "suite_id",
        "cases",
        "mode",
        "variants",
        "connection_id",
        "model_id",
        "max_calls",
        "max_tokens",
        "timeout_seconds",
        "confirmed_model_calls",
        "expected_selection",
        "repeat_count",
        "expected_plan",
        "request_id",
    }
    if not isinstance(raw, dict) or set(raw) - allowed:
        raise EvaluationError("检查配置包含不支持的字段。")
    mode = raw.get("mode")
    capability = next((c for c in CAPABILITIES if mode in c["modes"]), None)
    if not capability:
        raise EvaluationError("回放模式无效。")
    if raw.get("suite_id") and "cases" in raw:
        raise EvaluationError("请选择一个测试集或一组样例。")
    suite = store.document("suites", raw["suite_id"]) if raw.get("suite_id") else None
    refs = suite["cases"] if suite else raw.get("cases")
    if not isinstance(refs, list) or not 1 <= len(refs) <= 200:
        raise EvaluationError("请选择 1–200 条样例。")
    cases = []
    for ref in refs:
        if (
            not isinstance(ref, dict)
            or "case_id" not in ref
            or set(ref) - {"case_id", "benchmark_revision"}
        ):
            raise EvaluationError("样例配置无效。")
        case = store.projection(ref["case_id"], ref.get("benchmark_revision"))
        if case["capability_id"] != capability["id"]:
            raise EvaluationError("本次测试集只能包含同一业务能力。")
        if mode not in case["replay_capabilities"]:
            raise EvaluationError("所选样例缺少此模式的必要快照。", "missing_snapshot", 409)
        cases.append(case)
    if len({c["case_id"] for c in cases}) != len(cases):
        raise EvaluationError("同一测试集不能重复包含样例。")
    repeats = raw.get("repeat_count", 1)
    if type(repeats) is not int or not 1 <= repeats <= 10:
        raise EvaluationError("每条样例的重复次数应为 1–10。")
    variants = raw.get("variants", [{"source": "original"}, {"source": "active"}])
    if not isinstance(variants, list) or not 1 <= len(variants) <= 2:
        raise EvaluationError("请选择一到两个方案。")
    prompts = PromptStore(store.state_root / "prompts")
    active = prompts.snapshot()  # One baseline for the entire experiment, including both variants.
    config = effective_config(model.request("config"), active)
    used_prompts = set(capability["prompts"])
    if mode == "learning_trigger":
        used_prompts = {"ai-persona.conversation-signal"}
    elif mode == "learning_content":
        used_prompts = {"ai-persona.conversation-candidate"}
    pending = list(used_prompts)
    while pending:
        for dependency in prompts.definition(pending.pop()).get("dependencies", []):
            if dependency not in used_prompts:
                used_prompts.add(dependency)
                pending.append(dependency)
    frozen = []
    for index, variant in enumerate(variants):
        if (
            not isinstance(variant, dict)
            or set(variant) - {"source", "versions", "connection_id", "model_id", "reasoning"}
            or variant.get("source") not in {"original", "active"}
        ):
            raise EvaluationError("方案配置无效。")
        overrides = variant.get("versions", {})
        if not isinstance(overrides, dict) or set(overrides) - set(capability["prompts"]):
            raise EvaluationError("只能替换当前能力的提示词。")
        selected, connection = resolve_selection(config, mode, {**raw, **variant})
        reasoning = resolve_reasoning(config, mode, variant, selected, connection)
        snapshots = {}
        for case in cases:
            bundle = copy.deepcopy(
                case["result"]["prompt_snapshot"] if variant["source"] == "original" else active
            )
            if not bundle:
                raise EvaluationError("旧样例缺少原提示词版本。", "missing_snapshot", 409)
            for key, version in overrides.items():
                bundle["versions"][key] = prompts.version(key, version)
            bundle["versions"] = {key: bundle["versions"][key] for key in used_prompts}
            bundle.pop("trigger_models", None)  # Selection is explicit in every replay.
            for key in used_prompts:
                prompts.compatible(key, bundle["versions"][key])
            bundle["fingerprint"] = digest({k: v["id"] for k, v in bundle["versions"].items()})
            snapshots[case["case_id"]] = bundle
        frozen.append(
            {
                "source": variant["source"],
                "snapshots": snapshots,
                "selection": selected,
                "reasoning": reasoning,
                "connection_name": connection.get("name", connection["id"]),
                "provider_id": connection["providerId"],
                "label": "AB"[index],
            }
        )
    per_case_calls = {
        "activation": 1,
        "learning_trigger": 2,
        "learning_content": 6,
        "learning_pipeline": 8,
    }[mode]
    replays = len(cases) * len(frozen) * repeats
    maximum_calls = replays * per_case_calls
    budget = {}
    for key, default, minimum, maximum in [
        ("max_calls", max(50, min(500, maximum_calls)), 1, 500),
        ("max_tokens", 200000, 1000, 5000000),
        ("timeout_seconds", 900, 10, 7200),
    ]:
        value = raw.get(key, default)
        if type(value) is not int or not minimum <= value <= maximum:
            raise EvaluationError(f"{key} 超出允许范围。")
        budget[key] = value
    refs = [{"case_id": c["case_id"], "benchmark_revision": c["benchmark_revision"]} for c in cases]
    # Feedback reasons are deliberately absent from the plan, its digest, and all model inputs.
    identity = {
        "cases": refs,
        "build_signature": build_signature(),
        "labels": [c["trigger_labels"] for c in cases],
        "mode": mode,
        "variants": frozen,
        "repeat_count": repeats,
        "budget": budget,
    }
    fingerprint = digest(identity)
    if raw.get("expected_plan") and raw["expected_plan"] != fingerprint:
        raise EvaluationError("样例、提示词或模型配置已变化，请重新确认检查。", "plan_changed", 409)
    if (
        raw.get("expected_selection") is not None
        and raw["expected_selection"] != frozen[0]["selection"]
    ):
        raise EvaluationError("模型连接已变化，请重新确认本次实际模型。", "selection_changed", 409)
    current_plan = None
    if mode in {"activation", "learning_trigger"}:
        key = "ai-persona.activation" if mode == "activation" else "ai-persona.conversation-signal"
        current_selection, current_connection = resolve_selection(config, mode, {})
        current_plan = {
            "prompt_id": key, "signature": plan_signature(active, key),
            "selection": current_selection,
            "reasoning": resolve_reasoning(config, mode, {}, current_selection, current_connection),
            "versions": {key: active["versions"][key]["id"] for key in used_prompts},
        }
    return {
        "suite": suite,
        "cases": cases,
        "refs": refs,
        "capability": capability,
        "mode": mode,
        "variants": frozen,
        "repeat_count": repeats,
        "budget": budget,
        "fingerprint": fingerprint,
        "planned_replays": replays,
        "maximum_calls": maximum_calls,
        "current_plan": current_plan,
    }


def public_preview(plan):
    return {
        "fingerprint": plan["fingerprint"],
        "cases": plan["refs"],
        "mode": plan["mode"],
        "repeat_count": plan["repeat_count"],
        "budget": plan["budget"],
        "planned_replays": plan["planned_replays"],
        "maximum_calls": plan["maximum_calls"],
        "budget_may_limit_run": plan["maximum_calls"] > plan["budget"]["max_calls"],
        "coverage": {
            "should_trigger": sum(
                v["expected_trigger"] for c in plan["cases"] for v in c["trigger_labels"]
            ),
            "should_not_trigger": sum(
                not v["expected_trigger"] for c in plan["cases"] for v in c["trigger_labels"]
            ),
        },
        "variants": [
            {k: v for k, v in variant.items() if k != "snapshots"}
            | {
                "prompt_versions": {
                    case_id: {
                        key: {"id": v["id"], "note": v.get("note", "")}
                        for key, v in bundle["versions"].items()
                        if key in plan["capability"]["prompts"]
                    }
                    for case_id, bundle in variant["snapshots"].items()
                }
            }
            for variant in plan["variants"]
        ],
    }
