from __future__ import annotations

import copy
import io
import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError
from ai_persona.change_sets import ChangeSetRepository
from ai_persona.cli import main
from ai_persona.compiler import PersonaCompiler
from ai_persona.conversation_learning.adapters.codex import capture
from ai_persona.conversation_learning.contracts import (
    CandidateOutput,
    Capabilities,
    ContextSnapshot,
    ConversationEvent,
    LearningSettings,
    SignalOutput,
    SourceConnection,
)
from ai_persona.conversation_learning.pipeline import LearningPipeline
from ai_persona.conversation_learning.repository import LearningRepository
from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.conversation_learning.worker import LearningWorker
from ai_persona.models import Evidence, KnowledgeNode, Preference, Relation
from ai_persona.proposals import ProposalDependencyError, ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


class FakeModel:
    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.signature = "configured-v1"

    def configuration_signature(self, task):
        return self.signature

    def generate(self, task, system, payload, **kwargs):
        self.calls.append((task, system, copy.deepcopy(payload)))
        value = self.outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        if callable(value):
            value = value(payload)
        return {"text": json.dumps(value, ensure_ascii=False), "usage": {"totalTokens": 100}}


@pytest.fixture
def learning(tmp_path, monkeypatch):
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "local"))
    repository = LearningRepository(data)
    repository.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
    repository.save_connection(
        SourceConnection(
            id="test",
            name="Test connector",
            enabled=True,
            allowed_scopes=["project"],
            capabilities=Capabilities(verified_human_origin=True, message_revisions=True),
        )
    )
    return ConversationLearningService(data, state, repository=repository)


def event(identifier="e1", text="帮我生成一份关于测试新知识的 note", **updates):
    value = {
        "schema": "ai-persona.conversation-event/v1",
        "event_id": identifier,
        "source_connection_id": "test",
        "event_type": "message.submitted",
        "conversation_id": "chat",
        "scope_ref": "project",
        "message": {
            "id": identifier,
            "revision": "1",
            "role": "user",
            "origin": "human",
            "content": [{"type": "text", "text": text}],
        },
    }
    value.update(updates)
    return ConversationEvent.model_validate(value)


def signals(kind="note_request", target="knowledge_node", **updates):
    value = {
        "id": "s1",
        "kind": kind,
        "target_type": target,
        "statement": "用户请求整理测试新知识。",
        "topic": "测试新知识",
        "scope": "",
    }
    value.update(updates)
    return {"decision": "observe", "signals": [value]}


def knowledge(title="测试新知识", **updates):
    value = {
        "client_ref": "new",
        "operation": "create",
        "entity_type": "knowledge_node",
        "signal_ids": ["s1"],
        "note": "用户请求生成该主题的 note。",
        "values": {"title": title, "semantic_role": "concept", "summary": "待整理的知识主题。"},
    }
    value.update(updates)
    return value


def process(service, fake, identifier="e1", text="帮我生成一份关于测试新知识的 note"):
    receipt = service.ingest_event(event(identifier, text), "test")
    row = service.repository.claim("test-lease")
    assert row["id"] == receipt["event_id"]
    LearningPipeline(service, fake).process(row["id"], "test-lease")
    return service.get_event_status(row["id"], "test")


def test_note_request_proposal_only_has_note_no_source_or_evidence(learning):
    before = PersonaStore(learning.data_root).load()
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    result = process(learning, fake)
    assert result["outcome"] == "submitted_review"
    proposal = ProposalRepository(learning.data_root).list_pending()[0]
    assert proposal.reason == "用户请求生成该主题的 note。"
    assert proposal.confidence is None
    assert proposal.proposal_context.kind == "conversation"
    assert not proposal.evidence_candidates and not proposal.evidence_refs
    assert proposal.proposal_context.source_id is None
    assert PersonaStore(learning.data_root).load().config.revision == before.config.revision
    manifest = ChangeSetRepository(learning.data_root).get(result["change_set_id"])
    assert manifest.assistant_session_id is None
    assert manifest.producer_ref.kind == "conversation_learning"
    assert manifest.producer_ref.id == result["id"]
    accepted = ProposalService(learning.data_root, learning.state_root).accept(proposal.id)
    assert accepted.record.knowledge_level == accepted.record.interest_level == "unspecified"
    after = PersonaStore(learning.data_root).load()
    assert after.sources == before.sources
    assert len(after.of_type(Evidence)) == len(before.of_type(Evidence))
    assert len(fake.calls) == 2
    assert "evidence" not in fake.calls[1][2]["output_schema"]["$defs"]["Candidate"]["properties"]
    with TestClient(create_app(learning.data_root, learning.state_root)) as client:
        response = client.get("/review/" + proposal.id)
        assert response.status_code == 200
        projected = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review").json()["proposals"][0]
        assert projected["note"] == proposal.reason
        assert projected["source_evidence"] == []
        assert "confidence" not in projected


