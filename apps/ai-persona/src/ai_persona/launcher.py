from __future__ import annotations

import errno
import fcntl
import json
import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from collections import deque
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from .demo import DEMO_PORT, workspace_identity
from .workspace import PersonaWorkspace

PID_FILENAME = "ui-server.json"
LOG_FILENAME = "ui-server.log"
LOCK_FILENAME = "ui-server-start.lock"
DEFAULT_PORT = 8765


@dataclass(frozen=True)
class UIServerInfo:
    pid: int
    host: str
    port: int
    url: str
    workspace: str | None
    data_root: str
    state_root: str
    started_at: str


def _pid_path(workspace: PersonaWorkspace) -> Path:
    assert workspace.state_root is not None
    return workspace.state_root / PID_FILENAME


def _log_path(workspace: PersonaWorkspace) -> Path:
    assert workspace.state_root is not None
    return workspace.state_root / LOG_FILENAME


def _browser_url(host: str, port: int) -> str:
    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    if ":" in browser_host and not browser_host.startswith("["):
        browser_host = f"[{browser_host}]"
    return f"http://{browser_host}:{port}"


def _read_info(workspace: PersonaWorkspace) -> UIServerInfo | None:
    path = _pid_path(workspace)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return UIServerInfo(
            pid=int(payload["pid"]),
            host=str(payload["host"]),
            port=int(payload["port"]),
            url=str(payload["url"]),
            workspace=str(payload["workspace"]) if payload.get("workspace") else None,
            data_root=str(payload["data_root"]),
            state_root=str(payload["state_root"]),
            started_at=str(payload["started_at"]),
        )
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _write_info(workspace: PersonaWorkspace, info: UIServerInfo) -> None:
    path = _pid_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(asdict(info), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.chmod(0o600)
    os.replace(temporary, path)


def _remove_info(workspace: PersonaWorkspace) -> None:
    _pid_path(workspace).unlink(missing_ok=True)


@contextmanager
def track_ui_process(workspace: PersonaWorkspace, host: str, port: int):
    """Keep start/status/logs usable when a supervisor owns the foreground server."""
    assert workspace.data_root is not None and workspace.state_root is not None
    pid = os.getpid()
    with _start_lock(workspace):
        previous = _read_info(workspace)
        if previous and previous.pid != pid and _pid_is_running(previous.pid):
            raise RuntimeError("Studio is already running; stop the existing process first")
        _write_info(workspace, UIServerInfo(
            pid=pid, host=host, port=port, url=_browser_url(host, port),
            workspace=str(workspace.root) if workspace.root else None,
            data_root=str(workspace.data_root), state_root=str(workspace.state_root),
            started_at=datetime.now(UTC).isoformat(),
        ))
    try:
        yield
    finally:
        with _start_lock(workspace):
            current = _read_info(workspace)
            if current and current.pid == pid:
                _remove_info(workspace)


@contextmanager
def _start_lock(workspace: PersonaWorkspace) -> Iterator[None]:
    assert workspace.state_root is not None
    workspace.state_root.mkdir(parents=True, exist_ok=True)
    lock_path = workspace.state_root / LOCK_FILENAME
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _process_state(pid: int) -> str | None:
    completed = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return None
    state = completed.stdout.strip()
    return state or None


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    state = _process_state(pid)
    return state is not None and not state.startswith("Z")


def _process_command(pid: int) -> str:
    completed = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="],
        check=False,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _is_managed_process(info: UIServerInfo) -> bool:
    command = _process_command(info.pid)
    location_matches = (
        info.state_root in command
        or (info.workspace is not None and info.workspace in command)
        or "--demo" in command
    )
    return "-m ai_persona serve" in command and location_matches


def _health(url: str, *, timeout: float = 0.5) -> dict[str, Any] | None:
    try:
        with urlopen(f"{url}/healthz", timeout=timeout) as response:  # noqa: S310
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        return None
    if payload.get("ok") is not True or payload.get("service") != "ai-persona":
        return None
    return payload


def _location_arguments(workspace: PersonaWorkspace) -> list[str]:
    assert workspace.data_root is not None
    assert workspace.state_root is not None
    if workspace.root is not None:
        return ["--workspace", str(workspace.root)]
    return ["--data", str(workspace.data_root), "--state", str(workspace.state_root)]


def _tail(path: Path, lines: int = 30) -> str:
    if not path.is_file():
        return ""
    with path.open(encoding="utf-8", errors="replace") as handle:
        return "".join(deque(handle, maxlen=lines)).rstrip()


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except webbrowser.Error:
        pass


def _reserve_listener(host: str, port: int, *, automatic: bool) -> socket.socket:
    """Keep the selected port reserved until the child inherits its listener."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    listener = socket.socket(family, socket.SOCK_STREAM)
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((host, port))
        except OSError as exc:
            if exc.errno != errno.EADDRINUSE:
                raise
            if not automatic:
                raise RuntimeError(
                    f"Port {port} is already in use. Choose another --port, "
                    "or omit --port to select an available port automatically."
                ) from exc
            listener.bind((host, 0))
        listener.listen(128)
        return listener
    except BaseException:
        listener.close()
        raise


def start_ui(
    workspace: PersonaWorkspace,
    *,
    host: str = "127.0.0.1",
    port: int | None = None,
    open_browser: bool = True,
    startup_timeout: float = 15.0,
) -> dict[str, Any]:
    assert workspace.data_root is not None
    assert workspace.state_root is not None
    automatic_port = port is None
    port = port if port is not None else DEMO_PORT if workspace.is_demo else DEFAULT_PORT
    identity = workspace_identity(workspace.data_root, workspace.state_root)
    if not 1 <= port <= 65535:
        raise ValueError("port must be between 1 and 65535")
    if startup_timeout <= 0:
        raise ValueError("startup timeout must be positive")

    url = _browser_url(host, port)
    with _start_lock(workspace):
        existing = _read_info(workspace)
        if existing is not None and _pid_is_running(existing.pid):
            health = _health(existing.url)
            if health is None:
                raise RuntimeError(
                    f"AI Persona process {existing.pid} is running but not healthy; "
                    f"inspect {_log_path(workspace)}"
                )
            if health.get("workspace_id") != identity:
                raise RuntimeError("此端口运行的是其他工作区或旧版服务，不会打开它。请使用其他端口。")
            if open_browser:
                _open_browser(existing.url)
            return {
                "ok": True,
                "running": True,
                "already_running": True,
                "managed": True,
                "pid": existing.pid,
                "url": existing.url,
                "persona_revision": health.get("persona_revision"),
                "log": str(_log_path(workspace)),
            }
        if existing is not None:
            _remove_info(workspace)

        unmanaged_health = _health(url)
        if unmanaged_health is not None and unmanaged_health.get("workspace_id") != identity:
            if not automatic_port:
                raise RuntimeError("此端口运行的是其他工作区或旧版服务，不会打开它。请使用其他端口。")
            unmanaged_health = None
        if unmanaged_health is not None:
            if open_browser:
                _open_browser(url)
            return {
                "ok": True,
                "running": True,
                "already_running": True,
                "managed": False,
                "pid": None,
                "url": url,
                "persona_revision": unmanaged_health.get("persona_revision"),
                "log": None,
            }

        log_path = _log_path(workspace)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with _reserve_listener(host, port, automatic=automatic_port) as listener, log_path.open("a", encoding="utf-8") as log_file:
            port = listener.getsockname()[1]
            url = _browser_url(host, port)
            command = [
                sys.executable, "-m", "ai_persona", "serve",
                *_location_arguments(workspace),
                "--host", host, "--port", str(port),
                "--listen-fd", str(listener.fileno()),
            ]
            process = subprocess.Popen(  # noqa: S603
                command,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
                pass_fds=(listener.fileno(),),
            )
        info = UIServerInfo(
            pid=process.pid,
            host=host,
            port=port,
            url=url,
            workspace=str(workspace.root) if workspace.root else None,
            data_root=str(workspace.data_root),
            state_root=str(workspace.state_root),
            started_at=datetime.now(UTC).isoformat(),
        )
        _write_info(workspace, info)

        deadline = time.monotonic() + startup_timeout
        health: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            health = _health(url)
            if health is not None and health.get("workspace_id") == identity:
                break
            health = None
            time.sleep(0.1)

        if health is None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            _remove_info(workspace)
            details = _tail(log_path)
            suffix = f"\n{details}" if details else ""
            raise RuntimeError(f"AI Persona Studio failed to start; inspect {log_path}{suffix}")

        if open_browser:
            _open_browser(url)
        return {
            "ok": True,
            "running": True,
            "already_running": False,
            "managed": True,
            "pid": process.pid,
            "url": url,
            "persona_revision": health.get("persona_revision"),
            "log": str(log_path),
        }


def ui_status(workspace: PersonaWorkspace) -> dict[str, Any]:
    info = _read_info(workspace)
    log_path = _log_path(workspace)
    if info is None:
        return {
            "ok": True,
            "running": False,
            "managed": False,
            "pid": None,
            "url": None,
            "log": str(log_path),
        }
    if not _pid_is_running(info.pid):
        _remove_info(workspace)
        return {
            "ok": True,
            "running": False,
            "managed": True,
            "pid": None,
            "url": info.url,
            "log": str(log_path),
        }
    health = _health(info.url)
    if health and health.get("workspace_id") != workspace_identity(
        workspace.data_root, workspace.state_root
    ):
        health = None
    return {
        "ok": health is not None,
        "running": health is not None,
        "managed": True,
        "pid": info.pid,
        "url": info.url,
        "persona_revision": health.get("persona_revision") if health else None,
        "started_at": info.started_at,
        "log": str(log_path),
    }


def stop_ui(workspace: PersonaWorkspace, *, timeout: float = 10.0) -> dict[str, Any]:
    if timeout <= 0:
        raise ValueError("stop timeout must be positive")
    with _start_lock(workspace):
        info = _read_info(workspace)
        if info is None:
            return {"ok": True, "running": False, "stopped": False, "pid": None}
        if not _pid_is_running(info.pid):
            _remove_info(workspace)
            return {"ok": True, "running": False, "stopped": False, "pid": info.pid}
        if not _is_managed_process(info):
            raise RuntimeError(
                f"refusing to stop PID {info.pid}: it is not the recorded AI Persona process"
            )

        os.kill(info.pid, signal.SIGTERM)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and _pid_is_running(info.pid):
            time.sleep(0.1)
        if _pid_is_running(info.pid):
            raise RuntimeError(f"AI Persona process {info.pid} did not stop within {timeout:g}s")
        _remove_info(workspace)
        return {"ok": True, "running": False, "stopped": True, "pid": info.pid}


def read_ui_logs(workspace: PersonaWorkspace, *, lines: int = 50) -> str:
    if lines < 1:
        raise ValueError("lines must be positive")
    return _tail(_log_path(workspace), lines=lines)
