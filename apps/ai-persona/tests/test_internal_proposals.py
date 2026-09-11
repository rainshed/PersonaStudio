"""Proposal lifecycle coverage at the internal service boundary."""

import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError, PersonaProposalFacade, ProposalChangeInput
from ai_persona.compiler import PersonaCompiler
from ai_persona.models import ProposalContext
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.query_service import KnowledgeQueryService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


def mcp_workspace(tmp_path):
    data, state = tmp_path / "persona-data", tmp_path / "persona-state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state


class InternalServices:
    """Normalize dictionary fixtures once before calling typed business services."""

    def __init__(self, data, state):
        self.proposals = PersonaProposalFacade(data, state)
        self.query = KnowledgeQueryService(data, state)

    def call(self, operation, arguments):
        args = dict(arguments)
        try:
            if operation == "propose_change_set":
                args["changes"] = [ProposalChangeInput.model_validate(c) for c in args["changes"]]
                if args.get("proposal_context"):
                    args["proposal_context"] = ProposalContext.model_validate(
                        args["proposal_context"]
                    )
                result = self.proposals.propose_change_set(**args)
            elif operation == "get_proposal_status":
                result = self.proposals.get_status(args["change_set_id"])
            else:
                result = getattr(self.query, operation)(**args)
            return result.model_dump(mode="json")
        except AgentServiceError as exc:
            return {"ok": False, "error": {"code": exc.code}}


def test_internal_proposal_is_inert_until_human_review_and_is_idempotent(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    services = InternalServices(data_root, state_root)
    before = PersonaStore(data_root).load()
    assert before.config is not None
    original_revision = before.config.revision

    def scenario() -> None:
        arguments = {
            "idempotency_key": "test-run:create-krylov",
            "observed_persona_revision": original_revision,
            "summary": "Add a reviewed candidate knowledge topic.",
            "changes": [
                {
                    "client_ref": "new-krylov",
                    "operation": "create",
                    "entity_type": "knowledge_node",
                    "values": {
                        "title": "Krylov time evolution",
                        "semantic_role": "method",
                        "knowledge_level": "aware",
                        "interest_level": "high",
                        "summary": "A candidate extracted from explicit user feedback.",
                    },
                    "reason": "The user explicitly described using this method.",
                    "confidence": 1.0,
                }
            ],
        }
        submitted = services.call("propose_change_set", arguments)
        assert submitted["ok"] is True
        assert submitted["effective_change"] is False
        assert submitted["status"] == "pending_review"
        proposal = submitted["proposals"][0]
        candidate_id = proposal["candidate_record_id"]
        assert PersonaStore(data_root).load().config.revision == original_revision
        assert candidate_id not in PersonaStore(data_root).load().records
        hidden = services.call("get_persona_records", {"record_ids": [candidate_id]})
        assert hidden["data"]["items"][0]["error"]["code"] == "not_found_or_not_visible"
        replay = services.call("propose_change_set", arguments)
        assert replay["change_set_id"] == submitted["change_set_id"]
        assert replay["proposals"][0]["proposal_id"] == proposal["proposal_id"]
        conflicting_arguments = dict(arguments)
        conflicting_arguments["summary"] = "A different payload using the same key."
        conflict = services.call("propose_change_set", conflicting_arguments)
        assert conflict["error"]["code"] == "idempotency_conflict"
        ProposalService(data_root, state_root).accept(proposal["proposal_id"])
        visible = services.call("get_persona_records", {"record_ids": [candidate_id]})
        assert visible["ok"] is True
        assert visible["data"]["items"][0]["record"]["title"] == "Krylov time evolution"
        status = services.call("get_proposal_status", {"change_set_id": submitted["change_set_id"]})
        assert status["status"] == "accepted"
        assert status["effective_change"] is True
        assert status["proposals"][0]["published_persona_revision"] == original_revision + 1
        changes = services.call("list_persona_changes", {"since_revision": original_revision})
        assert changes["changes"][-1]["object_id"] == candidate_id
        assert changes["changes"][-1]["operation"] == "create"

    scenario()


def test_internal_rejects_stale_and_rolls_back_an_invalid_change_set(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    services = InternalServices(data_root, state_root)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    revision = store.config.revision
    tebd_revision = store.records["kn_demo_tebd"].record.revision
    pending_root = data_root / "proposals" / "pending"
    change_set_root = data_root / "proposals" / "change-sets"

    def scenario() -> None:
        stale = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:stale",
                "observed_persona_revision": revision,
                "summary": "Stale update",
                "changes": [
                    {
                        "operation": "update",
                        "entity_type": "knowledge_node",
                        "target_id": "kn_demo_tebd",
                        "expected_record_revision": tebd_revision + 1,
                        "values": {"summary": "Should never enter the queue."},
                        "reason": "Candidate based on an old read.",
                        "confidence": 0.7,
                    }
                ],
            },
        )
        assert stale["error"]["code"] == "stale_record"
        pending_before = set(pending_root.glob("*.json"))
        change_sets_before = set(change_set_root.glob("*.json"))
        invalid_batch = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:rollback",
                "observed_persona_revision": revision,
                "summary": "The second candidate has a broken dependency.",
                "changes": [
                    {
                        "client_ref": "new-topic",
                        "operation": "create",
                        "entity_type": "knowledge_node",
                        "values": {
                            "title": "Transient invalid batch topic",
                            "semantic_role": "topic",
                            "knowledge_level": "unspecified",
                            "interest_level": "medium",
                        },
                        "reason": "First candidate.",
                        "confidence": 0.8,
                    },
                    {
                        "operation": "relate",
                        "entity_type": "relation",
                        "values": {
                            "source_ref": "new-topic",
                            "target_ref": "missing-topic",
                            "relation_type": "related_to",
                        },
                        "reason": "Broken candidate relation.",
                        "confidence": 0.5,
                    },
                ],
            },
        )
        assert invalid_batch["error"]["code"] == "invalid_reference"
        assert set(pending_root.glob("*.json")) == pending_before
        assert set(change_set_root.glob("*.json")) == change_sets_before

    scenario()
    assert ProposalRepository(data_root).list_pending() == []


