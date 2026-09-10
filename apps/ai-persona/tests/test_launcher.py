from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

import pytest
from persona_fixture import demo_workspace

from ai_persona import cli, launcher
from ai_persona.launcher import start_ui, stop_ui, ui_status
from ai_persona.store import PersonaStore
from ai_persona.workspace import (
    PersonaWorkspace,
    configured_workspace,
    save_configured_workspace,
)


def _available_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


@pytest.fixture(autouse=True)
def isolated_launcher_environment(tmp_path, monkeypatch):
    """Every subprocess in this module uses only the test's private locations."""
    for name in list(os.environ):
        if name.startswith("AI_PERSONA_"):
            monkeypatch.delenv(name)
    for name, folder in {
        "AI_PERSONA_CONFIG": "config.toml",
        "AI_PERSONA_DEMO_HOME": "demo",
        "AI_PERSONA_MODEL_DATA_DIR": "models",
        "AI_PERSONA_MODEL_RUNTIME_CACHE_DIR": "runtime",
        "AI_PERSONA_LEARNING_DIR": "learning",
    }.items():
        monkeypatch.setenv(name, str(tmp_path / folder))


def _private_workspace(root: Path) -> PersonaWorkspace:
    data, state = root / "persona-data", root / "persona-state"
    shutil.copytree(demo_workspace().data_root, data)
    return PersonaWorkspace(root, data, state)


def test_bare_cli_defaults_to_start_with_repository_workspace(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    config = tmp_path / "persona-data" / "config" / "persona.toml"
    config.parent.mkdir(parents=True)
    config.write_text('[persona]\nid = "test"\nrevision = 1\n', encoding="utf-8")
    observed: dict[str, object] = {}

    def fake_start(workspace: PersonaWorkspace, **kwargs: object) -> dict[str, object]:
        observed["workspace"] = workspace
        observed.update(kwargs)
        return {"ok": True, "running": True, "url": "http://127.0.0.1:8765"}

    monkeypatch.delenv("AI_PERSONA_WORKSPACE", raising=False)
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "missing-config.toml"))
    monkeypatch.setattr(cli, "project_root", lambda: tmp_path)
    monkeypatch.setattr(cli, "start_ui", fake_start)

    assert cli.main([]) == 0
    selected = observed["workspace"]
    assert isinstance(selected, PersonaWorkspace)
    assert selected.root == tmp_path.resolve()
    assert observed["open_browser"] is True
    assert observed["port"] is None
    assert json.loads(capsys.readouterr().out)["running"] is True


def test_saved_default_workspace_round_trips(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "settings" / "config.toml"
    workspace_root = tmp_path / "persona workspace" / "知识"
    workspace_root.mkdir(parents=True)
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(config_path))

    assert save_configured_workspace(workspace_root) == config_path
    assert configured_workspace() == workspace_root.resolve()


def test_demo_never_reuses_real_studio_on_same_port(tmp_path, monkeypatch):
    from ai_persona.workspace import demo_workspace as public_demo

    real = tmp_path / "real"
    shutil.copytree(demo_workspace().data_root, real / "persona-data")
    workspace = PersonaWorkspace(real, real / "persona-data", real / "persona-state")
    monkeypatch.setenv("AI_PERSONA_DEMO_HOME", str(tmp_path / "demo"))
    sample = public_demo()
    real_port, demo_port = _available_port(), _available_port()
    opened = []
    monkeypatch.setattr("ai_persona.launcher._open_browser", opened.append)
    try:
        original = start_ui(workspace, port=real_port, open_browser=False, startup_timeout=20)
        with pytest.raises(RuntimeError, match="其他工作区"):
            start_ui(sample, port=real_port, open_browser=True)
        assert not opened
        assert ui_status(workspace)["pid"] == original["pid"]
        with pytest.raises(RuntimeError, match="只能运行一个"):
            start_ui(sample, port=demo_port, open_browser=False, startup_timeout=20)
        stop_ui(workspace)
        started = start_ui(sample, port=demo_port, open_browser=False, startup_timeout=20)
        assert started["pid"] != original["pid"]
        from types import SimpleNamespace

        from ai_persona import mcp_server

        review = {}

        def server(data, state, **kwargs):
            review.update(kwargs)
            return SimpleNamespace(run=lambda transport: None)

        monkeypatch.setattr(mcp_server, "create_mcp_server", server)
        assert mcp_server.main(["--demo"]) == 0
        assert review["review_base_url"] == f"http://127.0.0.1:{demo_port}"
        stop_ui(sample)
        assert not ui_status(workspace)["running"]
    finally:
        stop_ui(sample)
        stop_ui(workspace)


