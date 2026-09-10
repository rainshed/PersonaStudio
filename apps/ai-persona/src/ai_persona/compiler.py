from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .index import build_index
from .models import (
    SCHEMA_MODELS,
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
from .store import LoadedRecord, PersonaStore


@dataclass(frozen=True)
class BuildResult:
    persona_revision: int
    snapshot_path: Path
    state_database: Path
    record_count: int
    source_count: int


def _json_bytes(value: Any, *, pretty: bool) -> bytes:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    else:
        text = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    return text.encode("utf-8")


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    finally:
        temporary_path = Path(temporary_name)
        if temporary_path.exists():
            temporary_path.unlink()


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class PersonaCompiler:
    def __init__(self, data_root: Path, state_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.state_root = state_root.resolve()
        self.store = PersonaStore(self.data_root)

    def build(self) -> BuildResult:
        from .reset_storage import recover

        recover(self.state_root)
        self.store.load()
        assert self.store.config is not None
        self._write_schemas()

        stage = Path(tempfile.mkdtemp(prefix=".generated-", dir=self.data_root))
        try:
            self._write_snapshot(stage)
            self._write_preferences(stage)
            self._write_human_views(stage)
            self._publish_generated(stage)
        finally:
            if stage.exists():
                shutil.rmtree(stage)

        database = build_index(self.store, self.state_root)
        return BuildResult(
            persona_revision=self.store.config.revision,
            snapshot_path=self.data_root / "generated" / "persona.snapshot.json",
            state_database=database,
            record_count=len(self.store.records),
            source_count=len(self.store.sources),
        )

    def _write_schemas(self) -> None:
        schemas_root = self.data_root / "schemas"
        schemas_root.mkdir(parents=True, exist_ok=True)
        for legacy_name in (
            "preference-pack.v1.schema.json",
            "preference-rule.v1.schema.json",
            "preference-example.v1.schema.json",
            "preference-example.v2.schema.json",
        ):
            (schemas_root / legacy_name).unlink(missing_ok=True)
        for filename, model in sorted(SCHEMA_MODELS.items()):
            _atomic_write(
                schemas_root / filename,
                _json_bytes(model.model_json_schema(by_alias=True), pretty=True),
            )

    def _record_payload(self, loaded: LoadedRecord) -> dict[str, Any]:
        assert self.store.config is not None
        payload = loaded.record.model_dump(mode="json", exclude_none=True, by_alias=True)
        if self.store.config.include_human_notes_in_snapshot and loaded.body:
            payload["human_notes"] = loaded.body
        return payload

    def _write_snapshot(self, stage: Path) -> None:
        assert self.store.config is not None
        active_loaded = [
            loaded
            for loaded in self.store.records.values()
            if loaded.record.status == "active"
        ]
        generated_at = max(
            (loaded.record.updated_at for loaded in active_loaded),
            default=self.store.config.created_at,
        )

        payload: dict[str, Any] = {
            "schema_version": "ai-persona.snapshot/v1",
            "persona_id": self.store.config.persona_id,
            "persona_revision": self.store.config.revision,
            "generated_at": _iso_utc(generated_at),
            "knowledge_nodes": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(KnowledgeNode, active_only=True)
            ],
            "courses": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Course, active_only=True)
            ],
            "materials": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Material, active_only=True)
            ],
            "relations": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Relation, active_only=True)
            ],
            "tags": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Tag, active_only=False)
            ],
            "evidence_index": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Evidence, active_only=True)
            ],
            "preference_contexts": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(
                    PreferenceContext, active_only=True
                )
            ],
            "preferences": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(Preference, active_only=True)
            ],
            "preference_examples": [
                self._record_payload(loaded)
                for loaded in self.store.loaded_of_type(
                    PreferenceExample, active_only=True
                )
            ],
        }
        canonical_hash = hashlib.sha256(_json_bytes(payload, pretty=False)).hexdigest()
        payload["content_hash"] = f"sha256:{canonical_hash}"
        output = stage / "persona.snapshot.json"
        output.write_bytes(_json_bytes(payload, pretty=True))

    def _write_preferences(self, stage: Path) -> None:
        output_root = stage / "preferences"
        output_root.mkdir(parents=True, exist_ok=True)
        behavior_order = {"required": 0, "preferred": 1, "avoid": 2}
        global_preferences = [
            item
            for item in self.store.of_type(Preference, active_only=True)
            if item.scope == "global"
        ]
        loaded_examples = self.store.loaded_of_type(PreferenceExample, active_only=True)
        groups: list[tuple[str, str, list[Preference], list[LoadedRecord]]] = []
        if global_preferences:
            groups.append(("global", "All tasks", global_preferences, []))
        for context in self.store.of_type(PreferenceContext, active_only=True):
            selected = global_preferences + [
                item
                for item in self.store.of_type(Preference, active_only=True)
                if item.scope == "contexts" and context.id in item.context_refs
            ]
            examples = [
                loaded
                for loaded in loaded_examples
                if isinstance(loaded.record, PreferenceExample)
                and context.id in loaded.record.context_refs
            ]
            if selected or examples:
                groups.append((context.key, context.name, selected, examples))

        for key, name, preferences, examples in groups:
            preferences = sorted(
                {item.id: item for item in preferences}.values(),
                key=lambda item: (behavior_order[item.behavior], item.id),
            )
            lines = [
                f"# Personal Preferences: {name}",
                "",
                f"- Context key: `{key}`",
                "",
            ]
            for behavior, heading in (
                ("required", "Required"),
                ("preferred", "Preferred"),
                ("avoid", "Avoid"),
            ):
                lines.extend(["", f"## {heading}", ""])
                selected = [item for item in preferences if item.behavior == behavior]
                if not selected:
                    lines.append("No active preferences.")
                for preference in selected:
                    lines.append(f"- `{preference.id}` — {preference.instruction}")
                    if preference.condition:
                        lines.append(f"  - When: {preference.condition}")
                    if preference.rationale:
                        lines.append(f"  - Why: {preference.rationale}")
            lines.extend(["", "## Reference Examples", ""])
            if not examples:
                lines.append("No active examples.")
            for loaded_example in examples:
                example = loaded_example.record
                assert isinstance(example, PreferenceExample)
                lines.append(
                    f"- `{example.id}` — {example.title} ({example.example_type})"
                )
                manifest = self.store.sources[example.source_ref]
                lines.append(
                    f"  - File: `sources/{example.source_ref}/{manifest.canonical_file}`"
                )
                lines.append(
                    f"  - Original filename: "
                    f"`{manifest.origin.identifier or manifest.canonical_file}`"
                )
                lines.append(f"  - Content hash: `{example.content_hash}`")
                if example.condition:
                    lines.append(f"  - When: {example.condition}")
                for reason in example.reasons:
                    lines.append(f"  - {reason}")
            lines.extend(["", "## Final Check", ""])
            checks = [
                item for item in preferences if item.behavior in {"required", "avoid"}
            ]
            if checks:
                for preference in checks:
                    lines.append(f"- [ ] {preference.instruction}")
            else:
                lines.append("No required checks.")
            content_without_hash = "\n".join(lines).rstrip() + "\n"
            content_hash = hashlib.sha256(content_without_hash.encode("utf-8")).hexdigest()
            lines.insert(3, f"- Content hash: `sha256:{content_hash}`")
            (output_root / f"{key}.md").write_text(
                "\n".join(lines).rstrip() + "\n",
                encoding="utf-8",
            )

    def _write_human_views(self, stage: Path) -> None:
        human_root = stage / "human"
        human_root.mkdir(parents=True, exist_ok=True)
        self._write_home(human_root)
        self._write_knowledge_tree(human_root)
        self._write_grouped_knowledge(human_root, "knowledge_level", "by-level.md")
        self._write_grouped_knowledge(human_root, "interest_level", "by-interest.md")
        self._write_tag_view(human_root)
        self._write_courses_and_materials(human_root)
        self._write_preferences_view(human_root)

    def _write_home(self, root: Path) -> None:
        assert self.store.config is not None
        counts = Counter(
            loaded.record.entity_type
            for loaded in self.store.records.values()
            if loaded.record.status == "active"
        )
        lines = [
            "# AI Persona Demo",
            "",
            f"- Persona: `{self.store.config.persona_id}`",
            f"- Persona revision: `{self.store.config.revision}`",
            f"- Canonical records: `{sum(counts.values())}`",
            f"- Sources: `{len(self.store.sources)}`",
            "",
            "## Inventory",
            "",
        ]
        for entity_type, count in sorted(counts.items()):
            lines.append(f"- {entity_type}: {count}")
        lines.extend(
            [
                "",
                "## Views",
                "",
                "- [Knowledge tree](knowledge-tree.md)",
                "- [By level](by-level.md)",
                "- [By interest](by-interest.md)",
                "- [By tag](by-tag.md)",
                "- [Courses](courses.md)",
                "- [Materials](materials.md)",
                "- [Preferences](preferences.md)",
            ]
        )
        (root / "home.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _write_knowledge_tree(self, root: Path) -> None:
        nodes = {item.id: item for item in self.store.of_type(KnowledgeNode, active_only=True)}
        children: dict[str, list[str]] = defaultdict(list)
        parents: dict[str, set[str]] = defaultdict(set)
        for relation in self.store.of_type(Relation, active_only=True):
            if relation.relation_type == "broader_than":
                children[relation.source_id].append(relation.target_id)
                parents[relation.target_id].add(relation.source_id)
        roots = sorted(node_id for node_id in nodes if not parents[node_id])
        lines = ["# Knowledge Tree", "", "The same node may appear under multiple parents.", ""]

        def render(node_id: str, depth: int, path: set[str]) -> None:
            node = nodes[node_id]
            indent = "  " * depth
            lines.append(
                f"{indent}- {node.title} — {node.semantic_role}; "
                f"{node.knowledge_level}; interest={node.interest_level} (`{node.id}`)"
            )
            if node_id in path:
                lines.append(f"{indent}  - cycle suppressed")
                return
            next_path = path | {node_id}
            for child_id in sorted(children.get(node_id, []), key=lambda item: nodes[item].title):
                render(child_id, depth + 1, next_path)

        for root_id in sorted(roots, key=lambda item: nodes[item].title):
            render(root_id, 0, set())
        (root / "knowledge-tree.md").write_text(
            "\n".join(lines).rstrip() + "\n",
            encoding="utf-8",
        )

    def _write_grouped_knowledge(self, root: Path, field: str, filename: str) -> None:
        title = "Knowledge by Level" if field == "knowledge_level" else "Knowledge by Interest"
        groups: dict[str, list[Any]] = defaultdict(list)
        for loaded in self.store.active_knowledge():
            value = getattr(loaded.record, field, None)
            if value is not None:
                groups[str(value)].append(loaded.record)
        lines = [f"# {title}", ""]
        for value in sorted(groups):
            lines.extend([f"## {value}", ""])
            for record in sorted(groups[value], key=lambda item: item.title):
                lines.append(f"- {record.title} (`{record.id}`, {record.entity_type})")
            lines.append("")
        (root / filename).write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    def _write_tag_view(self, root: Path) -> None:
        tags = {tag.id: tag for tag in self.store.of_type(Tag, active_only=False)}
        tagged: dict[str, list[Any]] = defaultdict(list)
        for loaded in self.store.active_knowledge():
            for tag_id in loaded.record.tags:
                tagged[tag_id].append(loaded.record)
        lines = ["# Knowledge by Tag", ""]
        for tag_id, records in sorted(tagged.items(), key=lambda item: tags[item[0]].label):
            tag = tags[tag_id]
            lines.extend([f"## {tag.label}", "", f"`{tag.namespace}:{tag.slug}`", ""])
            for record in sorted(records, key=lambda item: item.title):
                lines.append(f"- {record.title} (`{record.id}`)")
            lines.append("")
        (root / "by-tag.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

    def _write_courses_and_materials(self, root: Path) -> None:
        lines = ["# Courses", ""]
        for course in self.store.of_type(Course, active_only=True):
            lines.append(
                f"- {course.title} — {course.knowledge_level}; interest={course.interest_level} (`{course.id}`)"
            )
            if course.description:
                lines.append(f"  - Description: {course.description}")
            if course.syllabus:
                lines.extend(
                    [
                        "  - Syllabus:",
                        *[f"    {line}" for line in course.syllabus.splitlines()],
                    ]
                )
        (root / "courses.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

        preference_order = ["favorite", "liked", "neutral", "disliked", "unspecified"]
        materials = self.store.of_type(Material, active_only=True)
        lines = ["# Materials", ""]
        authored = [item for item in materials if "authored" in item.user_relationships]
        if authored:
            lines.extend(["## Authored", ""])
            for material in authored:
                lines.append(self._material_summary_line(material))
            lines.append("")
        for preference_level in preference_order:
            selected = [
                item
                for item in materials
                if item.preference_level == preference_level and item not in authored
            ]
            if not selected:
                continue
            lines.extend([f"## {preference_level}", ""])
            for material in selected:
                lines.append(self._material_summary_line(material))
            lines.append("")
        (root / "materials.md").write_text(
            "\n".join(lines).rstrip() + "\n", encoding="utf-8"
        )

        material_root = root / "materials"
        material_root.mkdir(parents=True, exist_ok=True)
        for loaded in self.store.loaded_of_type(Material, active_only=True):
            material = loaded.record
            assert isinstance(material, Material)
            self._write_material_detail(material_root, material, loaded.body)

    def _material_summary_line(self, material: Material) -> str:
        authors = ", ".join(material.bibliography.authors) or "Unknown author"
        year = material.bibliography.published_at or "Unknown date"
        relationships = ", ".join(material.user_relationships)
        knowledge = {
            item.id: item for item in self.store.of_type(KnowledgeNode, active_only=True)
        }
        relations = [
            item
            for item in self.store.of_type(Relation, active_only=True)
            if item.source_id == material.id and item.relation_type == "covers"
        ]
        topics = ", ".join(
            knowledge[item.target_id].title
            for item in relations
            if item.knowledge_role in {"topic", "problem"}
        )
        methods = ", ".join(
            knowledge[item.target_id].title
            for item in relations
            if item.knowledge_role == "method"
        )
        line = (
            f"- [{material.title}](materials/{material.id}.md) — {authors}; {year}; "
            f"{relationships}; {material.knowledge_level}; {material.preference_level} "
            f"(`{material.id}`)"
        )
        qualifiers = []
        if topics:
            qualifiers.append(f"topics={topics}")
        if methods:
            qualifiers.append(f"methods={methods}")
        if qualifiers:
            line += f"; {'; '.join(qualifiers)}"
        return line

    def _write_material_detail(self, root: Path, material: Material, body: str) -> None:
        tags = {item.id: item for item in self.store.of_type(Tag, active_only=False)}
        knowledge = {
            item.id: item for item in self.store.of_type(KnowledgeNode, active_only=True)
        }
        relations = [
            item
            for item in self.store.of_type(Relation, active_only=True)
            if item.source_id == material.id and item.relation_type == "covers"
        ]
        manifest = self.store.sources[material.source_ref]
        evidence = {
            loaded.record.id: loaded
            for loaded in self.store.loaded_of_type(Evidence, active_only=True)
        }
        identifiers = material.bibliography.identifiers
        lines = [
            f"# {material.title}",
            "",
            material.summary or "No summary recorded.",
            "",
            "## Abstract",
            "",
            material.abstract or "No source abstract recorded.",
            "",
            "## Bibliography",
            "",
            f"- Type: `{material.material_type}`",
            f"- Authors: {', '.join(material.bibliography.authors) or 'Unknown'}",
            f"- Published: {material.bibliography.published_at or 'Unknown'}",
            f"- Venue: {material.bibliography.venue or 'Unknown'}",
            f"- Language: {material.bibliography.language or 'Unknown'}",
            f"- arXiv: {identifiers.arxiv or 'None'}",
            f"- DOI: {identifiers.doi or 'None'}",
            f"- ISBN: {identifiers.isbn or 'None'}",
            f"- Canonical URL: {material.bibliography.canonical_url or 'None'}",
            "",
            "## My Reading",
            "",
            f"- Relationships: {', '.join(material.user_relationships)}",
            f"- Understanding: `{material.knowledge_level}`",
            f"- Preference: `{material.preference_level}`",
            f"- Scope: {material.scope_note or 'Not specified'}",
            "",
            "## Preference Reasons",
            "",
        ]
        if material.preference_reasons:
            lines.extend(
                f"- **{item.aspect}** — {item.note}"
                for item in material.preference_reasons
            )
        else:
            lines.append("No preference reasons recorded.")
        lines.extend(["", "## Knowledge Connections", ""])
        if relations:
            for relation in sorted(
                relations,
                key=lambda item: (
                    item.knowledge_role or "",
                    item.salience or "",
                    knowledge[item.target_id].title,
                ),
            ):
                node = knowledge[relation.target_id]
                lines.append(
                    f"- **{node.title}** — {relation.knowledge_role}; "
                    f"{relation.salience}: {relation.statement} (`{relation.id}`)"
                )
                if relation.evidence_refs:
                    for evidence_id in relation.evidence_refs:
                        loaded_evidence = evidence[evidence_id]
                        item = loaded_evidence.record
                        assert isinstance(item, Evidence)
                        lines.append(
                            f"  - Evidence `{item.id}` from `{item.source_id}` at "
                            f"`{json.dumps(item.locator, ensure_ascii=False, sort_keys=True)}`"
                        )
                        excerpt = loaded_evidence.body.strip()
                        if excerpt:
                            for excerpt_line in excerpt[:500].splitlines():
                                lines.append(
                                    f"    > {excerpt_line}" if excerpt_line else "    >"
                                )
        else:
            lines.append("No confirmed knowledge connections.")
        lines.extend(
            [
                "",
                "## Tags",
                "",
                ", ".join(tags[item].label for item in material.tags) or "No tags.",
                "",
                "## Personal Notes",
                "",
                body or "No personal notes.",
                "",
                "## Source",
                "",
                f"- Source ID: `{manifest.id}`",
                f"- Original: `sources/{manifest.id}/{manifest.canonical_file}`",
                f"- Provider: {manifest.origin.provider}",
                f"- Version: {manifest.origin.version or 'Unknown'}",
                f"- URL: {manifest.origin.url or 'None'}",
                f"- Content hash: `sha256:{manifest.content_hash}`",
                "- Files:",
                *(
                    f"  - `{item.path}` — {item.role}; {item.media_type}; "
                    f"sha256:{item.sha256}"
                    for item in manifest.files
                ),
                "",
                "## Record",
                "",
                f"- ID: `{material.id}`",
                f"- Revision: `{material.revision}`",
                f"- Updated: `{_iso_utc(material.updated_at)}`",
            ]
        )
        (root / f"{material.id}.md").write_text(
            "\n".join(lines).rstrip() + "\n", encoding="utf-8"
        )

    def _write_preferences_view(self, root: Path) -> None:
        lines = ["# Preferences", "", "## Contexts", ""]
        contexts = {
            context.id: context
            for context in self.store.of_type(PreferenceContext, active_only=False)
            if context.status != "archived"
        }
        if contexts:
            for context in sorted(contexts.values(), key=lambda item: item.name):
                lines.append(
                    f"- **{context.name}** — `{context.key}`; {context.description or 'No description.'}"
                )
        else:
            lines.append("No custom contexts.")

        lines.extend(["", "## Preferences", ""])
        preferences = [
            item
            for item in self.store.of_type(Preference, active_only=False)
            if item.status != "archived"
        ]
        for preference in preferences:
            scope = (
                "All tasks"
                if preference.scope == "global"
                else ", ".join(
                    contexts[item].name
                    for item in preference.context_refs
                    if item in contexts
                )
            )
            lines.extend(
                [
                    f"### {preference.instruction}",
                    "",
                    f"- Behavior: `{preference.behavior}`",
                    f"- Scope: {scope}",
                    f"- Status: `{preference.status}`",
                    f"- Condition: {preference.condition or 'Always'}",
                    f"- Rationale: {preference.rationale or 'Not recorded'}",
                ]
            )
        if not preferences:
            lines.append("No preferences.")

        lines.extend(["", "## Reference Examples", ""])
        examples = [
            loaded
            for loaded in self.store.loaded_of_type(PreferenceExample, active_only=False)
            if loaded.record.status != "archived"
        ]
        for loaded in examples:
            example = loaded.record
            assert isinstance(example, PreferenceExample)
            manifest = self.store.sources[example.source_ref]
            context_names = [
                contexts[context_id].name
                for context_id in example.context_refs
                if context_id in contexts
            ]
            lines.append(
                f"- **{example.title}** — `{example.example_type}`; "
                f"contexts={', '.join(context_names)}; "
                f"file=`{manifest.origin.identifier or manifest.canonical_file}`; "
                f"status=`{example.status}` (`{example.id}`)"
            )
        if not examples:
            lines.append("No reference examples.")
        (root / "preferences.md").write_text(
            "\n".join(lines).rstrip() + "\n",
            encoding="utf-8",
        )

    def _publish_generated(self, stage: Path) -> None:
        final = self.data_root / "generated"
        backup = self.data_root / ".generated.previous"
        if backup.exists():
            shutil.rmtree(backup)
        try:
            if final.exists():
                os.replace(final, backup)
            os.replace(stage, final)
        except Exception:
            if not final.exists() and backup.exists():
                os.replace(backup, final)
            raise
        else:
            if backup.exists():
                shutil.rmtree(backup)