def test_internal_change_set_resolves_internal_relation_references(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    services = InternalServices(data_root, state_root)
    store = PersonaStore(data_root).load()
    assert store.config is not None

    def scenario() -> None:
        submitted = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:dependent-relation",
                "observed_persona_revision": store.config.revision,
                "summary": "Add a topic and a relation that depends on it.",
                "changes": [
                    {
                        "client_ref": "new-topic",
                        "operation": "create",
                        "entity_type": "knowledge_node",
                        "values": {
                            "title": "TDVP",
                            "semantic_role": "method",
                            "knowledge_level": "familiar",
                            "interest_level": "high",
                        },
                        "reason": "User discussed TDVP explicitly.",
                        "confidence": 0.95,
                    },
                    {
                        "client_ref": "new-relation",
                        "operation": "relate",
                        "entity_type": "relation",
                        "values": {
                            "source_ref": "new-topic",
                            "target_id": "kn_demo_tebd",
                            "relation_type": "related_to",
                        },
                        "reason": "Both are tensor-network evolution methods.",
                        "confidence": 0.9,
                    },
                ],
            },
        )
        assert submitted["ok"] is True
        create_proposal, relation_proposal = submitted["proposals"]
        assert relation_proposal["dependencies"] == [create_proposal["proposal_id"]]
        assert submitted["atomic_groups"] == [
            sorted([create_proposal["proposal_id"], relation_proposal["proposal_id"]])
        ]
        assert submitted["dependency_groups"] == [
            {
                "root_proposal_id": create_proposal["proposal_id"],
                "dependent_proposal_ids": [relation_proposal["proposal_id"]],
            }
        ]
        saved_relation = ProposalRepository(data_root).get(relation_proposal["proposal_id"])
        patch = {item.field: item.after for item in saved_relation.patch}
        assert {patch["source_id"], patch["target_id"]} == {
            create_proposal["candidate_record_id"],
            "kn_demo_tebd",
        }

    scenario()


