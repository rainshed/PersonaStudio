from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MaintenanceInput(Contract):
    target_types: list[Literal["knowledge_node", "preference", "material", "course"]] = Field(
        min_length=1, max_length=4
    )
    record_ids: list[str] = Field(default_factory=list, max_length=50)
    knowledge_root: str | None = None
    material_ids: list[str] = Field(default_factory=list, max_length=20)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    collect_attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    attachment_relationships: dict[str, Literal["skimmed", "read", "studied", "authored"]] = Field(
        default_factory=dict
    )
    reading: Literal["targeted", "full"] = "targeted"


class Basis(Contract):
    ref: str
    supports: list[str] = Field(default_factory=list, max_length=30)


class Candidate(Contract):
    client_ref: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    operation: Literal["create", "update", "archive", "restore", "relate", "unrelate"]
    entity_type: Literal[
        "knowledge_node",
        "preference",
        "preference_context",
        "preference_example",
        "material",
        "course",
        "relation",
        "tag",
    ]
    target_id: str | None = None
    values: dict = Field(default_factory=dict)
    basis: list[Basis] = Field(default_factory=list, max_length=30)
    reason: str = Field(min_length=1, max_length=4000)
    conflicts: list[str] = Field(default_factory=list, max_length=20)


class Finish(Contract):
    kind: Literal["propose", "clarify", "no_change"]
    summary: str = Field(min_length=1, max_length=5000)
    changes: list[Candidate] = Field(default_factory=list, max_length=30)
    questions: list[str] = Field(default_factory=list, max_length=8)
    deferred_items: list[str] = Field(default_factory=list, max_length=8)


class ToolAction(Contract):
    name: str
    arguments: dict = Field(default_factory=dict)


class ModelAction(Contract):
    calls: list[ToolAction] = Field(default_factory=list, max_length=8)
    result: Finish | None = None
