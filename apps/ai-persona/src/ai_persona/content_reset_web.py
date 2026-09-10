"""Explicit, preview-bound content reset actions in Studio."""

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .agent import AgentServiceError
from .ai_web import check_request, failure, input_json
from .change_sets import proposal_lock
from .content_reset import ContentReset
from .reset_storage import content_access


class ContentAccessMiddleware:
    def __init__(self, app, state_root):
        self.app, self.state_root = app, state_root

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"].startswith("/api/content-reset"):
            return await self.app(scope, receive, send)
        try:
            with content_access(self.state_root):
                await self.app(scope, receive, send)
        except AgentServiceError as exc:
            response = JSONResponse(
                {"ok": False, "error": {"code": exc.code, "message": exc.message}}, status_code=503
            )
            await response(scope, receive, send)


def mount_content_reset_routes(app, data_root, state_root):
    manager = ContentReset(data_root, state_root, app)
    app.state.content_reset = manager
    app.add_middleware(ContentAccessMiddleware, state_root=state_root)

    def preview(task_id):
        with proposal_lock(state_root):
            return manager.plan(task_id)

    @app.get("/api/content-reset/preview")
    async def get_preview(request: Request, task_id: str | None = None):
        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(preview, task_id), headers={"Cache-Control": "no-store"}
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/content-reset")
    async def clear(request: Request):
        try:
            value = await input_json(request, 10000)
            if (
                value.get("confirm") != "clear-content"
                or not isinstance(value.get("token"), str)
                or type(value.get("backup", False)) is not bool
                or (
                    "task_id" in value
                    and value["task_id"] is not None
                    and not isinstance(value["task_id"], str)
                )
            ):
                raise AgentServiceError("invalid_request", "请先预览清理范围，再确认清理。")
            result = await run_in_threadpool(
                manager.apply,
                token=value["token"],
                task_id=value.get("task_id"),
                backup=value.get("backup", False),
            )
            return JSONResponse(result, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
