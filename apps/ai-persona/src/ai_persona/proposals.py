from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from .change_sets import ChangeSetError, ChangeSetRepository, proposal_lock
from .compiler import PersonaCompiler
from .frontmatter import dump_markdown_record
from .materials import (
    MaterialSourceError,
    discard_staged_source,
    publish_staged_source,
    restore_staged_source,
    validate_staged_source,
)
from .models import (
    BaseRecord,
    ChangeProposal,
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
    parse_record,
)
from .store import LoadedRecord, PersonaStore


class ProposalError(ValueError):
    """Raised when a proposal operation cannot be completed safely."""


class StaleProposalError(ProposalError):
    """Raised when the target changed after a proposal was created."""


class ProposalDependencyError(ProposalError):
    """Raised when a proposal's ChangeSet dependencies are not satisfied."""


@dataclass(frozen=True)
class AppliedProposal:
    proposal: ChangeProposal
    persona_revision: int
    record: BaseRecord


@dataclass(frozen=True)
class RejectedProposalGroup:
    root_proposal: ChangeProposal
    rejected_proposals: list[ChangeProposal]

    @property
    def cascaded_count(self) -> int:
        return max(0, len(self.rejected_proposals) - 1)


UPDATE_FIELDS: dict[type[BaseRecord], set[str]] = {
    KnowledgeNode: {
        "title",
        "aliases",
        "semantic_role",
        "knowledge_level",
        "interest_level",
        "summary",
        "scope_note",
        "tags",
        "body",
    },
    Course: {
        "title",
        "aliases",
        "knowledge_level",
        "interest_level",
        "description",
        "syllabus",
        "tags",
    },
    Material: {
        "title",
        "aliases",
        "abstract",
        "material_type",
        "bibliography",
        "user_relationships",
        "knowledge_level",
        "preference_level",
        "preference_reasons",
        "summary",
        "scope_note",
        "tags",
        "source_ref",
        "body",
    },
    Relation: {"knowledge_role", "salience", "statement", "evidence_refs"},
    Evidence: set(),
    PreferenceContext: {"name", "description", "activation", "body", "status"},
    Preference: {
        "scope",
        "context_refs",
        "behavior",
        "instruction",
        "condition",
        "rationale",
        "body",
        "status",
    },
    PreferenceExample: {
        "example_type",
        "title",
        "context_refs",
        "condition",
        "reasons",
        "source_ref",
        "content_hash",
        "status",
    },
    Tag: {"namespace", "slug", "label", "aliases"},
}

CREATE_TYPES: dict[str, type[BaseRecord]] = {
    "knowledge_node": KnowledgeNode,
    "course": Course,
    "material": Material,
    "evidence": Evidence,
    "preference_context": PreferenceContext,
    "preference": Preference,
    "preference_example": PreferenceExample,
    "tag": Tag,
}

CREATE_FIELDS: dict[type[BaseRecord], set[str]] = {
    KnowledgeNode: UPDATE_FIELDS[KnowledgeNode],
    Course: UPDATE_FIELDS[Course],
    Material: UPDATE_FIELDS[Material],
    Evidence: {
        "source_id",
        "source_hash",
        "locator",
        "supports",
        "evidence_kind",
        "extraction_method",
        "confidence",
        "body",
    },
    PreferenceContext: (UPDATE_FIELDS[PreferenceContext] - {"status"}) | {"key"},
    Preference: UPDATE_FIELDS[Preference] - {"status"},
    PreferenceExample: UPDATE_FIELDS[PreferenceExample] - {"status"},
    Tag: UPDATE_FIELDS[Tag],
}

SCHEMA_BY_TYPE = {
    "knowledge_node": "ai-persona.knowledge-node/v1",
    "course": "ai-persona.course/v1",
    "material": "ai-persona.material/v3",
    "evidence": "ai-persona.evidence/v1",
    "relation": "ai-persona.relation/v2",
    "preference_context": "ai-persona.preference-context/v1",
    "preference": "ai-persona.preference/v1",
    "preference_example": "ai-persona.preference-example/v3",
    "tag": "ai-persona.tag/v1",
}

PREFIX_BY_TYPE = {
    "knowledge_node": "kn_",
    "course": "crs_",
    "material": "mat_",
    "evidence": "ev_",
    "relation": "rel_",
    "preference_context": "pctx_",
    "preference": "pref_",
    "preference_example": "pex_",
    "tag": "tag_",
}


