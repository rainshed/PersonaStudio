from __future__ import annotations

import shutil
import tarfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace
from test_extraction import FixtureBackend, add

from ai_persona.agent import AgentServiceError
from ai_persona.compiler import PersonaCompiler
from ai_persona.content_reset import ContentReset
from ai_persona.extraction.service import ExtractionService
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.reset_storage import ContentTransaction, content_access, recover, reset_operation
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state


def extracted(workspace, accept=False):
    data, state = workspace
    service = ExtractionService(data, state, FixtureBackend())
    task = add(service)
    service.run(task["id"], service.start(task["id"], task["revision"]))
    task = service.repository.get(task["id"])
    assert task["status"] == "review", task["error"]
    if accept:
        for p in sorted(
            task["submissions"][0]["proposals"], key=lambda p: p["entity_type"] == "relation"
        ):
            ProposalService(data, state).accept(p["proposal_id"])
    return service, task


def test_clear_pending_batch_preserves_inputs_and_can_rerun(workspace):
    service, task = extracted(workspace)
    reset = ContentReset(*workspace)
    before = set(service.store().records)
    plan = reset.plan(task["id"])
    assert plan["proposal_count"] == 3
    assert plan["counts"] == {}
    reset.apply(token=plan["token"], task_id=task["id"])
    new = service.view(task["id"])
    assert new["members"] and new["status"] == "draft" and new["submissions"] == []
    assert new["graph"]["nodes"] == []
    assert set(service.store().records) == before
    assert ProposalRepository(workspace[0]).list_pending() == []
    run = service.start(task["id"], new["revision"])
    service.run(task["id"], run)
    again = service.view(task["id"])
    assert again["status"] == "review", again["error"]
    assert len(again["submissions"]) == 1
    assert again["submissions"][0]["change_set_id"] != task["submissions"][0]["change_set_id"]


def test_clear_accepted_batch_and_preserve_unrelated(workspace):
    before = set(PersonaStore(workspace[0]).load().records)
    service, task = extracted(workspace, accept=True)
    reset = ContentReset(*workspace)
    plan = reset.plan(task["id"])
    assert plan["counts"]["knowledge_node"] == 1
    assert plan["counts"]["material"] == 1
    assert plan["counts"]["relation"] == 1
    assert not plan["protected"]
    reset.apply(token=plan["token"], task_id=task["id"])
    assert set(service.store().records) == before
    assert service.view(task["id"])["members"]


def test_batch_preserves_later_edited_record(workspace):
    service, task = extracted(workspace, accept=True)
    store = service.store()
    loaded = next(
        v for v in store.records.values() if getattr(v.record, "title", "") == "Spectral clustering"
    )
    loaded.path.write_text(
        loaded.path.read_text().replace("Spectral clustering", "Spectral clustering (edited)")
    )
    PersonaCompiler(*workspace).build()
    reset = ContentReset(*workspace)
    plan = reset.plan(task["id"])
    assert loaded.record.id in {p["id"] for p in plan["protected"]}
    reset.apply(token=plan["token"], task_id=task["id"])
    assert service.store().records[loaded.record.id].record.title.endswith("(edited)")


def test_full_reset_keeps_settings_and_backups_optional(workspace):
    service, task = extracted(workspace)
    reset = ContentReset(*workspace)
    service.repository.save_policy({"output_language": "en", "max_nodes": 33})
    marker = workspace[1] / "model-config.json"
    marker.write_text('{"keep":true}')
    config = service.store().config
    result = reset.apply(token=reset.plan()["token"], backup=True)
    store = service.store()
    assert not store.records and not store.sources
    assert store.config.persona_id == config.persona_id
    assert store.config.revision == config.revision + 1
    assert marker.read_text() == '{"keep":true}'
    assert service.repository.policy().max_nodes == 33
    assert service.repository.list() == []
    assert ProposalRepository(workspace[0]).list_pending() == []
    with tarfile.open(result["backup"]) as archive:
        assert "manifest.json" in archive.getnames()
    from ai_persona.backup import restore_workspace

    restored = workspace[0].parent / "restored"
    restore_workspace(Path(result["backup"]), restored)
    restored_store = PersonaStore(restored / "persona-data").load()
    assert restored_store.records and restored_store.sources
    assert restored_store.config.revision == config.revision
    # A new extraction remains fully functional after initialization.
    fresh = add(service)
    service.run(fresh["id"], service.start(fresh["id"], fresh["revision"]))
    assert service.view(fresh["id"])["status"] == "review"


def test_stale_preview_and_failure_rollback(workspace, monkeypatch):
    reset = ContentReset(*workspace)
    plan = reset.plan()
    reset.tasks.create()
    with pytest.raises(AgentServiceError, match="变化"):
        reset.apply(token=plan["token"])
    before = (workspace[0] / "config/persona.toml").read_bytes()
    records = set(PersonaStore(workspace[0]).load().records)
    plan = reset.plan()

    def fail(*args):
        raise RuntimeError("simulated build failure")

    monkeypatch.setattr(PersonaCompiler, "build", fail)
    with pytest.raises(RuntimeError, match="simulated"):
        reset.apply(token=plan["token"])
    assert set(PersonaStore(workspace[0]).load().records) == records
    assert (workspace[0] / "config/persona.toml").read_bytes() == before
    assert len(reset.tasks.list()) == 1
    assert not (workspace[1] / "content-reset.active").exists()


