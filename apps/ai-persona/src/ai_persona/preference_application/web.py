"""Local Studio settings, application history and links to existing feedback."""

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..ai_web import check_request, failure, input_json
from ..studio_links import legacy_inbox
from .cli import hook_config
from .repository import ApplicationSettings
from .service import ApplicationService


def mount_application_routes(app, data_root, state_root, templates, common_context):
    def service():
        if not hasattr(app.state, "preference_application"):
            app.state.preference_application = ApplicationService(
                data_root, state_root, ai_service=app.state.ai_service
            )
        return app.state.preference_application

    @app.get("/preferences/applications")
    async def page(request: Request):
        check_request(request)
        if request.query_params.get("settings") == "1":
            from fastapi.responses import RedirectResponse
            return RedirectResponse("/settings?tab=capabilities", status_code=303)
        return legacy_inbox(request, kind="application", key=request.query_params.get("application"), defaults={"view": "all", "type": "activation"})

    @app.get("/api/preferences/application/config")
    async def config(request: Request):
        try:
            check_request(request)
            current = service()
            return JSONResponse({
                "settings": current.repository.settings().model_dump(),
                "connections": [{
                    "id": c.id, "name": c.name, "scope_mode": c.scope_mode,
                    "projects": list(c.adapter_config.get("project_scopes", {})),
                } for c in current.connections.connections() if c.adapter == "codex"],
            }, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/preferences/application/config")
    async def save_config(request: Request):
        try:
            settings = ApplicationSettings.model_validate(await input_json(request))
            current = service()
            for identifier in settings.connection_ids:
                if current.connections.connection(identifier).adapter != "codex":
                    raise ValueError("只支持 Codex 来源。")
            current.repository.save_settings(settings)
            return {"settings": settings.model_dump()}
        except Exception as exc:
            return failure(exc)

    @app.get("/api/preferences/application/hooks/{connection_id}")
    async def hook(connection_id: str, request: Request):
        try:
            check_request(request)
            return JSONResponse(hook_config(service(), connection_id), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/preferences/application/records")
    async def records(request: Request, offset: int = 0):
        try:
            check_request(request)
            current = service()
            rows, total = await run_in_threadpool(current.repository.recent, offset)
            rows = [current.recover(row) for row in rows]
            return JSONResponse({"items": [{
                "id": row["id"], "prompt": row["request"]["user_prompt"],
                "created_at": row["created_at"], "status": row["status"],
                "decision_state": row["decision_state"], "error_code": row.get("error_code"),
                "duration_ms": row["duration_ms"],
                "matched_contexts": (row.get("activation") or {}).get("matched_contexts", []),
            } for row in rows], "total": total}, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/api/preferences/application/records/{identifier}")
    async def detail(identifier: str, request: Request):
        try:
            check_request(request)
            current = service()
            row = current.recover(await run_in_threadpool(current.repository.get, identifier))
            return JSONResponse(row, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
