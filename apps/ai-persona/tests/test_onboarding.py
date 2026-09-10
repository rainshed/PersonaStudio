import json
import os
import socket
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

import pytest
from fastapi.testclient import TestClient

from ai_persona import launcher, onboarding
from ai_persona.initialization import initialize_persona
from ai_persona.workspace import PersonaWorkspace, configured_workspace


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config = tmp_path / "config.toml"
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(config))
    monkeypatch.delenv("AI_PERSONA_WORKSPACE", raising=False)
    calls = []

    def launch(workspace, **options):
        calls.append((workspace, options))
        return {"ok": True, "url": "http://127.0.0.1:" + ("8766" if workspace.is_demo else "8765")}

    monkeypatch.setattr(onboarding, "start_ui", launch)
    app = onboarding.create_setup_app(default_workspace=tmp_path / "personal")
    client = TestClient(app)
    client.headers.update({"Origin": "http://testserver", "X-Persona-Setup": app.state.setup_token})
    return app, client, config, calls


def test_setup_is_bilingual_and_reading_does_not_create_data(setup, tmp_path):
    _, client, config, calls = setup
    english = client.get("/?lang=en")
    chinese = client.get("/?lang=zh-CN")
    assert "Make your AI feel more like you" in english.text
    assert "让 AI 更了解你" in chinese.text
    assert 'lang="zh-CN"' in chinese.text
    assert str(tmp_path / "personal") in english.text
    assert english.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in english.headers["content-security-policy"]
    assert not config.exists() and not calls and not (tmp_path / "personal").exists()


def test_create_workspace_launches_then_sets_default_and_keeps_language(setup, tmp_path):
    _, client, config, calls = setup
    root = tmp_path / "new-persona"
    response = client.post("/api/setup", json={"mode": "create", "path": str(root), "persona_id": "research-persona"},
                           headers={"X-Persona-Language": "zh-CN"})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "url": "http://127.0.0.1:8765", "demo": False}
    assert "research-persona" in (root / "persona-data/config/persona.toml").read_text()
    assert configured_workspace() == root
    assert calls[0][0].root == root
    assert calls[0][1] == {"host": "127.0.0.1", "open_browser": False}
    assert "ai_persona_locale=zh-CN" in response.headers["set-cookie"]
    assert config.stat().st_mode & 0o777 == 0o600
    # A double-click cannot initialize or launch twice.
    assert client.post("/api/setup", json={"mode": "create", "path": str(root)}).status_code == 200
    assert len(calls) == 1


def test_demo_does_not_replace_config_or_start_real_workspace(setup, tmp_path, monkeypatch):
    _, client, config, calls = setup
    config.write_text('[defaults]\nworkspace = "/existing/workspace"\n')
    before = config.read_bytes()
    demo = tmp_path / "demo"
    (demo / "persona-data").mkdir(parents=True)
    monkeypatch.setattr(onboarding, "demo_workspace", lambda: PersonaWorkspace(demo, demo / "persona-data", demo / "persona-state", True))
    response = client.post("/api/setup", json={"mode": "demo", "path": "/ignored"})
    assert response.status_code == 200
    assert response.json()["url"] == "http://127.0.0.1:8766"
    assert calls[0][0].is_demo
    assert config.read_bytes() == before


def test_open_validates_existing_workspace_without_reinitializing(setup, tmp_path, monkeypatch):
    _, client, _, calls = setup
    root = tmp_path / "existing"
    initialize_persona(root / "persona-data", root / "persona-state", persona_id="existing")
    config = root / "persona-data/config/persona.toml"
    before = config.read_bytes()
    monkeypatch.setattr(onboarding, "initialize_persona", lambda *args, **kwargs: pytest.fail("Open must not initialize"))
    response = client.post("/api/setup", json={"mode": "open", "path": str(root)})
    assert response.status_code == 200, response.text
    assert configured_workspace() == root and len(calls) == 1
    assert config.read_bytes() == before


