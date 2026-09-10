from __future__ import annotations

import copy
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from test_ai_service import FakeModel, change, evidence, material_knowledge, output, run
from test_ai_service import workspace as workspace

from ai_persona.agent import AgentServiceError, PersonaProposalFacade
from ai_persona.ai_service import PersonaAIService
from ai_persona.change_sets import ChangeSetRepository, proposal_lock
from ai_persona.pending_sync import PreparedProposals
from ai_persona.proposals import ProposalError, ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


def candidate(instruction="先给结论"):
    return change(values={"behavior": "preferred", "instruction": instruction})


def refine(service, session):
    running = service.begin(session["id"], "更新措辞", session["version"])
    return service.generate(session["id"], running["run_id"])


def test_pending_replacement_preserves_group_and_history_and_old_forms_are_safe(workspace):
    data, state = workspace
    initial = PersonaStore(data).load().config.revision
    service = PersonaAIService(
        data, state, FakeModel(output(candidate()), output(candidate("新的措辞")))
    )
    first = run(service)
    old_id = first["submission"]["proposals"][0]["proposal_id"]
    second = refine(service, first)
    assert second["status"] == "submitted", second
    assert first["submission"]["change_set_id"] == second["submission"]["change_set_id"]
    repository = ProposalRepository(data)
    assert len(repository.list_pending()) == 1
    assert repository.get(old_id).status == "stale"
    assert repository.get(old_id).decision_source == "system"
    for method in ["accept", "reject", "defer"]:
        with pytest.raises(ProposalError):
            getattr(ProposalService(data, state), method)(old_id)
    assert PersonaStore(data).load().config.revision == initial
    manifest = ChangeSetRepository(data).list()[0]
    assert manifest.assistant_session_id == first["id"]
    assert manifest.generation == 2
    assert len(list((ChangeSetRepository(data).root / "history").glob("*.json"))) == 1
    with TestClient(create_app(data, state)) as client:
        detail = client.get("/review/" + repository.list_pending()[0].id)
        assert detail.status_code == 200
        projection = client.get("/api/inbox/v1/items/proposal:" + repository.list_pending()[0].id).json()
        assert projection["source_url"] == f"/ai?session={first['id']}"
        assert projection["generation"] == 2
        assert client.get("/review/" + old_id).status_code == 200
        assert client.get("/review?change_set=" + manifest.id).status_code == 200


@pytest.mark.parametrize("decision", ["accept", "reject", "defer"])
def test_human_decision_blocks_further_ai_edits(workspace, decision):
    service = PersonaAIService(*workspace, FakeModel(output(candidate())))
    first = run(service)
    getattr(ProposalService(*workspace), decision)(
        first["submission"]["proposals"][0]["proposal_id"]
    )
    assert service.get_session(first["id"])["can_refine"] is False
    with pytest.raises(AgentServiceError, match="审核决定"):
        service.begin(first["id"], "继续", first["version"])
    with pytest.raises(AgentServiceError, match="审核决定"):
        service.edit(first["id"], first["draft"], first["version"])
    assert len(service.model.calls) == 1


@pytest.mark.parametrize("decision", ["accept", "reject", "defer"])
def test_review_during_generation_is_not_overwritten(workspace, decision):
    fake = FakeModel(output(candidate()))
    service = PersonaAIService(*workspace, fake)
    first = run(service)
    identifier = first["submission"]["proposals"][0]["proposal_id"]

    def review_while_running(payload):
        getattr(ProposalService(*workspace), decision)(identifier)
        return output(candidate("不能覆盖审核"))

    fake.outputs.append(review_while_running)
    result = refine(service, first)
    assert result["status"] in {"failed", "submission_failed"}
    assert result["error"]["code"] == (
        "stale_record" if decision == "accept" else "already_reviewed"
    )
    assert (
        ProposalRepository(workspace[0]).get(identifier).status
        == {"accept": "accepted", "reject": "rejected", "defer": "deferred"}[decision]
    )
    assert len(ChangeSetRepository(workspace[0]).list()) == 1
    refreshed = service.get_session(first["id"])
    assert refreshed["status"] == result["status"]
    assert refreshed["error"] == result["error"]


def test_clarification_and_no_changes_do_not_submit_or_withdraw_existing_candidates(workspace):
    fake = FakeModel(
        output(candidate(), questions=["适用于什么场景？"]),
        output(candidate()),
        output(questions=["还有什么要求？"]),
    )
    service = PersonaAIService(*workspace, fake)
    first = run(service)
    assert first["status"] == "ready" and first["submission"] is None
    assert not ProposalRepository(workspace[0]).list_pending()
    with pytest.raises(AgentServiceError, match="澄清"):
        service.submit(first["id"], first["version"])
    second = refine(service, first)
    assert second["status"] == "submitted"
    third = refine(service, second)
    assert third["status"] == "ready"
    assert third["submission"] == second["submission"]
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1