def test_background_studio_lifecycle(tmp_path: Path) -> None:
    bundled_demo = demo_workspace()
    assert bundled_demo.data_root is not None
    data_root = tmp_path / "persona-data"
    state_root = tmp_path / "persona-state"
    shutil.copytree(bundled_demo.data_root, data_root)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    workspace = PersonaWorkspace(
        root=tmp_path,
        data_root=data_root,
        state_root=state_root,
    )
    port = _available_port()

    try:
        started = start_ui(
            workspace,
            port=port,
            open_browser=False,
            startup_timeout=20,
        )
        assert started["running"] is True
        assert started["already_running"] is False
        assert started["persona_revision"] == store.config.revision

        repeated = start_ui(workspace, port=port, open_browser=False)
        assert repeated["running"] is True
        assert repeated["already_running"] is True
        assert repeated["pid"] == started["pid"]

        status = ui_status(workspace)
        assert status["running"] is True
        assert status["pid"] == started["pid"]

        stopped = stop_ui(workspace)
        assert stopped["stopped"] is True
        assert ui_status(workspace)["running"] is False
    finally:
        status = ui_status(workspace)
        if status["running"]:
            stop_ui(workspace)


@pytest.mark.parametrize("is_demo", [False, True], ids=["workspace", "demo"])
def test_automatic_port_uses_and_reserves_free_preferred_port(tmp_path, monkeypatch, is_demo):
    from ai_persona.workspace import demo_workspace as public_demo

    workspace = public_demo() if is_demo else _private_workspace(tmp_path / "private")
    preferred = _available_port()
    monkeypatch.setattr(launcher, "DEMO_PORT" if is_demo else "DEFAULT_PORT", preferred)
    original_popen = subprocess.Popen
    reservations = []

    def probe_before_spawn(command, *args, **kwargs):
        if list(command)[1:4] == ["-m", "ai_persona", "serve"]:
            # A rival cannot claim the chosen port between selection and startup.
            with socket.socket() as rival:
                with pytest.raises(OSError):
                    rival.bind(("127.0.0.1", preferred))
            reservations.append(preferred)
        return original_popen(command, *args, **kwargs)

    monkeypatch.setattr(launcher.subprocess, "Popen", probe_before_spawn)
    try:
        started = start_ui(workspace, open_browser=False, startup_timeout=20)
        assert started["url"] == f"http://127.0.0.1:{preferred}"
        assert started["running"] and not started["already_running"]
        assert reservations == [preferred]
        assert ui_status(workspace)["pid"] == started["pid"]
    finally:
        stop_ui(workspace)
    assert not ui_status(workspace)["running"]


def test_automatic_port_skips_non_http_listener_and_reuses_fallback(tmp_path, monkeypatch):
    workspace = _private_workspace(tmp_path / "private")
    opened = []
    monkeypatch.setattr(launcher, "_open_browser", opened.append)
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(8)  # Deliberately accepts TCP without speaking HTTP.
        preferred = occupied.getsockname()[1]
        monkeypatch.setattr(launcher, "DEFAULT_PORT", preferred)
        try:
            started = start_ui(workspace, open_browser=True, startup_timeout=20)
            assert started["running"] and not started["already_running"]
            assert started["url"] != f"http://127.0.0.1:{preferred}"
            assert opened == [started["url"]]
            assert occupied.getsockname()[1] == preferred
            with socket.socket() as probe:
                with pytest.raises(OSError):
                    probe.bind(("127.0.0.1", preferred))
            # Freeing the original choice must not spawn a second instance.
            occupied.close()
            repeated = start_ui(workspace, open_browser=False, startup_timeout=20)
            assert repeated["already_running"]
            assert repeated["pid"] == started["pid"]
            assert repeated["url"] == started["url"]
            assert ui_status(workspace)["url"] == started["url"]
            stopped = stop_ui(workspace)
            assert stopped["stopped"] and stopped["pid"] == started["pid"]
            assert not ui_status(workspace)["running"]
        finally:
            stop_ui(workspace)


