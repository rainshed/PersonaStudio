"""Stable, read-only references shared by Studio and the research workspace."""
import hashlib
from urllib.parse import quote

from .models import KnowledgeNode, Material, Relation, Tag


def workspace_key(store):
    identity = f"{store.config.persona_id}\n{store.config.created_at.isoformat()}"
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def reference_id(store, record):
    # Namespaced by stable Persona identity; renames/moves preserve references,
    # and a legacy demo ID can never silently become a real library record.
    suffix = hashlib.sha256(record.id.encode()).hexdigest()[:32]
    return f"ps_{workspace_key(store)}_{suffix}"


def library_items(store, studio_origin):
    nodes = {n.id: n for n in store.of_type(KnowledgeNode)}
    tags = {t.id: t.label for t in store.of_type(Tag, active_only=True)}
    parents = {}
    for rel in store.of_type(Relation, active_only=True):
        if rel.relation_type == "broader_than":
            parents.setdefault(rel.target_id, []).append(rel.source_id)

    def ancestry(node_id, visited=frozenset()):
        if node_id in visited:
            return []
        candidates = [
            [*ancestry(parent, visited | {node_id}), nodes[parent].title]
            for parent in sorted(parents.get(node_id, [])) if parent in nodes
        ]
        return min(candidates, key=lambda p: (-len(p), p)) if candidates else []

    items = []
    for loaded in store.records.values():
        record = loaded.record
        if not isinstance(record, (KnowledgeNode, Material)):
            continue
        knowledge = isinstance(record, KnowledgeNode)
        path = " / ".join(ancestry(record.id)) if knowledge else "材料库"
        section = "knowledge" if knowledge else "materials"
        items.append({
            "id": reference_id(store, record), "record_id": record.id,
            "kind": "knowledge" if knowledge else "material",
            "title": record.title, "aliases": record.aliases,
            "tags": [tags[t] for t in record.tags if t in tags],
            "path": path or "知识库",
            "summary": record.summary or (record.abstract[:600] if not knowledge else ""),
            "archived": record.status == "archived", "source": "live",
            "revision": record.revision, "updated_at": record.updated_at.isoformat(),
            "detail_url": f"{studio_origin}/{section}/{quote(record.id, safe='')}"
            if studio_origin else "",
        })
    return sorted(items, key=lambda item: (item["archived"], item["kind"], item["title"]))


def detail_body(loaded):
    record = loaded.record
    sections = []
    if isinstance(record, Material) and record.abstract:
        sections.append("## 摘要\n" + record.abstract)
    if record.scope_note:
        sections.append("## 适用范围\n" + record.scope_note)
    if loaded.body.strip():
        sections.append(loaded.body.strip())
    return "\n\n".join(sections)
