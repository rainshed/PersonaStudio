from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_preference_application import work as work

from ai_persona import codex_setup, remote_client
from ai_persona.conversation_learning.adapters.codex import capture
from ai_persona.conversation_learning.contracts import LearningSettings
from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.preference_application.context import remote_context
from ai_persona.remote_gateway import Gateway, Requests, private_json
from ai_persona.workspace import PersonaWorkspace

TOKEN = "test-remote-persona-token-with-enough-entropy"
HEADERS = {"Authorization": "Bearer " + TOKEN}


@pytest.fixture
def remote(work, tmp_path):
    service, payload, *_ = work
    connection = service.connections.connection("test_codex").model_copy(update={
        "enabled": True, "trust_user_messages": True, "scope_mode": "restricted",
        "allowed_scopes": ["remote-project"],
        "adapter_config": {"remote_host": "tensor-test", "codex_home": "/remote/home/.codex",
                           "project_scopes": {"/remote/project": "remote-project"},
                           "transcript_roots": ["/remote/home/.codex/sessions"]},
    })
    service.connections.save_connection(connection)
    service.connections.save_settings(LearningSettings(enabled=True))
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"clients": [{"connection_id": connection.id,
                        "token_sha256": hashlib.sha256(TOKEN.encode()).hexdigest()}]}))
    registry.chmod(0o600)
    gateway = Gateway(PersonaWorkspace(tmp_path, service.data_root, service.state_root), registry)
    calls = []

    async def execute(captured):
        calls.append(captured)
        learning = ConversationLearningService(service.data_root, service.state_root,
                                                repository=service.connections)
        capture(learning, connection.id, captured.payload, captured=captured)
        row, created = service.begin(connection.id, captured.payload, captured=captured)
        if created:
            service.process(row["id"])
        output = service.output(row["id"])
        return {"status": "returned" if output else "no_context", "hook_output": output}

    gateway.execute = execute
    body = {"schema_version": "ai-persona.remote-turn/v1", "hostname": "tensor-test",
            "session_id": payload["session_id"], "turn_id": payload["turn_id"],
            "cwd": "/remote/project/subdir", "prompt": payload["prompt"]}
    return gateway, body, calls


def client(gateway):
    return TestClient(gateway.app(), base_url="http://127.0.0.1:8766", client=("127.0.0.1", 32123))