@pytest.mark.parametrize("is_demo", [False, True], ids=["other-workspace", "demo"])
def test_automatic_port_preserves_another_studio(tmp_path, monkeypatch, is_demo):
    from ai_persona.workspace import demo_workspace as public_demo

    original_workspace = _private_workspace(tmp_path / "original")
    selected = public_demo() if is_demo else _private_workspace(tmp_path / "selected")
    preferred = _available_port()
    opened = []
    monkeypatch.setattr(launcher, "DEMO_PORT" if is_demo else "DEFAULT_PORT", preferred)
    monkeypatch.setattr(launcher, "_open_browser", opened.append)
    try:
        original = start_ui(
            original_workspace, port=preferred, open_browser=False, startup_timeout=20
        )
        with pytest.raises(RuntimeError, match="只能运行一个"):
            start_ui(selected, open_browser=True, startup_timeout=20)
        assert not opened
        assert not ui_status(selected)["running"]
        assert ui_status(original_workspace)["pid"] == original["pid"]
        stop_ui(selected)
        assert ui_status(original_workspace)["running"]
    finally:
        stop_ui(selected)
        stop_ui(original_workspace)


def test_explicit_occupied_port_is_rejected_without_starting_or_opening(tmp_path, monkeypatch):
    workspace = _private_workspace(tmp_path / "private")
    opened = []
    monkeypatch.setattr(launcher, "_open_browser", opened.append)
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen(8)
        port = occupied.getsockname()[1]
        with pytest.raises(RuntimeError, match="port|端口"):
            start_ui(workspace, port=port, open_browser=True, startup_timeout=20)
        assert not opened
        assert occupied.getsockname()[1] == port
        assert not ui_status(workspace)["running"]
        assert not (workspace.state_root / "ui-server.json").exists()


@pytest.mark.parametrize("failure", ["spawn", "startup"])
def test_failed_launch_releases_reserved_port_and_removes_own_descriptor(
    tmp_path,
    monkeypatch,
    failure,
):
    workspace = _private_workspace(tmp_path / "private")
    preferred = _available_port()
    monkeypatch.setattr(launcher, "DEFAULT_PORT", preferred)
    original_popen = subprocess.Popen
    opened, children = [], []
    monkeypatch.setattr(launcher, "_open_browser", opened.append)

    def fail_only_our_launch(command, *args, **kwargs):
        if list(command)[1:4] == ["-m", "ai_persona", "serve"]:
            if failure == "spawn":
                raise OSError("simulated process creation failure")
            command = [sys.executable, "-c", "raise SystemExit(7)"]
            process = original_popen(command, *args, **kwargs)
            children.append(process)
            return process
        return original_popen(command, *args, **kwargs)

    monkeypatch.setattr(launcher.subprocess, "Popen", fail_only_our_launch)
    try:
        with pytest.raises(OSError if failure == "spawn" else RuntimeError):
            start_ui(workspace, open_browser=True, startup_timeout=3)
        assert not opened
        assert not ui_status(workspace)["running"]
        assert not (workspace.state_root / "ui-server.json").exists()
        with socket.socket() as released:
            released.bind(("127.0.0.1", preferred))
        assert all(process.poll() is not None for process in children)
    finally:
        for process in children:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)


