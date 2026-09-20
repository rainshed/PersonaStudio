"""Studio-only Ideas UI. No automatic model or network access."""
import re
import uuid

from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from .agent import AgentServiceError
from .ai_web import check_request, input_json
from .change_sets import proposal_lock
from .ideas import EN_LABELS, LABELS, IdeaService, payload
from .models import Idea


def failure(exc):
    if isinstance(exc, AgentServiceError):
        code, message = exc.code, exc.message
    else:
        code, message = "save_failed", "操作未完成，输入已保留，请检查后重试。"
    return JSONResponse({"error": {"code": code, "message": message}},
                        status_code={"conflict": 409, "not_found": 404, "missing_file": 404,
                                     "forbidden": 403, "save_failed": 500}.get(code, 400),
                        headers={"Cache-Control": "no-store"})


def mount_idea_routes(app, data_root, state_root, templates, common_context):
    service = IdeaService(data_root, state_root)
    app.state.ideas = service

    def context(request):
        store = service.store()
        value = common_context(request, store, section="ideas")
        value["excerpt"] = lambda text: re.sub(r"(?m)^\s*(?:#{1,6}|>|[-*+])\s+", "", text)[:180]
        value["labels"] = LABELS if value["locale"] == "zh-CN" else EN_LABELS
        return store, value

    @app.get("/ideas")
    def ideas_page(request: Request):
        check_request(request)
        store, ctx = context(request)
        query = request.query_params.get("q", "").strip().casefold()
        archive = request.query_params.get("archive", "active")
        filters = {key: request.query_params.getlist(key) for key in LABELS}
        records = []
        for loaded in store.loaded_of_type(Idea):
            r = loaded.record
            if archive != "all" and r.status != archive:
                continue
            values = {"execution_status": r.execution_status, "novelty": r.novelty,
                      "difficulty": r.difficulty, "outcome": r.closure.outcome if r.closure else ""}
            if any(selected and values[key] not in selected for key, selected in filters.items()):
                continue
            haystack = [r.title, loaded.body, r.novelty_reason, r.difficulty_reason,
                        r.closure.summary if r.closure else ""]
            haystack.extend(f"{x.title} {x.note} {x.url or ''} {x.file_path or ''}" for x in r.resources)
            haystack.extend(
                store.sources[x.source_ref].origin.identifier or ""
                for x in r.resources if x.kind == "file" and x.source_ref in store.sources
            )
            if query and query not in "\n".join(haystack).casefold():
                continue
            records.append(loaded)
        records.sort(key=lambda x: (x.record.updated_at, x.record.id), reverse=True)
        ctx.update(records=records, filters=filters, query=request.query_params.get("q", ""),
                   archive=archive)
        return templates.TemplateResponse(request, "ideas.html", ctx,
                                          headers={"Cache-Control": "no-store"})

    @app.get("/ideas/{identifier}")
    @app.get("/ideas/new")
    def idea_page(request: Request, identifier: str = ""):
        check_request(request)
        try:
            store, ctx = context(request)
            item = payload(service.get(identifier, store)) if identifier else {
                "id": "idea_" + uuid.uuid4().hex, "revision": 0, "title": "", "body": "",
                "status": "active", "novelty": "unknown", "novelty_reason": "",
                "difficulty": "unknown", "difficulty_reason": "",
                "execution_status": "not_started", "closure": None, "resources": [],
            }
            ctx.update(item=item, upload_mb=service.upload_limit() // 1024 // 1024)
            return templates.TemplateResponse(request, "idea.html", ctx,
                                              headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/ideas/upload")
    async def upload(request: Request):
        try:
            app.state.studio_access.check(request)
            if request.headers.get("x-ai-persona") != "1":
                raise AgentServiceError("forbidden", "请从 Studio 上传文件。")
            chunks, size, limit = [], 0, service.upload_limit()
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise AgentServiceError("input_limit", "文件超过上传大小限制。")
                chunks.append(chunk)
            item = await run_in_threadpool(service.upload,
                request.query_params.get("filename", "attachment"), b"".join(chunks),
                request.headers.get("content-type", "application/octet-stream"))
            return JSONResponse({"item": item}, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ideas/files")
    def files(request: Request):
        check_request(request)
        store = service.store()
        return JSONResponse({"items": [
            {"source_ref": s.id, "file_path": f.path,
             "title": (s.origin.identifier or s.canonical_file) +
                      (" · " + f.path if f.path != s.canonical_file else "")}
            for s in store.sources.values() for f in s.files
        ]}, headers={"Cache-Control": "no-store"})

    @app.get("/api/ideas/file")
    def download(request: Request, source_ref: str, file_path: str):
        try:
            check_request(request)
            path, name = service.file(source_ref, file_path)
            return FileResponse(path, media_type="application/octet-stream", filename=name,
                                headers={"X-Content-Type-Options": "nosniff",
                                         "Content-Security-Policy": "sandbox",
                                         "Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ideas/{identifier}/history")
    def history(request: Request, identifier: str):
        try:
            check_request(request)
            return JSONResponse({"items": service.history(identifier)},
                                headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/ideas/{identifier}/context")
    def ai_context(request: Request, identifier: str, resources: bool = False):
        try:
            check_request(request)
            with proposal_lock(state_root):
                value = service.context(identifier, resources)
            return JSONResponse({"text": value}, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/ideas/{identifier}")
    async def save(request: Request, identifier: str):
        try:
            value = await input_json(request)
            if set(value) != {"expected_revision", "values"}:
                raise AgentServiceError("invalid_request", "无效的保存请求。")
            result = await run_in_threadpool(service.save, identifier,
                                            value["expected_revision"], value["values"])
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
