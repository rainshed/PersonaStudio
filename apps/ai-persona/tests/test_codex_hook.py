from __future__ import annotations

import fcntl
import json
import subprocess
import time

import pytest
from fastapi.testclient import TestClient
from test_learning_input import wrapped
from test_model_bridge import configure, local_upstream, stop
from test_preference_application import work as work

from ai_persona import codex_hook, codex_input
from ai_persona.conversation_learning.adapters.codex import capture
from ai_persona.conversation_learning.cli import hook_config as learning_config
from ai_persona.conversation_learning.contracts import (
    ContextSnapshot,
    ConversationEvent,
    LearningSettings,
)
from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.model_bridge import ModelClient
from ai_persona.preference_application.cli import hook_config as preference_config
from ai_persona.preference_application.repository import ApplicationSettings
from ai_persona.web import create_app


def enable(work, *, learning=True, application=True):
    service = work[0]
    service.connections.save_settings(LearningSettings(enabled=learning))
    source = service.connections.connection("test_codex").model_copy(update={"enabled": learning})
    service.connections.save_connection(source)
    service.repository.save_settings(ApplicationSettings(enabled=application,
                                                         connection_ids=[source.id]))
    return ConversationLearningService(service.data_root, service.state_root,
                                       repository=service.connections)


def transcript(work, tmp_path):
    service, payload, *_ = work
    payload["prompt"] = wrapped("帮我画图并整理笔记")
    source = service.connections.connection("test_codex")
    source.adapter_config["transcript_roots"] = [str(tmp_path)]
    service.connections.save_connection(source)
    path = tmp_path / "session.jsonl"
    entries = [{"type": "session_meta", "payload": {"id": payload["session_id"]}}]
    for role, text in [("user", wrapped("我在分析实验数据。")), ("assistant", "可以先比较趋势。"),
                       ("user", payload["prompt"])]:
        entries.append({"type": "response_item", "payload": {"type": "message", "role": role,
                        "content": [{"type": "input_text", "text": text}]}})
    path.write_text("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
    payload["transcript_path"] = str(path)
    return path


def synchronous_preferences(work, monkeypatch):
    service = work[0]
    monkeypatch.setattr("ai_persona.preference_application.service.ApplicationService",
                        lambda *args, **kwargs: service)

    def run(service, connection_id, payload, *, captured=None):
        row, created = service.begin(connection_id, payload, captured=captured)
        if row and created:
            service.process(row["id"])
            output = service.output(row["id"])
            if output:
                print(json.dumps(output))

    monkeypatch.setattr("ai_persona.preference_application.cli.run_hook", run)


def process(work):
    service, payload, *_ = work
    codex_hook.process_input(service.data_root, service.state_root, service.connections,
                             "test_codex", payload)


@pytest.mark.parametrize("learning,application", [(True, True), (True, False), (False, True), (False, False)])
def test_one_capture_with_independent_feature_switches(work, monkeypatch, tmp_path, capsys,
                                                      learning, application):
    learning_service = enable(work, learning=learning, application=application)
    transcript(work, tmp_path)
    reads = []
    original = codex_input.capture_context

    def read(*args):
        reads.append(args)
        return original(*args)

    monkeypatch.setattr(codex_input, "capture_context", read)
    monkeypatch.setattr(codex_hook, "dispatch_learning", lambda d, s, r, c:
                        (capture(learning_service, c.connection_id, c.payload, captured=c), None)[1])
    synchronous_preferences(work, monkeypatch)
    process(work)
    assert len(reads) == int(learning or application)
    service = work[0]
    events = service.connections.recent()
    rows, _ = service.repository.recent()
    assert len(events) == int(learning) and len(rows) == int(application)
    assert bool(capsys.readouterr().out) == application
    if learning and application:
        event = ConversationEvent.model_validate_json(events[0]["payload"])
        snapshot = ContextSnapshot.model_validate_json(events[0]["snapshot"])
        assert event.message.text == work[1]["prompt"]
        assert event.message.learning_text == rows[0]["request"]["user_prompt"]
        assert snapshot.boundary == rows[0]["request"]["context_boundary"]
        assert [{"role": m.role, "content": m.learning_text} for m in snapshot.messages] == rows[0]["request"]["recent_messages"]
        assert len(snapshot.messages) == 2


def test_learning_redelivery_freezes_first_snapshot_and_new_turn_is_distinct(work, tmp_path):
    learning = enable(work)
    path = transcript(work, tmp_path)
    captured = codex_input.capture_input(work[0].connections.connection("test_codex"), work[1])
    first = capture(learning, "test_codex", work[1], captured=captured)
    original = learning.repository.get(first["event_id"])["snapshot"]
    with path.open("a") as stream:
        stream.write(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "assistant",
                            "content": [{"type": "output_text", "text": "后续回答"}]}}) + "\n")
    again = capture(learning, "test_codex", work[1])
    assert again["status"] == "duplicate" and again["event_id"] == first["event_id"]
    assert learning.repository.get(first["event_id"])["snapshot"] == original
    assert len(captured.snapshot.messages) == 2
    next_event = capture(learning, "test_codex", {**work[1], "turn_id": "turn_2"})
    assert next_event["event_id"] != first["event_id"]


def test_scope_rejected_before_background_is_read(work, monkeypatch):
    enable(work)
    work[1]["cwd"] = "/outside-project"
    monkeypatch.setattr(codex_input, "capture_context", lambda *args: pytest.fail("Out of scope read"))
    process(work)
    assert not work[0].connections.recent() and work[0].repository.recent()[1] == 0


