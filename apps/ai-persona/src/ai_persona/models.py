from __future__ import annotations

import re
from datetime import datetime
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

KnowledgeLevel = Literal["proficient", "familiar", "aware", "unspecified"]
InterestLevel = Literal["high", "medium", "low", "unspecified"]
MaterialPreferenceLevel = Literal["favorite", "liked", "neutral", "disliked", "unspecified"]
MaterialRelationship = Literal["authored", "studied", "read", "skimmed"]
MaterialKnowledgeRole = Literal[
    "topic",
    "problem",
    "method",
    "theory",
    "model",
    "application",
    "result",
    "background",
    "mentioned",
]
RelationSalience = Literal["primary", "secondary", "mentioned"]
RecordStatus = Literal["active", "archived"]
PreferenceStatus = Literal["active", "paused", "archived"]
ProposalStatus = Literal[
    "draft",
    "pending_review",
    "accepted",
    "edited_and_accepted",
    "rejected",
    "deferred",
    "stale",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class BaseRecord(StrictModel):
    schema_id: str = Field(alias="schema", serialization_alias="schema")
    id: str
    entity_type: str
    status: RecordStatus
    revision: int = Field(ge=1)
    created_at: datetime
    updated_at: datetime

    expected_schema: ClassVar[str]
    expected_entity_type: ClassVar[str]
    expected_id_prefix: ClassVar[str]

    @field_validator("id")
    @classmethod
    def id_must_not_contain_paths(cls, value: str) -> str:
        if not value or any(character in value for character in "/\\\0"):
            raise ValueError("id must be non-empty and path-independent")
        return value

    @model_validator(mode="after")
    def validate_record_contract(self) -> BaseRecord:
        if self.schema_id != self.expected_schema:
            raise ValueError(f"schema must be {self.expected_schema!r}")
        if self.entity_type != self.expected_entity_type:
            raise ValueError(f"entity_type must be {self.expected_entity_type!r}")
        if not self.id.startswith(self.expected_id_prefix):
            raise ValueError(f"id must start with {self.expected_id_prefix!r}")
        if self.updated_at < self.created_at:
            raise ValueError("updated_at cannot be earlier than created_at")
        return self


class KnowledgeRecord(BaseRecord):
    title: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    knowledge_level: KnowledgeLevel = "unspecified"
    interest_level: InterestLevel
    summary: str = ""
    scope_note: str | None = None
    tags: list[str] = Field(default_factory=list)
    evidence_refs: list[str] = Field(default_factory=list)


class KnowledgeNode(KnowledgeRecord):
    schema_id: Literal["ai-persona.knowledge-node/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["knowledge_node"]
    semantic_role: Literal[
        "domain",
        "area",
        "topic",
        "concept",
        "theory",
        "model",
        "method",
        "technique",
        "tool",
    ]

    expected_schema = "ai-persona.knowledge-node/v1"
    expected_entity_type = "knowledge_node"
    expected_id_prefix = "kn_"


class Course(BaseRecord):
    schema_id: Literal["ai-persona.course/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["course"]
    title: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    knowledge_level: KnowledgeLevel = "unspecified"
    interest_level: InterestLevel
    description: str = ""
    syllabus: str = ""
    tags: list[str] = Field(default_factory=list)

    expected_schema = "ai-persona.course/v1"
    expected_entity_type = "course"
    expected_id_prefix = "crs_"


class BibliographicIdentifiers(StrictModel):
    arxiv: str | None = None
    doi: str | None = None
    isbn: str | None = None

    @field_validator("arxiv")
    @classmethod
    def normalize_arxiv(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = re.sub(r"(?i)^arxiv:\s*", "", value.strip())
        if not re.fullmatch(
            r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?",
            normalized,
            flags=re.IGNORECASE,
        ):
            raise ValueError("arxiv must be a canonical arXiv identifier")
        return normalized

    @field_validator("doi")
    @classmethod
    def normalize_doi(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = re.sub(
            r"(?i)^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip()
        ).casefold()
        if not re.fullmatch(r"10\.\d{4,9}/\S+", normalized):
            raise ValueError("doi must be a canonical DOI")
        return normalized

    @field_validator("isbn")
    @classmethod
    def normalize_isbn(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = re.sub(r"[\s-]", "", value).upper()
        if not re.fullmatch(r"(?:\d{9}[\dX]|\d{13})", normalized):
            raise ValueError("isbn must contain 10 or 13 valid ISBN characters")
        return normalized


class Bibliography(StrictModel):
    authors: list[str] = Field(default_factory=list)
    published_at: str | None = Field(
        default=None,
        pattern=r"^\d{4}(?:-\d{2}(?:-\d{2})?)?$",
    )
    venue: str | None = None
    language: str | None = None
    identifiers: BibliographicIdentifiers = Field(default_factory=BibliographicIdentifiers)
    canonical_url: str | None = None

    @field_validator("canonical_url")
    @classmethod
    def canonical_url_is_web_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not re.match(r"^https?://[^\s]+$", normalized, flags=re.IGNORECASE):
            raise ValueError("canonical_url must be an http or https URL")
        return normalized

    @model_validator(mode="after")
    def published_date_is_valid(self) -> Bibliography:
        if not self.published_at:
            return self
        try:
            if len(self.published_at) == 4:
                datetime.strptime(self.published_at, "%Y")
            elif len(self.published_at) == 7:
                datetime.strptime(self.published_at, "%Y-%m")
            else:
                datetime.strptime(self.published_at, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("published_at must be a valid calendar date") from exc
        return self


class MaterialPreferenceReason(StrictModel):
    aspect: Literal[
        "topic",
        "method",
        "result",
        "research-direction",
        "writing-style",
        "visualization",
        "practicality",
        "other",
    ]
    note: str = Field(min_length=1)

    @field_validator("note")
    @classmethod
    def note_is_meaningful(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("preference reason note cannot be blank")
        return normalized


class Material(BaseRecord):
    schema_id: Literal["ai-persona.material/v3"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["material"]
    material_type: Literal[
        "article",
        "note",
        "paper",
        "book",
        "course_material",
        "conversation",
        "resume",
        "other",
    ]
    title: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)
    abstract: str = ""
    bibliography: Bibliography
    user_relationships: list[MaterialRelationship] = Field(default_factory=list)
    knowledge_level: KnowledgeLevel = "unspecified"
    preference_level: MaterialPreferenceLevel
    preference_reasons: list[MaterialPreferenceReason] = Field(default_factory=list)
    summary: str = ""
    scope_note: str | None = None
    tags: list[str] = Field(default_factory=list)
    source_ref: str
    evidence_refs: list[str] = Field(default_factory=list)

    expected_schema = "ai-persona.material/v3"
    expected_entity_type = "material"
    expected_id_prefix = "mat_"

    @field_validator("schema_id", mode="before")
    @classmethod
    def migrate_v2(cls, value):
        # Lossless read migration; canonical files change only through reviewed writes.
        return "ai-persona.material/v3" if value == "ai-persona.material/v2" else value

    @field_validator("title")
    @classmethod
    def title_is_meaningful(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("material title cannot be blank")
        return normalized

    @field_validator("aliases", "tags", "evidence_refs")
    @classmethod
    def references_cannot_repeat(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("material list fields cannot contain duplicates")
        return value

    @model_validator(mode="after")
    def validate_user_relationships(self) -> Material:
        if len(self.user_relationships) != len(set(self.user_relationships)):
            raise ValueError("user_relationships cannot contain duplicates")
        reading_states = {"studied", "read", "skimmed"}.intersection(
            self.user_relationships
        )
        if len(reading_states) > 1:
            raise ValueError("a material can have at most one reading relationship")
        return self


class Relation(BaseRecord):
    schema_id: Literal["ai-persona.relation/v2"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["relation"]
    source_id: str
    relation_type: Literal[
        "broader_than",
        "part_of",
        "applied_in",
        "requires",
        "related_to",
        "covers",
    ]
    target_id: str
    knowledge_role: MaterialKnowledgeRole | None = None
    salience: RelationSalience | None = None
    statement: str | None = Field(default=None, min_length=1)
    evidence_refs: list[str] = Field(default_factory=list)

    expected_schema = "ai-persona.relation/v2"
    expected_entity_type = "relation"
    expected_id_prefix = "rel_"

    @field_validator("statement")
    @classmethod
    def statement_is_meaningful(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("relation statement cannot be blank")
        return normalized

    @model_validator(mode="after")
    def endpoints_must_differ(self) -> Relation:
        if self.source_id == self.target_id:
            raise ValueError("a relation cannot point to itself")
        if self.relation_type == "related_to" and self.source_id > self.target_id:
            raise ValueError("related_to endpoints must be stored in lexical id order")
        qualifiers = (self.knowledge_role, self.salience, self.statement)
        if self.relation_type != "covers" and any(item is not None for item in qualifiers):
            raise ValueError("knowledge relation qualifiers are only valid for covers")
        return self


class Tag(BaseRecord):
    schema_id: Literal["ai-persona.tag/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["tag"]
    namespace: str = Field(min_length=1)
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    label: str = Field(min_length=1)
    aliases: list[str] = Field(default_factory=list)

    expected_schema = "ai-persona.tag/v1"
    expected_entity_type = "tag"
    expected_id_prefix = "tag_"


class Evidence(BaseRecord):
    schema_id: Literal["ai-persona.evidence/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["evidence"]
    source_id: str
    source_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    locator: dict[str, str | int | None]
    supports: list[str] = Field(min_length=1)
    evidence_kind: Literal[
        "explicit_user_statement",
        "authored_material",
        "read_signal",
        "user_feedback",
        "human_edit",
        "inferred_pattern",
    ]
    extraction_method: str
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)

    expected_schema = "ai-persona.evidence/v1"
    expected_entity_type = "evidence"
    expected_id_prefix = "ev_"

    @field_validator("locator")
    @classmethod
    def locator_file_is_source_relative(
        cls, value: dict[str, str | int | None]
    ) -> dict[str, str | int | None]:
        file_ref = value.get("file")
        if isinstance(file_ref, str):
            normalized = file_ref.replace("\\", "/")
            if (
                normalized.startswith("/")
                or re.match(r"^[A-Za-z]:/", normalized)
                or ".." in normalized.split("/")
                or "\0" in normalized
            ):
                raise ValueError("locator file must be a source-relative path")
        return value


class ProposalContext(StrictModel):
    kind: Literal["general", "material", "conversation", "maintenance"] = "general"
    source_versions: dict[str, str] = Field(default_factory=dict)
    learning_batch_id: str | None = Field(default=None, pattern=r"^learn_[a-f0-9]{32}$")
    material_id: str | None = None
    source_id: str | None = None
    source_hash: str | None = Field(
        default=None, pattern=r"^sha256:[0-9a-f]{64}$"
    )

    @model_validator(mode="after")
    def material_context_is_complete(self) -> ProposalContext:
        if self.kind != "maintenance" and self.source_versions:
            raise ValueError("source_versions requires maintenance context")
        material_values = (self.material_id, self.source_id, self.source_hash)
        if self.kind == "material" and not all(material_values):
            raise ValueError(
                "material proposal context requires material_id, source_id, and source_hash"
            )
        if self.kind == "general" and any(value is not None for value in material_values):
            raise ValueError("general proposal context cannot name a material source")
        if self.kind == "conversation":
            if not self.learning_batch_id or any(value is not None for value in material_values):
                raise ValueError("conversation context requires a learning batch, not a Source")
        elif self.learning_batch_id is not None:
            raise ValueError("only conversation context can name a learning batch")
        return self


class ProposalEvidenceCandidate(StrictModel):
    id: str
    source_id: str
    source_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    locator: dict[str, str | int | None]
    evidence_kind: Literal[
        "explicit_user_statement",
        "authored_material",
        "read_signal",
        "user_feedback",
        "human_edit",
        "inferred_pattern",
    ]
    extraction_method: str = Field(min_length=1)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    body: str = Field(min_length=1, max_length=20_000)

    @field_validator("id")
    @classmethod
    def evidence_id_is_safe(cls, value: str) -> str:
        if not value.startswith("ev_") or any(character in value for character in "/\\\0"):
            raise ValueError("evidence candidate id must start with 'ev_' and be path-independent")
        return value

    @field_validator("locator")
    @classmethod
    def locator_file_is_source_relative(
        cls, value: dict[str, str | int | None]
    ) -> dict[str, str | int | None]:
        file_ref = value.get("file")
        if isinstance(file_ref, str):
            normalized = file_ref.replace("\\", "/")
            if (
                normalized.startswith("/")
                or re.match(r"^[A-Za-z]:/", normalized)
                or ".." in normalized.split("/")
                or "\0" in normalized
            ):
                raise ValueError("locator file must be a source-relative path")
        return value


class Activation(StrictModel):
    # Retain the storage key so existing contexts and proposals remain compatible.
    intents: list[str] = Field(
        default_factory=list,
        description=(
            "Typical user requests that should activate this context. These are positive "
            "semantic examples, not trigger keywords or an exhaustive list of allowed requests."
        ),
    )
    artifact_types: list[str] = Field(default_factory=list)
    excludes: list[str] = Field(default_factory=list)


class PreferenceContext(BaseRecord):
    schema_id: Literal["ai-persona.preference-context/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["preference_context"]
    status: PreferenceStatus
    key: str = Field(pattern=r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")
    name: str = Field(min_length=1)
    description: str = Field(
        default="", description="When this context should be used, including its scope and boundaries."
    )
    activation: Activation = Field(default_factory=Activation)

    expected_schema = "ai-persona.preference-context/v1"
    expected_entity_type = "preference_context"
    expected_id_prefix = "pctx_"


class Preference(BaseRecord):
    schema_id: Literal["ai-persona.preference/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["preference"]
    status: PreferenceStatus
    scope: Literal["global", "contexts"] = "global"
    context_refs: list[str] = Field(default_factory=list)
    behavior: Literal["required", "preferred", "avoid"]
    instruction: str = Field(min_length=1)
    condition: str = ""
    rationale: str = ""

    expected_schema = "ai-persona.preference/v1"
    expected_entity_type = "preference"
    expected_id_prefix = "pref_"

    @model_validator(mode="after")
    def validate_scope(self) -> Preference:
        if len(self.context_refs) != len(set(self.context_refs)):
            raise ValueError("context_refs cannot contain duplicates")
        if self.scope == "global" and self.context_refs:
            raise ValueError("global preferences cannot name contexts")
        if self.scope == "contexts" and not self.context_refs:
            raise ValueError("context preferences require at least one context")
        return self


class PreferenceExample(BaseRecord):
    schema_id: Literal["ai-persona.preference-example/v3"] = Field(
        alias="schema", serialization_alias="schema"
    )
    entity_type: Literal["preference_example"]
    status: PreferenceStatus
    context_refs: list[str] = Field(min_length=1)
    example_type: Literal["positive", "negative"]
    title: str = Field(min_length=1)
    condition: str = ""
    reasons: list[str] = Field(default_factory=list)
    source_ref: str
    content_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    expected_schema = "ai-persona.preference-example/v3"
    expected_entity_type = "preference_example"
    expected_id_prefix = "pex_"

    @model_validator(mode="after")
    def references_cannot_repeat(self) -> PreferenceExample:
        if len(self.context_refs) != len(set(self.context_refs)):
            raise ValueError("context_refs cannot contain duplicates")
        return self


class SourceFile(StrictModel):
    path: str
    role: Literal["original", "extracted_text", "attachment"]
    media_type: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class SourceOrigin(StrictModel):
    provider: str = Field(min_length=1)
    identifier: str | None = None
    version: str | None = None
    url: str | None = None
    retrieved_at: datetime | None = None

    @field_validator("url")
    @classmethod
    def source_url_is_web_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not re.match(r"^https?://[^\s]+$", value, flags=re.IGNORECASE):
            raise ValueError("source origin URL must use http or https")
        return value


class SourceExtraction(StrictModel):
    tool: str = Field(min_length=1)
    version: str = Field(min_length=1)


class SourceManifest(StrictModel):
    schema_id: Literal["ai-persona.source-manifest/v2"] = Field(
        alias="schema", serialization_alias="schema"
    )
    id: str
    source_type: Literal[
        "article",
        "note",
        "paper",
        "book",
        "course_material",
        "conversation",
        "resume",
        "manual_declaration",
        "task_attachment",
        "other",
    ]
    imported_at: datetime
    origin: SourceOrigin
    canonical_file: str
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    files: list[SourceFile] = Field(min_length=1)
    extraction: SourceExtraction | None = None

    @field_validator("id")
    @classmethod
    def source_id_has_prefix(cls, value: str) -> str:
        if not value.startswith("src_"):
            raise ValueError("source id must start with 'src_'")
        return value


class ProposalPatch(StrictModel):
    field: Literal[
        "activation",
        "abstract",
        "behavior",
        "title",
        "aliases",
        "avoid",
        "content_hash",
        "confidence",
        "condition",
        "context_refs",
        "description",
        "bibliography",
        "evidence_refs",
        "evidence_kind",
        "example_type",
        "instruction",
        "knowledge_level",
        "knowledge_role",
        "label",
        "interest_level",
        "material_type",
        "locator",
        "name",
        "namespace",
        "key",
        "preference_level",
        "preference_reasons",
        "rationale",
        "reasons",
        "relation_type",
        "salience",
        "semantic_role",
        "statement",
        "summary",
        "syllabus",
        "scope_note",
        "slug",
        "supports",
        "source_id",
        "source_hash",
        "source_ref",
        "status",
        "scope",
        "tags",
        "target_id",
        "extraction_method",
        "user_relationships",
        "body",
    ]
    before: Any
    after: Any


class ChangeProposal(StrictModel):
    model_config = ConfigDict(json_schema_extra={
        "if": {"properties": {"submitted_by": {"const": "ai"}}, "required": ["submitted_by"]},
        "then": {"required": ["reason"], "properties": {"reason": {"pattern": r"\S"}}},
    })

    schema_id: Literal["ai-persona.change-proposal/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    id: str
    proposal_revision: int = Field(ge=1)
    operation: Literal[
        "create", "update", "archive", "restore", "relate", "unrelate"
    ]
    status: ProposalStatus
    target_id: str
    target_entity_type: Literal[
        "knowledge_node",
        "course",
        "material",
        "evidence",
        "relation",
        "preference_context",
        "preference",
        "preference_example",
        "tag",
    ] | None = None
    base_revision: int | None = Field(default=None, ge=1)
    base_hash: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    patch: list[ProposalPatch] = Field(min_length=1)
    reason: str = ""
    evidence_refs: list[str] = Field(default_factory=list)
    evidence_candidates: list[ProposalEvidenceCandidate] = Field(
        default_factory=list, max_length=20
    )
    proposal_context: ProposalContext = Field(default_factory=ProposalContext)
    confidence: float | None = Field(ge=0.0, le=1.0)
    conflicts: list[str] = Field(default_factory=list)
    duplicate_candidates: list[str] = Field(default_factory=list)
    submitted_by: Literal["human", "ai"]
    created_at: datetime
    updated_at: datetime
    decided_at: datetime | None = None
    decision_reason: str | None = None
    decision_source: Literal["human_review", "human_edit", "dependency_cascade", "system"] | None = None
    decision_parent_id: str | None = Field(
        default=None, pattern=r"^prop_[A-Za-z0-9_-]+$"
    )
    review_patch: list[ProposalPatch] = Field(default_factory=list)
    # Confirmed business fields, not chat evidence. Preserved at review commit
    # so later Persona edits cannot change a benchmark's historical answer.
    approved_content: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_proposal_contract(self) -> ChangeProposal:
        if self.confidence is None and self.proposal_context.kind not in {"conversation", "maintenance"}:
            raise ValueError("only conversation/maintenance proposals may omit confidence")
        if self.submitted_by == "ai" and not self.reason.strip():
            raise ValueError("AI proposals require a reason")
        if not self.id.startswith("prop_") or any(character in self.id for character in "/\\\0"):
            raise ValueError("proposal id must start with 'prop_' and be path-independent")
        if self.updated_at < self.created_at:
            raise ValueError("updated_at cannot be earlier than created_at")
        fields = [item.field for item in self.patch]
        if len(fields) != len(set(fields)):
            raise ValueError("proposal patch cannot update the same field twice")
        review_fields = [item.field for item in self.review_patch]
        if len(review_fields) != len(set(review_fields)):
            raise ValueError("review patch cannot update the same field twice")
        if bool(self.review_patch) != (self.status == "edited_and_accepted"):
            raise ValueError("review edits require edited_and_accepted status")
        if self.decision_source == "human_edit" and (
            self.submitted_by != "human" or self.status != "accepted"
        ):
            raise ValueError("human edits require an accepted human submission")
        if self.decision_source == "dependency_cascade":
            if self.status != "rejected" or not self.decision_parent_id:
                raise ValueError(
                    "dependency cascade decisions require a rejected status and parent id"
                )
        elif self.decision_parent_id is not None:
            raise ValueError("decision_parent_id requires dependency_cascade source")
        candidate_ids = [item.id for item in self.evidence_candidates]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("proposal evidence candidate ids must be unique")
        if self.evidence_candidates:
            if self.proposal_context.kind not in {"material", "maintenance"}:
                raise ValueError("inline evidence requires material proposal context")
            if self.operation not in {"create", "update", "relate"}:
                raise ValueError("inline evidence only supports create, update, and relate")
            if self.target_entity_type not in {
                "knowledge_node", "material", "course", "relation", "preference", "preference_context",
                "preference_example",
            }:
                raise ValueError("this proposal target cannot own inline evidence")
            if not set(candidate_ids) <= set(self.evidence_refs):
                raise ValueError("proposal evidence_refs must include inline evidence ids")
            if self.proposal_context.kind == "maintenance" and any(
                self.proposal_context.source_versions.get(item.source_id) != item.source_hash
                for item in self.evidence_candidates
            ):
                raise ValueError("inline evidence must use a registered maintenance source")
            if self.proposal_context.kind == "material" and any(
                item.source_id != self.proposal_context.source_id
                or item.source_hash != self.proposal_context.source_hash
                for item in self.evidence_candidates
            ):
                raise ValueError("inline evidence must use the proposal material source")
        if self.operation in {"create", "relate"}:
            if self.base_revision is not None or self.base_hash is not None:
                raise ValueError(f"{self.operation} proposals cannot have a base record")
            if self.target_entity_type is None:
                raise ValueError(f"{self.operation} proposals require target_entity_type")
        else:
            if self.base_revision is None or self.base_hash is None:
                raise ValueError(f"{self.operation} proposals require a base record")
        return self


Record = (
    KnowledgeNode
    | Course
    | Material
    | Relation
    | Tag
    | Evidence
    | PreferenceContext
    | Preference
    | PreferenceExample
)


RECORD_MODELS: dict[str, type[BaseRecord]] = {
    "knowledge_node": KnowledgeNode,
    "course": Course,
    "material": Material,
    "relation": Relation,
    "tag": Tag,
    "evidence": Evidence,
    "preference_context": PreferenceContext,
    "preference": Preference,
    "preference_example": PreferenceExample,
}


SCHEMA_MODELS: dict[str, type[BaseModel]] = {
    "knowledge-node.v1.schema.json": KnowledgeNode,
    "course.v1.schema.json": Course,
    "material.v3.schema.json": Material,
    "relation.v2.schema.json": Relation,
    "tag.v1.schema.json": Tag,
    "evidence.v1.schema.json": Evidence,
    "preference-context.v1.schema.json": PreferenceContext,
    "preference.v1.schema.json": Preference,
    "preference-example.v3.schema.json": PreferenceExample,
    "source-manifest.v2.schema.json": SourceManifest,
    "change-proposal.v1.schema.json": ChangeProposal,
}


def parse_record(data: dict[str, Any]) -> Record:
    entity_type = data.get("entity_type")
    model = RECORD_MODELS.get(str(entity_type))
    if model is None:
        raise ValueError(f"unsupported entity_type: {entity_type!r}")
    return model.model_validate(data)  # type: ignore[return-value]
