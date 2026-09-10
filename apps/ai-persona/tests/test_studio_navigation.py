from datetime import datetime
from html import unescape
from urllib.parse import parse_qs, urlparse

import pytest
from test_evaluations import activation_trace
from test_evaluations import work as work
from test_inbox import inbox as inbox
from test_inbox import material_session
from test_learning_workspace import seed_tasks

from ai_persona.models import PreferenceContext
from ai_persona.preference_application.repository import ApplicationRepository, ApplicationSettings
from ai_persona.proposals import ProposalService
from ai_persona.store import PersonaStore


def test_dates_and_oldest_order_use_full_collection_and_stable_cursor(inbox):
    service, evaluations, result, _, client = inbox
    tasks = seed_tasks(service.learning, evaluations, result, count=5)
    with service.learning.repository.transaction() as db:
        for day, (event_id, _) in enumerate(tasks, 1):
            db.execute("UPDATE events SET created=? WHERE id=?", (datetime(2026, 1, day, 12).timestamp(), event_id))
    query = {"view": "all", "type": "learning", "from": "2026-01-02", "to": "2026-01-04", "order": "oldest", "limit": 2}
    page = service.list(query)
    assert page["total"] == 3
    assert [i["id"] for i in page["items"]] == ["learning:" + t[0] for t in tasks[1:3]]
    next_page = service.list({**query, "cursor": page["next_cursor"]})
    assert [i["id"] for i in next_page["items"]] == ["learning:" + tasks[3][0]]
    for extra in [{"from": "2026-02-31"}, {"from": "2026-01-05"}, {"order": "random"}]:
        assert client.get("/api/inbox/v1/items", params={**query, **extra}).status_code == 400


def test_same_turn_link_uses_existing_source_identity_not_matching_words(inbox):
    service, _, result, _, _ = inbox
    event = service.learning.repository.get(result["task_ref"])
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET external_id='codex_exact-turn' WHERE id=?", (event["id"],))
    repo = ApplicationRepository(service.state_root)
    request = {"connection_id": event["connection_id"], "connection_name": "Test", "user_prompt": "different displayed text"}
    application, _ = repo.claim("exact-turn", request, ApplicationSettings())
    unrelated, _ = repo.claim("another-turn", {**request, "user_prompt": result["input"]["event"]["message"]["content"][0]["text"]}, ApplicationSettings())
    detail = service.detail("learning:" + event["id"])
    assert detail["related"] == [{"id": "application:" + application["id"], "type": "activation"}]
    assert service.detail("application:" + unrelated["id"])["related"] == []


def test_material_and_scene_entry_filters_do_not_duplicate_candidates(inbox):
    service, evaluations, _, _, _ = inbox
    ref = material_session(service.data_root, service.state_root)
    page = service.list({"view": "all", "material": "mat_demo_tebd_note"})
    assert [i["id"] for i in page["items"]] == [ref]
    assert page["items"][0]["materials"][0]["name"] != "mat_demo_tebd_note"
    result = activation_trace(evaluations, False, False)
    page = service.list({"view": "all", "context": "note.write"})
    assert [i["result_id"] for i in page["items"]] == [result["id"]]
    assert service.list({"view": "all", "context": "unknown"})["total"] == 0
    proposals = service.review(ref)["proposals"]
    root = next(p for p in proposals if p["pending_dependents"])
    assert "Candidate dependency topic" in root["dependent_titles"][0]
    assert not root["dependent_titles"][0].startswith("rel_")


def test_scene_snapshot_stays_frozen_after_current_context_changes(inbox):
    service, evaluations, _, _, _ = inbox
    publisher = ProposalService(service.data_root, service.state_root)
    new = publisher.create_record("preference_context", {"key": "note.write", "name": "写 note", "description": "旧边界"})
    publisher.accept(new.id)
    scene = next(c for c in PersonaStore(service.data_root).load().of_type(PreferenceContext) if c.key == "note.write")
    result = evaluations.create_result("persona.activation", input_data={"user_prompt": "写 note", "catalog": [
        {"key": scene.key, "name": "当时名称", "description": "当时边界", "revision": scene.revision, "activation": scene.activation.model_dump()}
    ]})
    evaluations.complete_result(result["id"], state="completed", decisions=[
        {"subject": {"kind": "activation_context", "context_key": scene.key}, "name": "当时名称", "triggered": False}
    ])
    publisher = ProposalService(service.data_root, service.state_root)
    change = publisher.create_update(scene.id, {"description": "今天修改后的边界"})
    publisher.accept(change.id)
    projected = service.detail("result:" + result["id"])["scenes"][scene.key]
    assert projected["name"] == "当时名称" and projected["description"] == "当时边界"
    assert projected["changed"] and scene.id in projected["current_url"]
    assert not evaluations.cases()