@pytest.mark.parametrize(
    "instruction",
    [
        "note 中不要有不必要的换行",
        "每个符号在第一次出现的时候要给出定义",
        "图里的元素不要重叠",
    ],
)
def test_one_behavior_requirement_creates_scoped_preference(learning, instruction):
    signal = signals(
        "behavior_requirement", "preference", statement=instruction, topic="", scope="note"
    )
    output = {
        "changes": [
            {
                "client_ref": "ctx",
                "operation": "create",
                "entity_type": "preference_context",
                "signal_ids": ["s1"],
                "note": "为笔记要求建立场景。",
                "values": {
                    "key": "notes.test",
                    "name": "笔记编写",
                    "description": "生成或修改笔记",
                },
            },
            {
                "client_ref": "pref",
                "operation": "create",
                "entity_type": "preference",
                "signal_ids": ["s1"],
                "note": "根据用户的具体修改要求。",
                "values": {
                    "behavior": "required",
                    "instruction": instruction,
                    "scope": "contexts",
                    "context_client_refs": ["ctx"],
                },
            },
        ]
    }
    result = process(learning, FakeModel(signal, output), text=instruction)
    assert len(result["review"]["proposals"]) == 2
    group = ChangeSetRepository(learning.data_root).get(result["change_set_id"])
    review = ProposalService(learning.data_root, learning.state_root)
    for identifier in group.topological_proposal_ids():
        review.accept(identifier)
    preferences = list(PersonaStore(learning.data_root).load().of_type(Preference))
    assert any(p.instruction == instruction and p.scope == "contexts" for p in preferences)


def test_relation_to_existing_knowledge_is_independently_reviewed(learning):
    store = PersonaStore(learning.data_root).load()
    selected = LearningPipeline(learning, FakeModel()).shared_relevant(
        store, SignalOutput.model_validate(signals()).signals
    )
    existing = next(row.record for row in selected if isinstance(row.record, KnowledgeNode))
    relation = {
        "client_ref": "link",
        "operation": "relate",
        "entity_type": "relation",
        "signal_ids": ["s1"],
        "note": "由新增知识与现有知识匹配生成。",
        "values": {"source_ref": "new", "target_id": existing.id, "relation_type": "related_to"},
    }
    result = process(learning, FakeModel(signals(), {"changes": [knowledge(), relation]}))
    links = result["review"]["proposals"]
    new = next(p for p in links if p["entity_type"] == "knowledge_node")
    link = next(p for p in links if p["entity_type"] == "relation")
    review = ProposalService(learning.data_root, learning.state_root)
    with pytest.raises(ProposalDependencyError):
        review.accept(link["proposal_id"])
    review.accept(new["proposal_id"])
    review.accept(link["proposal_id"])
    record = PersonaStore(learning.data_root).load().records[link["candidate_record_id"]].record
    assert isinstance(record, Relation)
    assert not record.evidence_refs and record.statement is None


def test_disabled_out_of_scope_and_principal_are_checked_before_models(learning):
    learning.repository.save_settings(LearningSettings())
    assert learning.ingest_event(event(), "test")["status"] == "ignored_by_policy"
    learning.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
    assert learning.ingest_event(event(scope_ref="other"), "test")["status"] == "ignored_by_policy"
    with pytest.raises(AgentServiceError, match="身份"):
        learning.ingest_event(event(), "other")
    assert learning.repository.recent() == []


def test_idempotency_same_key_conflict_and_message_revision_dedup(learning):
    first = learning.ingest_event(event(), "test")
    assert learning.ingest_event(event(), "test")["status"] == "duplicate"
    another = event().model_copy(update={"event_id": "retry_external_id"})
    assert learning.ingest_event(another, "test")["event_id"] == first["event_id"]
    with pytest.raises(AgentServiceError, match="不同内容"):
        learning.ingest_event(event(text="不同正文"), "test")
    assert learning.ingest_event(event("e2"), "test")["status"] == "accepted"


@pytest.mark.parametrize("trusted", [False, True])
@pytest.mark.parametrize(
    "origin,role",
    [("automation", "user"), ("unknown", "assistant"), ("human", "tool"), ("human", "system")],
)
def test_automatic_and_non_user_messages_do_not_call_model(learning, origin, role, trusted):
    learning.repository.save_connection(
        learning.repository.connection("test").model_copy(update={"trust_user_messages": trusted})
    )
    value = event()
    value.message.origin, value.message.role = origin, role
    result = learning.ingest_event(value, "test")
    assert learning.get_event_status(result["event_id"], "test")["outcome"] == "ignored"
    assert not LearningWorker(learning, FakeModel()).run_once()


def test_unknown_origin_observes_then_requires_explicit_user_confirmation(learning):
    value = event()
    value.message.origin = "unknown"
    result = learning.ingest_event(value, "test")
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    worker = LearningWorker(learning, fake)
    worker.run_once()
    state = learning.get_event_status(result["event_id"], "test")
    assert state["status"] == "waiting_origin"
    assert len(fake.calls) == 1
    with pytest.raises(AgentServiceError):
        learning.retry_job(state["id"], state["version"], "test")
    learning.retry_job(state["id"], state["version"], "test", confirm_human=True)
    worker.run_once()
    assert learning.get_event_status(state["id"], "test")["outcome"] == "submitted_review"
    assert len(fake.calls) == 2  # signal checkpoint was reused
    assert learning.get_event_status(state["id"], "test")["origin_basis"] == "confirmed_human"


