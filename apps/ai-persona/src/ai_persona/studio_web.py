"""Read-only Studio pages. Existing capability APIs remain the only write paths."""
import json
import os
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from .ai_web import check_request, failure
from .conversation_learning.service import ConversationLearningService
from .conversation_learning.worker import worker_status
from .inbox import InboxService
from .models import PreferenceContext
from .store import PersonaStore
from .web_access import LOCAL_HOSTS, origin_parts


def workbench_url():
    """The configured Workbench is an HTTP(S) origin, never a request parameter."""
    value = os.environ.get("AI_PERSONA_PROMPT_WORKBENCH_URL", "http://127.0.0.1:4318").rstrip("/")
    try:
        scheme, authority = origin_parts(value)
    except ValueError as exc:
        raise ValueError("AI_PERSONA_PROMPT_WORKBENCH_URL must be an HTTP(S) origin without a path, credentials or query") from exc
    return f"{scheme}://{authority}"


def workbench_available():
    endpoint = urlsplit(workbench_url())
    connection_type = HTTPSConnection if endpoint.scheme == "https" else HTTPConnection
    connection = connection_type(endpoint.hostname, endpoint.port, timeout=0.8)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        return response.status == 200 and json.loads(response.read(4096)).get("service") == "prompt-workbench"
    except (OSError, ValueError, HTTPException):
        return False
    finally:
        connection.close()


def mount_studio_routes(app, data_root, state_root, templates, common_context):
    def page(request, template, section):
        try:
            check_request(request)
            store = PersonaStore(data_root).load(verify_source_files=False)
            context = common_context(request, store, section=section)
            if section == "extensions":
                context["radar_install_command"] = (
                    "personastudio install paper-radar" if os.environ.get("AI_PERSONA_INSTALL_ROOT") else
                    "curl -fsSL https://github.com/rainshed/PersonaStudio/releases/latest/download/install.sh | sh -s -- --with-paper-radar"
                )
            if section == "settings":
                from .connection_setup import setup_instructions

                context["connection_setup"] = setup_instructions(
                    data_root, state_root, str(request.base_url)
                )
            context["trial_context"] = next((c for c in store.of_type(PreferenceContext) if c.id == request.query_params.get("context")), None)
            return templates.TemplateResponse(request, template, context)
        except Exception as exc:
            return failure(exc)

    @app.post("/studio/paper-radar")
    async def paper_radar(request: Request):
        try:
            check_request(request)
            if request.url.hostname not in LOCAL_HOSTS:
                return JSONResponse({"ok": False, "error": "Open Paper Radar from this computer."}, status_code=403)
            from .demo import is_demo_data
            from .studio_apps import open_paper_radar

            if is_demo_data(data_root):
                return JSONResponse({"ok": False, "error": "Open a personal workspace first."}, status_code=400)
            url = await run_in_threadpool(open_paper_radar, data_root.parent)
            return JSONResponse({"url": url})
        except Exception as exc:
            return failure(exc)

    @app.get("/settings/extensions")
    async def extensions(request: Request):
        return page(request, "extensions.html", "extensions")

    @app.get("/settings")
    async def settings(request: Request):
        try:
            check_request(request)
        except Exception as exc:
            return failure(exc)
        tab = request.query_params.get("tab")
        if tab is None:
            previous = request.cookies.get("persona-settings-tab")
            target = (
                f"/settings?tab={previous}"
                if previous in {"sources", "capabilities", "retention"}
                else "/settings/models"
            )
            return RedirectResponse(target, status_code=303)
        if tab not in {"sources", "capabilities", "retention"}:
            return RedirectResponse("/settings/models", status_code=303)
        return page(request, "settings.html", "settings")

    @app.get("/preferences/try")
    async def trial(request: Request):
        return page(request, "activation_trial.html", "preferences")

    @app.get("/api/studio/v1/workbench")
    async def workbench(request: Request):
        try:
            check_request(request)
            if request.url.hostname not in LOCAL_HOSTS:
                return JSONResponse(
                    {"available": False, "remote": True}, headers={"Cache-Control": "no-store"},
                )
            return JSONResponse({"available": await run_in_threadpool(workbench_available)}, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.get("/studio/workbench")
    async def open_workbench(request: Request):
        try:
            check_request(request)
            if request.url.hostname not in LOCAL_HOSTS:
                return JSONResponse({"available": False, "remote": True}, status_code=403)
            return RedirectResponse(workbench_url() + "/?project=ai-persona", status_code=303)
        except Exception as exc:
            return failure(exc)

    @app.get("/api/studio/v1/health")
    async def health(request: Request):
        try:
            check_request(request)
            if not hasattr(app.state, "learning_service"):
                app.state.learning_service = ConversationLearningService(data_root, state_root)
            learning = app.state.learning_service
            values = await run_in_threadpool(InboxService(data_root, state_root, learning).list, {"view": "all", "status": "failed", "limit": 3})
            with learning.repository.connect() as db:
                queued = db.execute("SELECT COUNT(*) FROM events WHERE status='queued'").fetchone()[0]
            settings = learning.repository.settings()
            worker = worker_status(learning.repository)
            return JSONResponse({
                "failures": values["items"], "failure_count": values["total"], "warnings": values["warnings"],
                "waiting_for_worker": queued if queued and settings.enabled and settings.allow_model_calls and not worker["running"] else 0,
                "learning": {
                    "enabled": settings.enabled, "allow_model_calls": settings.allow_model_calls,
                    "worker_running": worker["running"], "worker_stopping": worker.get("stopping", False),
                    "queued_count": queued,
                },
            }, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
