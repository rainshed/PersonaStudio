from __future__ import annotations

import re
import shutil
from html import unescape
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.compiler import PersonaCompiler
from ai_persona.human_edits import HumanEditService
from ai_persona.models import Preference, PreferenceExample
from ai_persona.preference_views import preference_return_url
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    service = HumanEditService(data, state)
    a = service.create_record("preference_context", {
        "name": "Alpha notes", "key": "workspace.notes", "description": "Write notes",
    }).target_id
    b = service.create_record("preference_context", {
        "name": "Beta plots", "key": "workspace.plots", "description": "Draw plots",
    }).target_id
    rules = {}
    for name, refs, status in [
        ("Shared guidance", [], "active"), ("Notes only", [a], "active"),
        ("Plots only", [b], "active"), ("Both contexts", [a, b], "active"),
        ("Paused note", [a], "paused"), ("Archived note", [a], "archived"),
    ]:
        rules[name] = service.create_record("preference", {
            "scope": "contexts" if refs else "global", "context_refs": refs,
            "behavior": "preferred", "instruction": name,
            "condition": "Only when writing a full explanation",
        }).target_id
        if status == "archived":
            service.create_archive(rules[name])
        elif status != "active":
            service.create_update(rules[name], {"status": status})
    with TestClient(create_app(data, state)) as client:
        for name, refs in [("Notes sample", [a]), ("Shared sample", [a, b]), ("Plots sample", [b])]:
            result = client.post("/preferences/examples/proposals", data={
                "title": name, "example_type": "positive", "context_refs": refs,
                "condition": "When explaining a figure",
            }, files={"sample_file": (name + ".md", b"Sample content", "text/markdown")},
                follow_redirects=False)
            assert result.status_code == 303
        yield data, service, client, a, b, rules


def ids(page, kind):
    return re.findall(fr'data-{kind}-id="([^"]+)"', page.text)


def test_context_contains_scoped_and_global_preferences_with_only_its_samples(workspace):
    data, _, client, a, b, rules = workspace
    samples = {r.title: r for r in PersonaStore(data).load().of_type(PreferenceExample)}
    page = client.get(f"/preferences?context={a}")
    assert page.status_code == 200
    assert set(ids(page, "preference")) == {
        rules["Notes only"], rules["Both contexts"], rules["Shared guidance"],
    }
    assert set(ids(page, "sample")) == {samples["Notes sample"].id, samples["Shared sample"].id}
    assert len(ids(page, "preference")) == 3
    assert 'data-rule-group="global"' in page.text
    assert "Only when writing a full explanation" in page.text
    b_page = client.get(f"/preferences?context={b}")
    assert rules["Notes only"] not in ids(b_page, "preference")
    assert samples["Notes sample"].id not in ids(b_page, "sample")


def test_all_tasks_and_all_preferences_are_distinct_and_deduplicated(workspace):
    _, _, client, _, _, rules = workspace
    global_page = client.get("/preferences?context=global")
    assert ids(global_page, "preference") == [rules["Shared guidance"]]
    assert ids(global_page, "sample") == []
    all_page = client.get("/preferences?context=all")
    assert len(ids(all_page, "preference")) == len(set(ids(all_page, "preference"))) == 4
    assert len(ids(all_page, "sample")) == len(set(ids(all_page, "sample"))) == 3


def test_context_selection_is_remembered_and_invalid_selection_falls_back(workspace):
    _, _, client, a, b, _ = workspace
    client.get(f"/preferences?context={b}")
    assert f'data-selected-context="{b}"' in client.get("/preferences").text
    assert f'data-selected-context="{b}"' in client.get("/preferences?context=missing").text
    client.get(f"/preferences?context={a}")
    assert f'data-selected-context="{a}"' in client.get("/preferences").text


def test_filters_do_not_remove_samples_due_to_preference_text_search(workspace):
    _, _, client, a, _, rules = workspace
    page = client.get(f"/preferences?context={a}&q=Notes%20only")
    assert ids(page, "preference") == [rules["Notes only"]]
    assert len(ids(page, "sample")) == 2
    paused = client.get(f"/preferences?context={a}&status=paused")
    assert ids(paused, "preference") == [rules["Paused note"]]
    archived = client.get(f"/preferences?context={a}&status=archived")
    assert ids(archived, "preference") == [rules["Archived note"]]


