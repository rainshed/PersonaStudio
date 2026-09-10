from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from test_change_set_review import submit_dependent_change_set
from test_evaluations import CANDIDATE, SIGNAL, activation_trace, click, make_learning
from test_evaluations import work as work
from test_learning_workspace import seed_tasks

from ai_persona.ai_service import DraftRepository
from ai_persona.change_sets import ChangeSetRepository
from ai_persona.evaluations.contracts import now
from ai_persona.inbox import InboxService
from ai_persona.preference_application.repository import ApplicationRepository, ApplicationSettings
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def inbox(work):
    learning, evaluations, result, model = make_learning(work, [SIGNAL, CANDIDATE])
    service = InboxService(*work, learning)
    app = create_app(*work)
    app.state.learning_service = learning
    return service, evaluations, result, model, TestClient(app)


def item_path(ref, suffix=""):
    return "/api/inbox/v1/items/" + ref + suffix


def post(client, ref, candidate, action="accept", updates=None):
    return client.post(item_path(ref, "/review/" + candidate["id"]), json={
        "action": action, "revision": candidate["revision"], "updates": updates or {},
    }, headers={"X-AI-Persona": "1"})


def material_session(data, state):
    submitted = submit_dependent_change_set(data, state)
    repository = ChangeSetRepository(data)
    manifest = repository.get(submitted.change_set_id)
    manifest.assistant_session_id = "ai_inbox_material"
    repository.save(manifest)
    DraftRepository(state).create({"id": manifest.assistant_session_id, "title": "请整理这份材料",
        "created_at": now(), "updated_at": now(), "material_id": "mat_demo_tebd_note", "record_id": None,
        "status": "submitted", "messages": [{"role": "user", "content": "请整理这份材料"}],
        "submission": {"change_set_id": manifest.id}})
    return "assistant:" + manifest.assistant_session_id


def test_review_only_material_and_independent_candidate_are_not_unrated(inbox):
    service, evaluations, result, model, client = inbox
    ref = material_session(service.data_root, service.state_root)
    proposal = ProposalService(service.data_root, service.state_root).create_record(
        "course", {"title": "仅审核的课程", "interest_level": "unspecified"}, submitted_by="ai", reason="课程候选")
    listed = client.get("/api/inbox/v1/items").json()
    by_id = {i["id"]: i for i in listed["items"]}
    assert by_id[ref]["type"] == "material" and by_id[ref]["review"]["pending"] == 3
    assert not by_id[ref]["feedback"]["supported"]
    assert by_id["proposal:" + proposal.id]["feedback"]["state"] == "not_applicable"
    feedback = client.get("/api/inbox/v1/items?view=feedback").json()
    assert {i["id"] for i in feedback["items"]} == {"learning:" + result["task_ref"]}
    detail = client.get(item_path(ref)).json()
    assert detail["feedback_value"] is None and detail["review"]["total"] == 3
    candidates = client.get(item_path(ref, "/review")).json()["proposals"]
    relation = next(p for p in candidates if p["entity_type"] == "relation" and p["dependencies"])
    assert "Candidate dependency topic" in relation["title"] and "涵盖" in relation["title"]
    selected = client.get(item_path("proposal:" + proposal.id, "/review")).json()["proposals"][0]
    assert post(client, "proposal:" + proposal.id, selected, updates={"title": "人工确认的课程"}).status_code == 200
    assert evaluations.cases() == [] and len(model.calls) == 2


def test_shared_review_preserves_fields_dependencies_and_feedback_boundaries(inbox):
    service, evaluations, result, _, client = inbox
    ref = "learning:" + result["task_ref"]
    proposal = client.get(item_path(ref, "/review")).json()["proposals"][0]
    case = click(evaluations, result)
    response = post(client, ref, proposal, updates={"title": "在统一工作台修改", "aliases": ["alias"], "body": "简短备注"})
    assert response.status_code == 200, response.text
    saved = response.json()["proposals"][0]
    assert saved["saved"]["title"] == "在统一工作台修改" and saved["values"]["aliases"] == ["alias"]
    old = client.get(f'/api/learning/v1/events/{result["task_ref"]}/review').json()["proposals"][0]
    assert old == saved
    assert post(client, ref, proposal).status_code == 409
    assert evaluations.case(case["case_id"])["trigger_labels"][0]["expected_trigger"]
    gold = evaluations.case(case["case_id"])
    evaluations.withdraw(case["case_id"], {"kind": "learning_gate"}, gold["feedback"]["revision"])
    assert saved["target_id"] in PersonaStore(service.data_root).load().records
    assert client.get(item_path(ref)).json()["feedback"]["state"] == "unrated"


