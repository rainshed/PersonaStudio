#!/usr/bin/env python3
"""Standalone Python 3.11+ remote Codex adapter; no Persona or model dependencies."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import socket
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BODY = 256 * 1024


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def load_config(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 32 * 1024):
            raise ValueError("Remote credentials must be owner-only.")
        config = json.load(stream)
    url = urllib.parse.urlsplit(config["url"])
    if (url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port
            or url.path not in {"", "/"} or url.query or url.fragment or url.username):
        raise ValueError("Expected the loopback SSH tunnel URL.")
    if socket.gethostname() != config["hostname"]:
        raise ValueError("This connection belongs to another host.")
    if not isinstance(config["token"], str) or len(config["token"]) < 32:
        raise ValueError("Invalid credential.")
    return config


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(config, path, body=None, *, timeout=3):
    headers = {"Authorization": "Bearer " + config["token"], "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(config["url"].rstrip("/") + path, headers=headers,
                                 data=encoded(body).encode() if body is not None else None)
    # SSH loopback traffic must not go through shell HTTP proxies or redirects.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(req, timeout=max(0.05, timeout)) as response:
        data = response.read(200_001)
        if len(data) > 200_000:
            raise ValueError("Response exceeds limit.")
        return json.loads(data)


def capture_context(config, payload):
    original = Path(payload.get("transcript_path") or "")
    roots = [Path(root).resolve() for root in config.get("transcript_roots", [])]
    if not payload.get("transcript_path") or not roots:
        return None, "context_unavailable"
    path = original.resolve()
    if not original.is_absolute() or ".." in original.parts or path != original or not any(path.is_relative_to(r) for r in roots):
        return None, "context_path_rejected"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                return None, "context_path_rejected"
            header = stream.readline(32 * 1024)
            meta = json.loads(header)
            if meta.get("type") != "session_meta" or meta.get("payload", {}).get("id") != payload["session_id"]:
                return None, "context_session_mismatch"
            offset = max(len(header), info.st_size - 128 * 1024)
            stream.seek(offset)
            if offset > len(header):
                stream.readline(128 * 1024)
            content = stream.read(min(128 * 1024, info.st_size - stream.tell()))
            after = os.fstat(stream.fileno())
            if after.st_size < info.st_size or (after.st_size == info.st_size and after.st_mtime_ns != info.st_mtime_ns):
                return None, "context_changed"
        messages = []
        for index, line in enumerate(content.splitlines()):
            try:
                entry = json.loads(line)
                message = entry.get("payload", {})
                role = message.get("role")
                if entry.get("type") != "response_item" or message.get("type") != "message" or role not in {"user", "assistant"}:
                    continue
                if role == "assistant" and message.get("channel") not in {None, "final"}:
                    continue
                text = "\n".join(p["text"] for p in message.get("content", []) if isinstance(p, dict)
                                 and p.get("type") in {"input_text", "output_text"} and isinstance(p.get("text"), str))
                if not text.strip() or len(text) > 12_000:
                    continue
                messages.append({"id": "capture_" + digest([offset, index, line.decode()])[:24],
                                 "role": role, "origin": "unknown", "content": [{"type": "text", "text": text}]})
            except (ValueError, TypeError, AttributeError):
                continue
        messages = messages[-12:]
        while len(encoded(messages).encode()) > 24_000:
            messages.pop(0)
        boundary = "capture_" + digest([info.st_ino, info.st_size, content.hex()])[:32]
        return {"id": "ctx_" + digest([config["connection_id"], boundary])[:32],
                "source_connection_id": config["connection_id"], "conversation_id": payload["session_id"],
                "boundary": boundary, "messages": messages, "coverage": "partial",
                "missing": ["bounded_tail_only", "unverified_message_origins"]}, None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None, "context_format_unsupported"


def state_directory(config):
    # Node-local filesystem: the user's home may be shared over NFS by multiple nodes.
    root = Path("/tmp") / ("ai-persona-remote-" + str(os.getuid()))
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe delivery state directory.")
    directory = root / digest([config["hostname"], config["connection_id"]])[:24]
    directory.mkdir(mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Unsafe connection state directory.")
    return directory


def run_hook(config, payload):
    if payload.get("hook_event_name") != "UserPromptSubmit":
        return
    for key in ("session_id", "turn_id", "cwd", "prompt"):
        if not isinstance(payload.get(key), str) or not payload[key]:
            return
    started = time.monotonic()
    budget = min(65, max(2, float(config.get("timeout_seconds", 18))))
    directory = state_directory(config)
    identity = digest([config["connection_id"], payload["session_id"], payload["turn_id"], payload["cwd"], payload["prompt"]])
    path = directory / (identity + ".receipt")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as receipt:
        try:
            fcntl.flock(receipt, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if receipt.read():
            return
        snapshot, warning = capture_context(config, payload)
        body = {"schema_version": "ai-persona.remote-turn/v1", "hostname": config["hostname"],
                **{key: payload[key] for key in ("session_id", "turn_id", "cwd", "prompt")},
                "snapshot": snapshot, "warning": warning}
        if len(encoded(body).encode()) > MAX_BODY:
            raise ValueError("Input exceeds limit.")
        response = None
        for attempt in range(2):
            remaining = budget - (time.monotonic() - started)
            if remaining <= 0:
                break
            try:
                response = request(config, "/v1/codex/turn", body, timeout=remaining)
                break
            except urllib.error.HTTPError:
                raise
            except (OSError, ValueError):
                if attempt:
                    raise
        if response is None or time.monotonic() - started >= budget:
            return
        output = response.get("hook_output")
        if output:
            specific = output.get("hookSpecificOutput", {})
            if (set(output) != {"hookSpecificOutput"} or specific.get("hookEventName") != "UserPromptSubmit"
                    or not isinstance(specific.get("additionalContext"), str)):
                raise ValueError("Invalid Hook output.")
            context = json.loads(specific["additionalContext"])
            if (context.get("schema_version") != "ai-persona.preference-context-payload/v1"
                    or context.get("applies_to", {}).get("turn_id") != payload["turn_id"]):
                raise ValueError("Context belongs to another turn.")
            sys.stdout.write(encoded(output) + "\n")
            sys.stdout.flush()
        receipt.write(str(time.time()))
        receipt.flush()
        if response.get("request_id"):
            try:
                request(config, "/v1/codex/ack/" + response["request_id"], {}, timeout=1)
            except Exception:
                pass
    for old in directory.glob("*.receipt"):
        if old.stat().st_mtime < time.time() - 7 * 86400:
            old.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["hook", "health", "headers"])
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "hook":
            # Shared NFS home: this hook is intentionally inactive on other nodes.
            try:
                load_config(args.config)
            except ValueError as exc:
                if str(exc) == "This connection belongs to another host.":
                    return 0
                raise
        config = load_config(args.config)
        if args.action == "headers":
            print(encoded({"Authorization": "Bearer " + config["token"]}))
        elif args.action == "health":
            print(encoded(request(config, "/healthz")))
        else:
            content = sys.stdin.read(MAX_BODY + 1)
            if len(content.encode()) > MAX_BODY:
                raise ValueError("Input exceeds limit.")
            run_hook(config, json.loads(content))
    except Exception:
        # Neither credentials nor conversation content may be echoed into Codex diagnostics.
        print("AI Persona remote connection unavailable; continuing without new preferences.", file=sys.stderr)
        return 0 if args.action == "hook" else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
