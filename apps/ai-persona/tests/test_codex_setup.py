"""First-run setup uses disposable files and real Hook delivery, never user accounts."""

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from ai_persona import codex_hook, codex_setup
from ai_persona.agent import AgentServiceError
from ai_persona.conversation_learning.contracts import (
    LearningSettings,
    SourceConnection,
    digest,
    encoded,
)
from ai_persona.conversation_learning.repository import LearningRepository
from ai_persona.web import create_app


@pytest.fixture
def setup(tmp_path, monkeypatch):
    data, state, home = tmp_path / "data", tmp_path / "state", tmp_path / "codex"
    data.mkdir()
    state.mkdir()
    (home / "sessions").mkdir(parents=True)
    repo = LearningRepository(data, tmp_path / "queue")
    c = SourceConnection(
        id="codex-test",
        name="Codex test",
        adapter="codex",
        scope_mode="all",
        adapter_config={"codex_home": str(home), "transcript_roots": [str(home / "sessions")]},
    )
    repo.save_connection(c)
    service = SimpleNamespace(repository=repo, data_root=data, state_root=state)
    original = codex_setup.codex_home
    monkeypatch.setattr(
        codex_setup,
        "codex_home",
        lambda connection=None: original(connection) if connection else home,
    )
    return service, c, home


def payload(probe, home, *, cwd=None):
    return {
        "hook_event_name": "UserPromptSubmit",
        "session_id": "chat",
        "turn_id": "turn",
        "prompt": probe["message"],
        "cwd": str(cwd or home),
        "transcript_path": str(home / "sessions" / "chat.jsonl"),
    }


def test_detect_and_validate_are_read_only_and_do_not_grant_roots(setup):
    service, c, home = setup
    before = service.repository.connection(c.id)
    found = codex_setup.environment()
    assert found["sessions"]["path"] == str(home / "sessions") and found["sessions"]["readable"]
    info = codex_setup.status(service, c.id)
    assert not info["installation"]["installed"] and not (home / "hooks.json").exists()
    assert service.repository.connection(c.id) == before
    raw = c.model_dump()
    raw["adapter_config"]["transcript_roots"] = [str(home / "missing")]
    with pytest.raises(AgentServiceError, match="会话目录不存在"):
        codex_setup.normalize_connection(raw)
    raw["adapter_config"]["transcript_roots"] = []
    assert codex_setup.normalize_connection(raw).adapter_config["transcript_roots"] == []
    raw["adapter"] = "standard"
    with pytest.raises(AgentServiceError, match="仅支持 Codex"):
        codex_setup.normalize_connection(raw)


def test_install_preserves_other_hooks_backs_up_and_is_idempotent(setup):
    service, c, home = setup
    own = codex_setup.installation(service, c.id)["snippet"]["hooks"]["UserPromptSubmit"][0][
        "hooks"
    ][0]
    old = {**own, "timeout": 12}
    other = {
        **own,
        "command": own["command"].replace("--connection codex-test", "--connection other-source"),
    }
    unrelated = {"type": "command", "command": "echo unrelated"}
    assert not codex_setup.owns_handler({"type": "command", "command": "echo " + own["command"]}, own)
    existing = {
        "description": "Keep metadata",
        "hooks": {
            "Stop": [{"hooks": [unrelated]}],
            "UserPromptSubmit": [{"matcher": "*", "hooks": [old, unrelated, other]}],
        },
    }
    path = home / "hooks.json"
    original = (json.dumps(existing) + "\n").encode()
    path.write_bytes(original)
    preview = codex_setup.installation(service, c.id)
    assert preview["replace_count"] == 1 and preview["status"] == "update"
    result = codex_setup.install(service, c.id, preview["revision"])
    assert Path(result["backup"]).read_bytes() == original
    saved = json.loads(path.read_text())
    assert saved["description"] == "Keep metadata"
    assert saved["hooks"]["Stop"] == existing["hooks"]["Stop"]
    assert saved["hooks"]["UserPromptSubmit"][0] == {"matcher": "*", "hooks": [unrelated, other]}
    assert saved["hooks"]["UserPromptSubmit"][1]["hooks"] == [own]
    current = path.read_bytes()
    again = codex_setup.install(service, c.id, result["installation"]["revision"])
    assert not again["changed"] and again["backup"] is None and path.read_bytes() == current


def test_installed_hook_uses_stable_command_and_replaces_legacy_entry(setup, monkeypatch):
    service, c, _ = setup
    stable = "/fixture/bin/ai-persona"
    monkeypatch.setenv("AI_PERSONA_COMMAND", stable)
    preview = codex_setup.installation(service, c.id)
    expected = preview["snippet"]["hooks"]["UserPromptSubmit"][0]["hooks"][0]
    assert expected["command"].startswith(stable + " codex-hook run ")
    legacy = {
        **expected,
        "command": (
            f"env PYTHONPATH=/old/source /old/venv/bin/python -m ai_persona "
            f"{expected['command'].split(' ', 1)[1]}"
        ),
    }
    assert codex_setup.owns_handler(legacy, expected)


def test_conflicts_invalid_files_and_symlinks_are_not_overwritten(setup):
    service, c, home = setup
    path = home / "hooks.json"
    preview = codex_setup.installation(service, c.id)
    path.write_text('{"hooks":{},"description":"edited"}')
    with pytest.raises(AgentServiceError, match="变化"):
        codex_setup.install(service, c.id, preview["revision"])
    assert json.loads(path.read_text())["description"] == "edited"
    path.write_text("not json")
    assert not codex_setup.installation(service, c.id)["can_install"]
    with pytest.raises(AgentServiceError):
        codex_setup.install(service, c.id, "anything")
    assert path.read_text() == "not json"
    target = home / "target.json"
    target.write_text('{"hooks":{}}')
    path.unlink()
    path.symlink_to(target)
    assert not codex_setup.installation(service, c.id)["can_install"]
    assert target.read_text() == '{"hooks":{}}'


