"""Human-readable fields offered when reviewing a proposed record."""

from __future__ import annotations

from typing import Any

from .i18n import Locale, label_map, translator
from .models import BaseRecord, ChangeProposal, PreferenceContext, ProposalPatch, Relation, Tag
from .proposals import CREATE_TYPES, record_content_hash, review_update_fields
from .store import PersonaStore

REVIEW_FIELDS: dict[str, tuple[str, ...]] = {
    "knowledge_node": (
        "title", "knowledge_level", "interest_level", "semantic_role", "aliases",
        "summary", "scope_note", "tags", "body",
    ),
    "course": (
        "title", "knowledge_level", "interest_level", "aliases", "description", "syllabus",
        "tags",
    ),
    "material": (
        "title", "knowledge_level", "preference_level", "aliases",
        "abstract", "summary", "scope_note", "tags", "body",
    ),
    "preference_context": ("name", "description", "body"),
    "preference": (
        "instruction", "behavior", "scope", "context_refs", "condition", "rationale",
        "status", "body",
    ),
    "preference_example": (
        "title", "example_type", "context_refs", "condition", "reasons", "status",
    ),
    "relation": ("knowledge_role", "salience", "statement"),
    "tag": ("slug", "label", "aliases"),
}

CHOICE_LABELS = {
    "relation_type": "relation",
    "knowledge_level": "level",
    "interest_level": "interest",
    "preference_level": "preference",
    "semantic_role": "role",
    "behavior": "behavior",
    "scope": "preference_scope",
    "status": "preference_status",
    "example_type": "example_type",
    "knowledge_role": "material_knowledge_role",
    "salience": "salience",
}

LINE_LIST_FIELDS = {"aliases", "reasons"}
REQUIRED_TEXT_FIELDS = {
    "title", "name", "instruction", "statement", "namespace", "slug", "label",
}


def record_field_labels(entity_type: str | None, locale: Locale) -> dict[str, str]:
    labels = label_map(locale, "field")
    t = translator(locale)
    if entity_type in {"knowledge_node", "course"}:
        labels["knowledge_level"] = t("review.knowledge_level")
    if entity_type == "knowledge_node":
        labels.update(summary=t("knowledge.description"), scope_note=t("detail.scope"),
                      body=t("knowledge.personal_notes"))
    elif entity_type == "course":
        labels.update(description=t("courses.description"), syllabus=t("courses.syllabus"))
    elif entity_type == "material":
        labels.update(abstract=t("material_detail.abstract"), summary=t("common.summary"),
                      knowledge_level=t("material_detail.understanding"),
                      scope_note=t("material_detail.reading_scope"),
                      body=t("material_form.personal_notes"))
    return labels


def effective_changes(proposal: ChangeProposal) -> list[ProposalPatch]:
    """Historical changes come from the proposal, never today's record values."""
    changes = {change.field: change for change in proposal.patch}
    for correction in proposal.review_patch:
        original = changes.get(correction.field)
        before = original.before if original else correction.before
        if proposal.operation in {"create", "relate"}:
            before = None
        changes[correction.field] = ProposalPatch(
            field=correction.field, before=before, after=correction.after
        )
    return [change for change in changes.values() if change.before != change.after]


