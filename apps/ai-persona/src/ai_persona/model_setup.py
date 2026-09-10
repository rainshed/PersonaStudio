"""Explicit, local-only installation of the application's locked model runtime."""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import threading

from .runtime_support import runtime_diagnostics


class ModelSetup:
    def __init__(self):
        self._lock = threading.Lock()
        self._installing = False
        self._error: str | None = None

    def status(self) -> dict:
        with self._lock:
            if self._installing:
                return {"status": "installing", "error": None, "checks": []}
            error = self._error
        result = runtime_diagnostics()
        tools_ready = all(c["ok"] for c in result["checks"] if c["name"] != "model_runtime")
        return {
            "status": "ready" if result["ok"] else "needs_node" if not tools_ready
            else "failed" if error else "not_installed",
            "error": error,
            # Do not expose local paths, subprocess output, proxy URLs or account data.
            "checks": [{"name": c["name"], "ok": c["ok"], "version": c["version"]}
                       for c in result["checks"]],
        }

    def install(self) -> dict:
        status = self.status()
        if status["status"] in {"ready", "needs_node", "installing"}:
            return status
        with self._lock:
            if self._installing:
                return {"status": "installing", "error": None, "checks": []}
            self._installing, self._error = True, None
            worker = threading.Thread(target=self._install, name="persona-model-setup", daemon=True)
            worker.start()
        return {"status": "installing", "error": None, "checks": []}

    def _install(self):
        error = None
        try:
            # Only our fixed installer is executable; the HTTP request supplies no arguments.
            # A temporary file bounds memory and keeps npm output out of browser responses.
            with tempfile.TemporaryFile() as output:
                process = subprocess.Popen(
                    [sys.executable, "-m", "ai_persona", "models-install"],
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    if process.wait(timeout=300) != 0:
                        error = "install_failed"
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    error = "install_timeout"
            if error is None and not runtime_diagnostics()["ok"]:
                error = "install_incomplete"
        except (OSError, ValueError):
            error = "install_failed"
        finally:
            with self._lock:
                self._error, self._installing = error, False
