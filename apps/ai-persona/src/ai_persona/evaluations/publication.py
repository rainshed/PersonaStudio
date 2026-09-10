"""Explicit promotion of a reviewed experiment into one capability's live plan."""

from __future__ import annotations

from .. import trigger_plans
from .contracts import EvaluationError
from .planning import resolve_reasoning, resolve_selection


def candidate(runner, run_id, apply=False):
    run = runner.store.document("runs", run_id)
    if (apply and (run.get("imported") or run.get("parent_id"))) or run.get(
        "private_content_deleted"
    ):
        raise EvaluationError("此报告仅供查看，请复制候选后重新检查。", "not_publishable", 409)
    if run["status"] in {"queued", "running"} or len(run.get("variants", [])) != 2:
        raise EvaluationError("请先完成候选方案检查。", "not_publishable", 409)
    current = run.get("current_plan")
    if not current or run["variants"][0]["source"] != "active":
        raise EvaluationError("报告缺少当前方案基准，请重新检查。", "not_publishable", 409)
    for ref in run["suite"]["cases"] if apply else []:
        projection = runner.store.projection(ref["case_id"])
        if projection["benchmark_revision"] != ref["benchmark_revision"]:
            raise EvaluationError("样例已修改，请重新检查。", "case_changed", 409)
    base, value = run["variants"]
    if (
        base["selection"] != current["selection"]
        or base.get("reasoning") != current.get("reasoning")
        or any(
            {k: v["id"] for k, v in s["versions"].items()} != current["versions"]
            for s in base["snapshots"].values()
        )
    ):
        raise EvaluationError("比较基准与当时的当前方案不同，请重新检查。", "not_publishable", 409)
    key = current["prompt_id"]
    versions = [s["versions"][key] for s in value["snapshots"].values()]
    if not versions or len({v["id"] for v in versions}) != 1:
        raise EvaluationError("候选提示词版本不一致。", "not_publishable", 409)
    return run, versions[0]


def promote(runner, run_id, apply=False):
    with runner.lock, runner.store.mutex:
        if runner.active:
            raise EvaluationError("请等待正在进行的检查结束。", "busy", 409)
        run, version = candidate(runner, run_id, apply=apply)
        expected, value = run["current_plan"], run["variants"][1]
        if apply:
            if run["status"] != "succeeded" or not run.get("results"):
                raise EvaluationError(
                    "尚未完成最终比较，请先复制候选并手动检查。", "not_publishable", 409
                )
            active = runner.prompts.snapshot()
            config = trigger_plans.effective_config(runner.model.request("config"), active)
            selected, connection = resolve_selection(config, run["mode"], {})
            reasoning = resolve_reasoning(config, run["mode"], {}, selected, connection)
            if (
                selected != expected["selection"]
                or reasoning != expected.get("reasoning")
                or any(
                    active["versions"][key]["id"] != vid
                    for key, vid in expected["versions"].items()
                )
            ):
                raise EvaluationError(
                    "当前提示词或模型已改变，请重新比较后启用。", "plan_changed", 409
                )
            raw = {
                "connection_id": value["selection"]["connectionId"],
                "model_id": value["selection"]["modelId"],
                "reasoning": value.get("reasoning"),
            }
            chosen, connection = resolve_selection(config, run["mode"], raw)
            resolve_reasoning(config, run["mode"], raw, chosen, connection)
            if chosen != value["selection"]:
                raise EvaluationError("候选模型连接已改变，请重新比较。", "connection_changed", 409)
        # Save only after explicit user promotion; no draft is made active here.
        saved = runner.prompts.save_version(
            version["prompt_id"], version["templates"], version.get("note", "")
        )
        if not apply:
            return {
                "version": saved,
                "selection": value["selection"],
                "reasoning": value.get("reasoning"),
            }
        record = trigger_plans.publish(
            runner.prompts,
            version["prompt_id"],
            saved["id"],
            value["selection"],
            value.get("reasoning"),
            expected["signature"],
            origin=run_id,
            previous_selection=expected["selection"],
            previous_reasoning=expected.get("reasoning"),
        )
        run["publication"] = record
        try:
            runner.store.save_run(run)
        except OSError:
            # SQLite already committed the whole plan and its undo record.
            # A later read recovers publication from that authoritative history.
            pass
        return record


def undo(runner, run_id):
    with runner.lock, runner.store.mutex:
        if runner.active:
            raise EvaluationError("请等待当前检查结束。", "busy", 409)
        run = runner.store.document("runs", run_id)
        record = trigger_plans.publication_record(runner.prompts, run_id) or run.get("publication")
        if not record or run.get("imported"):
            raise EvaluationError("没有可回退的启用记录。")
        previous = record["before"]["model"]
        config = runner.model.request("config")
        selection = previous["selection"]
        raw = {
            "connection_id": selection["connectionId"],
            "model_id": selection["modelId"],
            "reasoning": previous.get("reasoning"),
        }
        selected, connection = resolve_selection(config, run["mode"], raw)
        resolve_reasoning(config, run["mode"], raw, selected, connection)
        if selected != selection:
            raise EvaluationError(
                "原模型连接已变化，不能直接回退，请重新选择方案。", "connection_changed", 409
            )
        record = trigger_plans.rollback(runner.prompts, record["id"])
        run["publication"] = record
        try:
            runner.store.save_run(run)
        except OSError:
            pass
        return record
