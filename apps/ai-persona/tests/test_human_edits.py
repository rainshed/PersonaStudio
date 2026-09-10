from __future__ import annotations

import json
import re
import shutil

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.human_edits import HumanEditService
from ai_persona.i18n import LOCALE_COOKIE
from ai_persona.models import Course
from ai_persona.proposals import ProposalError, ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state


def persisted_files(data):
    return {
        str(path.relative_to(data)): path.read_bytes()
        for root in ("records", "config", "revisions", "proposals", "generated")
        for path in (data / root).rglob("*")
        if path.is_file()
    }


def test_human_save_keeps_ai_candidates_pending_and_invalidates_stale_ai_update(workspace):
    data, state = workspace
    ai = ProposalService(data, state)
    proposal = ai.create_update(
        "kn_demo_tebd", {"summary": "AI suggestion"}, submitted_by="ai", reason="From a note"
    )
    before_pending = (ai.repository.pending_root / f"{proposal.id}.json").read_bytes()
    saved = HumanEditService(data, state).create_update(
        "kn_demo_tebd", {"summary": "My own summary"}
    )
    assert saved.status == "accepted" and saved.decision_source == "human_edit"
    assert (ai.repository.pending_root / f"{proposal.id}.json").read_bytes() == before_pending
    assert [item.id for item in ai.repository.list_pending()] == [proposal.id]
    ledger = json.loads((data / "revisions/changes.jsonl").read_text().splitlines()[-1])
    assert ledger["actor"] == "human" and ledger["decision_source"] == "human_edit"
    assert ledger["proposal_ids"] == [saved.id]
    with pytest.raises(ProposalError):
        ai.accept(proposal.id)
    assert PersonaStore(data).load().records["kn_demo_tebd"].record.summary == "My own summary"


def test_human_publication_boundary_rejects_ai_content(workspace):
    data, state = workspace
    before = persisted_files(data)
    with pytest.raises(ProposalError, match="AI changes require human review"):
        HumanEditService(data, state).create_update(
            "kn_demo_tebd", {"summary": "AI content"}, submitted_by="ai", reason="A suggestion"
        )
    assert persisted_files(data) == before


@pytest.mark.parametrize("failure_point", ["compile", "history"])
def test_batch_failure_rolls_back_all_records_history_and_indexes(workspace, monkeypatch, failure_point):
    data, state = workspace
    before = persisted_files(data)
    attempts = 0
    if failure_point == "compile":
        owner, method = PersonaCompiler, "build"
    else:
        owner, method = ProposalRepository, "complete"
    original = getattr(owner, method)

    def fail_second(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        result = original(*args, **kwargs)
        if attempts == 2:
            raise ProposalError("Simulated second save failure")
        return result

    monkeypatch.setattr(owner, method, fail_second)
    with pytest.raises(ProposalError, match="Simulated second save failure"):
        HumanEditService(data, state).create_relations(
            "kn_demo_nonequilibrium", [("requires", "kn_demo_mps"), ("requires", "kn_demo_tebd")]
        )
    assert persisted_files(data) == before
    assert ProposalRepository(data).list_pending() == []


@pytest.mark.parametrize("collection,record_id", [
    ("knowledge", "kn_demo_tebd"),
    ("courses", "crs_demo_qmb"),
    ("materials", "mat_demo_tebd_note"),
])
def test_stale_edit_form_cannot_overwrite_newer_record(workspace, collection, record_id):
    data, state = workspace
    if collection == "courses":
        record_id = PersonaStore(data).load().of_type(Course, active_only=True)[0].id
    with TestClient(create_app(data, state)) as client:
        page = client.get(f"/{collection}/{record_id}/edit")
        assert page.status_code == 200
        revision = re.search(r'name="record_revision" value="(\d+)"', page.text).group(1)
        HumanEditService(data, state).create_update(record_id, {"title": "Newer title"})
        before = persisted_files(data)
        result = client.post(
            f"/{collection}/{record_id}/proposals",
            data={"title": "Old page title", "record_revision": revision},
            follow_redirects=False,
        )
        assert "kind=error" in result.headers["location"]
        assert "记录已更新" in client.get(result.headers["location"]).text
        assert persisted_files(data) == before


@pytest.mark.parametrize("locale,save_label,approve_label", [
    ("zh-CN", "保存", "保存并通过"), ("en", "Save", "Save and approve"),
])
def test_manual_forms_and_ai_review_explain_the_save_action(workspace, locale, save_label, approve_label):
    data, state = workspace
    proposal = ProposalService(data, state).create_update(
        "kn_demo_tebd", {"summary": "Candidate"}, submitted_by="ai", reason="A suggestion"
    )
    with TestClient(create_app(data, state)) as client:
        client.cookies.set(LOCALE_COOKIE, locale)
        form = client.get(f"/knowledge/kn_demo_tebd/edit?lang={locale}")
        assert save_label in form.text
        assert "预览变更提案" not in form.text
        review = client.get(f"/review/{proposal.id}?lang={locale}")
        assert review.url.path == "/inbox"
        projection = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
        assert "summary" in projection["values"] and projection["status"] == "pending_review"
