"""MCP service self-checks and observed client reads, independent of the Hook."""

import asyncio
import hashlib
import json
import os
import socket
import sqlite3
import sys
import time
import tomllib
from contextlib import contextmanager
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

from .ai_web import check_request, failure, input_json
from .demo import workspace_identity
from .query_mcp import PUBLIC_QUERY_TOOLS


def configuration(data_root, state_root):
    config_path = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"

    def signature(config):
        return hashlib.sha256(
            json.dumps(
                {
                    "mcp": config,
                    "contract": "read-only-mcp/v1",
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
    # Old nonce verification rows are deliberately not treated as read observations.
    db.execute(
        "CREATE TABLE IF NOT EXISTS observations "
        "(signature TEXT, kind TEXT, payload TEXT, PRIMARY KEY(signature, kind))"
    )
    try:
        with db:
            yield db
    finally:
        db.close()


def _save(state_root, signature, kind, value):
    with database(state_root) as db:
        db.execute(
            "INSERT OR REPLACE INTO observations VALUES (?,?,?)",
            (signature, kind, json.dumps(value, ensure_ascii=False)),
        )


def record_client_read(data_root, state_root, signature, tool):
    """Record only successful public reads, without arguments, content or identity claims."""
    if tool not in PUBLIC_QUERY_TOOLS or signature == "unreadable":
        return
    _save(
        state_root,
        signature,
        "client_read",
        {
            "received": time.time(),
            "host": socket.gethostname(),
            "tool": tool,
            "workspace_id": workspace_identity(data_root, state_root),
        },
    )


def server_arguments(data_root, state_root):
    return ["-m", "ai_persona.mcp_server", "--data", str(data_root), "--state", str(state_root)]


async def diagnose_server(data_root, state_root):
    """Start Studio's own server and inspect its handshake/catalog, never call a tool."""
    from mcp import Client, StdioServerParameters, stdio_client

    signature = configuration(data_root, state_root)[1]
    value = {
        "ok": False,
        "checked_at": time.time(),
        "workspace_id": workspace_identity(data_root, state_root),
    }
    parameters = StdioServerParameters(
        command=sys.executable,
        args=server_arguments(data_root, state_root),
        env={
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
            "CODEX_HOME": os.environ.get("CODEX_HOME", str(Path.home() / ".codex")),
            "AI_PERSONA_SEMANTIC_SEARCH": "0",
        },
    )
    try:
        async with asyncio.timeout(15):
            # Client initialization performs the handshake. No query or model call.
            with open(os.devnull, "w") as errors:
                async with Client(
                    stdio_client(parameters, errlog=errors), mode="legacy", read_timeout_seconds=10
                ) as client:
                    listed = await client.list_tools()
                    names = [tool.name for tool in listed.tools]
                    value.update(
                        tools=names,
                        ok=(
                            set(names) == set(PUBLIC_QUERY_TOOLS)
                            and len(names) == len(PUBLIC_QUERY_TOOLS)
                            and all(
                                t.annotations and t.annotations.read_only_hint for t in listed.tools
                            )
                        ),
                    )
                    if not value["ok"]:
                        value["error"] = "unexpected_tool_catalog"
    except Exception:
        value["error"] = "service_unavailable"
    if configuration(data_root, state_root)[1] != signature:
        value.update(ok=False, error="configuration_changed")
    _save(state_root, signature, "service_check", value)
    return value


def mount_mcp_setup(app, data_root, state_root):
    @app.get("/api/studio/mcp-setup")
    async def status(request: Request):
        try:
            check_request(request)
            configured, signature = configuration(data_root, state_root)
            with database(state_root) as db:
                rows = db.execute(
                    "SELECT kind,payload FROM observations WHERE signature=?", (signature,)
                ).fetchall()
            observations = {r["kind"]: json.loads(r["payload"]) for r in rows}
            if signature == "unreadable":
                observations.pop("client_read", None)
            snippet = (
                "[mcp_servers.ai_persona]\ncommand = "
                + json.dumps(sys.executable)
                + "\nargs = "
                + json.dumps(server_arguments(data_root, state_root), ensure_ascii=False)
                + "\nenabled_tools = "
                + json.dumps(PUBLIC_QUERY_TOOLS)
                + "\n\n[mcp_servers.ai_persona.env]\nPYTHONPATH = "
                + json.dumps(str(Path(__file__).resolve().parents[1]), ensure_ascii=False)
                + "\n"
            )
            return JSONResponse(
                {
                    "configured": configured,
                    "workspace_id": workspace_identity(data_root, state_root),
                    "service_check": observations.get("service_check"),
                    "client_read": observations.get("client_read"),
                    "config": snippet,
                    "expected_tools": PUBLIC_QUERY_TOOLS,
                },
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/mcp-setup/diagnose")
    async def diagnose(request: Request):
        try:
            await input_json(request)
            return await diagnose_server(data_root, state_root)
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/mcp-setup/probe")
    async def probe(request: Request):
        try:
            await input_json(request)
            return {
                "message": "请从当前客户端调用 AI Persona 的 get_knowledge_map 工具，参数为 "
                '{"scope":{"tag_ids":[]},"max_chars":1000}。'
                "这是空范围的只读查询，不读取个人正文或调用模型。"
                "成功后在 Studio 检查最近查询的时间与工具名；"
                "该记录表示服务收到查询，不证明某个指定客户端的身份。",
                "tool": "get_knowledge_map",
                "arguments": {"scope": {"tag_ids": []}, "max_chars": 1000},
                "workspace_id": workspace_identity(data_root, state_root),
            }
        except Exception as exc:
            return failure(exc)