@pytest.mark.parametrize("adapter", ["codex", "standard", "future_platform"])
def test_trusted_source_sends_candidates_for_review_without_faking_human_origin(
    learning, tmp_path, adapter
):
    before = PersonaStore(learning.data_root).load().config.revision
    if adapter == "codex":
        connection, raw = codex_scope_fixture(learning, tmp_path, trust_user_messages=True)
        receipt = capture(learning, "codex", raw)
    else:
        connection = SourceConnection(
            id="trusted",
            name="Trusted",
            adapter=adapter,
            enabled=True,
            allowed_scopes=["project"],
            trust_user_messages=True,
        )
        learning.repository.save_connection(connection)
        value = event(source_connection_id=connection.id)
        value.message.origin = "unknown"
        receipt = learning.ingest_event(value, connection.id)
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    LearningWorker(learning, fake).run_once()
    state = learning.get_event_status(receipt["event_id"], connection.id)
    assert state["outcome"] == "submitted_review"
    assert state["origin_basis"] == "trusted_source"
    assert state["human_confirmed"] == 0
    assert state["event"]["message"]["origin"] == "unknown"
    assert not learning.repository.connection(connection.id).capabilities.verified_human_origin
    assert len(fake.calls) == 2
    assert len(ProposalRepository(learning.data_root).list_pending()) == 1
    assert PersonaStore(learning.data_root).load().config.revision == before


def test_trusting_source_resumes_waiting_jobs_and_reuses_signal_checkpoint(learning):
    value = event()
    value.message.origin = "unknown"
    receipt = learning.ingest_event(value, "test")
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    worker = LearningWorker(learning, fake)
    worker.run_once()
    old = learning.repository.get(receipt["event_id"])
    connection = learning.repository.connection("test").model_copy(
        update={"trust_user_messages": True}
    )
    assert learning.repository.save_connection(connection) == 1
    row = learning.repository.get(old["id"])
    assert row["status"] == "queued" and row["human_confirmed"] == 0
    assert row["checkpoint"] == old["checkpoint"]
    assert row["version"] > old["version"]
    assert learning.repository.observations(old["id"])[0]["status"] == "new"
    assert learning.repository.save_connection(connection) == 0
    worker.run_once()
    assert len(fake.calls) == 2
    assert learning.get_event_status(old["id"], "test")["outcome"] == "submitted_review"


def test_enabling_trust_during_wait_transition_does_not_strand_job(learning, monkeypatch):
    value = event()
    value.message.origin = "unknown"
    receipt = learning.ingest_event(value, "test")
    update = learning.repository.fenced_update

    def enable_at_gate(identifier, token, **updates):
        update(identifier, token, **updates)
        checkpoint = json.loads(updates.get("checkpoint", "{}"))
        if "origin_basis" in checkpoint and checkpoint["origin_basis"] is None:
            learning.repository.save_connection(
                learning.repository.connection("test").model_copy(
                    update={"trust_user_messages": True}
                )
            )

    monkeypatch.setattr(learning.repository, "fenced_update", enable_at_gate)
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    worker = LearningWorker(learning, fake)
    worker.run_once()
    assert learning.repository.get(receipt["event_id"])["status"] == "queued"
    worker.run_once()
    assert learning.repository.get(receipt["event_id"])["outcome"] == "submitted_review"
    assert len(fake.calls) == 2


def test_trust_resumes_only_matching_in_scope_live_waiting_tasks(learning):
    connection = learning.repository.connection("test")
    learning.repository.save_connection(connection.model_copy(update={"scope_mode": "all"}))
    learning.repository.save_connection(connection.model_copy(update={"id": "other"}))
    entries = {}
    for name in ("allowed", "outside", "other", "cancelled", "failed", "expired"):
        value = event(
            name,
            source_connection_id="other" if name == "other" else "test",
            scope_ref="outside" if name == "outside" else "project",
        )
        value.message.origin = "unknown"
        entries[name] = learning.ingest_event(value, value.source_connection_id)["event_id"]
        LearningWorker(learning, FakeModel(signals())).run_once()
    row = learning.repository.get(entries["cancelled"])
    learning.cancel(row["id"], row["version"], "test")
    with learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='failed' WHERE id=?", (entries["failed"],))
        db.execute("UPDATE events SET payload=NULL WHERE id=?", (entries["expired"],))
    assert (
        learning.repository.save_connection(
            connection.model_copy(update={"trust_user_messages": True, "enabled": False})
        )
        == 0
    )
    assert (
        learning.repository.save_connection(
            connection.model_copy(update={"trust_user_messages": True})
        )
        == 1
    )
    assert learning.repository.get(entries["allowed"])["status"] == "queued"
    for name in ("outside", "other", "expired"):
        assert learning.repository.get(entries[name])["status"] == "waiting_origin"
    assert learning.repository.get(entries["cancelled"])["status"] == "cancelled"
    assert learning.repository.get(entries["failed"])["status"] == "failed"


@pytest.mark.parametrize("stage", ["queued", "signal", "candidate"])
def test_revoking_trust_prevents_unconfirmed_candidate_submission(learning, stage):
    connection = learning.repository.connection("test").model_copy(
        update={"trust_user_messages": True}
    )
    learning.repository.save_connection(connection)
    value = event()
    value.message.origin = "unknown"
    receipt = learning.ingest_event(value, "test")

    def revoke(_payload=None):
        learning.repository.save_connection(
            connection.model_copy(update={"trust_user_messages": False})
        )
        return {"changes": [knowledge()]} if stage == "candidate" else signals()

    if stage == "queued":
        revoke()
    fake = FakeModel(revoke) if stage == "signal" else FakeModel(signals(), revoke)
    LearningWorker(learning, fake).run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["status"] == ("paused" if stage == "candidate" else "waiting_origin")
    assert row["change_set_id"] is None
    assert not ProposalRepository(learning.data_root).list_pending()
    assert len(fake.calls) == (2 if stage == "candidate" else 1)


