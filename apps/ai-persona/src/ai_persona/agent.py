from __future__ import annotations

import base64
import hashlib
import json
import unicodedata
import uuid
from collections import defaultdict, deque
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import to_jsonable_python

from .change_sets import (
    ChangeSetError,
    ChangeSetLink,
    ChangeSetManifest,
    ChangeSetRepository,
    DependencyGroup,
    proposal_lock,
)
from .index import rank_knowledge_ids
from .models import (
    Course,
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    ProposalContext,
    ProposalEvidenceCandidate,
    ProposalPatch,
    Relation,
    Tag,
)
from .proposals import ProposalError, ProposalRepository, ProposalService
from .store import LoadedRecord, PersonaStore

KnowledgeEntityType = Literal["knowledge_node", "course", "material"]
ProposalEntityType = Literal[
    "knowledge_node",
    "course",
    "material",
    "tag",
    "relation",
    "evidence",
    "preference_context",
    "preference",
    "preference_example",
]
ProposalOperation = Literal["create", "update", "archive", "restore", "relate", "unrelate"]


class AgentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentServiceError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details or {}


class ErrorDetail(AgentModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class MCPErrorResult(AgentModel):
    ok: Literal[False] = False
    schema_version: Literal["ai-persona.mcp-error/v1"] = "ai-persona.mcp-error/v1"
    request_id: str
    error: ErrorDetail


class TagScope(AgentModel):
    """None means legacy unrestricted queries; an explicit empty scope matches nothing."""

    tag_ids: list[str] = Field(max_length=100)
    tag_match: Literal["all", "any"] = "all"

    @field_validator("tag_ids")
    @classmethod
    def normalize_ids(cls, values: list[str]) -> list[str]:
        if any(not value or len(value) > 200 for value in values):
            raise ValueError("Tag IDs must be nonempty and at most 200 characters")
        return sorted(set(values))


class ContextCoverage(AgentModel):
    scope_record_count: int
    matched_count: int
    returned_count: int
    omission_reasons: list[str] = Field(default_factory=list)


class TagResult(AgentModel):
    id: str
    label: str
    slug: str
    aliases: list[str]
    namespace: str
    revision: int
    match_kind: Literal["exact", "partial"] | None = None


class ListTagsResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.tags/v1"] = "ai-persona.tags/v1"
    persona_revision: int
    request_id: str
    tags: list[TagResult]
    total_count: int
    next_cursor: str | None = None


class MaterialSourceSummary(AgentModel):
    source_id: str
    source_hash: str
    has_text: bool


class BudgetResult(AgentModel):
    max_chars: int
    used_chars: int
    truncated: bool
    next_cursor: str | None = None


class ContextMatchResult(AgentModel):
    id: str
    key: str
    name: str
    match_reasons: list[str]


class RelationHintResult(AgentModel):
    relation_id: str
    relation_type: str
    other_id: str
    direction: Literal["incoming", "outgoing"]


class EvidenceResult(AgentModel):
    id: str
    source_id: str
    source_hash: str
    locator: dict[str, str | int | None]
    evidence_kind: str
    confidence: float | None


class KnowledgeResult(AgentModel):
    id: str
    entity_type: KnowledgeEntityType
    title: str
    semantic_role: str | None = None
    knowledge_level: str
    interest_level: str | None = None
    preference_level: str | None = None
    abstract: str = ""
    summary: str = ""
    description: str = ""
    syllabus: str = ""
    record_revision: int
    tags: list[str] = Field(default_factory=list)
    user_relationships: list[str] = Field(default_factory=list)
    bibliography: dict[str, Any] | None = None
    material_type: str | None = None
    source: MaterialSourceSummary | None = None
    match_reasons: list[str]
    relation_hints: list[RelationHintResult] = Field(default_factory=list)
    evidence: list[EvidenceResult] = Field(default_factory=list)


class PreferenceResult(AgentModel):
    id: str
    scope: str
    context_refs: list[str]
    behavior: str
    instruction: str
    condition: str
    condition_status: Literal["applicable", "unknown"]
    rationale: str
    record_revision: int
    match_reasons: list[str]


class PreferenceExampleResult(AgentModel):
    id: str
    context_refs: list[str]
    example_type: str
    title: str
    condition: str
    reasons: list[str]
    source_ref: str
    content_hash: str
    record_revision: int


class UnknownResult(AgentModel):
    subject: str
    reason: str


class GuidanceResult(AgentModel):
    explanation_depth: Literal[
        "advanced_with_explicit_assumptions",
        "intermediate_with_brief_reminders",
        "detailed_with_background",
        "no_assumption",
    ]


class PrepareContextResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.context/v1"] = "ai-persona.context/v1"
    persona_revision: int
    request_id: str
    matched_contexts: list[ContextMatchResult]
    knowledge: list[KnowledgeResult]
    preferences: list[PreferenceResult]
    examples: list[PreferenceExampleResult]
    unknowns: list[UnknownResult]
    guidance: GuidanceResult
    budget: BudgetResult
    scope: TagScope | None = None
    coverage: ContextCoverage | None = None


class SearchKnowledgeResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.search/v1"] = "ai-persona.search/v1"
    persona_revision: int
    request_id: str
    results: list[KnowledgeResult]
    total_count: int = 0
    scope: TagScope | None = None
    next_cursor: str | None = None


class SearchPreferencesResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.preference-search/v1"] = (
        "ai-persona.preference-search/v1"
    )
    persona_revision: int
    request_id: str
    matched_contexts: list[ContextMatchResult]
    preferences: list[PreferenceResult]
    examples: list[PreferenceExampleResult]
    conflict_notes: list[str]
    budget: BudgetResult
    next_cursor: str | None = None


class PersonaRecordResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.record-result/v1"] = (
        "ai-persona.record-result/v1"
    )
    persona_revision: int
    request_id: str
    record: dict[str, Any]
    relations: list[dict[str, Any]]
    evidence: list[EvidenceResult]
    revision_summary: list[dict[str, Any]]
    truncated: bool
    scope: TagScope | None = None


class MaterialSourceFileResult(AgentModel):
    role: Literal["original", "extracted_text", "attachment"]
    relative_path: str
    path: str
    media_type: str
    sha256: str
    size_bytes: int
    line_count: int | None = None
    evidence_locator: Literal["lines", "unsupported"]
    preferred_for_text: bool = False


class MaterialSourceResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.material-source/v1"] = (
        "ai-persona.material-source/v1"
    )
    persona_revision: int
    request_id: str
    material_id: str
    material_revision: int
    source_id: str
    source_hash: str
    source_type: str
    immutable: Literal[True] = True
    files: list[MaterialSourceFileResult]
    scope: TagScope | None = None


class InlineEvidenceInput(AgentModel):
    source_id: str | None = None
    file: str = Field(min_length=1, max_length=500)
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)
    evidence_kind: Literal[
        "explicit_user_statement",
        "authored_material",
        "read_signal",
        "user_feedback",
        "human_edit",
        "inferred_pattern",
    ]
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    @field_validator("file")
    @classmethod
    def file_is_source_relative(cls, value: str) -> str:
        normalized = value.strip().replace("\\", "/")
        if (
            not normalized
            or normalized.startswith("/")
            or ".." in normalized.split("/")
            or "\0" in normalized
            or (len(normalized) >= 3 and normalized[1:3] == ":/")
        ):
            raise ValueError("file must be a source-relative path")
        return normalized

    @model_validator(mode="after")
    def line_range_is_bounded(self) -> InlineEvidenceInput:
        if self.line_end < self.line_start:
            raise ValueError("line_end must be greater than or equal to line_start")
        if self.line_end - self.line_start + 1 > 500:
            raise ValueError("inline evidence cannot span more than 500 lines")
        return self


class ProposalChangeInput(AgentModel):
    client_ref: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    operation: ProposalOperation
    entity_type: ProposalEntityType
    target_id: str | None = None
    expected_record_revision: int | None = Field(default=None, ge=1)
    values: dict[str, Any] = Field(default_factory=dict)
    reason: str = Field(min_length=1, max_length=4000)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    evidence_refs: list[str] = Field(default_factory=list, max_length=100)
    evidence: list[InlineEvidenceInput] = Field(default_factory=list, max_length=20)
    conflicts: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("reason")
    @classmethod
    def reason_cannot_be_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("reason cannot be blank")
        return normalized

    @model_validator(mode="after")
    def operation_shape_is_valid(self) -> ProposalChangeInput:
        existing_operations = {"update", "archive", "restore", "unrelate"}
        if self.operation in existing_operations:
            if not self.target_id or self.expected_record_revision is None:
                raise ValueError(
                    f"{self.operation} requires target_id and expected_record_revision"
                )
        elif self.target_id is not None or self.expected_record_revision is not None:
            raise ValueError(f"{self.operation} does not accept a target base record")
        if self.operation == "create" and self.entity_type == "relation":
            raise ValueError("relations must use the relate operation")
        if self.operation == "relate" and self.entity_type != "relation":
            raise ValueError("relate requires entity_type=relation")
        if self.operation == "unrelate" and self.entity_type != "relation":
            raise ValueError("unrelate requires entity_type=relation")
        if self.operation in {"create", "update", "relate"} and not self.values:
            raise ValueError(f"{self.operation} requires values")
        if self.operation in {"archive", "restore", "unrelate"} and self.values:
            raise ValueError(f"{self.operation} does not accept values")
        if self.evidence and self.operation not in {"create", "update", "relate"}:
            raise ValueError("inline evidence only supports create, update, and relate")
        if self.evidence and self.entity_type not in {
            "knowledge_node",
            "course",
            "material",
            "relation",
            "preference",
            "preference_context",
            "preference_example",
        }:
            raise ValueError("this entity type cannot own inline evidence")
        return self