def test_prepare_failure_retains_old_group_and_retry_needs_no_model(workspace, monkeypatch):
    fake = FakeModel(output(candidate()), output(candidate("更新")))
    service = PersonaAIService(*workspace, fake)
    first = run(service)
    original = PreparedProposals.save_pending

    def fail(*args):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(PreparedProposals, "save_pending", fail)
    failed = refine(service, first)
    assert failed["status"] == "submission_failed"
    assert failed["draft"]["changes"][0]["values"]["instruction"] == "更新"
    assert failed["submission"] == first["submission"]
    assert not (workspace[1] / "pending-sync.json").exists()
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1
    monkeypatch.setattr(PreparedProposals, "save_pending", original)
    retried = service.submit(failed["id"], failed["version"])
    assert retried["status"] == "submitted"
    assert retried["submission"]["change_set_id"] == first["submission"]["change_set_id"]
    assert len(fake.calls) == 2


def test_interrupted_file_commit_is_replayed_before_review_and_retry_is_idempotent(
    workspace, monkeypatch
):
    service = PersonaAIService(
        *workspace, FakeModel(output(candidate()), output(candidate("更新")))
    )
    first = run(service)
    original = ChangeSetRepository.save

    def fail(*args):
        raise OSError("crash after proposals written, before manifest replaced")

    monkeypatch.setattr(ChangeSetRepository, "save", fail)
    failed = refine(service, first)
    assert failed["status"] == "submission_failed"
    assert (workspace[1] / "pending-sync.json").exists()
    monkeypatch.setattr(ChangeSetRepository, "save", original)
    with proposal_lock(workspace[1]):
        assert not (workspace[1] / "pending-sync.json").exists()
    manifest = ChangeSetRepository(workspace[0]).list()[0]
    assert manifest.generation == 2
    retried = service.submit(failed["id"], failed["version"])
    assert retried["status"] == "submitted"
    assert retried["submission"]["change_set_id"] == manifest.id
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1
    assert len(service.model.calls) == 2


def test_concurrent_legacy_submission_does_not_duplicate_group(workspace, monkeypatch):
    service = PersonaAIService(*workspace, FakeModel(output(candidate())))
    monkeypatch.setattr(service, "_auto_submit", lambda value: value)
    first = run(service)

    def submit():
        try:
            return service.submit(first["id"], first["version"])
        except AgentServiceError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert any(r and r["status"] == "submitted" for r in results)
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1
    assert len(ChangeSetRepository(workspace[0]).list()) == 1


def test_candidate_removal_replaces_group_but_cannot_silently_withdraw_all(workspace):
    service = PersonaAIService(
        *workspace, FakeModel(output(candidate("一个"), candidate("另一个")))
    )
    first = run(service)
    edited = copy.deepcopy(first["draft"])
    edited["changes"].pop()
    result = service.edit(first["id"], edited, first["version"])
    assert result["submission"]["change_set_id"] == first["submission"]["change_set_id"]
    assert len(ProposalRepository(workspace[0]).list_pending()) == 1
    edited["changes"] = []
    with pytest.raises(AgentServiceError, match="拒绝"):
        service.edit(result["id"], edited, result["version"])


def test_assistant_cannot_replace_another_tasks_group(workspace):
    service = PersonaAIService(*workspace, FakeModel(output(candidate())))
    first = run(service)
    from ai_persona.pending_sync import require_unreviewed

    with pytest.raises(AgentServiceError):
        require_unreviewed(
            PersonaProposalFacade(*workspace), "ai_wrong", first["submission"]["change_set_id"]
        )


@pytest.mark.parametrize("refs", [[], ["ev_missing"]])
def test_legacy_relation_record_evidence_refs_are_normalized_and_validated(workspace, refs):
    relation = change(
        "relation",
        "relate",
        values={
            "source_id": "mat_demo_tebd_note",
            "target_ref": "new-concept",
            "relation_type": "covers",
            "knowledge_role": "topic",
            "salience": "secondary",
            "statement": "材料介绍此概念。",
            "evidence_refs": refs,
        },
        evidence=[evidence()],
    )
    service = PersonaAIService(*workspace, FakeModel(output(material_knowledge(), relation)))
    first = run(service, material_id="mat_demo_tebd_note")
    if refs:
        assert first["status"] == "submission_failed", first["error"]
        assert first["error"]["code"] == "invalid_reference"
        assert service.get_session(first["id"])["error"] == first["error"]
        assert not ProposalRepository(workspace[0]).list_pending()
    else:
        assert first["status"] == "submitted", first["error"]
        assert len(ProposalRepository(workspace[0]).list_pending()) == 2
        links = first["submission"]["proposals"]
        assert links[1]["dependencies"] == [links[0]["proposal_id"]]
