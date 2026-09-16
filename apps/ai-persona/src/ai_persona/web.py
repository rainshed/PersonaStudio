from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from .change_sets import ChangeSetError, ChangeSetManifest, ChangeSetRepository
from .human_edits import HumanEditService
from .i18n import (
    DEFAULT_LOCALE,
    LOCALE_COOKIE,
    SUPPORTED_LOCALES,
    label_map,
    localized_error,
    request_locale,
    translator,
)
from .knowledge_graph import knowledge_graph_data
from .material_imports import (
    ImportDraft,
    ImportDraftError,
    MaterialImportError,
    MaterialImportService,
)
from .materials import (
    MaterialSourceError,
    discard_staged_source,
    stage_pasted_source,
    stage_source,
    stage_url_source,
    validate_staged_source,
)
from .models import (
    BaseRecord,
    Bibliography,
    ChangeProposal,
    Course,
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Relation,
    Tag,
)
from .overview import pending_breakdown, recent_changes
from .preference_sources import (
    folder_members,
    folder_tree,
    is_folder_source,
    stage_preference_upload,
)
from .preference_views import build_preference_workspace, preference_return_url
from .proposals import (
    AppliedProposal,
    ProposalError,
    ProposalRepository,
    ProposalService,
    StaleProposalError,
    record_content_hash,
)
from .review import (
    CHOICE_LABELS,
    LINE_LIST_FIELDS,
    REQUIRED_TEXT_FIELDS,
    editable_review_fields,
    proposal_presentation,
    record_field_labels,
    review_field_schema,
    review_values,
)
from .store import LoadedRecord, PersonaStore, StoreValidationError
from .studio_apps import radar_launcher
from .studio_locale import STUDIO_EN, studio_text
from .web_access import StudioAccess, StudioAccessMiddleware

LEVEL_LABELS = {
    "proficient": "精通", "familiar": "熟悉", "aware": "了解", "unspecified": "未设置"
}
INTEREST_LABELS = {
    "high": "高兴趣",
    "medium": "中等兴趣",
    "low": "低兴趣",
    "unspecified": "未设置",
}
PREFERENCE_LABELS = {
    "favorite": "非常喜欢",
    "liked": "喜欢",
    "neutral": "一般",
    "disliked": "不喜欢",
    "unspecified": "未标注",
}
MATERIAL_RELATIONSHIP_LABELS = {
    "authored": "我参与撰写",
    "studied": "研究过",
    "read": "读过",
    "skimmed": "浏览过",
}
MATERIAL_TYPE_LABELS = {
    "paper": "论文",
    "article": "文章",
    "note": "Note",
    "book": "书籍",
    "course_material": "课程材料",
    "conversation": "对话",
    "resume": "简历",
    "other": "其他",
}
MATERIAL_KNOWLEDGE_ROLE_LABELS = {
    "topic": "研究主题",
    "problem": "研究问题",
    "method": "使用方法",
    "theory": "理论基础",
    "model": "模型或系统",
    "application": "应用方向",
    "result": "主要结果",
    "background": "背景知识",
    "mentioned": "一般提及",
}
SALIENCE_LABELS = {
    "primary": "核心",
    "secondary": "次要",
    "mentioned": "仅提及",
}
PREFERENCE_ASPECT_LABELS = {
    "topic": "主题",
    "method": "方法",
    "result": "结果",
    "research-direction": "研究方向",
    "writing-style": "写作方式",
    "visualization": "图示",
    "practicality": "实用性",
    "other": "其他",
}
ENTITY_LABELS = {
    "knowledge_node": "知识概念",
    "course": "课程",
    "material": "材料",
    "relation": "关系",
    "tag": "标签",
    "evidence": "证据",
    "preference_context": "偏好场景",
    "preference": "偏好",
    "preference_example": "偏好样本",
}
ROLE_LABELS = {
    "domain": "领域",
    "area": "方向",
    "topic": "主题",
    "concept": "概念",
    "theory": "理论",
    "model": "模型",
    "method": "方法",
    "technique": "技术",
    "tool": "工具",
}
RELATION_LABELS = {
    "broader_than": "包含",
    "part_of": "属于",
    "applied_in": "应用于",
    "requires": "依赖",
    "related_to": "相关",
    "covers": "涵盖",
}
PROPOSAL_STATUS_LABELS = {
    "draft": "草稿",
    "pending_review": "待审核",
    "accepted": "已接受",
    "edited_and_accepted": "编辑后接受",
    "rejected": "已拒绝",
    "deferred": "已暂缓",
    "stale": "已过期",
}
OPERATION_LABELS = {
    "create": "新建",
    "update": "修改",
    "archive": "归档",
    "restore": "恢复",
    "relate": "添加关系",
    "unrelate": "移除关系",
}
FIELD_LABELS = {
    "activation": "激活条件",
    "abstract": "原文摘要",
    "aliases": "别名",
    "behavior": "行为类型",
    "body": "正文",
    "content_hash": "内容指纹",
    "condition": "使用条件",
    "context_refs": "适用场景",
    "description": "描述",
    "bibliography": "书目信息",
    "evidence_refs": "证据",
    "evidence_kind": "证据类型",
    "example_type": "样本类型",
    "instruction": "具体要求",
    "interest_level": "兴趣程度",
    "knowledge_level": "知识水平",
    "knowledge_role": "知识角色",
    "label": "显示名称",
    "locator": "原文位置",
    "material_type": "材料类型",
    "name": "名称",
    "namespace": "命名空间",
    "key": "场景键",
    "preference_level": "喜欢程度",
    "preference_reasons": "偏好原因",
    "rationale": "原因",
    "reasons": "参考原因",
    "relation_type": "关系类型",
    "salience": "重要程度",
    "semantic_role": "语义角色",
    "source_id": "起点知识",
    "source_hash": "Source 指纹",
    "source_ref": "来源",
    "status": "状态",
    "scope": "适用范围",
    "statement": "关系说明",
    "summary": "内容摘要",
    "syllabus": "课程大纲",
    "supports": "支持对象",
    "scope_note": "范围说明",
    "slug": "标识名",
    "tags": "标签",
    "target_id": "目标知识",
    "extraction_method": "提取方式",
    "confidence": "置信度",
    "title": "名称",
    "user_relationships": "与我的关系",
}


def _display_value(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, list):
        return "、".join(str(item) for item in value) if value else "—"
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    if value in LEVEL_LABELS:
        return LEVEL_LABELS[str(value)]
    if value in INTEREST_LABELS:
        return INTEREST_LABELS[str(value)]
    if value in PREFERENCE_LABELS:
        return PREFERENCE_LABELS[str(value)]
    if value in MATERIAL_RELATIONSHIP_LABELS:
        return MATERIAL_RELATIONSHIP_LABELS[str(value)]
    if value in MATERIAL_KNOWLEDGE_ROLE_LABELS:
        return MATERIAL_KNOWLEDGE_ROLE_LABELS[str(value)]
    if value in SALIENCE_LABELS:
        return SALIENCE_LABELS[str(value)]
    if value in RELATION_LABELS:
        return RELATION_LABELS[str(value)]
    return str(value)


def _localized_display_value(value: Any, labels: list[dict[str, str]], empty: str) -> str:
    if value is None or value == "":
        return empty
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) if value else empty
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
    for values in labels:
        if str(value) in values:
            return values[str(value)]
    return str(value)


def _record_title(record: BaseRecord) -> str:
    return str(
        getattr(
            record,
            "title",
            getattr(record, "name", getattr(record, "label", record.id)),
        )
    )


def _record_url(record: BaseRecord) -> str:
    if isinstance(record, Course):
        return f"/courses/{record.id}"
    if isinstance(record, Material):
        return f"/materials/{record.id}"
    if isinstance(record, KnowledgeNode):
        return f"/knowledge/{record.id}"
    if isinstance(record, Tag):
        return "/"
    if isinstance(record, (PreferenceContext, Preference, PreferenceExample)):
        return "/preferences"
    return "/preferences"


def _redirect(path: str, message: str, *, kind: str = "success") -> RedirectResponse:
    separator = "&" if "?" in path else "?"
    query = urlencode({"message": message, "kind": kind})
    return RedirectResponse(f"{path}{separator}{query}", status_code=303)


def _split_lines(value: Any) -> list[str]:
    return [line.strip() for line in str(value or "").splitlines() if line.strip()]


def _domain_tags(store: PersonaStore, *, active_only: bool = True) -> list[Tag]:
    return sorted(
        [
            tag
            for tag in store.of_type(Tag, active_only=active_only)
            if tag.namespace.strip().casefold() == "domain"
        ],
        key=lambda tag: (tag.label.casefold(), tag.id),
    )


def _preserved_tags(
    store: PersonaStore,
    record: BaseRecord,
    selectable_tags: list[Tag],
) -> list[Tag]:
    selectable_ids = {tag.id for tag in selectable_tags}
    return [
        store.records[tag_id].record
        for tag_id in getattr(record, "tags", [])
        if tag_id not in selectable_ids
        and tag_id in store.records
        and isinstance(store.records[tag_id].record, Tag)
    ]


def _normalize_tag_slug(value: Any, *, fallback: str) -> str:
    source = str(value or "").strip() or fallback
    ascii_source = (
        unicodedata.normalize("NFKD", source).encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_source.casefold()).strip("-")
    return slug or f"discipline-{uuid.uuid4().hex[:8]}"


def _domain_tag_ids_from_form(
    form: Any,
    store: PersonaStore,
    *,
    existing: BaseRecord | None = None,
) -> list[str]:
    selected = [str(value) for value in form.getlist("tags")]
    allowed = {tag.id for tag in _domain_tags(store)}
    if existing is not None:
        allowed.update(getattr(existing, "tags", []))
    unknown = set(selected) - allowed
    if unknown:
        raise ProposalError(f"未找到可用的学科标签: {sorted(unknown)}")
    return list(dict.fromkeys(selected))


