from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient
from test_change_set_review import submit_dependent_change_set
from test_evaluations import CANDIDATE, SIGNAL, click, make_learning
from test_evaluations import work as work

from ai_persona.change_sets import ChangeSetLink, ChangeSetRepository
from ai_persona.conversation_learning.review import LearningReview
from ai_persona.evaluations.business import sync_review_gold
from ai_persona.material_analysis import field_contracts
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.review import review_field_schema, review_projection
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def inline(work):
    candidate = copy.deepcopy(CANDIDATE)
    candidate["changes"][0]["values"].update(aliases=["alias one", "alias two"], scope_note="只保留这个范围", body="## 我的笔记\n\n不要丢失。", tags=["tag_domain_quantum"])
    # Use an existing domain tag rather than relying on a fixture's spelling.
    store = PersonaStore(work[0]).load()
    tag = next(r.id for loaded in store.records.values() if (r := loaded.record).entity_type == "tag" and r.namespace == "domain")
    candidate["changes"][0]["values"]["tags"] = [tag]
    service, evaluations, result, model = make_learning(work, [SIGNAL, candidate])
    app = create_app(*work)
    app.state.learning_service = service
    return service, evaluations, result, model, TestClient(app)


def path(result, proposal_id=None):
    base = f'/api/learning/v1/events/{result["task_ref"]}/review'
    return base if proposal_id is None else f'{base}/{proposal_id}'


def post(client, result, item, updates=None, action="accept", **extra):
    return client.post(path(result, item["id"]), json={"action": action, "revision": item["revision"], "updates": updates or {}, **extra}, headers={"X-AI-Persona": "1"})


def test_schema_display_edit_and_saved_fields_preserve_partial_updates(inline):
    service, evaluations, result, model, client = inline
    response = client.get(path(result))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    item = response.json()["proposals"][0]
    fields = {f["name"]: f for f in item["fields"]}
    assert set(fields) == set(item["values"])
    assert fields["evidence_refs"]["readonly"]
    assert fields["knowledge_level"]["user_only"] and not fields["knowledge_level"]["readonly"]
    ai_fields = field_contracts(False, True)["knowledge_node"]["properties"]
    assert set(ai_fields) <= set(fields)
    before = item["values"]
    response = post(client, result, item, {"title": "人工确认的知识", "knowledge_level": "familiar"})
    assert response.status_code == 200, response.text
    saved = response.json()["proposals"][0]
    assert saved["status"] == "edited_and_accepted"
    assert saved["values"] == {**before, "title": "人工确认的知识", "knowledge_level": "familiar"}
    assert saved["values"] == {k: saved["saved"].get(k) for k in fields}
    assert saved["original_patch"]["title"] == "测试知识"
    assert saved["review_patch"] == {"title": "人工确认的知识", "knowledge_level": "familiar"}
    assert evaluations.cases() == []
    assert len(model.calls) == 2
    assert client.get(f'/api/inbox/v1/items/proposal:{item["id"]}/review').json()["proposals"][0]["title"] == "人工确认的知识"
    assert client.get(f'/api/learning/v1/events/{result["task_ref"]}').json()["review_summary"]["statuses"] == {"edited_and_accepted": 1}
    assert post(client, result, item, {"title": "重复保存"}).status_code == 409
    assert post(client, result, item, action="reject").status_code == 409


@pytest.mark.parametrize("updates,field", [({"title": ""}, "title"), ({"knowledge_level": "expert"}, "knowledge_level"), ({"evidence_refs": ["ev_made_up"]}, "evidence_refs"), ({"id": "kn_wrong"}, "id"), ({"body": None}, "body")])
def test_invalid_values_report_field_and_do_not_publish(inline, updates, field):
    service, _, result, _, client = inline
    item = client.get(path(result)).json()["proposals"][0]
    response = post(client, result, item, updates)
    assert response.status_code == 422, response.text
    assert field in response.json()["error"]["fields"]
    assert ProposalRepository(service.data_root).get(item["id"]).status == "pending_review"
    assert item["target_id"] not in PersonaStore(service.data_root).load().records