def test_material_dependencies_defer_reject_and_ownership(inbox):
    service, evaluations, result, _, client = inbox
    ref = material_session(service.data_root, service.state_root)
    values = client.get(item_path(ref, "/review")).json()["proposals"]
    root = next(p for p in values if p["entity_type"] == "knowledge_node")
    child = next(p for p in values if p["dependencies"])
    assert post(client, ref, child).status_code == 422
    deferred = post(client, ref, root, action="defer")
    assert deferred.status_code == 200, deferred.text
    assert post(client, ref, root, action="defer").status_code == 409
    root = next(p for p in deferred.json()["proposals"] if p["id"] == root["id"])
    rejected = post(client, ref, root, action="reject").json()["proposals"]
    assert sum(p["status"] == "rejected" for p in rejected) == 2
    unrelated = client.get(item_path("learning:" + result["task_ref"], "/review")).json()["proposals"][0]
    assert post(client, ref, unrelated).status_code == 422
    assert evaluations.cases() == []


def test_all_negative_scenes_partial_feedback_and_application_deduplication(inbox):
    service, evaluations, _, _, client = inbox
    result = activation_trace(evaluations, False, False)
    repository = ApplicationRepository(service.state_root)
    row, _ = repository.claim("inbox-test", {"user_prompt": "写一份 note", "connection_name": "测试来源"}, ApplicationSettings())
    repository.update(row["id"], {"result_id": result["id"], "status": "returned", "decision_state": "completed"})
    ref = "application:" + row["id"]
    items = client.get("/api/inbox/v1/items?view=feedback&type=activation").json()["items"]
    assert len(items) == 1 and items[0]["id"] == ref and items[0]["matched_count"] == 0
    click(evaluations, result, "unsatisfied")
    item = client.get(item_path(ref)).json()
    assert item["feedback"]["state"] == "partial" and item["feedback"]["unrated"] == 1
    assert len(item["feedback_value"]["decisions"]) == 2
    assert item["review"]["total"] == 0 and item["runtime"]["status"] == "returned"
    assert evaluations.cases()[0]["trigger_labels"][0]["expected_trigger"] is True


def test_full_history_paging_filter_before_slice_pinned_rows_and_new_boundary(inbox):
    service, evaluations, result, _, client = inbox
    seeded = seed_tasks(service.learning, evaluations, result, 105)
    first = service.list({"view": "feedback", "type": "learning"})
    seen = {i["id"] for i in first["items"]}
    assert first["total"] == 106
    page = first
    while page["next_cursor"]:
        page = service.list({"view": "feedback", "type": "learning", "cursor": page["next_cursor"]})
        assert not seen.intersection(i["id"] for i in page["items"])
        seen.update(i["id"] for i in page["items"])
    assert len(seen) == 106
    row = first["items"][0]
    click(evaluations, evaluations.result(row["result_id"]))
    updated = service.list({"view": "feedback", "type": "learning", "cursor": first["cursor"], "ids": row["id"]})
    assert updated["updates"][0]["matches"] is False and updated["updates"][0]["feedback"]["rated"] == 1
    target = service.list({"view": "all", "q": "任务 000"})
    assert len(target["items"]) == 1 and target["items"][0]["id"] == "learning:" + seeded[0][0]
    # The newest seeded row may be the one just rated on a slower machine.
    # Move an unrated row across the boundary so it still matches this filter.
    new_id = next(event_id for event_id, _ in reversed(seeded) if "learning:" + event_id != row["id"])
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET created=? WHERE id=?", (time.time() + 10, new_id))
    updated = service.list({"view": "feedback", "type": "learning", "cursor": first["cursor"]})
    assert updated["new_count"] == 1


