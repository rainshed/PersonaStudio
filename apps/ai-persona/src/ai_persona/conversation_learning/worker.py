"""Explicitly started, independent local worker with leases and bounded retries."""

from __future__ import annotations

import fcntl
import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from ..agent import AgentServiceError
from ..prompt_store import PromptError
from .contracts import encoded
from .pipeline import LearningPipeline


class LearningWorker:
    def __init__(self, service, model=None, context_providers=None):
        self.service = service
        self.repo = service.repository
        self.pipeline = LearningPipeline(service, model, context_providers)

    def run_once(self):
        token = uuid.uuid4().hex
        row = self.repo.claim(token)
        if row is None:
            return False
        stopped = threading.Event()

        def heartbeat():
            while not stopped.wait(20):
                try:
                    if not self.repo.heartbeat(row["id"], token):
                        return
                except Exception:
                    # A short DB lock must not kill the monitor or expose chat text.
                    continue

        monitor = threading.Thread(target=heartbeat, daemon=True)
        monitor.start()
        try:
            self.pipeline.process(row["id"], token)
        except Exception as exc:
            code = exc.code if isinstance(exc, (AgentServiceError, PromptError)) else "internal_error"
            if code != "cancelled":
                status = {"paused_budget": "paused_budget", "paused": "paused"}.get(code)
                if status is None:
                    status = (
                        "retryable_failed"
                        if (isinstance(exc, AgentServiceError) and exc.retryable)
                        or isinstance(exc, OSError)
                        else "failed"
                    )
                try:
                    if code == "invalid_model_output":
                        checkpoint = json.loads(self.repo.get(row["id"])["checkpoint"])
                        checkpoint.pop("candidate", None)
                        self.repo.fenced_update(row["id"], token, checkpoint=encoded(checkpoint))
                    self.repo.fenced_update(row["id"], token, status=status, error_code=code)
                except AgentServiceError:
                    pass
            self.repo.diagnostic(row["connection_id"], code)
        finally:
            stopped.set()
            monitor.join(timeout=1)
        return True

    def serve(self, stop_event=None):
        stop_event = stop_event or threading.Event()
        lock_path = self.repo.directory / "worker.lock"
        with lock_path.open("a+") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            lock_path.chmod(0o600)
            marker = self.repo.directory / "worker.json"
            stop_marker = self.repo.directory / "stop.request"
            # On restart no older worker can own this lock, so immediately expire its leases.
            with self.repo.transaction() as db:
                db.execute("UPDATE events SET lease_until=0 WHERE status='running'")
            last_cleanup = 0
            try:
                while not stop_event.is_set() and not stop_marker.exists():
                    marker.write_text(encoded({"pid": os.getpid(), "heartbeat": time.time()}))
                    marker.chmod(0o600)
                    if time.time() - last_cleanup > 3600:
                        self.service.cleanup()
                        last_cleanup = time.time()
                    if not self.run_once():
                        stop_event.wait(1)
            finally:
                marker.unlink(missing_ok=True)
                stop_marker.unlink(missing_ok=True)


def worker_status(repository):
    lock_path = repository.directory / "worker.lock"
    if not lock_path.exists():
        return {"running": False}
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)
            return {"running": False}
        except BlockingIOError:
            try:
                state = json.loads((repository.directory / "worker.json").read_text())
            except (OSError, ValueError):
                state = {}
            return {
                "running": True,
                "heartbeat": state.get("heartbeat"),
                "stopping": (repository.directory / "stop.request").exists(),
            }


def start_worker(service):
    if worker_status(service.repository)["running"]:
        return worker_status(service.repository)
    if not service.repository.settings().enabled:
        raise AgentServiceError("disabled", "请先启用对话学习。")
    (service.repository.directory / "stop.request").unlink(missing_ok=True)
    env = dict(os.environ)
    # Also works for a src checkout without a globally installed console script.
    source = str(Path(__file__).resolve().parents[2])
    env["PYTHONPATH"] = source + os.pathsep + env.get("PYTHONPATH", "")
    subprocess.Popen(
        [
            sys.executable,
            "-m",
            "ai_persona",
            "learning",
            "worker",
            "--data",
            str(service.data_root),
            "--state",
            str(service.state_root),
            "--queue-dir",
            str(service.repository.directory),
        ],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"starting": True}


def stop_worker(service):
    if not worker_status(service.repository)["running"]:
        return {"running": False}
    # Do not signal a PID from a potentially stale descriptor. The lock owner
    # observes this private marker and exits after the current bounded request.
    marker = service.repository.directory / "stop.request"
    marker.touch(mode=0o600, exist_ok=True)
    return {"stopping": True}


def run_worker(service):
    stopped = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stopped.set())
    LearningWorker(service).serve(stopped)