def test_material_change_set_publishes_inline_evidence_atomically(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    services = InternalServices(data_root, state_root)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    source = store.sources["src_demo_note"]

    def scenario() -> None:
        submitted = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:material-inline-evidence",
                "observed_persona_revision": store.config.revision,
                "proposal_context": {
                    "kind": "material",
                    "material_id": "mat_demo_tebd_note",
                    "source_id": source.id,
                    "source_hash": f"sha256:{source.content_hash}",
                },
                "summary": "Extract one reviewed topic and its material relation.",
                "changes": [
                    {
                        "client_ref": "new-entanglement-growth",
                        "operation": "create",
                        "entity_type": "knowledge_node",
                        "values": {
                            "title": "Entanglement growth",
                            "semantic_role": "concept",
                            "knowledge_level": "unspecified",
                            "interest_level": "unspecified",
                            "summary": "Growth of entanglement during time evolution.",
                        },
                        "reason": "The material discusses entanglement growth.",
                        "confidence": 0.9,
                        "evidence": [
                            {
                                "file": "original.md",
                                "line_start": 1,
                                "line_end": 4,
                                "evidence_kind": "authored_material",
                                "confidence": 0.9,
                            }
                        ],
                    },
                    {
                        "operation": "relate",
                        "entity_type": "relation",
                        "values": {
                            "source_id": "mat_demo_tebd_note",
                            "relation_type": "covers",
                            "target_ref": "new-entanglement-growth",
                            "knowledge_role": "topic",
                            "salience": "secondary",
                            "statement": "The note discusses entanglement growth as a practical limit on TEBD.",
                        },
                        "reason": "Connect the source material to the extracted topic.",
                        "confidence": 0.85,
                        "evidence": [
                            {
                                "file": "original.md",
                                "line_start": 1,
                                "line_end": 4,
                                "evidence_kind": "authored_material",
                                "confidence": 0.85,
                            }
                        ],
                    },
                ],
            },
        )
        assert submitted["ok"] is True
        knowledge_link, relation_link = submitted["proposals"]
        repository = ProposalRepository(data_root)
        knowledge_proposal = repository.get(knowledge_link["proposal_id"])
        relation_proposal = repository.get(relation_link["proposal_id"])
        assert knowledge_proposal.proposal_context.kind == "material"
        assert len(knowledge_proposal.evidence_candidates) == 1
        assert len(relation_proposal.evidence_candidates) == 1
        with TestClient(create_app(data_root, state_root)) as studio:
            review = studio.get(f"/review/{knowledge_proposal.id}")
            assert review.status_code == 200
            candidates = studio.get(
                f"/api/inbox/v1/items/proposal:{knowledge_proposal.id}/review"
            ).json()["proposals"]
            projected = next((p for p in candidates if p["id"] == knowledge_proposal.id))
            assert (
                projected["source_evidence"][0]["body"]
                == knowledge_proposal.evidence_candidates[0].body
            )
        hidden = services.call(
            "get_persona_records", {"record_ids": [knowledge_link["candidate_record_id"]]}
        )
        assert hidden["data"]["items"][0]["error"]["code"] == "not_found_or_not_visible"
        ProposalService(data_root, state_root).accept(knowledge_proposal.id)
        ProposalService(data_root, state_root).accept(relation_proposal.id)
        published = PersonaStore(data_root).load()
        knowledge = published.records[knowledge_proposal.target_id].record
        relation = published.records[relation_proposal.target_id].record
        knowledge_evidence_id = knowledge_proposal.evidence_candidates[0].id
        relation_evidence_id = relation_proposal.evidence_candidates[0].id
        assert knowledge_evidence_id in knowledge.evidence_refs
        assert relation_evidence_id in relation.evidence_refs
        assert published.records[knowledge_evidence_id].record.supports == [knowledge.id]
        assert published.records[relation_evidence_id].record.supports == [relation.id]

    scenario()


