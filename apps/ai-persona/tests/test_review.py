from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.index import prepare_context
from ai_persona.materials import stage_source
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def review_workspace(tmp_path: Path) -> tuple[Path, Path, TestClient]:
    demo = demo_workspace().data_root
    assert demo is not None
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo, data)
    PersonaCompiler(data, state).build()
    return data, state, TestClient(create_app(data, state))


def create_ai_knowledge(service: ProposalService):
    return service.create_record(
        "knowledge_node",
        {
            "title": "Krylov subspace",
            "semantic_role": "method",
            "knowledge_level": "aware",
            "interest_level": "unspecified",
        },
        reason="从用户提供的研究笔记提取的候选知识。",
        submitted_by="ai",
    )


def test_review_edits_new_ai_knowledge_and_preserves_original(review_workspace):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    initial_revision = PersonaStore(data).load().config.revision
    proposal = create_ai_knowledge(service)
    original_patch = proposal.patch
    page = client.get(f"/review/{proposal.id}")
    assert page.status_code == 200
    projected = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
    assert {"knowledge_level", "interest_level"} <= {f["name"] for f in projected["fields"]}
    assert projected["values"]["knowledge_level"] == "aware"
    assert projected["values"]["interest_level"] == "unspecified"
    assert proposal.target_id not in PersonaStore(data).load().records

    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={
            "proposal_revision": proposal.proposal_revision,
            "title": "Krylov 子空间",
            "knowledge_level": "proficient",
            "interest_level": "high",
            "scope_note": "能够独立实现时间演化。",
            "review_note": "这部分是我实际完成的研究工作。",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    store = PersonaStore(data).load()
    record = store.records[proposal.target_id].record
    assert record.title == "Krylov 子空间"
    assert record.knowledge_level == "proficient"
    assert record.interest_level == "high"
    assert record.scope_note == "能够独立实现时间演化。"
    assert record.revision == 1
    assert store.config.revision == initial_revision + 1
    accepted = ProposalRepository(data).get(proposal.id)
    assert accepted.status == "edited_and_accepted"
    assert accepted.patch == original_patch
    assert accepted.submitted_by == "ai"
    assert accepted.decision_reason == "这部分是我实际完成的研究工作。"
    corrections = {item.field: item for item in accepted.review_patch}
    assert corrections["knowledge_level"].before == "aware"
    assert corrections["knowledge_level"].after == "proficient"
    assert corrections["interest_level"].before == "unspecified"
    assert corrections["interest_level"].after == "high"
    history = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
    assert history["review_patch"]["knowledge_level"] == "proficient"
    assert history["saved"]["interest_level"] == "high"
    assert history["record_url"] == f"/knowledge/{record.id}"
    changes = json.loads((data / "revisions/changes.jsonl").read_text().splitlines()[-1])
    assert changes["review_patch"] == [item.model_dump() for item in accepted.review_patch]
    context = prepare_context(state, context_key="note.write", question="Krylov")
    match = next(item for item in context["relevant_knowledge"] if item["id"] == record.id)
    assert match["knowledge_level"] == "proficient"
    assert match["interest_level"] == "high"


def test_review_can_add_fields_to_an_update_and_clear_tags(review_workspace):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    before = PersonaStore(data).load()
    old = before.records["kn_demo_tebd"].record
    proposal = service.create_update(
        old.id, {"summary": "AI suggested summary"}, reason="Refresh summary", submitted_by="ai"
    )
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={
            "proposal_revision": proposal.proposal_revision,
            "knowledge_level": "familiar",
            "interest_level": "low",
            "summary": "Human confirmed summary",
            "aliases": "TEBD\r\nTime evolution",
            "tags": "",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    store = PersonaStore(data).load()
    new = store.records[old.id].record
    assert new.summary == "Human confirmed summary"
    assert new.knowledge_level == "familiar"
    assert new.interest_level == "low"
    assert new.aliases == ["TEBD", "Time evolution"]
    assert new.tags == []
    assert new.revision == old.revision + 1
    assert store.config.revision == before.config.revision + 1


@pytest.mark.parametrize("bad_values", [
    {"knowledge_level": "expert"},
    {"interest_level": "maximum"},
    {"tags": "tag_missing"},
    {"status": "archived"},
    {"target_id": "kn_someone_else"},
])
def test_invalid_review_does_not_publish_and_keeps_input(review_workspace, bad_values):
    data, state, client = review_workspace
    proposal = create_ai_knowledge(ProposalService(data, state))
    pending = data / "proposals/pending" / f"{proposal.id}.json"
    original = pending.read_bytes()
    before = (data / "generated/persona.snapshot.json").read_bytes()
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={
            "proposal_revision": proposal.proposal_revision,
            "title": "Keep my correction",
            "review_note": "Keep this explanation too",
            **bad_values,
        },
    )
    assert response.status_code == 422
    assert 'role="alert"' in response.text
    assert "Keep this explanation too" in response.text
    if not ({"status", "target_id"} & set(bad_values)):
        assert 'value="Keep my correction"' in response.text
    assert pending.read_bytes() == original
    assert (data / "generated/persona.snapshot.json").read_bytes() == before
    assert proposal.target_id not in PersonaStore(data).load().records


@pytest.mark.parametrize("changed", ["record", "proposal"])
def test_stale_review_cannot_overwrite_a_newer_version(review_workspace, changed):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    proposal = service.create_update(
        "kn_demo_tebd", {"summary": "AI suggestion"}, reason="Review candidate"
    )
    if changed == "record":
        newer = service.create_update(
            "kn_demo_tebd", {"summary": "New approved summary"}, reason="Newer decision"
        )
        service.accept(newer.id)
    else:
        service.defer(proposal.id)
    before = (data / "generated/persona.snapshot.json").read_bytes()
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={"proposal_revision": proposal.proposal_revision, "knowledge_level": "familiar"},
    )
    assert response.status_code == 409
    assert (data / "generated/persona.snapshot.json").read_bytes() == before
    saved = service.repository.get(proposal.id)
    assert saved.status == ("stale" if changed == "record" else "deferred")
    assert saved.review_patch == []


