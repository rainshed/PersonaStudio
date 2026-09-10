from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

import ai_persona.proposals as proposal_module
from ai_persona.agent import PersonaProposalFacade, ProposalChangeInput
from ai_persona.change_sets import ChangeSetLink, ChangeSetManifest
from ai_persona.compiler import PersonaCompiler
from ai_persona.proposals import (
    ProposalDependencyError,
    ProposalRepository,
    ProposalService,
)
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def change_set_workspace(tmp_path: Path) -> tuple[Path, Path]:
    demo = demo_workspace().data_root
    assert demo is not None
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo, data)
    PersonaCompiler(data, state).build()
    return data, state


def submit_dependent_change_set(data: Path, state: Path):
    store = PersonaStore(data).load()
    assert store.config is not None
    return PersonaProposalFacade(data, state).propose_change_set(
        idempotency_key="tests:dependency-review:v1",
        observed_persona_revision=store.config.revision,
        summary="Add a candidate topic with one dependent and one independent relation.",
        changes=[
            ProposalChangeInput.model_validate(
                {
                    "client_ref": "candidate-topic",
                    "operation": "create",
                    "entity_type": "knowledge_node",
                    "values": {
                        "title": "Candidate dependency topic",
                        "semantic_role": "topic",
                        "knowledge_level": "unspecified",
                        "interest_level": "medium",
                    },
                    "reason": "The candidate is useful for testing review dependencies.",
                    "confidence": 0.8,
                }
            ),
            ProposalChangeInput.model_validate(
                {
                    "operation": "relate",
                    "entity_type": "relation",
                    "values": {
                        "source_id": "mat_demo_tebd_note",
                        "relation_type": "covers",
                        "target_ref": "candidate-topic",
                        "knowledge_role": "topic",
                        "salience": "secondary",
                        "statement": "The material provides an example of the candidate topic.",
                    },
                    "reason": "Connect the material to the new candidate.",
                    "confidence": 0.8,
                }
            ),
            ProposalChangeInput.model_validate(
                {
                    "operation": "relate",
                    "entity_type": "relation",
                    "values": {
                        "source_id": "kn_demo_mps",
                        "relation_type": "related_to",
                        "target_id": "kn_demo_quantum_physics",
                    },
                    "reason": "This independent relation does not use the candidate.",
                    "confidence": 0.7,
                }
            ),
        ],
    )


