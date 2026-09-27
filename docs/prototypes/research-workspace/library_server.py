"""Serve the research prototype with read-only access to one Persona library.

No workspace files are mounted or copied into the prototype. Run with the
AI Persona virtualenv; the existing private reverse proxy can keep its port.
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import uvicorn
from ai_persona.library_references import (
    detail_body,
    library_items,
    workspace_key,
)
from ai_persona.store import PersonaStore
from ai_persona.web_access import StudioAccess, StudioAccessMiddleware, origin_parts
from ai_persona.workspace import configured_workspace, resolve_workspace
from ai_persona.workspace_registry import display_name
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response

ASSETS = {
    "index.html", "styles.css", "references.css", "references.js",
    "demo-data.js", "app.js", "library-client.js",
    "integration.css",
}
LOG = logging.getLogger(__name__)



def create_app(data_root, *, public_origin="", studio_origin="", asset_root=None,
               api_base="/api/library", integrated=False):
    data_root = Path(data_root).resolve()
    if studio_origin:
        origin_parts(studio_origin)
    assets = Path(asset_root or __file__).resolve()
    if asset_root is None:
        assets = assets.parent
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(StudioAccessMiddleware, policy=StudioAccess(public_origin))

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    def load():
        try:
            # Read canonical records, skipping expensive attachment checksums.
            # This validates record contracts and never invokes write/rebuild APIs.
            return PersonaStore(data_root).load(verify_source_files=False)
        except (ValueError, OSError):
            LOG.exception("Could not read Persona library")
            raise HTTPException(503, "正式知识库暂时不可用，请稍后重试。") from None

    @app.get("/api/library")
    def catalog():
        store = load()
        items = library_items(store, studio_origin)
        return {
            "mode": "live", "workspace": {
                "key": workspace_key(store), "name": display_name(data_root),
            },
            "items": items,
            "counts": {
                "knowledge": sum(i["kind"] == "knowledge" and not i["archived"] for i in items),
                "material": sum(i["kind"] == "material" and not i["archived"] for i in items),
                "archived": sum(i["archived"] for i in items),
            },
        }

    @app.get("/api/library/items/{item_id}")
    def item_detail(item_id: str):
        store = load()
        item = next((i for i in library_items(store, studio_origin) if i["id"] == item_id), None)
        if item is None:
            raise HTTPException(404, "该条目已不在当前正式知识库中，已有引用仍会保留。")
        return {**item, "body": detail_body(store.records[item["record_id"]])}

    @app.get("/runtime-config.js")
    def runtime_config():
        config = {"mode": "live", "apiBase": api_base, "integrated": integrated}
        return Response(f"window.ResearchLibraryConfig = {json.dumps(config)};",
                        media_type="application/javascript")

    @app.get("/")
    def index():
        return FileResponse(assets / "index.html")

    @app.get("/{asset}")
    def asset(asset: str):
        if asset not in ASSETS:
            raise HTTPException(404)
        return FileResponse(assets / asset)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    return app


def create_integrated_app(data_root, state_root, *, public_origin=""):
    """Keep every native Studio route and add research under a separate prefix."""
    from ai_persona.web import create_app as create_studio

    studio = create_studio(
        data_root, state_root,
        access_policy=StudioAccess(public_origin),
    )
    research = create_app(
        data_root, public_origin=public_origin,
        studio_origin=public_origin,
        api_base="/research/api/library", integrated=True,
    )
    studio.mount("/research", research, name="research_workspace")
    return studio


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--port", type=int, default=4179)
    parser.add_argument("--public-origin", default="")
    parser.add_argument("--studio-origin", default="")
    parser.add_argument("--with-studio", action="store_true",
                        help="Keep the complete Studio at / and add research at /research/")
    args = parser.parse_args()
    selected = resolve_workspace(
        workspace=args.workspace or configured_workspace(), data_root=None, state_root=None,
        demo=False, require_data=True, require_state=args.with_studio, allow_demo=False,
    )
    # Refuse to replace a working preview with an unusable connection.
    PersonaStore(selected.data_root).load(verify_source_files=False)
    app = (
        create_integrated_app(selected.data_root, selected.state_root,
                              public_origin=args.public_origin)
        if args.with_studio else
        create_app(selected.data_root, public_origin=args.public_origin,
                   studio_origin=args.studio_origin)
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port, proxy_headers=False, access_log=False)


if __name__ == "__main__":
    main()