def test_authentication_required_for_every_route_and_revocation_is_live(remote):
    gateway, _, _ = remote
    with client(gateway) as http:
        for path in ["/healthz", "/mcp", "/v1/codex/turn"]:
            assert http.get(path).status_code == 401
            assert http.post(path, headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert http.get("/healthz", headers=HEADERS).json()["preferences_enabled"]
        assert http.get("/healthz", headers={**HEADERS, "Host": "attacker.test"}).status_code == 403
        assert http.get("/healthz", headers={**HEADERS, "Origin": "https://attacker.test"}).status_code == 403
        gateway.registry.write_text('{"clients":[]}')
        assert http.get("/healthz", headers=HEADERS).status_code == 401


def test_authenticated_turn_applies_preferences_and_enqueues_learning_once(remote, work):
    gateway, body, calls = remote
    with client(gateway) as http:
        first = http.post("/v1/codex/turn", json=body, headers=HEADERS)
        assert first.status_code == 200
        context = json.loads(first.json()["hook_output"]["hookSpecificOutput"]["additionalContext"])
        assert context["applies_to"]["turn_id"] == body["turn_id"]
        assert context["source"]["kind"] == "saved_user_persona"
        assert context["preferences"]
        second = http.post("/v1/codex/turn", json={**body, "warning": "context_unavailable"}, headers=HEADERS)
        assert first.json() == second.json()
        assert len(calls) == 1 and len(work[0].connections.recent()) == 1
        identifier = first.json()["request_id"]
        assert http.post("/v1/codex/ack/" + identifier, headers=HEADERS).json()["ok"]
        assert gateway.requests.get(identifier)["delivered"]


@pytest.mark.parametrize("change", [
    {"hostname": "other-host"}, {"cwd": "/remote/other"}, {"cwd": "/remote/project/../private"},
    {"connection_id": "local-source"}, {"transcript_path": "/Users/private/file"},
    {"snapshot": {"id": "ctx", "source_connection_id": "other", "conversation_id": "session_test",
                  "boundary": "capture", "messages": []}},
])
def test_remote_scope_and_snapshot_cannot_be_spoofed(remote, change):
    gateway, body, calls = remote
    with client(gateway) as http:
        assert http.post("/v1/codex/turn", json={**body, **change}, headers=HEADERS).status_code == 400
    assert not calls


def test_remote_context_is_normalized_and_never_claims_verified_human_origin(remote):
    gateway, body, calls = remote
    body["snapshot"] = {"id": "ctx", "source_connection_id": "test_codex", "conversation_id": "session_test",
                        "boundary": "capture", "messages": [{"id": "previous", "role": "user",
                        "origin": "human", "content": [{"text": "前一条用户请求"}]}]}
    with client(gateway) as http:
        assert http.post("/v1/codex/turn", json=body, headers=HEADERS).status_code == 200
    assert calls[0].snapshot.messages[0].origin == "unknown"
    assert calls[0].recent_messages == [{"role": "user", "content": "前一条用户请求"}]


def test_mcp_over_http_queries_sources_without_exposing_learning_or_admin_routes(remote):
    gateway, _, _ = remote
    headers = {**HEADERS, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    with client(gateway) as http:
        def rpc(method, params):
            response = http.post("/mcp", headers=headers,
                                 json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            assert response.status_code == 200, response.text
            return response.json()["result"]
        rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                           "clientInfo": {"name": "remote-persona-test", "version": "1"}})
        names = {tool["name"] for tool in rpc("tools/list", {})["tools"]}
        assert {"search_knowledge", "read_source", "prepare_preference_context"} <= names
        assert not {"ingest_conversation_event", "get_conversation_learning_status", "publish"} & names
        result = rpc("tools/call", {"name": "list_source_files", "arguments": {"source_id": "src_demo_note"}})
        assert not result.get("isError")
        assert http.post("/api/learning/v1/events", headers=HEADERS).status_code == 404


def test_remote_resources_use_mcp_and_preserve_original_local_context():
    original = {"reference_samples": [{"resource": {"source_ref": "src_sample", "location": "/Users/private",
                                                   "archive_location": "/Users/archive", "available": True}}]}
    remote = remote_context(original)["reference_samples"][0]["resource"]
    assert "location" not in remote and "archive_location" not in remote
    assert remote["access"]["source_id"] == "src_sample"
    assert original["reference_samples"][0]["resource"]["location"] == "/Users/private"


def test_remote_setup_never_installs_into_mac_hooks(remote, work):
    gateway, _, _ = remote
    learning = ConversationLearningService(work[0].data_root, work[0].state_root, repository=gateway.connections)
    assert not codex_setup.installation(learning, "test_codex")["can_install"]
    with pytest.raises(Exception, match="远端 Hook"):
        codex_setup.install(learning, "test_codex", "any")
    codex_setup.normalize_connection(gateway.connections.connection("test_codex").model_dump())
    info = codex_setup.status(learning, "test_codex")
    assert info["environment"]["remote"]
    assert info["environment"]["sessions"] == {
        "path": "/remote/home/.codex/sessions", "exists": None, "readable": False,
    }
    assert info["environment"]["hooks_path"] == "/remote/home/.codex/hooks.json"


def test_remote_studio_probe_uses_captured_context_without_opening_mac_paths(remote, work, monkeypatch):
    from ai_persona import codex_hook, codex_input
    from ai_persona.remote_gateway import RemoteTurn, capture_remote

    gateway, body, _ = remote
    connection = gateway.connections.connection("test_codex")
    probe = codex_setup.begin_probe(gateway.connections, connection.id)
    body["prompt"] = probe["message"]
    body["snapshot"] = {"id": "ctx", "source_connection_id": connection.id,
                        "conversation_id": body["session_id"], "boundary": "capture",
                        "messages": [{"id": "previous", "role": "user", "origin": "unknown",
                                      "content": [{"text": "上一条消息"}]}]}
    captured = capture_remote(RemoteTurn.model_validate(body), connection)

    def forbidden(*args, **kwargs):
        raise AssertionError("Must not read remote transcript on Mac")

    monkeypatch.setattr(codex_input, "capture_input", forbidden)
    codex_hook.process_input(work[0].data_root, work[0].state_root, gateway.connections,
                             connection.id, captured.payload, captured=captured)
    result = codex_setup.probe_state(gateway.connections, connection)
    assert result["status"] == "received" and result["scope_ok"]
    assert result["context_status"] == "readable" and result["context_messages"] == 1
    assert not gateway.connections.recent()


def test_retry_rechecks_preference_switch_and_deadline(remote, work):
    gateway, body, calls = remote
    with client(gateway) as http:
        assert http.post("/v1/codex/turn", json=body, headers=HEADERS).json()["hook_output"]
        settings = work[0].repository.settings()
        settings.enabled = False
        work[0].repository.save_settings(settings)
        assert http.post("/v1/codex/turn", json=body, headers=HEADERS).json()["hook_output"] is None
        assert len(calls) == 1


def test_failed_processing_does_not_return_partial_context(remote):
    gateway, body, _ = remote
    async def fail(captured):
        raise RuntimeError("private diagnostic")
    gateway.execute = fail
    with client(gateway) as http:
        response = http.post("/v1/codex/turn", json=body, headers=HEADERS)
        assert response.json()["hook_output"] is None
        assert "private diagnostic" not in response.text


def test_client_is_fail_open_when_tunnel_is_down(tmp_path):
    config = tmp_path / "config.json"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config.write_text(json.dumps({"url": f"http://127.0.0.1:{port}", "token": TOKEN,
                                  "hostname": socket.gethostname(), "connection_id": "offline-test"}))
    config.chmod(0o600)
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "offline", "turn_id": str(time.time()),
               "cwd": str(tmp_path), "prompt": "private user input"}
    result = subprocess.run([sys.executable, str(Path(remote_client.__file__)), "hook", "--config", str(config)],
                            input=json.dumps(payload), text=True, capture_output=True, timeout=5)
    assert result.returncode == 0 and not result.stdout
    assert TOKEN not in result.stderr and payload["prompt"] not in result.stderr


