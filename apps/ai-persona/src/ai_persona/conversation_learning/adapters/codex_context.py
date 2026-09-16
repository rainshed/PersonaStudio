"""Bounded Codex JSONL compatibility reader. Unsupported formats fail closed."""

from __future__ import annotations

import json
import os
import stat as file_stat
from pathlib import Path

from ..contracts import ContextSnapshot, Message, TextPart, digest
from ..input_text import learning_text

MAX_CAPTURE_BYTES = 128 * 1024
MAX_HEADER_BYTES = 1024 * 1024


def capture_context(
    path_text: str | None, roots: list[str], connection_id: str, conversation_id: str
):
    if not path_text or not roots:
        return None, "context_unavailable"
    original = Path(path_text)
    if not original.is_absolute() or ".." in original.parts:
        return None, "context_path_rejected"
    path = original.resolve()
    # Validate configured roots, not cwd, and do not follow a client-provided symlink.
    if path != original or not any(path.is_relative_to(Path(root).resolve()) for root in roots):
        return None, "context_path_rejected"
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            stat = os.fstat(stream.fileno())
            if not file_stat.S_ISREG(stat.st_mode):
                return None, "context_path_rejected"
            # Confirm the session identity in the bounded header, not its filename.
            # Session metadata includes base instructions and tool definitions,
            # which can exceed 32 KiB. Keep its bound separate from the chat tail.
            header = stream.readline(MAX_HEADER_BYTES + 1)
            if len(header) > MAX_HEADER_BYTES:
                return None, "context_format_unsupported"
            meta = json.loads(header)
            if (
                meta.get("type") != "session_meta"
                or meta.get("payload", {}).get("id") != conversation_id
            ):
                return None, "context_session_mismatch"
            offset = max(len(header), stat.st_size - MAX_CAPTURE_BYTES)
            stream.seek(offset)
            if offset > len(header):
                stream.readline(MAX_CAPTURE_BYTES)  # discard an incomplete first record
            captured = stream.read(min(MAX_CAPTURE_BYTES, stat.st_size - stream.tell()))
            after = os.fstat(stream.fileno())
            if (
                after.st_size < stat.st_size
                or after.st_ino != stat.st_ino
                or (after.st_size == stat.st_size and after.st_mtime_ns != stat.st_mtime_ns)
            ):
                return None, "context_changed"
        messages = []
        for index, line in enumerate(captured.splitlines()):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            payload = entry.get("payload", {})
            if entry.get("type") != "response_item" or payload.get("type") != "message":
                continue
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue
            if role == "assistant" and payload.get("channel") not in {None, "final"}:
                continue
            parts = payload.get("content", [])
            text = "\n".join(
                p["text"]
                for p in parts
                if isinstance(p, dict)
                and p.get("type") in {"input_text", "output_text"}
                and isinstance(p.get("text"), str)
            )
            if not learning_text(text, role=role).strip() or len(text) > 12_000:
                continue
            # The local offset is a capture identity, not a claimed native message id.
            messages.append(
                Message(
                    id="capture_" + digest([offset, index, line.decode()])[:24],
                    role=role,
                    origin="unknown",
                    content=[TextPart(text=text)],
                )
            )
        messages = messages[-12:]
        while len(json.dumps([m.model_dump() for m in messages])) > 24_000:
            messages.pop(0)
        boundary = "capture_" + digest([stat.st_ino, stat.st_size, captured.hex()])[:32]
        snapshot = ContextSnapshot(
            id="ctx_" + digest([connection_id, boundary])[:32],
            source_connection_id=connection_id,
            conversation_id=conversation_id,
            boundary=boundary,
            messages=messages,
            coverage="partial",
            missing=["bounded_tail_only", "unverified_message_origins"],
        )
        return snapshot, None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None, "context_format_unsupported"
