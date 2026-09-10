"""Read-only presentation of preferences and samples for one task context."""

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

from .models import Preference, PreferenceContext, PreferenceExample
from .preference_sources import folder_members, is_folder_source
from .store import PersonaStore


def preference_return_url(value: Any, fallback: str = "/preferences") -> str:
    """Only accept navigation back to the local preferences workspace."""
    candidate = str(value or "")
    if candidate == "/preferences":
        return fallback
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return fallback
    if parsed.scheme or parsed.netloc or parsed.path != "/preferences":
        return fallback
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def build_preference_workspace(
    store: PersonaStore,
    data_root: Path,
    params: Mapping[str, str],
    remembered: str,
    t: Callable[..., str],
) -> dict[str, Any]:
    all_contexts = sorted(
        store.of_type(PreferenceContext, active_only=False),
        key=lambda item: (item.name.casefold(), item.id),
    )
    by_id = {item.id: item for item in all_contexts}
    active_contexts = [item for item in all_contexts if item.status != "archived"]
    available = {item.id for item in active_contexts} | {"global", "all"}
    default = remembered if remembered in available else (
        active_contexts[0].id if active_contexts else "global"
    )
    selected = params.get("context") or default
    if selected not in by_id and selected not in {"global", "all"}:
        selected = default
    scene = by_id.get(selected)
    default_status = "archived" if scene and scene.status == "archived" else "active"
    status = params.get("status", default_status)
    if status not in {"active", "paused", "archived", "current"}:
        status = default_status
    query = params.get("q", "").strip()
    behavior = params.get("behavior", "")
    if behavior not in {"required", "preferred", "avoid"}:
        behavior = ""

    def url(context: str, *, filtered: bool = False, clear: bool = False) -> str:
        values = {"context": context}
        target_status = default_status if clear else status
        if target_status != "active":
            values["status"] = target_status
        if filtered and query:
            values["q"] = query
        if filtered and behavior:
            values["behavior"] = behavior
        return "/preferences?" + urlencode(values)

    current_url = url(selected, filtered=True)
    return_query = urlencode({"return_to": current_url})

    def status_matches(record: Any) -> bool:
        return record.status != "archived" if status == "current" else record.status == status

    items = []
    for loaded in store.loaded_of_type(Preference, active_only=False):
        record = loaded.record
        if not status_matches(record):
            continue
        if selected == "global" and record.scope != "global":
            continue
        if scene and record.scope != "global" and selected not in record.context_refs:
            continue
        if behavior and record.behavior != behavior:
            continue
        names = [by_id[item].name for item in record.context_refs if item in by_id]
        haystack = "\n".join([
            record.instruction, record.condition, record.rationale, loaded.body, *names,
        ]).casefold()
        if query and query.casefold() not in haystack:
            continue
        items.append({
            "preference": record, "loaded": loaded, "context_names": names,
            "edit_url": f"/preferences/items/{record.id}/edit?{return_query}",
        })
    order = {"required": 0, "preferred": 1, "avoid": 2}
    items.sort(key=lambda item: (
        item["preference"].status == "paused", order[item["preference"].behavior],
        item["preference"].instruction.casefold(), item["preference"].id,
    ))
    scoped = [item for item in items if item["preference"].scope == "contexts"]
    shared = [item for item in items if item["preference"].scope == "global"]
    groups = []
    if scoped:
        groups.append({"title": t("preferences.scene_preferences"), "shared": False,
                       "items": scoped, "show_title": bool(shared)})
    if shared:
        groups.append({"title": t("preferences.shared_preferences"), "shared": True,
                       "items": shared, "show_title": selected != "global"})

    examples = []
    if selected != "global":
        for loaded in store.loaded_of_type(PreferenceExample, active_only=False):
            example = loaded.record
            if not status_matches(example) or (scene and selected not in example.context_refs):
                continue
            source = store.sources[example.source_ref]
            info = next(item for item in source.files if item.path == source.canonical_file)
            path = data_root / "sources" / source.id / source.canonical_file
            is_folder = is_folder_source(source)
            if is_folder:
                path = data_root / "sources" / source.id / "files" / source.origin.identifier
            examples.append({
                "example": example, "source": source,
                "file_path": str(path.resolve()),
                "file_name": source.origin.identifier or source.canonical_file,
                "file_type": path.suffix.lstrip(".").upper()[:8] or "FILE",
                "is_image": info.media_type in {"image/png", "image/jpeg", "image/webp", "image/gif"},
                "is_folder": is_folder, "file_count": len(folder_members(source)) if is_folder else 1,
                "browse_url": f"/preferences/examples/{example.id}/files?{return_query}",
                "context_names": [by_id[item].name for item in example.context_refs if item in by_id],
                "edit_url": f"/preferences/examples/{example.id}/edit?{return_query}",
            })
        examples.sort(key=lambda item: (
            item["example"].status == "paused", item["example"].title.casefold(),
            item["example"].id,
        ))

    contexts = all_contexts if status == "archived" else list(active_contexts)
    if scene and scene not in contexts:
        contexts.append(scene)
    choices = [{"value": item.id, "name": item.name, "status": item.status,
                "url": url(item.id), "selected": selected == item.id} for item in contexts]
    choices.append({"value": "global", "name": t("preferences.global"), "status": "active",
                    "url": url("global"), "selected": selected == "global"})
    new_values = {"return_to": current_url}
    if scene and scene.status != "archived":
        new_values["context_id"] = scene.id
    return {
        "selected_context": selected, "selected_scene": scene,
        "scene_choices": choices, "current_view_url": current_url,
        "all_preferences_url": url("all"),
        "clear_filters_url": url(selected, clear=True),
        "workspace_title": scene.name if scene else t(
            "preferences.global" if selected == "global" else "preferences.all_preferences"
        ),
        "workspace_description": scene.description if scene else t(
            "preferences.global_description" if selected == "global"
            else "preferences.all_description"
        ),
        "rule_groups": groups, "rule_count": len(items), "sample_items": examples,
        "show_samples": selected != "global",
        "create_preference_url": "/preferences/new?" + urlencode(new_values),
        "create_example_url": "/preferences/examples/new?" + urlencode(new_values),
        "edit_context_url": (
            f"/preferences/contexts/{scene.id}/edit?{return_query}" if scene else ""
        ),
        "can_add": not scene or scene.status != "archived",
        "filters": {"q": query, "behavior": behavior, "status": status},
        "has_filters": bool(query or behavior or status != default_status),
    }