def test_trust_does_not_enable_models_or_bypass_budget(learning):
    connection = learning.repository.connection("test").model_copy(
        update={"trust_user_messages": True}
    )
    learning.repository.save_connection(connection)
    value = event()
    value.message.origin = "unknown"
    learning.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=False))
    receipt = learning.ingest_event(value, "test")
    fake = FakeModel(signals())
    worker = LearningWorker(learning, fake)
    assert not worker.run_once() and not fake.calls
    learning.repository.save_settings(
        LearningSettings(enabled=True, allow_model_calls=True, daily_calls=1)
    )
    worker.run_once()
    assert learning.repository.get(receipt["event_id"])["status"] == "paused_budget"
    assert len(fake.calls) == 1
    assert not ProposalRepository(learning.data_root).list_pending()


def test_trust_setting_roundtrip_is_local_configuration_not_event_metadata(learning):
    connection = learning.repository.connection("test")
    old = connection.model_dump(exclude={"trust_user_messages"})
    with learning.repository.transaction() as db:
        db.execute("UPDATE connections SET value=? WHERE id='test'", (json.dumps(old),))
    assert learning.repository.connection("test").trust_user_messages is False
    with pytest.raises(ValueError):
        event(trust_user_messages=True)
    app = create_app(learning.data_root, learning.state_root)
    app.state.learning_service = learning
    settings = learning.repository.settings()
    with TestClient(app) as client:
        assert 'name="trust_user_messages"' in client.get("/settings?tab=sources").text
        for trusted in (True, False):
            value = {**old, "trust_user_messages": trusted}
            assert client.post("/api/learning/v1/connections", json=value).status_code == 403
            response = client.post(
                "/api/learning/v1/connections", json=value, headers={"X-AI-Persona": "1"}
            )
            assert response.status_code == 200
            assert response.json() == {"connection": value, "resumed_events": 0}
            saved = client.get("/api/learning/v1/config").json()
            assert saved["connections"] == [value]
            assert saved["worker"]["running"] is False
    assert learning.repository.settings() == settings


def test_temporary_requirement_is_not_promoted(learning):
    result = process(
        learning,
        FakeModel(
            signals(
                "behavior_requirement",
                "preference",
                temporary=True,
                topic="",
                scope="note",
            )
        ),
    )
    assert result["outcome"] == "ignored"
    assert not ProposalRepository(learning.data_root).list_pending()


def test_model_timeout_resume_and_changed_model_invalidates_checkpoint(learning):
    result = learning.ingest_event(event(), "test")
    fake = FakeModel(
        signals(),
        AgentServiceError("timeout", "timeout", retryable=True),
        signals(),
        {"changes": [knowledge()]},
    )
    worker = LearningWorker(learning, fake)
    worker.run_once()
    row = learning.repository.get(result["event_id"])
    assert row["status"] == "retryable_failed"
    assert json.loads(row["checkpoint"])["signal"]
    fake.signature = "configured-v2"
    learning.retry_job(row["id"], row["version"], "test")
    worker.run_once()
    assert learning.repository.get(row["id"])["outcome"] == "submitted_review"
    assert [c[0] for c in fake.calls].count("conversation_signal") == 2


def test_budget_pause_does_not_become_ignore(learning):
    learning.repository.save_settings(
        LearningSettings(
            enabled=True,
            allow_model_calls=True,
            daily_tokens=1000,
        )
    )
    result = learning.ingest_event(event(), "test")
    fake = FakeModel(signals())
    LearningWorker(learning, fake).run_once()
    row = learning.repository.get(result["event_id"])
    assert row["status"] == "paused_budget" and row["outcome"] is None
    assert not fake.calls


def test_cancel_during_model_call_never_submits(learning):
    result = learning.ingest_event(event(), "test")

    def cancel(_):
        row = learning.repository.get(result["event_id"])
        learning.cancel(row["id"], row["version"], "test")
        return {"changes": [knowledge()]}

    LearningWorker(learning, FakeModel(signals(), cancel)).run_once()
    assert learning.repository.get(result["event_id"])["status"] == "cancelled"
    assert not ProposalRepository(learning.data_root).list_pending()


def test_retraction_invalidates_pending_but_never_rewrites_published(learning):
    result = process(learning, FakeModel(signals(), {"changes": [knowledge()]}))
    proposal = ProposalRepository(learning.data_root).list_pending()[0]
    revised = event(event_type="message.retracted")
    revised.event_id = "retracted"
    revised.message.content = []
    learning.ingest_event(revised, "test")
    assert ProposalRepository(learning.data_root).get(proposal.id).status == "stale"
    assert learning.repository.get(result["id"])["status"] == "cancelled"


def test_expired_lease_is_fenced_and_recoverable(learning):
    result = learning.ingest_event(event(), "test")
    first = learning.repository.claim("first")
    assert first["id"] == result["event_id"]
    assert learning.repository.claim("other") is None
    with learning.repository.transaction() as db:
        db.execute("UPDATE events SET lease_until=0")
    second = learning.repository.claim("second")
    assert second["id"] == first["id"]
    with pytest.raises(AgentServiceError):
        learning.repository.fenced_update(first["id"], "first", status="completed")


