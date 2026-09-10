"""One host entry point: capture once, enqueue learning, return bounded preferences."""

from __future__ import annotations

import contextlib
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .codex_input import CodexInput, capture_input, scope_for, validate_payload
from .conversation_learning.cli import read_input
from .conversation_learning.repository import LearningRepository


def command(data_root, state_root, repository, connection_id, action):
    return [sys.executable, "-m", "ai_persona", "codex-hook", action,
            "--data", str(data_root), "--state", str(state_root),
            "--queue-dir", str(repository.directory), "--connection", connection_id]


def hook_config(data_root, state_root, repository, connection_id):
    if repository.connection(connection_id).adapter != "codex":
        raise ValueError("请选择 Codex 来源。")
    return {"hooks": {"UserPromptSubmit": [{"hooks": [{
        "type": "command",
        "command": shlex.join(["env", "PYTHONPATH=" + str(Path(__file__).resolve().parents[1]),
                               *command(data_root, state_root, repository, connection_id, "run")]),
        # The application enforces the configurable 1–60 second turn budget.
        "timeout": 62, "additionalContextLimit": 0,
        "statusMessage": "正在处理 AI Persona",
    }]}]}}


def diagnostic(repository, connection_id, code):
    with contextlib.suppress(Exception):
        repository.diagnostic(connection_id, code)


def dispatch_learning(data_root, state_root, repository, captured):
    # An inherited, unlinked file avoids a pipe write blocking the synchronous
    # preference path. No transcript reread or durable second inbox is needed.
    with tempfile.TemporaryFile() as stream:
        stream.write(captured.model_dump_json().encode())
        stream.seek(0)
        return subprocess.Popen(
            command(data_root, state_root, repository, captured.connection_id, "enqueue"),
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
            stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


def enqueue(data_root, state_root, repository, connection_id):
    from .conversation_learning.adapters.codex import capture
    from .conversation_learning.service import ConversationLearningService

    def expired(*_):
        raise TimeoutError("Learning enqueue deadline exceeded")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, 3)
    try:
        # Internal snapshot contains both raw and normalized text; the external
        # Hook input retains the existing, smaller 256 KiB limit.
        body = sys.stdin.read(1_048_577)
        if len(body.encode()) > 1_048_576:
            raise ValueError("共享输入超过限制。")
        captured = CodexInput.model_validate_json(body)
        captured.verify(connection_id, captured.payload)
        service = ConversationLearningService(data_root, state_root, repository=repository)
        with contextlib.redirect_stdout(sys.stderr):
            return capture(service, connection_id, captured.payload, captured=captured)
    except Exception:
        diagnostic(repository, connection_id, "capture_failed")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def process_input(data_root, state_root, repository, connection_id, payload, *, captured=None):
    if os.environ.get("AI_PERSONA_INTERNAL_EXTRACTION") == "1":
        return
    started_at = time.time()
    validate_payload(payload)
    connection = repository.connection(connection_id)
    from .codex_setup import handle_probe

    if handle_probe(repository, connection, payload, captured=captured):
        return
    _, reason = scope_for(connection, payload["cwd"], payload["session_id"])
    if reason:
        return
    learning_enabled = application_enabled = False
    try:
        learning_enabled = repository.settings().enabled and connection.enabled
    except Exception:
        diagnostic(repository, connection_id, "learning_settings_unavailable")
    try:
        from .preference_application.repository import ApplicationRepository

        settings = ApplicationRepository(state_root).settings()
        application_enabled = settings.enabled and connection_id in settings.connection_ids
    except Exception:
        diagnostic(repository, connection_id, "preference_settings_unavailable")
    if not learning_enabled and not application_enabled:
        return
    if captured is not None:
        captured.verify(connection_id, payload)
    else:
        captured = capture_input(connection, payload, started_at=started_at)
    learning_process = None
    if learning_enabled:
        try:
            learning_process = dispatch_learning(data_root, state_root, repository, captured)
        except Exception:
            diagnostic(repository, connection_id, "capture_dispatch_failed")
    if application_enabled:
        try:
            from .preference_application.cli import run_hook
            from .preference_application.service import ApplicationService

            service = ApplicationService(data_root, state_root, connections=repository)
            run_hook(service, connection_id, payload, captured=captured)
        except Exception:
            diagnostic(repository, connection_id, "preference_application_failed")
    # Reap an already-completed enqueue process; never wait for learning here.
    if learning_process:
        learning_process.poll()


def run(args, workspace):
    repository = None
    try:
        repository = LearningRepository(workspace.data_root, args.queue_dir)
        if args.action == "enqueue":
            enqueue(workspace.data_root, workspace.state_root, repository, args.connection)
        else:
            process_input(workspace.data_root, workspace.state_root, repository,
                          args.connection, read_input())
    except Exception:
        if repository:
            diagnostic(repository, args.connection, "codex_hook_failed")
    return None