class ProposalLinkResult(AgentModel):
    proposal_id: str
    client_ref: str | None = None
    candidate_record_id: str
    operation: str
    entity_type: str
    status: str
    dependencies: list[str] = Field(default_factory=list)
    duplicate_candidates: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)
    published_persona_revision: int | None = None


class ProposeChangeSetResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.proposal-submit/v1"] = (
        "ai-persona.proposal-submit/v1"
    )
    persona_revision: int
    request_id: str
    change_set_id: str
    status: str
    effective_change: Literal[False] = False
    proposals: list[ProposalLinkResult]
    atomic_groups: list[list[str]]
    dependency_groups: list[DependencyGroup]
    warnings: list[str]
    review_url: str


class ProposalStatusResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.proposal-status/v1"] = (
        "ai-persona.proposal-status/v1"
    )
    persona_revision: int
    request_id: str
    change_set_id: str
    status: str
    effective_change: bool
    proposals: list[ProposalLinkResult]
    dependency_groups: list[DependencyGroup]
    review_url: str


class PersonaChangeResult(AgentModel):
    persona_revision: int
    published_at: str
    object_id: str
    entity_type: str | None = None
    operation: str
    old_record_revision: int | None = None
    new_record_revision: int


class PersonaChangesResult(AgentModel):
    ok: Literal[True] = True
    schema_version: Literal["ai-persona.change-list/v1"] = "ai-persona.change-list/v1"
    persona_revision: int
    request_id: str
    from_revision: int
    to_revision: int
    changes: list[PersonaChangeResult]
    next_cursor: str | None = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _request_id() -> str:
    return f"req_{uuid.uuid4().hex}"


