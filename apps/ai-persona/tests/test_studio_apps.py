import json
import os
import socket
import subprocess
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen

import pytest
from test_evaluations import work as work
from test_studio import studio as studio

from ai_persona import studio_apps


@pytest.fixture(autouse=True)
def isolated_companion_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config/config.toml"))
    for name in ("AI_PERSONA_INSTALL_ROOT", "PAPER_RADAR_HOME", "PAPER_RADAR_STORAGE_DIR",
                 "PAPER_RADAR_DATA_DIR", "PAPER_RADAR_PERSONA_CONFIG", "PAPER_RADAR_PORT"):
        monkeypatch.delenv(name, raising=False)


def test_companion_launcher_uses_a_fixed_command_and_passes_workspace_without_shell(monkeypatch, tmp_path):
    root = tmp_path / "Studio with spaces"
    launcher = root / "apps/paper-radar/scripts/launcher.mjs"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("// fixture")
    monkeypatch.setenv("PERSONASTUDIO_ROOT", str(root))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout=json.dumps({"url": "http://127.0.0.1:12345/"}))

    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    workspace = tmp_path / "my persona"
    assert studio_apps.open_paper_radar(workspace) == "http://127.0.0.1:12345/"
    assert calls[0][0] == ["/usr/bin/node", str(launcher), "start", "--no-open", "--json"]
    assert calls[0][1]["env"]["AI_PERSONA_WORKSPACE"] == str(workspace)
    assert not calls[0][1].get("shell")


def test_companion_launcher_rejects_nonlocal_redirects(monkeypatch):
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    for url in ["https://example.org", "http://user@127.0.0.1:3000", "http://127.0.0.1:3000/unexpected"]:
        monkeypatch.setattr(studio_apps.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=json.dumps({"url": url})))
        with pytest.raises(ValueError, match="local application"):
            studio_apps.open_paper_radar(Path("/workspace"))


def test_application_switch_requires_protected_local_post(studio, monkeypatch):
    _, client, _, _, _ = studio
    calls = []
    monkeypatch.setattr(studio_apps, "open_paper_radar", lambda workspace: calls.append(workspace) or "http://127.0.0.1:12345/")
    assert client.post("/studio/paper-radar", json={}).status_code == 403
    assert client.post("/studio/paper-radar", json={}, headers={"X-AI-Persona": "1", "Origin": "https://elsewhere.invalid"}).status_code == 403
    assert not calls
    response = client.post("/studio/paper-radar", json={}, headers={"X-AI-Persona": "1"})
    assert response.status_code == 200
    assert response.json()["url"] == "http://127.0.0.1:12345/"
    assert len(calls) == 1


def test_extensions_offer_installation_without_a_dead_application_link(studio, monkeypatch, tmp_path):
    _, client, _, _, _ = studio
    monkeypatch.delenv("AI_PERSONA_INSTALL_ROOT", raising=False)
    monkeypatch.setenv("PERSONASTUDIO_ROOT", str(tmp_path))
    response = client.get("/settings/extensions")
    assert response.status_code == 200
    assert "--with-paper-radar" in response.text
    assert "data-copy-install" in response.text
    assert "data-open-paper-radar" not in response.text
    launcher = tmp_path / "apps/paper-radar/scripts/launcher.mjs"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("// installed")
    response = client.get("/settings/extensions")
    assert "data-open-paper-radar" in response.text
    assert "data-copy-install" not in response.text
    assert "personastudio remove paper-radar" in response.text
    monkeypatch.setenv("AI_PERSONA_INSTALL_ROOT", str(tmp_path / "managed"))
    response = client.get("/settings/extensions")
    assert "personastudio install paper-radar" in response.text
    assert "curl -fsSL" not in response.text


