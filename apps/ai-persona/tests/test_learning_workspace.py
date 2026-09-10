from __future__ import annotations

import copy
import json
import time

import pytest
from fastapi.testclient import TestClient
from test_evaluations import CANDIDATE, SIGNAL, click, make_learning
from test_evaluations import work as work

from ai_persona.agent import AgentServiceError
from ai_persona.conversation_learning.contracts import ConversationEvent
from ai_persona.conversation_learning.views import LearningViews
from ai_persona.evaluations.contracts import LEARNING, EvaluationError
from ai_persona.web import create_app


def seed_tasks(service, store, template, count=120):
    items = []
    for i in range(count):
        event = copy.deepcopy(template["input"]["event"])
        event["event_id"] = f"workspace-{i}"
        event["message"]["id"] = f"workspace-message-{i}"
        event["message"]["content"] = [
            {"type": "text", "text": f"任务 {i:03d}：请解释测试知识 {i} 的适用条件。"}
        ]
        row = service.ingest_event(ConversationEvent.model_validate(event), "test")
        result = store.create_result(
            LEARNING,
            task_ref=row["event_id"],
            input_data={"event": event},
            prompt_snapshot=template["prompt_snapshot"],
        )
        store.complete_result(
            result["id"],
            state="completed",
            decisions=[
                {
                    "subject": {"kind": "learning_gate"},
                    "name": "对话学习",
                    "triggered": bool(i % 2),
                }
            ],
        )
        with service.repository.transaction() as db:
            db.execute(
                "UPDATE events SET status='completed',outcome='ignored',checkpoint=?,created=? WHERE id=?",
                (
                    json.dumps({"evaluation_result_id": result["id"]}),
                    time.time() - count + i,
                    row["event_id"],
                ),
            )
        items.append((row["event_id"], result["id"]))
    return items


@pytest.fixture
def workspace(work):
    service, store, result, model = make_learning(work, [SIGNAL, CANDIDATE])
    return service, store, result, model


def test_task_pagination_filters_all_records_and_has_stable_boundary(workspace):
    service, store, result, _ = workspace
    items = seed_tasks(service, store, result)
    views = LearningViews(service)
    page = views.list({})
    assert page["total"] == 121 and len(page["events"]) == 20
    seen = {e["id"] for e in page["events"]}
    cursor = page["next_cursor"]
    while cursor:
        page = views.list({"cursor": cursor})
        assert not seen.intersection(e["id"] for e in page["events"])
        seen.update(e["id"] for e in page["events"])
        cursor = page["next_cursor"]
    assert len(seen) == 121
    old = store.result(items[0][1])
    click(store, old, "unsatisfied", "THIS_REASON_MUST_NOT_BE_SEARCHED")
    filtered = views.list({"feedback": "unsatisfied"})
    assert [e["id"] for e in filtered["events"]] == [items[0][0]]
    assert [e["id"] for e in views.list({"feedback": "rated"})["events"]] == [items[0][0]]
    assert views.list({"q": "任务 000"})["total"] == 1
    assert views.list({"q": "THIS_REASON_MUST_NOT_BE_SEARCHED"})["total"] == 0
    pinned = views.list({"feedback": "unrated", "ids": items[0][0]})
    assert pinned["updates"][0]["feedback"]["state"] == "unsatisfied"
    with service.repository.transaction() as db:
        db.execute("UPDATE events SET created=? WHERE id=?", (time.time() + 5, items[-1][0]))
    assert views.list({"cursor": filtered["cursor"], "feedback": "unsatisfied"})["total"] == 1
    assert not store.result(result["id"])["case_id"]


def test_feedback_cancel_is_visible_and_does_not_cancel_task_or_gold(workspace):
    service, store, result, model = workspace
    views = LearningViews(service)
    original = service.repository.get(result["task_ref"])
    assert views.list({})["events"][0]["feedback"]["state"] == "unrated"
    case = click(store, result)
    item = views.list({})["events"][0]
    assert item["feedback"]["state"] == "satisfied" and item["feedback"]["can_withdraw"]
    assert item["review_summary"]["total"] == 1
    store.withdraw(case["case_id"], {"kind": "learning_gate"}, case["feedback"]["revision"])
    assert views.list({})["events"][0]["feedback"]["state"] == "unrated"
    with pytest.raises(EvaluationError):
        store.projection(case["case_id"])
    assert service.repository.get(result["task_ref"])["status"] == original["status"]
    assert len(model.calls) == 2