def test_downstream_failure_keeps_valid_gate_and_versioned_recovery(inbox):
    service, _, result, model, client = inbox
    ref = "learning:" + result["task_ref"]
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='failed',error_code='timeout' WHERE id=?", (result["task_ref"],))
    detail = service.detail(ref)
    assert detail["triggered"] is True and detail["feedback"]["total"] == 1
    retry = next(a for a in detail["actions"] if a["url"].endswith("/retry"))
    assert retry["body"] == {"version": detail["runtime"]["version"]}
    response = client.post(retry["url"], json={"version": -1}, headers={"X-AI-Persona": "1"})
    assert response.status_code in {400, 409} and len(model.calls) == 2


@pytest.mark.parametrize("old,expected", [
    ("/learning?event=learn_example", {"item": ["learning:learn_example"]}),
    ("/preferences/applications?application=application_example", {"item": ["application:application_example"]}),
    ("/review?change_set=chg_example", {"item": ["change_set:chg_example"]}),
])
def test_legacy_routes_preserve_identity_without_second_page_shell(inbox, old, expected):
    _, _, _, _, client = inbox
    response = client.get(old, follow_redirects=False)
    assert response.status_code == 303
    url = urlparse(response.headers["location"])
    assert url.path == "/inbox"
    query = parse_qs(url.query)
    for key, values in expected.items():
        assert query[key] == values
    assert client.get("/learning?settings=1", follow_redirects=False).headers["location"] == "/settings?tab=capabilities"


def test_manual_edit_history_remains_readonly_and_not_a_new_daily_task(inbox):
    service, evaluations, _, _, client = inbox
    publisher = ProposalService(service.data_root, service.state_root)
    proposal = publisher.create_update("kn_demo_tebd", {"summary": "人主动保存"})
    publisher.accept(proposal.id)
    detail = service.detail("proposal:" + proposal.id)
    assert not detail["feedback"]["supported"]
    assert all(i["id"] != detail["id"] for i in service.list({"view": "all", "limit": 100})["items"])
    projection = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
    assert projection["saved"]["summary"] == "人主动保存"
    assert client.get(projection["record_url"]).status_code == 200
    assert evaluations.cases() == []


def test_navigation_overview_and_settings_are_readonly(inbox, monkeypatch):
    service, evaluations, _, model, client = inbox
    monkeypatch.setattr("ai_persona.studio_web.workbench_available", lambda: False)
    page = client.get("/").text
    assert page.index('class="home-assets"') < page.index('class="home-changes"') < page.index('class="home-footer"')
    assert 'studio-asset-summary' not in page and 'review-preview' not in page
    assert "persona-nav" in page and "Prompt Workbench" not in page
    assert client.get("/api/studio/v1/workbench").json() == {"available": False}
    assert client.get("/api/studio/v1/health").json()["failure_count"] == 0
    for path in ("/api/studio/v1/health", "/api/studio/v1/workbench"):
        assert client.get(path, headers={"Origin": "https://untrusted.invalid"}).status_code == 403
    assert service.learning.repository.settings().enabled and not evaluations.cases()
    assert len(model.calls) == 2


def test_feedback_is_saved_even_if_answer_sync_temporarily_fails(inbox, monkeypatch):
    service, evaluations, result, _, client = inbox
    def unavailable(*args):
        raise OSError("temporary answer read failure")
    monkeypatch.setattr("ai_persona.evaluations.web.sync_review_gold", unavailable)
    response = client.post(f'/api/evaluations/v1/results/{result["id"]}/feedback', json={
        "subject": {"kind": "learning_gate"}, "rating": "satisfied", "reason": "",
        "expected_feedback_revision": 0, "idempotency_key": "sync-failure-test",
    }, headers={"X-AI-Persona": "1"})
    assert response.status_code == 200, response.text
    assert response.json()["answer_sync_state"] == "failed"
    case = evaluations.case(response.json()["case_id"])
    assert case["trigger_labels"][0]["expected_trigger"] and not case["content_gold"]
    assert client.get('/api/evaluations/v1/cases/' + case["case_id"]).json()["answer_sync_state"] == "failed"
    assert service.detail("learning:" + result["task_ref"])["feedback"]["state"] == "satisfied"


def test_english_ui_keeps_user_content_and_scene_trial_context(inbox):
    service, _, _, _, client = inbox
    client.cookies.set("ai_persona_locale", "en")
    for path, heading in [("/inbox", "Feedback & review"), ("/settings", "Settings"), ("/evaluations", "Evaluation"), ("/preferences/try", "scenario")]:
        page = client.get(path)
        assert page.status_code == 200 and heading.lower() in unescape(page.text).lower()
        assert "STUDIO_MESSAGES" in page.text
    publisher = ProposalService(service.data_root, service.state_root)
    proposal = publisher.create_record("preference_context", {"key": "trial.example", "name": "用户定义的场景"})
    publisher.accept(proposal.id)
    scene = next(iter(PersonaStore(service.data_root).load().of_type(PreferenceContext)))
    page = client.get("/preferences/try", params={"context": scene.id}).text
    assert scene.name in page and f'/preferences?context={scene.id}' in page
    assert "full" in page.lower()
    assert '<html lang="en">' in client.get("/learning").text