def test_cleanup_removes_raw_inputs_even_for_reviewed_proposals(learning):
    result = process(learning, FakeModel(signals(), {"changes": [knowledge()]}))
    with learning.repository.transaction() as db:
        db.execute("UPDATE events SET created=?", (time.time() - 40 * 86400,))
        db.execute("UPDATE observations SET created=?", (time.time() - 40 * 86400,))
    assert learning.cleanup()["expired_events"] == 1
    row = learning.repository.get(result["id"])
    assert row["payload"] is None and row["snapshot"] is None and row["checkpoint"] == "{}"
    assert row["change_set_id"] == result["change_set_id"]
    assert len(ProposalRepository(learning.data_root).list_pending()) == 1


def test_source_snapshot_boundaries_and_secret_filter(learning):
    value = event()
    value.context.boundary = "before"
    snapshot = ContextSnapshot(
        id="ctx", source_connection_id="test", conversation_id="chat", boundary="later"
    )
    with pytest.raises(AgentServiceError, match="边界"):
        learning.ingest_event(value, "test", snapshot)
    assert not learning.repository.recent()
    result = learning.ingest_event(event(text="sk-" + "x" * 35), "test")
    row = learning.repository.get(result["event_id"])
    assert row["payload"] is None and row["outcome"] == "sensitive_content"


def test_codex_and_standard_adapters_share_the_pipeline(learning, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    transcripts = tmp_path / "sessions"
    transcripts.mkdir()
    transcript = transcripts / "chat.jsonl"
    transcript.write_text(json.dumps({"type": "session_meta", "payload": {"id": "chat"}}) + "\n")
    learning.repository.save_connection(
        SourceConnection(
            id="codex",
            name="Codex",
            adapter="codex",
            enabled=True,
            allowed_scopes=["project"],
            adapter_config={
                "project_scopes": {str(project): "project"},
                "transcript_roots": [str(transcripts)],
            },
        )
    )
    raw = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "chat",
        "turn_id": "turn",
        "prompt": "帮我生成一份关于测试新知识的 note",
        "cwd": str(project),
        "transcript_path": str(transcript),
    }
    receipt = capture(learning, "codex", raw)
    assert capture(learning, "codex", raw)["status"] == "duplicate"
    fake = FakeModel(signals(), {"changes": [knowledge()]})
    worker = LearningWorker(learning, fake)
    worker.run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["status"] == "waiting_origin"
    learning.retry_job(row["id"], row["version"], "codex", confirm_human=True)
    worker.run_once()
    assert learning.repository.get(row["id"])["outcome"] == "submitted_review"
    model_input = json.dumps(fake.calls)
    assert "transcript_path" not in model_input and str(tmp_path) not in model_input
    pipeline_source = Path(__file__).parents[1] / "src/ai_persona/conversation_learning/pipeline.py"
    assert "adapters.codex" not in pipeline_source.read_text()


def test_cli_hook_is_silent_and_fail_open(learning, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO("not valid json"))
    assert (
        main(
            [
                "learning",
                "capture",
                "--data",
                str(learning.data_root),
                "--state",
                str(learning.state_root),
                "--connection",
                "missing",
            ]
        )
        == 0
    )
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "not valid json" not in captured.err