def test_existing_review_updates_inline_view_and_only_explicit_feedback_creates_gold(inline):
    service, evaluations, result, _, client = inline
    item = client.get(path(result)).json()["proposals"][0]
    case = click(evaluations, result)
    response = client.post(f'/review/{item["id"]}/edit-and-accept', data={"proposal_revision": item["revision"], "summary": "经过人工编辑的摘要"}, follow_redirects=False)
    assert response.status_code == 303
    updated = client.get(path(result)).json()["proposals"][0]
    assert updated["values"]["summary"] == "经过人工编辑的摘要"
    sync_review_gold(evaluations)
    gold = evaluations.case(case["case_id"])
    assert gold["content_gold"] and gold["trigger_labels"][0]["expected_trigger"]
    evaluations.withdraw(case["case_id"], {"kind": "learning_gate"}, gold["feedback"]["revision"])
    assert client.get(path(result)).json()["proposals"][0]["status"] == "edited_and_accepted"
    assert item["target_id"] in PersonaStore(service.data_root).load().records


def test_dependencies_rejection_and_transport_guards(inline):
    service, evaluations, result, _, client = inline
    submitted = submit_dependent_change_set(service.data_root, service.state_root)
    with service.repository.transaction() as db:
        db.execute("UPDATE events SET change_set_id=? WHERE id=?", (submitted.change_set_id, result["task_ref"]))
    root, dependent, independent = client.get(path(result)).json()["proposals"]
    assert dependent["dependencies"][0]["id"] == root["id"]
    assert post(client, result, dependent).status_code == 422
    assert post(client, result, root, action="reject").status_code == 200
    values = client.get(path(result)).json()["proposals"]
    assert [v["status"] for v in values] == ["rejected", "rejected", "pending_review"]
    assert not evaluations.cases()
    assert client.post(path(result, independent["id"]), json={}).status_code == 403
    assert client.post(path(result, independent["id"]), json={}, headers={"X-AI-Persona": "1", "Origin": "https://elsewhere.invalid"}).status_code == 403
    old = next(p for p in ProposalRepository(service.data_root).list_pending() if p.id != independent["id"])
    assert post(client, result, {"id": old.id, "revision": old.proposal_revision}).status_code == 422


def test_preference_context_and_relation_use_persisted_contract(inline):
    service, _, result, _, client = inline
    publisher = ProposalService(service.data_root, service.state_root)
    context = publisher.create_record("preference_context", {"name": "新场景", "key": "new.scene", "activation": {"intents": ["解释"], "artifact_types": [], "excludes": []}})
    publisher.accept(context.id)
    preference = publisher.create_record("preference", {"instruction": "每个符号首次出现时给出定义", "scope": "contexts", "context_refs": [context.target_id], "behavior": "required"}, body="只需简短备注")
    repo = ChangeSetRepository(service.data_root)
    manifest = LearningReview(service).manifest(result["task_ref"])
    # Include this test proposal in the same task's review group.
    manifest.proposal_links.append(ChangeSetLink(proposal_id=preference.id, candidate_record_id=preference.target_id, operation="create", entity_type="preference"))
    repo.save(manifest)
    item = next(i for i in client.get(path(result)).json()["proposals"] if i["id"] == preference.id)
    invalid = post(client, result, item, {"scope": "global"})
    assert invalid.status_code == 422 and "context_refs" in invalid.json()["error"]["fields"]
    valid = post(client, result, item, {"scope": "global", "context_refs": []})
    assert valid.status_code == 200, valid.text
    persisted = next(i for i in valid.json()["proposals"] if i["id"] == preference.id)
    assert persisted["saved"]["body"] == "只需简短备注"
    schema = review_field_schema(context, PersonaStore(service.data_root).load())
    assert {"key", "activation", "body"} <= {f["name"] for f in schema}


def test_relation_identity_edit_normalizes_and_matches_review_audit(work):
    submitted = submit_dependent_change_set(*work)
    publisher = ProposalService(*work)
    proposal = publisher.repository.get(submitted.proposals[-1].proposal_id)
    original = {p.field: p.after for p in proposal.patch}
    publisher.accept(proposal.id, review_updates={"source_id": original["target_id"], "target_id": original["source_id"], "body": "关系备注"}, expected_proposal_revision=proposal.proposal_revision)
    projection = review_projection(publisher.repository.get(proposal.id), PersonaStore(work[0]).load())
    assert projection["saved"]["source_id"] < projection["saved"]["target_id"]
    assert projection["values"]["body"] == "关系备注"
    assert {**original, **projection["review_patch"]}["source_id"] == projection["saved"]["source_id"]
