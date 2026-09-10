"""Local prompt management and isolated single-call experiments."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .prompt_store import PromptError, PromptStore, now


def validate_result(identifier, text, variables):
    from .ai_service import ActivationOutput, DraftOutput, parse_output
    from .conversation_learning.contracts import CandidateOutput, SignalOutput
    from .maintenance.contracts import ModelAction
    from .material_analysis import MaterialAnalysis, check_analysis

    models = {
        "activation": ActivationOutput,
        "maintenance": DraftOutput,
        "maintenance-agent": ModelAction,
        "material-analysis": MaterialAnalysis,
        "material-candidate": DraftOutput,
        "conversation-signal": SignalOutput,
        "conversation-candidate": CandidateOutput,
    }
    value = parse_output({"text": text}, models[identifier.split(".")[-1]])
    payload = variables.get("payload", {})
    issues, coverage = [], ["输出结构"]
    if identifier.endswith("activation"):
        expected = {v["key"] for v in payload.get("catalog", [])}
        actual = [v.key for v in value.contexts]
        if set(actual) != expected or len(actual) != len(set(actual)):
            issues.append("模型未完整判断所有场景，或返回未知/重复场景。")
        coverage.append("场景范围")
    if identifier.endswith("material-analysis") and payload.get("segment"):
        check_analysis(value, payload["segment"])
        coverage.append("原文行号与分段范围")
    return {
        "parsed": value.model_dump(mode="json"),
        "issues": issues,
        "coverage": coverage,
        "note": "候选发布、跨记录关系与领域事实仍需原业务流程或人工核对。",
    }


class PromptAPI:
    def __init__(self, store, model):
        self.store, self.model = store, model
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="prompt-experiment")
        self.lock = threading.RLock()
        self.active = {}
        for value in store.records("experiments", limit=-1):
            if value.get("status") in ("queued", "running"):
                store.put_record(
                    "experiments",
                    {**value, "status": "interrupted", "error": "服务已重新启动，请重新运行实验。"},
                )

    def close(self):
        for identifier in list(self.active):
            self.cancel(identifier)
        self.pool.shutdown(wait=False, cancel_futures=True)

    def detail(self, identifier):
        from .prompt_examples import with_example

        return with_example(self.store.detail(identifier))

    def start(self, raw):
        identifier = raw["prompt_id"]
        d = self.store.definition(identifier)
        if d["kind"] != "message":
            raise PromptError("请通过使用此规则的功能进行试跑。")
        capture = (
            self.store.record("captures", raw["capture_id"]) if raw.get("capture_id") else None
        )
        if capture and capture["prompt_id"] != identifier:
            raise PromptError("快照不属于当前提示词。")
        variables = raw.get(
            "variables",
            capture["variables"] if capture else self.detail(identifier).get("example", {}),
        )
        variants = raw.get("variants", [{"version": "active"}])
        if not isinstance(variants, list) or not 1 <= len(variants) <= 2:
            raise PromptError("一次实验支持一个或两个版本。")
        bundle = self.store.snapshot()
        previews = [
            self.store.preview(identifier, variables, snapshot=bundle, variant=v) for v in variants
        ]
        response = self.model.request("config")
        if response.get("capabilities", {}).get("promptExperiments") != 1:
            raise PromptError(
                "模型服务需更新并重启后才能固定实验模型。请在 AI Persona 执行 models-stop 后重试。",
                "incompatible",
                409,
            )
        config = response["settings"]
        from .model_routing import model_task

        task = model_task(config, d["task"])
        override = config["overrides"].get(task)
        connection_id = raw.get("connection_id") or override or config.get("defaultConnectionId")
        c = next((v for v in config["connections"] if v["id"] == connection_id), None)
        if not c:
            raise PromptError("请先在 AI Persona 模型设置中配置此任务的模型。", "not_configured")
        model_id = (
            raw.get("model_id")
            or (
                (
                    config.get("overrideModelIds", {}).get(task)
                    if override
                    else config.get("defaultModelId")
                )
                if not raw.get("connection_id")
                else None
            )
            or c["modelId"]
        )
        selection = {"connectionId": c["id"], "modelId": model_id, "revision": c.get("revision")}
        tokens = raw.get("max_tokens", 4096)
        if type(tokens) is not int or not 128 <= tokens <= 8192:
            raise PromptError("实验输出上限应为 128–8192。")
        with self.lock:
            if len(self.active) >= 2:
                raise PromptError("已有两个实验运行中，请等待或取消。", "busy", 409)
            value = self.store.put_record(
                "experiments",
                {
                    "prompt_id": identifier,
                    "name": d["name"],
                    "status": "queued",
                    "variables": variables,
                    "previews": previews,
                    "results": [],
                    "model": {"providerId": c["providerId"], **selection},
                    "max_tokens": tokens,
                    "feedback": None,
                    "capture_id": raw.get("capture_id"),
                },
            )
            self.active[value["id"]] = threading.Event()
            self.pool.submit(self.run, value, selection, d["task"])
        return value

    def run(self, value, selection, task):
        identifier = value["id"]
        cancel = self.active[identifier]
        try:
            with self.lock:
                if cancel.is_set():
                    return
                value["status"] = "running"
                self.store.put_record("experiments", value)
            for index, preview in enumerate(value["previews"]):
                if cancel.is_set():
                    return
                started = time.monotonic()
                result = {"label": "AB"[index], "status": "failed"}
                try:
                    raw = self.model.request(
                        "generate",
                        {
                            "task": task,
                            "systemPrompt": preview["rendered"]["system"],
                            "prompt": preview["rendered"]["user"],
                            "maxTokens": value["max_tokens"],
                            "runId": identifier,
                            "stage": "prompt-experiment",
                            "experimentSelection": selection,
                        },
                    )
                    result.update(
                        {
                            "status": "succeeded",
                            "output": raw["text"],
                            "model": {k: v for k, v in raw.items() if k != "text"},
                        }
                    )
                    try:
                        result["validation"] = validate_result(
                            value["prompt_id"], raw["text"], value["variables"]
                        )
                    except Exception as exc:
                        result["validation"] = {
                            "issues": [
                                getattr(exc, "message", "输出格式或证据范围不符合本阶段要求。")
                            ],
                            "coverage": ["输出结构"],
                        }
                except Exception as exc:
                    result["error"] = getattr(exc, "message", "模型调用失败，请检查项目模型连接。")
                result["duration_ms"] = round((time.monotonic() - started) * 1000)
                with self.lock:
                    if cancel.is_set():
                        return
                    value["results"].append(result)
                    self.store.put_record("experiments", value)
            with self.lock:
                if not cancel.is_set():
                    value.update(
                        status="succeeded"
                        if all(r["status"] == "succeeded" for r in value["results"])
                        else "failed",
                        finished_at=now(),
                    )
                    self.store.put_record("experiments", value)
        finally:
            with self.lock:
                self.active.pop(identifier, None)

    def cancel(self, identifier):
        with self.lock:
            value = self.store.record("experiments", identifier)
            if value["status"] in ("queued", "running"):
                if identifier in self.active:
                    self.active[identifier].set()
                value["status"] = "cancelled"
                self.store.put_record("experiments", value)
                try:
                    self.model.cancel(identifier)
                except Exception:
                    pass
            return value

    def dispatch(self, method, path, raw, query):
        parts = [v for v in path.split("/") if v]
        if not parts and method == "GET":
            return {
                "protocol_version": 1,
                "project_id": "ai-persona",
                "capabilities": {"experiments": True, "captures": True, "activation_batch": True},
                "prompts": self.store.catalog(),
            }
        if parts == ["models"] and method == "GET":
            return self.model.request("config")
        if parts and parts[0] == "prompts":
            if len(parts) == 2 and method == "GET":
                return self.detail(parts[1])
            if len(parts) == 3 and parts[2] == "versions" and method == "POST":
                return self.store.save_version(
                    parts[1], raw["templates"], raw.get("note", ""), raw.get("base_version")
                )
        if parts == ["activate"] and method == "POST":
            return self.store.activate(raw["changes"])
        if parts == ["preview"] and method == "POST":
            return self.store.preview(
                raw["prompt_id"], raw["variables"], variant=raw.get("variant")
            )
        if parts == ["delete"] and method == "POST":
            return self.store.delete(raw["kind"], raw["id"])
        if parts == ["export"] and method == "GET":
            # Full private content is exported only by an explicit download action.
            return {
                "protocol_version": 1,
                "project_id": "ai-persona",
                "prompts": [self.store.detail(k) for k in self.store.definitions],
                **{
                    k: self.store.records(k, limit=-1)
                    for k in ("samples", "captures", "experiments")
                },
            }
        if parts and parts[0] in ("samples", "captures", "experiments"):
            kind = parts[0]
            if method == "GET":
                if len(parts) == 2:
                    return self.store.record(kind, parts[1])
                if len(parts) == 1:
                    values = self.store.records(kind, query.get("prompt_id"))
                    return {
                        "items": [
                            {
                                k: v
                                for k, v in item.items()
                                if k
                                not in ("snapshot", "context", "variables", "previews", "results")
                            }
                            for item in values
                        ]
                    }
            if method == "POST":
                if kind == "samples" and len(parts) == 1:
                    self.store.preview(raw["prompt_id"], raw["variables"])
                    name = raw.get("name", "").strip()
                    if not name or len(name) > 200 or len(raw.get("expected", "")) > 3000:
                        raise PromptError(
                            "请填写不超过 200 字符的样例名称，预期说明不超过 3000 字符。"
                        )
                    return self.store.put_record(
                        kind,
                        {
                            "prompt_id": raw["prompt_id"],
                            "name": name,
                            "variables": raw["variables"],
                            "expected": raw.get("expected", ""),
                        },
                    )
                if kind == "experiments":
                    if len(parts) == 1:
                        return self.start(raw)
                    if len(parts) == 3 and parts[2] == "cancel":
                        return self.cancel(parts[1])
                    if len(parts) == 3 and parts[2] == "feedback":
                        if (
                            raw.get("choice") not in ("A", "B", "equal")
                            or len(raw.get("note", "")) > 2000
                        ):
                            raise PromptError("评价格式无效。")
                        with self.lock:
                            value = self.store.record(kind, parts[1])
                            if value["status"] in ("queued", "running"):
                                raise PromptError("请等待实验结束。")
                            value["feedback"] = {
                                "choice": raw["choice"],
                                "note": raw.get("note", ""),
                            }
                            return self.store.put_record(kind, value)
        raise PromptError("接口不存在。", "not_found", 404)


def mount_prompt_routes(app, state_root):
    from .ai_web import check_request, input_json

    manager = PromptAPI(PromptStore(state_root / "prompts"), app.state.ai_service.model)
    app.state.prompt_api = manager
    app.on_event("shutdown")(manager.close)

    @app.api_route("/api/prompts/v1", methods=["GET", "POST"])
    @app.api_route("/api/prompts/v1/{path:path}", methods=["GET", "POST"])
    async def prompt_api(request: Request, path: str = ""):
        try:
            check_request(request)
            raw = await input_json(request) if request.method == "POST" else {}
            result = await run_in_threadpool(
                manager.dispatch, request.method, path, raw, dict(request.query_params)
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            status = getattr(exc, "status", 403 if getattr(exc, "code", "") == "forbidden" else 400)
            return JSONResponse(
                {
                    "code": getattr(exc, "code", "invalid_request"),
                    "message": getattr(exc, "message", "请求未完成，请检查输入。"),
                },
                status_code=status,
                headers={"Cache-Control": "no-store"},
            )
