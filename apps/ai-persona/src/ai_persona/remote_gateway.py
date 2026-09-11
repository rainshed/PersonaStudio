"""Authenticated loopback gateway for remote Codex MCP and bounded Hook events."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import signal
import sqlite3
import stat
import sys
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .codex_input import CodexInput, scope_for, turn_identity, validate_payload
from .conversation_learning.contracts import ContextSnapshot, Contract, Identifier, digest, encoded
from .conversation_learning.input_text import learning_text
from .conversation_learning.repository import LearningRepository
from .mcp_server import create_mcp_server
from .preference_application.context import remote_context, snapshot_signature
from .preference_application.repository import ApplicationRepository
from .store import PersonaStore

MAX_BODY = 256 * 1024


class RemoteTurn(Contract):
    schema_version: str = Field(pattern=r"^ai-persona.remote-turn/v1$")
    hostname: str = Field(min_length=1, max_length=255)
    session_id: Identifier
    turn_id: Identifier
    cwd: str = Field(min_length=1, max_length=4096)
    prompt: str = Field(max_length=120_000)
    snapshot: ContextSnapshot | None = None
    warning: str | None = Field(default=None, max_length=100)


def private_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 64 * 1024):
            raise ValueError("Credential registry must be an owner-only regular file.")
        return json.load(stream)


class Authentication:
    def __init__(self, app, registry):
        self.app, self.registry = app, registry

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1")
        try:
            valid_host = urlsplit("http://" + host).hostname in {"127.0.0.1", "localhost", "::1"}
            peer = (scope.get("client") or ("",))[0]
            origin = headers.get(b"origin")
            valid_origin = origin is None or origin.decode("latin-1") == "http://" + host
            if not valid_host or not valid_origin or peer not in {"127.0.0.1", "::1"}:
                raise ValueError("invalid transport")
        except ValueError:
            return await JSONResponse({"error": "forbidden"}, status_code=403)(scope, receive, send)
        principal = None
        authorization = headers.get(b"authorization", b"")
        if authorization.startswith(b"Bearer ") and len(authorization) <= 512:
            hashed = hashlib.sha256(authorization[7:]).hexdigest()
            try:
                for client in private_json(self.registry).get("clients", []):
                    if client.get("enabled", True) and hmac.compare_digest(hashed, client["token_sha256"]):
                        principal = client["connection_id"]
                        break
            except (OSError, ValueError, KeyError, TypeError):
                pass
        if not principal:
            return await JSONResponse({"error": "unauthorized"}, status_code=401,
                                      headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
        scope.setdefault("state", {})["persona_connection_id"] = principal
        await self.app(scope, receive, send)


class Requests:
    """First delivery owns processing; retries can retrieve the same bounded result."""

    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, connection TEXT NOT NULL, created REAL NOT NULL,
                expires REAL NOT NULL, response TEXT, delivered REAL)""")
        path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=1)
        try:
            with db:
                yield db
        finally:
            db.close()

    def claim(self, identifier, connection, expires):
        with self.connect() as db:
            # Retain only delivery metadata beyond the short response lifetime.
            db.execute("UPDATE requests SET response=NULL WHERE expires<?", (time.time(),))
            db.execute("DELETE FROM requests WHERE created<?", (time.time() - 7 * 86400,))
            cursor = db.execute("INSERT OR IGNORE INTO requests VALUES (?,?,?,?,NULL,NULL)",
                                (identifier, connection, time.time(), expires))
            return cursor.rowcount == 1

    def get(self, identifier):
        with self.connect() as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM requests WHERE id=?", (identifier,)).fetchone()
        return dict(row) if row else None

    def complete(self, identifier, response):
        with self.connect() as db:
            db.execute("UPDATE requests SET response=? WHERE id=? AND response IS NULL",
                       (encoded(response), identifier))

    def acknowledge(self, identifier, connection):
        with self.connect() as db:
            return db.execute("UPDATE requests SET delivered=? WHERE id=? AND connection=?",
                              (time.time(), identifier, connection)).rowcount == 1