def test_retry_does_not_inherit_feedback_and_old_result_remains_reachable(inbox):
    service, evaluations, result, _, client = inbox
    click(evaluations, result)
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='queued' WHERE id=?", (result["task_ref"],))
    row = client.get(item_path("learning:" + result["task_ref"])).json()
    assert row["feedback"]["state"] == "waiting" and row["result_id"] is None
    old = client.get(item_path("result:" + result["id"])).json()
    assert old["feedback"]["state"] == "satisfied" and old["result_id"] == result["id"]


def test_replays_are_not_daily_feedback_tasks_and_missing_source_cases_stay_accessible(inbox):
    service, evaluations, result, _, client = inbox
    case = click(evaluations, result)
    replay = evaluations.create_result(result["capability_id"], task_ref="evaluation:run_test", input_data=result["input"], parent_case_id=case["case_id"])
    evaluations.complete_result(replay["id"], state="completed", decisions=result["decisions"])
    assert replay["id"] not in json.dumps(service.list({"view": "all"}))
    with service.learning.repository.transaction() as db:
        db.execute("DELETE FROM events WHERE id=?", (result["task_ref"],))
    detail = client.get(item_path("result:" + result["id"])).json()
    assert detail["feedback"]["state"] == "satisfied" and detail["input_text"]
    assert len(evaluations.cases()) == 1


def test_transports_reject_cross_site_and_reading_never_calls_models(inbox):
    service, evaluations, result, model, client = inbox
    revision = PersonaStore(service.data_root).load().config.revision
    ref = "learning:" + result["task_ref"]
    assert client.get("/inbox").status_code == 200
    home = client.get('/').text
    assert 'class="home-review-notice"' in home and 'href="/inbox"' in home
    assert '/settings?tab=capabilities' in client.get('/inbox').text
    response = client.get("/api/inbox/v1/items")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert all(not any(k.startswith('_') for k in item) for item in response.json()["items"])
    assert client.get("/api/inbox/v1/items", headers={"Origin":"https://elsewhere.invalid"}).status_code == 403
    proposal = client.get(item_path(ref, "/review")).json()["proposals"][0]
    assert client.post(item_path(ref, "/review/" + proposal["id"]), json={}).status_code == 403
    assert client.get("/api/inbox/v1/items?cursor=broken").status_code == 400
    assert client.get("/api/inbox/v1/items?view=unknown").status_code == 400
    assert client.get("/api/inbox/v1/items?limit=101").status_code == 400
    assert not evaluations.cases() and len(model.calls) == 2
    assert PersonaStore(service.data_root).load().config.revision == revision


def test_feedback_read_failure_is_never_unrated(inbox, monkeypatch):
    service, _, _, _, _ = inbox
    monkeypatch.setattr(service.evaluations, "inbox_summaries", lambda: (_ for _ in ()).throw(OSError("fixture")))
    page = service.list({"view": "all"})
    assert page["warnings"]
    assert all(i["feedback"]["state"] in {"unavailable", "not_applicable"} for i in page["items"])
    assert service.list({"view": "feedback"})["total"] == 0


def test_nested_material_properties_follow_model_and_persistence_contract(inbox):
    service, _, _, _, client = inbox
    publisher = ProposalService(service.data_root, service.state_root)
    proposal = publisher.create_update("mat_demo_tebd_note", {"summary":"需要审核的材料摘要"}, submitted_by="ai", reason="材料整理")
    ref = "proposal:" + proposal.id
    item = client.get(item_path(ref, "/review")).json()["proposals"][0]
    assert next(f for f in item["fields"] if f["name"] == "preference_reasons")["kind"] == "json"
    saved = post(client, ref, item, updates={"summary":"确认后的摘要", "preference_reasons":[{"aspect":"other", "note":"便于复习"}]})
    assert saved.status_code == 200, saved.text
    current = ProposalRepository(service.data_root).get(proposal.id)
    assert current.status == "edited_and_accepted"
    assert saved.json()["proposals"][0]["values"]["preference_reasons"] == [{"aspect":"other", "note":"便于复习"}]
