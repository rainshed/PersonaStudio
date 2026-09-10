"""Explicit MCP verification, separate from the conversation Hook probe."""

import hashlib
import json
import os
import secrets
import socket
import sqlite3
import sys
import time
import tomllib
from contextlib import contextmanager
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

from .agent import AgentServiceError
from .ai_web import check_request, failure, input_json
from .demo import workspace_identity


def configuration(data_root, state_root):
    config_path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"

    def signature(config):
        return hashlib.sha256(
            json.dumps(
                {
                    "mcp": config,
                    "host": socket.gethostname(),
                    "workspace": workspace_identity(data_root, state_root),
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()

    try:
        config = tomllib.loads(config_path.read_text()).get("mcp_servers", {})

        def points_here(entry):
            args = entry.get("args", [])
            if not isinstance(args, list):
                return False
            values = dict(zip(args, args[1:]))
            try:
                if "--workspace" in values:
                    root = Path(values["--workspace"]).expanduser().resolve()
                    return (
                        data_root == root / "persona-data" and state_root == root / "persona-state"
                    )
                return (
                    Path(values.get("--data", "")).expanduser().resolve() == data_root
                    and Path(values.get("--state", "")).expanduser().resolve() == state_root
                )
            except (TypeError, ValueError):
                return False

        matches = {
            k: v
            for k, v in config.items()
            if isinstance(v, dict) and v.get("enabled", True) and points_here(v)
        }
        fingerprint = signature(config)
        return bool(matches), fingerprint
    except FileNotFoundError:
        return False, signature({})
    except (OSError, ValueError):
        return False, "unreadable"


@contextmanager
def database(state_root):
    state_root.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(state_root / "mcp-setup.sqlite3")
    db.row_factory = sqlite3.Row
    db.execute(
        "CREATE TABLE IF NOT EXISTS probes (code TEXT PRIMARY KEY, expires REAL, received REAL, host TEXT, signature TEXT)"
    )
    try:
        with db:
            yield db
    finally:
        db.close()


def verify_connection(data_root, state_root, code):
    digest = hashlib.sha256(code.encode()).hexdigest()
    signature = configuration(data_root, state_root)[1]
    with database(state_root) as db:
        probe = db.execute("SELECT * FROM probes WHERE code=?", (digest,)).fetchone()
        if not probe or probe["expires"] < time.time():
            raise AgentServiceError("invalid_request", "验证消息已过期，请在 Studio 中重新生成。")
        db.execute(
            "UPDATE probes SET received=?,host=?,signature=? WHERE code=?",
            (time.time(), socket.gethostname(), signature, digest),
        )
    return {
        "ok": True,
        "workspace_id": workspace_identity(data_root, state_root),
        "message": "MCP 调用已收到；未触发模型调用或对话学习。",
    }


def mount_mcp_setup(app, data_root, state_root):
    @app.get("/api/studio/mcp-setup")
    async def status(request: Request):
        try:
            check_request(request)
            configured, fingerprint = configuration(data_root, state_root)
            with database(state_root) as db:
                rows = db.execute(
                    "SELECT received,host,signature FROM probes WHERE received IS NOT NULL ORDER BY received DESC LIMIT 10"
                ).fetchall()
            latest = next((dict(r) for r in rows if r["signature"] == fingerprint), None)
            args = [
                "-m",
                "ai_persona.mcp_server",
                "--data",
                str(data_root),
                "--state",
                str(state_root),
            ]
            snippet = (
                "[mcp_servers.ai_persona]\ncommand = "
                + json.dumps(sys.executable)
                + "\nargs = "
                + json.dumps(args, ensure_ascii=False)
                + "\n"
            )
            return JSONResponse(
                {
                    "configured": configured,
                    "verified": bool(latest) and fingerprint != "unreadable",
                    "verification": latest,
                    "config": snippet,
                },
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/mcp-setup/probe")
    async def probe(request: Request):
        try:
            await input_json(request)
            code = secrets.token_urlsafe(18)
            with database(state_root) as db:
                db.execute(
                    "INSERT INTO probes VALUES (?,?,NULL,NULL,?)",
                    (
                        hashlib.sha256(code.encode()).hexdigest(),
                        time.time() + 900,
                        configuration(data_root, state_root)[1],
                    ),
                )
            return {
                "message": f"请调用 AI Persona 的 verify_persona_connection 工具，code 参数为 {code}。这是一次接入检查，不需要查询个人正文或调用模型。",
                "expires_in": 900,
            }
        except Exception as exc:
            return failure(exc)
