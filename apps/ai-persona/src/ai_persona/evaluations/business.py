"""Business snapshots and review gold. Never reads credentials or live host logs."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from ..models import ChangeProposal, parse_record
from ..store import LoadedRecord, PersonaConfig, PersonaStore
from .contracts import LEARNING, digest
from .store import EvaluationStore


def proposal_fingerprint(proposal):
    # Review status/revision can change on defer/accept; the original patch cannot.
    return digest(
        {
            k: proposal.model_dump(mode="json")[k]
            for k in (
                "id",
                "operation",
                "target_id",
                "target_entity_type",
                "patch",
                "base_revision",
                "base_hash",
                "created_at",
            )
        }
    )


def approved_content(proposal, candidate, body, review_patch):
    fields = {p.field for p in [*proposal.patch, *review_patch]}
    raw = candidate.model_dump(mode="json")
    return {
        "candidate_version_ref": proposal_fingerprint(proposal),
        "operation": proposal.operation,
        "entity_type": proposal.target_entity_type,
        "target_id": proposal.target_id,
        "values": {k: body if k == "body" else raw[k] for k in fields if k == "body" or k in raw},
    }


def snapshot_persona(store, history):
    kinds = {"knowledge_node", "preference", "preference_context", "relation", "tag"}
    completed = [p for p in history if p.status not in {"pending_review", "deferred"}]
    return {
        "config": {
            "persona_id": store.config.persona_id,
            "revision": store.config.revision,
            "created_at": store.config.created_at.isoformat(),
            "include_human_notes_in_snapshot": store.config.include_human_notes_in_snapshot,
        },
        "records": [
            {"record": v.record.model_dump(mode="json", by_alias=True), "body": v.body}
            for v in store.records.values()
            if v.record.entity_type in kinds
        ],
        "history": [
            p.model_dump(mode="json", by_alias=True)
            for p in history
            if p.target_entity_type in kinds
        ],
        # Preserve the global history limit without retaining unrelated bodies.
        "history_order": {
            p.id: index for index, p in enumerate(completed) if p.target_entity_type in kinds
        },
    }


def restore_persona(snapshot):
    # Reuse the actual in-memory query/validation operations, but never load the
    # production filesystem. Sources/materials are outside these two capabilities.
    store = PersonaStore(Path("/evaluation-snapshot-not-a-workspace"))
    config = dict(snapshot["config"])
    config["created_at"] = datetime.fromisoformat(config["created_at"])
    store.config = PersonaConfig(**config)
    for item in snapshot["records"]:
        record = parse_record(item["record"])
        store.records[record.id] = LoadedRecord(record, item["body"], Path("snapshot"))
    return store, [ChangeProposal.model_validate(p) for p in snapshot["history"]]


def bindings(proposals):
    return [
        {"proposal_id": p.id, "candidate_version_ref": proposal_fingerprint(p)} for p in proposals
    ]


def sync_review_gold(store: EvaluationStore, case_id=None):
    """Pull from committed proposal history. Also repairs a missed notification.

    No case is created here. Read-only proposal lookup occurs outside the
    evaluation lock, avoiding inversion with the production proposal lock.
    """
    from ..change_sets import proposal_lock
    from ..proposals import ProposalRepository

    cases = [store.case(case_id)] if case_id else store.cases(LEARNING)
    updated = 0
    for item in cases:
        if item["status"] != "active" or item["capability_id"] != LEARNING:
            continue
        try:
            case = store.projection(item["case_id"])
        except ValueError:
            continue
        gold = []
        with proposal_lock(store.state_root):
            repository = ProposalRepository(store.data_root)
            for binding in case["result"].get("proposal_bindings", []):
                try:
                    proposal = repository.get(binding["proposal_id"])
                except ValueError:
                    continue
                content = proposal.approved_content
                if (
                    proposal.status not in {"accepted", "edited_and_accepted"}
                    or not content
                    or content.get("candidate_version_ref") != binding["candidate_version_ref"]
                ):
                    continue
                gold.append(
                    {
                        **binding,
                        "review_revision": proposal.proposal_revision,
                        "decision": proposal.status,
                        "approved_at": proposal.decided_at.isoformat(),
                        "content": content,
                    }
                )
        if gold:
            updated += int(store.add_gold(item["case_id"], gold))
    return updated


def notify_review(data_root, state_root):
    # A failed projection update must never undo a committed human review. API
    # reads/feedback also call sync_review_gold, making notification recoverable.
    import logging

    try:
        if (Path(data_root) / "evaluations" / "cases").exists():
            sync_review_gold(EvaluationStore(data_root, state_root))
    except Exception:
        logging.getLogger(__name__).warning("Evaluation answer sync deferred; review is committed.")
