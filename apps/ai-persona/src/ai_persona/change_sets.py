from __future__ import annotations

import json
import os
import tempfile
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import ProposalContext


class ChangeSetError(ValueError):
    """Raised when a ChangeSet cannot be loaded or has an invalid dependency graph."""


class ChangeSetModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ChangeSetLink(ChangeSetModel):
    proposal_id: str
    client_ref: str | None = None
    candidate_record_id: str
    operation: str
    entity_type: str
    dependencies: list[str] = Field(default_factory=list)


class DependencyGroup(ChangeSetModel):
    root_proposal_id: str
    dependent_proposal_ids: list[str]


class ProducerRef(ChangeSetModel):
    kind: Literal["assistant_session", "conversation_learning"]
    id: str = Field(pattern=r"^(?:ai|learn)_[A-Za-z0-9_-]+$")


class ChangeSetManifest(ChangeSetModel):
    schema_id: Literal["ai-persona.change-set/v1"] = Field(
        alias="schema", serialization_alias="schema"
    )
    id: str = Field(pattern=r"^chg_[A-Za-z0-9_-]+$")
    idempotency_key: str
    payload_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    observed_persona_revision: int = Field(ge=1)
    summary: str
    submitted_by: Literal["ai"] = "ai"
    created_at: datetime
    proposal_context: ProposalContext = Field(default_factory=ProposalContext)
    proposal_links: list[ChangeSetLink]
    atomic_groups: list[list[str]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    assistant_session_id: str | None = Field(default=None, pattern=r"^ai_[A-Za-z0-9_-]+$")
    producer_ref: ProducerRef | None = None
    generation: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def dependency_graph_is_valid(self) -> ChangeSetManifest:
        if self.assistant_session_id and self.producer_ref and (
            self.producer_ref.kind != "assistant_session"
            or self.producer_ref.id != self.assistant_session_id
        ):
            raise ValueError("producer_ref conflicts with assistant_session_id")
        if self.proposal_context.kind == "conversation" and self.producer_ref and (
            self.producer_ref.kind != "conversation_learning"
            or self.producer_ref.id != self.proposal_context.learning_batch_id
        ):
            raise ValueError("producer_ref conflicts with learning_batch_id")
        proposal_ids = [link.proposal_id for link in self.proposal_links]
        if len(proposal_ids) != len(set(proposal_ids)):
            raise ValueError("a ChangeSet cannot contain the same proposal twice")
        known = set(proposal_ids)
        for link in self.proposal_links:
            if len(link.dependencies) != len(set(link.dependencies)):
                raise ValueError("proposal dependencies must be unique")
            if link.proposal_id in link.dependencies:
                raise ValueError("a proposal cannot depend on itself")
            unknown = set(link.dependencies) - known
            if unknown:
                raise ValueError(f"unknown proposal dependencies: {sorted(unknown)}")
        self.topological_proposal_ids()
        return self

    def dependencies_of(self, proposal_id: str) -> list[str]:
        link = next(
            (item for item in self.proposal_links if item.proposal_id == proposal_id),
            None,
        )
        if link is None:
            raise ChangeSetError(f"proposal {proposal_id} is not part of {self.id}")
        return list(link.dependencies)

    def direct_dependents_of(self, proposal_id: str) -> list[str]:
        return [
            link.proposal_id
            for link in self.proposal_links
            if proposal_id in link.dependencies
        ]

    def transitive_dependencies_of(self, proposal_id: str) -> list[str]:
        known = {link.proposal_id for link in self.proposal_links}
        if proposal_id not in known:
            raise ChangeSetError(f"proposal {proposal_id} is not part of {self.id}")
        result: set[str] = set()
        queue = deque(self.dependencies_of(proposal_id))
        while queue:
            dependency = queue.popleft()
            if dependency in result:
                continue
            result.add(dependency)
            queue.extend(self.dependencies_of(dependency))
        order = self.topological_proposal_ids()
        return [item for item in order if item in result]

    def transitive_dependents_of(self, proposal_id: str) -> list[str]:
        known = {link.proposal_id for link in self.proposal_links}
        if proposal_id not in known:
            raise ChangeSetError(f"proposal {proposal_id} is not part of {self.id}")
        result: set[str] = set()
        queue = deque(self.direct_dependents_of(proposal_id))
        while queue:
            dependent = queue.popleft()
            if dependent in result:
                continue
            result.add(dependent)
            queue.extend(self.direct_dependents_of(dependent))
        order = self.topological_proposal_ids()
        return [item for item in order if item in result]

    def topological_proposal_ids(self) -> list[str]:
        order_index = {
            link.proposal_id: index for index, link in enumerate(self.proposal_links)
        }
        indegree = {
            link.proposal_id: len(link.dependencies) for link in self.proposal_links
        }
        adjacency: dict[str, list[str]] = defaultdict(list)
        for link in self.proposal_links:
            for dependency in link.dependencies:
                adjacency[dependency].append(link.proposal_id)
        ready = [item for item, degree in indegree.items() if degree == 0]
        ready.sort(key=order_index.__getitem__)
        result: list[str] = []
        while ready:
            current = ready.pop(0)
            result.append(current)
            for dependent in sorted(adjacency[current], key=order_index.__getitem__):
                indegree[dependent] -= 1
                if indegree[dependent] == 0:
                    ready.append(dependent)
                    ready.sort(key=order_index.__getitem__)
        if len(result) != len(self.proposal_links):
            raise ValueError("ChangeSet proposal dependencies contain a cycle")
        return result

    def dependency_groups(self) -> list[DependencyGroup]:
        roots = [
            link.proposal_id
            for link in self.proposal_links
            if not link.dependencies and self.direct_dependents_of(link.proposal_id)
        ]
        return [
            DependencyGroup(
                root_proposal_id=root,
                dependent_proposal_ids=self.transitive_dependents_of(root),
            )
            for root in roots
        ]


def _atomic_json_write(path: Path, value: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = (
        json.dumps(
            value.model_dump(mode="json", by_alias=True),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
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


class ChangeSetRepository:
    def __init__(self, data_root: Path) -> None:
        self.root = data_root.resolve() / "proposals" / "change-sets"

    def save(self, manifest: ChangeSetManifest) -> Path:
        path = self.root / f"{manifest.id}.json"
        _atomic_json_write(path, manifest)
        return path

    def list(self) -> list[ChangeSetManifest]:
        if not self.root.exists():
            return []
        manifests = [self._load(path) for path in sorted(self.root.glob("chg_*.json"))]
        return sorted(manifests, key=lambda item: item.created_at, reverse=True)

    def get(self, change_set_id: str) -> ChangeSetManifest:
        if not change_set_id.startswith("chg_") or any(
            character in change_set_id for character in "/\\\0"
        ):
            raise ChangeSetError("invalid ChangeSet id")
        path = self.root / f"{change_set_id}.json"
        if not path.is_file():
            raise ChangeSetError(f"unknown ChangeSet: {change_set_id}")
        return self._load(path)

    def by_idempotency_key(self, key: str) -> ChangeSetManifest | None:
        return next((item for item in self.list() if item.idempotency_key == key), None)

    def find_by_proposal_id(self, proposal_id: str) -> ChangeSetManifest | None:
        matches = [
            manifest
            for manifest in self.list()
            if any(link.proposal_id == proposal_id for link in manifest.proposal_links)
        ]
        if len(matches) > 1:
            raise ChangeSetError(f"proposal {proposal_id} belongs to multiple ChangeSets")
        return matches[0] if matches else None

    @staticmethod
    def _load(path: Path) -> ChangeSetManifest:
        try:
            return ChangeSetManifest.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ChangeSetError(f"invalid ChangeSet {path}: {exc}") from exc


@contextmanager
def proposal_lock(state_root: Path) -> Iterator[None]:
    import fcntl

    resolved_state_root = state_root.resolve()
    resolved_state_root.mkdir(parents=True, exist_ok=True)
    lock_path = resolved_state_root / "persona-mcp.lock"
    with lock_path.open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            # Finish interrupted AI candidate updates before any human review mutation.
            from .pending_sync import recover_pending_sync

            recover_pending_sync(resolved_state_root)
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
