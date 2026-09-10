"""Explicit local Studio feedback and benchmark management. No MCP write tools."""

from __future__ import annotations

import difflib
import json
import threading
import time

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..ai_web import check_request
from ..prompt_store import PromptStore
from ..store import PersonaStore
from ..trigger_plans import effective_config, publication_record
from .business import sync_review_gold
from .contracts import CAPABILITIES, EvaluationError, now
from .optimization import start_optimization
from .optimization_plan import optimization_preview, prepare_optimization
from .planning import prepare, public_preview, resolve_reasoning, resolve_selection
from .publication import promote, undo
from .replay import summarize
from .runner import EvaluationRunner
from .store import MAX_DOCUMENT_BYTES, EvaluationStore


class EvaluationAPI:
    def __init__(self, app, data_root, state_root):
        self.app = app
        self.store = EvaluationStore(data_root, state_root)
        self._runner = None
        self._runner_lock = threading.Lock()
        self.last_cleanup = 0
        for run in self.store.documents("runs"):
            if run["status"] in {"queued", "running"}:
                EvaluationRunner._finish_pending(run, "interrupted")
                self.store.save_run({**run, "status": "interrupted", "finished_at": now()})

    @property
    def runner(self):
        with self._runner_lock:
            if self._runner is None:
                self._runner = EvaluationRunner(self.store, self.app.state.ai_service.model)
            return self._runner

    def close(self):
        if self._runner:
            self._runner.close()

    def dispatch(self, method, path, raw, query):
        def sync_answers(case_id=None):
            try:
                sync_review_gold(self.store, case_id)
                return "synced"
            except Exception:
                return "failed"

        parts = [v for v in path.split("/") if v]
        if time.monotonic() - self.last_cleanup > 3600:
            self.store.cleanup()
            self.last_cleanup = time.monotonic()
        if method == "GET":
            if not parts or parts == ["capabilities"]:
                return {"protocol_version": 1, "capabilities": CAPABILITIES}
            if parts == ["models"]:
                return effective_config(self.app.state.ai_service.model.request("config"), PromptStore(self.store.state_root / "prompts").snapshot())
            if parts == ["selection"]:
                if query.get("mode") not in {m for c in CAPABILITIES for m in c["modes"]}:
                    raise EvaluationError("评测模式无效。")
                config = effective_config(self.app.state.ai_service.model.request("config"), PromptStore(self.store.state_root / "prompts").snapshot())
                selection, connection = resolve_selection(config, query["mode"], query)
                return {
                    "selection": selection,
                    "name": connection.get("name", connection["id"]),
                    "provider_id": connection["providerId"],
                    "reasoning": resolve_reasoning(config, query["mode"], query, selection, connection),
                }
            if parts == ["prompts"]:
                prompts = PromptStore(self.store.state_root / "prompts")
                ids = {key for c in CAPABILITIES for key in c["prompts"]}
                return {"items": [prompts.detail(key) for key in sorted(ids)]}
            if parts == ["results"]:
                return {
                    "items": self.store.results(
                        query.get("capability_id"),
                        query.get("task_ref"),
                        max(1, min(int(query.get("limit", 30)), 100)),
                        max(0, int(query.get("offset", 0))),
                    )
                }
            if len(parts) == 2 and parts[0] == "results":
                value = self.store.result(parts[1])
                return {**value, "display_input": self.store.input_text(value)}
            if parts == ["cases"]:
                state = sync_answers()
                return {
                    "items": self.store.cases(query.get("capability_id")),
                    "answer_sync_state": state,
                }
            if len(parts) == 2 and parts[0] == "cases":
                state = sync_answers(parts[1])
                value = self.store.case(parts[1])
                value["result"]["display_input"] = self.store.input_text(value["result"])
                return {**value, "answer_sync_state": state}
            if parts == ["references"]:
                values = []
                for case in self.store.cases(query.get("capability_id")):
                    if case["status"] != "active":
                        continue
                    value = self.store.case(case["case_id"])
                    for feedback in value["feedback"]["subjects"].values():
                        if (
                            feedback["active"]
                            and feedback["rating"] == "unsatisfied"
                            and feedback.get("reason")
                        ):
                            values.append(
                                {
                                    "case_id": value["case_id"],
                                    "subject": feedback["subject"],
                                    "reason": feedback["reason"],
                                    "input_text": self.store.input_text(value["result"]),
                                }
                            )
                return {"items": values}
            if parts in (["suites"], ["runs"]):
                return {"items": self.store.documents(parts[0])}
            if len(parts) == 2 and parts[0] in {"runs", "suites"}:
                value = self.store.document(parts[0], parts[1])
                if parts[0] == "runs":
                    if not value.get("imported"):
                        publication = publication_record(PromptStore(self.store.state_root / "prompts"), value["id"])
                        if publication:
                            value["publication"] = publication
                    value["report"] = summarize(value.get("results", []))
                    if len(value.get("variants", [])) == 2 and value.get("current_plan"):
                        key = value["current_plan"]["prompt_id"]
                        versions = [next(iter(v["snapshots"].values()), {}).get("versions", {}).get(key) for v in value["variants"]]
                        if all(versions):
                            value["prompt_changes"] = {field: "\n".join(difflib.unified_diff(versions[0]["templates"][field].splitlines(), versions[1]["templates"][field].splitlines(), fromfile="当前方案", tofile="候选方案", lineterm="")) for field in versions[0]["templates"]}
                    for item in value.get("results", []):
                        if item.get("reference"):
                            item["reference"]["display_input"] = self.store.input_text(
                                item["reference"]
                            )
                return value
        if method == "POST":
            if len(parts) == 3 and parts[0] == "results" and parts[2] == "feedback":
                value = self.store.feedback(parts[1], raw)
                state = sync_answers(value["case_id"])
                return {**self.store.case(value["case_id"]), "answer_sync_state": state}
            if len(parts) == 3 and parts[0] == "cases":
                key, action = parts[1:]
                if action == "reason":
                    if set(raw) != {"subject", "reason", "expected_feedback_revision"}:
                        raise EvaluationError("理由更新字段无效。")
                    return self.store.reason(
                        key, raw["subject"], raw["reason"], raw["expected_feedback_revision"]
                    )
                if action == "withdraw":
                    if set(raw) - {"subject", "expected_feedback_revision"}:
                        raise EvaluationError("撤回字段无效。")
                    if self._runner:
                        self._runner.cancel_case(key)
                    return self.store.withdraw(
                        key, raw.get("subject"), raw["expected_feedback_revision"]
                    )
                if action == "delete":
                    if raw != {"confirm": True}:
                        raise EvaluationError("请确认彻底删除此样例及其历史正文。")
                    if self._runner:
                        self._runner.cancel_case(key)
                    return self.store.delete(key)
            if parts == ["suites"]:
                return self.store.save_suite(raw["name"], raw["cases"])
            if parts == ["preview"]:
                return public_preview(prepare(self.store, self.app.state.ai_service.model, raw))
            if parts == ["runs"]:
                return self.runner.start(raw)
            if parts == ["optimizations", "preview"]:
                return optimization_preview(prepare_optimization(self.store, self.app.state.ai_service.model, raw))
            if parts == ["optimizations"]:
                return start_optimization(self.runner, raw)
            if len(parts) == 3 and parts[0] == "runs":
                if parts[2] == "cancel":
                    return self.runner.cancel(parts[1])
                if parts[2] == "review":
                    return self.runner.review(parts[1], raw)
                if parts[2] in {"promote", "apply", "rollback"}:
                    if raw != {"confirm": True}:
                        raise EvaluationError("请明确确认此操作。")
                    return undo(self.runner, parts[1]) if parts[2] == "rollback" else promote(self.runner, parts[1], apply=parts[2] == "apply")
            if parts == ["export"]:
                return self.store.export(raw.get("mode", "backup"), raw.get("case_ids"))
            if parts == ["import"]:
                return self.store.import_data(raw)
        raise EvaluationError("接口不存在。", "not_found", 404)