def capture_remote(turn, connection):
    if connection.adapter != "codex" or turn.hostname != connection.adapter_config.get("remote_host"):
        raise ValueError("Wrong remote host or source")
    path = PurePosixPath(turn.cwd)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Invalid remote cwd")
    payload = {"hook_event_name": "UserPromptSubmit", **turn.model_dump(
        include={"session_id", "turn_id", "cwd", "prompt"})}
    validate_payload(payload)
    _, reason = scope_for(connection, turn.cwd, turn.session_id)
    if reason:
        raise ValueError("Remote project outside permitted scope")
    snapshot = turn.snapshot.model_copy(deep=True) if turn.snapshot else None
    if snapshot:
        if (snapshot.source_connection_id != connection.id or snapshot.conversation_id != turn.session_id
                or len(snapshot.messages) > 12 or len(encoded(snapshot).encode()) > 80_000):
            raise ValueError("Invalid context identity or size")
        for message in snapshot.messages:
            if message.role not in {"user", "assistant"}:
                raise ValueError("Invalid context role")
            message.origin = "unknown"
    prompt = learning_text(turn.prompt)
    if snapshot and snapshot.messages and snapshot.messages[-1].role == "user" and snapshot.messages[-1].learning_text == prompt:
        snapshot.messages.pop()
    messages = [{"role": m.role, "content": m.learning_text} for m in snapshot.messages] if snapshot else []
    return CodexInput(connection_id=connection.id, session_id=turn.session_id, turn_id=turn.turn_id,
                      cwd=str(path), prompt=turn.prompt, user_prompt=prompt, snapshot=snapshot,
                      recent_messages=messages, warning=turn.warning, started_at=time.time())