def test_recovery_and_reset_gate(workspace):
    data, state = workspace
    p = data / "config/persona.toml"
    before = p.read_bytes()
    tx = ContentTransaction(state)
    tx.capture(p)
    p.write_text("interrupted")
    recover(state)
    assert p.read_bytes() == before
    with reset_operation(state):
        from ai_persona.reset_storage import OWNER

        token = OWNER.set(False)
        try:
            with pytest.raises(AgentServiceError, match="清理"):
                with content_access(state):
                    pass
        finally:
            OWNER.reset(token)
    with content_access(state):
        pass


def test_http_requires_confirmation_and_reports_preview(workspace):
    app = create_app(*workspace)
    with TestClient(app) as client:
        before = set(PersonaStore(workspace[0]).load().records)
        preview = client.get("/api/content-reset/preview").json()
        assert preview["counts"]
        headers = {"X-AI-Persona": "1"}
        response = client.post(
            "/api/content-reset", json={"token": preview["token"]}, headers=headers
        )
        assert response.status_code == 400
        assert set(PersonaStore(workspace[0]).load().records) == before
        assert (
            client.post(
                "/api/content-reset", json={"token": preview["token"], "confirm": "clear-content"}
            ).status_code
            == 403
        )
        response = client.post(
            "/api/content-reset",
            json={"token": preview["token"], "confirm": "clear-content"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        assert client.get("/").status_code == 200
        assert not PersonaStore(workspace[0]).load().records


@pytest.mark.parametrize("accept_relation", [False, True])
def test_batch_preserves_shared_records(workspace, accept_relation):
    service, task = extracted(workspace, accept=True)
    shared = next(
        v.record.id
        for v in service.store().records.values()
        if getattr(v.record, "title", "") == "Spectral clustering"
    )
    reviews = ProposalService(*workspace)
    proposal = reviews.create_relation(
        source_id=shared,
        target_id="kn_demo_mps",
        relation_type="related_to",
        reason="User connects this to other knowledge.",
    )
    if accept_relation:
        reviews.accept(proposal.id)
    reset = ContentReset(*workspace)
    plan = reset.plan(task["id"])
    assert shared in {p["id"] for p in plan["protected"]}
    reset.apply(token=plan["token"], task_id=task["id"])
    assert shared in service.store().records
    assert ProposalRepository(workspace[0]).get(proposal.id)
    if accept_relation:
        assert proposal.target_id in service.store().records


def test_reset_blocks_old_learning_events_and_old_context(workspace):
    import json

    from test_conversation_learning import event

    from ai_persona.conversation_learning.contracts import (
        Capabilities,
        ContextSnapshot,
        LearningSettings,
        SourceConnection,
    )
    from ai_persona.conversation_learning.service import ConversationLearningService

    reset = ContentReset(*workspace)
    repo = reset.learning
    repo.save_settings(LearningSettings(enabled=True))
    repo.save_connection(
        SourceConnection(
            id="test",
            name="Test",
            enabled=True,
            allowed_scopes=["project"],
            capabilities=Capabilities(verified_human_origin=True),
        )
    )
    learning = ConversationLearningService(*workspace, repository=repo)
    old = event("old")
    assert learning.ingest_event(old, "test")["status"] == "accepted"
    reset.apply(token=reset.plan()["token"])
    assert repo.settings().enabled
    assert learning.ingest_event(old, "test")["reason"] == "content_reset"
    new = event("new", context={"boundary": "now"})
    snapshot = ContextSnapshot(
        id="ctx",
        source_connection_id="test",
        conversation_id="chat",
        boundary="now",
        messages=[old.message, new.message],
    )
    accepted = learning.ingest_event(new, "test", snapshot)
    assert accepted["status"] == "accepted"
    with repo.connect() as db:
        stored = db.execute(
            "SELECT snapshot FROM events WHERE id=?", (accepted["event_id"],)
        ).fetchone()[0]
    assert [m["id"] for m in json.loads(stored)["messages"]] == ["new"]
    # Retain new assistant context after a post-reset user message.
    next_event = event("next", context={"boundary": "later"})
    assistant = new.message.model_copy(update={"id": "answer", "role": "assistant"})
    later = ContextSnapshot(
        id="later",
        source_connection_id="test",
        conversation_id="chat",
        boundary="later",
        messages=[old.message, new.message, assistant, next_event.message],
    )
    accepted = learning.ingest_event(next_event, "test", later)
    with repo.connect() as db:
        saved = json.loads(
            db.execute(
                "SELECT snapshot FROM events WHERE id=?", (accepted["event_id"],)
            ).fetchone()[0]
        )
    assert [m["id"] for m in saved["messages"]] == ["new", "answer", "next"]


def test_running_extraction_is_cancelled_before_reset(workspace):
    app = create_app(*workspace)
    service = app.state.extraction_service
    task = add(service)
    service.start(task["id"], task["revision"])
    cancelled = []
    service.backend = type(
        "Backend", (), {"cancel": lambda _, task_id: cancelled.append(task_id)}
    )()
    manager = app.state.content_reset
    manager.apply(token=manager.plan()["token"])
    assert cancelled == [task["id"]]
    assert service.repository.list() == []
