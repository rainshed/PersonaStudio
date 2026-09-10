from __future__ import annotations

import json
import re

import pytest
from fastapi.testclient import TestClient

from ai_persona.compiler import PersonaCompiler
from ai_persona.index import prepare_context, search_index
from ai_persona.initialization import initialize_persona
from ai_persona.materials import stage_pasted_source
from ai_persona.models import SCHEMA_MODELS
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app

COLLECTIONS = {
    "knowledge_node": "knowledge",
    "course": "courses",
    "material": "materials",
}
SNAPSHOT_KEYS = {"knowledge_node": "knowledge_nodes", "course": "courses", "material": "materials"}
SCHEMAS = {
    "knowledge_node": "knowledge-node.v1.schema.json",
    "course": "course.v1.schema.json",
    "material": "material.v3.schema.json",
}


@pytest.fixture
def empty_workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    initialize_persona(data, state, persona_id="unset-levels")
    return data, state, TestClient(create_app(data, state))


def candidate_values(data, entity_type):
    values = {"title": "Krylov research"}
    if entity_type == "material":
        source = stage_pasted_source(data, text="# Krylov research", source_type="note")
        values.update({
            "material_type": "note",
            "bibliography": {},
            "source_ref": source.manifest.id,
            "user_relationships": ["read"],
            "preference_level": "unspecified",
        })
    else:
        values["interest_level"] = "unspecified"
        if entity_type == "knowledge_node":
            values["semantic_role"] = "method"
    return values


def level_select(html):
    match = re.search(r'<select name="knowledge_level"[^>]*>.*?</select>', html, re.S)
    assert match is not None
    return match.group()


def confirm(client, proposal, **updates):
    response = client.post(
        f"/review/{proposal.id}/edit-and-accept",
        data={"proposal_revision": proposal.proposal_revision, **updates},
        follow_redirects=False,
    )
    assert response.status_code == 303


@pytest.mark.parametrize("entity_type", COLLECTIONS)
def test_omitted_level_survives_review_publication_and_rebuild(empty_workspace, entity_type):
    data, state, client = empty_workspace
    proposal = ProposalService(data, state).create_record(
        entity_type, candidate_values(data, entity_type), reason="From supplied material",
        submitted_by="ai",
    )
    assert proposal.target_id not in PersonaStore(data).load().records
    assert search_index(state, "Krylov") == []
    level_patch = next(item for item in proposal.patch if item.field == "knowledge_level")
    assert level_patch.after == "unspecified"

    page = client.get(f"/review/{proposal.id}")
    assert page.status_code == 200
    projected = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
    field = next(f for f in projected["fields"] if f["name"] == "knowledge_level")
    assert projected["values"]["knowledge_level"] == "unspecified"
    assert field["choices"]["unspecified"] == "未设置"
    assert not field["required"]
    confirm(client, proposal, knowledge_level="unspecified")

    store = PersonaStore(data).load()
    loaded = store.records[proposal.target_id]
    assert loaded.record.knowledge_level == "unspecified"
    assert "knowledge_level: unspecified" in loaded.path.read_text()
    accepted = ProposalRepository(data).get(proposal.id)
    assert accepted.status == "accepted"
    assert accepted.review_patch == []
    assert accepted.submitted_by == "ai"
    assert store.config.revision == 2

    snapshot_path = data / "generated/persona.snapshot.json"
    before = snapshot_path.read_bytes()
    snapshot = json.loads(before)
    assert snapshot[SNAPSHOT_KEYS[entity_type]][0]["knowledge_level"] == "unspecified"
    context = prepare_context(state, context_key="note.write", question="Krylov")
    assert context["relevant_knowledge"][0]["knowledge_level"] == "unspecified"
    grouped = (data / "generated/human/by-level.md").read_text()
    assert "## unspecified" in grouped and proposal.target_id in grouped

    collection = COLLECTIONS[entity_type]
    detail = client.get(f"/{collection}/{proposal.target_id}")
    assert detail.status_code == 200
    assert "未设置" in detail.text
    results = client.get(f"/{collection}?knowledge_level=unspecified")
    assert results.status_code == 200 and "Krylov research" in results.text
    filtered = client.get(f"/{collection}?knowledge_level=aware")
    assert filtered.context["records"] == []
    dashboard = client.get("/")
    assert dashboard.context["active_counts"][entity_type] == 1
    assert dashboard.context["active_counts"].get("knowledge_node", 0) == (entity_type == "knowledge_node")
    assert 'class="home-asset-grid"' in dashboard.text

    schema_path = data / "schemas" / SCHEMAS[entity_type]
    schema = json.loads(schema_path.read_text())
    assert "knowledge_level" not in schema["required"]
    assert schema["properties"]["knowledge_level"]["default"] == "unspecified"
    assert schema == (
        SCHEMA_MODELS[SCHEMAS[entity_type]].model_json_schema(by_alias=True)
    )
    PersonaCompiler(data, state).build()
    assert snapshot_path.read_bytes() == before
    assert search_index(state, "Krylov")[0]["knowledge_level"] == "unspecified"


