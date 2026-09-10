"""Shared first-use status, workspace binding, and editor support."""

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .agent import AgentServiceError
from .ai_web import check_request, failure, input_json
from .demo import is_demo_data, workspace_identity
from .web_access import SAFE_METHODS, StudioAccess


class WorkspaceBinding:
    def __init__(self, app, state, identity):
        self.app, self.state, self.identity = app, state, identity

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        mutation = request.method not in SAFE_METHODS
        supplied = request.headers.get("x-persona-workspace") or request.query_params.get(
            "_workspace_id"
        )
        control = request.url.path.startswith("/api/studio/workspaces/")
        if mutation and (
            (supplied and supplied != self.identity) or (self.state.switching and not control)
        ):
            return await JSONResponse(
                {
                    "error": {
                        "code": "workspace_changed",
                        "message": "工作区已切换或正在切换，请重新打开正确的工作区。 / Workspace changed; reopen the correct workspace.",
                    }
                },
                status_code=409,
            )(scope, receive, send)
        if mutation and not control:
            self.state.active_writes += 1
        try:
            await self.app(scope, receive, send)
        finally:
            if mutation and not control:
                self.state.active_writes -= 1


def maintenance_status(app):
    runtime = app.state.model_setup.status()
    if runtime["status"] != "ready":
        return {"ready": False, "status": runtime["status"], "next": "/settings/models"}
    try:
        config = app.state.ai_service.model.request("config")
        settings = config["settings"]
        from .model_routing import model_task

        task = model_task(settings, "maintenance")
        connection_id = settings.get("overrides", {}).get(task) or settings.get(
            "defaultConnectionId"
        )
        model = settings.get("overrideModelIds", {}).get(task) or settings.get("defaultModelId")
        connection = next(
            (
                c
                for c in settings["connections"]
                if c["id"] == connection_id and c.get("enabled", True)
            ),
            None,
        )
        ready = bool(
            model
            and connection
            and (connection.get("hasCredential") or connection.get("authType") == "none")
        )
        return {
            "ready": ready,
            "status": "configured" if ready else "needs_account",
            "next": "/settings/models",
        }
    except Exception:
        return {"ready": False, "status": "unavailable", "next": "/settings/models"}