def test_installed_companion_follows_current_version_and_uses_managed_node(monkeypatch, tmp_path):
    installation = tmp_path / "installed"
    current = installation / "current"
    current.mkdir(parents=True)
    launcher = current / "apps/paper-radar/scripts/launcher.mjs"
    launcher.parent.mkdir(parents=True)
    launcher.touch()
    node = current / "runtime/node/bin/node"
    node.parent.mkdir(parents=True)
    node.touch()
    monkeypatch.setenv("AI_PERSONA_INSTALL_ROOT", str(installation))
    monkeypatch.setenv("PERSONASTUDIO_ROOT", "/obsolete/version")
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: None)
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout=json.dumps({"url": "http://127.0.0.1:12345/"}))
    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    assert studio_apps.radar_launcher() == launcher
    studio_apps.open_paper_radar(tmp_path / "workspace")
    assert calls[0][0] == str(node)
    launcher.unlink()
    assert studio_apps.radar_launcher() is None


def test_binding_persists_per_workspace_and_overrides_an_inherited_profile(monkeypatch, tmp_path):
    workspace, other = tmp_path / "persona one", tmp_path / "persona two"
    home = tmp_path / "Radar with spaces"
    home.mkdir()
    assert studio_apps.save_paper_radar_home(workspace, str(home)) == str(home)
    assert studio_apps.paper_radar_home(workspace) == str(home)
    assert studio_apps.paper_radar_home(other) == ""
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    for name in ("PAPER_RADAR_HOME", "PAPER_RADAR_STORAGE_DIR", "PAPER_RADAR_DATA_DIR",
                 "PAPER_RADAR_PERSONA_CONFIG", "PAPER_RADAR_PORT"):
        monkeypatch.setenv(name, "/old-profile")
    calls = []

    def run(args, **kwargs):
        calls.append(kwargs["env"])
        return SimpleNamespace(stdout=json.dumps({"url": "http://127.0.0.1:12345/"}))

    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    studio_apps.open_paper_radar(workspace)
    assert calls[0]["PAPER_RADAR_HOME"] == str(home)
    assert calls[0]["AI_PERSONA_WORKSPACE"] == str(workspace)
    assert not any(key in calls[0] for key in ("PAPER_RADAR_STORAGE_DIR", "PAPER_RADAR_DATA_DIR",
                                              "PAPER_RADAR_PERSONA_CONFIG", "PAPER_RADAR_PORT"))
    studio_apps.save_paper_radar_home(workspace, "")
    assert studio_apps.paper_radar_home(workspace) == ""
    studio_apps.open_paper_radar(workspace)
    assert calls[1]["PAPER_RADAR_HOME"] == "/old-profile"
    assert calls[1]["PAPER_RADAR_STORAGE_DIR"] == "/old-profile"


@pytest.mark.parametrize("home", [None, 17, [], "relative/path", "/nonexistent/radar/home", "bad\0path"])
def test_invalid_directory_cannot_replace_a_saved_binding(tmp_path, home):
    studio_apps.save_paper_radar_home(tmp_path, str(tmp_path))
    with pytest.raises(studio_apps.PaperRadarError) as caught:
        studio_apps.save_paper_radar_home(tmp_path, home)
    assert caught.value.code == "invalid_home"
    assert studio_apps.paper_radar_home(tmp_path) == str(tmp_path)


def test_missing_or_corrupt_binding_never_silently_launches_default(monkeypatch, tmp_path):
    home = tmp_path / "removed-profile"
    home.mkdir()
    studio_apps.save_paper_radar_home(tmp_path, str(home))
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    home.rmdir()
    with pytest.raises(studio_apps.PaperRadarError) as caught:
        studio_apps.open_paper_radar(tmp_path)
    assert caught.value.code == "invalid_home"
    studio_apps._binding_path(tmp_path).write_text("{broken")
    with pytest.raises(studio_apps.PaperRadarError) as caught:
        studio_apps.open_paper_radar(tmp_path)
    assert caught.value.code == "invalid_binding"


@pytest.mark.parametrize("code", ["data_in_use", "starting", "unresponsive", "not_built", "timeout"])
def test_launcher_reports_safe_structured_errors(monkeypatch, tmp_path, code):
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")

    def run(*args, **kwargs):
        raise subprocess.CalledProcessError(1, args[0], stderr=json.dumps({
            "error": {"code": code, "message": "private log contents"},
        }))

    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    with pytest.raises(studio_apps.PaperRadarError) as caught:
        studio_apps.open_paper_radar(tmp_path)
    assert caught.value.code == code
    assert "private" not in str(caught.value)


