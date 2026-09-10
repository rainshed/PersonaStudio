from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..models import Bibliography

ImportKind = Literal["arxiv", "markdown"]
ImportFieldStatus = Literal["autofilled", "review_required", "missing", "user_confirmed"]
DuplicateKind = Literal["exact", "possible", "newer_version", "older_version"]


class ImportModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ImportMetadata(ImportModel):
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
    title: str
    aliases: list[str] = Field(default_factory=list)
    abstract: str = ""
    bibliography: Bibliography = Field(default_factory=Bibliography)


class ImportFieldState(ImportModel):
    source: str
    source_locator: str | None = None
    status: ImportFieldStatus
    warnings: list[str] = Field(default_factory=list)


class DuplicateMatch(ImportModel):
    material_id: str
    title: str
    kind: DuplicateKind
    reason: str
    current_version: str | None = None


class DraftFile(ImportModel):
    path: str
    role: Literal["original", "attachment", "extracted_text"]
    media_type: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("path")
    @classmethod
    def path_is_relative_and_safe(cls, value: str) -> str:
        path = Path(value)
        if (
            not value
            or path.is_absolute()
            or ".." in path.parts
            or any(character in value for character in "\\\0")
        ):
            raise ValueError("draft file path must be a safe relative path")
        return value


class ImportDraft(ImportModel):
    schema_id: Literal["ai-persona.material-import/v1"] = Field(
        default="ai-persona.material-import/v1",
        alias="schema",
        serialization_alias="schema",
    )
    id: str
    input_kind: ImportKind
    original_input: str
    display_name: str
    source_provider: str
    source_identifier: str | None = None
    source_version: str | None = None
    source_url: str | None = None
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    original_file: str
    files: list[DraftFile] = Field(min_length=1)
    values: ImportMetadata
    field_states: dict[str, ImportFieldState]
    warnings: list[str] = Field(default_factory=list)
    duplicate_matches: list[DuplicateMatch] = Field(default_factory=list)
    created_at: datetime
    expires_at: datetime

    @field_validator("id")
    @classmethod
    def id_is_safe(cls, value: str) -> str:
        if not value.startswith("imp_") or any(character in value for character in "/\\\0"):
            raise ValueError("import draft id must start with imp_ and be path-independent")
        return value

    @model_validator(mode="after")
    def files_are_consistent(self) -> ImportDraft:
        originals = [item for item in self.files if item.role == "original"]
        if len(originals) != 1 or originals[0].path != self.original_file:
            raise ValueError("import draft requires exactly one matching original file")
        if len({item.path for item in self.files}) != len(self.files):
            raise ValueError("import draft file paths cannot repeat")
        if self.expires_at <= self.created_at:
            raise ValueError("import draft expiry must follow creation")
        return self

    def field_state(self, field: str) -> ImportFieldState:
        return self.field_states.get(
            field,
            ImportFieldState(source="none", status="missing"),
        )

    def normalized_metadata_payload(self) -> dict[str, Any]:
        return {
            "schema": "ai-persona.extracted-material-metadata/v1",
            "input_kind": self.input_kind,
            "source": {
                "provider": self.source_provider,
                "identifier": self.source_identifier,
                "version": self.source_version,
                "url": self.source_url,
            },
            "values": self.values.model_dump(mode="json"),
            "field_states": {
                name: state.model_dump(mode="json")
                for name, state in sorted(self.field_states.items())
            },
            "warnings": self.warnings,
            "parser_version": "1",
        }