def proposal_presentation(
    proposal: ChangeProposal, store: PersonaStore, locale: Locale, references=None
) -> dict[str, str]:
    t = translator(locale)
    loaded = store.records.get(proposal.target_id)
    entity_type = proposal.target_entity_type or (loaded.record.entity_type if loaded else None)
    values = review_values(proposal, store)
    values.update({change.field: change.after for change in proposal.review_patch})
    entity = label_map(locale, "entity").get(str(entity_type), t("common.record"))
    sentence_entity = entity.lower() if locale == "en" else entity
    action = t(f"review.actions.{proposal.operation}", entity=sentence_entity)
    subtype = (
        label_map(locale, "material_type").get(str(values.get("material_type")), "")
        if entity_type == "material" else ""
    )
    title = str(values.get("title") or values.get("name") or values.get("label")
                or values.get("instruction") or proposal.target_id)
    if entity_type == "relation":
        source = store.records.get(str(values.get("source_id", "")))
        target = store.records.get(str(values.get("target_id", "")))
        if (source or str(values.get("source_id")) in (references or {})) and (target or str(values.get("target_id")) in (references or {})):
            relation = label_map(locale, "relation").get(
                str(values.get("relation_type")), t("common.relationships")
            )
            source_name = source.record.title if source else references[str(values["source_id"])]
            target_name = target.record.title if target else references[str(values["target_id"])]
            title = f"{source_name} {relation} {target_name}"
    elif entity_type == "evidence":
        locator = values.get("locator")
        if isinstance(locator, dict) and locator.get("line_start") and locator.get("line_end"):
            title = t("review.source_evidence_lines", line_start=locator["line_start"],
                      line_end=locator["line_end"])

    summary = t("review.record_action", action=action, title=title)
    if proposal.operation == "update":
        labels = record_field_labels(entity_type, locale)
        descriptions = []
        for change in effective_changes(proposal):
            field = labels.get(change.field, change.field)
            if change.field in CHOICE_LABELS:
                choices = label_map(locale, CHOICE_LABELS[change.field])
                before = choices.get(str(change.before), t("common.unknown"))
                after = choices.get(str(change.after), t("common.unknown"))
                descriptions.append(f"{field}: {before} → {after}")
            else:
                descriptions.append(t("review.changed_field", field=field))
        summary = t("review.change_separator").join(descriptions[:3])
        if len(descriptions) > 3:
            summary += t("review.more_changes", count=len(descriptions) - 3)
        if not descriptions:
            summary = t("review.no_final_changes")

    effect = t(f"review.effects.{proposal.operation}", entity=sentence_entity)
    return {"entity_type": str(entity_type), "entity": entity, "action": action,
            "subtype": subtype, "title": title, "summary": summary, "effect": effect}


def review_values(proposal: ChangeProposal, store: PersonaStore) -> dict[str, Any]:
    loaded = store.records.get(proposal.target_id)
    model = Relation if proposal.target_entity_type == "relation" else CREATE_TYPES.get(str(proposal.target_entity_type))
    defaults = {
        name: field.get_default(call_default_factory=True)
        for name, field in model.model_fields.items()
        if name not in BaseRecord.model_fields and not field.is_required()
    } if model else {}
    values = (
        loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
        if loaded else {"status": "active", **defaults}
    )
    values["body"] = loaded.body if loaded else ""
    values.update({item.field: item.after for item in proposal.patch})
    return values


def editable_review_fields(proposal: ChangeProposal, store: PersonaStore) -> tuple[str, ...]:
    if proposal.operation not in {"create", "update", "relate"}:
        return ()
    loaded = store.records.get(proposal.target_id)
    entity_type = loaded.record.entity_type if loaded else proposal.target_entity_type
    if entity_type in {"knowledge_node", "preference", "relation", "preference_context"}:
        return tuple(f["name"] for f in review_field_schema(proposal, store) if not f["readonly"])
    return REVIEW_FIELDS.get(str(entity_type), ())