def test_install_preview_is_bound_to_codex_home_and_source_revision(setup):
    service, c, home = setup
    preview = codex_setup.installation(service, c.id)
    c.adapter_config["codex_home"] = str(home / "another")
    service.repository.save_connection(c)
    with pytest.raises(AgentServiceError, match="变化"):
        codex_setup.install(service, c.id, preview["revision"])
    assert not (home / "another" / "hooks.json").exists()


@pytest.mark.parametrize("enabled", [False, True])
def test_real_hook_probe_bypasses_feature_calls_and_retains_only_diagnostics(
    setup, monkeypatch, enabled
):
    service, c, home = setup
    service.repository.save_settings(LearningSettings(enabled=enabled, allow_model_calls=enabled))
    c.enabled = enabled
    service.repository.save_connection(c)
    monkeypatch.setattr(
        codex_hook,
        "dispatch_learning",
        lambda *args: pytest.fail("Probe must not enqueue learning"),
    )
    lines = [
        {"type": "session_meta", "payload": {"id": "chat"}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "Private prior text"}],
            },
        },
    ]
    (home / "sessions" / "chat.jsonl").write_text("\n".join(json.dumps(v) for v in lines) + "\n")
    probe = codex_setup.begin_probe(service.repository, c.id)
    codex_hook.process_input(
        service.data_root, service.state_root, service.repository, c.id, payload(probe, home)
    )
    result = codex_setup.probe_state(service.repository, c)
    assert (
        result["status"] == "received"
        and result["scope_ok"]
        and result["context_status"] == "readable"
    )
    assert result["context_messages"] == 1 and service.repository.recent() == []
    with service.repository.connect() as db:
        raw = db.execute("SELECT value FROM setup_checks").fetchone()[0]
        assert "Private prior text" not in raw and probe["message"] not in raw
        assert db.execute("SELECT count(*) FROM model_calls").fetchone()[0] == 0


def test_out_of_scope_probe_does_not_read_context_and_prompt_only_is_explicit(setup, monkeypatch):
    service, c, home = setup
    c.scope_mode = "restricted"
    c.allowed_scopes = ["project"]
    c.adapter_config["project_scopes"] = {str(home / "project"): "project"}
    service.repository.save_connection(c)
    probe = codex_setup.begin_probe(service.repository, c.id)
    import ai_persona.codex_input as inputs

    original = inputs.capture_input
    monkeypatch.setattr(inputs, "capture_input", lambda *args: pytest.fail("Out of scope read"))
    assert codex_setup.handle_probe(service.repository, c, payload(probe, home))
    result = codex_setup.probe_state(service.repository, c)
    assert not result["scope_ok"] and result["context_status"] == "not_checked"
    monkeypatch.setattr(inputs, "capture_input", original)
    c.adapter_config["transcript_roots"] = []
    service.repository.save_connection(c)
    assert codex_setup.probe_state(service.repository, c)["status"] == "stale"
    probe = codex_setup.begin_probe(service.repository, c.id)
    codex_setup.handle_probe(service.repository, c, payload(probe, home, cwd=home / "project"))
    assert codex_setup.probe_state(service.repository, c)["context_status"] == "disabled"


def test_probe_restart_expiry_and_connection_change_do_not_accept_old_success(setup):
    service, c, home = setup
    first = codex_setup.begin_probe(service.repository, c.id)
    second = codex_setup.begin_probe(service.repository, c.id)
    codex_setup.handle_probe(service.repository, c, payload(first, home))
    assert codex_setup.probe_state(service.repository, c)["status"] == "waiting"
    c.name = "Changed"
    service.repository.save_connection(c)
    codex_setup.handle_probe(service.repository, c, payload(second, home))
    assert codex_setup.probe_state(service.repository, c)["status"] == "stale"
    fresh = codex_setup.begin_probe(service.repository, c.id)
    with service.repository.transaction() as db:
        value = json.loads(db.execute("SELECT value FROM setup_checks").fetchone()[0])
        value["expires_at"] = time.time() - 1
        db.execute("UPDATE setup_checks SET value=?", (encoded(value),))
    codex_setup.handle_probe(service.repository, c, payload(fresh, home))
    assert codex_setup.probe_state(service.repository, c)["status"] == "expired"


def test_setup_http_requires_local_access_and_explicit_saves(setup):
    service, c, home = setup
    app = create_app(service.data_root, service.state_root)
    app.state.learning_service = service
    client = TestClient(app)
    base = "/api/learning/v1"
    headers = {"X-AI-Persona": "1"}
    before = service.repository.settings()
    assert (
        client.get(
            base + "/codex/environment", headers={"Origin": "https://elsewhere.invalid"}
        ).status_code
        == 403
    )
    route = base + "/connections/" + c.id + "/setup"
    assert client.post(route + "/install", json={}).status_code == 403
    assert client.get(route).status_code == 200 and not (home / "hooks.json").exists()
    raw = c.model_dump()
    raw["adapter_config"]["transcript_roots"] = []
    saved = client.post(
        base + "/codex/connections",
        headers=headers,
        json={"connection": raw, "expected_revision": digest(c)},
    )
    assert saved.status_code == 200
    stale = client.post(
        base + "/codex/connections",
        headers=headers,
        json={"connection": raw, "expected_revision": digest(c)},
    )
    assert stale.status_code == 400 and stale.json()["error"]["code"] == "conflict"
    probe = client.post(route + "/probe", headers=headers, json={})
    assert probe.json()["probe"]["status"] == "waiting"
    assert service.repository.settings() == before and service.repository.recent() == []