def test_launcher_timeout_has_a_specific_error(monkeypatch, tmp_path):
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")

    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 50)

    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    with pytest.raises(studio_apps.PaperRadarError) as caught:
        studio_apps.open_paper_radar(tmp_path)
    assert caught.value.code == "timeout"


def test_settings_endpoint_is_protected_and_survives_page_reload(studio, tmp_path):
    _, client, _, _, store = studio
    home = tmp_path / "linked-radar"
    home.mkdir()
    endpoint = "/studio/paper-radar/settings"
    headers = {"X-AI-Persona": "1"}
    assert client.post(endpoint, json={"home": str(home)}).status_code == 403
    assert client.post(endpoint, json={"home": str(home)}, headers={
        **headers, "Origin": "https://elsewhere.invalid",
    }).status_code == 403
    assert studio_apps.paper_radar_home(store.data_root.parent) == ""
    response = client.post(endpoint, json={"home": str(home)}, headers=headers)
    assert response.json() == {"ok": True, "home": str(home)}
    assert studio_apps.paper_radar_home(store.data_root.parent) == str(home)
    assert str(home) in client.get("/settings/extensions").text
    assert client.post(endpoint, json={"home": ""}, headers=headers).json()["home"] == ""


def test_launch_failure_is_localized_and_keeps_its_cause(studio, monkeypatch):
    _, client, _, _, _ = studio

    def launch(workspace):
        raise studio_apps.PaperRadarError("data_in_use")

    monkeypatch.setattr(studio_apps, "open_paper_radar", launch)
    for locale, message in [("zh-CN", "数据目录正被另一服务占用"), ("en", "Another service")]:
        client.cookies.set("ai_persona_locale", locale)
        response = client.post("/studio/paper-radar", json={}, headers={"X-AI-Persona": "1"})
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "paper_radar_data_in_use"
        assert message in response.json()["error"]["message"]


def test_real_bound_service_reuses_restarts_and_follows_port_changes(monkeypatch, tmp_path):
    launcher = Path(__file__).resolve().parents[2] / "paper-radar/scripts/launcher.mjs"
    node = studio_apps.shutil.which("node")
    if not node or not (launcher.parent.parent / "web/dist/client/index.html").is_file():
        pytest.skip("Build Paper Radar before running the companion integration test")
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: launcher)
    legacy, home, workspace = tmp_path / "legacy", tmp_path / "selected radar", tmp_path / "persona"
    (legacy / "data").mkdir(parents=True)
    (legacy / "data/analysis.lock").write_text(str(os.getpid()))
    home.mkdir()
    monkeypatch.setenv("PAPER_RADAR_HOME", str(legacy))
    monkeypatch.setenv("PAPER_RADAR_CODEX_BIN", str(tmp_path / "no-model-binary"))
    legacy_env = dict(os.environ)
    # Reproduce the original failure without touching the user's legacy service.
    blocked = subprocess.run([node, str(launcher), "start", "--no-open", "--json"],
                             env=legacy_env, capture_output=True, text=True, timeout=10)
    assert blocked.returncode == 1
    assert json.loads(blocked.stderr)["error"]["code"] == "data_in_use"
    studio_apps.save_paper_radar_home(workspace, str(home))
    env = {**os.environ, "PAPER_RADAR_HOME": str(home)}

    def stop():
        subprocess.run([node, str(launcher), "stop"], env=env, capture_output=True,
                       text=True, timeout=20, check=True)

    def state():
        return json.loads((home / "data/.runtime/server.json").read_text())

    try:
        first = studio_apps.open_paper_radar(workspace)
        original = state()
        with urlopen(first, timeout=5) as response:
            assert response.status == 200
        assert studio_apps.open_paper_radar(workspace) == first
        assert state()["pid"] == original["pid"]
        stop()
        # Occupy the old address so a stale/hard-coded redirect would fail.
        with socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("127.0.0.1", original["port"]))
            occupied.listen()
            restarted = studio_apps.open_paper_radar(workspace)
            assert restarted != first
            assert state()["instance_id"] != original["instance_id"]
            with urlopen(restarted, timeout=5) as response:
                assert response.status == 200
        assert (legacy / "data/analysis.lock").read_text() == str(os.getpid())
    finally:
        stop()