def test_retry_never_inherits_previous_feedback_and_cleanup_can_use_saved_snapshot(workspace):
    service, store, result, _ = workspace
    click(store, result)
    views = LearningViews(service)
    identifier = result["task_ref"]
    original = service.repository.get(identifier)
    with service.repository.transaction() as db:
        db.execute("UPDATE events SET payload=NULL,checkpoint='{}' WHERE id=?", (identifier,))
    expired = views.detail(identifier)
    assert expired["input_state"] == "benchmark"
    assert expired["feedback"]["state"] == "satisfied"
    assert "测试知识" in expired["input_preview"]
    with service.repository.transaction() as db:
        db.execute(
            "UPDATE events SET status='queued',payload=?,checkpoint=? WHERE id=?",
            (original["payload"], original["checkpoint"], identifier),
        )
    queued = views.detail(identifier)
    assert queued["current_result_id"] is None
    assert queued["feedback"]["can_rate"] is False
    assert queued["has_previous_feedback"] is True
    service.repository.claim("next-attempt")
    running = views.detail(identifier)
    assert running["current_result_id"] is None
    assert not running["feedback"]["can_rate"]
    with service.repository.transaction() as db:
        db.execute(
            "UPDATE events SET status='completed',payload=NULL,checkpoint='{}' WHERE id=?",
            (identifier,),
        )
    expired = views.detail(identifier)
    assert expired["current_result_id"] is None
    assert not expired["feedback"]["can_rate"]
    assert expired["has_previous_feedback"]


def test_incomplete_and_unavailable_results_do_not_become_unrated_negatives(workspace, monkeypatch):
    service, store, result, _ = workspace
    views = LearningViews(service)
    fresh = store.create_result(LEARNING, task_ref=result["task_ref"], input_data=result["input"])
    with service.repository.transaction() as db:
        db.execute(
            "UPDATE events SET checkpoint=? WHERE id=?",
            (json.dumps({"evaluation_result_id": fresh["id"]}), result["task_ref"]),
        )
    assert views.list({})["events"][0]["triggered"] is None
    assert views.list({"feedback": "unrated"})["total"] == 0
    monkeypatch.setattr(
        views.evaluations, "learning_summaries", lambda _: (_ for _ in ()).throw(OSError())
    )
    item = views.list({})["events"][0]
    assert item["feedback"]["state"] == "unavailable" and not item["feedback"]["can_rate"]


@pytest.mark.parametrize(
    "query",
    [
        {"limit": "0"},
        {"feedback": "maybe"},
        {"status": "fake"},
        {"cursor": "bad"},
        {"q": "x" * 301},
    ],
)
def test_invalid_list_queries_are_rejected(workspace, query):
    with pytest.raises(AgentServiceError):
        LearningViews(workspace[0]).list(query)


def test_new_arrivals_are_counted_without_changing_the_page_boundary(workspace):
    service, store, result, _ = workspace
    views = LearningViews(service)
    before = views.list({})
    event = copy.deepcopy(result["input"]["event"])
    event["event_id"] = "new-arrival"
    event["message"]["id"] = "new-arrival-message"
    service.ingest_event(ConversationEvent.model_validate(event), "test")
    polled = views.list({"cursor": before["cursor"]})
    assert polled["new_count"] == 1
    assert [e["id"] for e in polled["events"]] == [e["id"] for e in before["events"]]
    assert views.list({})["total"] == 2
    assert not store.cases()


def test_http_task_view_is_local_read_only_and_compact(workspace):
    service, store, result, model = workspace
    app = create_app(service.data_root, service.state_root)
    app.state.learning_service = service
    with TestClient(app) as client:
        response = client.get("/api/learning/v1/events")
        assert response.status_code == 200
        item = response.json()["events"][0]
        assert item["current_result_id"] == result["id"]
        assert (
            "environment" not in item["feedback_value"]
            and "input_text" not in item["feedback_value"]
        )
        assert (
            client.get(
                "/api/learning/v1/events", headers={"Origin": "https://evil.test"}
            ).status_code
            == 403
        )
        page = client.get("/learning").text
        assert 'id="inbox-detail"' in page
        assert 'id="inbox-list"' in page
        assert 'id="learning-settings-dialog"' not in page
        assert "/settings?tab=capabilities" in page
        assert "/static/conversation-learning.js" not in page
    assert not store.cases() and len(model.calls) == 2
