"""Same-origin project UI and APIs in the selected Studio workspace."""
import json
from pathlib import Path

from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool

from .agent import AgentServiceError
from .ai_web import check_request, input_json
from .ideas_web import failure
from .library_references import detail_body, library_items, workspace_key
from .projects import ProjectService
from .store import PersonaStore
from .workspace_registry import display_name


def mount_project_routes(app, data_root, state_root, templates, common_context):
    service = ProjectService(data_root, state_root)
    app.state.projects = service
    assets = Path(__file__).parent / "static/projects"

    @app.get("/projects")
    @app.get("/research/")
    def project_redirect():
        return RedirectResponse("/projects/", status_code=307)

    @app.get("/projects/")
    def project_page(request: Request):
        check_request(request)
        store = PersonaStore(data_root).load(verify_source_files=False)
        return templates.TemplateResponse(
            request, "projects.html", common_context(request, store, "projects"),
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/projects/runtime-config.js")
    def project_config(request: Request):
        check_request(request)
        config = {"mode": "live", "integrated": True, "apiBase": "/api/projects/library"}
        return Response("window.ResearchLibraryConfig = " + json.dumps(config) + ";",
                        media_type="application/javascript", headers={"Cache-Control": "no-store"})

    @app.get("/projects/{asset}")
    def project_asset(request: Request, asset: str):
        check_request(request)
        if asset not in {"styles.css", "references.css", "references.js", "app.js", "library-client.js", "integration.css"}:
            return Response(status_code=404)
        return FileResponse(assets / asset, headers={"Cache-Control": "no-store"})

    @app.get("/api/projects/library")
    def library(request: Request):
        check_request(request)
        store = PersonaStore(data_root).load(verify_source_files=False)
        items = library_items(store, str(request.base_url).rstrip("/"))
        return JSONResponse({"mode": "live", "items": items,
                             "workspace": {"key": workspace_key(store), "name": display_name(data_root)},
                             "counts": {kind: sum(i["kind"] == kind and not i["archived"] for i in items)
                                        for kind in ("knowledge", "material")}}, headers={"Cache-Control": "no-store"})

    @app.get("/api/projects/library/items/{identifier}")
    def library_detail(request: Request, identifier: str):
        check_request(request)
        store = PersonaStore(data_root).load(verify_source_files=False)
        item = next((i for i in library_items(store, str(request.base_url).rstrip("/")) if i["id"] == identifier), None)
        if item is None:
            return JSONResponse({"error": "条目不可用"}, status_code=404)
        return JSONResponse({**item, "body": detail_body(store.records[item["record_id"]])},
                            headers={"Cache-Control": "no-store"})

    def workspace(data):
        if data.get("workspace_key") != service.catalog()["workspace_key"]:
            raise AgentServiceError("conflict", "当前 Persona 已切换，请重新打开页面后保存。输入已保留。")

    @app.get("/api/projects")
    def projects(request: Request):
        try:
            check_request(request)
            return JSONResponse(service.catalog(), headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/projects")
    async def save(request: Request):
        try:
            data = await input_json(request, max_bytes=8_000_000)
            workspace(data)
            value = await run_in_threadpool(service.save, data.get("expected_revision"), data.get("changes"))
            return JSONResponse(value, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)

    @app.post("/api/projects/import")
    async def import_browser(request: Request):
        try:
            data = await input_json(request, max_bytes=16_000_000)
            workspace(data)
            value = await run_in_threadpool(service.import_browser, data.get("expected_revision"),
                                           data.get("snapshot"), data.get("project_ids"), str(request.base_url).rstrip("/"))
            return JSONResponse(value, headers={"Cache-Control": "no-store"})
        except Exception as exc:
            return failure(exc)