def review_field_schema(proposal: ChangeProposal, store: PersonaStore, locale: Locale = "zh-CN") -> list[dict]:
    """One projection of model fields for display, form controls and JSON validation.

    Model schemas supply types/defaults/enums; persistence supplies write permissions.
    Only presentation order/grouping lives here, not a separate field whitelist.
    """
    entity = str(proposal.target_entity_type or store.records[proposal.target_id].record.entity_type)
    model = Relation if entity == "relation" else CREATE_TYPES.get(entity)
    if not model:
        return []
    schema = model.model_json_schema()
    allowed = review_update_fields(entity, proposal.operation)
    values = review_values(proposal, store)
    labels = record_field_labels(entity, locale)
    labels.update(
        {"source_id": "Source", "target_id": "Target", "relation_type": "Relation type", "activation": "Activation", "key": "Context key", "evidence_refs": "Evidence references"}
        if locale == "en" else
        {"source_id": "起点", "target_id": "终点", "relation_type": "关系类型", "activation": "触发条件", "key": "场景标识", "evidence_refs": "来源引用"}
    )
    main = {"knowledge_node": ["title", "semantic_role", "summary"], "preference": ["instruction", "behavior", "scope", "context_refs", "condition"], "relation": ["source_id", "relation_type", "target_id"], "preference_context": ["name", "description", "activation"], "material": ["title", "material_type", "summary", "abstract"], "course": ["title", "description", "syllabus"], "preference_example": ["title", "example_type", "condition"], "tag": ["label", "namespace", "slug"], "evidence": ["source_id", "supports", "locator"]}.get(entity, [])
    names = list(dict.fromkeys([*main, *(n for n in model.model_fields if n not in BaseRecord.model_fields), *(n for n in ("status", "body") if n in allowed)]))
    result = []
    for name in names:
        spec = schema["properties"].get(name, {"type": "string", "default": ""})
        variants = spec.get("anyOf", [spec])
        nullable = any(v.get("type") == "null" for v in variants)
        typed = next((v for v in variants if v.get("type") != "null"), spec)
        typed = schema.get("$defs", {}).get(typed.get("$ref", "").removeprefix("#/$defs/"), typed)
        choices = {}
        kind = "text" if name in {"title", "name", "key", "source_id", "target_id"} else "textarea"
        if "enum" in typed:
            kind = "select"
            translated = label_map(locale, CHOICE_LABELS[name]) if name in CHOICE_LABELS else {}
            choices = {v: translated.get(v, v) for v in typed["enum"]}
            if nullable:
                choices = {"": "Not set" if locale == "en" else "未设置", **choices}
        elif typed.get("type") == "array":
            item_schema = typed.get("items", {})
            item_schema = schema.get("$defs", {}).get(item_schema.get("$ref", "").removeprefix("#/$defs/"), item_schema)
            kind = "lines" if item_schema.get("type") == "string" else "json"
            if name in {"tags", "context_refs"}:
                kind = "tags"
                if name == "tags":
                    choices = {t.id: t.label for t in store.of_type(Tag, active_only=True) if entity not in {"knowledge_node", "material"} or t.namespace == "domain"}
                else:
                    choices = {c.id: c.name for c in store.of_type(PreferenceContext, active_only=False) if c.status != "archived"}
                choices.update({v: v for v in values.get(name, []) if v not in choices})
        elif typed.get("type") == "object":
            kind = "json"
        user_only = name in {"knowledge_level", "interest_level", "preference_level"}
        result.append({"name": name, "label": labels.get(name, name), "kind": kind, "choices": choices,
                       "nullable": nullable, "required": name in schema.get("required", []) or bool(typed.get("minLength")),
                       "readonly": name not in allowed, "user_only": user_only,
                       "group": "personal" if user_only else "main" if name in main else "advanced",
                       "schema": spec})
    return result


def review_projection(proposal: ChangeProposal, store: PersonaStore, locale: Locale = "zh-CN", references=None) -> dict:
    values = review_values(proposal, store)
    values.update({p.field: p.after for p in proposal.review_patch})
    loaded = store.records.get(proposal.target_id)
    saved = None
    if loaded:
        saved = {**loaded.record.model_dump(mode="json", by_alias=True), "body": loaded.body}
    reviewed = proposal.status in {"accepted", "edited_and_accepted"}
    fields = review_field_schema(proposal, store, locale)
    current = saved if reviewed and saved else values
    return {"id": proposal.id, "revision": proposal.proposal_revision, "status": proposal.status,
            "operation": proposal.operation, "entity_type": proposal.target_entity_type or (loaded.record.entity_type if loaded else None),
            "presentation": proposal_presentation(proposal, store, locale, references),
            "title": proposal_presentation(proposal, store, locale, references)["title"], "note": proposal.reason,
            "target_id": proposal.target_id, "stale": not reviewed and (
                bool(loaded) if proposal.operation in {"create", "relate"} else
                not loaded or loaded.record.revision != proposal.base_revision or record_content_hash(loaded) != proposal.base_hash),
            "fields": fields, "values": {f["name"]: current.get(f["name"]) for f in fields},
            "original_patch": {p.field: p.after for p in proposal.patch},
            "before_patch": {p.field: p.before for p in proposal.patch},
            "source_evidence": [e.model_dump(mode="json") for e in proposal.evidence_candidates],
            "source_context": proposal.proposal_context.model_dump(mode="json"),
            "review_patch": {p.field: p.after for p in proposal.review_patch}, "saved": saved}