@pytest.mark.parametrize("collection", COLLECTIONS.values())
def test_new_forms_default_to_unset_in_both_languages(empty_workspace, collection):
    _, _, client = empty_workspace
    for locale, label in [("zh-CN", "未设置"), ("en", "Unspecified")]:
        client.cookies.set("ai_persona_locale", locale)
        response = client.get(f"/{collection}/new")
        assert response.status_code == 200
        select = level_select(response.text)
        assert f'value="unspecified" selected>{label}</option>' in select
        assert "required" not in select


def test_course_content_fields_are_optional_in_forms_and_schema(empty_workspace):
    data, _, client = empty_workspace
    for locale, labels in [
        ("zh-CN", ("课程简介", "课程大纲")),
        ("en", ("Course description", "Course syllabus")),
    ]:
        client.cookies.set("ai_persona_locale", locale)
        page = client.get("/courses/new")
        assert page.status_code == 200
        for name, label in zip(("description", "syllabus"), labels, strict=True):
            assert label in page.text
            field = re.search(rf'<textarea name="{name}"[^>]*>', page.text)
            assert field is not None
            assert "required" not in field.group()

    schema = json.loads((data / "schemas/course.v1.schema.json").read_text())
    assert "description" not in schema["required"]
    assert "syllabus" not in schema["required"]
    assert schema["properties"]["description"]["default"] == ""
    assert schema["properties"]["syllabus"]["default"] == ""


@pytest.mark.parametrize("collection", COLLECTIONS.values())
@pytest.mark.parametrize("level", [None, ""])
def test_form_submission_accepts_missing_or_empty_level(empty_workspace, collection, level):
    data, _, client = empty_workspace
    values = {
        "title": "Krylov research", "semantic_role": "method",
        "interest_level": "unspecified", "reason": "Create an initial entry",
    }
    if collection == "materials":
        values.update({
            "material_type": "note", "source_mode": "paste",
            "source_text": "# Krylov research", "relationships": "read",
            "preference_level": "unspecified",
        })
    if level is not None:
        values["knowledge_level"] = level
    response = client.post(f"/{collection}/proposals", data=values, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"].startswith(f"/{collection}/")
    assert ProposalRepository(data).list_pending() == []
    proposal = ProposalRepository(data).list_history()[0]
    assert proposal.status == "accepted"
    assert PersonaStore(data).load().records[proposal.target_id].record.knowledge_level == (
        "unspecified"
    )


@pytest.mark.parametrize("entity_type", COLLECTIONS)
def test_review_can_clear_an_existing_level_and_later_fill_it(empty_workspace, entity_type):
    data, state, client = empty_workspace
    service = ProposalService(data, state)
    values = candidate_values(data, entity_type)
    values["knowledge_level"] = "familiar"
    original = service.create_record(entity_type, values, reason="Known level")
    confirm(client, original)

    proposal = service.create_update(
        original.target_id, {"title": "Updated Krylov research"}, reason="Revise title",
        submitted_by="ai",
    )
    assert PersonaStore(data).load().records[original.target_id].record.knowledge_level == "familiar"
    confirm(client, proposal, knowledge_level="unspecified")
    accepted = service.repository.get(proposal.id)
    assert accepted.status == "edited_and_accepted"
    assert not any(item.field == "knowledge_level" for item in accepted.patch)
    correction = next(item for item in accepted.review_patch if item.field == "knowledge_level")
    assert (correction.before, correction.after) == ("familiar", "unspecified")
    assert PersonaStore(data).load().records[original.target_id].record.knowledge_level == "unspecified"

    collection = COLLECTIONS[entity_type]
    edit = client.get(f"/{collection}/{original.target_id}/edit")
    assert 'value="unspecified" selected>未设置</option>' in level_select(edit.text)
    form = {
        "title": "Updated Krylov research", "semantic_role": "method",
        "knowledge_level": "proficient", "interest_level": "unspecified",
        "reason": "Add my level later",
    }
    if entity_type == "material":
        form.update({
            "material_type": "note", "relationships": "read", "preference_level": "unspecified",
        })
    response = client.post(
        f"/{collection}/{original.target_id}/proposals", data=form, follow_redirects=False,
    )
    assert response.status_code == 303 and response.headers["location"].startswith(f"/{collection}/")
    assert service.repository.list_pending() == []
    assert PersonaStore(data).load().records[original.target_id].record.knowledge_level == "proficient"
    assert search_index(state, "Krylov")[0]["knowledge_level"] == "proficient"
