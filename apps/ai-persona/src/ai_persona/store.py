from __future__ import annotations

import hashlib
import tomllib
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, TypeVar

from pydantic import ValidationError

from .frontmatter import FrontmatterError, load_markdown_record, load_yaml_file
from .models import (
    BaseRecord,
    Course,
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Record,
    Relation,
    SourceManifest,
    Tag,
    parse_record,
)


class StoreValidationError(ValueError):
    """Raised when the canonical persona records violate a store invariant."""


@dataclass(frozen=True)
class PersonaConfig:
    persona_id: str
    revision: int
    created_at: datetime
    include_human_notes_in_snapshot: bool


@dataclass(frozen=True)
class LoadedRecord:
    record: Record
    body: str
    path: Path


T = TypeVar("T", bound=BaseRecord)


class PersonaStore:
    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.records: dict[str, LoadedRecord] = {}
        self.sources: dict[str, SourceManifest] = {}
        self.config: PersonaConfig | None = None

    def load(self, *, verify_source_files: bool = True) -> PersonaStore:
        self.config = self._load_config()
        self.sources = self._load_sources(verify_files=verify_source_files)
        self.records = self._load_records()
        self.validate(verify_source_files=verify_source_files)
        return self

    def _load_config(self) -> PersonaConfig:
        path = self.data_root / "config" / "persona.toml"
        if not path.is_file():
            raise StoreValidationError(f"missing persona config: {path}")
        try:
            raw = tomllib.loads(path.read_text(encoding="utf-8"))
            section = raw["persona"]
            persona_id = str(section["id"])
            revision = int(section["revision"])
            raw_created_at = section.get("created_at", "1970-01-01T00:00:00Z")
            if isinstance(raw_created_at, datetime):
                created_at = raw_created_at
            else:
                created_at = datetime.fromisoformat(
                    str(raw_created_at).replace("Z", "+00:00")
                )
            include_notes = bool(section.get("include_human_notes_in_snapshot", True))
        except (KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as exc:
            raise StoreValidationError(f"invalid persona config: {path}: {exc}") from exc
        if not persona_id or revision < 1:
            raise StoreValidationError("persona id must be non-empty and revision must be positive")
        if created_at.tzinfo is None:
            raise StoreValidationError("persona created_at must include a timezone")
        return PersonaConfig(
            persona_id,
            revision,
            created_at.astimezone(timezone.utc),
            include_notes,
        )

    def _load_sources(self, *, verify_files=True) -> dict[str, SourceManifest]:
        sources_root = self.data_root / "sources"
        result: dict[str, SourceManifest] = {}
        if not sources_root.exists():
            return result
        for path in sorted(sources_root.glob("*/manifest.yaml")):
            try:
                manifest = SourceManifest.model_validate(load_yaml_file(path))
            except (FrontmatterError, ValidationError) as exc:
                raise StoreValidationError(f"invalid source manifest {path}: {exc}") from exc
            if manifest.id in result:
                raise StoreValidationError(f"duplicate source id: {manifest.id}")
            if path.parent.name != manifest.id:
                raise StoreValidationError(
                    f"source directory {path.parent.name!r} must match id {manifest.id!r}"
                )
            self._verify_source_files(path.parent, manifest, verify_contents=verify_files)
            result[manifest.id] = manifest
        return result

    def _verify_source_files(self, source_root: Path, manifest: SourceManifest,
                             *, verify_contents=True) -> None:
        if len({item.path for item in manifest.files}) != len(manifest.files):
            raise StoreValidationError(f"source {manifest.id}: duplicate file paths")
        declared: dict[str, str] = {item.path: item.sha256 for item in manifest.files}
        if manifest.canonical_file not in declared:
            raise StoreValidationError(
                f"source {manifest.id}: canonical_file must be listed in files"
            )
        for relative_path, expected_hash in declared.items():
            path = (source_root / relative_path).resolve()
            try:
                path.relative_to(source_root.resolve())
            except ValueError as exc:
                raise StoreValidationError(
                    f"source {manifest.id}: file escapes source directory: {relative_path}"
                ) from exc
            if not verify_contents:
                continue
            if not path.is_file():
                raise StoreValidationError(f"source {manifest.id}: missing file {relative_path}")
            actual_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual_hash != expected_hash:
                raise StoreValidationError(
                    f"source {manifest.id}: hash mismatch for {relative_path}"
                )
        if manifest.content_hash != declared[manifest.canonical_file]:
            raise StoreValidationError(
                f"source {manifest.id}: content_hash must match the canonical file hash"
            )
        original_files = [item for item in manifest.files if item.role == "original"]
        if len(original_files) != 1:
            raise StoreValidationError(
                f"source {manifest.id}: exactly one original file is required"
            )
        if original_files[0].path != manifest.canonical_file:
            raise StoreValidationError(
                f"source {manifest.id}: canonical_file must be the original file"
            )

    def source_file_path(self, source_id: str, relative_path: str) -> Path:
        """Resolve one manifest-declared source file without allowing path escape."""

        manifest = self.sources.get(source_id)
        if manifest is None:
            raise StoreValidationError(f"unknown source id: {source_id}")
        declared = {item.path for item in manifest.files}
        if relative_path not in declared:
            raise StoreValidationError(
                f"source {source_id}: undeclared file {relative_path}"
            )
        source_root = (self.data_root / "sources" / source_id).resolve()
        path = (source_root / relative_path).resolve()
        try:
            path.relative_to(source_root)
        except ValueError as exc:
            raise StoreValidationError(
                f"source {source_id}: file escapes source directory: {relative_path}"
            ) from exc
        if not path.is_file():
            raise StoreValidationError(f"source {source_id}: missing file {relative_path}")
        return path

    def _load_records(self) -> dict[str, LoadedRecord]:
        records_root = self.data_root / "records"
        if not records_root.is_dir():
            raise StoreValidationError(f"missing records directory: {records_root}")
        result: dict[str, LoadedRecord] = {}
        for path in sorted(records_root.rglob("*.md")):
            try:
                raw, body = load_markdown_record(path)
                record = parse_record(raw)
            except (FrontmatterError, ValidationError, ValueError) as exc:
                raise StoreValidationError(f"invalid record {path}: {exc}") from exc
            if record.id in result:
                raise StoreValidationError(
                    f"duplicate record id {record.id!r}: {result[record.id].path} and {path}"
                )
            result[record.id] = LoadedRecord(record=record, body=body, path=path)
        return result

    def validate(self, *, verify_source_files=True) -> None:
        errors: list[str] = []
        record_values = [loaded.record for loaded in self.records.values()]
        tags = {record.id: record for record in record_values if isinstance(record, Tag)}
        evidence = {
            record.id: record for record in record_values if isinstance(record, Evidence)
        }
        contexts = {
            record.id: record
            for record in record_values
            if isinstance(record, PreferenceContext)
        }
        preferences = {
            record.id: record for record in record_values if isinstance(record, Preference)
        }
        material_identifiers: dict[tuple[str, str], str] = {}
        material_source_hashes: dict[str, str] = {}
        tag_keys: dict[tuple[str, str], str] = {}

        for tag in tags.values():
            key = (tag.namespace.strip().casefold(), tag.slug.strip().casefold())
            other_id = tag_keys.get(key)
            if other_id:
                errors.append(
                    f"{tag.id}: tag namespace and slug already used by {other_id}"
                )
            else:
                tag_keys[key] = tag.id

        for loaded in self.records.values():
            record = loaded.record
            for tag_id in getattr(record, "tags", []):
                if tag_id not in tags:
                    errors.append(f"{record.id}: unknown tag ref {tag_id}")
            for evidence_id in getattr(record, "evidence_refs", []):
                if evidence_id not in evidence:
                    errors.append(f"{record.id}: unknown evidence ref {evidence_id}")

            if isinstance(record, Material) and record.source_ref not in self.sources:
                errors.append(f"{record.id}: unknown source ref {record.source_ref}")
            if isinstance(record, Material) and record.status == "active":
                source = self.sources.get(record.source_ref)
                if source is not None:
                    if source.source_type not in {record.material_type, "task_attachment"}:
                        errors.append(
                            f"{record.id}: source type {source.source_type!r} does not match "
                            f"material type {record.material_type!r}"
                        )
                    other_id = material_source_hashes.get(source.content_hash)
                    if other_id:
                        errors.append(
                            f"{record.id}: source content already used by {other_id}"
                        )
                    else:
                        material_source_hashes[source.content_hash] = record.id
                identifiers = record.bibliography.identifiers.model_dump()
                for identifier_type, raw_value in identifiers.items():
                    if not raw_value:
                        continue
                    value = str(raw_value).strip().casefold()
                    key = (identifier_type, value)
                    other_id = material_identifiers.get(key)
                    if other_id:
                        errors.append(
                            f"{record.id}: {identifier_type} {raw_value!r} already used by "
                            f"{other_id}"
                        )
                    else:
                        material_identifiers[key] = record.id
            if isinstance(record, Evidence):
                manifest = self.sources.get(record.source_id)
                if manifest is None:
                    errors.append(f"{record.id}: unknown source id {record.source_id}")
                elif record.source_hash != f"sha256:{manifest.content_hash}":
                    errors.append(f"{record.id}: source_hash does not match source manifest")
                elif "line_start" in record.locator or "line_end" in record.locator:
                    line_start = record.locator.get("line_start")
                    line_end = record.locator.get("line_end")
                    locator_file = record.locator.get("file") or manifest.canonical_file
                    source_file = next(
                        (item for item in manifest.files if item.path == locator_file), None
                    )
                    if not isinstance(line_start, int) or not isinstance(line_end, int):
                        errors.append(
                            f"{record.id}: line locator requires integer line_start and line_end"
                        )
                    elif line_start < 1 or line_end < line_start:
                        errors.append(f"{record.id}: invalid evidence line range")
                    elif source_file is None:
                        errors.append(
                            f"{record.id}: locator file is not declared by source manifest"
                        )
                    elif verify_source_files and source_file.media_type.startswith("text/"):
                        source_path = (
                            self.data_root / "sources" / manifest.id / source_file.path
                        )
                        line_count = len(
                            source_path.read_text(
                                encoding="utf-8", errors="replace"
                            ).splitlines()
                        )
                        if line_end > line_count:
                            errors.append(
                                f"{record.id}: evidence line range exceeds {line_count} lines"
                            )
                for supported_id in record.supports:
                    if supported_id not in self.records:
                        errors.append(f"{record.id}: supports unknown record {supported_id}")
            if isinstance(record, Preference):
                for context_id in record.context_refs:
                    context = contexts.get(context_id)
                    if context is None:
                        errors.append(f"{record.id}: unknown preference context {context_id}")
                    elif record.status != "archived" and context.status == "archived":
                        errors.append(
                            f"{record.id}: active or paused preference uses archived context "
                            f"{context_id}"
                        )
            if isinstance(record, PreferenceExample):
                if loaded.body.strip():
                    errors.append(f"{record.id}: preference example body must be empty")
                for context_id in record.context_refs:
                    context = contexts.get(context_id)
                    if context is None:
                        errors.append(f"{record.id}: unknown preference context {context_id}")
                    elif record.status != "archived" and context.status == "archived":
                        errors.append(
                            f"{record.id}: active or paused example uses archived context "
                            f"{context_id}"
                        )
                source = self.sources.get(record.source_ref)
                if source is None:
                    errors.append(f"{record.id}: unknown source ref {record.source_ref}")
                elif record.content_hash != f"sha256:{source.content_hash}":
                    errors.append(
                        f"{record.id}: content_hash does not match source manifest"
                    )

        errors.extend(self._validate_relations())
        errors.extend(self._validate_preference_layout(contexts, preferences))
        if errors:
            raise StoreValidationError("canonical store validation failed:\n- " + "\n- ".join(errors))

    def _validate_relations(self) -> list[str]:
        errors: list[str] = []
        seen: set[tuple[str, str, str, str | None]] = set()
        for relation in self.of_type(Relation):
            source = self.records.get(relation.source_id)
            target = self.records.get(relation.target_id)
            if source is None:
                errors.append(f"{relation.id}: unknown source endpoint {relation.source_id}")
                continue
            if target is None:
                errors.append(f"{relation.id}: unknown target endpoint {relation.target_id}")
                continue
            role_key = relation.knowledge_role if relation.relation_type == "covers" else None
            key = (
                relation.source_id,
                relation.relation_type,
                relation.target_id,
                role_key,
            )
            if relation.status == "active" and key in seen:
                errors.append(f"{relation.id}: duplicate active relation {key}")
            if relation.status == "active":
                seen.add(key)

            source_record = source.record
            target_record = target.record
            if relation.relation_type in {
                "broader_than",
                "part_of",
                "applied_in",
                "requires",
            } and not (
                isinstance(source_record, KnowledgeNode)
                and isinstance(target_record, KnowledgeNode)
            ):
                errors.append(
                    f"{relation.id}: {relation.relation_type} requires knowledge_node endpoints"
                )
            if relation.relation_type == "covers" and not (
                isinstance(source_record, (Course, Material))
                and isinstance(target_record, KnowledgeNode)
            ):
                errors.append(
                    f"{relation.id}: covers requires course/material -> knowledge_node"
                )
            if relation.relation_type == "covers" and isinstance(
                source_record, Material
            ) and isinstance(target_record, KnowledgeNode):
                if not all(
                    (relation.knowledge_role, relation.salience, relation.statement)
                ):
                    errors.append(
                        f"{relation.id}: material covers relations require knowledge_role, "
                        "salience, and statement"
                    )
                elif relation.statement and relation.statement.strip().casefold() in {
                    target_record.title.strip().casefold(),
                    *(alias.strip().casefold() for alias in target_record.aliases),
                }:
                    errors.append(
                        f"{relation.id}: statement must explain more than the target title"
                    )
            if relation.relation_type == "covers" and isinstance(source_record, Course):
                if any(
                    item is not None
                    for item in (
                        relation.knowledge_role,
                        relation.salience,
                        relation.statement,
                    )
                ):
                    errors.append(
                        f"{relation.id}: course covers relations do not use material qualifiers"
                    )
            if relation.status == "active" and (
                source_record.status != "active" or target_record.status != "active"
            ):
                errors.append(f"{relation.id}: active relations require active endpoints")
        cycle = self._broader_cycle()
        if cycle:
            errors.append("broader_than graph contains a cycle: " + " -> ".join(cycle))
        return errors

    def _validate_preference_layout(
        self,
        contexts: dict[str, PreferenceContext],
        preferences: dict[str, Preference],
    ) -> list[str]:
        errors: list[str] = []
        keys: dict[str, str] = {}
        for context in contexts.values():
            other_id = keys.get(context.key)
            if context.status != "archived" and other_id:
                errors.append(
                    f"{context.id}: context key {context.key!r} already used by {other_id}"
                )
            if context.status != "archived":
                keys[context.key] = context.id

        signatures: dict[tuple[str, tuple[str, ...]], str] = {}
        for preference in preferences.values():
            if preference.status == "archived":
                continue
            signature = (
                " ".join(preference.instruction.split()).casefold(),
                tuple(sorted(preference.context_refs))
                if preference.scope == "contexts"
                else ("global",),
            )
            other_id = signatures.get(signature)
            if other_id:
                errors.append(
                    f"{preference.id}: duplicate preference in the same scope as {other_id}"
                )
            else:
                signatures[signature] = preference.id
        return errors

    def _broader_cycle(self) -> list[str] | None:
        adjacency: dict[str, list[str]] = defaultdict(list)
        for relation in self.of_type(Relation, active_only=True):
            if relation.relation_type == "broader_than":
                adjacency[relation.source_id].append(relation.target_id)
        visiting: set[str] = set()
        visited: set[str] = set()
        stack: list[str] = []

        def visit(node: str) -> list[str] | None:
            if node in visiting:
                start = stack.index(node)
                return stack[start:] + [node]
            if node in visited:
                return None
            visiting.add(node)
            stack.append(node)
            for child in sorted(adjacency.get(node, [])):
                cycle = visit(child)
                if cycle:
                    return cycle
            stack.pop()
            visiting.remove(node)
            visited.add(node)
            return None

        for node in sorted(adjacency):
            cycle = visit(node)
            if cycle:
                return cycle
        return None

    def relation_closure(self) -> list[tuple[str, str, int]]:
        adjacency: dict[str, list[str]] = defaultdict(list)
        for relation in self.of_type(Relation, active_only=True):
            if relation.relation_type == "broader_than":
                adjacency[relation.source_id].append(relation.target_id)
        closure: list[tuple[str, str, int]] = []
        for ancestor in sorted(adjacency):
            distances: dict[str, int] = {}
            queue: deque[tuple[str, int]] = deque((child, 1) for child in adjacency[ancestor])
            while queue:
                descendant, distance = queue.popleft()
                old_distance = distances.get(descendant)
                if old_distance is not None and old_distance <= distance:
                    continue
                distances[descendant] = distance
                queue.extend((child, distance + 1) for child in adjacency.get(descendant, []))
            closure.extend(
                (ancestor, descendant, distance)
                for descendant, distance in sorted(distances.items())
            )
        return sorted(closure)

    def of_type(self, model: type[T], *, active_only: bool = False) -> list[T]:
        values: list[T] = []
        for loaded in self.records.values():
            if isinstance(loaded.record, model):
                if active_only and loaded.record.status != "active":
                    continue
                values.append(loaded.record)
        return sorted(values, key=lambda item: item.id)

    def loaded_of_type(
        self,
        model: type[T],
        *,
        active_only: bool = False,
    ) -> list[LoadedRecord]:
        result = [
            loaded
            for loaded in self.records.values()
            if isinstance(loaded.record, model)
            and (not active_only or loaded.record.status == "active")
        ]
        return sorted(result, key=lambda loaded: loaded.record.id)

    def active_knowledge(self) -> Iterable[LoadedRecord]:
        for model in (KnowledgeNode, Course, Material):
            yield from self.loaded_of_type(model, active_only=True)
