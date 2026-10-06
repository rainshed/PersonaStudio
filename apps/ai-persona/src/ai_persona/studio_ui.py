"""Interface appearance: Classic and Studio render the same pages, routes and scripts.

Only the shell and styles differ. The choice lives in cookies so every page (and
every local Studio port on the same host) follows it without touching Persona data.
"""
from collections import Counter

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

from .models import Idea, KnowledgeNode, Material, PreferenceContext, Relation
from .studio_links import record_link

UI_COOKIE = "persona_ui"
THEME_COOKIE = "persona_theme"
UI_MODES = ("classic", "studio")
THEMES = ("light", "dark", "system")
DEFAULT_UI = "classic"
DEFAULT_THEME = "light"
COOKIE_AGE = 365 * 24 * 60 * 60
SEARCH_LIMIT = 1200


def request_ui(request: Request) -> str:
    value = request.cookies.get(UI_COOKIE, DEFAULT_UI)
    return value if value in UI_MODES else DEFAULT_UI


def request_theme(request: Request) -> str:
    value = request.cookies.get(THEME_COOKIE, DEFAULT_THEME)
    return value if value in THEMES else DEFAULT_THEME


def safe_return_path(value: object) -> str:
    path = str(value or "/")
    return path if path.startswith("/") and not path.startswith("//") else "/"


def appearance_context(request: Request, store) -> dict:
    ui_mode = request_ui(request)
    context = {
        "ui_mode": ui_mode,
        "studio_ui": ui_mode == "studio",
        "ui_theme": request_theme(request),
        "embedded": request.query_params.get("embed") == "1",
    }
    if ui_mode == "studio":
        context["nav_counts"] = Counter(
            loaded.record.entity_type
            for loaded in store.records.values()
            if loaded.record.status == "active"
        )
    return context


def search_index(store) -> list[dict]:
    """Titles and links only; the palette never receives record bodies."""
    items = []
    for kind, model in (("knowledge", KnowledgeNode), ("material", Material),
                        ("context", PreferenceContext), ("idea", Idea)):
        for record in store.of_type(model, active_only=True):
            title = getattr(record, "title", None) or getattr(record, "name", record.id)
            aliases = list(getattr(record, "aliases", []) or [])
            url = f"/ideas/{record.id}" if kind == "idea" else record_link(record, store)
            items.append({"kind": kind, "title": title, "aliases": aliases, "url": url})
            if len(items) >= SEARCH_LIMIT:
                return items
    return items


def knowledge_details(store) -> dict:
    """Summaries and covering materials for the Studio graph card, keyed by knowledge id."""
    details = {
        node.id: {"summary": node.summary, "materials": []}
        for node in store.of_type(KnowledgeNode, active_only=True)
    }
    for relation in store.of_type(Relation, active_only=True):
        source = store.records.get(relation.source_id)
        if (relation.relation_type == "covers" and relation.target_id in details
                and source and isinstance(source.record, Material)
                and source.record.status == "active"):
            materials = details[relation.target_id]["materials"]
            if len(materials) < 5:
                materials.append({"title": source.record.title,
                                  "url": f"/materials/{source.record.id}"})
    return details


def mount_studio_ui_routes(app, data_root, templates, common_context, load_store):
    @app.post("/appearance")
    async def set_appearance(request: Request) -> RedirectResponse:
        form = await request.form()
        response = RedirectResponse(safe_return_path(form.get("return_to")), status_code=303)
        ui_mode = str(form.get("ui", ""))
        theme = str(form.get("theme", ""))
        if ui_mode in UI_MODES:
            response.set_cookie(UI_COOKIE, ui_mode, max_age=COOKIE_AGE, samesite="lax")
        if theme in THEMES:
            response.set_cookie(THEME_COOKIE, theme, max_age=COOKIE_AGE, samesite="lax")
        return response

    @app.get("/settings/appearance")
    async def appearance_settings(request: Request):
        context = common_context(request, load_store(), "appearance")
        return templates.TemplateResponse(request, "appearance.html", context)

    @app.get("/api/studio-ui/v1/index")
    async def palette_index(request: Request) -> JSONResponse:
        return JSONResponse(
            {"items": search_index(load_store())}, headers={"Cache-Control": "no-store"}
        )
