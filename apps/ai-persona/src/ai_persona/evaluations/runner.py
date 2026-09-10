"""Bounded background evaluation jobs. Explicit start is the only model entry."""

from __future__ import annotations

import copy
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from ..ai_service import ActivationOutput, LegacyActivationOutput, parse_output
from ..prompt_store import PromptStore
from .contracts import EvaluationError, digest, now
from .planning import build_signature, prepare, resolve_selection  # noqa: F401
from .replay import replay, score, summarize


class EvaluationRunner:
    def __init__(self, store, model):
        self.store, self.model = store, model
        self.prompts = PromptStore(store.state_root / "prompts")
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="persona-evaluation")
        self.lock = threading.RLock()
        self.active = {}
        for run in store.documents("runs"):
            if run["status"] in {"queued", "running"}:
                self._finish_pending(run, "interrupted")
                store.save_run({**run, "status": "interrupted", "finished_at": now()})

    def model_options(self):
        return self.model.request("config")

    def start(self, raw):
        if raw.get("confirmed_model_calls") is not True:
            raise EvaluationError("请明确确认将所选样例发送给配置的模型。")
        request_id = raw.get("request_id")
        if request_id is not None and (
            not isinstance(request_id, str) or not 1 <= len(request_id) <= 80
        ):
            raise EvaluationError("检查请求标识无效。")
        with self.lock:
            if request_id:
                for previous in self.store.documents("runs"):
                    if previous.get("request_id") == request_id:
                        if previous.get("request_fingerprint") != digest(raw):
                            raise EvaluationError(
                                "此请求标识已用于另一组检查配置。", "conflict", 409
                            )
                        return previous
            if self.active:
                raise EvaluationError("已有回测进行中，请等待或取消。", "busy", 409)
            plan = prepare(self.store, self.model, raw)
            run = self.create_run(plan, raw)
            initial = self.store.save_run(run)
            self.active[run["id"]] = {"cancel": threading.Event(), "call_id": None}
            self.pool.submit(self._run, run)
        return initial

    def create_run(self, plan, raw):
        suite = plan["suite"] or self.store.save_suite(plan["capability"]["name"], plan["refs"])
        run = {
            "id": "eval_" + uuid.uuid4().hex,
            "created_at": now(),
            "status": "queued",
            "capability_id": plan["capability"]["id"],
            "suite": suite,
            "mode": plan["mode"],
            "variants": plan["variants"],
            "selection": plan["variants"][0]["selection"],
            "budget": plan["budget"],
            "repeat_count": plan["repeat_count"],
            "plan_fingerprint": plan["fingerprint"],
            "planned_replays": plan["planned_replays"],
            "build_signature": build_signature(),
            "results": [],
            "planned_scores": {
                case["case_id"]: score(case, {"decisions": []}, plan["mode"])
                for case in plan["cases"]
            },
            "calls": 0,
            "reserved_tokens": 0,
            "actual_tokens": 0,
            "report": {},
            "provider_id": plan["variants"][0]["provider_id"],
            "workflow_version": 2 if "repeat_count" in raw or "expected_plan" in raw else 1,
            "request_id": raw.get("request_id"),
            "request_fingerprint": digest(raw),
        }
        if run["workflow_version"] == 2:
            groups = {c["case_id"]: c["group_id"] for c in plan["cases"]}
            for ref, index, repeat_index in self._schedule(run):
                run["results"].append(
                    {
                        **ref,
                        "variant": "AB"[index],
                        "repeat_index": repeat_index,
                        "id": "check_" + uuid.uuid4().hex,
                        "status": "queued",
                        "calls": [],
                        "group_id": groups[ref["case_id"]],
                        "input_preview": next(
                            self.store.input_text(c["result"])[:200]
                            for c in plan["cases"]
                            if c["case_id"] == ref["case_id"]
                        ),
                        "score": copy.deepcopy(run["planned_scores"][ref["case_id"]]),
                    }
                )
            run["report"] = summarize(run["results"])
        run["current_plan"] = plan.get("current_plan")
        return run

    def execute_plan(self, plan, control, model, on_created):
        """Internal synchronous stage; the parent owns the single execution slot."""
        run = self.create_run(plan, {"repeat_count": plan["repeat_count"]})
        run["parent_id"] = control["parent_id"]
        with self.lock:
            if control["cancel"].is_set():
                raise EvaluationError("自动改进已取消。", "cancelled", 409)
            self.store.save_run(run)
            self.active[run["id"]] = control
            on_created(run)
        self._run(run, model=model)
        return self.store.document("runs", run["id"])

    @staticmethod
    def _schedule(run):
        for repeat_index in range(1, run.get("repeat_count", 1) + 1):
            for case_index, ref in enumerate(run["suite"]["cases"]):
                order = list(range(len(run["variants"])))
                if run.get("workflow_version") == 2 and (case_index + repeat_index - 1) % 2:
                    order.reverse()
                for index in order:
                    yield ref, index, repeat_index

    @staticmethod
    def _finish_pending(run, reason):
        for item in run.get("call_log", []):
            if item.get("status") == "running":
                item.update(status=reason, finished_at=now())
        for item in run.get("stages", []):
            if item.get("status") in {"queued", "running"}:
                item["status"] = reason
        for item in run.get("results", []):
            if item["status"] in {"queued", "running"}:
                item.update(status="not_run", error={"code": reason, "message": "本次判断未完成。"})
        run["report"] = summarize(run.get("results", []))

    def _run(self, run, model=None):
        model = model or self.model
        run_id = run["id"]
        active = self.active[run_id]
        deadline = time.monotonic() + run["budget"]["timeout_seconds"]
        run["status"] = "running"
        try:
            self.store.save_run(run)
            for case_ref, index, repeat_index in self._schedule(run):
                if active["cancel"].is_set():
                    return
                variant = run["variants"][index]
                label = "AB"[index]
                item = next(
                    (
                        r
                        for r in run["results"]
                        if r.get("case_id") == case_ref["case_id"]
                        and r.get("variant") == label
                        and r.get("repeat_index") == repeat_index
                    ),
                    None,
                )
                if item is None:
                    item = {
                        **case_ref,
                        "variant": label,
                        "repeat_index": repeat_index,
                        "id": "check_" + uuid.uuid4().hex,
                        "status": "failed",
                        "calls": [],
                    }
                if run.get("workflow_version") == 2:
                    item.update(status="running", started_at=now())
                    run["report"] = summarize(run["results"])
                    self.store.save_run(run)
                started = time.monotonic()
                case = None
                try:
                    case = self.store.projection(
                        case_ref["case_id"], case_ref["benchmark_revision"]
                    )
                    item["group_id"] = case["group_id"]
                    item["reference"] = {
                        "input": case["result"]["input"],
                        "original_output": case["result"].get("generation"),
                        "content_gold": case["content_gold"],
                    }

                    def call(prompt_id, payload, output_type, max_tokens):
                        if active["cancel"].is_set():
                            raise EvaluationError("回测已取消。", "cancelled", 409)
                        # Recheck revocation/deletion before EVERY model call.
                        self.store.projection(case_ref["case_id"], case_ref["benchmark_revision"])
                        bundle = variant["snapshots"][case_ref["case_id"]]
                        if prompt_id == "ai-persona.activation":
                            output_type = (
                                ActivationOutput
                                if bundle["versions"][prompt_id]["signature"]
                                == self.prompts.signature(prompt_id)
                                else LegacyActivationOutput
                            )
                            payload = {**payload, "output_schema": output_type.model_json_schema()}
                        preview = self.prompts.preview(
                            prompt_id,
                            {"payload": payload},
                            snapshot=bundle,
                            legacy_activation=prompt_id == "ai-persona.activation",
                        )
                        reservation = (
                            len(
                                (
                                    preview["rendered"]["system"] + preview["rendered"]["user"]
                                ).encode()
                            )
                            + max_tokens
                        )
                        if (
                            time.monotonic() >= deadline
                            or run["calls"] >= run["budget"]["max_calls"]
                            or run["reserved_tokens"] + reservation > run["budget"]["max_tokens"]
                        ):
                            raise EvaluationError(
                                "已达到回测调用、时间或 token 预算。", "budget_exhausted", 409
                            )
                        run["calls"] += 1
                        run["reserved_tokens"] += reservation
                        # The Pi daemon accepts only alphanumerics/hyphens;
                        # evaluation document IDs contain an underscore.
                        call_id = f"{run_id.replace('_', '-')}-{run['calls']}"
                        active["call_id"] = call_id

                        def cancel_call():
                            try:
                                model.cancel(call_id)
                            except Exception:
                                pass

                        timer = threading.Timer(max(0.01, deadline - time.monotonic()), cancel_call)
                        timer.daemon = True
                        timer.start()
                        try:
                            active["variant"] = label
                            with self.lock:
                                if not active["cancel"].is_set():
                                    self.store.save_run(run)
                            raw = model.request(
                                "generate",
                                {
                                    "task": self.prompts.definition(prompt_id)["task"],
                                    "systemPrompt": preview["rendered"]["system"],
                                    "prompt": preview["rendered"]["user"],
                                    "maxTokens": max_tokens,
                                    "runId": call_id,
                                    "stage": "benchmark",
                                    "experimentSelection": variant.get(
                                        "selection", run["selection"]
                                    ),
                                    **(
                                        {"reasoning": variant["reasoning"]}
                                        if variant.get("reasoning") is not None
                                        else {}
                                    ),
                                },
                            )
                        finally:
                            timer.cancel()
                            active["call_id"] = None
                        if active["cancel"].is_set() or time.monotonic() >= deadline:
                            raise EvaluationError("回测已取消或达到时间预算。", "cancelled", 409)
                        self.store.projection(case_ref["case_id"], case_ref["benchmark_revision"])
                        usage = raw.get("usage", {}) or {}
                        total = usage.get("totalTokens")
                        if type(total) is not int:
                            total = sum(
                                usage.get(k, 0)
                                for k in ("input", "output", "cacheRead", "cacheWrite")
                                if type(usage.get(k)) is int
                            )
                        run["actual_tokens"] += total
                        item["calls"].append(
                            {
                                "prompt_id": prompt_id,
                                "payload": payload,
                                "max_tokens": max_tokens,
                                "versions": preview["versions"],
                                "model": {k: v for k, v in raw.items() if k != "text"},
                                "output": raw.get("text", ""),
                            }
                        )
                        with self.lock:
                            if not active["cancel"].is_set():
                                self.store.save_run(run)
                        return parse_output(raw, output_type)

                    output = replay(case, run["mode"], call)
                    item.update(
                        status="succeeded",
                        output=output,
                        score=score(case, output, run["mode"]),
                    )
                    # A new generated result is only a temporary trace, not a case.
                    if output.get("decisions") and not run.get("parent_id"):
                        original = case["result"]
                        trace = self.store.create_result(
                            case["capability_id"],
                            input_data=(
                                item["calls"][0]["payload"]
                                if run["mode"] == "activation"
                                else original["input"]
                            ),
                            environment=original.get("environment"),
                            group_id=case["group_id"],
                            prompt_snapshot=variant["snapshots"][case_ref["case_id"]],
                            task_ref="evaluation:" + run_id,
                            parent_case_id=case_ref["case_id"],
                        )
                        candidate_input = None
                        for stage in item["calls"]:
                            self.store.complete_result(trace["id"], stage=stage)
                            if stage["prompt_id"] == "ai-persona.conversation-candidate":
                                candidate_input = stage["payload"]
                        self.store.complete_result(
                            trace["id"],
                            decisions=output["decisions"],
                            expanded_context=original.get("expanded_context"),
                            candidate_input=candidate_input,
                            environment_changed=bool(original.get("environment_changed")),
                            state="completed",
                            generation=output.get("generation"),
                        )
                        item["result_id"] = trace["id"]
                except Exception as exc:
                    item["status"] = (
                        "not_run"
                        if run.get("workflow_version") == 2
                        and getattr(exc, "code", "") in {"budget_exhausted", "cancelled"}
                        else "failed"
                    )
                    item["error"] = {
                        "code": getattr(exc, "code", "evaluation_failed"),
                        "message": getattr(exc, "message", "回测未完成，请查看格式或业务约束。"),
                    }
                    if case:
                        item["score"] = score(case, {"decisions": []}, run["mode"])
                    else:
                        item["score"] = copy.deepcopy(run["planned_scores"][case_ref["case_id"]])
                item["duration_ms"] = round((time.monotonic() - started) * 1000)
                with self.lock:
                    if active["cancel"].is_set():
                        return
                    if run.get("workflow_version") != 2:
                        run["results"].append(item)
                    run["report"] = summarize(run["results"])
                    self.store.save_run(run)
                if run.get("workflow_version") == 2 and item.get("error", {}).get("code") in {
                    "budget_exhausted",
                    "cancelled",
                }:
                    self._finish_pending(run, item["error"]["code"])
                    break

            run.update(
                status="succeeded"
                if all(v["status"] == "succeeded" for v in run["results"])
                else "completed_with_errors",
                finished_at=now(),
            )
            self.store.save_run(run)
        except Exception as exc:
            # A failed/oversized write must not erase the last durable partial report.
            saved = self.store.document("runs", run_id)
            self._finish_pending(saved, getattr(exc, "code", "interrupted"))
            saved.update(
                status="failed",
                finished_at=now(),
                error={
                    "code": getattr(exc, "code", "evaluation_failed"),
                    "message": getattr(exc, "message", "检查未完成，已保留之前保存的结果。"),
                },
            )
            self.store.save_run(saved)
        finally:
            with self.lock:
                self.active.pop(run_id, None)

    def cancel(self, run_id):
        with self.lock:
            run = self.store.document("runs", run_id)
            if run["status"] in {"queued", "running"}:
                active = self.active.get(run_id)
                if active:
                    active["cancel"].set()
                    if active["call_id"]:
                        try:
                            self.model.cancel(active["call_id"])
                        except Exception:
                            pass
                self._finish_pending(run, "cancelled")
                run.update(status="cancelled", finished_at=now())
                self.store.save_run(run)
                if active and active.get("parent_id"):
                    for related_id, control in list(self.active.items()):
                        if related_id != run_id and control is active:
                            related = self.store.document("runs", related_id)
                            self._finish_pending(related, "cancelled")
                            related.update(status="cancelled", finished_at=now())
                            self.store.save_run(related)
            return run

    def cancel_case(self, case_id):
        for run_id in list(self.active):
            run = self.store.document("runs", run_id)
            if any(c["case_id"] == case_id for c in run["suite"]["cases"]):
                self.cancel(run_id)

    def review(self, run_id, raw):
        if (
            set(raw) - {"case_id", "variant", "judgment", "repeat_index"}
            or not {"case_id", "variant", "judgment"} <= set(raw)
            or raw["judgment"]
            not in {
                "correct",
                "incorrect",
                "undetermined",
            }
        ):
            raise EvaluationError("内容评价格式无效。")
        with self.lock:
            run = self.store.document("runs", run_id)
            if run["status"] in {"queued", "running"}:
                raise EvaluationError("请等待回测结束。", "busy", 409)
            if run.get("repeat_count", 1) > 1 and "repeat_index" not in raw:
                raise EvaluationError("请选择具体第几次运行的结果。")
            repeat_index = raw.get("repeat_index", 1)
            if type(repeat_index) is not int or not 1 <= repeat_index <= run.get("repeat_count", 1):
                raise EvaluationError("运行次数标识无效。")
            item = next(
                (
                    r
                    for r in run["results"]
                    if r.get("case_id") == raw["case_id"]
                    and r.get("variant") == raw["variant"]
                    and r.get("repeat_index", 1) == repeat_index
                ),
                None,
            )
            if (
                not item
                or item["status"] != "succeeded"
                or item.get("score", {}).get("content", {}).get("semantic_status") == "not_scored"
                or not item.get("score", {}).get("content", {}).get("reference_count")
            ):
                raise EvaluationError("本条没有可评价的审核标准答案。")
            item["score"]["content"]["semantic_status"] = raw["judgment"]
            self.store.save_run(run)
            return run

    def close(self):
        for key in list(self.active):
            self.cancel(key)
        self.pool.shutdown(wait=False, cancel_futures=True)
