"""Recoverable replacement of one assistant task's *unreviewed* candidate group.

No Persona record is published here. Prepared proposals remain in memory until
validation finishes. A durable roll-forward journal closes the multi-file crash
window; every review mutation acquires proposal_lock and replays it first.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from .change_sets import (
    ChangeSetManifest,
    ChangeSetRepository,
    ProducerRef,
    _atomic_json_write,
    proposal_lock,
)
from .models import ChangeProposal
from .proposals import ProposalRepository


class PreparedProposals(ProposalRepository):
    def __init__(self, data_root: Path) -> None:
        super().__init__(data_root)
        self.proposals: list[ChangeProposal] = []

    def save_pending(self, proposal: ChangeProposal) -> Path:
        self.proposals.append(proposal)
        return self.pending_root / f"{proposal.id}.json"


class PendingSync(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data_root: str
    manifest: ChangeSetManifest
    previous: ChangeSetManifest | None
    proposals: list[ChangeProposal]
    superseded: list[ChangeProposal]


def recover_pending_sync(state_root: Path) -> None:
    """Called only while holding proposal_lock; replay is idempotent."""
    path = state_root / "pending-sync.json"
    if not path.exists():
        return
    sync = PendingSync.model_validate_json(path.read_text(encoding="utf-8"))
    repository = ProposalRepository(Path(sync.data_root))
    groups = ChangeSetRepository(Path(sync.data_root))
    for proposal in sync.proposals:
        repository.save_pending(proposal)
    repository.complete_many(sync.superseded)
    if sync.previous:
        _atomic_json_write(
            groups.root / "history" / f"{sync.previous.id}-{sync.previous.generation}.json",
            sync.previous,
        )
    groups.save(sync.manifest)
    path.unlink()


def require_unreviewed(facade, session_id: str, change_set_id: str,
                      producer_ref: ProducerRef | None = None) -> ChangeSetManifest:
    from .agent import AgentServiceError

    manifest = facade.change_sets.get(change_set_id)
    # Older assistant-created groups predate the explicit ownership field.
    owned = manifest.assistant_session_id == session_id or (
        manifest.assistant_session_id is None
        and manifest.idempotency_key.startswith(f"ai-draft:{session_id}:")
    )
    if producer_ref is not None:
        owned = manifest.producer_ref == producer_ref
    repository = ProposalRepository(facade.data_root)
    if not owned or any(
        repository.get(link.proposal_id).status != "pending_review"
        for link in manifest.proposal_links
    ):
        raise AgentServiceError(
            "already_reviewed", "这组候选已有审核决定，不能覆盖。请新建维护任务。"
        )
    return manifest


def sync_pending(facade, *, session_id: str | None = None,
                 producer_ref: ProducerRef | None = None,
                 guard=None,
                 change_set_id: str | None, **kwargs):
    from .agent import AgentServiceError
    from .store import PersonaStore

    with proposal_lock(facade.state_root):
        if guard:
            guard()
        existing = facade.change_sets.by_idempotency_key(kwargs["idempotency_key"])
        if existing:
            return facade._submission_result(existing)
        if not session_id and not producer_ref:
            raise AgentServiceError("invalid_request", "候选组必须有明确的任务归属。")
        previous = require_unreviewed(
            facade, session_id or "", change_set_id, producer_ref
        ) if change_set_id else None
        store = PersonaStore(facade.data_root).load()
        if store.config.revision != kwargs["observed_persona_revision"]:
            raise AgentServiceError("stale_record", "Persona 已更新，请继续对话重新匹配。")
        prepared = PreparedProposals(facade.data_root)
        manifest = facade._propose_change_set_locked(prepared_repository=prepared, **kwargs)
        assert isinstance(manifest, ChangeSetManifest)
        manifest = manifest.model_copy(
            update={
                "id": previous.id if previous else manifest.id,
                "created_at": previous.created_at if previous else manifest.created_at,
                "generation": previous.generation + 1 if previous else 1,
                "assistant_session_id": session_id,
                "producer_ref": producer_ref or ProducerRef(kind="assistant_session", id=session_id),
            }
        )
        if producer_ref and producer_ref.kind == "conversation_learning":
            prepared.proposals = [
                ChangeProposal.model_validate({**p.model_dump(), "confidence": None})
                for p in prepared.proposals
            ]
        stamp = datetime.now(UTC)
        repository = ProposalRepository(facade.data_root)
        superseded = [
            repository.get(link.proposal_id).model_copy(
                update={
                    "status": "stale",
                    "decision_source": "system",
                    "decision_reason": "已由同一 AI 任务的新候选替代；未发布到 Persona。",
                    "updated_at": stamp,
                    "decided_at": stamp,
                }
            )
            for link in (previous.proposal_links if previous else [])
        ]
        journal = PendingSync(
            data_root=str(facade.data_root.resolve()),
            manifest=manifest,
            previous=previous,
            proposals=prepared.proposals,
            superseded=superseded,
        )
        if guard:
            guard()
        _atomic_json_write(facade.state_root / "pending-sync.json", journal)
        recover_pending_sync(facade.state_root)
        return facade._submission_result(manifest)