def mount_evaluation_routes(app, data_root, state_root, templates, common_context):
    manager = EvaluationAPI(app, data_root, state_root)
    app.state.evaluations = manager
    app.on_event("shutdown")(manager.close)

    @app.get("/evaluations")
    async def page(request: Request):
        check_request(request)
        context = common_context(request, PersonaStore(data_root).load(), section="evaluations")
        context["evaluation_embedded"] = request.query_params.get("embedded") == "1"
        return templates.TemplateResponse(request, "evaluations.html", context)

    @app.api_route("/api/evaluations/v1", methods=["GET", "POST"])
    @app.api_route("/api/evaluations/v1/{path:path}", methods=["GET", "POST"])
    async def endpoint(request: Request, path: str = ""):
        try:
            check_request(request)
            raw = {}
            if request.method == "POST":
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > (MAX_DOCUMENT_BYTES if path == "import" else 1_200_000):
                        raise EvaluationError("请求超过大小上限。", "too_large", 413)
                    chunks.append(chunk)
                raw = json.loads(b"".join(chunks))
                if not isinstance(raw, dict):
                    raise EvaluationError("请求必须是 JSON 对象。")
            result = await run_in_threadpool(
                manager.dispatch, request.method, path, raw, request.query_params
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            code = getattr(exc, "code", "invalid_request")
            return JSONResponse(
                {"code": code, "message": getattr(exc, "message", "请检查输入或刷新后重试。")},
                status_code=getattr(exc, "status", 403 if code == "forbidden" else 400),
                headers={"Cache-Control": "no-store"},
            )