def test_unchanged_review_is_a_normal_acceptance(review_workspace):
    data, state, client = review_workspace
    proposal = create_ai_knowledge(ProposalService(data, state))
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={
            "proposal_revision": proposal.proposal_revision,
            "knowledge_level": "aware", "interest_level": "unspecified",
            "aliases": "", "summary": "", "scope_note": "", "body": "", "tags": "",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    accepted = ProposalRepository(data).get(proposal.id)
    assert accepted.status == "accepted"
    assert accepted.review_patch == []
    assert client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={"proposal_revision": proposal.proposal_revision, "interest_level": "high"},
    ).status_code == 422


def test_reverting_the_entire_update_does_not_publish_a_noop(review_workspace):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    old = PersonaStore(data).load().records["kn_demo_tebd"].record
    proposal = service.create_update(old.id, {"summary": "AI summary"}, reason="Candidate")
    before = (data / "generated/persona.snapshot.json").read_bytes()
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={"proposal_revision": proposal.proposal_revision, "summary": old.summary},
    )
    assert response.status_code == 422
    assert "无需发布" in response.text
    assert service.repository.get(proposal.id).status == "pending_review"
    assert (data / "generated/persona.snapshot.json").read_bytes() == before


def test_failed_publication_retains_original_proposal(review_workspace, monkeypatch):
    data, state, _ = review_workspace
    service = ProposalService(data, state)
    proposal = create_ai_knowledge(service)
    pending = data / "proposals/pending" / f"{proposal.id}.json"
    before = pending.read_bytes()
    snapshot = (data / "generated/persona.snapshot.json").read_bytes()
    original_build = PersonaCompiler.build
    calls = 0

    def fail_first_build(compiler):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated projection failure")
        return original_build(compiler)

    monkeypatch.setattr(PersonaCompiler, "build", fail_first_build)
    with pytest.raises(RuntimeError, match="simulated projection failure"):
        service.accept(proposal.id, review_updates={"knowledge_level": "proficient"})
    assert pending.read_bytes() == before
    assert (data / "generated/persona.snapshot.json").read_bytes() == snapshot
    assert proposal.target_id not in PersonaStore(data).load().records