def mount_first_use(app, data_root, state_root, templates, common_context):
    from .editor_drafts import mount_draft_routes
    from .mcp_setup import mount_mcp_setup
    from .workspace_registry import display_name

    identity = workspace_identity(data_root, state_root)
    app.state.switching = False
    app.state.active_writes = 0
    app.add_middleware(WorkspaceBinding, state=app.state, identity=identity)
    mount_draft_routes(app, state_root)
    mount_mcp_setup(app, data_root, state_root)

    @app.get("/api/studio/readiness")
    async def readiness(request: Request):
        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(maintenance_status, app),
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.get("/api/studio/integrations")
    async def integrations(request: Request):
        def read():
            if is_demo_data(data_root):
                return {"demo": True, "connections": []}
            from .codex_setup import status
            from .conversation_learning.service import ConversationLearningService
            from .conversation_learning.worker import worker_status
            from .preference_application.service import ApplicationService

            service = ConversationLearningService(data_root, state_root)
            application = ApplicationService(data_root, state_root).repository.settings()
            learning = service.repository.settings()
            connections = []
            for c in service.repository.connections():
                if c.adapter != "codex":
                    continue
                s = status(service, c.id)
                p = s["probe"] or {}
                verified = (
                    p.get("status") == "received"
                    and p.get("scope_ok")
                    and p.get("context_status") in {"readable", "disabled"}
                    and c.enabled
                    and (s["environment"].get("remote") or s["installation"].get("installed"))
                    and not s["installation"].get("hooks_disabled")
                )
                connections.append(
                    {
                        "id": c.id,
                        "name": c.name,
                        "host": s["environment"].get("hostname", ""),
                        "scope": c.scope_mode,
                        "verified_at": p.get("received_at"),
                        "enabled": c.enabled,
                        "verified": bool(verified),
                        "preferences": bool(
                            c.enabled and application.enabled and c.id in application.connection_ids
                        ),
                        "learning": bool(
                            c.enabled and learning.enabled and learning.allow_model_calls
                        ),
                        "worker": worker_status(service.repository).get("running", False),
                    }
                )
            return {"demo": False, "connections": connections}

        try:
            check_request(request)
            return JSONResponse(
                await run_in_threadpool(read), headers={"Cache-Control": "no-store"}
            )
        except Exception as exc:
            return failure(exc)

    @app.get("/workspaces")
    async def workspace_page(request: Request):
        from .store import PersonaStore
        from .workspace_registry import recents

        check_request(request)
        context = common_context(request, PersonaStore(data_root).load(), "workspaces")
        context.update(
            workspace_path=str(data_root.parent if data_root.name == "persona-data" else data_root),
            workspace_state_path=str(state_root),
            workspace_label=display_name(data_root),
            recent_workspaces=recents(),
        )
        return templates.TemplateResponse(request=request, name="workspaces.html", context=context)

    @app.post("/api/studio/workspaces/forget")
    async def forget_workspace(request: Request):
        try:
            value = await input_json(request)
            StudioAccess().check(request)
            from .workspace_registry import forget

            if not isinstance(value.get("path"), str):
                raise AgentServiceError("invalid_request", "请选择一条最近工作区记录。")
            await run_in_threadpool(forget, value["path"])
            return {"ok": True}
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/workspaces/open-manager")
    async def open_manager(request: Request):
        try:
            await input_json(request)
            StudioAccess().check(request)
            from .workspace_switch import launch_manager

            url = await run_in_threadpool(launch_manager, data_root, state_root)
            return {"url": url}
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/workspaces/prepare-switch")
    async def prepare_switch(request: Request):
        try:
            value = await input_json(request)
            StudioAccess().check(request)
            if value.get("workspace_id") != identity:
                raise AgentServiceError("conflict", "工作区身份已经改变。")
            if value.get("release"):
                app.state.switching = False
                return {"ok": True}
            if app.state.active_writes or app.state.ai_jobs or app.state.extraction_jobs:
                raise AgentServiceError("busy", "仍有操作或 AI 任务运行，请完成后再切换。")
            from .conversation_learning.service import ConversationLearningService
            from .conversation_learning.worker import worker_status

            if not is_demo_data(data_root) and worker_status(
                ConversationLearningService(data_root, state_root).repository
            ).get("running"):
                raise AgentServiceError("busy", "请先在自动功能设置中停止后台学习，再切换工作区。")
            manager = getattr(app.state, "evaluations", None)
            if manager and any(
                r["status"] in {"queued", "running"} for r in manager.store.documents("runs")
            ):
                raise AgentServiceError("busy", "评测仍在运行，请完成后再切换。")
            app.state.switching = True
            return {"ok": True}
        except Exception as exc:
            return failure(exc)

    @app.get("/api/studio/source-capabilities")
    async def source_capabilities(request: Request):
        check_request(request)
        return {
            "formats": ["arxiv", "md", "markdown", "pdf", "txt", "text"],
            "file_accept": ".md,.markdown,.pdf,.txt",
            "assistant_file_accept": ".md,.markdown,.pdf,.txt,.png,.jpg,.jpeg,.webp",
            "max_bytes": 20 * 1024 * 1024,
            "max_pdf_pages": 500,
            "images": "assistant_only",
        }

    @app.post("/api/studio/materials/{draft_id}/use")
    async def use_material(draft_id: str, request: Request):
        def transfer(target):
            import sqlite3
            from contextlib import closing

            from .material_imports.service import MaterialImportService

            importer = MaterialImportService(data_root, state_root)
            importer.get(draft_id)
            with (
                closing(
                    sqlite3.connect(state_root / "material-handoffs.sqlite3", timeout=30)
                ) as db,
                db,
            ):
                db.execute(
                    "CREATE TABLE IF NOT EXISTS handoffs (draft TEXT, target TEXT, url TEXT, PRIMARY KEY(draft,target))"
                )
                db.execute("BEGIN IMMEDIATE")
                previous = db.execute(
                    "SELECT url FROM handoffs WHERE draft=? AND target=?", (draft_id, target)
                ).fetchone()
                if previous:
                    return {"url": previous[0]}
                if target == "extract":
                    service = app.state.extraction_service
                    task = service.repository.create()
                    service.add(task["id"], task["revision"], draft_id=draft_id)
                    url = "/extract?task=" + task["id"]
                elif target == "ai":
                    from .extraction.sources import TEXT_FILE, import_source

                    member = import_source(data_root, state_root, draft_id=draft_id)
                    service = app.state.ai_service
                    session = service.create_session(
                        maintenance={"target_types": ["knowledge_node", "material"]}
                    )
                    source = {
                        "id": member["source_id"],
                        "title": member["title"],
                        "kind": "attachment",
                        "source_hash": "sha256:" + member["hash"],
                        "file": TEXT_FILE,
                        "parse_status": "ready",
                        "material_metadata": member["metadata"],
                        "warnings": member["warnings"],
                    }
                    config = dict(session["maintenance"])
                    config["attachment_ids"] = [source["id"]]
                    service.repository.update(
                        session["id"],
                        {"attachments": [source], "maintenance": config},
                        session["version"],
                    )
                    url = "/ai?session=" + session["id"]
                else:
                    raise AgentServiceError("invalid_request", "请选择材料提取或 AI 维护。")
                db.execute("INSERT INTO handoffs VALUES (?,?,?)", (draft_id, target, url))
                return {"url": url}

        try:
            value = await input_json(request)
            return await run_in_threadpool(transfer, value.get("target"))
        except Exception as exc:
            return failure(exc)
