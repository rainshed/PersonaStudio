"""Publish explicit Studio edits without adding them to the review queue."""

from contextlib import ExitStack
from pathlib import Path

from .change_sets import proposal_lock
from .compiler import PersonaCompiler
from .models import ChangeProposal
from .proposals import ProposalError, ProposalRepository, ProposalService


class _HumanEditRepository(ProposalRepository):
    def __init__(self, data_root: Path, proposals: list[ChangeProposal]) -> None:
        super().__init__(data_root)
        self.prepared = {proposal.id: proposal for proposal in proposals}

    def get(self, proposal_id: str) -> ChangeProposal:
        return self.prepared.get(proposal_id) or super().get(proposal_id)

    def complete(self, proposal: ChangeProposal) -> Path:
        # Failed saves must never become review items or misleading history entries.
        if proposal.status != "accepted":
            return self.history_root / f"{proposal.id}.json"
        return super().complete(proposal)


class HumanEditService(ProposalService):
    """Use only for explicit human form submissions, never for AI generation.

    Candidate validation and publication reuse ProposalService. Candidates stay
    in memory; only accepted history is persisted. A multi-relation form rolls
    back all its records and history if any publication fails.
    """

    def _save_proposals(self, proposals: list[ChangeProposal]) -> list[ChangeProposal]:
        if any(proposal.submitted_by != "human" for proposal in proposals):
            raise ProposalError("AI changes require human review")
        reviewer = ProposalService(self.data_root, self.state_root)
        reviewer.repository = _HumanEditRepository(self.data_root, proposals)
        with proposal_lock(self.state_root):
            try:
                with ExitStack() as transaction:
                    accepted = [
                        reviewer._accept_locked(
                            proposal.id,
                            decision_source="human_edit",
                            transaction=transaction,
                        ).proposal
                        for proposal in proposals
                    ]
                    transaction.pop_all()
                    return accepted
            except Exception:
                PersonaCompiler(self.data_root, self.state_root).build()
                raise
