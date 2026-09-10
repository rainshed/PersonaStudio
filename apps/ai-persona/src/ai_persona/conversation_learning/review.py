"""Learning ownership adapter for the shared inline candidate review service."""
from __future__ import annotations

from ..candidate_review import CandidateReview
from ..candidate_review import ReviewInputError as ReviewInputError
from ..change_sets import ChangeSetRepository
from ..proposals import ProposalError


class LearningReview(CandidateReview):
    def __init__(self, service, locale="zh-CN"):
        super().__init__(service.data_root, service.state_root, locale)
        self.service = service

    def manifest(self, event_id):
        row = self.service.repository.get(event_id)
        if not row["change_set_id"]:
            return None
        manifest = ChangeSetRepository(self.data_root).get(row["change_set_id"])
        if manifest.producer_ref and manifest.producer_ref.id != event_id:
            raise ProposalError("任务与候选来源不一致，请刷新后重试。")
        return manifest

    def selection(self, event_id):
        manifest = self.manifest(event_id)
        return manifest, [self.repo.get(i) for i in manifest.topological_proposal_ids()] if manifest else []