def test_learning_dispatch_failure_does_not_prevent_preferences(work, monkeypatch, capsys):
    enable(work)
    synchronous_preferences(work, monkeypatch)

    def fail(*args):
        raise OSError("private diagnostic must not reach host")

    monkeypatch.setattr(codex_hook, "dispatch_learning", fail)
    process(work)
    output = capsys.readouterr()
    assert json.loads(output.out)["hookSpecificOutput"]
    assert "private diagnostic" not in output.out + output.err


def test_preference_initialization_failure_does_not_prevent_learning(work, monkeypatch, capsys):
    learning = enable(work)
    children = []
    original = codex_hook.dispatch_learning

    def dispatch(*args):
        child = original(*args)
        children.append(child)
        return child

    def fail(*args, **kwargs):
        raise OSError("application unavailable")

    monkeypatch.setattr(codex_hook, "dispatch_learning", dispatch)
    monkeypatch.setattr("ai_persona.preference_application.service.ApplicationService", fail)
    process(work)
    assert children[0].wait(timeout=5) == 0
    assert len(learning.repository.recent()) == 1
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("output", [RuntimeError("model unavailable"), {"contexts": []}])
def test_failed_judgment_keeps_learning_and_emits_no_global_fallback(work, monkeypatch, capsys, output):
    learning = enable(work)
    synchronous_preferences(work, monkeypatch)
    work[0].ai.model.outputs = [output]
    monkeypatch.setattr(codex_hook, "dispatch_learning", lambda d, s, r, c:
                        (capture(learning, c.connection_id, c.payload, captured=c), None)[1])
    process(work)
    assert capsys.readouterr().out == ""
    row = work[0].repository.recent()[0][0]
    assert row["status"] == "failed" and row["payload"] is None
    assert len(learning.repository.recent()) == 1


def test_blocked_learning_enqueue_does_not_delay_preferences_and_expires(work, monkeypatch, capsys):
    enable(work)
    synchronous_preferences(work, monkeypatch)
    original = codex_hook.dispatch_learning
    children = []

    def dispatch(*args):
        child = original(*args)
        children.append(child)
        return child

    monkeypatch.setattr(codex_hook, "dispatch_learning", dispatch)
    with (work[0].state_root / "persona-mcp.lock").open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        started = time.monotonic()
        process(work)
        assert time.monotonic() - started < 2
        assert json.loads(capsys.readouterr().out)["hookSpecificOutput"]
        assert children[0].wait(timeout=5) == 0
    assert not work[0].connections.recent()


def test_shared_capture_time_counts_toward_preference_deadline(work, monkeypatch, capsys):
    learning = enable(work)
    synchronous_preferences(work, monkeypatch)
    original = codex_hook.capture_input

    def delayed(*args, **kwargs):
        result = original(*args, **kwargs)
        result.started_at -= 6
        return result

    monkeypatch.setattr(codex_hook, "capture_input", delayed)
    monkeypatch.setattr(codex_hook, "dispatch_learning", lambda d, s, r, c:
                        (capture(learning, c.connection_id, c.payload, captured=c), None)[1])
    process(work)
    assert capsys.readouterr().out == ""
    assert work[0].repository.recent()[0][0]["error_code"] == "timeout"
    assert len(learning.repository.recent()) == 1


def test_both_configuration_entries_generate_the_same_single_hook(work):
    learning = enable(work)
    expected = preference_config(work[0], "test_codex")
    assert learning_config(learning, "test_codex") == expected
    handler = expected["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert "codex-hook run" in handler["command"]
    assert handler["timeout"] == 62 and handler["additionalContextLimit"] == 0
    app = create_app(work[0].data_root, work[0].state_root)
    app.state.learning_service = learning
    app.state.preference_application = work[0]
    with TestClient(app) as client:
        first = client.get("/api/learning/v1/connections/test_codex/hook-config")
        second = client.get("/api/preferences/application/hooks/test_codex")
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json() == expected


def test_real_unified_hook_returns_only_preferences_and_enqueues_learning(work, monkeypatch, tmp_path):
    enable(work)
    path = transcript(work, tmp_path)
    service = work[0]
    client = ModelClient(tmp_path / "models")
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(client.directory))
    with local_upstream() as (url, calls):
        try:
            configure(client, url)
            cmd = codex_hook.command(service.data_root, service.state_root, service.connections,
                                     "test_codex", "run")
            result = subprocess.run(cmd, input=json.dumps(work[1]), capture_output=True, text=True, timeout=10)
            assert result.returncode == 0 and result.stderr == ""
            context = json.loads(json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"])
            assert context["type"] == "user_preference_context"
            until = time.monotonic() + 5
            while not service.connections.recent() and time.monotonic() < until:
                time.sleep(0.05)
            assert len(service.connections.recent()) == 1
            assert len(calls) == 1  # Learning model runs later, through its existing worker.
            with path.open("a") as stream:
                stream.write(json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n")
            duplicate = subprocess.run(cmd, input=json.dumps(work[1]), capture_output=True, text=True, timeout=10)
            assert duplicate.returncode == 0 and duplicate.stdout == ""
            assert len(calls) == 1 and service.repository.recent()[1] == 1
            malformed = subprocess.run(cmd, input="not json", capture_output=True, text=True, timeout=5)
            assert malformed.returncode == 0 and malformed.stdout == malformed.stderr == ""
        finally:
            stop(client)
