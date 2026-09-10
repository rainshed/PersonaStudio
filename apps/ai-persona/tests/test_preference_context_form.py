from __future__ import annotations

import re
import shutil

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.human_edits import HumanEditService
from ai_persona.models import PreferenceContext
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    with TestClient(create_app(data, state)) as client:
        yield data, HumanEditService(data, state), client


def persisted_files(data):
    return {
        str(path.relative_to(data)): path.read_bytes()
        for root in ("records", "config", "revisions", "proposals", "generated")
        for path in (data / root).rglob("*") if path.is_file()
    }


def legacy_context(service):
    return service.create_record(
        "preference_context",
        {"name": "旧场景", "key": "legacy.notes", "activation": {"intents": ["写 note"]}},
        body="保留这段历史补充说明。\n\n第二段内容。",
    ).target_id


@pytest.mark.parametrize("missing", ["name", "description"])
@pytest.mark.parametrize("locale", ["zh-CN", "en"])
def test_required_fields_reject_whitespace_without_losing_input(workspace, missing, locale):
    data, _, client = workspace
    client.cookies.set("ai_persona_locale", locale)
    values = {
        "name": "My notes", "description": "When writing my notes",
        "request_examples": ["Explain this result", "Add a derivation"],
        "excludes": "Only translate", "artifact_types": "Research note",
    }
    values[missing] = " \n "
    before = persisted_files(data)
    response = client.post("/preferences/contexts/proposals", data=values)
    assert response.status_code == 422
    assert 'aria-invalid="true"' in response.text
    for retained in ("Explain this result", "Add a derivation", "Only translate", "Research note"):
        assert retained in response.text
    message = "请填写场景名称" if missing == "name" else "请描述这个场景在什么时候使用"
    if locale == "en":
        message = "Enter a context name" if missing == "name" else "Describe when this context"
    assert message in response.text
    assert persisted_files(data) == before


def test_individual_examples_round_trip_and_can_be_cleared(workspace):
    data, _, client = workspace
    examples = ["  Help with my notes  ", "Derive this result\nand explain the assumptions.", " "]
    response = client.post(
        "/preferences/contexts/proposals",
        data={"name": "New notes", "description": "When writing notes", "request_examples": examples},
        follow_redirects=False,
    )
    assert response.status_code == 303
    record = next(r for r in PersonaStore(data).load().of_type(PreferenceContext) if r.name == "New notes")
    assert record.key.startswith("custom.")
    assert record.activation.intents == ["Help with my notes", examples[1]]
    page = client.get(f"/preferences/contexts/{record.id}/edit")
    assert page.status_code == 200
    assert 'name="request_examples"' in page.text
    assert examples[1] in page.text
    response = client.post(
        f"/preferences/contexts/{record.id}/proposals",
        data={"name": record.name, "description": record.description,
              "record_revision": record.revision, "request_examples": ""},
        follow_redirects=False,
    )
    assert response.status_code == 303
    saved = PersonaStore(data).load().records[record.id].record
    assert saved.activation.intents == []
    assert saved.key == record.key


def test_editing_legacy_context_preserves_body_and_key(workspace):
    data, service, client = workspace
    record_id = legacy_context(service)
    old = PersonaStore(data).load().records[record_id]
    assert client.get(f"/preferences/contexts/{record_id}/edit").status_code == 200
    response = client.post(
        f"/preferences/contexts/{record_id}/proposals",
        data={"name": "Updated notes", "description": "When writing notes",
              "record_revision": old.record.revision, "request_examples": ["One", "Two"],
              "excludes": "Translation\nProofreading", "artifact_types": "Note\nReport"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    saved = PersonaStore(data).load().records[record_id]
    assert saved.body == old.body
    assert saved.record.key == old.record.key
    assert saved.record.activation.excludes == ["Translation", "Proofreading"]
    assert saved.record.activation.artifact_types == ["Note", "Report"]


def test_stale_context_edit_keeps_draft_and_original_revision(workspace):
    data, service, client = workspace
    record_id = legacy_context(service)
    old = PersonaStore(data).load().records[record_id].record
    service.create_update(record_id, {"name": "Newer saved name"})
    before = persisted_files(data)
    values = {"name": "My unsaved name", "description": "My unsaved description",
              "record_revision": old.revision, "request_examples": ["My draft example"]}
    response = client.post(f"/preferences/contexts/{record_id}/proposals", data=values)
    assert response.status_code == 409
    assert "记录已更新" in response.text
    assert "My unsaved name" in response.text
    assert "My unsaved description" in response.text
    assert "My draft example" in response.text
    revision = re.search(r'name="record_revision" value="(\d+)"', response.text).group(1)
    assert int(revision) == old.revision
    assert persisted_files(data) == before


def test_legacy_context_without_description_can_be_archived_and_restored(workspace):
    data, service, client = workspace
    record_id = legacy_context(service)
    response = client.post(f"/preferences/contexts/{record_id}/archive-proposals", follow_redirects=False)
    assert response.status_code == 303
    assert PersonaStore(data).load().records[record_id].record.status == "archived"
    page = client.get(f"/preferences/contexts/{record_id}/edit")
    assert 'formnovalidate formaction=' in page.text
    response = client.post(
        f"/preferences/contexts/{record_id}/state-proposals",
        data={"status": "active"}, follow_redirects=False,
    )
    assert response.status_code == 303
    saved = PersonaStore(data).load().records[record_id]
    assert saved.record.status == "active"
    assert saved.record.description == ""
    assert "历史补充说明" in saved.body
