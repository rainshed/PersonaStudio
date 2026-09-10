from __future__ import annotations

import base64
import html
from concurrent.futures import ThreadPoolExecutor

from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from ..agent import AgentServiceError
from ..ai_web import check_request, failure, input_json
from .backend import CodexBackend, LoginManager
from .service import ExtractionService
from .sources import TEXT_FILE


def mount_extraction_routes(app, data_root, state_root, templates, common_context):
    from ..demo import is_demo_data

    codex_home = state_root / "extraction" / "codex-demo" if is_demo_data(data_root) else None
    backend = CodexBackend(codex_home=codex_home)
    service = ExtractionService(data_root, state_root, backend)
    service.repository.recover()
    app.state.extraction_service = service
    login = LoginManager(codex_home=codex_home)
    workers = ThreadPoolExecutor(max_workers=1, thread_name_prefix="persona-extract")

    app.state.extraction_jobs = {}

    @app.on_event("shutdown")
    def stop():
        for task in service.repository.list():
            if task["status"] == "running":
                service.cancel(task["id"])
        login.close()
        workers.shutdown(wait=False, cancel_futures=True)

    @app.get("/extract")
    async def page(request: Request):
        check_request(request)
        return templates.TemplateResponse(
            request=request,
            name="extraction.html",
            context=common_context(request, service.store(), section="ai"),
        )

    @app.get("/api/extraction")
    async def tasks(request: Request):
        check_request(request)
        return {
            "policy": service.repository.policy().model_dump(),
            "tasks": [
                {
                    "id": t["id"],
                    "status": t["status"],
                    "title": t["policy"]["goal"],
                    "updated_at": t["updated_at"],
                }
                for t in service.repository.list()
            ],
        }

    @app.get("/api/extraction/runtime")
    async def runtime(request: Request):
        try:
            check_request(request)
            return await run_in_threadpool(backend.status)
        except Exception:
            return {
                "available": False,
                "authenticated": False,
                "message": "Codex 运行组件未能启动。请重新运行安装程序，或检查本机 Codex 配置。",
            }

    @app.post("/api/extraction/login")
    async def authenticate(request: Request):
        try:
            value = await input_json(request, 10000)
            return await run_in_threadpool(login.login, value.get("api_key"))
        except Exception:
            return failure(
                AgentServiceError("login_failed", "Codex 登录未完成，请检查网络或稍后重试。")
            )

    @app.post("/api/extraction/policy")
    async def save_policy(request: Request):
        try:
            return service.repository.save_policy(await input_json(request, 30000))
        except Exception as exc:
            return failure(exc)

    @app.post("/api/extraction")
    async def create(request: Request):
        try:
            value = await input_json(request, 30000)
            task = service.repository.create(value.get("policy"))
            return service.view(task["id"])
        except Exception as exc:
            return failure(exc)

    @app.get("/api/extraction/{task_id}")
    async def get_task(task_id: str, request: Request):
        try:
            check_request(request)
            return await run_in_threadpool(service.view, task_id)
        except Exception as exc:
            return failure(exc)

    @app.post("/api/extraction/{task_id}/{action}")
    async def change(task_id: str, action: str, request: Request):
        try:
            value = await input_json(request, 29_000_000 if action == "add" else 30000)
            if action == "add":
                source = (
                    {"arxiv": value["arxiv"]}
                    if value.get("arxiv")
                    else {
                        "filename": value.get("filename"),
                        "content": base64.b64decode(value.get("content", ""), validate=True),
                    }
                )
                return await run_in_threadpool(service.add, task_id, value["revision"], **source)
            if action == "modify":
                return await run_in_threadpool(
                    service.modify,
                    task_id,
                    value["revision"],
                    policy=value.get("policy"),
                    remove=value.get("remove"),
                    retry=value.get("retry"),
                    same_as=value.get("same_as"),
                )
            if action == "start":
                if any(t["status"] == "running" for t in service.repository.list()):
                    raise AgentServiceError(
                        "busy", "当前已有一个整理任务运行，请等待完成或停止后再继续。"
                    )
                run_id = service.start(
                    task_id,
                    value["revision"],
                    partial=value.get("partial", False),
                    expected_max_nodes=value.get("expected_max_nodes"),
                )
                future = workers.submit(service.run, task_id, run_id)
                app.state.extraction_jobs[run_id] = future
                future.add_done_callback(lambda _future: app.state.extraction_jobs.pop(run_id, None))
                return service.view(task_id)
            if action == "cancel":
                return await run_in_threadpool(service.cancel, task_id)
            raise AgentServiceError("not_found", "未知操作。")
        except Exception as exc:
            return failure(exc)

    @app.get("/extract/{task_id}/source/{source_id}")
    async def source(
        task_id: str, source_id: str, request: Request, original: bool = False, start: int = 1
    ):
        check_request(request)
        task = service.repository.get(task_id)
        if not any(m["source_id"] == source_id for m in task["members"]):
            return JSONResponse({"error": "not_found"}, status_code=404)
        store = service.store()
        if original:
            manifest = store.sources[source_id]
            return FileResponse(
                store.source_file_path(source_id, manifest.canonical_file),
                filename=manifest.canonical_file,
                media_type="application/octet-stream",
            )
        lines = (
            store.source_file_path(source_id, TEXT_FILE).read_text(encoding="utf-8").splitlines()
        )
        start = max(1, min(start, len(lines)))
        body = "\n".join(
            f'<span id="L{i}" class="{"selected" if i >= start else ""}">{i:5} {html.escape(line)}</span>'
            for i, line in enumerate(lines[max(0, start - 10) : start + 190], max(1, start - 9))
        )
        return HTMLResponse(
            '<meta charset="utf-8"><title>来源片段</title><style>body{max-width:1000px;margin:32px auto;padding:20px;font:15px/1.8 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}.selected{background:#fff7d6}a{margin-right:20px}</style><h1>来源片段</h1><a href="?original=true">下载原文件</a>'
            + f'<a href="?start={max(1, start - 180)}">上一段</a><a href="?start={start + 180}">下一段</a><p>来源：{html.escape(source_id)} · 第 {start} 行附近 · 共 {len(lines)} 行</p><pre>{body}</pre>',
            headers={
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                "Cache-Control": "no-store",
            },
        )
