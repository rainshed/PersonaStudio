"""Bounded synchronous host adapter; failed runs have no model-visible output."""

from __future__ import annotations

import contextlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from ..conversation_learning.cli import read_input
from ..conversation_learning.repository import LearningRepository
from .repository import ApplicationSettings, encoded
from .service import ApplicationService


def command(service, action, connection_id=None):
    value = [sys.executable, "-m", "ai_persona", "preferences-apply", action,
             "--data", str(service.data_root), "--state", str(service.state_root),
             "--queue-dir", str(service.connections.directory)]
    if connection_id:
        value += ["--connection", connection_id]
    return value


def hook_config(service, connection_id):
    from ..codex_hook import hook_config as shared_hook_config

    return shared_hook_config(service.data_root, service.state_root, service.connections, connection_id)


def terminate(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=0.1)


def run_hook(service, connection_id, payload, *, captured=None):
    row, created = service.begin(connection_id, payload, captured=captured)
    # Re-deliveries never print a second preference package for an existing event.
    if not row or not created or row["status"] != "running":
        return None
    process = None
    try:
        remaining = row["deadline"] - time.time()
        if remaining <= 0:
            raise subprocess.TimeoutExpired("preferences-apply", 0)
        process = subprocess.Popen(
            [*command(service, "process"), "--application", row["id"]],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2])},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        process.wait(timeout=remaining)
        if process.returncode or service.repository.get(row["id"])["status"] == "running":
            service.fail(row["id"], "process_failed")
        output = service.output(row["id"])
        if output:
            sys.stdout.write(encoded(output) + "\n")
            sys.stdout.flush()
            service.repository.update(row["id"], {"status": "returned"}, expected=("prepared",))
    except subprocess.TimeoutExpired:
        if process:
            terminate(process)
        service.fail(row["id"], "timeout")
    except (Exception, KeyboardInterrupt):
        if process:
            terminate(process)
        service.fail(row["id"], "delivery_failed")
    finally:
        if process:
            terminate(process)
    return None


def run(args, workspace):
    service = ApplicationService(
        workspace.data_root, workspace.state_root,
        connections=LearningRepository(workspace.data_root, args.queue_dir),
    )
    if args.action == "hook":
        # Only the final package is stdout; source/model diagnostics stay local.
        return run_hook(service, args.connection, read_input())
    if args.action == "process":
        with contextlib.redirect_stdout(sys.stderr):
            service.process(args.application)
        return None
    if args.action == "configure":
        settings = ApplicationSettings.model_validate(read_input())
        for connection_id in settings.connection_ids:
            if service.connections.connection(connection_id).adapter != "codex":
                raise ValueError("只支持 Codex 来源。")
        service.repository.save_settings(settings)
        return {"settings": settings.model_dump()}
    if args.action == "hook-config":
        return hook_config(service, args.connection)
    if args.action == "status":
        rows, total = service.repository.recent(limit=10)
        return {"settings": service.repository.settings().model_dump(), "total": total,
                "recent": [{k: r.get(k) for k in (
                    "id", "status", "decision_state", "duration_ms", "error_code"
                )} for r in rows]}
    raise ValueError("不支持的操作。")