class Gateway:
    def __init__(self, workspace, registry, *, review_url="http://127.0.0.1:8765"):
        self.workspace, self.registry = workspace, registry
        self.connections = LearningRepository(workspace.data_root)
        self.requests = Requests(self.connections.directory / "remote-requests.sqlite3")
        self.tasks = {}
        self.review_url = review_url

    async def execute(self, captured):
        command = [sys.executable, "-m", "ai_persona.remote_gateway", "process",
                   "--workspace", str(self.workspace.root), "--connection", captured.connection_id]
        child = await asyncio.create_subprocess_exec(
            *command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
        )
        timeout = ApplicationRepository(self.workspace.state_root).settings().timeout_seconds + 4
        try:
            stdout, _ = await asyncio.wait_for(child.communicate(captured.model_dump_json().encode()), timeout)
            if child.returncode or len(stdout) > 200_000:
                return {"status": "failed", "hook_output": None}
            output = json.loads(stdout) if stdout.strip() else None
            if output:
                value = json.loads(output["hookSpecificOutput"]["additionalContext"])
                output["hookSpecificOutput"]["additionalContext"] = encoded(remote_context(value))
            return {"status": "returned" if output else "no_context", "hook_output": output}
        except (TimeoutError, ValueError, KeyError):
            return {"status": "failed", "hook_output": None}
        finally:
            if child.returncode is None:
                os.killpg(child.pid, signal.SIGKILL)
                await child.wait()

    async def process(self, identifier, captured):
        try:
            response = await self.execute(captured)
            if response.get("hook_output"):
                applications = ApplicationRepository(self.workspace.state_root)
                with applications.connect() as db:
                    row = db.execute("SELECT body FROM applications WHERE identity=?",
                                     (turn_identity(captured.connection_id, captured.payload, remote=True),)).fetchone()
                application = json.loads(row[0]) if row else {}
                response["_valid_until"] = application.get("deadline", 0)
                response["_signature"] = application.get("snapshot_signature")
            response["request_id"] = identifier
            self.requests.complete(identifier, response)
        except Exception:
            self.requests.complete(identifier, {"status": "failed", "hook_output": None,
                                                "request_id": identifier})
        finally:
            self.tasks.pop(identifier, None)

    async def turn(self, request: Request):
        try:
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY:
                    return JSONResponse({"error": "too_large"}, status_code=413)
            turn = RemoteTurn.model_validate_json(bytes(body))
            connection = self.connections.connection(request.state.persona_connection_id)
            captured = capture_remote(turn, connection)
        except Exception:
            return JSONResponse({"error": "invalid_remote_turn"}, status_code=400)
        identifier = digest([connection.id, turn.session_id, turn.turn_id, turn.cwd, turn.prompt])
        budget = ApplicationRepository(self.workspace.state_root).settings().timeout_seconds + 4
        if len(self.tasks) >= 8 and identifier not in self.tasks:
            return JSONResponse({"error": "busy"}, status_code=429)
        if self.requests.claim(identifier, connection.id, time.time() + budget):
            self.tasks[identifier] = asyncio.create_task(self.process(identifier, captured))
        task = self.tasks.get(identifier)
        if task:
            await asyncio.shield(task)
        row = self.requests.get(identifier)
        response = (json.loads(row["response"]) if row and row["response"] and row["expires"] > time.time()
                    else {"status": "expired", "hook_output": None, "request_id": identifier})
        if response.get("hook_output"):
            # A retry must honor the same settings, revision and deadline as first delivery.
            settings = ApplicationRepository(self.workspace.state_root).settings()
            current = self.connections.connection(connection.id)
            _, reason = scope_for(current, turn.cwd, turn.session_id)
            try:
                valid = (settings.enabled and connection.id in settings.connection_ids and not reason
                         and time.time() < response.get("_valid_until", 0)
                         and len(response["hook_output"]["hookSpecificOutput"]["additionalContext"].encode()) <= settings.max_context_bytes
                         and response.get("_signature") == snapshot_signature(
                             PersonaStore(self.workspace.data_root).load(verify_source_files=False)))
            except Exception:
                valid = False
            if not valid:
                response.update(status="context_unavailable", hook_output=None)
        response = {k: v for k, v in response.items() if not k.startswith("_")}
        return JSONResponse(response, headers={"Cache-Control": "no-store"})

    async def health(self, request: Request):
        connection = self.connections.connection(request.state.persona_connection_id)
        settings = ApplicationRepository(self.workspace.state_root).settings()
        return JSONResponse({"ok": True, "protocol": "ai-persona.remote-turn/v1",
                             "connection_id": connection.id,
                             "hostname": connection.adapter_config.get("remote_host"),
                             "preferences_enabled": settings.enabled and connection.id in settings.connection_ids,
                             "learning_enabled": self.connections.settings().enabled and connection.enabled,
                             "timeout_seconds": settings.timeout_seconds}, headers={"Cache-Control": "no-store"})

    async def ack(self, request: Request):
        ok = self.requests.acknowledge(request.path_params["identifier"], request.state.persona_connection_id)
        return JSONResponse({"ok": ok}, status_code=200 if ok else 404)

    def app(self):
        server = create_mcp_server(self.workspace.data_root, self.workspace.state_root)
        app = server.streamable_http_app(stateless_http=True, json_response=True, max_request_body_size=MAX_BODY)
        app.routes.extend([Route("/healthz", self.health),
                           Route("/v1/codex/turn", self.turn, methods=["POST"]),
                           Route("/v1/codex/ack/{identifier}", self.ack, methods=["POST"])])
        app.add_middleware(Authentication, registry=self.registry)
        return app


def main():
    from .workspace import resolve_workspace

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["serve", "process"])
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--connection")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--review-url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    workspace = resolve_workspace(workspace=args.workspace, data_root=None, state_root=None,
                                  demo=False, require_data=True, require_state=True)
    if args.action == "process":
        from .codex_hook import process_input

        body = sys.stdin.read(1_048_577)
        if len(body.encode()) > 1_048_576:
            return 1
        captured = CodexInput.model_validate_json(body)
        captured.verify(args.connection, captured.payload)
        process_input(workspace.data_root, workspace.state_root, LearningRepository(workspace.data_root),
                      args.connection, captured.payload, captured=captured)
    else:
        import uvicorn

        if args.registry is None:
            parser.error("--registry is required for serve")
        private_json(args.registry)
        uvicorn.run(Gateway(workspace, args.registry, review_url=args.review_url).app(),
                    host="127.0.0.1", port=args.port, proxy_headers=False, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
