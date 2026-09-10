"""Local-only Studio endpoints for model settings and review-gated AI drafts."""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .agent import AgentServiceError
from .ai_service import PersonaAIService
from .model_setup import ModelSetup
from .store import PersonaStore
from .web_access import SAFE_METHODS, StudioAccess


def check_request(request: Request) -> None:
    getattr(request.app.state, "studio_access", StudioAccess()).check(request)
    if request.method not in SAFE_METHODS and (
        request.headers.get("x-ai-persona") != "1"
        or not request.headers.get("content-type", "").startswith("application/json")
    ):
        raise AgentServiceError("forbidden", "请从 Studio 或受信任的本机客户端提交 JSON 请求。")


async def input_json(request: Request, max_bytes: int = 1_200_000) -> dict:
    check_request(request)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise AgentServiceError("invalid_request", "请求过大。")
        chunks.append(chunk)
    value = json.loads(b"".join(chunks))
    if not isinstance(value, dict):
        raise AgentServiceError("invalid_request", "请求必须是 JSON 对象。")
    return value


def failure(exc: Exception) -> JSONResponse:
    code = exc.code if isinstance(exc, AgentServiceError) else "invalid_request"
    message = (
        exc.message
        if isinstance(exc, AgentServiceError)
        else "请求未完成，请检查输入或刷新后重试。"
    )
    return JSONResponse(
        {"ok": False, "error": {"code": code, "message": message}},
        status_code=403 if code == "forbidden" else 400,
        headers={"Cache-Control": "no-store"},
    )