def test_learning_ui_local_only_and_settings_do_not_start_models(learning):
    app = create_app(learning.data_root, learning.state_root)
    app.state.learning_service = learning
    with TestClient(app) as client:
        page = client.get("/settings?tab=capabilities")
        assert page.status_code == 200
        assert page.text.count('id="learning-worker-toggle"') == 1
        assert 'id="learning-start"' not in page.text and 'id="learning-stop"' not in page.text
        assert 'id="learning-worker-status"' in page.text
        assert 'id="learning-refresh"' not in page.text
        assert 'learning-cleanup' not in page.text
        assert 'learning-cleanup' not in client.get("/static/conversation-learning.js").text
        assert 'type="module"' in page.text
        module = client.get("/static/learning-worker-control.mjs")
        assert module.status_code == 200 and "javascript" in module.headers["content-type"]
        assert "/settings" in client.get("/").text
        assert client.get("/api/learning/v1/config").json()["worker"]["running"] is False
        value = event().model_dump(mode="json", by_alias=True)
        assert client.post("/api/learning/v1/events", json=value).status_code == 403
        response = client.post("/api/learning/v1/events", json=value, headers={"X-AI-Persona": "1"})
        assert response.status_code == 202
        assert (
            client.post(
                "/api/learning/v1/events",
                json=value,
                headers={"X-AI-Persona": "1", "Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert len(client.get("/api/learning/v1/events").json()["events"]) == 1


def test_candidate_schema_only_requests_short_notes():
    schema = CandidateOutput.model_json_schema()["$defs"]["Candidate"]
    assert "note" in schema["required"]
    assert not {"reason", "confidence", "evidence", "evidence_refs"} & set(schema["properties"])
    assert schema["properties"]["note"]["maxLength"] == 300


def test_learning_uses_real_pi_bridge_with_local_upstream(learning, tmp_path):
    from test_model_bridge import configure, local_upstream, stop

    from ai_persona.model_bridge import ModelClient

    client = ModelClient(tmp_path / "models")
    if not shutil.which("node") or not (client.runtime / "node_modules").exists():
        pytest.skip("Run ai-persona models-install for the Pi integration test")
    with local_upstream() as (url, requests):
        try:
            configure(client, url)
            result = process(learning, client)
            assert result["outcome"] == "submitted_review"
            assert len(requests) == 2
            assert {r["task"] for r in client.request("config")["runs"]} == {
                "conversation_signal",
                "conversation_candidate",
            }
        finally:
            stop(client)


def test_committed_group_recovers_without_contacting_model_service(learning):
    result = process(learning, FakeModel(signals(), {"changes": [knowledge()]}))
    proposal = ProposalRepository(learning.data_root).list_pending()[0]
    ProposalService(learning.data_root, learning.state_root).accept(proposal.id)
    with learning.repository.transaction() as db:
        db.execute(
            "UPDATE events SET status='queued', change_set_id=NULL WHERE id=?", (result["id"],)
        )

    class UnavailableModel:
        def configuration_signature(self, task):
            raise AssertionError("Recovery must not contact the model service")

    LearningWorker(learning, UnavailableModel()).run_once()
    state = learning.repository.get(result["id"])
    assert (
        state["outcome"] == "submitted_review" and state["change_set_id"] == result["change_set_id"]
    )
    assert ProposalRepository(learning.data_root).get(proposal.id).status == "accepted"


def test_settings_changed_during_model_output_prevent_submission(learning):
    receipt = learning.ingest_event(event(), "test")

    def disable_knowledge(_):
        learning.repository.save_settings(
            LearningSettings(
                enabled=True,
                allow_model_calls=True,
                learning_types=["preference"],
            )
        )
        return {"changes": [knowledge()]}

    LearningWorker(learning, FakeModel(signals(), disable_knowledge)).run_once()
    assert learning.repository.get(receipt["event_id"])["status"] == "paused"
    assert not ProposalRepository(learning.data_root).list_pending()


@pytest.mark.parametrize("decision", ["pending", "reject", "accept"])
def test_repeated_preferences_do_not_repeat_review(learning, decision):
    output = {
        "changes": [
            {
                "client_ref": "pref",
                "operation": "create",
                "entity_type": "preference",
                "signal_ids": ["s1"],
                "note": "用户要求清楚定义符号。",
                "values": {"behavior": "required", "instruction": "首次出现时定义符号"},
            }
        ]
    }
    signal = signals("behavior_requirement", "preference", topic="", scope="global")
    process(learning, FakeModel(signal, output))
    proposal = ProposalRepository(learning.data_root).list_pending()[0]
    if decision != "pending":
        review = ProposalService(learning.data_root, learning.state_root)
        getattr(review, decision)(proposal.id)
    result = process(learning, FakeModel(signal, output), identifier="again")
    assert result["outcome"] == "observed" and result["change_set_id"] is None


def test_codex_context_excludes_reasoning_and_rejects_unsafe_paths(tmp_path):
    from ai_persona.conversation_learning.adapters.codex_context import capture_context

    root = tmp_path / "sessions"
    root.mkdir()
    path = root / "chat.jsonl"
    records = [{"type": "session_meta", "payload": {"id": "chat"}}]
    for channel in ("analysis", "final"):
        records.append(
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "channel": channel,
                    "content": [{"type": "output_text", "text": channel + " content"}],
                },
            }
        )
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    snapshot, warning = capture_context(str(path), [str(root)], "test", "chat")
    assert warning is None
    assert [m.text for m in snapshot.messages] == ["final content"]
    assert capture_context(str(path), [str(root)], "test", "other")[1] == "context_session_mismatch"
    alias = root / "link.jsonl"
    alias.symlink_to(path)
    assert capture_context(str(alias), [str(root)], "test", "chat")[1] == "context_path_rejected"
    assert (
        capture_context(str(path), [str(root / "nested")], "test", "chat")[1]
        == "context_path_rejected"
    )


def test_hook_command_imports_checkout_without_inherited_pythonpath(learning, tmp_path):
    import os
    import subprocess

    from ai_persona.conversation_learning.cli import hook_config

    learning.repository.save_connection(SourceConnection(id="codex", name="Codex", adapter="codex"))
    command = hook_config(learning, "codex")["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    result = subprocess.run(
        command,
        shell=True,
        input="{}",
        capture_output=True,
        text=True,
        env=env,
        cwd=tmp_path,
        timeout=5,
    )
    assert result.returncode == 0 and result.stdout == "" and result.stderr == ""


def test_new_platform_id_requires_no_core_schema_changes(learning):
    source = learning.repository.connection("test")
    learning.repository.save_connection(
        source.model_copy(
            update={
                "id": "future",
                "adapter": "future-chat-platform",
                "adapter_config": {"workspace": "opaque"},
            }
        )
    )
    value = event(source_connection_id="future")
    receipt = learning.ingest_event(value, "future")
    LearningWorker(learning, FakeModel(signals(), {"changes": [knowledge()]})).run_once()
    assert learning.repository.get(receipt["event_id"])["outcome"] == "submitted_review"


def test_late_submission_cannot_resurrect_retracted_message(learning):
    retraction = event(event_type="message.retracted")
    retraction.event_id = "retracted-first"
    learning.ingest_event(retraction, "test")
    with pytest.raises(AgentServiceError) as caught:
        learning.ingest_event(event(), "test")
    assert caught.value.code == "stale_event"
    assert not LearningWorker(learning, FakeModel()).run_once()


def test_worker_can_stop_without_signalling_untrusted_pid(learning):
    import threading

    from ai_persona.conversation_learning.worker import stop_worker, worker_status

    learning.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=False))
    worker = LearningWorker(learning, FakeModel())
    thread = threading.Thread(target=worker.serve)
    thread.start()
    try:
        deadline = time.monotonic() + 3
        while not worker_status(learning.repository)["running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        assert stop_worker(learning)["stopping"] is True
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert worker_status(learning.repository)["running"] is False
    finally:
        (learning.repository.directory / "stop.request").touch()
        thread.join(timeout=3)


def codex_scope_fixture(learning, tmp_path, *, scope_mode="restricted", **updates):
    project = tmp_path / "allowed project"
    project.mkdir(exist_ok=True)
    connection = SourceConnection(
        id="codex",
        name="Codex scope test",
        adapter="codex",
        enabled=True,
        scope_mode=scope_mode,
        allowed_scopes=["allowed-project"],
        adapter_config={"project_scopes": {str(project): "allowed-project"}},
    ).model_copy(update=updates)
    learning.repository.save_connection(connection)
    raw = {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "chat",
        "turn_id": "turn",
        "prompt": "讲解一个测试知识点",
        "cwd": str(project),
        "transcript_path": None,
    }
    return connection, raw


def test_codex_global_scope_accepts_unlisted_projects_and_sessions(learning, tmp_path):
    connection, raw = codex_scope_fixture(
        learning,
        tmp_path,
        scope_mode="all",
        allowed_conversations=["previously-limited-chat"],
    )
    for index, directory in enumerate(
        ["allowed project", "another project", "worktrees/new", "projectless"]
    ):
        receipt = capture(
            learning,
            "codex",
            {
                **raw,
                "session_id": f"chat-{index}",
                "cwd": str(tmp_path / directory),
            },
        )
        assert receipt["status"] == "accepted"
        row = learning.repository.get(receipt["event_id"])
        saved = ConversationEvent.model_validate_json(row["payload"])
        assert saved.message.origin == "unknown"
        assert saved.scope_ref and str(tmp_path) not in row["payload"]
        assert row["snapshot"] is None
    assert (
        learning.repository.connection("codex") == connection
    )  # Filters were retained, not erased.


def test_codex_global_scope_does_not_require_project_configuration(learning, tmp_path):
    _, raw = codex_scope_fixture(
        learning, tmp_path, scope_mode="all", allowed_scopes=[], adapter_config={}
    )
    assert capture(learning, "codex", raw)["status"] == "accepted"


def test_codex_scope_defaults_do_not_expand_legacy_connections(learning, tmp_path):
    connection, raw = codex_scope_fixture(learning, tmp_path, allow_all_conversations=True)
    old_config = connection.model_dump(exclude={"scope_mode"})
    with learning.repository.transaction() as db:
        db.execute("UPDATE connections SET value=? WHERE id='codex'", (json.dumps(old_config),))
    assert learning.repository.connection("codex").scope_mode == "restricted"
    assert (
        capture(learning, "codex", {**raw, "cwd": str(tmp_path / "outside")})["status"]
        == "ignored_by_policy"
    )
    assert (
        capture(learning, "codex", {**raw, "cwd": raw["cwd"] + "/subproject"})["status"]
        == "accepted"
    )
    learning.repository.save_connection(
        connection.model_copy(update={"allowed_conversations": ["different-chat"]})
    )
    assert capture(learning, "codex", raw)["reason"] == "conversation_not_allowed"


@pytest.mark.parametrize("disable", ["source", "settings"])
def test_global_scope_never_overrides_collection_disable(learning, tmp_path, disable):
    connection, raw = codex_scope_fixture(learning, tmp_path, scope_mode="all")
    if disable == "source":
        learning.repository.save_connection(connection.model_copy(update={"enabled": False}))
    else:
        learning.repository.save_settings(LearningSettings())
    assert capture(learning, "codex", raw)["status"] == "ignored_by_policy"
    assert learning.repository.recent() == []


def test_global_scope_does_not_widen_transcript_read_permissions(learning, tmp_path, monkeypatch):
    from ai_persona.conversation_learning.adapters import codex_context

    _, raw = codex_scope_fixture(
        learning,
        tmp_path,
        scope_mode="all",
        adapter_config={
            "transcript_roots": [str(tmp_path / "permitted-sessions")],
        },
        allowed_scopes=[],
    )

    def never_open(*args):
        raise AssertionError("An unapproved transcript must not be opened")

    monkeypatch.setattr(codex_context.os, "open", never_open)
    receipt = capture(
        learning, "codex", {**raw, "transcript_path": str(tmp_path / "private.jsonl")}
    )
    assert receipt["status"] == "accepted"
    assert learning.repository.get(receipt["event_id"])["snapshot"] is None
    assert "context_path_rejected" in {
        d["code"] for d in learning.repository.health()["diagnostics"]
    }


def test_global_scope_can_be_narrowed_before_queued_models_run(learning, tmp_path):
    connection, raw = codex_scope_fixture(learning, tmp_path, scope_mode="all")
    receipt = capture(learning, "codex", {**raw, "cwd": str(tmp_path / "outside")})
    learning.repository.save_connection(connection.model_copy(update={"scope_mode": "restricted"}))
    fake = FakeModel()
    LearningWorker(learning, fake).run_once()
    assert not fake.calls
    assert learning.repository.get(receipt["event_id"])["status"] == "paused"
    assert (
        capture(learning, "codex", {**raw, "cwd": str(tmp_path / "outside")})["status"]
        == "ignored_by_policy"
    )
    assert capture(learning, "codex", raw)["status"] == "accepted"


def test_global_scope_model_disable_and_human_confirmation_are_unchanged(learning, tmp_path):
    _, raw = codex_scope_fixture(learning, tmp_path, scope_mode="all")
    learning.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=False))
    receipt = capture(learning, "codex", raw)
    fake = FakeModel(signals())
    worker = LearningWorker(learning, fake)
    assert worker.run_once() is False and not fake.calls
    learning.repository.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
    worker.run_once()
    assert learning.repository.get(receipt["event_id"])["status"] == "waiting_origin"
    assert len(fake.calls) == 1


