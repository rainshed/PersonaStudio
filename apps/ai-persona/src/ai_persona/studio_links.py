"""Stable internal navigation; never construct a redirect from a supplied host."""
from urllib.parse import urlencode

from fastapi.responses import RedirectResponse


def legacy_inbox(request, *, kind=None, key=None, defaults=None):
    query = {k: v for k, v in request.query_params.items() if k in {"message", "kind", "embedded", "return_to"}}
    query.update(defaults or {})
    if kind and key:
        query.update(view="all", item=f"{kind}:{key}")
        if kind == "proposal":
            query["proposal"] = key
    return RedirectResponse("/inbox?" + urlencode(query), status_code=303)


def record_link(record, store):
    entity = record.entity_type
    if entity in {"knowledge_node", "course", "material"}:
        return f"/{dict(knowledge_node='knowledge', course='courses', material='materials')[entity]}/{record.id}"
    if entity == "preference_context":
        return "/preferences?" + urlencode({"context": record.id})
    if entity == "preference":
        return f"/preferences/items/{record.id}/edit"
    if entity == "preference_example":
        return f"/preferences/examples/{record.id}/edit"
    if entity in {"relation", "evidence"}:
        source = store.records.get(record.source_id if entity == "relation" else record.supports[0])
        if source and source.record.entity_type in {"knowledge_node", "course", "material"}:
            return record_link(source.record, store)
    return "/knowledge"