def test_reject_cascades_to_dependents_but_not_independent_proposals(
    change_set_workspace: tuple[Path, Path],
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, independent = submitted.proposals
    service = ProposalService(data, state)

    rejected = service.reject_group(root.proposal_id, "The concept is too specific.")

    assert rejected.cascaded_count == 1
    repository = ProposalRepository(data)
    saved_root = repository.get(root.proposal_id)
    saved_dependent = repository.get(dependent.proposal_id)
    saved_independent = repository.get(independent.proposal_id)
    assert saved_root.status == "rejected"
    assert saved_root.decision_source == "human_review"
    assert saved_dependent.status == "rejected"
    assert saved_dependent.decision_source == "dependency_cascade"
    assert saved_dependent.decision_parent_id == root.proposal_id
    assert saved_independent.status == "pending_review"

    service.accept(independent.proposal_id)
    assert repository.get(independent.proposal_id).status == "accepted"


def test_save_and_approve_only_publishes_the_current_ai_candidate(change_set_workspace):
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, independent = submitted.proposals
    repository = ProposalRepository(data)
    original = repository.get(root.proposal_id)
    untouched = {
        item.proposal_id: (repository.pending_root / f"{item.proposal_id}.json").read_bytes()
        for item in (dependent, independent)
    }
    with TestClient(create_app(data, state)) as client:
        response = client.post(
            f"/review/{root.proposal_id}/edit-and-accept",
            data={"proposal_revision": original.proposal_revision, "title": "My corrected topic"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert "kind=success" in response.headers["location"]
    accepted = repository.get(root.proposal_id)
    assert accepted.status == "edited_and_accepted"
    assert accepted.submitted_by == "ai"
    assert accepted.decision_source == "human_review"
    store = PersonaStore(data).load()
    assert store.records[accepted.target_id].record.title == "My corrected topic"
    for proposal_id, content in untouched.items():
        assert (repository.pending_root / f"{proposal_id}.json").read_bytes() == content
        proposal = repository.get(proposal_id)
        assert proposal.status == "pending_review"
        assert proposal.target_id not in store.records


def test_dependent_proposal_cannot_be_accepted_before_its_dependency(
    change_set_workspace: tuple[Path, Path],
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, _ = submitted.proposals
    service = ProposalService(data, state)

    with pytest.raises(ProposalDependencyError, match="review dependent proposals first"):
        service.accept(dependent.proposal_id)

    assert service.repository.get(dependent.proposal_id).status == "pending_review"
    with TestClient(create_app(data, state)) as client:
        response = client.post(
            f"/review/{root.proposal_id}/accept", follow_redirects=False
        )
        assert f"/review/{dependent.proposal_id}" in response.headers["location"]
    service.accept(dependent.proposal_id)
    assert service.repository.get(dependent.proposal_id).status == "accepted"


def test_rejecting_a_dependent_does_not_reject_its_dependency(
    change_set_workspace: tuple[Path, Path],
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, _ = submitted.proposals
    service = ProposalService(data, state)

    rejected = service.reject_group(dependent.proposal_id)

    assert rejected.cascaded_count == 0
    assert service.repository.get(dependent.proposal_id).status == "rejected"
    assert service.repository.get(root.proposal_id).status == "pending_review"


def test_deferred_dependency_blocks_but_does_not_reject_dependents(
    change_set_workspace: tuple[Path, Path],
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, _ = submitted.proposals
    service = ProposalService(data, state)

    service.defer(root.proposal_id, "Review this concept later.")
    with pytest.raises(ProposalDependencyError, match="review dependent proposals first"):
        service.accept(dependent.proposal_id)

    assert service.repository.get(root.proposal_id).status == "deferred"
    assert service.repository.get(dependent.proposal_id).status == "pending_review"


def test_cascade_rejection_rolls_back_all_history_moves_on_failure(
    change_set_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, _ = submitted.proposals
    original_atomic_write = proposal_module._atomic_write
    history_writes = 0

    def fail_second_history_write(path: Path, content: bytes) -> None:
        nonlocal history_writes
        if path.parent.name == "history":
            history_writes += 1
            if history_writes == 2:
                raise OSError("simulated history write failure")
        original_atomic_write(path, content)

    monkeypatch.setattr(proposal_module, "_atomic_write", fail_second_history_write)
    with pytest.raises(OSError, match="simulated history write failure"):
        ProposalService(data, state).reject_group(root.proposal_id)

    repository = ProposalRepository(data)
    assert repository.get(root.proposal_id).status == "pending_review"
    assert repository.get(dependent.proposal_id).status == "pending_review"
    assert (repository.pending_root / f"{root.proposal_id}.json").is_file()
    assert (repository.pending_root / f"{dependent.proposal_id}.json").is_file()
    assert not (repository.history_root / f"{root.proposal_id}.json").exists()
    assert not (repository.history_root / f"{dependent.proposal_id}.json").exists()


def test_change_set_review_page_groups_and_explains_dependencies(
    change_set_workspace: tuple[Path, Path],
) -> None:
    data, state = change_set_workspace
    submitted = submit_dependent_change_set(data, state)
    root, dependent, independent = submitted.proposals

    with TestClient(create_app(data, state)) as client:
        queue = client.get(f"/review?change_set={submitted.change_set_id}")
        assert queue.status_code == 200
        assert queue.url.path == "/inbox"
        detail = client.get(f"/api/inbox/v1/items/change_set:{submitted.change_set_id}").json()
        assert "Add a candidate topic with one dependent" in detail["input_text"]
        candidates = client.get(f"/api/inbox/v1/items/change_set:{submitted.change_set_id}/review").json()["proposals"]
        ids = [p["id"] for p in candidates]
        assert ids.index(root.proposal_id) < ids.index(dependent.proposal_id)

        blocked = client.get(f"/review/{dependent.proposal_id}")
        assert blocked.url.params["proposal"] == dependent.proposal_id
        projected = next(p for p in candidates if p["id"] == dependent.proposal_id)
        assert projected["dependencies"] == [{"id": root.proposal_id, "title": "Candidate dependency topic"}]

        root_page = client.get(f"/review/{root.proposal_id}")
        assert root_page.status_code == 200
        assert next(p for p in candidates if p["id"] == root.proposal_id)["pending_dependents"] == [dependent.proposal_id]
        response = client.post(
            f"/review/{root.proposal_id}/reject", follow_redirects=False
        )
        assert response.status_code == 303
        assert f"/review/{independent.proposal_id}" in response.headers["location"]

        refreshed = client.get(f"/api/inbox/v1/items/change_set:{submitted.change_set_id}/review").json()["proposals"]
        assert {p["id"]: p["status"] for p in refreshed} == {independent.proposal_id: "pending_review", root.proposal_id: "rejected", dependent.proposal_id: "rejected"}


def test_change_set_dependency_graph_supports_transitive_cascades() -> None:
    links = [
        ChangeSetLink(
            proposal_id="prop_a",
            candidate_record_id="kn_a",
            operation="create",
            entity_type="knowledge_node",
        ),
        ChangeSetLink(
            proposal_id="prop_b",
            candidate_record_id="rel_b",
            operation="relate",
            entity_type="relation",
            dependencies=["prop_a"],
        ),
        ChangeSetLink(
            proposal_id="prop_c",
            candidate_record_id="rel_c",
            operation="relate",
            entity_type="relation",
            dependencies=["prop_b"],
        ),
    ]
    manifest = ChangeSetManifest(
        schema="ai-persona.change-set/v1",
        id="chg_transitive",
        idempotency_key="tests:transitive",
        payload_hash="sha256:" + "0" * 64,
        observed_persona_revision=1,
        summary="Transitive dependency test",
        created_at=datetime.now(timezone.utc),
        proposal_links=links,
    )

    assert manifest.topological_proposal_ids() == ["prop_a", "prop_b", "prop_c"]
    assert manifest.transitive_dependencies_of("prop_c") == ["prop_a", "prop_b"]
    assert manifest.transitive_dependents_of("prop_a") == ["prop_b", "prop_c"]
    assert manifest.dependency_groups()[0].model_dump() == {
        "root_proposal_id": "prop_a",
        "dependent_proposal_ids": ["prop_b", "prop_c"],
    }