def mount_ai_routes(app, data_root: Path, state_root: Path, templates, common_context):
    app.state.ai_service = PersonaAIService(data_root, state_root)
    app.state.model_setup = ModelSetup()
    workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="persona-ai")
    active: dict[str, str] = {}
    app.state.ai_jobs = active
    active_lock = threading.Lock()

    def done(session_id, run_id):
        with active_lock:
            if active.get(session_id) == run_id:
                active.pop(session_id)

    @app.on_event("shutdown")
    def shutdown_ai():
        with active_lock:
            pending = list(active)
        for session_id in pending:
            try:
                value = app.state.ai_service.get_session(session_id)
                if value["status"] == "running":
                    app.state.ai_service.cancel(session_id, value["version"])
            except AgentServiceError:
                pass
        workers.shutdown(wait=False, cancel_futures=True)

    @app.get("/ai")
    async def assistant_page(request: Request):
        context = common_context(request, PersonaStore(data_root).load(), section="ai")
        context.update(
            record_id=request.query_params.get("record_id", ""),
            material_id=request.query_params.get("material_id", ""),
        )
        return templates.TemplateResponse(request, "ai_assistant.html", context)

    @app.get("/settings/models")
    async def models_page(request: Request):
        context = common_context(request, PersonaStore(data_root).load(), section="models")
        return templates.TemplateResponse(request, "model_settings.html", context)

    @app.api_route("/api/models/{route:path}", methods=["GET", "POST"])
    async def model_api(route: str, request: Request):
        try:
            check_request(request)
            if route in {"runtime", "runtime/install"}:
                # Installing programs is only available at a local Studio address,
                # even when a private reverse-proxy origin is configured.
                try:
                    StudioAccess().check(request)
                    can_install = True
                except AgentServiceError:
                    can_install = False
                if route == "runtime" and request.method == "GET":
                    result = await run_in_threadpool(app.state.model_setup.status)
                elif route == "runtime/install" and request.method == "POST":
                    StudioAccess().check(request)
                    if await input_json(request):
                        raise AgentServiceError("invalid_request", "安装不接受自定义参数。")
                    result = await run_in_threadpool(app.state.model_setup.install)
                else:
                    raise AgentServiceError("not_found", "接口不存在。")
                return JSONResponse({**result, "can_install": can_install}, headers={"Cache-Control": "no-store"})
            if request.method == "GET":
                if route != "config" and not (
                    route.startswith("auth/") and len(route.split("/")) == 2
                ):
                    raise AgentServiceError("not_found", "接口不存在。")
                payload = None
            else:
                if route not in {
                    "connections",
                    "remove",
                    "disconnect",
                    "routing",
                    "test",
                    "auth/start",
                    "auth/answer",
                    "auth/cancel",
                }:
                    raise AgentServiceError("not_found", "接口不存在。")
                payload = await input_json(request)
            def request_model():
                from .trigger_plans import clear_workspace_models, effective_config

                manager = getattr(app.state, "evaluations", None)
                changing = route in {"routing", "connections", "remove", "disconnect"}
                with manager.store.mutex if manager and changing else nullcontext():
                    if route == "routing" and any((payload or {}).get("overrideReasoning", {}).values()):
                        config = app.state.ai_service.model.request("config")
                        if config.get("capabilities", {}).get("persistentReasoning") != 1:
                            raise AgentServiceError("runtime_incompatible", "请重启更新后的模型服务，再保存包含思考强度的设置。")
                    if route == "test" and (payload or {}).get("reasoning") is not None:
                        config = app.state.ai_service.model.request("config")
                        if config.get("capabilities", {}).get("reasoningTests") != 1:
                            raise AgentServiceError("runtime_incompatible", "请重启更新后的模型服务，再测试所选思考强度。")
                    result = app.state.ai_service.model.request(route, payload)
                    if route == "routing" and request.method == "POST":
                        clear_workspace_models(app.state.ai_service.prompts)
                    if isinstance(result, dict) and "settings" in result:
                        result = effective_config(result, app.state.ai_service.prompts.snapshot())
                    return result

            result = await run_in_threadpool(request_model)
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/ai/activation")
    async def activation(request: Request):
        try:
            payload = await input_json(request)
            result = await run_in_threadpool(
                app.state.ai_service.resolve_persona_activation, **payload
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.api_route("/api/ai/sessions", methods=["GET", "POST"])
    async def sessions(request: Request):
        try:
            check_request(request)
            service = app.state.ai_service
            if request.method == "GET":
                result = {"sessions": service.repository.recent()}
            else:
                result = service.create_session(**await input_json(request))
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ai/options")
    async def maintenance_options(request: Request):
        try:
            check_request(request)
            store = PersonaStore(data_root).load()
            records = [{"id": r.record.id, "entity_type": r.record.entity_type,
                        "title": getattr(r.record, "title", None) or getattr(r.record, "name", None)
                                 or getattr(r.record, "instruction", r.record.id),
                        "status": r.record.status}
                       for r in store.records.values() if r.record.entity_type in
                       {"knowledge_node", "preference", "preference_context", "material", "course"}]
            return JSONResponse({"records": records}, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ai/sessions/{session_id}/basis/{basis_ref}")
    async def maintenance_basis(session_id: str, basis_ref: str, request: Request):
        try:
            check_request(request)
            value = app.state.ai_service.get_session(session_id)
            item = (value.get("checkpoint") or {}).get("ledger", {}).get("basis", {}).get(basis_ref)
            if not item:
                raise AgentServiceError("not_found", "依据不存在。")
            return JSONResponse(item, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ai/sessions/{session_id}/sources/{source_id}")
    async def maintenance_source(session_id: str, source_id: str, request: Request):
        try:
            check_request(request)
            value = app.state.ai_service.get_session(session_id)
            source = next((s for s in value.get("attachments", []) if s["id"] == source_id), None)
            if source is None:
                raise AgentServiceError("not_found", "资料不属于当前任务。")
            from .query_sources import SourceReader
            store = PersonaStore(data_root).load()
            reader = SourceReader(store, state_root, {source_id})
            manifest = reader.manifest(source_id)
            text = request.query_params.get("view") == "text"
            file = reader.by_path(source_id, source["file"] if text else manifest.canonical_file)
            if text and not file.media_type.startswith("text/"):
                raise AgentServiceError("source_text_required", "这份资料尚无可读取的文本。")
            return Response(
                reader.content(source_id, file),
                media_type="text/plain; charset=utf-8" if text else file.media_type,
                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
            )
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ai/sessions/{session_id}")
    async def session(session_id: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(app.state.ai_service.get_session, session_id),
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/ai/sessions/{session_id}/{action}")
    async def update_session(session_id: str, action: str, request: Request):
        try:
            payload = await input_json(request, 29 * 1024 * 1024 if action == "file" else 1_200_000)
            version = payload.get("version")
            if type(version) is not int:
                raise AgentServiceError("invalid_request", "缺少草稿版本。")
            service = app.state.ai_service
            if action in {"message", "resume"}:
                result = (
                    service.begin(session_id, payload["message"], version)
                    if action == "message"
                    else service.resume(session_id, version)
                )
                with active_lock:
                    active[session_id] = result["run_id"]
                future = workers.submit(service.generate, session_id, result["run_id"])
                future.add_done_callback(lambda _: done(session_id, result["run_id"]))
            elif action == "edit":
                result = await run_in_threadpool(service.edit, session_id, payload["draft"], version)
            elif action == "cancel":
                result = await run_in_threadpool(service.cancel, session_id, version)
            elif action == "submit":
                result = await run_in_threadpool(service.submit, session_id, version)
            elif action == "input":
                from .maintenance.service import update_input
                result = await run_in_threadpool(update_input, service, session_id, payload["input"], version)
            elif action == "attachment":
                from .maintenance.service import attach
                result = await run_in_threadpool(attach, service, session_id,
                                                 payload["text"], payload.get("title"), version)
            elif action == "arxiv":
                from .maintenance.imports import attach_arxiv
                result = await run_in_threadpool(
                    attach_arxiv, service, session_id, payload.get("url"), version,
                )
            elif action == "file":
                from .maintenance.imports import attach_file
                result = await run_in_threadpool(
                    attach_file, service, session_id, payload.get("filename"),
                    payload.get("content_base64"), version,
                )
            else:
                raise AgentServiceError("not_found", "操作不存在。")
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