def test_client_delivery_deduplicates_and_validates_turn(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(remote_client, "state_directory", lambda config: tmp_path)
    output = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": json.dumps({
        "schema_version": "ai-persona.preference-context-payload/v1", "applies_to": {"turn_id": "turn"}})}}
    calls = []
    def request(config, path, body=None, **kwargs):
        calls.append(path)
        return {"hook_output": output, "request_id": "receipt"} if path.endswith("turn") else {"ok": True}
    monkeypatch.setattr(remote_client, "request", request)
    config = {"connection_id": "remote", "hostname": "test"}
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "session", "turn_id": "turn",
               "cwd": str(tmp_path), "prompt": "Hello"}
    remote_client.run_hook(config, payload)
    assert json.loads(capsys.readouterr().out) == output
    remote_client.run_hook(config, payload)
    assert not capsys.readouterr().out
    assert calls == ["/v1/codex/turn", "/v1/codex/ack/receipt"]


def test_credentials_reject_world_readable_and_symlink_files(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{}')
    path.chmod(0o644)
    with pytest.raises(ValueError):
        private_json(path)
    path.chmod(0o600)
    link = tmp_path / "symlink"
    link.symlink_to(path)
    with pytest.raises(OSError):
        private_json(link)


def test_expired_response_is_not_replayed(tmp_path):
    requests = Requests(tmp_path / "requests.sqlite3")
    assert requests.claim("one", "client", time.time() - 1)
    requests.complete("one", {"hook_output": "expired preference"})
    assert not requests.claim("one", "client", time.time() + 10)
    assert requests.get("one")["response"] is None


@pytest.mark.parametrize("node_local", [False, True])
def test_installer_preserves_existing_configuration_and_reuses_credentials(tmp_path, node_local):
    from ai_persona.remote_install import REMOTE_INSTALL

    home = tmp_path / "home"
    codex = home / ".codex"
    codex.mkdir(parents=True)
    (codex / "config.toml").write_text('model = "existing-model"\n[mcp_servers.existing]\ncommand = "existing"\n')
    original_hook = {"type": "command", "command": "existing-command"}
    (codex / "hooks.json").write_text(json.dumps({"hooks": {"UserPromptSubmit": [{"hooks": [original_hook]}]}}))
    effective = tmp_path / "node-local" if node_local else codex
    if node_local:
        effective.mkdir()
        (effective / "config.toml").symlink_to(codex / "config.toml")
    payload = {"name": "tensor-test", "connection_id": "remote_test", "remote_port": 18766,
               "token": TOKEN, "script": Path(remote_client.__file__).read_text()}
    results = []
    for index, token in enumerate([TOKEN, "different-generated-token-on-second-install"]):
        payload["token"] = token
        result = subprocess.run([sys.executable, "-"], input=REMOTE_INSTALL.replace("PAYLOAD", repr(payload), 1),
                                text=True, capture_output=True,
                                env={**os.environ, "HOME": str(home), "CODEX_HOME": str(effective)}, timeout=10)
        assert result.returncode == 0, result.stderr
        results.append(json.loads(result.stdout))
        assert token not in result.stdout
        if index == 0:
            path = codex / "config.toml"
            path.write_text(path.read_text().replace(
                '# END AI Persona remote tensor-test',
                '[hooks.state."existing-hook"]\ntrusted_hash = "preserve-trust"\n# END AI Persona remote tensor-test'))
    assert results[0]["token_sha256"] == results[1]["token_sha256"]
    import tomllib

    config = tomllib.loads((codex / "config.toml").read_text())
    assert config["model"] == "existing-model" and "existing" in config["mcp_servers"]
    assert len(config["mcp_servers"]) == 2
    assert config["hooks"]["state"]["existing-hook"]["trusted_hash"] == "preserve-trust"
    hooks = json.loads((codex / "hooks.json").read_text())["hooks"]["UserPromptSubmit"]
    assert sum(len(g["hooks"]) for g in hooks) == 2 and hooks[0]["hooks"] == [original_hook]
    assert Path(results[0]["config"]).stat().st_mode & 0o777 == 0o600
    assert list(codex.glob("config.toml.backup-*"))
    assert results[-1]["codex_home"] == str(effective)
    assert results[-1]["hooks_path"] == str(effective / "hooks.json")
    client = json.loads(Path(results[-1]["config"]).read_text())
    assert str(effective / "sessions") in client["transcript_roots"]
    if node_local:
        assert (effective / "config.toml").is_symlink()
        assert (effective / "hooks.json").is_symlink()
        assert (effective / "hooks.json").resolve() == codex / "hooks.json"