@pytest.mark.parametrize("stage", ["signal", "candidate"])
def test_global_scope_narrowed_during_model_discards_late_output(learning, stage):
    connection = learning.repository.connection("test").model_copy(update={"scope_mode": "all"})
    learning.repository.save_connection(connection)
    receipt = learning.ingest_event(event(scope_ref="outside"), "test")

    def narrow_during_model(_payload):
        learning.repository.save_connection(
            connection.model_copy(update={"scope_mode": "restricted"})
        )
        return signals() if stage == "signal" else {"changes": [knowledge()]}

    fake = (
        FakeModel(narrow_during_model)
        if stage == "signal"
        else FakeModel(signals(), narrow_during_model)
    )
    LearningWorker(learning, fake).run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["status"] == "paused" and row["change_set_id"] is None
    assert not ProposalRepository(learning.data_root).list_pending()
    assert len(fake.calls) == (1 if stage == "signal" else 2)


def test_global_scope_settings_round_trip_without_mutating_other_settings(learning, tmp_path):
    connection, _ = codex_scope_fixture(learning, tmp_path, allowed_conversations=["chat"])
    app = create_app(learning.data_root, learning.state_root)
    app.state.learning_service = learning
    original_settings = learning.repository.settings()
    with TestClient(app) as client:
        page = client.get("/settings?tab=sources").text
        assert 'name="scope_mode"' in page and '<option value="all">' in page
        for mode in ("all", "restricted"):
            value = {**connection.model_dump(), "scope_mode": mode}
            result = client.post(
                "/api/learning/v1/connections", json=value, headers={"X-AI-Persona": "1"}
            )
            assert result.status_code == 200
            assert result.json()["connection"] == value
            state = client.get("/api/learning/v1/config").json()
            assert next(c for c in state["connections"] if c["id"] == "codex") == value
            assert state["worker"]["running"] is False
        value["scope_mode"] = "invalid-mode"
        assert (
            client.post(
                "/api/learning/v1/connections", json=value, headers={"X-AI-Persona": "1"}
            ).status_code
            == 400
        )
    assert learning.repository.settings() == original_settings