def test_material_change_set_rejects_invalid_inline_evidence_without_writes(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    services = InternalServices(data_root, state_root)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    source = store.sources["src_demo_note"]
    pending_root = data_root / "proposals" / "pending"
    change_set_root = data_root / "proposals" / "change-sets"

    def scenario() -> None:
        result = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:invalid-inline-evidence",
                "observed_persona_revision": store.config.revision,
                "proposal_context": {
                    "kind": "material",
                    "material_id": "mat_demo_tebd_note",
                    "source_id": source.id,
                    "source_hash": f"sha256:{source.content_hash}",
                },
                "summary": "Reject an invalid source locator.",
                "changes": [
                    {
                        "operation": "create",
                        "entity_type": "knowledge_node",
                        "values": {
                            "title": "Invalid evidence candidate",
                            "semantic_role": "topic",
                            "interest_level": "unspecified",
                        },
                        "reason": "The locator is deliberately invalid.",
                        "confidence": 0.5,
                        "evidence": [
                            {
                                "file": "original.md",
                                "line_start": 9999,
                                "line_end": 9999,
                                "evidence_kind": "read_signal",
                                "confidence": 0.5,
                            }
                        ],
                    }
                ],
            },
        )
        assert result["error"]["code"] == "invalid_reference"
        assert list(pending_root.glob("*.json")) == []
        assert list(change_set_root.glob("*.json")) == []
        unsupported_level = services.call(
            "propose_change_set",
            {
                "idempotency_key": "test-run:unsupported-material-level",
                "observed_persona_revision": store.config.revision,
                "proposal_context": {
                    "kind": "material",
                    "material_id": "mat_demo_tebd_note",
                    "source_id": source.id,
                    "source_hash": f"sha256:{source.content_hash}",
                },
                "summary": "Do not infer mastery from a read signal.",
                "changes": [
                    {
                        "operation": "create",
                        "entity_type": "knowledge_node",
                        "values": {
                            "title": "Unsupported mastery candidate",
                            "semantic_role": "topic",
                            "knowledge_level": "proficient",
                            "interest_level": "unspecified",
                        },
                        "reason": "A read signal is insufficient for this level.",
                        "confidence": 0.5,
                        "evidence": [
                            {
                                "file": "original.md",
                                "line_start": 1,
                                "line_end": 1,
                                "evidence_kind": "read_signal",
                                "confidence": 0.5,
                            }
                        ],
                    }
                ],
            },
        )
        assert unsupported_level["error"]["code"] == "invalid_request"
        assert list(pending_root.glob("*.json")) == []
        assert list(change_set_root.glob("*.json")) == []

    scenario()


def test_internal_serializes_concurrent_idempotent_submissions(tmp_path: Path) -> None:
    data_root, state_root = mcp_workspace(tmp_path)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    facade = PersonaProposalFacade(data_root, state_root)
    change = ProposalChangeInput(
        client_ref="concurrent-topic",
        operation="create",
        entity_type="knowledge_node",
        values={
            "title": "Concurrent MCP candidate",
            "semantic_role": "topic",
            "knowledge_level": "unspecified",
            "interest_level": "medium",
        },
        reason="One logical submission retried concurrently.",
        confidence=0.8,
    )

    def submit() -> str:
        result = facade.propose_change_set(
            idempotency_key="test-run:concurrent",
            observed_persona_revision=store.config.revision,
            summary="A concurrent idempotency test.",
            changes=[change],
        )
        return result.change_set_id

    with ThreadPoolExecutor(max_workers=4) as executor:
        change_set_ids = set(executor.map(lambda _: submit(), range(8)))
    assert len(change_set_ids) == 1
    assert len(ProposalRepository(data_root).list_pending()) == 1
    assert len(list((data_root / "proposals" / "change-sets").glob("*.json"))) == 1
