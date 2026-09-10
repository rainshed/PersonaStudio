"""User-owned background gateway and reconnecting SSH tunnel."""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def paths(config):
    root = Path.home() / ".local/state/ai-persona/remote" / config["connection_id"]
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    return root


def read_config(path):
    from .remote_gateway import private_json

    value = private_json(path)
    if not value.get("ssh_host") or value["ssh_host"].startswith("-"):
        raise ValueError("Invalid SSH host")
    if not all(1024 <= int(value[k]) <= 65535 for k in ("local_port", "remote_port")):
        raise ValueError("Invalid port")
    return value


def status(config):
    root = paths(config)
    running = False
    with (root / "supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            running = True
    try:
        state = json.loads((root / "status.json").read_text())
    except (OSError, ValueError):
        state = {}
    return {**state, "running": running, "ssh_host": config["ssh_host"],
            "gateway_url": f'http://127.0.0.1:{config["local_port"]}',
            "remote_url": f'http://127.0.0.1:{config["remote_port"]}', "log": str(root / "service.log")}


def supervise(config):
    root = paths(config)
    with (root / "supervisor.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        stopped = False

        def stop(*_):
            nonlocal stopped
            stopped = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        gateway_cmd = [sys.executable, "-m", "ai_persona.remote_gateway", "serve", "--workspace",
                       config["workspace"], "--registry", config["registry"], "--port",
                       str(config["local_port"]), "--review-url", config["review_url"]]
        ssh_cmd = ["/usr/bin/ssh", "-NT", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                   "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=20",
                   "-o", "ServerAliveCountMax=3", "-R",
                   f'127.0.0.1:{config["remote_port"]}:127.0.0.1:{config["local_port"]}',
                   config["ssh_host"]]
        commands, processes, next_start = {"gateway": gateway_cmd, "tunnel": ssh_cmd}, {}, {}
        failures = {"gateway": 0, "tunnel": 0}
        started = {}
        (root / "stop.request").unlink(missing_ok=True)
        try:
            while not stopped and not (root / "stop.request").exists():
                for name, command in commands.items():
                    process = processes.get(name)
                    if process and process.poll() is not None:
                        failures[name] += 1
                        next_start[name] = time.monotonic() + min(30, 2 ** min(failures[name], 5))
                        processes.pop(name)
                    if name not in processes and time.monotonic() >= next_start.get(name, 0):
                        processes[name] = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                                           start_new_session=True)
                        started[name] = time.monotonic()
                    elif name in processes and time.monotonic() - started[name] > 60:
                        failures[name] = 0
                value = {"pid": os.getpid(), "updated_at": time.time(),
                         **{name + "_pid": p.pid for name, p in processes.items() if p.poll() is None},
                         "reconnects": dict(failures)}
                temp = root / "status.tmp"
                temp.write_text(json.dumps(value))
                temp.chmod(0o600)
                temp.replace(root / "status.json")
                time.sleep(1)
        finally:
            for process in processes.values():
                if process.poll() is None:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGTERM)
            for process in processes.values():
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            (root / "status.json").unlink(missing_ok=True)


def run(action, config_path):
    config = read_config(config_path)
    root = paths(config)
    if action == "supervise":
        supervise(config)
        return None
    if action == "start":
        with (root / "start.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not status(config)["running"]:
                (root / "stop.request").unlink(missing_ok=True)
                log = root / "service.log"
                # Bound log growth on an explicit start; diagnostics contain no event bodies.
                if log.exists() and log.stat().st_size > 2_000_000:
                    log.replace(root / "service.previous.log")
                with log.open("a") as stream:
                    log.chmod(0o600)
                    subprocess.Popen([sys.executable, "-m", "ai_persona", "remote", "supervise",
                                      "--config", str(config_path)], stdin=subprocess.DEVNULL,
                                     stdout=stream, stderr=stream, start_new_session=True,
                                     env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])})
                for _ in range(40):
                    if status(config)["running"]:
                        break
                    time.sleep(0.1)
    elif action == "stop":
        (root / "stop.request").touch(mode=0o600)
        for _ in range(100):
            if not status(config)["running"]:
                break
            time.sleep(0.1)
    return status(config)