@pytest.mark.parametrize("path", ["/", "relative/path", "/tmp/../unsafe", "\x00invalid", str(Path.home()), str(Path(onboarding.__file__).resolve().parents[2] / "user-data")])
def test_unsafe_paths_never_create_or_launch(setup, path):
    _, client, config, calls = setup
    response = client.post("/api/setup", json={"mode": "create", "path": path})
    assert response.status_code == 400
    assert not config.exists() and not calls


def test_existing_files_and_invalid_workspace_are_preserved(setup, tmp_path):
    _, client, config, calls = setup
    root = tmp_path / "occupied"
    root.mkdir()
    marker = root / "my-notes.txt"
    marker.write_text("keep this")
    for mode in ("create", "open"):
        response = client.post("/api/setup", json={"mode": mode, "path": str(root)})
        assert response.status_code == 400
    assert marker.read_text() == "keep this" and list(root.iterdir()) == [marker]
    assert not config.exists() and not calls


def test_invalid_id_is_rejected_before_creating_folder(setup, tmp_path):
    _, client, config, calls = setup
    root = tmp_path / "new-persona"
    response = client.post("/api/setup", json={"mode": "create", "path": str(root), "persona_id": "bad id"})
    assert response.status_code == 400
    assert not root.exists() and not config.exists() and not calls


@pytest.mark.parametrize("headers", [
    {"Origin": "https://elsewhere.invalid"}, {"Origin": ""}, {"X-Persona-Setup": "wrong"},
    {"Host": "elsewhere.invalid"}, {"Sec-Fetch-Site": "cross-site"},
])
def test_browser_mutations_require_local_origin_and_setup_token(setup, tmp_path, headers):
    _, client, config, calls = setup
    root = tmp_path / "blocked"
    response = client.post("/api/setup", json={"mode": "create", "path": str(root)}, headers=headers)
    assert response.status_code == 403
    assert not root.exists() and not config.exists() and not calls


def test_nonlocal_client_is_blocked_even_when_public_origin_configured(setup, monkeypatch):
    app, _, _, calls = setup
    monkeypatch.setenv("AI_PERSONA_PUBLIC_ORIGIN", "https://private.example")
    client = TestClient(app, client=("192.0.2.44", 50000))
    assert client.get("/").status_code == 403
    assert not calls


def test_failed_start_preserves_workspace_and_default_then_allows_retry(setup, tmp_path, monkeypatch, caplog):
    _, client, config, _ = setup
    config.write_text('[defaults]\nworkspace = "/previous/workspace"\n')
    before = config.read_bytes()
    root = tmp_path / "new-persona"
    original = onboarding.start_ui

    def failed(*args, **kwargs):
        raise RuntimeError("Port busy")

    monkeypatch.setattr(onboarding, "start_ui", failed)
    response = client.post("/api/setup", json={"mode": "create", "path": str(root)})
    assert response.status_code == 400
    assert response.json()["details"] == "Port busy"
    assert "8765" not in response.json()["error"] and "8766" not in response.json()["error"]
    assert any(record.exc_info for record in caplog.records)
    assert (root / "persona-data/config/persona.toml").exists() and config.read_bytes() == before
    monkeypatch.setattr(onboarding, "start_ui", original)
    assert client.post("/api/setup", json={"mode": "create", "path": str(root)}).status_code == 200
    assert configured_workspace() == root


@pytest.mark.parametrize("payload", [[], {"mode": "unknown"}, {"mode": "create", "path": 123}])
def test_invalid_payload_does_not_write(setup, payload):
    _, client, config, calls = setup
    assert client.post("/api/setup", json=payload).status_code == 400
    assert not config.exists() and not calls


def test_permission_failure_has_a_specific_explanation_and_logged_cause(setup, tmp_path, monkeypatch, caplog):
    _, client, config, calls = setup

    def denied(*args, **kwargs):
        raise PermissionError("Cannot create /restricted/persona-data")

    monkeypatch.setattr(onboarding, "initialize_persona", denied)
    response = client.post("/api/setup", json={"mode": "create", "path": str(tmp_path / "personal")},
                           headers={"X-Persona-Language": "zh-CN"})
    assert response.status_code == 400
    assert "权限" in response.json()["error"]
    assert response.json()["details"] == "Cannot create /restricted/persona-data"
    assert any(record.exc_info and "access" in record.message for record in caplog.records)
    assert not config.exists() and not calls