def _parse_json_object(value: Any, *, field_name: str) -> dict[str, Any]:
    text = str(value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProposalError(f"{field_name}必须是有效的 JSON 对象：{exc.msg}") from exc
    if not isinstance(parsed, dict):
        raise ProposalError(f"{field_name}必须是 JSON 对象")
    return parsed


def _parse_preference_reasons(value: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    localized_aspects = {
        label.casefold(): aspect
        for locale in SUPPORTED_LOCALES
        for aspect, label in label_map(locale, "preference_aspect").items()
    }
    for line_number, line in enumerate(_split_lines(value), start=1):
        aspect, separator, note = line.partition("|")
        if not separator or not aspect.strip() or not note.strip():
            raise ProposalError(
                f"偏好原因第 {line_number} 行应使用‘方面 | 具体原因’格式"
            )
        normalized_aspect = localized_aspects.get(
            aspect.strip().casefold(), aspect.strip().casefold()
        )
        if normalized_aspect not in PREFERENCE_ASPECT_LABELS:
            choices = "、".join(PREFERENCE_ASPECT_LABELS.values())
            raise ProposalError(
                f"偏好原因第 {line_number} 行的方面无效，可选：{choices}"
            )
        result.append({"aspect": normalized_aspect, "note": note.strip()})
    return result


def _material_values(form: Any) -> dict[str, Any]:
    bibliography = {
        "authors": _split_lines(form.get("authors")),
        "published_at": str(form.get("published_at", "")).strip() or None,
        "venue": str(form.get("venue", "")).strip() or None,
        "language": str(form.get("language", "")).strip() or None,
        "identifiers": {
            "arxiv": str(form.get("arxiv", "")).strip() or None,
            "doi": str(form.get("doi", "")).strip() or None,
            "isbn": str(form.get("isbn", "")).strip() or None,
        },
        "canonical_url": str(form.get("canonical_url", "")).strip() or None,
    }
    try:
        bibliography = Bibliography.model_validate(bibliography).model_dump(mode="json")
    except ValidationError as exc:
        raise ProposalError(f"书目信息无效：{exc.errors()[0]['msg']}") from exc
    return {
        "material_type": str(form.get("material_type", "")),
        "title": str(form.get("title", "")).strip(),
        "aliases": _split_lines(form.get("aliases")),
        "abstract": str(form.get("abstract", "")).strip(),
        "bibliography": bibliography,
        "user_relationships": [str(value) for value in form.getlist("relationships") if value],
        "knowledge_level": str(form.get("knowledge_level", "")).strip() or "unspecified",
        "preference_level": str(form.get("preference_level", "")),
        "preference_reasons": _parse_preference_reasons(form.get("preference_reasons")),
        "summary": str(form.get("summary", "")).strip(),
        "scope_note": str(form.get("scope_note", "")).strip() or None,
        "tags": [str(value) for value in form.getlist("tags")],
    }


def _import_form_values(draft: ImportDraft, form: Any | None = None) -> dict[str, Any]:
    bibliography = draft.values.bibliography
    if form is None:
        return {
            "material_type": draft.values.material_type,
            "title": draft.values.title,
            "aliases": "\n".join(draft.values.aliases),
            "abstract": draft.values.abstract,
            "authors": "\n".join(bibliography.authors),
            "published_at": bibliography.published_at or "",
            "venue": bibliography.venue or "",
            "language": bibliography.language or "",
            "canonical_url": bibliography.canonical_url or "",
            "arxiv": bibliography.identifiers.arxiv or "",
            "doi": bibliography.identifiers.doi or "",
            "isbn": bibliography.identifiers.isbn or "",
            "relationships": [],
            "knowledge_level": "unspecified",
            "preference_level": "unspecified",
            "preference_reasons": "",
            "summary": "",
            "scope_note": "",
            "body": "",
            "tags": [],
            "new_tag": "",
            "reason": "",
            "duplicate_confirmed": False,
        }
    return {
        "material_type": str(form.get("material_type", "")),
        "title": str(form.get("title", "")),
        "aliases": str(form.get("aliases", "")),
        "abstract": str(form.get("abstract", "")),
        "authors": str(form.get("authors", "")),
        "published_at": str(form.get("published_at", "")),
        "venue": str(form.get("venue", "")),
        "language": str(form.get("language", "")),
        "canonical_url": str(form.get("canonical_url", "")),
        "arxiv": str(form.get("arxiv", "")),
        "doi": str(form.get("doi", "")),
        "isbn": str(form.get("isbn", "")),
        "relationships": [str(value) for value in form.getlist("relationships")],
        "knowledge_level": str(form.get("knowledge_level", "unspecified")),
        "preference_level": str(form.get("preference_level", "unspecified")),
        "preference_reasons": str(form.get("preference_reasons", "")),
        "summary": str(form.get("summary", "")),
        "scope_note": str(form.get("scope_note", "")),
        "body": str(form.get("body", "")),
        "tags": [str(value) for value in form.getlist("tags")],
        "new_tag": str(form.get("new_tag", "")),
        "reason": str(form.get("reason", "")),
        "duplicate_confirmed": bool(form.get("duplicate_confirmed")),
    }
def _repeated_form_rows(form: Any, *field_names: str) -> list[tuple[str, ...]]:
    columns = [
        [str(value).strip() for value in form.getlist(field_name)]
        for field_name in field_names
    ]
    if len({len(column) for column in columns}) > 1:
        raise ProposalError("relation rows are incomplete")
    return list(zip(*columns, strict=True))


def _read_revisions(data_root: Path, *, limit: int = 8) -> list[dict[str, Any]]:
    path = data_root / "revisions" / "changes.jsonl"
    if not path.is_file():
        return []
    revisions = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    return list(reversed(revisions[-limit:]))


def _record_revisions(
    data_root: Path, record_id: str, *, limit: int = 8
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for revision in _read_revisions(data_root, limit=10_000):
        change = next(
            (
                item
                for item in revision.get("changes", [])
                if item.get("object_id") == record_id
            ),
            None,
        )
        if change is not None:
            result.append({"revision": revision, "change": change})
        if len(result) >= limit:
            break
    return result


def _filter_records(
    store: PersonaStore,
    model: type[KnowledgeNode] | type[Course] | type[Material],
    *,
    query: str = "",
    knowledge_level: str = "",
    tag_id: str = "",
) -> list[LoadedRecord]:
    normalized_query = query.strip().casefold()
    result: list[LoadedRecord] = []
    for loaded in store.loaded_of_type(model, active_only=True):
        record = loaded.record
        if knowledge_level and record.knowledge_level != knowledge_level:
            continue
        if tag_id and tag_id not in record.tags:
            continue
        haystack = "\n".join(
            [
                record.title,
                *record.aliases,
                getattr(record, "summary", ""),
                getattr(record, "description", ""),
                getattr(record, "syllabus", ""),
                loaded.body,
            ]
        ).casefold()
        if normalized_query and normalized_query not in haystack:
            continue
        result.append(loaded)
    return sorted(result, key=lambda item: (item.record.title.casefold(), item.record.id))


def _material_relations(
    store: PersonaStore,
) -> dict[str, dict[str, list[tuple[Relation, KnowledgeNode]]]]:
    grouped: dict[str, dict[str, list[tuple[Relation, KnowledgeNode]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for relation in store.of_type(Relation, active_only=True):
        if relation.relation_type != "covers" or not relation.knowledge_role:
            continue
        source = store.records.get(relation.source_id)
        target = store.records.get(relation.target_id)
        if (
            source is None
            or not isinstance(source.record, Material)
            or target is None
            or not isinstance(target.record, KnowledgeNode)
        ):
            continue
        grouped[source.record.id][relation.knowledge_role].append(
            (relation, target.record)
        )
    salience_order = {"primary": 0, "secondary": 1, "mentioned": 2}
    for by_role in grouped.values():
        for items in by_role.values():
            items.sort(
                key=lambda item: (
                    salience_order.get(item[0].salience or "mentioned", 9),
                    item[1].title.casefold(),
                )
            )
    return grouped


def _knowledge_path(store: PersonaStore, knowledge_id: str) -> list[KnowledgeNode]:
    """Return one deterministic, deepest root-to-node path for compact UI display."""
    parents: dict[str, list[str]] = defaultdict(list)
    for relation in store.of_type(Relation, active_only=True):
        if relation.relation_type == "broader_than":
            parents[relation.target_id].append(relation.source_id)
    for values in parents.values():
        values.sort()

    def paths_to(node_id: str) -> list[list[str]]:
        if not parents.get(node_id):
            return [[node_id]]
        return [
            [*path, node_id]
            for parent_id in parents[node_id]
            for path in paths_to(parent_id)
        ]

    paths = paths_to(knowledge_id)
    selected = sorted(paths, key=lambda item: (-len(item), item))[0]
    return [
        store.records[item].record
        for item in selected
        if item in store.records
        and isinstance(store.records[item].record, KnowledgeNode)
    ]


def _filter_materials(
    store: PersonaStore,
    *,
    query: str = "",
    knowledge_level: str = "",
    preference_level: str = "",
    material_type: str = "",
    relationship: str = "",
    tag_id: str = "",
    knowledge_id: str = "",
    knowledge_role: str = "",
    salience: str = "",
    status: str = "active",
) -> list[LoadedRecord]:
    normalized_query = query.strip().casefold()
    relation_map = _material_relations(store)
    descendants = {
        descendant
        for ancestor, descendant, _ in store.relation_closure()
        if ancestor == knowledge_id
    }
    if knowledge_id:
        descendants.add(knowledge_id)
    result: list[LoadedRecord] = []
    for loaded in store.loaded_of_type(Material):
        material = loaded.record
        assert isinstance(material, Material)
        if material.status != status:
            continue
        if knowledge_level and material.knowledge_level != knowledge_level:
            continue
        if preference_level and material.preference_level != preference_level:
            continue
        if material_type and material.material_type != material_type:
            continue
        if relationship and relationship not in material.user_relationships:
            continue
        if tag_id and tag_id not in material.tags:
            continue
        related_ids = {
            node.id for items in relation_map.get(material.id, {}).values() for _, node in items
        }
        if knowledge_id and not (related_ids & descendants):
            continue
        material_relation_items = [
            relation
            for items in relation_map.get(material.id, {}).values()
            for relation, _ in items
        ]
        if knowledge_role and not any(
            relation.knowledge_role == knowledge_role
            for relation in material_relation_items
        ):
            continue
        if salience and not any(
            relation.salience == salience for relation in material_relation_items
        ):
            continue
        relation_text = [
            text
            for items in relation_map.get(material.id, {}).values()
            for relation, node in items
            for text in (node.title, relation.statement or "")
        ]
        haystack = "\n".join(
            [
                material.title,
                *material.aliases,
                material.abstract,
                *material.bibliography.authors,
                material.bibliography.venue or "",
                material.summary,
                loaded.body,
                *(item.note for item in material.preference_reasons),
                *relation_text,
            ]
        ).casefold()
        if normalized_query and normalized_query not in haystack:
            continue
        result.append(loaded)
    return sorted(result, key=lambda item: (item.record.title.casefold(), item.record.id))


def _graph_title_lines(title: str, *, width: int = 29) -> list[str]:
    # CJK characters take roughly twice the space of Latin characters in the card.
    def units(value: str) -> int:
        return sum(2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
                   for char in value if not unicodedata.combining(char))

    remaining = " ".join(title.split())
    lines: list[str] = []
    while remaining and len(lines) < 2:
        end = 0
        while end < len(remaining) and units(remaining[:end + 1]) <= width:
            end += 1
        if end < len(remaining):
            space = remaining.rfind(" ", 0, end + 1)
            if space > end // 2:
                end = space
        line, remaining = remaining[:end].rstrip(), remaining[end:].lstrip()
        if len(lines) == 1 and remaining:
            while units(line + "…") > width:
                line = line[:-1]
            line = line.rstrip() + "…"
        lines.append(line)
    return lines or [""]


def _graph_layout(store: PersonaStore) -> dict[str, Any]:
    nodes = {item.id: item for item in store.of_type(KnowledgeNode, active_only=True)}
    all_edges = [
        item
        for item in store.of_type(Relation, active_only=True)
        if item.relation_type in {"broader_than", "requires", "related_to", "applied_in"}
        and item.source_id in nodes
        and item.target_id in nodes
    ]
    hierarchy_edges = [item for item in all_edges if item.relation_type == "broader_than"]

    hierarchy_children: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for edge in hierarchy_edges:
        hierarchy_children[edge.source_id].append((edge.target_id, edge.id))

    def has_alternative_hierarchy_path(edge: Relation) -> bool:
        pending = [
            target_id
            for target_id, relation_id in hierarchy_children[edge.source_id]
            if relation_id != edge.id
        ]
        visited = {edge.source_id}
        while pending:
            node_id = pending.pop()
            if node_id == edge.target_id:
                return True
            if node_id in visited:
                continue
            visited.add(node_id)
            pending.extend(target_id for target_id, _ in hierarchy_children[node_id])
        return False

    reduced_hierarchy_edges = [
        edge for edge in hierarchy_edges if not has_alternative_hierarchy_path(edge)
    ]
    edges = [
        *reduced_hierarchy_edges,
        *(edge for edge in all_edges if edge.relation_type != "broader_than"),
    ]
    relation_counts = Counter(item.relation_type for item in edges)
    depth = {node_id: 0 for node_id in nodes}
    for _ in range(len(nodes)):
        changed = False
        for edge in hierarchy_edges:
            candidate = depth[edge.source_id] + 1
            if candidate > depth[edge.target_id]:
                depth[edge.target_id] = candidate
                changed = True
        if not changed:
            break
    # Hierarchy determines tree boundaries and descendant placement. Contextual
    # links attach supporting records below without merging or renaming trees.
    parents: dict[str, list[str]] = defaultdict(list)
    neighbours: dict[str, set[str]] = defaultdict(set)
    for edge in reduced_hierarchy_edges:
        parents[edge.target_id].append(edge.source_id)
        neighbours[edge.source_id].add(edge.target_id)
        neighbours[edge.target_id].add(edge.source_id)

    def node_key(node_id: str) -> tuple[str, str]:
        return nodes[node_id].title.casefold(), node_id

    components: list[set[str]] = []
    unseen = set(neighbours)
    while unseen:
        pending = [min(unseen, key=node_key)]
        component: set[str] = set()
        while pending:
            node_id = pending.pop()
            if node_id in component:
                continue
            component.add(node_id)
            pending.extend(neighbours[node_id] - component)
        unseen -= component
        components.append(component)
    components.sort(key=lambda values: min(node_key(item) for item in values if not parents[item]))
    hierarchy_ids = set(neighbours)
    groups: list[dict[str, Any]] = []
    memberships: dict[str, list[str]] = defaultdict(list)
    anchors: dict[str, list[str]] = defaultdict(list)
    for component in components:
        roots = sorted((item for item in component if not parents[item]), key=node_key)
        group_id = "tree:" + ":".join(sorted(roots))
        groups.append({"index": group_id, "core": component, "members": set(component),
                       "roots": roots, "kind": "hierarchy",
                       "title": " · ".join(nodes[item].title for item in roots)})
        for node_id in component:
            memberships[node_id] = [group_id]
    groups_by_id = {group["index"]: group for group in groups}

    # Follow contextual links between non-hierarchy records, stopping at tree
    # boundaries. A method can accompany several trees without joining them.
    context_neighbours: dict[str, set[str]] = defaultdict(set)
    boundary: dict[str, set[str]] = defaultdict(set)
    for edge in edges:
        if edge.relation_type == "broader_than":
            continue
        for source, target in [(edge.source_id, edge.target_id), (edge.target_id, edge.source_id)]:
            if source in hierarchy_ids:
                continue
            if target in hierarchy_ids:
                boundary[source].add(target)
            else:
                context_neighbours[source].add(target)
    unseen = set(nodes) - hierarchy_ids
    while unseen:
        pending = [min(unseen, key=node_key)]
        component = set()
        while pending:
            node_id = pending.pop()
            if node_id in component:
                continue
            component.add(node_id)
            pending.extend(context_neighbours[node_id] - component)
        unseen -= component
        targets = sorted({target for item in component for target in boundary[item]}, key=node_key)
        destinations = sorted({memberships[target][0] for target in targets})
        if not destinations:
            # An independent connected component keeps its own name, never a
            # catch-all category defined by missing hierarchy metadata.
            group_id = "related:" + min(component)
            groups.append({"index": group_id, "core": set(), "members": component,
                           "roots": [], "kind": "related",
                           "title": " · ".join(nodes[item].title for item in sorted(component, key=node_key))})
            destinations = [group_id]
        else:
            for destination in destinations:
                groups_by_id[destination]["members"].update(component)
        for node_id in component:
            memberships[node_id] = destinations
            anchors[node_id] = targets

    node_width, node_height, x_gap, y_gap = 236, 112, 48, 72
    positioned: dict[str, dict[str, Any]] = {}
    clusters: list[dict[str, Any]] = []
    cursor = 40
    for color_index, group in enumerate(groups):
        group_id, core, roots = group["index"], group["core"], group["roots"]
        # Overview renders each record once; focused views use every membership.
        context = sorted((item for item in group["members"] - core if memberships[item][0] == group_id), key=node_key)
        local: dict[str, tuple[float, float]] = {}
        context_box = None
        if core:
            owned: dict[str, list[str]] = defaultdict(list)
            for node_id in core:
                if parents[node_id]:
                    primary = min(parents[node_id], key=lambda item: (-depth[item], node_key(item)))
                    owned[primary].append(node_id)
            for children in owned.values():
                children.sort(key=node_key)
            widths: dict[str, float] = {}

            def measure(node_id: str) -> float:
                children = owned[node_id]
                widths[node_id] = max(node_width, sum(measure(child) for child in children)
                                      + max(0, len(children) - 1) * x_gap)
                return widths[node_id]

            component_width = sum(measure(root) for root in roots) + (len(roots) - 1) * x_gap

            def place(node_id: str, left: float) -> None:
                local[node_id] = (left + (widths[node_id] - node_width) / 2,
                                  68 + depth[node_id] * (node_height + y_gap))
                for child in owned[node_id]:
                    place(child, left)
                    left += widths[child] + x_gap

            left = 0.0
            for root in roots:
                place(root, left)
                left += widths[root] + x_gap
            if context:
                def anchor_row(node_id: str) -> int:
                    return min(depth[target] for target in anchors[node_id] if target in core)

                context.sort(key=lambda item: (anchor_row(item), node_key(item)))
                context_x = component_width + 96
                row = -1
                for node_id in context:
                    row = max(row + 1, anchor_row(node_id))
                    local[node_id] = (context_x, 68 + row * (node_height + y_gap))
                top = min(local[item][1] for item in context) - 36
                bottom = max(local[item][1] for item in context) + node_height + 16
                context_box = {"x": cursor + context_x - 16, "y": top,
                               "width": node_width + 32, "height": bottom - top}
                component_width = context_x + node_width
        else:
            columns = min(3, len(context))
            component_width = columns * node_width + (columns - 1) * x_gap
            for index, node_id in enumerate(context):
                local[node_id] = ((index % columns) * (node_width + x_gap),
                                  68 + (index // columns) * (node_height + y_gap))

        for node_id, (x, y) in local.items():
            node = nodes[node_id]
            positioned[node_id] = {
                "record": node, "x": cursor + x, "y": y,
                "width": node_width, "height": node_height,
                "title_lines": _graph_title_lines(node.title, width=27),
                "cluster": group_id, "groups": memberships[node_id], "depth": depth[node_id],
                "contextual": node_id not in hierarchy_ids, "anchors": anchors[node_id],
                "child_count": sum(edge.source_id == node_id for edge in reduced_hierarchy_edges),
                "is_root": node_id in roots,
            }
        bottom = max(y + node_height for _, y in local.values())
        clusters.append({
            "index": group_id, "color_index": color_index, "title": group["title"],
            "title_lines": _graph_title_lines(group["title"], width=36),
            "kind": group["kind"], "roots": roots, "context_box": context_box,
            "count": len(group["members"]), "x": cursor - 24, "y": 16,
            "width": component_width + 48, "height": bottom + 8,
        })
        cursor += component_width + 104
    width = max(360, cursor - 64)
    height = max(300, max((node["y"] + node_height + 40 for node in positioned.values()), default=0))
    rendered_edges = []
    for edge in edges:
        source, target = positioned[edge.source_id], positioned[edge.target_id]
        source_center_x = source["x"] + source["width"] / 2
        source_center_y = source["y"] + source["height"] / 2
        target_center_x = target["x"] + target["width"] / 2
        target_center_y = target["y"] + target["height"] / 2
        if abs(target_center_y - source_center_y) > node_height:
            direction = 1 if target_center_y > source_center_y else -1
            x1, y1 = source_center_x, source_center_y + direction * source["height"] / 2
            x2, y2 = target_center_x, target_center_y - direction * target["height"] / 2
            curve = max(34, abs(y2 - y1) * 0.48)
            path = (
                f"M {x1} {y1} C {x1} {y1 + direction * curve}, "
                f"{x2} {y2 - direction * curve}, {x2} {y2}"
            )
        else:
            direction = 1 if target_center_x > source_center_x else -1
            x1 = source_center_x + direction * source["width"] / 2
            y1 = source_center_y
            x2 = target_center_x - direction * target["width"] / 2
            y2 = target_center_y
            curve = max(36, abs(x2 - x1) * 0.36)
            lift = -42 if source["y"] <= target["y"] else 42
            path = (
                f"M {x1} {y1} C {x1 + direction * curve} {y1 + lift}, "
                f"{x2 - direction * curve} {y2 + lift}, {x2} {y2}"
            )
        rendered_edges.append(
            {
                "id": edge.id,
                "source_id": edge.source_id,
                "target_id": edge.target_id,
                "relation_type": edge.relation_type,
                "path": path,
                "label_x": (x1 + x2) / 2,
                "label_y": (y1 + y2) / 2 - 7,
                "directed": edge.relation_type != "related_to",
            }
        )
    return {
        "nodes": sorted(positioned.values(), key=lambda item: (item["y"], item["x"])),
        "edges": rendered_edges,
        "clusters": clusters,
        "relation_counts": relation_counts,
        "width": width,
        "height": height,
    }


def create_app(data_root: Path, state_root: Path) -> FastAPI:
    from .demo import (
        DemoIsolationMiddleware,
        check_demo_paths,
        is_demo_data,
        workspace_identity,
    )

    check_demo_paths(data_root, state_root)
    resolved_data_root = data_root.resolve()
    resolved_state_root = state_root.resolve()
    from .reset_storage import recover

    recover(resolved_state_root)
    from .workspace_registry import display_name

    demo = is_demo_data(resolved_data_root)
    package_root = Path(__file__).resolve().parent
    templates = Jinja2Templates(directory=package_root / "templates")
    templates.env.globals.update(
        level_labels=LEVEL_LABELS,
        interest_labels=INTEREST_LABELS,
        preference_labels=PREFERENCE_LABELS,
        material_relationship_labels=MATERIAL_RELATIONSHIP_LABELS,
        material_type_labels=MATERIAL_TYPE_LABELS,
        material_knowledge_role_labels=MATERIAL_KNOWLEDGE_ROLE_LABELS,
        salience_labels=SALIENCE_LABELS,
        preference_aspect_labels=PREFERENCE_ASPECT_LABELS,
        entity_labels=ENTITY_LABELS,
        role_labels=ROLE_LABELS,
        relation_labels=RELATION_LABELS,
        proposal_status_labels=PROPOSAL_STATUS_LABELS,
        operation_labels=OPERATION_LABELS,
        field_labels=FIELD_LABELS,
        display_value=_display_value,
        record_url=_record_url,
        json_value=lambda value: json.dumps(value, ensure_ascii=False, indent=2),
    )

    app = FastAPI(title="AI Persona Studio", docs_url=None, redoc_url=None)
    app.state.studio_access = StudioAccess() if demo else StudioAccess.from_environment()
    if demo:
        app.add_middleware(DemoIsolationMiddleware)
    app.add_middleware(StudioAccessMiddleware, policy=app.state.studio_access)
    app.state.data_root = resolved_data_root
    app.state.state_root = resolved_state_root
    app.mount("/static", StaticFiles(directory=package_root / "static"), name="static")
    import_service = MaterialImportService(resolved_data_root, resolved_state_root)

    def load_store() -> PersonaStore:
        try:
            return PersonaStore(resolved_data_root).load()
        except StoreValidationError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    def saved_record_url(proposal: ChangeProposal) -> str:
        record = load_store().records[proposal.target_id].record
        if isinstance(record, (PreferenceContext, Preference, PreferenceExample)):
            selected = (
                record.id if isinstance(record, PreferenceContext)
                else "global" if isinstance(record, Preference) and record.scope == "global"
                else record.context_refs[0]
            )
            values = {"context": selected}
            if record.status != "active":
                values["status"] = record.status
            return "/preferences?" + urlencode(values)
        if isinstance(record, Relation):
            source = load_store().records[record.source_id].record
            return _record_url(source)
        if isinstance(record, Evidence):
            material_id = next((item for item in record.supports if item.startswith("mat_")), None)
            return f"/materials/{material_id}/source-text" if material_id else "/materials"
        if proposal.operation == "archive":
            if isinstance(record, Material):
                return "/materials?status=archived"
            if isinstance(record, Course):
                return "/courses"
            if isinstance(record, KnowledgeNode):
                return "/knowledge"
        return _record_url(record)

    def form_record_revision(form: Any) -> int | None:
        value = form.get("record_revision")
        if value is None:
            return None
        try:
            revision = int(str(value))
            if revision < 1:
                raise ValueError
            return revision
        except ValueError as exc:
            raise StaleProposalError("记录已更新，请刷新页面后重新编辑。") from exc

    def ensure_inline_domain_tag(label: str) -> Tag:
        """Resolve or immediately publish a domain tag entered in a record form."""

        normalized_label = label.strip()
        if not normalized_label:
            raise ProposalError("请输入新标签名称")
        normalized_key = normalized_label.casefold()
        store = load_store()
        slug = _normalize_tag_slug("", fallback=normalized_label)
        matching_tag = next(
            (
                tag
                for tag in _domain_tags(store, active_only=False)
                if normalized_key
                in {
                    tag.label.strip().casefold(),
                    tag.slug.strip().casefold(),
                    *(alias.strip().casefold() for alias in tag.aliases),
                }
                or tag.slug.casefold() == slug.casefold()
            ),
            None,
        )
        service = HumanEditService(resolved_data_root, resolved_state_root)
        if matching_tag is not None:
            if matching_tag.status == "archived":
                restored = service.create_restore(matching_tag.id)
                record = load_store().records[restored.target_id].record
                assert isinstance(record, Tag)
                return record
            return matching_tag
        created = service.create_record(
            "tag",
            {
                "namespace": "domain",
                "slug": slug,
                "label": normalized_label,
                "aliases": [],
            },
        )
        record = load_store().records[created.target_id].record
        assert isinstance(record, Tag)
        return record

    def domain_tag_ids_with_inline_new(
        form: Any,
        store: PersonaStore,
        *,
        existing: BaseRecord | None = None,
    ) -> list[str]:
        selected = _domain_tag_ids_from_form(form, store, existing=existing)
        new_label = str(form.get("new_tag", "")).strip()
        if new_label:
            new_tag = ensure_inline_domain_tag(new_label)
            if new_tag.id not in selected:
                selected.append(new_tag.id)
        return selected

    def apply_record_tags_immediately(
        record_id: str,
        model: type[KnowledgeNode] | type[Material],
        form: Any,
    ) -> None:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, model):
            raise HTTPException(status_code=404, detail="Record not found")
        if loaded.record.status != "active":
            raise ProposalError("归档记录不能修改标签")
        selected = domain_tag_ids_with_inline_new(
            form,
            store,
            existing=loaded.record,
        )
        if set(selected) == set(loaded.record.tags):
            return
        service = HumanEditService(resolved_data_root, resolved_state_root)
        service.create_update(record_id, {"tags": selected})

    async def stage_material_source(form: Any) -> str:
        source_mode = str(form.get("source_mode", "upload"))
        material_type = str(form.get("material_type", "other"))
        if source_mode == "upload":
            upload = form.get("source_file")
            if upload is None or not getattr(upload, "filename", ""):
                raise MaterialSourceError("请选择要导入的原文文件")
            content = await upload.read(20 * 1024 * 1024 + 1)
            staged = await run_in_threadpool(
                stage_source,
                resolved_data_root,
                content=content,
                filename=str(upload.filename),
                source_type=material_type,
                provider="file-upload",
                media_type=getattr(upload, "content_type", None),
            )
        elif source_mode == "paste":
            staged = await run_in_threadpool(
                stage_pasted_source,
                resolved_data_root,
                text=str(form.get("source_text", "")),
                source_type=material_type,
            )
        elif source_mode == "url":
            bibliography = _material_values(form)["bibliography"]
            identifiers = bibliography["identifiers"]
            identifier = identifiers["arxiv"] or identifiers["doi"] or identifiers["isbn"]
            source_url = str(form.get("source_url", "")).strip()
            if not source_url and identifiers["arxiv"]:
                source_url = f"https://arxiv.org/pdf/{identifiers['arxiv']}"
            elif not source_url and identifiers["doi"]:
                source_url = f"https://doi.org/{identifiers['doi']}"
            staged = await run_in_threadpool(
                stage_url_source,
                resolved_data_root,
                url=source_url,
                source_type=material_type,
                identifier=identifier,
            )
        else:
            raise MaterialSourceError("未知的原文导入方式")
        return staged.manifest.id

    def material_context(
        request: Request, store: PersonaStore, loaded: LoadedRecord
    ) -> dict[str, Any]:
        material = loaded.record
        assert isinstance(material, Material)
        selectable_tags = _domain_tags(store)
        relation_groups = _material_relations(store).get(material.id, {})
        relation_paths = {
            relation.id: _knowledge_path(store, node.id)
            for items in relation_groups.values()
            for relation, node in items
        }
        relation_evidence = {
            relation.id: [
                store.records[evidence_id].record
                for evidence_id in relation.evidence_refs
                if evidence_id in store.records
                and isinstance(store.records[evidence_id].record, Evidence)
            ]
            for items in relation_groups.values()
            for relation, _ in items
        }
        relation_count = sum(len(items) for items in relation_groups.values())
        pending_relations = []
        for proposal in ProposalRepository(resolved_data_root).list_pending():
            if proposal.target_entity_type != "relation" or proposal.operation != "relate":
                continue
            values = {change.field: change.after for change in proposal.patch}
            if values.get("source_id") == material.id:
                pending_relations.append(proposal)
        context = common_context(request, store, "materials")
        context.update(
            {
                "loaded": loaded,
                "material": material,
                "source": store.sources[material.source_ref],
                "has_source_text": any(
                    item.role == "extracted_text"
                    or (item.role == "original" and item.media_type.startswith("text/"))
                    for item in store.sources[material.source_ref].files
                ),
                "tags": [
                    store.records[item].record
                    for item in material.tags
                    if item in store.records and isinstance(store.records[item].record, Tag)
                ],
                "all_tags": selectable_tags,
                "preserved_tags": _preserved_tags(
                    store, material, selectable_tags
                ),
                "relation_groups": relation_groups,
                "relation_count": relation_count,
                "relation_paths": relation_paths,
                "relation_evidence": relation_evidence,
                "available_evidence": [
                    item
                    for item in store.of_type(Evidence, active_only=True)
                    if item.source_id == material.source_ref
                ],
                "pending_relations": pending_relations,
                "proposal_cards": {
                    proposal.id: proposal_presentation(proposal, store, request_locale(request))
                    for proposal in pending_relations
                },
                "content_hash": record_content_hash(loaded),
                "record_revisions": _record_revisions(resolved_data_root, material.id),
            }
        )
        return context

    def common_context(request: Request, store: PersonaStore, section: str) -> dict[str, Any]:
        assert store.config is not None
        locale = request_locale(request)
        t = translator(locale)
        labels = {
            name: label_map(locale, name)
            for name in (
                "level",
                "interest",
                "preference",
                "material_relationship",
                "material_type",
                "material_knowledge_role",
                "salience",
                "preference_aspect",
                "entity",
                "role",
                "relation",
                "proposal_status",
                "operation",
                "behavior",
                "preference_scope",
                "preference_status",
                "example_type",
                "record_status",
                "field",
            )
        }
        return {
            "request": request,
            "section": section,
            "persona": store.config,
            "is_demo": demo,
            "workspace_id": workspace_identity(resolved_data_root, resolved_state_root),
            "workspace_label": display_name(resolved_data_root),
            "paper_radar_available": radar_launcher() is not None,
            "locale": locale,
            "supported_locales": SUPPORTED_LOCALES,
            "t": t,
            "ui": lambda message: studio_text(message, locale),
            "studio_messages": STUDIO_EN if locale == "en" else {},
            "level_labels": labels["level"],
            "interest_labels": labels["interest"],
            "preference_labels": labels["preference"],
            "material_relationship_labels": labels["material_relationship"],
            "material_type_labels": labels["material_type"],
            "material_knowledge_role_labels": labels["material_knowledge_role"],
            "salience_labels": labels["salience"],
            "preference_aspect_labels": labels["preference_aspect"],
            "entity_labels": labels["entity"],
            "role_labels": labels["role"],
            "relation_labels": labels["relation"],
            "proposal_status_labels": labels["proposal_status"],
            "operation_labels": labels["operation"],
            "behavior_labels": labels["behavior"],
            "preference_scope_labels": labels["preference_scope"],
            "preference_status_labels": labels["preference_status"],
            "example_type_labels": labels["example_type"],
            "record_status_labels": labels["record_status"],
            "field_labels": labels["field"],
            "display_value": lambda value: _localized_display_value(
                value,
                [
                    labels["level"],
                    labels["interest"],
                    labels["preference"],
                    labels["material_relationship"],
                    labels["material_knowledge_role"],
                    labels["salience"],
                    labels["relation"],
                    labels["behavior"],
                    labels["preference_scope"],
                    labels["preference_status"],
                ],
                t("common.unknown"),
            ),
            "pending_count": len(ProposalRepository(resolved_data_root).list_pending()),
            "message": request.query_params.get("message", ""),
            "message_kind": request.query_params.get("kind", "success"),
        }

    def ui_error(request: Request, exc: Exception) -> str:
        return localized_error(request_locale(request), str(exc))

    def render_import_landing(
        request: Request,
        *,
        error: str = "",
        arxiv_input: str = "",
        status_code: int = 200,
    ) -> HTMLResponse:
        store = load_store()
        context = common_context(request, store, "materials")
        material_use = request.query_params.get("use", "library")
        context.update({"error": error, "arxiv_input": arxiv_input,
                        "material_use": material_use if material_use in {"extract", "ai"} else "library"})
        return templates.TemplateResponse(
            request=request,
            name="material_import.html",
            context=context,
            status_code=status_code,
        )

    def render_import_review(
        request: Request,
        draft: ImportDraft,
        *,
        form: Any | None = None,
        error: str = "",
        status_code: int = 200,
    ) -> HTMLResponse:
        store = load_store()
        context = common_context(request, store, "materials")
        duplicate_records = {
            item.material_id: store.records[item.material_id].record
            for item in draft.duplicate_matches
            if item.material_id in store.records
            and isinstance(store.records[item.material_id].record, Material)
        }
        context.update(
            {
                "draft": draft,
                "material_use": request.query_params.get("use", "library"),
                "values": _import_form_values(draft, form),
                "all_tags": _domain_tags(store),
                "duplicate_records": duplicate_records,
                "version_match": next(
                    (
                        item
                        for item in draft.duplicate_matches
                        if item.kind == "newer_version"
                    ),
                    None,
                ),
                "blocked_matches": [
                    item
                    for item in draft.duplicate_matches
                    if item.kind in {"exact", "older_version"}
                ],
                "possible_matches": [
                    item for item in draft.duplicate_matches if item.kind == "possible"
                ],
                "autofilled_count": sum(
                    state.status == "autofilled"
                    for state in draft.field_states.values()
                ),
                "review_count": sum(
                    state.status == "review_required"
                    for state in draft.field_states.values()
                ),
                "error": error,
            }
        )
        return templates.TemplateResponse(
            request=request,
            name="material_import_review.html",
            context=context,
            status_code=status_code,
        )

    @app.post("/language")
    async def set_language(request: Request) -> RedirectResponse:
        form = await request.form()
        locale = str(form.get("locale", DEFAULT_LOCALE))
        if locale not in SUPPORTED_LOCALES:
            locale = DEFAULT_LOCALE
        return_to = str(form.get("return_to", "/"))
        if not return_to.startswith("/") or return_to.startswith("//"):
            return_to = "/"
        response = RedirectResponse(return_to, status_code=303)
        response.set_cookie(
            LOCALE_COOKIE,
            locale,
            max_age=365 * 24 * 60 * 60,
            samesite="lax",
        )
        return response

    @app.get("/api/knowledge/suggestions")
    async def knowledge_suggestions(
        request: Request,
        q: str = "",
        source_id: str = "",
        relation_type: str = "",
        knowledge_role: str = "",
    ) -> list[dict[str, Any]]:
        store = load_store()
        locale = request_locale(request)
        role_labels = label_map(locale, "role")
        nodes = store.of_type(KnowledgeNode, active_only=True)
        nodes_by_id = {node.id: node for node in nodes}
        tag_labels = {
            tag.id: tag.label for tag in store.of_type(Tag, active_only=True)
        }
        parents: dict[str, list[str]] = defaultdict(list)
        for relation in store.of_type(Relation, active_only=True):
            if relation.relation_type == "broader_than":
                parents[relation.target_id].append(relation.source_id)
        for values in parents.values():
            values.sort()
        path_cache: dict[str, list[str]] = {}

        def path_to(node_id: str) -> list[str]:
            if node_id in path_cache:
                return path_cache[node_id]
            candidates = [
                [*path_to(parent_id), node_id]
                for parent_id in parents.get(node_id, [])
                if parent_id in nodes_by_id
            ]
            path_cache[node_id] = (
                sorted(candidates, key=lambda item: (-len(item), item))[0]
                if candidates
                else [node_id]
            )
            return path_cache[node_id]

        normalized_query = q.strip().casefold()
        terms = normalized_query.split()
        ranked: list[tuple[tuple[Any, ...], KnowledgeNode]] = []

        for node in nodes:
            if node.id == source_id:
                continue
            title = node.title.casefold()
            aliases = [alias.casefold() for alias in node.aliases]
            tags = [tag_labels[tag_id] for tag_id in node.tags if tag_id in tag_labels]
            path_text = " › ".join(
                nodes_by_id[item].title for item in path_to(node.id)[:-1]
            )
            haystack = "\n".join(
                [node.title, *node.aliases, *tags, path_text, node.summary]
            ).casefold()
            if terms and not all(term in haystack for term in terms):
                continue

            if not normalized_query:
                rank: tuple[Any, ...] = (
                    0,
                    -node.updated_at.timestamp(),
                    node.title.casefold(),
                )
            elif normalized_query == title or normalized_query in aliases:
                rank = (0, node.title.casefold())
            elif title.startswith(normalized_query):
                rank = (1, node.title.casefold())
            elif any(alias.startswith(normalized_query) for alias in aliases):
                rank = (2, node.title.casefold())
            elif normalized_query in title:
                rank = (3, node.title.casefold())
            elif any(normalized_query in alias for alias in aliases):
                rank = (4, node.title.casefold())
            else:
                rank = (5, node.title.casefold())
            ranked.append((rank, node))

        existing = {
            (
                relation.source_id,
                relation.target_id,
                relation.relation_type,
                relation.knowledge_role if relation.relation_type == "covers" else "",
            )
            for relation in store.of_type(Relation, active_only=True)
        }
        suggestions: list[dict[str, Any]] = []
        for _, node in sorted(ranked, key=lambda item: item[0])[:10]:
            candidate_source, candidate_target = source_id, node.id
            if relation_type == "related_to" and candidate_source > candidate_target:
                candidate_source, candidate_target = candidate_target, candidate_source
            duplicate = (
                candidate_source,
                candidate_target,
                relation_type,
                knowledge_role if relation_type == "covers" else "",
            ) in existing
            path = [
                nodes_by_id[item]
                for item in path_to(node.id)
                if item in nodes_by_id
            ]
            suggestions.append(
                {
                    "id": node.id,
                    "title": node.title,
                    "aliases": node.aliases[:3],
                    "role": role_labels[node.semantic_role],
                    "path": [item.title for item in path[:-1]],
                    "disabled": duplicate,
                }
            )
        return suggestions

    def detail_context(
        request: Request,
        store: PersonaStore,
        loaded: LoadedRecord,
        *,
        section: str,
        page_root: str,
        page_label: str,
        editable: bool,
        show_relations: bool,
    ) -> dict[str, Any]:
        record = loaded.record
        selectable_tags = (
            _domain_tags(store) if isinstance(record, KnowledgeNode) else []
        )
        outgoing: list[tuple[Relation, BaseRecord]] = []
        incoming: list[tuple[Relation, BaseRecord]] = []
        if show_relations:
            for relation in store.of_type(Relation, active_only=True):
                if relation.source_id == record.id and relation.target_id in store.records:
                    outgoing.append((relation, store.records[relation.target_id].record))
                if relation.target_id == record.id and relation.source_id in store.records:
                    incoming.append((relation, store.records[relation.source_id].record))
        evidence_refs = getattr(record, "evidence_refs", [])
        context = common_context(request, store, section)
        context.update(
            {
                "loaded": loaded,
                "record": record,
                "outgoing": outgoing,
                "incoming": incoming,
                "evidence": [
                    store.records[item].record
                    for item in evidence_refs
                    if item in store.records and isinstance(store.records[item].record, Evidence)
                ],
                "tags": [
                    store.records[item].record
                    for item in getattr(record, "tags", [])
                    if item in store.records and isinstance(store.records[item].record, Tag)
                ],
                "all_tags": selectable_tags,
                "preserved_tags": _preserved_tags(
                    store, record, selectable_tags
                ),
                "content_hash": record_content_hash(loaded),
                "page_root": page_root,
                "page_label": page_label,
                "editable": editable,
                "show_relations": show_relations,
            }
        )
        return context

    def proposal_is_stale(proposal: Any, store: PersonaStore) -> bool:
        context = proposal.proposal_context
        if context.kind == "material":
            material = store.records.get(context.material_id or "")
            source = store.sources.get(context.source_id or "")
            if (
                material is None
                or not isinstance(material.record, Material)
                or material.record.status != "active"
                or material.record.source_ref != context.source_id
                or source is None
                or f"sha256:{source.content_hash}" != context.source_hash
            ):
                return True
        target = store.records.get(proposal.target_id)
        if proposal.operation in {"create", "relate"}:
            return target is not None
        return target is None or (
            target.record.revision != proposal.base_revision
            or record_content_hash(target) != proposal.base_hash
        )

    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request) -> HTMLResponse:
        store = load_store()
        active_counts = Counter(
            loaded.record.entity_type
            for loaded in store.records.values()
            if loaded.record.status == "active"
        )
        repository = ProposalRepository(resolved_data_root)
        pending = repository.list_pending()
        locale = request_locale(request)
        context = common_context(request, store, "dashboard")
        context.update(
            {
                "active_counts": active_counts,
                "persona_empty": not any(active_counts.get(entity) for entity in
                                         ("knowledge_node", "preference", "material", "course")),
                "pending_count": len(pending),
                "pending_breakdown": pending_breakdown(pending, store, locale),
                "recent_changes": recent_changes(
                    _read_revisions(resolved_data_root, limit=12), repository, store, locale,
                ),
            }
        )
        return templates.TemplateResponse(request=request, name="dashboard.html", context=context)

    async def render_collection(
        request: Request,
        *,
        model: type[KnowledgeNode] | type[Course] | type[Material],
        section: str,
        title: str,
        eyebrow: str,
        lead: str,
        page_root: str,
        can_create: bool,
        readonly_note: str = "",
    ) -> HTMLResponse:
        store = load_store()
        query = request.query_params.get("q", "")
        level = request.query_params.get("knowledge_level", "")
        context = common_context(request, store, section)
        context.update(
            {
                "records": _filter_records(store, model, query=query, knowledge_level=level),
                "query": query,
                "selected_level": level,
                "tags": {tag.id: tag for tag in store.of_type(Tag, active_only=True)},
                "title": title,
                "eyebrow": eyebrow,
                "lead": lead,
                "page_root": page_root,
                "can_create": can_create,
                "readonly_note": readonly_note,
            }
        )
        return templates.TemplateResponse(request=request, name="collection.html", context=context)

    @app.get("/knowledge", response_class=HTMLResponse)
    async def knowledge_browser(request: Request) -> HTMLResponse:
        store = load_store()
        query = request.query_params.get("q", "")
        level = request.query_params.get("knowledge_level", "")
        tag_id = request.query_params.get("tag_id", "")
        context = common_context(request, store, "knowledge")
        context.update(
            {
                "records": _filter_records(
                    store,
                    KnowledgeNode,
                    query=query,
                    knowledge_level=level,
                    tag_id=tag_id,
                ),
                "query": query,
                "selected_level": level,
                "selected_tag_id": tag_id,
                "filter_tags": _domain_tags(store),
                "tags": {
                    tag.id: tag for tag in store.of_type(Tag, active_only=False)
                },
                "graph": knowledge_graph_data(store),
            }
        )
        return templates.TemplateResponse(request=request, name="knowledge.html", context=context)

    @app.get("/courses", response_class=HTMLResponse)
    async def courses(request: Request) -> HTMLResponse:
        t = translator(request_locale(request))
        return await render_collection(
            request,
            model=Course,
            section="courses",
            title=t("courses.page_title"),
            eyebrow="COURSE LIBRARY",
            lead=t("courses.lead"),
            page_root="/courses",
            can_create=True,
        )

    @app.get("/materials", response_class=HTMLResponse)
    async def materials(request: Request) -> HTMLResponse:
        store = load_store()
        filters = {
            "query": request.query_params.get("q", ""),
            "knowledge_level": request.query_params.get("knowledge_level", ""),
            "preference_level": request.query_params.get("preference_level", ""),
            "material_type": request.query_params.get("material_type", ""),
            "relationship": request.query_params.get("relationship", ""),
            "tag_id": request.query_params.get("tag_id", ""),
            "knowledge_id": request.query_params.get("knowledge_id", ""),
            "knowledge_role": request.query_params.get("knowledge_role", ""),
            "salience": request.query_params.get("salience", ""),
            "status": request.query_params.get("status", "active"),
        }
        context = common_context(request, store, "materials")
        context.update(
            {
                "records": _filter_materials(store, **filters),
                "filters": filters,
                "tags": _domain_tags(store),
                "tag_map": {
                    tag.id: tag for tag in store.of_type(Tag, active_only=False)
                },
                "knowledge_nodes": store.of_type(KnowledgeNode, active_only=True),
                "material_relations": _material_relations(store),
            }
        )
        return templates.TemplateResponse(
            request=request, name="materials.html", context=context
        )

    @app.get("/materials/table", response_class=HTMLResponse)
    async def material_table(request: Request) -> HTMLResponse:
        store = load_store()
        filters = {
            "query": request.query_params.get("q", ""),
            "knowledge_level": request.query_params.get("knowledge_level", ""),
            "preference_level": request.query_params.get("preference_level", ""),
            "material_type": request.query_params.get("material_type", ""),
            "relationship": request.query_params.get("relationship", ""),
            "tag_id": request.query_params.get("tag_id", ""),
            "knowledge_id": request.query_params.get("knowledge_id", ""),
            "knowledge_role": request.query_params.get("knowledge_role", ""),
            "salience": request.query_params.get("salience", ""),
            "status": request.query_params.get("status", "active"),
        }
        context = common_context(request, store, "materials")
        context.update(
            {
                "records": _filter_materials(store, **filters),
                "tag_map": {
                    tag.id: tag for tag in store.of_type(Tag, active_only=False)
                },
                "material_relations": _material_relations(store),
            }
        )
        return templates.TemplateResponse(
            request=request,
            name="partials/material_table.html",
            context=context,
        )

    @app.get("/{section_name}/table", response_class=HTMLResponse)
    async def collection_table(section_name: str, request: Request) -> HTMLResponse:
        model_by_section = {
            "knowledge": KnowledgeNode,
            "courses": Course,
        }
        model = model_by_section.get(section_name)
        if model is None:
            raise HTTPException(status_code=404, detail="Unknown collection")
        store = load_store()
        context = common_context(request, store, section_name)
        context.update(
            {
                "records": _filter_records(
                store,
                model,
                query=request.query_params.get("q", ""),
                knowledge_level=request.query_params.get("knowledge_level", ""),
                tag_id=(
                    request.query_params.get("tag_id", "")
                    if model is KnowledgeNode
                    else ""
                ),
            ),
                "tags": {
                    tag.id: tag for tag in store.of_type(Tag, active_only=False)
                },
            }
        )
        return templates.TemplateResponse(
            request=request, name="partials/knowledge_table.html", context=context
        )

    @app.get("/knowledge/new", response_class=HTMLResponse)
    async def new_knowledge(request: Request) -> HTMLResponse:
        store = load_store()
        context = common_context(request, store, "knowledge")
        context.update(
            {
                "mode": "create",
                "entity_type": "knowledge_node",
                "record": None,
                "loaded": None,
                "all_tags": _domain_tags(store),
                "page_root": "/knowledge",
                "page_label": translator(request_locale(request))("common.knowledge"),
                "form_action": "/knowledge/proposals",
            }
        )
        return templates.TemplateResponse(request=request, name="record_form.html", context=context)

    @app.post("/knowledge/proposals")
    async def create_knowledge(request: Request) -> RedirectResponse:
        form = await request.form()
        store = load_store()
        try:
            values = {
                "title": str(form.get("title", "")).strip(),
                "aliases": _split_lines(form.get("aliases")),
                "semantic_role": str(form.get("semantic_role", "")),
                "knowledge_level": str(form.get("knowledge_level", "")).strip()
                or "unspecified",
                "interest_level": str(form.get("interest_level", "")),
                "summary": str(form.get("summary", "")).strip(),
                "scope_note": str(form.get("scope_note", "")).strip() or None,
                "tags": domain_tag_ids_with_inline_new(form, store),
            }
            proposal = HumanEditService(resolved_data_root, resolved_state_root).create_record(
                "knowledge_node",
                values,
                body=str(form.get("body", "")),
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect("/knowledge/new", ui_error(request, exc), kind="error")
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.knowledge_created"),
        )

    @app.get("/courses/new", response_class=HTMLResponse)
    async def new_course(request: Request) -> HTMLResponse:
        store = load_store()
        context = common_context(request, store, "courses")
        context.update(
            {
                "mode": "create",
                "entity_type": "course",
                "record": None,
                "loaded": None,
                "all_tags": store.of_type(Tag, active_only=True),
                "page_root": "/courses",
                "page_label": translator(request_locale(request))("common.courses"),
                "form_action": "/courses/proposals",
            }
        )
        return templates.TemplateResponse(request=request, name="record_form.html", context=context)

    @app.post("/courses/proposals")
    async def create_course(request: Request) -> RedirectResponse:
        form = await request.form()
        values = {
            "title": str(form.get("title", "")).strip(),
            "aliases": _split_lines(form.get("aliases")),
            "knowledge_level": str(form.get("knowledge_level", "")).strip() or "unspecified",
            "interest_level": str(form.get("interest_level", "")),
            "description": str(form.get("description", "")).strip(),
            "syllabus": str(form.get("syllabus", "")).strip(),
            "tags": [str(value) for value in form.getlist("tags")],
        }
        try:
            proposal = HumanEditService(resolved_data_root, resolved_state_root).create_record(
                "course", values, reason=str(form.get("reason", ""))
            )
        except ProposalError as exc:
            return _redirect("/courses/new", ui_error(request, exc), kind="error")
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.course_created"),
        )

    @app.get("/materials/new", response_class=HTMLResponse)
    async def new_material(request: Request) -> HTMLResponse:
        return render_import_landing(request)

    @app.post("/materials/import-preview", response_class=HTMLResponse)
    async def preview_material_import(request: Request) -> Any:
        form = await request.form()
        input_kind = str(form.get("input_kind", "arxiv"))
        arxiv_input = str(form.get("arxiv_input", "")).strip()
        try:
            if input_kind == "arxiv":
                draft = await run_in_threadpool(import_service.create_arxiv, arxiv_input)
            elif input_kind in {"markdown", "file"}:
                upload = form.get("markdown_file")
                if upload is None or not getattr(upload, "filename", ""):
                    raise MaterialImportError("请选择 Markdown、TXT 或文本 PDF 文件")
                content = await upload.read(20 * 1024 * 1024 + 1)
                draft = await run_in_threadpool(
                    import_service.create_file,
                    str(upload.filename),
                    content,
                )
            elif input_kind == "text":
                title = str(form.get("source_title", "")).strip() or "粘贴文本"
                draft = await run_in_threadpool(import_service.create_file, title + ".txt", str(form.get("source_text", "")).encode())
            else:
                raise MaterialImportError("请选择 arXiv、Markdown、文本 PDF、TXT 或粘贴文本")
        except (MaterialImportError, ImportDraftError) as exc:
            return render_import_landing(
                request,
                error=ui_error(request, exc),
                arxiv_input=arxiv_input,
                status_code=422,
            )
        use = request.query_params.get("use", "library")
        suffix = "?use=" + use if use in {"extract", "ai"} else ""
        return RedirectResponse(f"/materials/imports/{draft.id}" + suffix, status_code=303)

    @app.get("/materials/imports/{draft_id}", response_class=HTMLResponse)
    async def review_material_import(draft_id: str, request: Request) -> HTMLResponse:
        try:
            draft = await run_in_threadpool(import_service.get, draft_id)
        except ImportDraftError as exc:
            return render_import_landing(
                request,
                error=ui_error(request, exc),
                status_code=404,
            )
        return render_import_review(request, draft)

    @app.get("/materials/imports/{draft_id}/source", response_class=FileResponse)
    async def material_import_source(draft_id: str) -> FileResponse:
        try:
            draft = await run_in_threadpool(import_service.get, draft_id)
            path = import_service.repository.file_path(draft, draft.original_file)
            file_info = next(item for item in draft.files if item.path == draft.original_file)
        except ImportDraftError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return FileResponse(
            path,
            media_type=file_info.media_type,
            filename=draft.display_name,
            content_disposition_type="inline",
        )

    @app.post("/materials/imports/{draft_id}/cancel")
    async def cancel_material_import(draft_id: str, request: Request) -> RedirectResponse:
        try:
            await run_in_threadpool(import_service.delete, draft_id)
        except ImportDraftError:
            pass
        return _redirect(
            "/materials",
            translator(request_locale(request))("material_import.cancelled"),
        )

    @app.post("/materials/imports/{draft_id}/proposals", response_class=HTMLResponse)
    async def create_imported_material_proposal(
        draft_id: str, request: Request
    ) -> Any:
        form = await request.form()
        staged_source_id: str | None = None
        try:
            draft = await run_in_threadpool(import_service.get, draft_id)
            blocked = [
                item
                for item in draft.duplicate_matches
                if item.kind in {"exact", "older_version", "newer_version"}
            ]
            if blocked:
                raise MaterialImportError("该材料已存在，请使用页面上的现有记录操作")
            if any(item.kind == "possible" for item in draft.duplicate_matches) and not form.get(
                "duplicate_confirmed"
            ):
                raise MaterialImportError("请先确认相似材料不是同一份内容")
            values = _material_values(form)
            staged = await run_in_threadpool(
                import_service.stage_draft,
                draft.id,
                material_type=values["material_type"],
            )
            staged_source_id = staged.manifest.id
            values["tags"] = domain_tag_ids_with_inline_new(form, load_store())
            values["source_ref"] = staged_source_id
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_record(
                "material",
                values,
                body=str(form.get("body", "")),
                reason=str(form.get("reason", "")),
            )
        except (ImportDraftError, MaterialImportError, ProposalError, MaterialSourceError) as exc:
            if staged_source_id:
                try:
                    discard_staged_source(resolved_data_root, staged_source_id)
                except MaterialSourceError:
                    pass
            try:
                draft
            except UnboundLocalError:
                return render_import_landing(
                    request, error=ui_error(request, exc), status_code=404
                )
            return render_import_review(
                request,
                draft,
                form=form,
                error=ui_error(request, exc),
                status_code=422,
            )
        await run_in_threadpool(import_service.delete, draft.id)
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.material_created"),
        )

    @app.post(
        "/materials/imports/{draft_id}/version-proposals",
        response_class=HTMLResponse,
    )
    async def create_material_version_proposal(
        draft_id: str, request: Request
    ) -> Any:
        form = await request.form()
        staged_source_id: str | None = None
        try:
            draft = await run_in_threadpool(import_service.get, draft_id)
            match = next(
                (
                    item
                    for item in draft.duplicate_matches
                    if item.kind == "newer_version"
                ),
                None,
            )
            if match is None:
                raise MaterialImportError("当前导入不是已存材料的更新版本")
            source_values = _material_values(form)
            staged = await run_in_threadpool(
                import_service.stage_draft,
                draft.id,
                material_type=source_values["material_type"],
            )
            staged_source_id = staged.manifest.id
            updates = {
                "material_type": source_values["material_type"],
                "title": source_values["title"],
                "aliases": source_values["aliases"],
                "abstract": source_values["abstract"],
                "bibliography": source_values["bibliography"],
                "source_ref": staged_source_id,
            }
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_update(
                match.material_id,
                updates,
                reason=str(form.get("reason", "")),
            )
        except (ImportDraftError, MaterialImportError, ProposalError, MaterialSourceError) as exc:
            if staged_source_id:
                try:
                    discard_staged_source(resolved_data_root, staged_source_id)
                except MaterialSourceError:
                    pass
            try:
                draft
            except UnboundLocalError:
                return render_import_landing(
                    request, error=ui_error(request, exc), status_code=404
                )
            return render_import_review(
                request,
                draft,
                form=form,
                error=ui_error(request, exc),
                status_code=422,
            )
        await run_in_threadpool(import_service.delete, draft.id)
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.material_updated"),
        )

    @app.post("/materials/proposals")
    async def create_material(request: Request) -> RedirectResponse:
        form = await request.form()
        staged_source_id: str | None = None
        try:
            values = _material_values(form)
            staged_source_id = await stage_material_source(form)
            values["tags"] = domain_tag_ids_with_inline_new(form, load_store())
            values["source_ref"] = staged_source_id
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_record(
                "material",
                values,
                body=str(form.get("body", "")),
                reason=str(form.get("reason", "")),
            )
        except (ProposalError, MaterialSourceError) as exc:
            if staged_source_id:
                try:
                    discard_staged_source(resolved_data_root, staged_source_id)
                except MaterialSourceError:
                    pass
            return _redirect("/materials/new", ui_error(request, exc), kind="error")
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.material_created"),
        )

    @app.get("/knowledge/{record_id}", response_class=HTMLResponse)
    async def knowledge_detail(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, KnowledgeNode):
            raise HTTPException(status_code=404, detail="Knowledge record not found")
        return templates.TemplateResponse(
            request=request,
            name="knowledge_detail.html",
            context=detail_context(
                request,
                store,
                loaded,
                section="knowledge",
                page_root="/knowledge",
                page_label=translator(request_locale(request))("common.knowledge"),
                editable=True,
                show_relations=True,
            ),
        )

    @app.get("/courses/{record_id}", response_class=HTMLResponse)
    async def course_detail(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Course):
            raise HTTPException(status_code=404, detail="Course not found")
        return templates.TemplateResponse(
            request=request,
            name="knowledge_detail.html",
            context=detail_context(
                request,
                store,
                loaded,
                section="courses",
                page_root="/courses",
                page_label=translator(request_locale(request))("common.courses"),
                editable=True,
                show_relations=False,
            ),
        )

    @app.get("/materials/{record_id}", response_class=HTMLResponse)
    async def material_detail(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        return templates.TemplateResponse(
            request=request,
            name="material_detail.html",
            context=material_context(request, store, loaded),
        )

    @app.post("/materials/{record_id}/tags")
    async def update_material_tags(
        record_id: str, request: Request
    ) -> RedirectResponse:
        form = await request.form()
        try:
            apply_record_tags_immediately(record_id, Material, form)
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}", ui_error(request, exc), kind="error"
            )
        return _redirect(
            f"/materials/{record_id}#tag-settings",
            translator(request_locale(request))("discipline_tags.saved"),
        )

    @app.get("/materials/{record_id}/edit", response_class=HTMLResponse)
    async def material_edit(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        context = common_context(request, store, "materials")
        context.update(
            {
                "mode": "edit",
                "material": loaded.record,
                "loaded": loaded,
                "all_tags": _domain_tags(store),
                "preserved_tags": _preserved_tags(
                    store, loaded.record, _domain_tags(store)
                ),
                "form_action": f"/materials/{record_id}/proposals",
                "preference_reasons_text": "\n".join(
                f"{label_map(request_locale(request), 'preference_aspect')[item.aspect]} | {item.note}"
                    for item in loaded.record.preference_reasons
                ),
            }
        )
        return templates.TemplateResponse(
            request=request, name="material_form.html", context=context
        )

    @app.post("/materials/{record_id}/proposals")
    async def update_material(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            store = load_store()
            loaded = store.records.get(record_id)
            if loaded is None or not isinstance(loaded.record, Material):
                raise HTTPException(status_code=404, detail="Material not found")
            values = _material_values(form)
            values.pop("tags", None)
            values["body"] = str(form.get("body", ""))
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_update(
                record_id, values, reason=str(form.get("reason", "")),
                expected_revision=form_record_revision(form),
            )
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}/edit", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.material_updated"),
        )

    @app.post("/materials/{record_id}/archive-proposals")
    async def archive_material(record_id: str, request: Request) -> RedirectResponse:
        return await archive_record(request, record_id, "/materials")

    @app.post("/materials/{record_id}/restore-proposals")
    async def restore_material(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_restore(record_id, reason=str(form.get("reason", "")))
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.material_restored"),
        )

    @app.get("/materials/{record_id}/source", response_class=FileResponse)
    async def material_source(record_id: str) -> FileResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        manifest = store.sources[loaded.record.source_ref]
        file_info = next(
            item for item in manifest.files if item.path == manifest.canonical_file
        )
        path = resolved_data_root / "sources" / manifest.id / manifest.canonical_file
        return FileResponse(
            path,
            media_type=file_info.media_type,
            filename=manifest.origin.identifier or manifest.canonical_file,
            content_disposition_type="inline",
        )

    @app.get("/materials/{record_id}/source-text", response_class=HTMLResponse)
    async def material_source_text(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        manifest = store.sources[loaded.record.source_ref]
        text_file = next(
            (item for item in manifest.files if item.role == "extracted_text"),
            next(
                (
                    item
                    for item in manifest.files
                    if item.role == "original" and item.media_type.startswith("text/")
                ),
                None,
            ),
        )
        if text_file is None:
            return _redirect(
                f"/materials/{record_id}",
                translator(request_locale(request))("messages.no_source_text"),
                kind="error",
            )
        text = (
            resolved_data_root / "sources" / manifest.id / text_file.path
        ).read_text(encoding="utf-8", errors="replace")
        context = common_context(request, store, "materials")
        context.update(
            {
                "material": loaded.record,
                "source": manifest,
                "source_text": text,
                "source_lines": list(enumerate(text.splitlines(), start=1)),
                "line_count": len(text.splitlines()),
                "source_file": text_file,
            }
        )
        return templates.TemplateResponse(
            request=request, name="material_source.html", context=context
        )

    @app.post("/materials/{record_id}/evidence-proposals")
    async def create_material_evidence(
        record_id: str, request: Request
    ) -> RedirectResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        manifest = store.sources[loaded.record.source_ref]
        text_file = next(
            (item for item in manifest.files if item.role == "extracted_text"),
            next(
                (
                    item
                    for item in manifest.files
                    if item.role == "original" and item.media_type.startswith("text/")
                ),
                None,
            ),
        )
        if text_file is None:
            return _redirect(
                f"/materials/{record_id}",
                translator(request_locale(request))("messages.no_locatable_text"),
                kind="error",
            )
        form = await request.form()
        try:
            line_start = int(str(form.get("line_start", "")))
            line_end = int(str(form.get("line_end", "")))
        except ValueError:
            return _redirect(
                f"/materials/{record_id}/source-text",
                translator(request_locale(request))("messages.valid_lines"),
                kind="error",
            )
        lines = (
            resolved_data_root / "sources" / manifest.id / text_file.path
        ).read_text(encoding="utf-8", errors="replace").splitlines()
        if (
            line_start < 1
            or line_end < line_start
            or line_end > len(lines)
            or line_end - line_start > 49
        ):
            return _redirect(
                f"/materials/{record_id}/source-text",
                translator(request_locale(request))(
                    "messages.line_range", count=len(lines)
                ),
                kind="error",
            )
        excerpt = "\n".join(lines[line_start - 1 : line_end]).strip()
        if not excerpt:
            return _redirect(
                f"/materials/{record_id}/source-text",
                translator(request_locale(request))("messages.empty_selection"),
                kind="error",
            )
        values = {
            "source_id": manifest.id,
            "source_hash": f"sha256:{manifest.content_hash}",
            "locator": {
                "file": text_file.path,
                "heading": str(form.get("heading", "")).strip() or None,
                "line_start": line_start,
                "line_end": line_end,
            },
            "supports": [record_id],
            "evidence_kind": "human_edit",
            "extraction_method": "human_line_selection",
            "confidence": 1.0,
        }
        try:
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_record(
                "evidence",
                values,
                body=excerpt,
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}/source-text", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.evidence_created"),
        )

    @app.get("/materials/{record_id}/source-manifest", response_class=FileResponse)
    async def material_source_manifest(record_id: str) -> FileResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        manifest = store.sources[loaded.record.source_ref]
        return FileResponse(
            resolved_data_root / "sources" / manifest.id / "manifest.yaml",
            media_type="application/yaml",
            filename=f"{manifest.id}.manifest.yaml",
            content_disposition_type="inline",
        )

    @app.get("/materials/{record_id}/source/edit", response_class=HTMLResponse)
    async def material_source_edit(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        context = common_context(request, store, "materials")
        context.update({"material": loaded.record, "source": store.sources[loaded.record.source_ref]})
        return templates.TemplateResponse(
            request=request, name="material_source_form.html", context=context
        )

    @app.post("/materials/{record_id}/source-proposals")
    async def update_material_source(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        staged_source_id: str | None = None
        try:
            staged_source_id = await stage_material_source(form)
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_update(
                record_id,
                {"source_ref": staged_source_id},
                reason=str(form.get("reason", "")),
                expected_revision=form_record_revision(form),
            )
        except (ProposalError, MaterialSourceError) as exc:
            if staged_source_id:
                try:
                    discard_staged_source(resolved_data_root, staged_source_id)
                except MaterialSourceError:
                    pass
            return _redirect(
                f"/materials/{record_id}/source/edit", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.source_updated"),
        )

    @app.post("/materials/{record_id}/relation-proposals")
    async def add_material_relation(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            rows = _repeated_form_rows(
                form, "target_id", "knowledge_role", "salience", "statement"
            )
            relations = [
                (target_id, knowledge_role, salience, statement)
                for target_id, knowledge_role, salience, statement in rows
                if target_id
            ]
            proposals = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_material_relations(
                record_id,
                relations,
                evidence_refs=[str(item) for item in form.getlist("evidence_refs")],
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}", ui_error(request, exc), kind="error"
            )
        if len(proposals) > 1:
            return _redirect(
                saved_record_url(proposals[0]),
                translator(request_locale(request))(
                    "messages.knowledge_relations_created", count=len(proposals)
                ),
            )
        return _redirect(
            saved_record_url(proposals[0]),
            translator(request_locale(request))("messages.knowledge_relation_created"),
        )

    @app.get(
        "/materials/{record_id}/relations/{relation_id}/edit",
        response_class=HTMLResponse,
    )
    async def material_relation_edit(
        record_id: str, relation_id: str, request: Request
    ) -> HTMLResponse:
        store = load_store()
        material = store.records.get(record_id)
        loaded = store.records.get(relation_id)
        if material is None or not isinstance(material.record, Material):
            raise HTTPException(status_code=404, detail="Material not found")
        if (
            loaded is None
            or not isinstance(loaded.record, Relation)
            or loaded.record.source_id != record_id
            or loaded.record.relation_type != "covers"
        ):
            raise HTTPException(status_code=404, detail="Material relation not found")
        context = common_context(request, store, "materials")
        context.update(
            {
                "material": material.record,
                "relation": loaded.record,
                "knowledge": store.records[loaded.record.target_id].record,
                "evidence": store.of_type(Evidence, active_only=True),
            }
        )
        return templates.TemplateResponse(
            request=request, name="material_relation_form.html", context=context
        )

    @app.post("/materials/{record_id}/relations/{relation_id}/proposals")
    async def update_material_relation(
        record_id: str, relation_id: str, request: Request
    ) -> RedirectResponse:
        form = await request.form()
        store = load_store()
        loaded = store.records.get(relation_id)
        if (
            loaded is None
            or not isinstance(loaded.record, Relation)
            or loaded.record.source_id != record_id
        ):
            raise HTTPException(status_code=404, detail="Material relation not found")
        updates = {
            "knowledge_role": str(form.get("knowledge_role", "")),
            "salience": str(form.get("salience", "")),
            "statement": str(form.get("statement", "")).strip(),
            "evidence_refs": [str(item) for item in form.getlist("evidence_refs")],
        }
        try:
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_update(
                relation_id, updates, reason=str(form.get("reason", "")),
                expected_revision=form_record_revision(form),
            )
        except ProposalError as exc:
            return _redirect(
                f"/materials/{record_id}/relations/{relation_id}/edit",
                ui_error(request, exc),
                kind="error",
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.relation_updated"),
        )

    @app.get("/knowledge/{record_id}/edit", response_class=HTMLResponse)
    async def knowledge_edit(record_id: str, request: Request) -> HTMLResponse:
        return await render_record_edit(
            request,
            record_id,
            KnowledgeNode,
            "knowledge",
            "/knowledge",
            translator(request_locale(request))("common.knowledge"),
        )

    @app.post("/knowledge/{record_id}/tags")
    async def update_knowledge_tags(
        record_id: str, request: Request
    ) -> RedirectResponse:
        form = await request.form()
        try:
            apply_record_tags_immediately(record_id, KnowledgeNode, form)
        except ProposalError as exc:
            return _redirect(
                f"/knowledge/{record_id}", ui_error(request, exc), kind="error"
            )
        return _redirect(
            f"/knowledge/{record_id}#tag-settings",
            translator(request_locale(request))("discipline_tags.saved"),
        )

    @app.get("/courses/{record_id}/edit", response_class=HTMLResponse)
    async def course_edit(record_id: str, request: Request) -> HTMLResponse:
        return await render_record_edit(
            request,
            record_id,
            Course,
            "courses",
            "/courses",
            translator(request_locale(request))("common.courses"),
        )

    async def render_record_edit(
        request: Request,
        record_id: str,
        model: type[KnowledgeNode] | type[Course],
        section: str,
        page_root: str,
        page_label: str,
    ) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, model):
            raise HTTPException(status_code=404, detail=f"{page_label}不存在")
        context = common_context(request, store, section)
        selectable_tags = (
            _domain_tags(store)
            if isinstance(loaded.record, KnowledgeNode)
            else store.of_type(Tag, active_only=True)
        )
        context.update(
            {
                "mode": "edit",
                "entity_type": loaded.record.entity_type,
                "record": loaded.record,
                "loaded": loaded,
                "all_tags": selectable_tags,
                "preserved_tags": _preserved_tags(
                    store, loaded.record, selectable_tags
                ),
                "page_root": page_root,
                "page_label": page_label,
                "form_action": f"{page_root}/{record_id}/proposals",
            }
        )
        return templates.TemplateResponse(request=request, name="record_form.html", context=context)

    async def update_record(request: Request, record_id: str, page_root: str) -> RedirectResponse:
        form = await request.form()
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, (KnowledgeNode, Course)):
            raise HTTPException(status_code=404, detail="Record not found")
        try:
            updates: dict[str, Any] = {
                "title": str(form.get("title", "")).strip(),
                "aliases": _split_lines(form.get("aliases")),
                "knowledge_level": str(form.get("knowledge_level", "")).strip()
                or "unspecified",
                "interest_level": str(form.get("interest_level", "")),
            }
            if isinstance(loaded.record, KnowledgeNode):
                updates.update(
                    {
                        "summary": str(form.get("summary", "")).strip(),
                        "scope_note": str(form.get("scope_note", "")).strip() or None,
                        "body": str(form.get("body", "")).strip(),
                    }
                )
                if "semantic_role" in form:
                    updates["semantic_role"] = str(form.get("semantic_role", ""))
            else:
                updates.update(
                    {
                        "description": str(form.get("description", "")).strip(),
                        "syllabus": str(form.get("syllabus", "")).strip(),
                        "tags": [str(value) for value in form.getlist("tags")],
                    }
                )
            proposal = HumanEditService(resolved_data_root, resolved_state_root).create_update(
                record_id, updates, reason=str(form.get("reason", "")),
                expected_revision=form_record_revision(form),
            )
        except ProposalError as exc:
            return _redirect(
                f"{page_root}/{record_id}/edit", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.record_updated"),
        )

    @app.post("/knowledge/{record_id}/proposals")
    async def update_knowledge(record_id: str, request: Request) -> RedirectResponse:
        return await update_record(request, record_id, "/knowledge")

    @app.post("/courses/{record_id}/proposals")
    async def update_course(record_id: str, request: Request) -> RedirectResponse:
        return await update_record(request, record_id, "/courses")

    @app.post("/knowledge/{record_id}/archive-proposals")
    async def archive_knowledge(record_id: str, request: Request) -> RedirectResponse:
        return await archive_record(request, record_id, "/knowledge")

    @app.post("/courses/{record_id}/archive-proposals")
    async def archive_course(record_id: str, request: Request) -> RedirectResponse:
        return await archive_record(request, record_id, "/courses")

    async def archive_record(request: Request, record_id: str, page_root: str) -> RedirectResponse:
        form = await request.form()
        try:
            proposal = HumanEditService(resolved_data_root, resolved_state_root).create_archive(
                record_id, reason=str(form.get("reason", ""))
            )
        except ProposalError as exc:
            return _redirect(
                f"{page_root}/{record_id}", ui_error(request, exc), kind="error"
            )
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.archive_created"),
        )

    @app.post("/knowledge/{record_id}/relation-proposals")
    async def add_relation(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            rows = _repeated_form_rows(form, "relation_type", "target_id")
            relations = [
                (relation_type, target_id)
                for relation_type, target_id in rows
                if target_id
            ]
            proposals = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_relations(
                record_id,
                relations,  # type: ignore[arg-type]
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect(
                f"/knowledge/{record_id}", ui_error(request, exc), kind="error"
            )
        if len(proposals) > 1:
            return _redirect(
                saved_record_url(proposals[0]),
                translator(request_locale(request))(
                    "messages.knowledge_relations_created", count=len(proposals)
                ),
            )
        return _redirect(
            saved_record_url(proposals[0]),
            translator(request_locale(request))("messages.knowledge_relation_created"),
        )

    @app.post("/relations/{relation_id}/remove-proposals")
    async def remove_relation(relation_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        store = load_store()
        loaded = store.records.get(relation_id)
        if loaded is None or not isinstance(loaded.record, Relation):
            raise HTTPException(status_code=404, detail="Relation not found")
        source = store.records.get(loaded.record.source_id)
        destination = (
            f"/materials/{loaded.record.source_id}"
            if source and isinstance(source.record, Material)
            else "/knowledge"
        )
        try:
            proposal = HumanEditService(resolved_data_root, resolved_state_root).create_unrelate(
                relation_id,
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect(destination, ui_error(request, exc), kind="error")
        return _redirect(
            saved_record_url(proposal),
            translator(request_locale(request))("messages.relation_removed"),
        )

    preference_context_cookie = "ai_persona_context_" + hashlib.sha256(
        str(resolved_data_root).encode()
    ).hexdigest()[:12]

    @app.get("/preferences", response_class=HTMLResponse)
    async def preferences(request: Request) -> HTMLResponse:
        store = load_store()
        view = build_preference_workspace(
            store, resolved_data_root, request.query_params,
            request.cookies.get(preference_context_cookie, ""),
            translator(request_locale(request)),
        )
        context = common_context(request, store, "preferences")
        context.update(view)
        response = templates.TemplateResponse(
            request=request, name="preferences.html", context=context
        )
        response.set_cookie(
            preference_context_cookie, view["selected_context"], max_age=31536000,
            httponly=True, samesite="lax", path="/preferences",
        )
        return response

    @app.get("/preferences/new", response_class=HTMLResponse)
    async def preference_new(request: Request) -> HTMLResponse:
        return render_preference_form(
            request, "preference", "create",
            selected_context_id=request.query_params.get("context_id", ""),
        )

    @app.get("/preferences/items/{record_id}/edit", response_class=HTMLResponse)
    async def preference_edit(record_id: str, request: Request) -> HTMLResponse:
        return render_preference_form(request, "preference", "edit", record_id)

    @app.get("/preferences/contexts/new", response_class=HTMLResponse)
    async def preference_context_new(request: Request) -> HTMLResponse:
        return render_preference_form(request, "context", "create")

    @app.get("/preferences/contexts/{record_id}/edit", response_class=HTMLResponse)
    async def preference_context_edit(record_id: str, request: Request) -> HTMLResponse:
        return render_preference_form(request, "context", "edit", record_id)

    @app.get("/preferences/examples/new", response_class=HTMLResponse)
    async def preference_example_new(request: Request) -> HTMLResponse:
        return render_preference_form(
            request,
            "example",
            "create",
            selected_context_id=request.query_params.get("context_id", ""),
        )

    @app.get("/preferences/examples/{record_id}/edit", response_class=HTMLResponse)
    async def preference_example_edit(record_id: str, request: Request) -> HTMLResponse:
        return render_preference_form(request, "example", "edit", record_id)

    @app.get("/preferences/examples/{record_id}/file", response_class=FileResponse)
    async def preference_example_file(record_id: str, path: str = "") -> FileResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, PreferenceExample):
            raise HTTPException(status_code=404, detail="Preference example not found")
        manifest = store.sources[loaded.record.source_ref]
        relative = path or manifest.canonical_file
        if path and (not is_folder_source(manifest)
                     or path not in {item.path for item in folder_members(manifest)}):
            raise HTTPException(status_code=404, detail="Sample file not found")
        try:
            file_path = store.source_file_path(manifest.id, relative)
        except StoreValidationError as exc:
            raise HTTPException(status_code=404, detail="Sample file not found") from exc
        file_info = next(item for item in manifest.files if item.path == relative)
        media_type = file_info.media_type
        disposition = "inline"
        filename = manifest.canonical_file
        if is_folder_source(manifest):
            filename = Path(relative).name if path else f"{manifest.origin.identifier}.zip"
            if media_type.startswith("text/"):
                media_type = "text/plain"
            elif media_type not in {"application/pdf", "image/png", "image/jpeg",
                                    "image/webp", "image/gif"}:
                disposition = "attachment"
        return FileResponse(
            file_path, media_type=media_type, filename=filename,
            content_disposition_type=disposition,
            headers={"X-Content-Type-Options": "nosniff"},
        )

    @app.get("/preferences/examples/{record_id}/files", response_class=HTMLResponse)
    async def preference_example_files(record_id: str, request: Request) -> HTMLResponse:
        store = load_store()
        loaded = store.records.get(record_id)
        if loaded is None or not isinstance(loaded.record, PreferenceExample):
            raise HTTPException(status_code=404, detail="Preference example not found")
        source = store.sources[loaded.record.source_ref]
        if not is_folder_source(source):
            raise HTTPException(status_code=404, detail="Folder sample not found")
        context = common_context(request, store, "preferences")
        context.update({
            "sample": loaded.record, "source": source,
            "tree": folder_tree(source, resolved_data_root, record_id),
            "file_count": len(folder_members(source)),
            "folder_path": str((resolved_data_root / "sources" / source.id
                                / "files" / source.origin.identifier).resolve()),
            "return_to": preference_return_url(
                request.query_params.get("return_to"),
                "/preferences?" + urlencode({"context": loaded.record.context_refs[0]}),
            ),
        })
        return templates.TemplateResponse(
            request=request, name="preference_folder.html", context=context,
        )

    def render_preference_form(
        request: Request,
        item_kind: str,
        mode: str,
        record_id: str = "",
        *,
        selected_context_id: str = "",
        form_values: dict[str, Any] | None = None,
        form_errors: dict[str, str] | None = None,
        submitted_revision: str | None = None,
        status_code: int = 200,
        return_to: str = "",
    ) -> HTMLResponse:
        store = load_store()
        loaded: LoadedRecord | None = None
        record: BaseRecord | None = None
        expected = {
            "context": PreferenceContext,
            "preference": Preference,
            "example": PreferenceExample,
        }.get(item_kind)
        if expected is None:
            raise HTTPException(status_code=404, detail="Unknown preference type")
        if mode == "edit":
            loaded = store.records.get(record_id)
            if loaded is None or not isinstance(loaded.record, expected):
                raise HTTPException(status_code=404, detail="Preference record not found")
            record = loaded.record
        contexts = [
            item
            for item in store.of_type(PreferenceContext, active_only=False)
            if item.status != "archived"
        ]
        if selected_context_id not in {item.id for item in contexts}:
            selected_context_id = ""
        source = (
            store.sources[record.source_ref]
            if isinstance(record, PreferenceExample)
            else None
        )
        context = common_context(request, store, "preferences")
        context.update(
            {
                "mode": mode,
                "item_kind": item_kind,
                "record": record,
                "loaded": loaded,
                "contexts": contexts,
                "selected_context_id": selected_context_id,
                "source": source,
                "is_folder": bool(source and is_folder_source(source)),
                "sample_values": (
                    form_values if item_kind == "example" and form_values is not None
                    else record.model_dump() if isinstance(record, PreferenceExample)
                    else {"title": "", "condition": "", "reasons": [],
                          "example_type": "positive", "context_refs": [selected_context_id]}
                ),
                "return_to": preference_return_url(
                    return_to or request.query_params.get("return_to"),
                    "/preferences?" + urlencode({"context": selected_context_id})
                    if selected_context_id else "/preferences",
                ),
                "editor_values": (
                    form_values if form_values is not None
                    else record.model_dump() if record
                    else {"name": "", "description": "", "activation": {
                        "intents": [], "artifact_types": [], "excludes": [],
                    }}
                ),
                "form_errors": form_errors or {},
                "editor_revision": (
                    submitted_revision if submitted_revision is not None
                    else record.revision if record else ""
                ),
                "form_action": (
                    {
                        "context": "/preferences/contexts/proposals",
                        "preference": "/preferences/proposals",
                        "example": "/preferences/examples/proposals",
                    }[item_kind]
                    if mode == "create"
                    else {
                        "context": f"/preferences/contexts/{record_id}/proposals",
                        "preference": f"/preferences/items/{record_id}/proposals",
                        "example": f"/preferences/examples/{record_id}/proposals",
                    }[item_kind]
                ),
            }
        )
        return templates.TemplateResponse(
            request=request,
            name=("preference_context_form.html" if item_kind == "context"
                  else "preference_form.html"),
            context=context,
            status_code=status_code,
        )

    def preference_context_values(form: Any, *, include_key: bool) -> dict[str, Any]:
        values: dict[str, Any] = {
            "name": str(form.get("name", "")).strip(),
            "description": str(form.get("description", "")).strip(),
            "activation": {
                "intents": (
                    [str(item).strip() for item in form.getlist("request_examples")
                     if str(item).strip()]
                    if "request_examples" in form else _split_lines(form.get("intents"))
                ),
                "artifact_types": _split_lines(form.get("artifact_types")),
                "excludes": _split_lines(form.get("excludes")),
            },
        }
        if include_key:
            raw_key = str(form.get("key", "")).strip().casefold()
            normalized_key = re.sub(r"[^a-z0-9.-]+", "-", raw_key).strip(".-")
            values["key"] = normalized_key or f"custom.{uuid.uuid4().hex[:10]}"
        return values

    def preference_values(form: Any) -> dict[str, Any]:
        scope = str(form.get("scope", "global"))
        return {
            "scope": scope,
            "context_refs": (
                [str(item) for item in form.getlist("context_refs") if item]
                if scope == "contexts"
                else []
            ),
            "behavior": str(form.get("behavior", "")),
            "instruction": str(form.get("instruction", "")).strip(),
            "condition": str(form.get("condition", "")).strip(),
            "rationale": str(form.get("rationale", "")).strip(),
        }

    def preference_example_values(form: Any) -> dict[str, Any]:
        return {
            "context_refs": [
                str(item) for item in form.getlist("context_refs") if item
            ],
            "example_type": str(form.get("example_type", "")),
            "title": str(form.get("title", "")).strip(),
            "condition": str(form.get("condition", "")).strip(),
            "reasons": _split_lines(form.get("reasons")),
        }

    def save_preference_record(
        request: Request,
        *,
        item_kind: str,
        values: dict[str, Any],
        form: Any = None,
        body: str | None = "",
        record_id: str = "",
        reason: str = "",
    ) -> RedirectResponse | HTMLResponse:
        entity_type = {
            "context": "preference_context",
            "preference": "preference",
            "example": "preference_example",
        }[item_kind]
        error_path = (
            {
                "context": "/preferences/contexts/new",
                "preference": "/preferences/new",
                "example": "/preferences/examples/new",
            }[item_kind]
            if not record_id
            else {
                "context": f"/preferences/contexts/{record_id}/edit",
                "preference": f"/preferences/items/{record_id}/edit",
                "example": f"/preferences/examples/{record_id}/edit",
            }[item_kind]
        )
        def context_error(errors: dict[str, str], status_code: int) -> HTMLResponse:
            return render_preference_form(
                request, "context", "edit" if record_id else "create", record_id,
                form_values=values,
                form_errors=errors,
                submitted_revision=str((form or {}).get("record_revision", "")),
                status_code=status_code,
                return_to=preference_return_url((form or {}).get("return_to")),
            )

        if item_kind == "context":
            translate = translator(request_locale(request))
            errors = {
                field: translate(f"preference_form.required_{field}")
                for field in ("name", "description") if not values[field]
            }
            if errors:
                return context_error(errors, 422)
        try:
            service = HumanEditService(resolved_data_root, resolved_state_root)
            if record_id:
                if body is not None:
                    values["body"] = body
                proposal = service.create_update(
                    record_id, values, reason=reason, expected_revision=form_record_revision(form or {})
                )
            else:
                proposal = service.create_record(
                    entity_type,  # type: ignore[arg-type]
                    values,
                    body=body or "",
                    reason=reason,
                )
        except ProposalError as exc:
            if item_kind == "context":
                return context_error(
                    {"form": ui_error(request, exc)},
                    409 if isinstance(exc, StaleProposalError) else 422,
                )
            return _redirect(error_path, ui_error(request, exc), kind="error")
        return _redirect(
            preference_return_url((form or {}).get("return_to"), saved_record_url(proposal)),
            translator(request_locale(request))("messages.preference_updated"),
        )

    @app.post("/preferences/contexts/proposals", response_model=None)
    async def create_preference_context(request: Request) -> RedirectResponse | HTMLResponse:
        form = await request.form()
        return save_preference_record(
            request,
            item_kind="context",
            form=form,
            values=preference_context_values(form, include_key=True),
            body=str(form.get("body", "")),
            reason=str(form.get("reason", "")),
        )

    @app.post("/preferences/contexts/{record_id}/proposals", response_model=None)
    async def update_preference_context(
        record_id: str, request: Request
    ) -> RedirectResponse | HTMLResponse:
        form = await request.form()
        return save_preference_record(
            request,
            item_kind="context",
            record_id=record_id,
            form=form,
            values=preference_context_values(form, include_key=False),
            body=str(form["body"]) if "body" in form else None,
            reason=str(form.get("reason", "")),
        )

    @app.post("/preferences/proposals")
    async def create_preference(request: Request) -> RedirectResponse:
        form = await request.form()
        return save_preference_record(
            request,
            item_kind="preference",
            form=form,
            values=preference_values(form),
            body=str(form.get("body", "")),
            reason=str(form.get("reason", "")),
        )

    @app.post("/preferences/items/{record_id}/proposals")
    async def update_preference(record_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        return save_preference_record(
            request,
            item_kind="preference",
            record_id=record_id,
            form=form,
            values=preference_values(form),
            body=str(form.get("body", "")),
            reason=str(form.get("reason", "")),
        )

    @app.post("/preferences/examples/proposals", response_model=None)
    async def create_preference_example(request: Request) -> RedirectResponse | HTMLResponse:
        form = await request.form(max_files=501)
        staged_source_id: str | None = None
        try:
            staged = await stage_preference_upload(resolved_data_root, form)
            staged_source_id = staged.manifest.id
            values = preference_example_values(form)
            values.update(
                {
                    "source_ref": staged_source_id,
                    "content_hash": f"sha256:{staged.manifest.content_hash}",
                }
            )
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_record(
                "preference_example",
                values,
                reason=str(form.get("reason", "")),
            )
        except (ProposalError, MaterialSourceError) as exc:
            if staged_source_id:
                try:
                    discard_staged_source(resolved_data_root, staged_source_id)
                except MaterialSourceError:
                    pass
            return render_preference_form(
                request, "example", "create", status_code=422,
                form_values={**preference_example_values(form),
                             "reason": str(form.get("reason", "")),
                             "upload_kind": str(form.get("upload_kind", "file"))},
                form_errors={"form": ui_error(request, exc)},
                return_to=preference_return_url(form.get("return_to")),
            )
        finally:
            await form.close()
        return _redirect(
            preference_return_url(form.get("return_to"), saved_record_url(proposal)),
            translator(request_locale(request))("messages.preference_updated"),
        )

    @app.post("/preferences/examples/{record_id}/proposals")
    async def update_preference_example(
        record_id: str, request: Request
    ) -> RedirectResponse:
        form = await request.form()
        return save_preference_record(
            request,
            item_kind="example",
            record_id=record_id,
            form=form,
            values=preference_example_values(form),
            reason=str(form.get("reason", "")),
        )

    @app.post("/preferences/{item_kind}/{record_id}/state-proposals")
    async def change_preference_state(
        item_kind: str, record_id: str, request: Request
    ) -> RedirectResponse:
        expected = {
            "contexts": PreferenceContext,
            "preferences": Preference,
            "examples": PreferenceExample,
        }.get(item_kind)
        if expected is None:
            raise HTTPException(status_code=404, detail="Unknown preference type")
        form = await request.form()
        new_status = str(form.get("status", ""))
        store = load_store()
        loaded = store.records.get(record_id)
        if (
            loaded is None
            or not isinstance(loaded.record, expected)
            or new_status
            not in (
                {"active"}
                if expected is PreferenceContext
                else {"active", "paused"}
            )
            or loaded.record.status == new_status
            or (loaded.record.status == "archived" and new_status != "active")
        ):
            return _redirect(
                "/preferences",
                translator(request_locale(request))("messages.invalid_preference_state"),
                kind="error",
            )
        try:
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_update(
                record_id,
                {"status": new_status},
                reason=str(form.get("reason", "")),
            )
        except ProposalError as exc:
            return _redirect("/preferences", ui_error(request, exc), kind="error")
        return _redirect(
            preference_return_url(form.get("return_to"), saved_record_url(proposal)),
            translator(request_locale(request))("messages.preference_updated"),
        )

    @app.post("/preferences/{item_kind}/{record_id}/archive-proposals")
    async def archive_preference(
        item_kind: str, record_id: str, request: Request
    ) -> RedirectResponse:
        if item_kind not in {"contexts", "preferences", "examples"}:
            raise HTTPException(status_code=404, detail="Unknown preference type")
        form = await request.form()
        try:
            proposal = HumanEditService(
                resolved_data_root, resolved_state_root
            ).create_archive(record_id, reason=str(form.get("reason", "")))
        except ProposalError as exc:
            return _redirect("/preferences", ui_error(request, exc), kind="error")
        return _redirect(
            preference_return_url(form.get("return_to"), saved_record_url(proposal)),
            translator(request_locale(request))("messages.archive_created"),
        )

    def next_change_set_review_url(
        manifest: ChangeSetManifest, *, exclude: set[str] | None = None
    ) -> str:
        repository = ProposalRepository(resolved_data_root)
        excluded = exclude or set()
        for proposal_id in manifest.topological_proposal_ids():
            if proposal_id in excluded:
                continue
            proposal = repository.get(proposal_id)
            if proposal.status not in {"pending_review", "deferred"}:
                continue
            dependencies = [
                repository.get(item) for item in manifest.dependencies_of(proposal_id)
            ]
            if all(
                item.status in {"accepted", "edited_and_accepted"}
                for item in dependencies
            ):
                return f"/review/{proposal_id}"
        return f"/review?change_set={manifest.id}"

    @app.get("/review", response_class=HTMLResponse)
    async def review_queue(request: Request) -> HTMLResponse:
        from .studio_links import legacy_inbox
        return legacy_inbox(request, kind="change_set", key=request.query_params.get("change_set"))

    @app.get("/review/{proposal_id}", response_class=HTMLResponse)
    async def review_detail(proposal_id: str, request: Request) -> HTMLResponse:
        from .studio_links import legacy_inbox
        try:
            ProposalRepository(resolved_data_root).get(proposal_id)
        except ProposalError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return legacy_inbox(request, kind="proposal", key=proposal_id)

    def render_review(
        proposal_id: str,
        request: Request,
        *,
        submitted_values: dict[str, Any] | None = None,
        review_note: str = "",
        error: str = "",
        status_code: int = 200,
    ) -> HTMLResponse:
        store = load_store()
        try:
            proposal = ProposalRepository(resolved_data_root).get(proposal_id)
        except ProposalError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        target = store.records.get(proposal.target_id)
        evidence = [
            store.records[item].record
            for item in proposal.evidence_refs
            if item in store.records and isinstance(store.records[item].record, Evidence)
        ]
        staged_source = None
        staged_source_preview = ""
        source_ref_change = next(
            (change for change in proposal.patch if change.field == "source_ref"), None
        )
        if source_ref_change and isinstance(source_ref_change.after, str):
            try:
                staged = validate_staged_source(resolved_data_root, source_ref_change.after)
            except MaterialSourceError:
                staged = None
            if staged:
                staged_source = staged.manifest
                text_file = next(
                    (
                        item
                        for item in staged.manifest.files
                        if item.role == "extracted_text"
                        or (
                            item.role == "original"
                            and item.media_type.startswith("text/")
                        )
                    ),
                    None,
                )
                if text_file:
                    staged_source_preview = (staged.path / text_file.path).read_text(
                        encoding="utf-8", errors="replace"
                    )[:2_500]
        context = common_context(request, store, "review")
        change_set_repository = ChangeSetRepository(resolved_data_root)
        try:
            change_set = change_set_repository.find_by_proposal_id(proposal.id)
        except ChangeSetError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        dependencies = change_set.dependencies_of(proposal.id) if change_set else []
        dependent_ids = change_set.transitive_dependents_of(proposal.id) if change_set else []
        related_proposals = {
            item_id: ProposalRepository(resolved_data_root).get(item_id)
            for item_id in [*dependencies, *dependent_ids]
        }
        unresolved_dependencies = [
            related_proposals[item_id]
            for item_id in dependencies
            if related_proposals[item_id].status not in {"accepted", "edited_and_accepted"}
        ]
        pending_dependents = [
            related_proposals[item_id]
            for item_id in dependent_ids
            if related_proposals[item_id].status in {"pending_review", "deferred"}
        ]
        values = review_values(proposal, store)
        values.update(submitted_values or {})
        review_fields = []
        for name in editable_review_fields(proposal, store):
            value = values.get(name)
            choices: dict[str, str] = {}
            if name in CHOICE_LABELS:
                kind = "select"
                choices = label_map(request_locale(request), CHOICE_LABELS[name])
            elif name in {"tags", "context_refs"}:
                kind = "tags"
                if name == "tags":
                    choice_tags = (
                        _domain_tags(store)
                        if proposal.target_entity_type
                        in {"knowledge_node", "material"}
                        else store.of_type(Tag, active_only=True)
                    )
                    choices = {
                        tag.id: tag.label
                        for tag in choice_tags
                    }
                elif name == "context_refs":
                    choices = {
                        item.id: item.name
                        for item in store.of_type(PreferenceContext, active_only=False)
                        if item.status != "archived"
                    }
                else:
                    choices = {
                        item.id: item.instruction
                        for item in store.of_type(Preference, active_only=False)
                        if item.status != "archived"
                    }
                # Keep invalid/stale selections visible so users can explicitly remove them.
                choices.update({item: item for item in (value or []) if item not in choices})
            elif name in {"title", "name"}:
                kind = "text"
            else:
                kind = "textarea"
            if name in LINE_LIST_FIELDS and isinstance(value, list):
                value = "\n".join(value)
            review_fields.append({
                "name": name,
                "kind": kind,
                "value": value if value is not None else "",
                "choices": choices,
                "required": name in REQUIRED_TEXT_FIELDS
                or (kind == "select" and name != "knowledge_level"),
                "line_list": name in LINE_LIST_FIELDS,
            })
        presentation = proposal_presentation(proposal, store, request_locale(request))
        if proposal.target_entity_type in {"knowledge_node", "preference", "relation", "preference_context"}:
            review_fields = []
            for field in review_field_schema(proposal, store, request_locale(request)):
                if field["readonly"]:
                    continue
                value = values.get(field["name"])
                if field["kind"] == "lines":
                    value = "\n".join(value or [])
                elif field["kind"] == "json":
                    value = json.dumps(value, ensure_ascii=False, indent=2)
                review_fields.append({**field, "line_list": field["kind"] == "lines", "value": value if value is not None else ""})
        context.update(
            {
                "proposal": proposal,
                "presentation": presentation,
                "field_labels": record_field_labels(
                    presentation["entity_type"], request_locale(request)
                ),
                "target": target.record if target else None,
                "target_title": presentation["title"],
                "is_stale": proposal_is_stale(proposal, store),
                "evidence": evidence,
                "evidence_candidates": proposal.evidence_candidates,
                "staged_source": staged_source,
                "staged_source_preview": staged_source_preview,
                "duplicate_titles": [
                    _record_title(store.records[item].record)
                    for item in proposal.duplicate_candidates
                    if item in store.records
                ],
                "review_fields": review_fields,
                "can_edit_review": bool(review_fields)
                and proposal.status in {"pending_review", "deferred"}
                and not proposal_is_stale(proposal, store),
                "review_note": review_note,
                "review_error": error,
                "change_set": change_set,
                "unresolved_dependencies": unresolved_dependencies,
                "pending_dependents": pending_dependents,
                "can_accept_dependencies": not unresolved_dependencies,
                "related_proposal_cards": {
                    item_id: proposal_presentation(
                        item, store, request_locale(request)
                    )
                    for item_id, item in related_proposals.items()
                },
            }
        )
        return templates.TemplateResponse(
            request=request, name="review_detail.html", context=context, status_code=status_code
        )

    @app.post("/review/{proposal_id}/edit-and-accept", response_model=None)
    async def edit_and_accept_proposal(
        proposal_id: str, request: Request
    ) -> HTMLResponse | RedirectResponse:
        form = await request.form()
        updates: dict[str, Any] = {}
        review_note = str(form.get("review_note", "")).strip()
        try:
            proposal = ProposalRepository(resolved_data_root).get(proposal_id)
            fields = editable_review_fields(proposal, load_store())
            specifications = {f["name"]: f for f in review_field_schema(proposal, load_store())}
            if not fields:
                raise ProposalError("此类提案不支持修改字段后通过。")
            unknown = set(form) - set(fields) - {"proposal_revision", "review_note"}
            if unknown:
                raise ProposalError(f"unsupported review fields: {sorted(unknown)}")
            for name in fields:
                if name not in form:
                    continue
                if name in {"tags", "context_refs"}:
                    updates[name] = [str(value) for value in form.getlist(name) if value]
                elif name in LINE_LIST_FIELDS or specifications.get(name, {}).get("kind") == "lines":
                    updates[name] = _split_lines(form.get(name))
                elif specifications.get(name, {}).get("kind") == "json":
                    try:
                        updates[name] = json.loads(str(form.get(name, "")))
                    except ValueError as exc:
                        raise ProposalError(f"{name}: JSON 格式无效。") from exc
                elif name == "knowledge_level":
                    updates[name] = str(form.get(name, "")).strip() or "unspecified"
                else:
                    value = str(form.get(name, "")).strip()
                    updates[name] = (
                        value or None if name in {"scope_note"} or specifications.get(name, {}).get("nullable") else value
                    )
            try:
                expected_revision = int(str(form.get("proposal_revision", "")))
            except ValueError as exc:
                raise StaleProposalError("审核页面已过期，请刷新后重新确认。") from exc
            result = ProposalService(resolved_data_root, resolved_state_root).accept(
                proposal_id,
                review_updates=updates,
                expected_proposal_revision=expected_revision,
                decision_reason=review_note,
            )
        except ProposalError as exc:
            return render_review(
                proposal_id, request, submitted_values=updates, review_note=review_note,
                error=ui_error(request, exc),
                status_code=409 if isinstance(exc, StaleProposalError) else 422,
            )
        return accepted_redirect(request, result)

    @app.post("/review/{proposal_id}/accept")
    async def accept_proposal(proposal_id: str, request: Request) -> RedirectResponse:
        try:
            result = ProposalService(resolved_data_root, resolved_state_root).accept(proposal_id)
        except (StaleProposalError, ProposalError) as exc:
            return _redirect(
                f"/review/{proposal_id}", ui_error(request, exc), kind="error"
            )
        return accepted_redirect(request, result)

    def accepted_redirect(request: Request, result: AppliedProposal) -> RedirectResponse:
        try:
            change_set = ChangeSetRepository(resolved_data_root).find_by_proposal_id(
                result.proposal.id
            )
        except ChangeSetError:
            change_set = None
        if change_set is not None:
            return _redirect(
                next_change_set_review_url(change_set),
                translator(request_locale(request))(
                    "messages.edited_and_accepted"
                    if result.proposal.status == "edited_and_accepted"
                    else "messages.accepted",
                    revision=result.persona_revision,
                ),
            )
        record = result.record
        if result.proposal.operation == "archive":
            if isinstance(record, Course):
                destination = "/courses"
            elif isinstance(record, Material):
                destination = "/materials?status=archived"
            elif isinstance(record, Tag):
                destination = "/"
            else:
                destination = "/knowledge"
        elif isinstance(record, Relation):
            destination = (
                f"/materials/{record.source_id}"
                if record.source_id.startswith("mat_")
                else f"/knowledge/{record.source_id}"
            )
        elif isinstance(record, Evidence):
            supported_material_id = next(
                (item for item in record.supports if item.startswith("mat_")), None
            )
            destination = (
                f"/materials/{supported_material_id}/source-text"
                if supported_material_id
                else "/review"
            )
        else:
            destination = _record_url(record)
        if isinstance(record, (PreferenceContext, Preference, PreferenceExample)):
            destination = "/preferences"
        return _redirect(
            destination,
            translator(request_locale(request))(
                "messages.edited_and_accepted"
                if result.proposal.status == "edited_and_accepted" else "messages.accepted",
                revision=result.persona_revision,
            ),
        )

    @app.post("/review/{proposal_id}/reject")
    async def reject_proposal(proposal_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            result = ProposalService(resolved_data_root, resolved_state_root).reject_group(
                proposal_id, str(form.get("reason", ""))
            )
        except ProposalError as exc:
            return _redirect(
                f"/review/{proposal_id}", ui_error(request, exc), kind="error"
            )
        try:
            change_set = ChangeSetRepository(resolved_data_root).find_by_proposal_id(proposal_id)
        except ChangeSetError:
            change_set = None
        destination = (
            next_change_set_review_url(
                change_set,
                exclude={item.id for item in result.rejected_proposals},
            )
            if change_set
            else "/review"
        )
        message_key = (
            "messages.rejected_with_dependents"
            if result.cascaded_count
            else "messages.rejected"
        )
        return _redirect(
            destination,
            translator(request_locale(request))(
                message_key, count=result.cascaded_count
            ),
        )

    @app.post("/review/{proposal_id}/defer")
    async def defer_proposal(proposal_id: str, request: Request) -> RedirectResponse:
        form = await request.form()
        try:
            ProposalService(resolved_data_root, resolved_state_root).defer(
                proposal_id, str(form.get("reason", ""))
            )
        except ProposalError as exc:
            return _redirect(
                f"/review/{proposal_id}", ui_error(request, exc), kind="error"
            )
        try:
            change_set = ChangeSetRepository(resolved_data_root).find_by_proposal_id(proposal_id)
        except ChangeSetError:
            change_set = None
        destination = (
            next_change_set_review_url(change_set, exclude={proposal_id})
            if change_set
            else "/review"
        )
        return _redirect(
            destination, translator(request_locale(request))("messages.deferred")
        )

    @app.get("/healthz")
    async def health() -> dict[str, Any]:
        store = load_store()
        assert store.config is not None
        return {
            "ok": True,
            "service": "ai-persona",
            "workspace_id": workspace_identity(resolved_data_root, resolved_state_root),
            "demo": demo,
            "persona_revision": store.config.revision,
        }

    from .ai_web import mount_ai_routes

    mount_ai_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .extraction.web import mount_extraction_routes

    mount_extraction_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .prompt_api import mount_prompt_routes

    mount_prompt_routes(app, resolved_state_root)
    from .conversation_learning.web import mount_learning_routes

    mount_learning_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .evaluations.web import mount_evaluation_routes

    mount_evaluation_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .preference_application.web import mount_application_routes

    mount_application_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .inbox_web import mount_inbox_routes

    mount_inbox_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .studio_web import mount_studio_routes

    mount_studio_routes(app, resolved_data_root, resolved_state_root, templates, common_context)
    from .content_reset_web import mount_content_reset_routes

    mount_content_reset_routes(app, resolved_data_root, resolved_state_root)
    from .first_use import mount_first_use
    mount_first_use(app, resolved_data_root, resolved_state_root, templates, common_context)
    return app