def test_global_scope_is_platform_independent_and_still_requires_principal(learning):
    connection = learning.repository.connection("test").model_copy(update={"scope_mode": "all"})
    learning.repository.save_connection(connection)
    value = event(scope_ref="unlisted-scope", conversation_id="unlisted-chat")
    with pytest.raises(AgentServiceError):
        learning.ingest_event(value, "other-connection")
    assert learning.ingest_event(value, "test")["status"] == "accepted"


def test_global_scope_change_does_not_change_installed_hook_command(learning, tmp_path):
    from ai_persona.conversation_learning.cli import hook_config

    connection, _ = codex_scope_fixture(learning, tmp_path)
    previous = hook_config(learning, "codex")
    learning.repository.save_connection(connection.model_copy(update={"scope_mode": "all"}))
    assert hook_config(learning, "codex") == previous


def test_candidate_stage_uses_shared_tool_loop_and_backend_versions(learning, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    service = ProposalService(learning.data_root, learning.state_root)
    existing = service.create_record("preference", {"instruction":"数学解释先定义符号。",
                                        "scope":"global", "behavior":"preferred"})
    service.accept(existing.id)
    fake = FakeModel(
        signals("behavior_requirement", "preference", statement="解释时增加符号单位。", topic="数学符号"),
        {"calls":[{"name":"search_preferences", "arguments":{"query":"数学符号"}}]},
        {"calls":[{"name":"get_preference_records", "arguments":{"record_ids":[existing.target_id]}}]},
        {"changes":[{"client_ref":"rule", "operation":"update", "entity_type":"preference",
                     "target_id":existing.target_id, "values":{"instruction":"先定义符号，并注明单位。"},
                     "signal_ids":["s1"], "note":"用户明确补充单位要求。"}]},
    )
    result = process(learning, fake, text="以后解释数学时，先定义符号，并注明单位。")
    assert result["outcome"] == "submitted_review"
    assert len(fake.calls) == 4
    assert "search_preferences" in json.dumps(fake.calls[-1][2]["tool_results"])
    pending = ProposalRepository(learning.data_root).get(result["review"]["proposals"][0]["proposal_id"])
    assert pending.target_id == existing.target_id
    assert pending.base_revision == 1
    assert not pending.evidence_candidates and pending.confidence is None