def test_default_save_failure_keeps_running_studio_available_and_allows_retry(
    setup, tmp_path, monkeypatch, caplog,
):
    app, client, config, calls = setup
    root = tmp_path / "personal"
    saved = onboarding.save_configured_workspace
    shutdowns = []
    app.state.shutdown = lambda: shutdowns.append(True)

    def denied(*args, **kwargs):
        raise PermissionError("Default configuration is read-only")

    monkeypatch.setattr(onboarding, "save_configured_workspace", denied)
    payload = {"mode": "create", "path": str(root)}
    first = client.post("/api/setup", json=payload)
    assert first.status_code == 200
    result = first.json()
    assert result["ok"] and result["url"] == "http://127.0.0.1:8765"
    assert "Studio is running" in result["warning"] and "error" not in result
    assert result["details"] == "Default configuration is read-only"
    assert not config.exists() and app.state.completed is None and not shutdowns
    assert len(calls) == 1 and (root / "persona-data/config/persona.toml").is_file()
    assert any(record.exc_info and "default workspace" in record.message for record in caplog.records)
    monkeypatch.setattr(onboarding, "save_configured_workspace", saved)
    retried = client.post("/api/setup", json=payload)
    assert retried.status_code == 200 and "warning" not in retried.json()
    assert configured_workspace() == root and len(shutdowns) == 1
    assert calls[0][0] == calls[1][0]


def test_first_create_opens_real_studio_when_preferred_port_is_occupied(tmp_path, monkeypatch):
    # The complete POST must exercise the real launcher, not a fake success URL.
    for key in list(os.environ):
        if key.startswith("AI_PERSONA_"):
            monkeypatch.delenv(key)
    for key, folder in {
        "AI_PERSONA_CONFIG": "config.toml", "AI_PERSONA_LEARNING_DIR": "learning",
        "AI_PERSONA_DEMO_HOME": "demo", "AI_PERSONA_MODEL_DATA_DIR": "models",
        "AI_PERSONA_MODEL_CACHE": "model-cache", "AI_PERSONA_MODEL_RUNTIME_DIR": "model-runtime",
        "XDG_CONFIG_HOME": "config", "XDG_CACHE_HOME": "cache", "XDG_DATA_HOME": "data",
    }.items():
        monkeypatch.setenv(key, str(tmp_path / folder))
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    monkeypatch.setenv("PYTHONPATH", str(Path(onboarding.__file__).resolve().parents[1]))
    root = tmp_path / "personal"
    workspace = PersonaWorkspace(root, root / "persona-data", root / "persona-state")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(8)
        preferred = occupied.getsockname()[1]
        monkeypatch.setattr(launcher, "DEFAULT_PORT", preferred)
        app = onboarding.create_setup_app(default_workspace=root)
        client = TestClient(app)
        client.headers.update({"Origin": "http://testserver", "X-Persona-Setup": app.state.setup_token})
        try:
            response = client.post("/api/setup", json={"mode": "create", "path": str(root)})
            assert response.status_code == 200, response.text
            result = response.json()
            assert result["ok"] and not result["demo"]
            assert urlsplit(result["url"]).port != preferred
            assert configured_workspace() == root
            opener = build_opener(ProxyHandler({}))
            with opener.open(result["url"] + "/healthz", timeout=5) as health_response:
                health = json.load(health_response)
            assert health["ok"] and health["workspace_id"] == launcher.workspace_identity(
                workspace.data_root, workspace.state_root,
            )
            with opener.open(result["url"] + "/knowledge", timeout=5) as page:
                assert "persona-nav" in page.read().decode()
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as competitor:
                with pytest.raises(OSError):
                    competitor.bind(("127.0.0.1", preferred))
            assert occupied.fileno() >= 0 and occupied.getsockname()[1] == preferred
            with socket.create_connection(("127.0.0.1", preferred), timeout=1) as probe:
                assert probe.getpeername()[1] == preferred
        finally:
            launcher.stop_ui(workspace)