def _serialized_chars(value: Any) -> int:
    serializable = to_jsonable_python(value, by_alias=True)
    return len(
        json.dumps(serializable, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def _query_fingerprint(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _encode_cursor(tool: str, revision: int, offset: int, query_hash: str = "") -> str:
    raw = json.dumps(
        {"tool": tool, "revision": revision, "offset": offset, "query_hash": query_hash},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(
    cursor: str | None, *, tool: str, revision: int, query_hash: str = ""
) -> int:
    if not cursor:
        return 0
    try:
        if len(cursor) > 2000:
            raise ValueError
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
        if (
            payload.get("tool") != tool
            or payload.get("revision") != revision
            or payload.get("query_hash") != query_hash
        ):
            raise AgentServiceError(
                "cursor_expired",
                "The cursor belongs to a different query, scope, or persona revision.",
                retryable=True,
            )
        if set(payload) != {"tool", "revision", "offset", "query_hash"}:
            raise ValueError
        if type(payload["offset"]) is not int or payload["offset"] < 0:
            raise ValueError
        return payload["offset"]
    except AgentServiceError:
        raise
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise AgentServiceError("invalid_request", "Invalid pagination cursor.") from exc


_active_query: ContextVar[tuple[object, PersonaStore] | None] = ContextVar(
    "persona_query_snapshot", default=None
)


def _consistent_read(operation):
    @wraps(operation)
    def wrapped(self, *args, **kwargs):
        active = _active_query.get()
        if active is not None and active[0] is self:
            return operation(self, *args, **kwargs)
        # Use the publication lock so records, index and source metadata belong to one revision.
        with proposal_lock(self.state_root):
            token = _active_query.set((self, PersonaStore(self.data_root).load()))
            try:
                return operation(self, *args, **kwargs)
            finally:
                _active_query.reset(token)
    return wrapped


class PersonaQueryService:
    def __init__(self, data_root: Path, state_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.state_root = state_root.resolve()

    def _store(self) -> PersonaStore:
        active = _active_query.get()
        if active is not None and active[0] is self:
            return active[1]
        return PersonaStore(self.data_root).load()

    def _revision(self, store: PersonaStore) -> int:
        assert store.config is not None
        return store.config.revision

    @staticmethod
    def _check_revision(store: PersonaStore, expected: int | None) -> None:
        if expected is None:
            return
        if type(expected) is not int or expected < 1:
            raise AgentServiceError("invalid_request", "Expected revision must be a positive integer.")
        assert store.config is not None
        if store.config.revision != expected:
            raise AgentServiceError(
                "stale_revision", "Persona changed; prepare a new context before reading further.",
                retryable=True,
                details={"expected_revision": expected, "persona_revision": store.config.revision},
            )

    @staticmethod
    def _resolve_scope(
        store: PersonaStore, scope: TagScope | dict[str, Any] | None,
        *, tag_ids: list[str] | None = None, tag_match: str = "all",
    ) -> TagScope | None:
        if scope is not None and tag_ids is not None:
            raise AgentServiceError("invalid_request", "Use scope or legacy tag_ids, not both.")
        if tag_match not in {"all", "any"}:
            raise AgentServiceError("invalid_request", "tag_match must be all or any.")
        if scope is not None:
            resolved = TagScope.model_validate(scope)
        elif tag_ids:
            resolved = TagScope(tag_ids=tag_ids, tag_match=tag_match)
        else:
            # Preserve the legacy meaning of omitted/empty top-level tag_ids.
            return None
        known = {tag.id for tag in store.of_type(Tag, active_only=True)}
        missing = set(resolved.tag_ids) - known
        if missing:
            raise AgentServiceError(
                "invalid_reference", "One or more tag filters do not identify active Tags.",
                details={"unknown_tag_ids": sorted(missing)},
            )
        return resolved

    @staticmethod
    def _scope_records(store: PersonaStore, scope: TagScope | None) -> set[str]:
        records = store.active_knowledge()
        if scope is None:
            return {item.record.id for item in records}
        selected = set(scope.tag_ids)
        if not selected:
            return set()
        return {
            item.record.id for item in records
            if (selected <= set(item.record.tags) if scope.tag_match == "all"
                else bool(selected & set(item.record.tags)))
        }

    @staticmethod
    def _scope_sources(store: PersonaStore, allowed_ids: set[str]) -> set[str]:
        return {
            item.source_ref for item in store.of_type(Material, active_only=True)
            if item.id in allowed_ids
        }

    @staticmethod
    def _require_scoped_record(record_id: str, allowed_ids: set[str] | None) -> None:
        if allowed_ids is not None and record_id not in allowed_ids:
            raise AgentServiceError("out_of_scope", "Record is outside the selected tag scope.")

    @staticmethod
    def _check_record_revision(record, expected: int | None) -> None:
        if expected is not None and (type(expected) is not int or expected < 1):
            raise AgentServiceError("invalid_request", "Expected record revision must be a positive integer.")
        if expected is not None and record.revision != expected:
            raise AgentServiceError(
                "stale_record", "Record changed; refresh the selected context.", retryable=True,
                details={"record_id": record.id, "record_revision": record.revision},
            )

    @_consistent_read
    def list_tags(
        self, *, query: str = "", namespace: str | None = "domain", limit: int = 50,
        cursor: str | None = None, expected_persona_revision: int | None = None,
    ) -> ListTagsResult:
        store = self._store()
        self._check_revision(store, expected_persona_revision)
        revision = self._revision(store)
        def normalize(value: str) -> str:
            return unicodedata.normalize("NFKC", value).strip().casefold()

        needle = normalize(query)
        category = normalize(namespace) if namespace is not None else None
        fingerprint = _query_fingerprint({"query": needle, "namespace": category})
        offset = _decode_cursor(cursor, tool="list_tags", revision=revision, query_hash=fingerprint)
        matches = []
        for tag in store.of_type(Tag, active_only=True):
            if category is not None and normalize(tag.namespace) != category:
                continue
            names = [normalize(value) for value in [tag.label, tag.slug, *tag.aliases]]
            if needle and not any(needle in value for value in names):
                continue
            matches.append(TagResult(
                id=tag.id, label=tag.label, slug=tag.slug, aliases=tag.aliases,
                namespace=tag.namespace, revision=tag.revision,
                match_kind=("exact" if needle in names else "partial") if needle else None,
            ))
        matches.sort(key=lambda tag: (tag.match_kind == "partial", normalize(tag.label), tag.id))
        limit = max(1, min(limit, 100))
        page = matches[offset:offset + limit]
        return ListTagsResult(
            persona_revision=revision, request_id=_request_id(), tags=page,
            total_count=len(matches),
            next_cursor=_encode_cursor("list_tags", revision, offset + limit, fingerprint)
            if offset + limit < len(matches) else None,
        )

    def _check_index(self, store: PersonaStore) -> None:
        import sqlite3

        database = self.state_root / "persona.sqlite3"
        if not database.is_file():
            raise AgentServiceError(
                "index_unavailable",
                "The persona index does not exist. Run ai-persona build first.",
                retryable=True,
            )
        try:
            connection = sqlite3.connect(database)
            row = connection.execute(
                "SELECT value FROM meta WHERE key='persona_revision'"
            ).fetchone()
        except sqlite3.Error as exc:
            raise AgentServiceError(
                "index_unavailable", "The persona index cannot be read.", retryable=True
            ) from exc
        finally:
            if "connection" in locals():
                connection.close()
        revision = self._revision(store)
        if row is None or int(row[0]) != revision:
            raise AgentServiceError(
                "index_unavailable",
                "The persona index is not at the current persona revision. Run build first.",
                retryable=True,
                details={"persona_revision": revision, "index_revision": row[0] if row else None},
            )

    @staticmethod
    def _relation_hints(
        store: PersonaStore, record_id: str, allowed_ids: set[str] | None = None
    ) -> list[RelationHintResult]:
        hints: list[RelationHintResult] = []
        for relation in store.of_type(Relation, active_only=True):
            if allowed_ids is not None and not {
                relation.source_id, relation.target_id
            } <= allowed_ids:
                continue
            if relation.source_id == record_id:
                hints.append(
                    RelationHintResult(
                        relation_id=relation.id,
                        relation_type=relation.relation_type,
                        other_id=relation.target_id,
                        direction="outgoing",
                    )
                )
            elif relation.target_id == record_id:
                hints.append(
                    RelationHintResult(
                        relation_id=relation.id,
                        relation_type=relation.relation_type,
                        other_id=relation.source_id,
                        direction="incoming",
                    )
                )
        return sorted(hints, key=lambda item: (item.relation_type, item.other_id, item.relation_id))

    @staticmethod
    def _evidence(
        store: PersonaStore, evidence_refs: list[str], allowed_sources: set[str] | None = None
    ) -> list[EvidenceResult]:
        results: list[EvidenceResult] = []
        for evidence_id in evidence_refs:
            loaded = store.records.get(evidence_id)
            if loaded is None or not isinstance(loaded.record, Evidence):
                continue
            evidence = loaded.record
            if allowed_sources is not None and evidence.source_id not in allowed_sources:
                continue
            if evidence.status != "active":
                continue
            results.append(
                EvidenceResult(
                    id=evidence.id,
                    source_id=evidence.source_id,
                    source_hash=evidence.source_hash,
                    locator=evidence.locator,
                    evidence_kind=evidence.evidence_kind,
                    confidence=evidence.confidence,
                )
            )
        return sorted(results, key=lambda item: item.id)

    def _knowledge_result(
        self,
        store: PersonaStore,
        loaded: LoadedRecord,
        *,
        match_reasons: list[str],
        include_evidence: bool,
        allowed_ids: set[str] | None = None,
        allowed_sources: set[str] | None = None,
    ) -> KnowledgeResult:
        record = loaded.record
        assert isinstance(record, (KnowledgeNode, Course, Material))
        manifest = store.sources.get(record.source_ref) if isinstance(record, Material) else None
        return KnowledgeResult(
            id=record.id,
            entity_type=record.entity_type,
            title=record.title,
            semantic_role=record.semantic_role if isinstance(record, KnowledgeNode) else None,
            knowledge_level=record.knowledge_level,
            interest_level=(
                record.interest_level if isinstance(record, (KnowledgeNode, Course)) else None
            ),
            preference_level=record.preference_level if isinstance(record, Material) else None,
            abstract=record.abstract if isinstance(record, Material) else "",
            summary=record.summary if isinstance(record, (KnowledgeNode, Material)) else "",
            description=record.description if isinstance(record, Course) else "",
            syllabus=record.syllabus if isinstance(record, Course) else "",
            record_revision=record.revision,
            tags=record.tags,
            user_relationships=record.user_relationships if isinstance(record, Material) else [],
            bibliography=record.bibliography.model_dump(mode="json")
            if isinstance(record, Material) else None,
            material_type=record.material_type if isinstance(record, Material) else None,
            source=MaterialSourceSummary(
                source_id=manifest.id, source_hash=f"sha256:{manifest.content_hash}",
                has_text=any(file.media_type.startswith("text/") for file in manifest.files),
            ) if manifest else None,
            match_reasons=match_reasons,
            relation_hints=self._relation_hints(store, record.id, allowed_ids),
            evidence=(
                self._evidence(store, list(getattr(record, "evidence_refs", [])), allowed_sources)
                if include_evidence
                else []
            ),
        )

    @staticmethod
    def _related_distances(
        store: PersonaStore, origin_id: str, allowed_ids: set[str] | None = None
    ) -> dict[str, int]:
        distances: dict[str, int] = {}
        adjacency: dict[str, set[str]] = defaultdict(set)
        for relation in store.of_type(Relation, active_only=True):
            if allowed_ids is not None and not {
                relation.source_id, relation.target_id
            } <= allowed_ids:
                continue
            adjacency[relation.source_id].add(relation.target_id)
            adjacency[relation.target_id].add(relation.source_id)
        queue: deque[tuple[str, int]] = deque([(origin_id, 0)])
        while queue:
            node, distance = queue.popleft()
            if node in distances and distances[node] <= distance:
                continue
            distances[node] = distance
            queue.extend((neighbor, distance + 1) for neighbor in sorted(adjacency[node]))
        return distances

    @_consistent_read
    def search_knowledge(
        self, *, query: str = "", entity_types: list[KnowledgeEntityType] | None = None,
        knowledge_levels: list[str] | None = None, interest_levels: list[str] | None = None,
        material_types: list[str] | None = None, tag_ids: list[str] | None = None,
        related_to: str | None = None, max_distance: int = 2, include_evidence: bool = False,
        limit: int = 10, cursor: str | None = None, scope: TagScope | None = None,
        tag_match: Literal["all", "any"] = "all",
        expected_persona_revision: int | None = None,
    ) -> SearchKnowledgeResult:
        if scope is None and not query.strip() and not any(
            (entity_types, knowledge_levels, interest_levels, material_types, tag_ids, related_to)
        ):
            raise AgentServiceError("invalid_filter", "Provide a query or a structured filter.")
        store = self._store()
        self._check_revision(store, expected_persona_revision)
        resolved = self._resolve_scope(store, scope, tag_ids=tag_ids, tag_match=tag_match)
        allowed_ids = self._scope_records(store, resolved)
        scoped_ids = allowed_ids if resolved is not None else None
        allowed_sources = self._scope_sources(store, allowed_ids) if resolved is not None else None
        self._check_index(store)
        revision = self._revision(store)
        fingerprint = _query_fingerprint({
            "query": query.strip(), "entity_types": sorted(set(entity_types or [])),
            "knowledge_levels": sorted(set(knowledge_levels or [])),
            "interest_levels": sorted(set(interest_levels or [])),
            "material_types": sorted(set(material_types or [])),
            "scope": resolved.model_dump() if resolved else None,
            "related_to": related_to, "max_distance": max_distance,
            "include_evidence": include_evidence,
        })
        offset = _decode_cursor(
            cursor, tool="search_knowledge", revision=revision, query_hash=fingerprint
        )
        if related_to:
            self._require_scoped_record(related_to, scoped_ids)
            origin = store.records.get(related_to)
            if origin is None or origin.record.status != "active":
                raise AgentServiceError("invalid_reference", "Unknown active related_to record.")
        distances = self._related_distances(store, related_to, scoped_ids) if related_to else {}
        eligible = {}
        for item in store.active_knowledge():
            record = item.record
            if record.id not in allowed_ids:
                continue
            if entity_types and record.entity_type not in entity_types:
                continue
            if knowledge_levels and record.knowledge_level not in knowledge_levels:
                continue
            if interest_levels and (
                isinstance(record, Material) or record.interest_level not in interest_levels
            ):
                continue
            if material_types and (
                not isinstance(record, Material) or record.material_type not in material_types
            ):
                continue
            if related_to and not (0 < distances.get(record.id, 0) <= max(1, min(max_distance, 10))):
                continue
            eligible[record.id] = item
        try:
            ranked = rank_knowledge_ids(
                self.state_root, query, allowed_ids=set(eligible), expected_revision=revision
            ) if query.strip() else sorted(eligible)
        except ValueError as exc:
            if str(exc) != "index_revision_changed":
                raise
            raise AgentServiceError(
                "index_unavailable", "Index changed during retrieval; retry after rebuilding.",
                retryable=True,
            ) from exc
        limit = max(1, min(limit, 50))
        page = []
        for record_id in ranked[offset:offset + limit]:
            record = eligible[record_id].record
            reasons = ["text_match"] if query.strip() else []
            if entity_types:
                reasons.append(f"entity_type:{record.entity_type}")
            if knowledge_levels:
                reasons.append(f"knowledge_level:{record.knowledge_level}")
            if interest_levels:
                reasons.append(f"interest_level:{record.interest_level}")
            if resolved:
                reasons.extend(f"tag:{tag}" for tag in resolved.tag_ids if tag in record.tags)
            if related_to:
                reasons.append(f"related_to:{related_to}:distance={distances[record_id]}")
            page.append(self._knowledge_result(
                store, eligible[record_id], match_reasons=reasons or ["structured_filter"],
                include_evidence=include_evidence, allowed_ids=scoped_ids,
                allowed_sources=allowed_sources,
            ))
        return SearchKnowledgeResult(
            persona_revision=revision, request_id=_request_id(), results=page,
            total_count=len(ranked), scope=resolved,
            next_cursor=_encode_cursor("search_knowledge", revision, offset + limit, fingerprint)
            if offset + limit < len(ranked) else None,
        )

    @staticmethod
    def _matched_contexts(
        store: PersonaStore,
        *,
        task: str,
        question: str = "",
        context_key: str | None = None,
        artifact_type: str | None = None,
    ) -> tuple[list[ContextMatchResult], list[str]]:
        contexts = store.of_type(PreferenceContext, active_only=True)
        if context_key:
            match = next((item for item in contexts if item.key == context_key), None)
            if match is None:
                return [], [f"Unknown preference context key: {context_key}"]
            return [
                ContextMatchResult(
                    id=match.id,
                    key=match.key,
                    name=match.name,
                    match_reasons=["explicit_context_key"],
                )
            ], []

        haystack = " ".join((task, question)).casefold()
        matches: list[ContextMatchResult] = []
        for context in contexts:
            excludes = [item.casefold() for item in context.activation.excludes if item.strip()]
            if any(item in haystack for item in excludes):
                continue
            reasons: list[str] = []
            if artifact_type and any(
                artifact_type.casefold() == item.casefold()
                for item in context.activation.artifact_types
            ):
                reasons.append(f"artifact_type:{artifact_type}")
            if reasons:
                matches.append(
                    ContextMatchResult(
                        id=context.id,
                        key=context.key,
                        name=context.name,
                        match_reasons=sorted(set(reasons)),
                    )
                )
        notes = []
        if contexts and (task.strip() or question.strip()) and not matches:
            notes.append(
                "Task context needs semantic matching: call resolve_persona_activation, "
                "then pass each matched context_key. Request examples are not trigger keywords."
            )
        return sorted(matches, key=lambda item: item.key), notes

    @staticmethod
    def _preference_result(
        preference: Preference, *, match_reasons: list[str]
    ) -> PreferenceResult:
        return PreferenceResult(
            id=preference.id,
            scope=preference.scope,
            context_refs=preference.context_refs,
            behavior=preference.behavior,
            instruction=preference.instruction,
            condition=preference.condition,
            condition_status="unknown" if preference.condition else "applicable",
            rationale=preference.rationale,
            record_revision=preference.revision,
            match_reasons=match_reasons,
        )

    @staticmethod
    def _example_result(example: PreferenceExample) -> PreferenceExampleResult:
        return PreferenceExampleResult(
            id=example.id,
            context_refs=example.context_refs,
            example_type=example.example_type,
            title=example.title,
            condition=example.condition,
            reasons=example.reasons,
            source_ref=example.source_ref,
            content_hash=example.content_hash,
            record_revision=example.revision,
        )

    @staticmethod
    def _trim_preference_budget(
        preferences: list[PreferenceResult],
        examples: list[PreferenceExampleResult],
        max_chars: int,
    ) -> tuple[list[PreferenceResult], list[PreferenceExampleResult], BudgetResult]:
        max_chars = max(1000, min(max_chars, 50_000))
        kept_preferences = list(preferences)
        kept_examples = list(examples)
        truncated = False
        while kept_examples and _serialized_chars(
            {"preferences": kept_preferences, "examples": kept_examples}
        ) > max_chars:
            kept_examples.pop()
            truncated = True
        while kept_preferences and _serialized_chars(
            {"preferences": kept_preferences, "examples": kept_examples}
        ) > max_chars:
            removable = next(
                (
                    index
                    for index in range(len(kept_preferences) - 1, -1, -1)
                    if kept_preferences[index].behavior != "required"
                ),
                None,
            )
            if removable is None:
                break
            kept_preferences.pop(removable)
            truncated = True
        used = _serialized_chars({"preferences": kept_preferences, "examples": kept_examples})
        return kept_preferences, kept_examples, BudgetResult(
            max_chars=max_chars,
            used_chars=used,
            truncated=truncated or used > max_chars,
        )

    @_consistent_read
    def search_preferences(
        self,
        *,
        task: str = "",
        context_key: str | None = None,
        artifact_type: str | None = None,
        query: str = "",
        behaviors: list[str] | None = None,
        include_examples: bool = False,
        max_chars: int = 5000,
        limit: int = 20,
        cursor: str | None = None,
    ) -> SearchPreferencesResult:
        if not task.strip() and not context_key and not query.strip():
            raise AgentServiceError(
                "invalid_filter", "Provide task, context_key, or query."
            )
        store = self._store()
        revision = self._revision(store)
        matched, conflict_notes = self._matched_contexts(
            store,
            task=task,
            context_key=context_key,
            artifact_type=artifact_type,
        )
        context_ids = {item.id for item in matched}
        query_text = query.strip().casefold()
        behavior_filter = set(behaviors or [])
        context_constrained = bool(task.strip() or context_key or artifact_type)
        preferences: list[PreferenceResult] = []
        behavior_order = {"required": 0, "preferred": 1, "avoid": 2}
        for preference in store.of_type(Preference, active_only=True):
            if behavior_filter and preference.behavior not in behavior_filter:
                continue
            if context_constrained and preference.scope != "global" and not (
                context_ids & set(preference.context_refs)
            ):
                continue
            searchable = " ".join(
                (preference.instruction, preference.condition, preference.rationale)
            ).casefold()
            if query_text and query_text not in searchable:
                continue
            reasons = ["global_scope"] if preference.scope == "global" else [
                f"context:{item.key}" for item in matched if item.id in preference.context_refs
            ]
            if query_text:
                reasons.append("text_match")
            preferences.append(self._preference_result(preference, match_reasons=reasons))
        preferences.sort(key=lambda item: (behavior_order.get(item.behavior, 9), item.id))

        fingerprint = _query_fingerprint({
            "task": task, "context_key": context_key, "artifact_type": artifact_type,
            "query": query_text, "behaviors": sorted(behavior_filter),
            "include_examples": include_examples, "max_chars": max_chars,
        })
        offset = _decode_cursor(
            cursor, tool="search_preferences", revision=revision, query_hash=fingerprint
        )
        limit = max(1, min(limit, 50))
        page = preferences[offset : offset + limit]
        next_cursor = (
            _encode_cursor("search_preferences", revision, offset + limit, fingerprint)
            if offset + limit < len(preferences)
            else None
        )
        examples: list[PreferenceExampleResult] = []
        if include_examples and context_ids:
            examples = [
                self._example_result(item)
                for item in store.of_type(PreferenceExample, active_only=True)
                if context_ids & set(item.context_refs)
            ][:10]
        page, examples, budget = self._trim_preference_budget(page, examples, max_chars)
        return SearchPreferencesResult(
            persona_revision=revision,
            request_id=_request_id(),
            matched_contexts=matched,
            preferences=page,
            examples=examples,
            conflict_notes=conflict_notes,
            budget=budget,
            next_cursor=next_cursor,
        )

    @_consistent_read
    def prepare_persona_context(
        self,
        *,
        task: str,
        question: str = "",
        context_key: str | None = None,
        artifact_type: str | None = None,
        max_chars: int = 8000,
        include_evidence: bool = False,
        scope: TagScope | None = None,
        expected_persona_revision: int | None = None,
        knowledge_limit: int = 8,
    ) -> PrepareContextResult:
        if not task.strip():
            raise AgentServiceError("invalid_request", "task cannot be blank")
        store = self._store()
        self._check_revision(store, expected_persona_revision)
        resolved = self._resolve_scope(store, scope)
        self._check_index(store)
        revision = self._revision(store)
        scope_count = len(self._scope_records(store, resolved))
        matched_count = 0
        knowledge_limit = max(1, min(knowledge_limit, 50))
        if question.strip() or resolved is not None:
            knowledge_result = self.search_knowledge(
                query=question,
                include_evidence=include_evidence,
                limit=knowledge_limit,
                scope=resolved,
                expected_persona_revision=revision,
            )
            knowledge = knowledge_result.results
            matched_count = knowledge_result.total_count
        else:
            knowledge = []
        if resolved is None:
            preferences_result = self.search_preferences(
                task="\n".join(item for item in (task, question) if item),
                context_key=context_key,
                artifact_type=artifact_type,
                include_examples=True,
                max_chars=max_chars,
                limit=50,
            )
        else:
            # Preference contexts/examples currently have no domain tags.
            preferences_result = SearchPreferencesResult(
                persona_revision=revision, request_id=_request_id(), matched_contexts=[],
                preferences=[], examples=[], conflict_notes=[],
                budget=BudgetResult(max_chars=max_chars, used_chars=0, truncated=False),
            )
        preferences = preferences_result.preferences
        examples = preferences_result.examples
        max_chars = max(1000, min(max_chars, 50_000))
        truncated = preferences_result.budget.truncated
        while examples and _serialized_chars(
            {"knowledge": knowledge, "preferences": preferences, "examples": examples}
        ) > max_chars:
            examples.pop()
            truncated = True
        while knowledge and _serialized_chars(
            {"knowledge": knowledge, "preferences": preferences, "examples": examples}
        ) > max_chars:
            knowledge.pop()
            truncated = True
        while preferences and _serialized_chars(
            {"knowledge": knowledge, "preferences": preferences, "examples": examples}
        ) > max_chars:
            removable = next(
                (
                    index
                    for index in range(len(preferences) - 1, -1, -1)
                    if preferences[index].behavior != "required"
                ),
                None,
            )
            if removable is None:
                break
            preferences.pop(removable)
            truncated = True
        used = _serialized_chars(
            {"knowledge": knowledge, "preferences": preferences, "examples": examples}
        )
        unknowns = [
            UnknownResult(
                subject=item.title,
                reason="No reviewed knowledge or understanding level is recorded.",
            )
            for item in knowledge
            if item.knowledge_level == "unspecified"
        ]
        unknowns.extend(
            UnknownResult(subject=note, reason="Preference context could not be matched.")
            for note in preferences_result.conflict_notes
        )

        levels = {item.knowledge_level for item in knowledge}
        if "proficient" in levels:
            depth = "advanced_with_explicit_assumptions"
        elif "familiar" in levels:
            depth = "intermediate_with_brief_reminders"
        elif "aware" in levels:
            depth = "detailed_with_background"
        else:
            depth = "no_assumption"

        omissions = []
        if matched_count > knowledge_limit:
            omissions.append("candidate_limit")
        if truncated:
            omissions.append("character_budget")
        if resolved is not None:
            omissions.append("unscoped_preferences_excluded")
        return PrepareContextResult(
            persona_revision=revision,
            request_id=_request_id(),
            scope=resolved,
            coverage=ContextCoverage(
                scope_record_count=scope_count, matched_count=matched_count,
                returned_count=len(knowledge), omission_reasons=omissions,
            ),
            matched_contexts=preferences_result.matched_contexts,
            knowledge=knowledge,
            preferences=preferences,
            examples=examples,
            unknowns=unknowns,
            guidance=GuidanceResult(explanation_depth=depth),
            budget=BudgetResult(
                max_chars=max_chars,
                used_chars=used,
                truncated=truncated or used > max_chars,
            ),
        )

    @_consistent_read
    def get_persona_record(
        self,
        *,
        record_id: str,
        include_relations: bool = True,
        include_evidence: bool = False,
        include_revision_summary: bool = False,
        max_chars: int = 12_000,
        scope: TagScope | None = None,
        expected_persona_revision: int | None = None,
        expected_record_revision: int | None = None,
    ) -> PersonaRecordResult:
        store = self._store()
        self._check_revision(store, expected_persona_revision)
        resolved = self._resolve_scope(store, scope)
        allowed_ids = self._scope_records(store, resolved) if resolved is not None else None
        allowed_sources = self._scope_sources(store, allowed_ids) if allowed_ids is not None else None
        self._require_scoped_record(record_id, allowed_ids)
        revision = self._revision(store)
        loaded = store.records.get(record_id)
        if loaded is None or loaded.record.status != "active":
            raise AgentServiceError("not_found", f"No active persona record: {record_id}")
        record = loaded.record
        self._check_record_revision(record, expected_record_revision)
        payload = record.model_dump(mode="json", by_alias=True, exclude_none=True)
        if store.config and store.config.include_human_notes_in_snapshot and loaded.body:
            payload["human_notes"] = loaded.body
        if resolved is not None and "evidence_refs" in payload:
            payload["evidence_refs"] = [
                item.id for item in self._evidence(store, payload["evidence_refs"], allowed_sources)
            ]
        relations: list[dict[str, Any]] = []
        if include_relations:
            for relation in store.of_type(Relation, active_only=True):
                if record_id not in {relation.source_id, relation.target_id}:
                    continue
                if allowed_ids is not None and not {
                    relation.source_id, relation.target_id
                } <= allowed_ids:
                    continue
                relation_payload = relation.model_dump(mode="json", by_alias=True, exclude_none=True)
                if resolved is not None:
                    relation_payload["evidence_refs"] = [
                        item.id for item in self._evidence(
                            store, relation.evidence_refs, allowed_sources
                        )
                    ]
                relations.append(relation_payload)
        evidence_refs = list(getattr(record, "evidence_refs", []))
        evidence = self._evidence(store, evidence_refs, allowed_sources) if include_evidence else []
        revision_summary: list[dict[str, Any]] = []
        if include_revision_summary:
            revision_summary = self._record_revision_summary(record_id)

        max_chars = max(1000, min(max_chars, 50_000))
        truncated = False
        record_result = {
            "id": record.id,
            "entity_type": record.entity_type,
            "record_revision": record.revision,
            "status": record.status,
            "data": payload,
            "omitted_fields": [],
        }
        result_content = {
            "record": record_result,
            "relations": relations,
            "evidence": evidence,
            "revision_summary": revision_summary,
        }
        if _serialized_chars(result_content) > max_chars and revision_summary:
            revision_summary = []
            result_content["revision_summary"] = []
            truncated = True
        if _serialized_chars(result_content) > max_chars and evidence:
            evidence = []
            result_content["evidence"] = []
            truncated = True
        while relations and _serialized_chars(result_content) > max_chars:
            relations.pop()
            truncated = True
        verbose_fields = (
            "human_notes",
            "syllabus",
            "description",
            "abstract",
            "summary",
            "scope_note",
            "rationale",
            "condition",
        )
        for field in verbose_fields:
            if _serialized_chars(result_content) <= max_chars:
                break
            if field in payload:
                payload.pop(field)
                record_result["omitted_fields"].append(field)
                truncated = True
        return PersonaRecordResult(
            persona_revision=revision,
            request_id=_request_id(),
            scope=resolved,
            record=record_result,
            relations=relations,
            evidence=evidence,
            revision_summary=revision_summary,
            truncated=truncated,
        )

    @_consistent_read
    def get_material_source(
        self, *, material_id: str, scope: TagScope | None = None,
        expected_persona_revision: int | None = None,
        expected_record_revision: int | None = None,
        expected_source_hash: str | None = None,
    ) -> MaterialSourceResult:
        store = self._store()
        self._check_revision(store, expected_persona_revision)
        resolved = self._resolve_scope(store, scope)
        allowed_ids = self._scope_records(store, resolved) if resolved is not None else None
        self._require_scoped_record(material_id, allowed_ids)
        revision = self._revision(store)
        loaded = store.records.get(material_id)
        if (
            loaded is None
            or not isinstance(loaded.record, Material)
            or loaded.record.status != "active"
        ):
            raise AgentServiceError("not_found", f"No active material: {material_id}")
        material = loaded.record
        self._check_record_revision(material, expected_record_revision)
        manifest = store.sources.get(material.source_ref)
        if manifest is None:
            raise AgentServiceError(
                "not_found", "The material source is not available."
            )

        if expected_source_hash is not None and expected_source_hash != f"sha256:{manifest.content_hash}":
            raise AgentServiceError(
                "stale_source", "Material source changed; refresh its metadata.", retryable=True,
            )
        preferred_path = next(
            (item.path for item in manifest.files if item.role == "extracted_text"),
            None,
        )
        if preferred_path is None:
            preferred_path = next(
                (
                    item.path
                    for item in manifest.files
                    if item.role == "original" and item.media_type.startswith("text/")
                ),
                None,
            )

        files: list[MaterialSourceFileResult] = []
        for source_file in manifest.files:
            path = store.source_file_path(manifest.id, source_file.path)
            is_text = source_file.media_type.startswith("text/")
            line_count = None
            if is_text:
                line_count = len(
                    path.read_text(encoding="utf-8", errors="replace").splitlines()
                )
            files.append(
                MaterialSourceFileResult(
                    role=source_file.role,
                    relative_path=source_file.path,
                    path=str(path),
                    media_type=source_file.media_type,
                    sha256=f"sha256:{source_file.sha256}",
                    size_bytes=path.stat().st_size,
                    line_count=line_count,
                    evidence_locator="lines" if is_text else "unsupported",
                    preferred_for_text=source_file.path == preferred_path,
                )
            )
        files.sort(key=lambda item: (not item.preferred_for_text, item.role, item.relative_path))
        return MaterialSourceResult(
            persona_revision=revision,
            request_id=_request_id(),
            scope=resolved,
            material_id=material.id,
            material_revision=material.revision,
            source_id=manifest.id,
            source_hash=f"sha256:{manifest.content_hash}",
            source_type=manifest.source_type,
            files=files,
        )

    def _record_revision_summary(self, record_id: str) -> list[dict[str, Any]]:
        path = self.data_root / "revisions" / "changes.jsonl"
        if not path.is_file():
            return []
        results: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            for change in entry.get("changes", []):
                if change.get("object_id") != record_id:
                    continue
                results.append(
                    {
                        "persona_revision": entry.get("persona_revision"),
                        "published_at": entry.get("published_at"),
                        "old_revision": change.get("old_revision"),
                        "new_revision": change.get("new_revision"),
                    }
                )
        return results[-20:]

    @_consistent_read
    def list_persona_changes(
        self,
        *,
        since_revision: int,
        limit: int = 20,
        cursor: str | None = None,
    ) -> PersonaChangesResult:
        if since_revision < 0:
            raise AgentServiceError("invalid_request", "since_revision cannot be negative")
        store = self._store()
        current = self._revision(store)
        fingerprint = _query_fingerprint({"since_revision": since_revision})
        offset = _decode_cursor(
            cursor, tool="list_persona_changes", revision=current, query_hash=fingerprint
        )
        entries: list[PersonaChangeResult] = []
        path = self.data_root / "revisions" / "changes.jsonl"
        proposal_repository = ProposalRepository(self.data_root)
        if path.is_file():
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                persona_revision = int(entry["persona_revision"])
                if persona_revision <= since_revision:
                    continue
                proposal_operations: dict[str, str] = {}
                for proposal_id in entry.get("proposal_ids", []):
                    try:
                        proposal = proposal_repository.get(proposal_id)
                    except ProposalError:
                        continue
                    proposal_operations[proposal.target_id] = proposal.operation
                for change in entry.get("changes", []):
                    object_id = str(change["object_id"])
                    loaded = store.records.get(object_id)
                    operation = proposal_operations.get(object_id)
                    if operation is None:
                        operation = "create" if change.get("old_revision") is None else "update"
                    entries.append(
                        PersonaChangeResult(
                            persona_revision=persona_revision,
                            published_at=str(entry.get("published_at", "")),
                            object_id=object_id,
                            entity_type=loaded.record.entity_type if loaded else None,
                            operation=operation,
                            old_record_revision=change.get("old_revision"),
                            new_record_revision=int(change["new_revision"]),
                        )
                    )
        limit = max(1, min(limit, 50))
        page = entries[offset : offset + limit]
        next_cursor = (
            _encode_cursor("list_persona_changes", current, offset + limit, fingerprint)
            if offset + limit < len(entries)
            else None
        )
        return PersonaChangesResult(
            persona_revision=current,
            request_id=_request_id(),
            from_revision=since_revision,
            to_revision=current,
            changes=page,
            next_cursor=next_cursor,
        )


class PersonaProposalFacade:
    def __init__(
        self,
        data_root: Path,
        state_root: Path,
        *,
        review_base_url: str = "http://127.0.0.1:8765",
    ) -> None:
        self.data_root = data_root.resolve()
        self.state_root = state_root.resolve()
        parsed_review_url = urlsplit(review_base_url)
        if (
            parsed_review_url.scheme not in {"http", "https"}
            or not parsed_review_url.netloc
            or parsed_review_url.username is not None
            or parsed_review_url.password is not None
            or parsed_review_url.query
            or parsed_review_url.fragment
        ):
            raise ValueError(
                "review_base_url must be an http(s) URL without credentials, query, or fragment"
            )
        self.review_base_url = review_base_url.rstrip("/")
        self.change_sets = ChangeSetRepository(self.data_root)

    @staticmethod
    def _payload_hash(
        *,
        observed_persona_revision: int,
        summary: str,
        proposal_context: ProposalContext,
        changes: list[ProposalChangeInput],
    ) -> str:
        payload = {
            "observed_persona_revision": observed_persona_revision,
            "summary": summary,
            "proposal_context": proposal_context.model_dump(mode="json"),
            "changes": [item.model_dump(mode="json") for item in changes],
        }
        content = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(content).hexdigest()}"

    @staticmethod
    def _validate_proposal_context(
        store: PersonaStore,
        proposal_context: ProposalContext,
        changes: list[ProposalChangeInput],
    ) -> Material | None:
        if proposal_context.kind == "maintenance":
            for source_id, source_hash in proposal_context.source_versions.items():
                manifest = store.sources.get(source_id)
                if not manifest or "sha256:" + manifest.content_hash != source_hash:
                    raise AgentServiceError("stale_source", "维护依据版本已变化。")
            for change in changes:
                if any(e.source_id not in proposal_context.source_versions for e in change.evidence):
                    raise AgentServiceError("invalid_evidence", "证据不属于本次维护来源。")
            return None
        if proposal_context.kind in {"general", "conversation"}:
            if any(change.evidence for change in changes):
                raise AgentServiceError(
                    "invalid_request", "Inline evidence requires material proposal context."
                )
            if proposal_context.kind == "conversation" and any(
                change.evidence_refs or change.values.get("evidence_refs")
                or change.operation not in {"create", "update", "relate"}
                or change.entity_type not in {
                    "knowledge_node", "preference", "preference_context", "relation"
                }
                for change in changes
            ):
                raise AgentServiceError("invalid_request", "对话学习只提交候选与简短备注，不附原始证据。")
            return None
        if any(
            change.operation not in {"create", "update", "relate"}
            for change in changes
        ):
            raise AgentServiceError(
                "invalid_request",
                "Material proposal context only supports create, update, and relate changes.",
            )
        loaded = store.records.get(proposal_context.material_id or "")
        if (
            loaded is None
            or not isinstance(loaded.record, Material)
            or loaded.record.status != "active"
        ):
            raise AgentServiceError("not_found", "The proposal Material is not active.")
        material = loaded.record
        if material.source_ref != proposal_context.source_id:
            raise AgentServiceError(
                "stale_source", "The Material no longer uses the observed Source.", retryable=True
            )
        manifest = store.sources.get(proposal_context.source_id or "")
        if (
            manifest is None
            or f"sha256:{manifest.content_hash}" != proposal_context.source_hash
        ):
            raise AgentServiceError(
                "stale_source", "The Material Source changed after it was read.", retryable=True
            )
        for change in changes:
            if (
                change.entity_type in {"knowledge_node", "relation"}
                and change.operation in {"create", "update", "relate"}
                and not change.evidence
                and not change.evidence_refs
            ):
                raise AgentServiceError(
                    "invalid_request",
                    "Material knowledge and relation changes require source evidence.",
                )
            if (
                change.entity_type == "knowledge_node"
                and change.values.get("knowledge_level") in {"familiar", "proficient"}
            ):
                evidence_kinds = {item.evidence_kind for item in change.evidence}
                evidence_kinds.update(
                    loaded.record.evidence_kind
                    for evidence_id in change.evidence_refs
                    if (loaded := store.records.get(evidence_id)) is not None
                    and isinstance(loaded.record, Evidence)
                )
                if not evidence_kinds.intersection(
                    {"explicit_user_statement", "authored_material", "user_feedback", "human_edit"}
                ):
                    raise AgentServiceError(
                        "invalid_request",
                        "Material content alone cannot establish familiar or proficient knowledge.",
                    )
        return material

    @staticmethod
    def _inline_evidence_candidates(
        store: PersonaStore,
        proposal_context: ProposalContext,
        material: Material | None,
        inputs: list[InlineEvidenceInput],
    ) -> list[ProposalEvidenceCandidate]:
        if not inputs:
            return []
        if proposal_context.kind != "maintenance" and (material is None or proposal_context.kind != "material"):
            raise AgentServiceError(
                "invalid_request", "Inline evidence requires material proposal context."
            )
        candidates: list[ProposalEvidenceCandidate] = []
        for evidence in inputs:
            manifest = store.sources[evidence.source_id if proposal_context.kind == "maintenance"
                                     else material.source_ref]
            if proposal_context.kind == "maintenance" and evidence.evidence_kind == "explicit_user_statement" and manifest.source_type != "manual_declaration":
                raise AgentServiceError("invalid_evidence", "参考材料不能冒充用户的明确陈述。")
            files = {item.path: item for item in manifest.files}
            source_file = files.get(evidence.file)
            if source_file is None:
                raise AgentServiceError(
                    "invalid_reference",
                    f"The evidence file is not declared by the Source: {evidence.file}",
                )
            if not source_file.media_type.startswith("text/"):
                raise AgentServiceError(
                    "invalid_request",
                    "Inline Evidence v1 requires a text Source file and line locator.",
                )
            if (
                evidence.evidence_kind == "authored_material"
                and (material is None or "authored" not in material.user_relationships)
            ):
                raise AgentServiceError(
                    "invalid_request",
                    "authored_material evidence requires an authored Material.",
                )
            source_path = store.source_file_path(manifest.id, source_file.path)
            lines = source_path.read_text(encoding="utf-8", errors="replace").splitlines()
            if evidence.line_end > len(lines):
                raise AgentServiceError(
                    "invalid_reference",
                    "The evidence line range exceeds the Source file.",
                    details={"line_count": len(lines), "file": source_file.path},
                )
            excerpt = "\n".join(lines[evidence.line_start - 1 : evidence.line_end]).strip()
            if not excerpt:
                raise AgentServiceError(
                    "invalid_request", "The evidence locator resolves to empty content."
                )
            if len(excerpt) > 20_000:
                raise AgentServiceError(
                    "invalid_request", "The evidence excerpt exceeds 20,000 characters."
                )
            candidates.append(
                ProposalEvidenceCandidate(
                    id=f"ev_{uuid.uuid4().hex}",
                    source_id=manifest.id,
                    source_hash=f"sha256:{manifest.content_hash}",
                    locator={
                        "file": source_file.path,
                        "line_start": evidence.line_start,
                        "line_end": evidence.line_end,
                    },
                    evidence_kind=evidence.evidence_kind,
                    extraction_method="maintenance/v1" if proposal_context.kind == "maintenance" else "agent_material_analysis/v1",
                    confidence=evidence.confidence,
                    body=excerpt,
                )
            )
        return candidates

    @staticmethod
    def _check_expected_revision(
        store: PersonaStore, change: ProposalChangeInput
    ) -> LoadedRecord:
        assert change.target_id is not None
        loaded = store.records.get(change.target_id)
        if loaded is None:
            raise AgentServiceError("not_found", f"Unknown target record: {change.target_id}")
        if loaded.record.entity_type != change.entity_type:
            raise AgentServiceError(
                "invalid_request",
                "entity_type does not match the target record.",
                details={
                    "target_id": change.target_id,
                    "expected": loaded.record.entity_type,
                    "received": change.entity_type,
                },
            )
        if loaded.record.revision != change.expected_record_revision:
            raise AgentServiceError(
                "stale_record",
                "The target record changed after it was read.",
                retryable=True,
                details={
                    "record_id": change.target_id,
                    "expected_revision": change.expected_record_revision,
                    "current_revision": loaded.record.revision,
                },
            )
        return loaded

    @staticmethod
    def _check_evidence(store: PersonaStore, evidence_refs: list[str]) -> None:
        for evidence_id in evidence_refs:
            loaded = store.records.get(evidence_id)
            if (
                loaded is None
                or not isinstance(loaded.record, Evidence)
                or loaded.record.status != "active"
            ):
                raise AgentServiceError(
                    "invalid_reference", f"Unknown active Evidence: {evidence_id}"
                )

    @staticmethod
    def _resolve_reference(
        values: dict[str, Any],
        id_field: str,
        ref_field: str,
        candidates: dict[str, tuple[str, str]],
    ) -> tuple[str, list[str]]:
        direct = values.pop(id_field, None)
        reference = values.pop(ref_field, None)
        if bool(direct) == bool(reference):
            raise AgentServiceError(
                "invalid_reference", f"Provide exactly one of {id_field} or {ref_field}."
            )
        if direct:
            return str(direct), []
        candidate = candidates.get(str(reference))
        if candidate is None:
            raise AgentServiceError(
                "invalid_reference", f"Unknown ChangeSet client_ref: {reference}"
            )
        return candidate[0], [candidate[1]]

    @staticmethod
    def _validate_relation_candidate(
        store: PersonaStore,
        values: dict[str, Any],
        candidate_types: dict[str, str],
        pending_relations: list[tuple[str, str, str]],
    ) -> None:
        source_id = str(values["source_id"])
        target_id = str(values["target_id"])
        relation_type = str(values["relation_type"])
        if source_id == target_id:
            raise AgentServiceError("invalid_reference", "A relation cannot point to itself.")

        def entity_type(record_id: str) -> str | None:
            loaded = store.records.get(record_id)
            if loaded is not None and loaded.record.status == "active":
                return loaded.record.entity_type
            return candidate_types.get(record_id)

        source_type, target_type = entity_type(source_id), entity_type(target_id)
        if source_type is None or target_type is None:
            raise AgentServiceError(
                "invalid_reference", "Relation endpoints must be active or created in this ChangeSet."
            )
        if relation_type == "covers":
            if source_type not in {"course", "material"} or target_type != "knowledge_node":
                raise AgentServiceError(
                    "invalid_reference", "covers requires course/material -> knowledge_node."
                )
            if source_type == "material" and not all(
                values.get(item) for item in ("knowledge_role", "salience", "statement")
            ):
                raise AgentServiceError(
                    "invalid_request",
                    "Material covers relations require knowledge_role, salience, and statement.",
                )
        elif source_type != "knowledge_node" or target_type != "knowledge_node":
            raise AgentServiceError(
                "invalid_reference", "Knowledge relations require knowledge_node endpoints."
            )
        signature = (source_id, relation_type, target_id)
        if signature in pending_relations:
            raise AgentServiceError("duplicate_change", "Duplicate relation in ChangeSet.")
        for relation in store.of_type(Relation, active_only=True):
            if (
                relation.source_id,
                relation.relation_type,
                relation.target_id,
            ) == signature:
                raise AgentServiceError("duplicate_change", "The active relation already exists.")

    @staticmethod
    def _validate_pending_broader_cycles(
        store: PersonaStore, pending_relations: list[tuple[str, str, str]]
    ) -> None:
        adjacency: dict[str, list[str]] = defaultdict(list)
        for relation in store.of_type(Relation, active_only=True):
            if relation.relation_type == "broader_than":
                adjacency[relation.source_id].append(relation.target_id)
        for source_id, relation_type, target_id in pending_relations:
            if relation_type == "broader_than":
                adjacency[source_id].append(target_id)
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node: str) -> bool:
            if node in visiting:
                return True
            if node in visited:
                return False
            visiting.add(node)
            if any(visit(child) for child in adjacency[node]):
                return True
            visiting.remove(node)
            visited.add(node)
            return False

        if any(visit(node) for node in sorted(adjacency)):
            raise AgentServiceError(
                "invalid_dependency", "The proposed broader_than relations create a cycle."
            )

    def _review_url(self, manifest: ChangeSetManifest) -> str:
        if len(manifest.proposal_links) == 1 and not manifest.assistant_session_id:
            return f"{self.review_base_url}/review/{manifest.proposal_links[0].proposal_id}"
        return f"{self.review_base_url}/review?change_set={manifest.id}"

    def _published_revisions(self) -> dict[str, int]:
        result: dict[str, int] = {}
        path = self.data_root / "revisions" / "changes.jsonl"
        if not path.is_file():
            return result
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            for proposal_id in entry.get("proposal_ids", []):
                result[str(proposal_id)] = int(entry["persona_revision"])
        return result

    def get_status(self, change_set_id: str) -> ProposalStatusResult:
        try:
            manifest = self.change_sets.get(change_set_id)
        except ChangeSetError as exc:
            raise AgentServiceError("proposal_not_found", str(exc)) from exc
        store = PersonaStore(self.data_root).load()
        assert store.config is not None
        repository = ProposalRepository(self.data_root)
        published = self._published_revisions()
        results: list[ProposalLinkResult] = []
        statuses: list[str] = []
        for link in manifest.proposal_links:
            proposal = repository.get(link.proposal_id)
            statuses.append(proposal.status)
            results.append(
                ProposalLinkResult(
                    **link.model_dump(),
                    status=proposal.status,
                    duplicate_candidates=proposal.duplicate_candidates,
                    conflicts=proposal.conflicts,
                    published_persona_revision=published.get(proposal.id),
                )
            )
        accepted = {"accepted", "edited_and_accepted"}
        if statuses and all(item in accepted for item in statuses):
            status = "accepted"
        elif statuses and all(item == "rejected" for item in statuses):
            status = "rejected"
        elif any(item in accepted for item in statuses) and any(
            item in {"rejected", "stale"} for item in statuses
        ):
            status = "partially_accepted"
        elif any(item in accepted for item in statuses):
            status = "partially_reviewed"
        elif any(item == "stale" for item in statuses):
            status = "stale"
        elif statuses and all(item == "deferred" for item in statuses):
            status = "deferred"
        else:
            status = "pending_review"
        return ProposalStatusResult(
            persona_revision=store.config.revision,
            request_id=_request_id(),
            change_set_id=manifest.id,
            status=status,
            effective_change=any(item in accepted for item in statuses),
            proposals=results,
            dependency_groups=manifest.dependency_groups(),
            review_url=self._review_url(manifest),
        )

    def _submission_result(self, manifest: ChangeSetManifest) -> ProposeChangeSetResult:
        status = self.get_status(manifest.id)
        return ProposeChangeSetResult(
            persona_revision=status.persona_revision,
            request_id=status.request_id,
            change_set_id=manifest.id,
            status=status.status,
            proposals=status.proposals,
            atomic_groups=manifest.atomic_groups,
            dependency_groups=manifest.dependency_groups(),
            warnings=manifest.warnings,
            review_url=status.review_url,
        )

    def propose_change_set(
        self,
        *,
        idempotency_key: str,
        observed_persona_revision: int,
        summary: str,
        changes: list[ProposalChangeInput],
        proposal_context: ProposalContext | None = None,
    ) -> ProposeChangeSetResult:
        if proposal_context and proposal_context.kind == "maintenance":
            raise AgentServiceError("invalid_request", "维护上下文由 Studio 任务登记，不能由外部调用者声明。")
        with proposal_lock(self.state_root):
            return self._propose_change_set_locked(
                idempotency_key=idempotency_key,
                observed_persona_revision=observed_persona_revision,
                summary=summary,
                changes=changes,
                proposal_context=proposal_context or ProposalContext(),
            )

    def _propose_change_set_locked(
        self,
        *,
        idempotency_key: str,
        observed_persona_revision: int,
        summary: str,
        changes: list[ProposalChangeInput],
        proposal_context: ProposalContext,
        prepared_repository: ProposalRepository | None = None,
        max_changes: int = 50,
        max_inline_evidence: int = 100,
    ) -> ProposeChangeSetResult | ChangeSetManifest:
        normalized_key = idempotency_key.strip()
        normalized_summary = summary.strip()
        if not normalized_key or len(normalized_key) > 200:
            raise AgentServiceError(
                "invalid_request", "idempotency_key must contain 1-200 characters."
            )
        if not normalized_summary or len(normalized_summary) > 4000:
            raise AgentServiceError("invalid_request", "summary must contain 1-4000 characters.")
        if not changes or len(changes) > min(max_changes, 300):
            raise AgentServiceError(
                "change_set_too_large", f"A ChangeSet must contain between 1 and {min(max_changes, 300)} changes."
            )
        payload_size = len(
            json.dumps(
                [item.model_dump(mode="json") for item in changes],
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        if payload_size > 1_000_000:
            raise AgentServiceError(
                "change_set_too_large", "A ChangeSet payload cannot exceed 1,000,000 bytes."
            )
        inline_evidence_count = sum(len(item.evidence) for item in changes)
        if inline_evidence_count > min(max_inline_evidence, 600):
            raise AgentServiceError(
                "change_set_too_large",
                "A ChangeSet cannot contain more than 100 inline Evidence items.",
            )
        client_refs = [item.client_ref for item in changes if item.client_ref]
        if len(client_refs) != len(set(client_refs)):
            raise AgentServiceError("duplicate_change", "client_ref values must be unique.")
        fingerprints = [
            json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
            for item in changes
        ]
        if len(fingerprints) != len(set(fingerprints)):
            raise AgentServiceError("duplicate_change", "The ChangeSet contains duplicate changes.")
        mutation_targets = [
            item.target_id
            for item in changes
            if item.operation in {"update", "archive", "restore", "unrelate"}
        ]
        if len(mutation_targets) != len(set(mutation_targets)):
            raise AgentServiceError(
                "duplicate_change", "A ChangeSet cannot mutate the same target more than once."
            )

        payload_hash = self._payload_hash(
            observed_persona_revision=observed_persona_revision,
            summary=normalized_summary,
            proposal_context=proposal_context,
            changes=changes,
        )
        existing = self.change_sets.by_idempotency_key(normalized_key)
        if existing:
            if existing.payload_hash != payload_hash:
                raise AgentServiceError(
                    "idempotency_conflict",
                    "The idempotency key was already used with a different payload.",
                )
            return self._submission_result(existing)

        store = PersonaStore(self.data_root).load()
        assert store.config is not None
        material = self._validate_proposal_context(store, proposal_context, changes)
        if observed_persona_revision < 1 or observed_persona_revision > store.config.revision:
            raise AgentServiceError(
                "invalid_request",
                "observed_persona_revision is not a valid published revision.",
                details={"current_revision": store.config.revision},
            )
        service = ProposalService(self.data_root, self.state_root)
        if prepared_repository is not None:
            service.repository = prepared_repository
        repository = service.repository
        created_proposals: list[str] = []
        links_by_index: dict[int, ChangeSetLink] = {}
        candidates: dict[str, tuple[str, str]] = {}
        candidate_types: dict[str, str] = {}
        context_candidates: list[PreferenceContext] = []
        pending_relations: list[tuple[str, str, str]] = []
        evidence_payload_bytes = 0
        counted_excerpts = set()
        warnings: list[str] = []
        if observed_persona_revision != store.config.revision:
            warnings.append(
                f"Persona advanced from revision {observed_persona_revision} "
                f"to {store.config.revision}; candidates were revalidated against the current store."
            )

        try:
            ordered_changes = sorted(enumerate(changes), key=lambda pair: (
                pair[1].entity_type != "preference_context" or pair[1].operation != "create",
                pair[0],
            ))
            for index, change in ordered_changes:
                self._check_evidence(store, change.evidence_refs)
                if change.operation == "relate":
                    continue
                values = dict(change.values)
                context_dependencies: list[str] = []
                if "context_client_refs" in values:
                    if change.entity_type not in {"preference", "preference_example"}:
                        raise AgentServiceError("invalid_dependency", "Only preferences use context_client_refs.")
                    refs = values.pop("context_client_refs")
                    if not isinstance(refs, list) or not all(isinstance(ref, str) for ref in refs):
                        raise AgentServiceError("invalid_dependency", "context_client_refs must be a list.")
                    context_ids = list(values.get("context_refs", []))
                    for ref in refs:
                        candidate = candidates.get(ref)
                        if not candidate or candidate_types[candidate[0]] != "preference_context":
                            raise AgentServiceError("invalid_dependency", "Unknown context candidate.")
                        context_ids.append(candidate[0])
                        context_dependencies.append(candidate[1])
                    values["context_refs"] = list(dict.fromkeys(context_ids))
                inline_evidence = self._inline_evidence_candidates(
                    store, proposal_context, material, change.evidence
                )
                for item in inline_evidence:
                    excerpt_key = (item.source_id, item.source_hash, json.dumps(item.locator, sort_keys=True), item.body)
                    if excerpt_key not in counted_excerpts:
                        counted_excerpts.add(excerpt_key)
                        evidence_payload_bytes += len(item.body.encode("utf-8"))
                if evidence_payload_bytes > 500_000:
                    raise AgentServiceError(
                        "change_set_too_large",
                        "Inline Evidence excerpts cannot exceed 500,000 bytes per ChangeSet.",
                    )
                proposal_evidence_refs = list(
                    dict.fromkeys(
                        [*change.evidence_refs, *(item.id for item in inline_evidence)]
                    )
                )
                if change.operation == "create":
                    if change.entity_type == "relation":
                        raise AgentServiceError(
                            "unsupported_operation", "Use relate for relation candidates."
                        )
                    body = str(values.pop("body", ""))
                    record_evidence_refs = (
                        proposal_evidence_refs
                        if change.entity_type in {"knowledge_node", "material"}
                        and proposal_evidence_refs
                        else None
                    )
                    proposal = service.create_record(
                        change.entity_type,  # type: ignore[arg-type]
                        values,
                        body=body,
                        reason=change.reason,
                        submitted_by="ai",
                        confidence=change.confidence,
                        evidence_refs=proposal_evidence_refs,
                        record_evidence_refs=record_evidence_refs,
                        evidence_candidates=inline_evidence,
                        proposal_context=proposal_context,
                        conflicts=change.conflicts,
                        context_candidates=context_candidates,
                    )
                    if change.client_ref:
                        candidates[change.client_ref] = (proposal.target_id, proposal.id)
                    candidate_types[proposal.target_id] = change.entity_type
                    if change.entity_type == "preference_context":
                        context_candidates.append(PreferenceContext.model_validate({
                            "schema": "ai-persona.preference-context/v1",
                            "id": proposal.target_id, "entity_type": "preference_context",
                            "status": "active", "revision": 1,
                            "created_at": _utc_now(), "updated_at": _utc_now(), **values,
                        }))
                elif change.operation == "update":
                    current = self._check_expected_revision(store, change)
                    record_evidence_refs = None
                    if proposal_evidence_refs and hasattr(current.record, "evidence_refs"):
                        record_evidence_refs = list(
                            dict.fromkeys(
                                [
                                    *getattr(current.record, "evidence_refs", []),
                                    *proposal_evidence_refs,
                                ]
                            )
                        )
                    proposal = service.create_update(
                        change.target_id or "",
                        values,
                        reason=change.reason,
                        submitted_by="ai",
                        confidence=change.confidence,
                        evidence_refs=proposal_evidence_refs,
                        record_evidence_refs=record_evidence_refs,
                        evidence_candidates=inline_evidence,
                        proposal_context=proposal_context,
                        conflicts=change.conflicts,
                        context_candidates=context_candidates,
                    )
                elif change.operation == "archive":
                    self._check_expected_revision(store, change)
                    proposal = service.create_archive(
                        change.target_id or "",
                        reason=change.reason,
                        submitted_by="ai",
                        confidence=change.confidence,
                        evidence_refs=change.evidence_refs,
                        conflicts=change.conflicts,
                    )
                elif change.operation == "restore":
                    self._check_expected_revision(store, change)
                    proposal = service.create_restore(
                        change.target_id or "",
                        reason=change.reason,
                        submitted_by="ai",
                        confidence=change.confidence,
                        evidence_refs=change.evidence_refs,
                        conflicts=change.conflicts,
                    )
                else:
                    self._check_expected_revision(store, change)
                    proposal = service.create_unrelate(
                        change.target_id or "",
                        reason=change.reason,
                        submitted_by="ai",
                        confidence=change.confidence,
                        evidence_refs=change.evidence_refs,
                        conflicts=change.conflicts,
                    )
                created_proposals.append(proposal.id)
                links_by_index[index] = ChangeSetLink(
                    proposal_id=proposal.id,
                    client_ref=change.client_ref,
                    candidate_record_id=proposal.target_id,
                    operation=proposal.operation,
                    entity_type=proposal.target_entity_type or change.entity_type,
                    dependencies=sorted(set(context_dependencies)),
                )

            for index, change in enumerate(changes):
                if change.operation != "relate":
                    continue
                inline_evidence = self._inline_evidence_candidates(
                    store, proposal_context, material, change.evidence
                )
                for item in inline_evidence:
                    excerpt_key = (item.source_id, item.source_hash, json.dumps(item.locator, sort_keys=True), item.body)
                    if excerpt_key not in counted_excerpts:
                        counted_excerpts.add(excerpt_key)
                        evidence_payload_bytes += len(item.body.encode("utf-8"))
                if evidence_payload_bytes > 500_000:
                    raise AgentServiceError(
                        "change_set_too_large",
                        "Inline Evidence excerpts cannot exceed 500,000 bytes per ChangeSet.",
                    )
                proposal_evidence_refs = list(
                    dict.fromkeys(
                        [*change.evidence_refs, *(item.id for item in inline_evidence)]
                    )
                )
                values = dict(change.values)
                source_id, source_dependencies = self._resolve_reference(
                    values, "source_id", "source_ref", candidates
                )
                target_id, target_dependencies = self._resolve_reference(
                    values, "target_id", "target_ref", candidates
                )
                relation_type = str(values.get("relation_type", ""))
                if relation_type not in {
                    "broader_than",
                    "part_of",
                    "applied_in",
                    "requires",
                    "related_to",
                    "covers",
                }:
                    raise AgentServiceError(
                        "invalid_request", f"Unsupported relation_type: {relation_type}"
                    )
                if relation_type == "related_to" and source_id > target_id:
                    source_id, target_id = target_id, source_id
                relation_values = {
                    "source_id": source_id,
                    "relation_type": relation_type,
                    "target_id": target_id,
                    "evidence_refs": proposal_evidence_refs,
                }
                allowed_optional = {"knowledge_role", "salience", "statement"}
                unknown = set(values) - {"relation_type", *allowed_optional}
                if unknown:
                    raise AgentServiceError(
                        "invalid_request", f"Unsupported relation fields: {sorted(unknown)}"
                    )
                relation_values.update(
                    {key: values[key] for key in allowed_optional if key in values}
                )
                relation_id = f"rel_{uuid.uuid4().hex}"
                Relation.model_validate(
                    {
                        "schema": "ai-persona.relation/v2",
                        "id": relation_id,
                        "entity_type": "relation",
                        "status": "active",
                        "revision": 1,
                        "created_at": _utc_now(),
                        "updated_at": _utc_now(),
                        **relation_values,
                    }
                )
                self._validate_relation_candidate(
                    store, relation_values, candidate_types, pending_relations
                )
                pending_relations.append((source_id, relation_type, target_id))
                proposal = service._new_proposal(
                    operation="relate",
                    target_id=relation_id,
                    target_entity_type="relation",
                    patch=[
                        ProposalPatch(field=field, before=None, after=value)
                        for field, value in relation_values.items()
                    ],
                    reason=change.reason,
                    submitted_by="ai",
                    confidence=change.confidence,
                    evidence_refs=proposal_evidence_refs,
                    evidence_candidates=inline_evidence,
                    proposal_context=proposal_context,
                    conflicts=change.conflicts,
                )
                repository.save_pending(proposal)
                created_proposals.append(proposal.id)
                dependencies = sorted(set(source_dependencies + target_dependencies))
                links_by_index[index] = ChangeSetLink(
                    proposal_id=proposal.id,
                    client_ref=change.client_ref,
                    candidate_record_id=proposal.target_id,
                    operation=proposal.operation,
                    entity_type="relation",
                    dependencies=dependencies,
                )
            self._validate_pending_broader_cycles(store, pending_relations)

            links = [links_by_index[index] for index in range(len(changes))]
            atomic_groups = [
                sorted({link.proposal_id, *link.dependencies})
                for link in links
                if link.dependencies
            ]
            manifest = ChangeSetManifest.model_validate(
                {
                    "schema": "ai-persona.change-set/v1",
                    "id": f"chg_{uuid.uuid4().hex}",
                    "idempotency_key": normalized_key,
                    "payload_hash": payload_hash,
                    "observed_persona_revision": observed_persona_revision,
                    "summary": normalized_summary,
                    "submitted_by": "ai",
                    "created_at": _utc_now(),
                    "proposal_context": proposal_context.model_dump(mode="json"),
                    "proposal_links": [item.model_dump() for item in links],
                    "atomic_groups": atomic_groups,
                    "warnings": warnings,
                }
            )
            if prepared_repository is not None:
                return manifest
            self.change_sets.save(manifest)
        except Exception:
            if prepared_repository is None:
                for proposal_id in created_proposals:
                    (repository.pending_root / f"{proposal_id}.json").unlink(missing_ok=True)
            raise
        return self._submission_result(manifest)