def test_course_review_and_english_labels(review_workspace):
    data, state, client = review_workspace
    proposal = ProposalService(data, state).create_record(
        "course",
        {
            "title": "Linear algebra",
            "knowledge_level": "aware",
            "interest_level": "low",
            "description": "Vector spaces and linear maps.",
            "syllabus": "1. Vector spaces\n2. Eigenvalues",
        },
        reason="Study history", submitted_by="ai",
    )
    client.cookies.set("ai_persona_locale", "en")
    page = client.get(f"/review/{proposal.id}")
    assert page.url.path == "/inbox"
    projected = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
    fields = {f["name"]: f["label"] for f in projected["fields"]}
    assert "semantic_role" not in fields
    assert fields["description"] == "Course description"
    assert fields["syllabus"] == "Course syllabus"
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={
            "proposal_revision": proposal.proposal_revision,
            "knowledge_level": "familiar",
            "description": "Vector spaces, linear maps, and matrix decompositions.",
        },
    )
    assert response.status_code == 200
    course = PersonaStore(data).load().records[proposal.target_id].record
    assert course.knowledge_level == "familiar"
    assert course.description == "Vector spaces, linear maps, and matrix decompositions."
    assert course.syllabus == "1. Vector spaces\n2. Eigenvalues"


@pytest.mark.parametrize(("record_id", "field", "value"), [
    ("mat_demo_tebd_note", "preference_level", "neutral"),
    ("rel_demo_material_covers_tebd", "statement", "The note uses TEBD to evolve a spin chain."),
])
def test_other_record_review_forms_publish_corrections(review_workspace, record_id, field, value):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    suggested = "disliked" if field == "preference_level" else value + " AI"
    proposal = service.create_update(record_id, {field: suggested}, reason="Candidate")
    page = client.get(f"/review/{proposal.id}")
    assert page.status_code == 200
    assert field in client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]["values"]
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={"proposal_revision": proposal.proposal_revision, field: value},
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert getattr(PersonaStore(data).load().records[record_id].record, field) == value


def test_new_preference_records_support_review_corrections(review_workspace):
    data, state, client = review_workspace
    service = ProposalService(data, state)
    context = service.create_record(
        "preference_context",
        {
            "key": "writing.notes",
            "name": "Research notes",
            "description": "Notes that explain technical work.",
            "activation": {},
        },
    )
    service.accept(context.id)
    preference_context = PersonaStore(data).load().records[context.target_id].record
    preference = service.create_record(
        "preference",
        {
            "scope": "contexts",
            "context_refs": [preference_context.id],
            "behavior": "preferred",
            "instruction": "Show the reasoning path before details.",
            "condition": "",
            "rationale": "",
        },
    )
    service.accept(preference.id)
    staged = stage_source(
        data,
        content=b"First show the three steps, then work through each one.\n",
        filename="reasoning-path.md",
        source_type="other",
        provider="test-upload",
        media_type="text/markdown",
        identifier="reasoning-path.md",
    )
    example = service.create_record(
        "preference_example",
        {
            "context_refs": [preference_context.id],
            "example_type": "positive",
            "title": "Reasoning path first",
            "condition": "",
            "reasons": [],
            "source_ref": staged.manifest.id,
            "content_hash": f"sha256:{staged.manifest.content_hash}",
        },
    )
    service.accept(example.id)

    cases = [
        (preference_context.id, "description", "Research notes and derivations."),
        (preference.target_id, "instruction", "Explain the reasoning path before details."),
        (example.target_id, "title", "A clear reasoning path"),
    ]
    for record_id, field, final_value in cases:
        proposal = service.create_update(record_id, {field: final_value + " AI"})
        page = client.get(f"/review/{proposal.id}")
        assert page.status_code == 200
        projection = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
        assert field in projection["values"]
        if record_id == preference.target_id:
            assert "context_refs" in projection["values"]
            assert "Research notes" in next(f for f in projection["fields"] if f["name"] == "context_refs")["choices"].values()
        response = client.post(
            f"/review/{proposal.id}/edit-and-accept",
            data={"proposal_revision": proposal.proposal_revision, field: final_value},
            follow_redirects=False,
        )
        assert response.status_code == 303
        record = PersonaStore(data).load().records[record_id].record
        assert getattr(record, field) == final_value