@pytest.mark.parametrize("supervised", [False, True])
def test_all_foreground_servers_track_pid_and_ignore_forwarded_peer(tmp_path: Path, supervised):
    data, state = tmp_path / "persona-data", tmp_path / "persona-state"
    shutil.copytree(demo_workspace().data_root, data)
    workspace = PersonaWorkspace(root=tmp_path, data_root=data, state_root=state)
    port = _available_port()
    origin = "https://test-mac.example.ts.net:8443"
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "ai_persona",
            "serve",
            "--workspace",
            str(tmp_path),
            "--port",
            str(port),
            *(["--supervised"] if supervised else []),
        ],
        env={**os.environ, "AI_PERSONA_PUBLIC_ORIGIN": origin},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if ui_status(workspace)["running"]:
                break
            assert process.poll() is None
            time.sleep(0.1)
        status = ui_status(workspace)
        assert status["running"] and status["pid"] == process.pid
        reused = start_ui(workspace, port=_available_port(), open_browser=False)
        assert reused["already_running"] and reused["pid"] == process.pid
        other = _private_workspace(tmp_path / "other")
        with pytest.raises(RuntimeError, match="只能运行一个"):
            start_ui(other, open_browser=False)
        duplicate = subprocess.run(
            [
                sys.executable,
                "-m",
                "ai_persona",
                "serve",
                "--workspace",
                str(other.root),
                "--port",
                str(_available_port()),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert duplicate.returncode != 0
        assert "只能运行一个" in duplicate.stdout + duplicate.stderr
        assert not (other.state_root / "ui-server.json").exists()
        request = Request(
            f"http://127.0.0.1:{port}/healthz",
            headers={
                "Host": "test-mac.example.ts.net:8443",
                "Origin": origin,
                "X-Forwarded-For": "100.64.0.2",
                "X-Forwarded-Proto": "http",
            },
        )
        with build_opener(ProxyHandler({})).open(request, timeout=3) as response:
            assert response.status == 200
    finally:
        process.terminate()
        process.wait(timeout=10)
    # Uvicorn re-raises SIGTERM after shutdown; status clears a stale descriptor.
    assert ui_status(workspace)["running"] is False
    assert not (state / "ui-server.json").exists()


def test_concurrent_starts_share_one_pid_and_setup_reuses_it(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from ai_persona import onboarding

    work = _private_workspace(tmp_path / "work")
    port = _available_port()
    opened = []
    monkeypatch.setattr(onboarding.webbrowser, "open", opened.append)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(lambda _: start_ui(work, port=port, open_browser=False), range(2))
            )
        assert results[0]["pid"] == results[1]["pid"]
        assert sorted(r["already_running"] for r in results) == [False, True]
        assert onboarding.run_setup(open_browser=True) == 0
        assert opened == [results[0]["url"]]
        assert ui_status(work)["pid"] == results[0]["pid"]
    finally:
        stop_ui(work)


def test_crash_releases_single_service_lock_and_allows_restart(tmp_path):
    work = _private_workspace(tmp_path / "work")
    try:
        old = start_ui(work, port=_available_port(), open_browser=False)
        os.kill(old["pid"], 9)
        deadline = time.monotonic() + 10
        while launcher._pid_is_running(old["pid"]) and time.monotonic() < deadline:
            time.sleep(0.05)
        new = start_ui(work, port=_available_port(), open_browser=False)
        assert new["pid"] != old["pid"]
        assert ui_status(work)["running"]
        # Removing metadata must never defeat the process-lifetime lock.
        launcher._pid_path(work).unlink()
        (launcher._global_root() / launcher.PID_FILENAME).unlink()
        with pytest.raises(RuntimeError, match="只能运行一个"):
            start_ui(work, port=_available_port(), open_browser=False)
        info = launcher.UIServerInfo(
            pid=new["pid"],
            host="127.0.0.1",
            port=int(new["url"].rsplit(":", 1)[1]),
            url=new["url"],
            workspace=str(work.root),
            data_root=str(work.data_root),
            state_root=str(work.state_root),
            started_at="test",
        )
        launcher._write_info(work, info)
        launcher._write_info_file(launcher._global_root() / launcher.PID_FILENAME, info)
    finally:
        stop_ui(work)
