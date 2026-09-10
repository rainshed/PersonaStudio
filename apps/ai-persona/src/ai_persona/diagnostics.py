"""Installation diagnostics; no model calls, account reads or process mutations."""
from __future__ import annotations

import platform
import sqlite3
import sys

from . import __version__
from .runtime_support import runtime_diagnostics
from .store import PersonaStore


def diagnose(workspace=None, *, workspace_error=None, require_models=False):
    checks = [{"name": "python", "ok": sys.version_info >= (3, 12),
               "version": platform.python_version(), "required": True},
              {"name": "platform", "ok": sys.platform in {"darwin", "linux"},
               "platform": sys.platform, "required": True,
               "message": "macOS and Linux are supported; native Windows is not supported."}]
    with sqlite3.connect(":memory:") as db:
        try:
            db.execute("CREATE VIRTUAL TABLE probe USING fts5(text)")
            search_ok = True
        except sqlite3.OperationalError:
            search_ok = False
    checks.append({"name": "sqlite_search", "ok": search_ok, "required": True})
    if workspace is None:
        checks.append({"name": "workspace", "ok": False, "required": True,
                       "message": workspace_error or "Run ai-persona setup to choose a workspace."})
    else:
        try:
            store = PersonaStore(workspace.data_root).load()
            checks.append({"name": "workspace", "ok": True, "required": True,
                           "data": str(workspace.data_root), "state": str(workspace.state_root),
                           "records": len(store.records), "sources": len(store.sources),
                           "revision": store.config.revision, "demo": workspace.is_demo})
        except (ValueError, OSError) as exc:
            checks.append({"name": "workspace", "ok": False, "required": True,
                           "message": str(exc)})
    runtime = runtime_diagnostics()
    checks.extend({**check, "required": require_models} for check in runtime["checks"])
    return {"ok": all(c["ok"] for c in checks if c["required"]), "version": __version__,
            "checks": checks, "ai_ready": runtime["ok"],
            "note": "Models are optional for browsing and manual editing. No provider was called."}