def review_update_fields(entity_type: str, operation: str) -> set[str]:
    """Human edits use the persistence contract; identities stay fixed after creation."""
    model = Relation if entity_type == "relation" else CREATE_TYPES.get(entity_type)
    if operation not in {"create", "update", "relate"}:
        return set()
    allowed = set(UPDATE_FIELDS.get(model, set()))
    if operation in {"create", "relate"}:
        allowed |= CREATE_FIELDS.get(model, set())
        if model is Relation:
            allowed |= {"source_id", "target_id", "relation_type"}
    if model is Relation:
        allowed.add("body")
    # Evidence remains source-owned, never a manually invented chat citation.
    allowed.discard("evidence_refs")
    return allowed


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def _normalize_newlines(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\r\n", "\n").replace("\r", "\n")
    if isinstance(value, list):
        return [_normalize_newlines(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_newlines(item) for key, item in value.items()}
    return value


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


def record_content_hash(loaded: LoadedRecord) -> str:
    payload = loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
    payload["body"] = loaded.body
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(canonical).hexdigest()


def _new_id(entity_type: str) -> str:
    return f"{PREFIX_BY_TYPE[entity_type]}{uuid.uuid4().hex}"


def _proposal_patch(
    values: dict[str, Any], *, before: dict[str, Any] | None = None
) -> list[ProposalPatch]:
    patches: list[ProposalPatch] = []
    for field in sorted(values):
        old_value = None if before is None else before.get(field)
        if old_value != values[field]:
            patches.append(ProposalPatch(field=field, before=old_value, after=values[field]))
    return patches


class ProposalRepository:
    def __init__(self, data_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.pending_root = self.data_root / "proposals" / "pending"
        self.history_root = self.data_root / "proposals" / "history"

    def list_pending(self) -> list[ChangeProposal]:
        proposals = self._load_directory(self.pending_root)
        return sorted(proposals, key=lambda item: item.updated_at, reverse=True)

    def list_history(self, *, limit: int | None = 20) -> list[ChangeProposal]:
        proposals = self._load_directory(self.history_root)
        return sorted(proposals, key=lambda item: item.updated_at, reverse=True)[:limit]

    def get(self, proposal_id: str) -> ChangeProposal:
        self._validate_id(proposal_id)
        for root in (self.pending_root, self.history_root):
            path = root / f"{proposal_id}.json"
            if path.is_file():
                return self._load_file(path)
        raise ProposalError(f"unknown proposal: {proposal_id}")

    def save_pending(self, proposal: ChangeProposal) -> Path:
        path = self.pending_root / f"{proposal.id}.json"
        _atomic_write(path, _json_bytes(proposal.model_dump(mode="json", by_alias=True)))
        return path

    def complete(self, proposal: ChangeProposal) -> Path:
        history_path = self.history_root / f"{proposal.id}.json"
        _atomic_write(
            history_path,
            _json_bytes(proposal.model_dump(mode="json", by_alias=True)),
        )
        pending_path = self.pending_root / f"{proposal.id}.json"
        if pending_path.exists():
            pending_path.unlink()
        return history_path

    def complete_many(self, proposals: list[ChangeProposal]) -> list[Path]:
        if len({proposal.id for proposal in proposals}) != len(proposals):
            raise ProposalError("cannot complete the same proposal twice")
        affected: dict[Path, bytes | None] = {}
        for proposal in proposals:
            for root in (self.pending_root, self.history_root):
                path = root / f"{proposal.id}.json"
                affected[path] = path.read_bytes() if path.exists() else None
        try:
            history_paths = []
            for proposal in proposals:
                history_path = self.history_root / f"{proposal.id}.json"
                _atomic_write(
                    history_path,
                    _json_bytes(proposal.model_dump(mode="json", by_alias=True)),
                )
                history_paths.append(history_path)
            for proposal in proposals:
                (self.pending_root / f"{proposal.id}.json").unlink(missing_ok=True)
            return history_paths
        except Exception:
            for path, previous in affected.items():
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write(path, previous)
            raise

    def _load_directory(self, root: Path) -> list[ChangeProposal]:
        if not root.exists():
            return []
        return [self._load_file(path) for path in sorted(root.glob("prop_*.json"))]

    @staticmethod
    def _load_file(path: Path) -> ChangeProposal:
        try:
            return ChangeProposal.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError) as exc:
            raise ProposalError(f"invalid proposal {path}: {exc}") from exc

    @staticmethod
    def _validate_id(proposal_id: str) -> None:
        if not re.fullmatch(r"prop_[A-Za-z0-9_-]+", proposal_id):
            raise ProposalError("invalid proposal id")


class ProposalService:
    def __init__(self, data_root: Path, state_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.state_root = state_root.resolve()
        self.repository = ProposalRepository(self.data_root)

    def _save_proposals(self, proposals: list[ChangeProposal]) -> list[ChangeProposal]:
        for proposal in proposals:
            self.repository.save_pending(proposal)
        return proposals

    def create_record(
        self,
        entity_type: Literal[
            "knowledge_node",
            "course",
            "material",
            "evidence",
            "preference_context",
            "preference",
            "preference_example",
            "tag",
        ],
        values: dict[str, Any],
        *,
        body: str = "",
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        record_evidence_refs: list[str] | None = None,
        evidence_candidates: list[ProposalEvidenceCandidate] | None = None,
        proposal_context: ProposalContext | None = None,
        conflicts: list[str] | None = None,
        context_candidates: list[PreferenceContext] | None = None,
    ) -> ChangeProposal:
        reason = self._normalize_reason(reason, submitted_by)
        store = PersonaStore(self.data_root).load()
        model = CREATE_TYPES[entity_type]
        allowed = CREATE_FIELDS[model] - {"body"}
        unknown = set(values) - allowed
        if unknown:
            raise ProposalError(f"unsupported create fields: {sorted(unknown)}")
        normalized = {key: _normalize_newlines(value) for key, value in values.items()}
        if record_evidence_refs is not None:
            if "evidence_refs" not in model.model_fields:
                raise ProposalError(f"{entity_type} records cannot own evidence")
            normalized["evidence_refs"] = list(dict.fromkeys(record_evidence_refs))
        normalized_body = str(_normalize_newlines(body)).strip()
        now = _utc_now()
        target_id = _new_id(entity_type)
        payload = {
            "schema": SCHEMA_BY_TYPE[entity_type],
            "id": target_id,
            "entity_type": entity_type,
            "status": "active",
            "revision": 1,
            "created_at": _iso_utc(now),
            "updated_at": _iso_utc(now),
            **normalized,
        }
        candidate = self._parse_candidate(payload)
        self._validate_candidate(
            store, candidate, normalized_body, context_candidates=context_candidates
        )
        proposal_values = dict(normalized)
        if isinstance(candidate, (KnowledgeNode, Course, Material)):
            # Show an omitted level explicitly in the proposal and its audit history.
            proposal_values["knowledge_level"] = candidate.knowledge_level
        if "body" in CREATE_FIELDS[model]:
            proposal_values["body"] = normalized_body
        proposal = self._new_proposal(
            operation="create",
            target_id=target_id,
            target_entity_type=entity_type,
            patch=_proposal_patch(proposal_values),
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs or [],
            evidence_candidates=evidence_candidates or [],
            proposal_context=proposal_context,
            conflicts=conflicts or [],
            duplicate_candidates=self._duplicate_candidates(store, candidate),
        )
        return self._save_proposals([proposal])[0]

    def create_update(
        self,
        target_id: str,
        updates: dict[str, Any],
        *,
        reason: str = "",
        expected_revision: int | None = None,
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        record_evidence_refs: list[str] | None = None,
        evidence_candidates: list[ProposalEvidenceCandidate] | None = None,
        proposal_context: ProposalContext | None = None,
        conflicts: list[str] | None = None,
        context_candidates: list[PreferenceContext] | None = None,
    ) -> ChangeProposal:
        reason = self._normalize_reason(reason, submitted_by)
        store = PersonaStore(self.data_root).load()
        loaded = store.records.get(target_id)
        if loaded is None:
            raise ProposalError(f"unknown record: {target_id}")
        if expected_revision is not None and loaded.record.revision != expected_revision:
            raise StaleProposalError("记录已更新，请刷新页面后重新编辑。")
        allowed = self._allowed_update_fields(loaded.record)
        unknown_fields = set(updates) - allowed
        if unknown_fields:
            raise ProposalError(
                f"record is not editable or fields are unsupported: {sorted(unknown_fields)}"
            )

        normalized = {field: _normalize_newlines(value) for field, value in updates.items()}
        if record_evidence_refs is not None:
            if "evidence_refs" not in type(loaded.record).model_fields:
                raise ProposalError(f"{loaded.record.entity_type} records cannot own evidence")
            normalized["evidence_refs"] = list(dict.fromkeys(record_evidence_refs))
        current = loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
        body = loaded.body
        candidate_payload = dict(current)
        for key, value in normalized.items():
            if key == "body":
                body = str(value).strip()
            else:
                candidate_payload[key] = value
        candidate = self._parse_candidate(candidate_payload)
        self._validate_candidate(
            store, candidate, body, replacing_id=target_id, context_candidates=context_candidates
        )
        if isinstance(candidate, Relation):
            self._validate_new_relation(store, candidate, excluding_id=target_id)
        before = dict(current)
        before["body"] = loaded.body
        patch = _proposal_patch(normalized, before=before)
        if not patch:
            raise ProposalError("the edit does not change any field")
        proposal = self._new_proposal(
            operation="update",
            target_id=target_id,
            target_entity_type=loaded.record.entity_type,
            base=loaded,
            patch=patch,
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs or [],
            evidence_candidates=evidence_candidates or [],
            proposal_context=proposal_context,
            conflicts=conflicts or [],
            duplicate_candidates=self._duplicate_candidates(
                store, candidate, excluding_id=target_id
            ),
        )
        return self._save_proposals([proposal])[0]

    def create_archive(
        self,
        target_id: str,
        *,
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> ChangeProposal:
        reason = self._normalize_reason(reason, submitted_by)
        store = PersonaStore(self.data_root).load()
        loaded = store.records.get(target_id)
        supported = (
            KnowledgeNode,
            Course,
            Material,
            PreferenceContext,
            Preference,
            PreferenceExample,
            Tag,
        )
        if loaded is None or not isinstance(loaded.record, supported):
            raise ProposalError(f"record cannot be archived here: {target_id}")
        if loaded.record.status == "archived":
            raise ProposalError("record is already archived")
        if isinstance(loaded.record, PreferenceContext):
            preference_users = [
                preference
                for preference in store.of_type(Preference, active_only=False)
                if preference.status != "archived"
                and loaded.record.id in preference.context_refs
            ]
            example_users = [
                example
                for example in store.of_type(PreferenceExample, active_only=False)
                if example.status != "archived"
                and loaded.record.id in example.context_refs
            ]
            if preference_users or example_users:
                raise ProposalError("请先移除或归档使用该场景的偏好和参考样本")
        if isinstance(loaded.record, Tag):
            users = [
                record.id
                for record in store.of_type(BaseRecord, active_only=True)
                if target_id in getattr(record, "tags", [])
            ]
            if users:
                raise ProposalError(
                    f"tag is still used by active records: {', '.join(sorted(users))}"
                )
        detected_conflicts: list[str] = []
        if isinstance(loaded.record, (KnowledgeNode, Course, Material)):
            relations = [
                relation
                for relation in store.of_type(Relation, active_only=True)
                if target_id in {relation.source_id, relation.target_id}
            ]
            if relations:
                detected_conflicts.append(
                    f"发布时将同时归档 {len(relations)} 条关联关系"
                )
        proposal = self._new_proposal(
            operation="archive",
            target_id=target_id,
            target_entity_type=loaded.record.entity_type,
            base=loaded,
            patch=[
                ProposalPatch(
                    field="status", before=loaded.record.status, after="archived"
                )
            ],
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs or [],
            conflicts=[*(conflicts or []), *detected_conflicts],
        )
        return self._save_proposals([proposal])[0]

    def create_restore(
        self,
        target_id: str,
        *,
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> ChangeProposal:
        reason = self._normalize_reason(reason, submitted_by)
        store = PersonaStore(self.data_root).load()
        loaded = store.records.get(target_id)
        supported = (
            KnowledgeNode,
            Course,
            Material,
            PreferenceContext,
            Preference,
            PreferenceExample,
            Tag,
        )
        if loaded is None or not isinstance(loaded.record, supported):
            raise ProposalError(f"record cannot be restored here: {target_id}")
        if loaded.record.status != "archived":
            raise ProposalError("record is already active")
        payload = loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
        payload["status"] = "active"
        candidate = self._parse_candidate(payload)
        self._validate_candidate(store, candidate, loaded.body, replacing_id=target_id)
        proposal = self._new_proposal(
            operation="restore",
            target_id=target_id,
            target_entity_type=loaded.record.entity_type,
            base=loaded,
            patch=[ProposalPatch(field="status", before="archived", after="active")],
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs or [],
            conflicts=conflicts or [],
        )
        return self._save_proposals([proposal])[0]

    def create_material_relation(
        self,
        material_id: str,
        knowledge_id: str,
        *,
        knowledge_role: str,
        salience: str,
        statement: str,
        reason: str = "",
        evidence_refs: list[str] | None = None,
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        conflicts: list[str] | None = None,
    ) -> ChangeProposal:
        return self.create_material_relations(
            material_id,
            [(knowledge_id, knowledge_role, salience, statement)],
            reason=reason,
            evidence_refs=evidence_refs,
            submitted_by=submitted_by,
            confidence=confidence,
            conflicts=conflicts,
        )[0]

    def create_material_relations(
        self,
        material_id: str,
        relations: list[tuple[str, str, str, str]],
        *,
        reason: str = "",
        evidence_refs: list[str] | None = None,
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        conflicts: list[str] | None = None,
    ) -> list[ChangeProposal]:
        reason = self._normalize_reason(reason, submitted_by)
        if not relations:
            raise ProposalError("at least one relation is required")
        store = PersonaStore(self.data_root).load()
        material = store.records.get(material_id)
        if material is None or not isinstance(material.record, Material):
            raise ProposalError("relation source must be an active material")
        if material.record.status != "active":
            raise ProposalError("relation source must be an active material")

        proposals: list[ChangeProposal] = []
        seen: set[tuple[str, str, str, str | None]] = set()
        for knowledge_id, knowledge_role, salience, statement in relations:
            knowledge = store.records.get(knowledge_id)
            if knowledge is None or not isinstance(knowledge.record, KnowledgeNode):
                raise ProposalError("relation target must be an active knowledge node")
            if knowledge.record.status != "active":
                raise ProposalError("relation endpoints must be active")
            relation_id = _new_id("relation")
            values = {
                "source_id": material_id,
                "relation_type": "covers",
                "target_id": knowledge_id,
                "knowledge_role": knowledge_role,
                "salience": salience,
                "statement": statement.strip(),
                "evidence_refs": evidence_refs or [],
            }
            now = _utc_now()
            candidate = self._parse_candidate(
                {
                    "schema": SCHEMA_BY_TYPE["relation"],
                    "id": relation_id,
                    "entity_type": "relation",
                    "status": "active",
                    "revision": 1,
                    "created_at": _iso_utc(now),
                    "updated_at": _iso_utc(now),
                    **values,
                }
            )
            assert isinstance(candidate, Relation)
            key = (
                candidate.source_id,
                candidate.relation_type,
                candidate.target_id,
                candidate.knowledge_role,
            )
            if key in seen:
                raise ProposalError("the same relation appears more than once")
            self._validate_new_relation(store, candidate)
            seen.add(key)
            proposals.append(
                self._new_proposal(
                    operation="relate",
                    target_id=relation_id,
                    target_entity_type="relation",
                    patch=_proposal_patch(values),
                    reason=reason,
                    submitted_by=submitted_by,
                    confidence=confidence,
                    evidence_refs=evidence_refs or [],
                    conflicts=conflicts or [],
                )
            )

        return self._save_proposals(proposals)

    def create_relation(
        self,
        source_id: str,
        relation_type: Literal["broader_than", "requires", "related_to", "applied_in"],
        target_id: str,
        *,
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> ChangeProposal:
        return self.create_relations(
            source_id,
            [(relation_type, target_id)],
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs,
            conflicts=conflicts,
        )[0]

    def create_relations(
        self,
        source_id: str,
        relations: list[
            tuple[
                Literal["broader_than", "requires", "related_to", "applied_in"],
                str,
            ]
        ],
        *,
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> list[ChangeProposal]:
        reason = self._normalize_reason(reason, submitted_by)
        if not relations:
            raise ProposalError("at least one relation is required")
        store = PersonaStore(self.data_root).load()
        source = store.records.get(source_id)
        if source is None or not isinstance(source.record, KnowledgeNode):
            raise ProposalError("relation source must be an active knowledge node")
        if source.record.status != "active":
            raise ProposalError("relation source must be an active knowledge node")

        proposals: list[ChangeProposal] = []
        seen: set[tuple[str, str, str]] = set()
        for relation_type, target_id in relations:
            relation_source_id = source_id
            target = store.records.get(target_id)
            if target is None or not isinstance(target.record, KnowledgeNode):
                raise ProposalError("relation target must be an active knowledge node")
            if target.record.status != "active":
                raise ProposalError("relation endpoints must be active")
            if source_id == target_id:
                raise ProposalError("a relation cannot point to itself")
            if relation_type == "related_to" and relation_source_id > target_id:
                relation_source_id, target_id = target_id, relation_source_id

            relation_id = _new_id("relation")
            values = {
                "source_id": relation_source_id,
                "relation_type": relation_type,
                "target_id": target_id,
                "evidence_refs": evidence_refs or [],
            }
            now = _utc_now()
            candidate = self._parse_candidate(
                {
                    "schema": SCHEMA_BY_TYPE["relation"],
                    "id": relation_id,
                    "entity_type": "relation",
                    "status": "active",
                    "revision": 1,
                    "created_at": _iso_utc(now),
                    "updated_at": _iso_utc(now),
                    **values,
                }
            )
            assert isinstance(candidate, Relation)
            key = (candidate.source_id, candidate.relation_type, candidate.target_id)
            if key in seen:
                raise ProposalError("the same relation appears more than once")
            self._validate_new_relation(store, candidate)
            seen.add(key)
            proposals.append(
                self._new_proposal(
                    operation="relate",
                    target_id=relation_id,
                    target_entity_type="relation",
                    patch=_proposal_patch(values),
                    reason=reason,
                    submitted_by=submitted_by,
                    confidence=confidence,
                    evidence_refs=evidence_refs or [],
                    conflicts=conflicts or [],
                )
            )

        return self._save_proposals(proposals)

    def create_unrelate(
        self,
        relation_id: str,
        *,
        reason: str = "",
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        conflicts: list[str] | None = None,
    ) -> ChangeProposal:
        reason = self._normalize_reason(reason, submitted_by)
        store = PersonaStore(self.data_root).load()
        loaded = store.records.get(relation_id)
        if loaded is None or not isinstance(loaded.record, Relation):
            raise ProposalError(f"unknown relation: {relation_id}")
        if loaded.record.status != "active":
            raise ProposalError("relation is already inactive")
        proposal = self._new_proposal(
            operation="unrelate",
            target_id=relation_id,
            target_entity_type="relation",
            base=loaded,
            patch=[ProposalPatch(field="status", before="active", after="archived")],
            reason=reason,
            submitted_by=submitted_by,
            confidence=confidence,
            evidence_refs=evidence_refs or [],
            conflicts=conflicts or [],
        )
        return self._save_proposals([proposal])[0]

    def accept(
        self,
        proposal_id: str,
        *,
        review_updates: dict[str, Any] | None = None,
        expected_proposal_revision: int | None = None,
        decision_reason: str = "",
    ) -> AppliedProposal:
        with proposal_lock(self.state_root):
            result = self._accept_locked(
                proposal_id,
                review_updates=review_updates,
                expected_proposal_revision=expected_proposal_revision,
                decision_reason=decision_reason,
            )
        if result.proposal.proposal_context.kind == "conversation":
            from .evaluations.business import notify_review

            notify_review(self.data_root, self.state_root)
        return result

    def _accept_locked(
        self,
        proposal_id: str,
        *,
        review_updates: dict[str, Any] | None = None,
        expected_proposal_revision: int | None = None,
        decision_reason: str = "",
        decision_source: Literal["human_review", "human_edit"] = "human_review",
        transaction: ExitStack | None = None,
    ) -> AppliedProposal:
        proposal = self.repository.get(proposal_id)
        if proposal.status not in {"pending_review", "deferred"}:
            raise ProposalError(f"proposal cannot be accepted from {proposal.status}")
        if (
            expected_proposal_revision is not None
            and proposal.proposal_revision != expected_proposal_revision
        ):
            raise StaleProposalError("审核页面已过期，请刷新后重新确认。")
        self._require_satisfied_dependencies(proposal)

        store = PersonaStore(self.data_root).load()
        now = _utc_now()
        loaded = None
        if proposal.operation in {"create", "relate"}:
            if proposal.target_id in store.records:
                self._complete_with_status(proposal, "stale", "目标 ID 已经存在。")
                raise StaleProposalError("proposal target already exists")
        else:
            loaded = self._require_current_target(store, proposal)

        effective_proposal, review_patch = self._apply_review_updates(
            proposal, loaded, review_updates or {}
        )
        if loaded is None:
            candidate, body = self._candidate_for_create(store, effective_proposal, now)
            writes = [(None, candidate, body, self._record_path(store, candidate))]
        else:
            candidate, body = self._candidate_for_existing(loaded, effective_proposal, now)
            if proposal.operation == "update":
                self._validate_candidate(store, candidate, body, replacing_id=candidate.id)
                if isinstance(candidate, Relation):
                    self._validate_new_relation(store, candidate, excluding_id=candidate.id)
            writes = [(loaded, candidate, body, loaded.path)]
            if proposal.operation == "archive" and isinstance(
                candidate, (KnowledgeNode, Course, Material)
            ):
                writes.extend(self._relation_archive_writes(store, candidate.id, now))

        try:
            writes.extend(
                self._inline_evidence_writes(store, effective_proposal, candidate, now)
            )
        except StaleProposalError as exc:
            self._complete_with_status(proposal, "stale", str(exc))
            raise

        staged_source: tuple[Path, Path] | None = None
        if isinstance(candidate, (Material, PreferenceExample)) and (
            candidate.source_ref not in store.sources
        ):
            try:
                staged = validate_staged_source(self.data_root, candidate.source_ref)
            except MaterialSourceError as exc:
                raise ProposalError(str(exc)) from exc
            staged_source = (
                staged.path,
                self.data_root / "sources" / candidate.source_ref,
            )

        self._ensure_unique_write_paths(writes)
        config_path = self.data_root / "config" / "persona.toml"
        revision_path = self.data_root / "revisions" / "changes.jsonl"
        previous_config = config_path.read_bytes()
        previous_revisions = revision_path.read_bytes() if revision_path.exists() else b""
        previous_files = {path: path.read_bytes() if path.exists() else None for _, _, _, path in writes}

        assert store.config is not None
        new_persona_revision = store.config.revision + 1
        config_text = previous_config.decode("utf-8")
        config_text, replacements = re.subn(
            r"(?m)^(revision\s*=\s*)\d+(\s*)$",
            rf"\g<1>{new_persona_revision}\g<2>",
            config_text,
            count=1,
        )
        if replacements != 1:
            raise ProposalError("persona config does not contain one revision field")

        change_entries = []
        for old, new, body, path in writes:
            new_loaded = LoadedRecord(record=new, body=body, path=path)
            change_entries.append(
                {
                    "object_id": new.id,
                    "old_revision": old.record.revision if old else None,
                    "new_revision": new.revision,
                    "old_hash": record_content_hash(old) if old else None,
                    "new_hash": record_content_hash(new_loaded),
                }
            )
        revision_entry = {
            "persona_revision": new_persona_revision,
            "published_at": _iso_utc(now),
            "actor": "human",
            "proposal_ids": [proposal.id],
            "changes": change_entries,
            "note": proposal.reason,
        }
        if decision_source == "human_edit":
            revision_entry["decision_source"] = decision_source
        if review_patch:
            revision_entry["review_patch"] = [
                item.model_dump(mode="json") for item in review_patch
            ]
            revision_entry["review_note"] = decision_reason.strip() or None
        revisions = previous_revisions
        if revisions and not revisions.endswith(b"\n"):
            revisions += b"\n"
        revisions += json.dumps(
            revision_entry,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8") + b"\n"

        history_path = self.repository.history_root / f"{proposal.id}.json"
        previous_history = history_path.read_bytes() if history_path.exists() else None
        pending_path = self.repository.pending_root / f"{proposal.id}.json"
        previous_pending = pending_path.read_bytes() if pending_path.exists() else None

        def rollback() -> None:
            for path, previous in previous_files.items():
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_write(path, previous)
            _atomic_write(config_path, previous_config)
            _atomic_write(revision_path, previous_revisions)
            if previous_history is None:
                history_path.unlink(missing_ok=True)
            else:
                _atomic_write(history_path, previous_history)
            if previous_pending is not None:
                _atomic_write(pending_path, previous_pending)
            if staged_source:
                restore_staged_source(*staged_source)

        try:
            if staged_source:
                publish_staged_source(self.data_root, candidate.source_ref)
            for _, new, body, path in writes:
                serialized = dump_markdown_record(
                    new.model_dump(mode="json", by_alias=True, exclude_none=True), body
                ).encode("utf-8")
                _atomic_write(path, serialized)
            _atomic_write(config_path, config_text.encode("utf-8"))
            PersonaStore(self.data_root).load()
            PersonaCompiler(self.data_root, self.state_root).build()
            _atomic_write(revision_path, revisions)
            accepted = proposal.model_copy(
                update={
                    "status": "edited_and_accepted" if review_patch else "accepted",
                    "review_patch": review_patch,
                    "decision_reason": decision_reason.strip() or None,
                    "proposal_revision": proposal.proposal_revision + 1,
                    "updated_at": now,
                    "decided_at": now,
                    "decision_source": decision_source,
                    "decision_parent_id": None,
                }
            )
            if proposal.proposal_context.kind == "conversation":
                from .evaluations.business import approved_content

                accepted = accepted.model_copy(update={
                    "approved_content": approved_content(proposal, candidate, body, review_patch)
                })
            self.repository.complete(accepted)
        except Exception:
            rollback()
            PersonaCompiler(self.data_root, self.state_root).build()
            raise
        if transaction is not None:
            transaction.callback(rollback)
        return AppliedProposal(
            proposal=accepted,
            persona_revision=new_persona_revision,
            record=candidate,
        )

    def _apply_review_updates(
        self,
        proposal: ChangeProposal,
        loaded: LoadedRecord | None,
        updates: dict[str, Any],
    ) -> tuple[ChangeProposal, list[ProposalPatch]]:
        """Apply human corrections in memory, retaining the original proposal for audit."""
        if not updates:
            return proposal, []
        if proposal.operation not in {"create", "update", "relate"}:
            raise ProposalError("此类提案不支持修改字段后通过。")
        model = type(loaded.record) if loaded else CREATE_TYPES.get(
            str(proposal.target_entity_type)
        )
        if proposal.target_entity_type == "relation":
            model = Relation
        allowed = review_update_fields(str(proposal.target_entity_type or (loaded.record.entity_type if loaded else "")), proposal.operation)
        unknown = set(updates) - allowed
        if unknown:
            raise ProposalError(f"unsupported review fields: {sorted(unknown)}")

        before = (
            loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
            if loaded else {}
        )
        before["body"] = loaded.body if loaded else ""
        defaults = {
            name: field.get_default(call_default_factory=True)
            for name, field in model.model_fields.items()
            if not field.is_required()
        } if model else {}
        suggested = {**defaults, **before, **{item.field: item.after for item in proposal.patch}}
        normalized = _normalize_newlines(updates)
        if "body" in normalized:
            normalized["body"] = str(normalized["body"]).strip()
        relation_values = {**suggested, **normalized}
        if model is Relation and relation_values.get("relation_type") == "related_to":
            source, target = relation_values.get("source_id"), relation_values.get("target_id")
            if source and target and source > target:
                normalized.update(source_id=target, target_id=source)
        review_patch = _proposal_patch(normalized, before=suggested)
        if not review_patch:
            return proposal, []
        final_values = {item.field: item.after for item in proposal.patch}
        final_values.update(normalized)
        effective_patch = _proposal_patch(
            final_values, before=before if loaded else None
        )
        if not effective_patch:
            raise ProposalError("修改后与当前记录一致，无需发布；可以拒绝此提案。")
        return proposal.model_copy(update={"patch": effective_patch}), review_patch

    def _require_satisfied_dependencies(self, proposal: ChangeProposal) -> None:
        try:
            manifest = ChangeSetRepository(self.data_root).find_by_proposal_id(proposal.id)
        except ChangeSetError as exc:
            raise ProposalError(str(exc)) from exc
        if manifest is None:
            return
        dependency_ids = manifest.transitive_dependencies_of(proposal.id)
        if not dependency_ids:
            return
        dependencies = [self.repository.get(item) for item in dependency_ids]
        failed = [
            item for item in dependencies if item.status in {"rejected", "stale"}
        ]
        if failed:
            parent = failed[0]
            self._reject_group_locked(
                proposal.id,
                f"Automatically rejected because dependency {parent.id} is {parent.status}.",
                decision_source="dependency_cascade",
                decision_parent_id=parent.id,
            )
            raise ProposalDependencyError(
                f"proposal was rejected because dependency {parent.id} is {parent.status}"
            )
        unresolved = [
            item
            for item in dependencies
            if item.status not in {"accepted", "edited_and_accepted"}
        ]
        if unresolved:
            states = ", ".join(f"{item.id} ({item.status})" for item in unresolved)
            raise ProposalDependencyError(
                f"review dependent proposals first: {states}"
            )

    def reject(self, proposal_id: str, reason: str = "") -> ChangeProposal:
        return self.reject_group(proposal_id, reason).root_proposal

    def reject_group(self, proposal_id: str, reason: str = "", *, expected_proposal_revision: int | None = None) -> RejectedProposalGroup:
        with proposal_lock(self.state_root):
            if expected_proposal_revision is not None and self.repository.get(proposal_id).proposal_revision != expected_proposal_revision:
                raise StaleProposalError("审核页面已过期，请刷新后重新确认。")
            return self._reject_group_locked(proposal_id, reason)

    def _reject_group_locked(
        self,
        proposal_id: str,
        reason: str = "",
        *,
        decision_source: Literal["human_review", "dependency_cascade"] = "human_review",
        decision_parent_id: str | None = None,
    ) -> RejectedProposalGroup:
        proposal = self.repository.get(proposal_id)
        if proposal.status not in {"pending_review", "deferred"}:
            raise ProposalError(f"proposal cannot be rejected from {proposal.status}")
        try:
            manifest = ChangeSetRepository(self.data_root).find_by_proposal_id(proposal_id)
        except ChangeSetError as exc:
            raise ProposalError(str(exc)) from exc
        dependent_ids = (
            manifest.transitive_dependents_of(proposal_id) if manifest is not None else []
        )
        dependents = [self.repository.get(item) for item in dependent_ids]
        already_published = [
            item.id
            for item in dependents
            if item.status in {"accepted", "edited_and_accepted"}
        ]
        if already_published:
            raise ProposalDependencyError(
                "cannot reject a proposal after dependent proposals were published: "
                + ", ".join(already_published)
            )
        rejected: list[ChangeProposal] = []
        now = _utc_now()
        for item in [proposal, *dependents]:
            if item.status not in {"pending_review", "deferred"}:
                continue
            is_root = item.id == proposal.id
            source = decision_source if is_root else "dependency_cascade"
            parent_id = decision_parent_id if is_root else proposal.id
            item_reason = (
                reason.strip() or None
                if is_root
                else f"Automatically rejected because dependency {proposal.id} was rejected."
            )
            rejected.append(
                item.model_copy(
                    update={
                        "status": "rejected",
                        "proposal_revision": item.proposal_revision + 1,
                        "updated_at": now,
                        "decided_at": now,
                        "decision_reason": item_reason,
                        "decision_source": source,
                        "decision_parent_id": parent_id,
                    }
                )
            )
        self.repository.complete_many(rejected)
        remaining_source_refs = {
            str(change.after)
            for pending in self.repository.list_pending()
            for change in pending.patch
            if change.field == "source_ref" and change.after
        }
        canonical_sources = PersonaStore(self.data_root).load().sources
        rejected_source_refs = {
            str(change.after)
            for item in rejected
            for change in item.patch
            if change.field == "source_ref" and change.after
        }
        for source_id in rejected_source_refs - remaining_source_refs - set(canonical_sources):
            try:
                discard_staged_source(self.data_root, source_id)
            except MaterialSourceError:
                # Rejection must remain successful if a staged source was already cleaned.
                pass
        root = next(item for item in rejected if item.id == proposal.id)
        return RejectedProposalGroup(root_proposal=root, rejected_proposals=rejected)

    def defer(self, proposal_id: str, reason: str = "", *, expected_proposal_revision: int | None = None) -> ChangeProposal:
        with proposal_lock(self.state_root):
            proposal = self.repository.get(proposal_id)
            if expected_proposal_revision is not None and proposal.proposal_revision != expected_proposal_revision:
                raise StaleProposalError("候选已更新，请刷新后重试。")
            if proposal.status not in {"pending_review", "deferred"}:
                raise ProposalError(f"proposal cannot be deferred from {proposal.status}")
            now = _utc_now()
            deferred = proposal.model_copy(
                update={
                    "status": "deferred",
                    "proposal_revision": proposal.proposal_revision + 1,
                    "updated_at": now,
                    "decision_reason": reason.strip() or None,
                }
            )
            self.repository.save_pending(deferred)
            return deferred

    def _new_proposal(
        self,
        *,
        operation: Literal[
            "create", "update", "archive", "restore", "relate", "unrelate"
        ],
        target_id: str,
        target_entity_type: str,
        patch: list[ProposalPatch],
        reason: str,
        base: LoadedRecord | None = None,
        submitted_by: Literal["human", "ai"] = "human",
        confidence: float = 1.0,
        evidence_refs: list[str] | None = None,
        evidence_candidates: list[ProposalEvidenceCandidate] | None = None,
        proposal_context: ProposalContext | None = None,
        conflicts: list[str] | None = None,
        duplicate_candidates: list[str] | None = None,
    ) -> ChangeProposal:
        now = _utc_now()
        return ChangeProposal.model_validate(
            {
                "schema": "ai-persona.change-proposal/v1",
                "id": f"prop_{uuid.uuid4().hex}",
                "proposal_revision": 1,
                "operation": operation,
                "status": "pending_review",
                "target_id": target_id,
                "target_entity_type": target_entity_type,
                "base_revision": base.record.revision if base else None,
                "base_hash": record_content_hash(base) if base else None,
                "patch": [item.model_dump(mode="json") for item in patch],
                "reason": reason,
                "evidence_refs": evidence_refs or [],
                "evidence_candidates": [
                    item.model_dump(mode="json") for item in (evidence_candidates or [])
                ],
                "proposal_context": (proposal_context or ProposalContext()).model_dump(
                    mode="json"
                ),
                "confidence": confidence,
                "conflicts": conflicts or [],
                "duplicate_candidates": duplicate_candidates or [],
                "submitted_by": submitted_by,
                "created_at": now,
                "updated_at": now,
            }
        )

    def _candidate_for_create(
        self, store: PersonaStore, proposal: ChangeProposal, now: datetime
    ) -> tuple[BaseRecord, str]:
        entity_type = proposal.target_entity_type
        if entity_type not in {*CREATE_TYPES, "relation"}:
            raise ProposalError(f"unsupported create target: {entity_type}")
        values = {change.field: change.after for change in proposal.patch}
        body = str(values.pop("body", "")).strip()
        payload = {
            "schema": SCHEMA_BY_TYPE[entity_type],
            "id": proposal.target_id,
            "entity_type": entity_type,
            "status": "active",
            "revision": 1,
            "created_at": _iso_utc(now),
            "updated_at": _iso_utc(now),
            **values,
        }
        candidate = self._parse_candidate(payload)
        self._validate_candidate(store, candidate, body)
        if isinstance(candidate, Relation):
            self._validate_new_relation(store, candidate)
        return candidate, body

    def _candidate_for_existing(
        self, loaded: LoadedRecord, proposal: ChangeProposal, now: datetime
    ) -> tuple[BaseRecord, str]:
        payload = loaded.record.model_dump(mode="json", by_alias=True, exclude_none=False)
        body = loaded.body
        for change in proposal.patch:
            if change.field == "body":
                body = str(_normalize_newlines(change.after)).strip()
            else:
                payload[change.field] = change.after
        payload["revision"] = loaded.record.revision + 1
        payload["updated_at"] = _iso_utc(now)
        return self._parse_candidate(payload), body

    def _inline_evidence_writes(
        self,
        store: PersonaStore,
        proposal: ChangeProposal,
        target: BaseRecord,
        now: datetime,
    ) -> list[tuple[None, BaseRecord, str, Path]]:
        if not proposal.evidence_candidates:
            return []
        context = proposal.proposal_context
        material_loaded = store.records.get(context.material_id or "")
        if context.kind != "maintenance" and (
            context.kind != "material"
            or material_loaded is None
            or not isinstance(material_loaded.record, Material)
            or material_loaded.record.status != "active"
            or material_loaded.record.source_ref != context.source_id
        ):
            raise StaleProposalError("material proposal source is no longer current")
        manifest = store.sources.get(context.source_id or "")
        if context.kind != "maintenance" and (manifest is None or f"sha256:{manifest.content_hash}" != context.source_hash):
            raise StaleProposalError("material source changed after the proposal was created")

        target_evidence_refs = set(getattr(target, "evidence_refs", []))
        candidate_ids = {item.id for item in proposal.evidence_candidates}
        # Preference records keep evidence through Evidence.supports and proposal history;
        # unlike knowledge/material/relation records, they have no evidence_refs field.
        if hasattr(target, "evidence_refs") and not candidate_ids <= target_evidence_refs:
            raise ProposalError("target record does not reference all inline evidence")

        writes: list[tuple[None, BaseRecord, str, Path]] = []
        for item in proposal.evidence_candidates:
            source_hash = context.source_hash
            if context.kind == "maintenance":
                manifest = store.sources.get(item.source_id)
                source_hash = context.source_versions.get(item.source_id)
                if manifest is None or f"sha256:{manifest.content_hash}" != source_hash:
                    raise StaleProposalError("maintenance source changed after submission")
            if item.id in store.records:
                raise StaleProposalError("inline evidence target already exists")
            if item.source_id != manifest.id or item.source_hash != source_hash:
                raise StaleProposalError("inline evidence source no longer matches the proposal")
            locator_file = item.locator.get("file")
            line_start = item.locator.get("line_start")
            line_end = item.locator.get("line_end")
            if (
                not isinstance(locator_file, str)
                or not isinstance(line_start, int)
                or not isinstance(line_end, int)
            ):
                raise ProposalError("inline evidence requires a file and integer line range")
            source_file = next(
                (entry for entry in manifest.files if entry.path == locator_file), None
            )
            if source_file is None or not source_file.media_type.startswith("text/"):
                raise StaleProposalError("inline evidence file is no longer readable as text")
            source_path = store.source_file_path(manifest.id, locator_file)
            lines = source_path.read_text(encoding="utf-8", errors="replace").splitlines()
            excerpt = "\n".join(lines[line_start - 1 : line_end]).strip()
            if not excerpt or excerpt != item.body:
                raise StaleProposalError("inline evidence excerpt changed after submission")
            evidence = Evidence.model_validate(
                {
                    "schema": "ai-persona.evidence/v1",
                    "id": item.id,
                    "entity_type": "evidence",
                    "status": "active",
                    "revision": 1,
                    "created_at": _iso_utc(now),
                    "updated_at": _iso_utc(now),
                    "source_id": item.source_id,
                    "source_hash": item.source_hash,
                    "locator": item.locator,
                    "supports": [proposal.target_id],
                    "evidence_kind": item.evidence_kind,
                    "extraction_method": item.extraction_method,
                    "confidence": item.confidence,
                }
            )
            writes.append((None, evidence, item.body, self._record_path(store, evidence)))
        return writes

    def _require_current_target(
        self, store: PersonaStore, proposal: ChangeProposal
    ) -> LoadedRecord:
        loaded = store.records.get(proposal.target_id)
        if loaded is None:
            self._complete_with_status(proposal, "stale", "目标记录已经不存在。")
            raise StaleProposalError("proposal target no longer exists")
        if (
            loaded.record.revision != proposal.base_revision
            or record_content_hash(loaded) != proposal.base_hash
        ):
            self._complete_with_status(proposal, "stale", "目标记录已在提案创建后发生变化。")
            raise StaleProposalError("proposal is stale because its target changed")
        return loaded

    def _relation_archive_writes(
        self, store: PersonaStore, record_id: str, now: datetime
    ) -> list[tuple[LoadedRecord, BaseRecord, str, Path]]:
        writes: list[tuple[LoadedRecord, BaseRecord, str, Path]] = []
        for loaded in store.loaded_of_type(Relation, active_only=True):
            relation = loaded.record
            if record_id not in {relation.source_id, relation.target_id}:
                continue
            payload = relation.model_dump(mode="json", by_alias=True, exclude_none=False)
            payload["status"] = "archived"
            payload["revision"] = relation.revision + 1
            payload["updated_at"] = _iso_utc(now)
            writes.append((loaded, self._parse_candidate(payload), loaded.body, loaded.path))
        return writes

    def _record_path(self, store: PersonaStore, record: BaseRecord) -> Path:
        records_root = self.data_root / "records"
        if isinstance(record, KnowledgeNode):
            return records_root / "knowledge-nodes" / f"{record.id}.md"
        if isinstance(record, Course):
            return records_root / "courses" / f"{record.id}.md"
        if isinstance(record, Material):
            return records_root / "materials" / f"{record.id}.md"
        if isinstance(record, Evidence):
            return records_root / "evidence" / f"{record.id}.md"
        if isinstance(record, Relation):
            return records_root / "relations" / f"{record.id}.md"
        if isinstance(record, PreferenceContext):
            return records_root / "preference-contexts" / f"{record.id}.md"
        if isinstance(record, Preference):
            return records_root / "preferences" / f"{record.id}.md"
        if isinstance(record, PreferenceExample):
            return records_root / "preference-examples" / f"{record.id}.md"
        if isinstance(record, Tag):
            return records_root / "tags" / f"{record.id}.md"
        raise ProposalError(f"no canonical path for {record.entity_type}")

    def _validate_candidate(
        self,
        store: PersonaStore,
        candidate: BaseRecord,
        body: str,
        *,
        replacing_id: str | None = None,
        context_candidates: list[PreferenceContext] | None = None,
    ) -> None:
        tags = getattr(candidate, "tags", [])
        known_tags = {tag.id for tag in store.of_type(Tag, active_only=True)}
        if replacing_id:
            existing = store.records.get(replacing_id)
            if existing is not None:
                known_tags.update(getattr(existing.record, "tags", []))
        if not set(tags) <= known_tags:
            raise ProposalError(f"unknown active tag refs: {sorted(set(tags) - known_tags)}")
        if isinstance(candidate, Tag):
            candidate_key = (
                candidate.namespace.strip().casefold(),
                candidate.slug.strip().casefold(),
            )
            for tag in store.of_type(Tag, active_only=False):
                if tag.id == replacing_id:
                    continue
                other_key = (tag.namespace.strip().casefold(), tag.slug.strip().casefold())
                if other_key == candidate_key:
                    raise ProposalError(
                        f"tag namespace and slug are already used by {tag.id}"
                    )
        if isinstance(candidate, PreferenceContext):
            for context in [*store.of_type(PreferenceContext, active_only=False),
                            *(context_candidates or [])]:
                if context.id != replacing_id and context.status != "archived" and (
                    context.key == candidate.key
                ):
                    raise ProposalError(f"偏好场景键已被 {context.id} 使用")
        if isinstance(candidate, Preference):
            contexts = {
                context.id: context
                for context in store.of_type(PreferenceContext, active_only=False)
            }
            contexts.update({context.id: context for context in context_candidates or []})
            for context_id in candidate.context_refs:
                context = contexts.get(context_id)
                if context is None or context.status == "archived":
                    raise ProposalError(f"未找到可用的偏好场景: {context_id}")
            candidate_instruction = " ".join(candidate.instruction.split()).casefold()
            for preference in store.of_type(Preference, active_only=False):
                if preference.id == replacing_id or preference.status == "archived":
                    continue
                same_instruction = (
                    " ".join(preference.instruction.split()).casefold()
                    == candidate_instruction
                )
                if (
                    same_instruction
                    and preference.scope == candidate.scope
                    and set(preference.context_refs) == set(candidate.context_refs)
                ):
                    raise ProposalError(f"相同适用范围已有重复偏好: {preference.id}")
        if isinstance(candidate, PreferenceExample):
            if body.strip():
                raise ProposalError("参考样本正文必须保存在 Source 文件中")
            contexts = {
                context.id: context
                for context in store.of_type(PreferenceContext, active_only=False)
            }
            contexts.update({context.id: context for context in context_candidates or []})
            for context_id in candidate.context_refs:
                context = contexts.get(context_id)
                if context is None or context.status == "archived":
                    raise ProposalError(f"未找到可用的偏好场景: {context_id}")
            candidate_source = store.sources.get(candidate.source_ref)
            if candidate_source is None:
                try:
                    candidate_source = validate_staged_source(
                        self.data_root, candidate.source_ref
                    ).manifest
                except MaterialSourceError as exc:
                    raise ProposalError(str(exc)) from exc
            if candidate.content_hash != f"sha256:{candidate_source.content_hash}":
                raise ProposalError("参考样本文件哈希与 Source 不一致")
        if isinstance(candidate, Evidence):
            source = store.sources.get(candidate.source_id)
            if source is None:
                raise ProposalError(f"unknown evidence source: {candidate.source_id}")
            if candidate.source_hash != f"sha256:{source.content_hash}":
                raise ProposalError("Evidence Source Hash 与当前 Source 不一致")
            for supported_id in candidate.supports:
                supported = store.records.get(supported_id)
                if supported is None or supported.record.status != "active":
                    raise ProposalError(f"invalid active evidence target: {supported_id}")
        if isinstance(candidate, Material):
            candidate_source = store.sources.get(candidate.source_ref)
            if candidate_source is None:
                try:
                    candidate_source = validate_staged_source(
                        self.data_root, candidate.source_ref
                    ).manifest
                except MaterialSourceError as exc:
                    raise ProposalError(str(exc)) from exc
            if candidate_source.source_type not in {candidate.material_type, "task_attachment"}:
                raise ProposalError("Source 类型必须与 Material 类型一致")
            candidate_ids = candidate.bibliography.identifiers.model_dump()
            for other in store.of_type(Material, active_only=True):
                if other.id == replacing_id:
                    continue
                other_ids = other.bibliography.identifiers.model_dump()
                for identifier_type, value in candidate_ids.items():
                    if not value or not other_ids[identifier_type]:
                        continue
                    if str(value).strip().casefold() == str(
                        other_ids[identifier_type]
                    ).strip().casefold():
                        raise ProposalError(
                            f"{identifier_type} 已被 Material {other.id} 使用"
                        )
                if store.sources[other.source_ref].content_hash == candidate_source.content_hash:
                    raise ProposalError(f"相同原文已经由 Material {other.id} 保存")
        if replacing_id and candidate.id != replacing_id:
            raise ProposalError("an update cannot change a stable record id")

    def _validate_new_relation(
        self,
        store: PersonaStore,
        candidate: Relation,
        *,
        excluding_id: str | None = None,
    ) -> None:
        source = store.records.get(candidate.source_id)
        target = store.records.get(candidate.target_id)
        if source is None or target is None:
            raise ProposalError("relation endpoints must exist")
        if source.record.status != "active" or target.record.status != "active":
            raise ProposalError("relation endpoints must be active")
        if candidate.relation_type == "covers":
            if not isinstance(source.record, (Course, Material)) or not isinstance(
                target.record, KnowledgeNode
            ):
                raise ProposalError("covers requires course/material -> knowledge node")
            if isinstance(source.record, Material) and not all(
                (candidate.knowledge_role, candidate.salience, candidate.statement)
            ):
                raise ProposalError(
                    "material knowledge relations require role, salience, and statement"
                )
            if (
                isinstance(source.record, Material)
                and isinstance(target.record, KnowledgeNode)
                and candidate.statement
                and candidate.statement.strip().casefold()
                in {
                    target.record.title.strip().casefold(),
                    *(alias.strip().casefold() for alias in target.record.aliases),
                }
            ):
                raise ProposalError("关系说明需要说清具体联系，不能只重复知识名称")
        elif not isinstance(source.record, KnowledgeNode) or not isinstance(
            target.record, KnowledgeNode
        ):
            raise ProposalError("knowledge relations require knowledge node endpoints")
        for relation in store.of_type(Relation, active_only=True):
            if relation.id == excluding_id:
                continue
            if (
                relation.source_id,
                relation.relation_type,
                relation.target_id,
                relation.knowledge_role,
            ) == (
                candidate.source_id,
                candidate.relation_type,
                candidate.target_id,
                candidate.knowledge_role,
            ):
                raise ProposalError("the same active relation already exists")
        if candidate.relation_type == "broader_than" and any(
            ancestor == candidate.target_id and descendant == candidate.source_id
            for ancestor, descendant, _ in store.relation_closure()
        ):
            raise ProposalError("this broader-than relation would create a cycle")

    @staticmethod
    def _allowed_update_fields(record: BaseRecord) -> set[str]:
        for model, fields in UPDATE_FIELDS.items():
            if isinstance(record, model):
                return fields
        return set()

    @staticmethod
    def _parse_candidate(payload: dict[str, Any]) -> BaseRecord:
        try:
            return parse_record(payload)
        except (ValidationError, ValueError) as exc:
            raise ProposalError(f"candidate record is invalid: {exc}") from exc

    @staticmethod
    def _normalize_reason(reason: str, submitted_by: str) -> str:
        cleaned = reason.strip()
        if submitted_by == "ai" and not cleaned:
            raise ProposalError("AI proposals require a reason")
        return cleaned

    @staticmethod
    def _duplicate_candidates(
        store: PersonaStore,
        candidate: BaseRecord,
        *,
        excluding_id: str | None = None,
    ) -> list[str]:
        if not isinstance(candidate, (KnowledgeNode, Course, Material, Tag)):
            return []
        candidate_name = (
            candidate.label if isinstance(candidate, Tag) else candidate.title
        )
        names = {
            candidate_name.strip().casefold(),
            *(item.strip().casefold() for item in candidate.aliases),
        }
        duplicates: list[str] = []
        candidates = (
            store.of_type(Tag, active_only=False)
            if isinstance(candidate, Tag)
            else (loaded.record for loaded in store.active_knowledge())
        )
        for record in candidates:
            if record.id == excluding_id:
                continue
            if type(record) is not type(candidate):
                continue
            record_name = record.label if isinstance(record, Tag) else record.title
            other_names = {
                record_name.strip().casefold(),
                *(item.strip().casefold() for item in record.aliases),
            }
            if names & other_names:
                duplicates.append(record.id)
                continue
            if isinstance(candidate, Material) and isinstance(record, Material):
                candidate_ids = candidate.bibliography.identifiers.model_dump()
                record_ids = record.bibliography.identifiers.model_dump()
                if any(
                    candidate_ids[key]
                    and record_ids[key]
                    and str(candidate_ids[key]).strip().casefold()
                    == str(record_ids[key]).strip().casefold()
                    for key in candidate_ids
                ):
                    duplicates.append(record.id)
                    continue
                same_year = (
                    candidate.bibliography.published_at
                    and record.bibliography.published_at
                    and candidate.bibliography.published_at[:4]
                    == record.bibliography.published_at[:4]
                )
                candidate_authors = {
                    item.casefold() for item in candidate.bibliography.authors
                }
                record_authors = {item.casefold() for item in record.bibliography.authors}
                title_similarity = SequenceMatcher(
                    None, candidate.title.casefold(), record.title.casefold()
                ).ratio()
                if (
                    title_similarity >= 0.88
                    and (same_year or bool(candidate_authors & record_authors))
                ):
                    duplicates.append(record.id)
        return sorted(duplicates)

    @staticmethod
    def _ensure_unique_write_paths(
        writes: list[tuple[LoadedRecord | None, BaseRecord, str, Path]]
    ) -> None:
        paths = [path.resolve() for _, _, _, path in writes]
        if len(paths) != len(set(paths)):
            raise ProposalError("proposal would write the same record twice")

    def _complete_with_status(
        self,
        proposal: ChangeProposal,
        status: Literal["rejected", "stale"],
        reason: str | None,
    ) -> ChangeProposal:
        now = _utc_now()
        completed = proposal.model_copy(
            update={
                "status": status,
                "proposal_revision": proposal.proposal_revision + 1,
                "updated_at": now,
                "decided_at": now,
                "decision_reason": reason,
                "decision_source": "system" if status == "stale" else "human_review",
                "decision_parent_id": None,
            }
        )
        self.repository.complete(completed)
        return completed