def test_create_forms_preselect_the_context_and_save_back_to_it(workspace):
    data, _, client, a, _, _ = workspace
    page = client.get(f"/preferences?context={a}")
    link = unescape(re.search(r'href="(/preferences/new\?[^"]+)"', page.text).group(1))
    form = client.get(link)
    assert re.search(r'name="scope" value="contexts"\s+checked', form.text)
    assert re.search(fr'name="context_refs" value="{a}"\s+checked', form.text)
    context_input = re.search(fr'<input[^>]*name="context_refs"[^>]*value="{a}"[^>]*>', form.text).group(0)
    assert "disabled" not in context_input
    destination = parse_qs(urlsplit(link).query)["return_to"][0]
    response = client.post("/preferences/proposals", data={
        "scope": "contexts", "context_refs": [a], "instruction": "Created in context",
        "behavior": "required", "return_to": destination,
    }, follow_redirects=False)
    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["context"] == [a]
    record = next(r for r in PersonaStore(data).load().of_type(Preference) if r.instruction == "Created in context")
    assert record.context_refs == [a]
    sample_link = unescape(re.search(r'href="(/preferences/examples/new\?[^"]+)"', page.text).group(1))
    sample_form = client.get(sample_link)
    assert re.search(fr'name="context_refs" value="{a}"\s+checked', sample_form.text)
    invalid = client.get("/preferences/new?context_id=missing")
    assert re.search(r'name="scope" value="global"\s+checked', invalid.text)


def test_sample_file_path_points_to_openable_content_and_actions_keep_context(workspace):
    data, _, client, a, _, _ = workspace
    store = PersonaStore(data).load()
    sample = next(r for r in store.of_type(PreferenceExample) if r.title == "Notes sample")
    manifest = store.sources[sample.source_ref]
    path = data / "sources" / sample.source_ref / manifest.canonical_file
    page = client.get(f"/preferences?context={a}")
    assert str(path.resolve()) in page.text
    assert client.get(f"/preferences/examples/{sample.id}/file").content == path.read_bytes()
    destination = f"/preferences?context={a}"
    response = client.post(f"/preferences/examples/{sample.id}/state-proposals", data={
        "status": "paused", "return_to": destination,
    }, follow_redirects=False)
    assert response.headers["location"].startswith(destination + "&")
    assert sample.id not in ids(client.get(destination), "sample")
    assert sample.id in ids(client.get(destination + "&status=paused"), "sample")
    for endpoint, values in [("archive-proposals", {}), ("state-proposals", {"status": "active"})]:
        response = client.post(f"/preferences/examples/{sample.id}/{endpoint}",
                               data={**values, "return_to": destination}, follow_redirects=False)
        assert response.status_code == 303
        assert response.headers["location"].startswith(destination + "&")


def test_archived_context_remains_reachable_and_restorable(workspace):
    _, service, client, b, _, _ = workspace
    a = service.create_record("preference_context", {
        "name": "Unused context", "key": "unused.context",
    }).target_id
    client.get(f"/preferences?context={a}")
    service.create_archive(a)
    page = client.get(f"/preferences?context={a}")
    assert page.status_code == 200
    assert f'data-selected-context="{a}"' in page.text
    assert 'value="archived" selected' in page.text
    # Opening the root does not remain stuck on an archived remembered context.
    assert f'data-selected-context="{b}"' in client.get("/preferences").text
    response = client.post(f"/preferences/contexts/{a}/state-proposals",
                           data={"status": "active"}, follow_redirects=False)
    assert response.status_code == 303
    assert parse_qs(urlsplit(response.headers["location"]).query)["context"] == [a]


def test_english_workspace_and_large_context_picker_render(workspace):
    _, service, client, a, _, _ = workspace
    for index in range(5):
        service.create_record("preference_context", {"name": f"Extra {index}", "key": f"extra.{index}"})
    client.cookies.set("ai_persona_locale", "en")
    page = client.get(f"/preferences?context={a}")
    assert page.status_code == 200
    assert "Applicable preferences" in page.text
    assert "Shared preferences" in page.text
    assert 'data-scene-search' in page.text


@pytest.mark.parametrize("value", ["https://example.com", "//example.com/preferences", "http://[", "/other"])
def test_return_destination_cannot_leave_workspace(value):
    assert preference_return_url(value, "/preferences?context=global") == "/preferences?context=global"
