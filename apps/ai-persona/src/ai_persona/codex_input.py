"""One bounded Codex input snapshot shared by learning and preference application."""

from __future__ import annotations

import time
from pathlib import Path, PurePosixPath

from pydantic import Field

from .conversation_learning.adapters.codex_context import capture_context
from .conversation_learning.contracts import ContextSnapshot, Contract, Identifier, digest
from .conversation_learning.input_text import INPUT_TEXT_VERSION, learning_text


def validate_payload(payload):
    if payload.get("hook_event_name") != "UserPromptSubmit" or not all(
        isinstance(payload.get(key), str) and payload[key]
        for key in ("session_id", "turn_id", "prompt", "cwd")
    ) or not Path(payload["cwd"]).is_absolute():
        raise ValueError("Codex 消息格式无效。")


def scope_for(connection, cwd, session_id):
    """Shared source boundary; each consumer checks its own feature switch."""
    if connection.adapter != "codex":
        raise ValueError("该来源不是 Codex 适配器。")
    if not Path(cwd).is_absolute():
        raise ValueError("Codex 工作目录必须是绝对路径。")
    scopes = connection.adapter_config.get("project_scopes", {})
    if not set(scopes.values()) <= set(connection.allowed_scopes):
        raise ValueError("Codex 项目必须映射到已允许的 scope_ref。")
    # Remote paths belong to another host. Never resolve them against the Mac's filesystem.
    remote = bool(connection.adapter_config.get("remote_host"))
    def canonical(value):
        if remote:
            path = PurePosixPath(value)
            if not path.is_absolute() or ".." in path.parts:
                raise ValueError("远端工作目录必须是规范的绝对路径。")
            return path
        return Path(value).resolve()
    current = canonical(cwd)
    matches = [(canonical(root), scope) for root, scope in scopes.items()
               if Path(root).is_absolute() and current.is_relative_to(canonical(root))]
    if connection.scope_mode != "all":
        if not matches:
            return None, "project_not_allowed"
        if connection.allowed_conversations and session_id not in connection.allowed_conversations:
            return None, "conversation_not_allowed"
    scope = (max(matches, key=lambda item: len(item[0].parts))[1] if matches
             else "codex_cwd_" + digest(str(current)))
    return scope, None


def turn_identity(connection_id, payload, *, remote=False):
    return digest([connection_id, payload["session_id"], payload["turn_id"],
                   str(PurePosixPath(payload["cwd"]) if remote else Path(payload["cwd"]).resolve()),
                   payload["prompt"]])


class CodexInput(Contract):
    connection_id: Identifier
    session_id: Identifier
    turn_id: Identifier
    cwd: str
    prompt: str = Field(max_length=120_000)
    user_prompt: str = Field(max_length=120_000)
    snapshot: ContextSnapshot | None = None
    recent_messages: list[dict[str, str]] = Field(default_factory=list, max_length=12)
    warning: str | None = None
    started_at: float
    input_text_version: str = INPUT_TEXT_VERSION

    @property
    def payload(self):
        return {"hook_event_name": "UserPromptSubmit", "session_id": self.session_id,
                "turn_id": self.turn_id, "cwd": self.cwd, "prompt": self.prompt}

    @property
    def identity(self):
        return turn_identity(self.connection_id, self.payload)

    def verify(self, connection_id, payload):
        validate_payload(payload)
        if self.connection_id != connection_id or self.payload != {
            key: payload[key] for key in self.payload
        }:
            raise ValueError("共享输入与当前 Codex 事件不匹配。")
        if self.snapshot and (self.snapshot.source_connection_id != connection_id
                              or self.snapshot.conversation_id != self.session_id):
            raise ValueError("共享背景与当前来源或会话不匹配。")


def capture_input(connection, payload, *, started_at=None):
    validate_payload(payload)
    started_at = time.time() if started_at is None else started_at
    prompt = learning_text(payload["prompt"])
    snapshot, warning = None, None
    if prompt.strip():
        snapshot, warning = capture_context(
            payload.get("transcript_path"), connection.adapter_config.get("transcript_roots", []),
            connection.id, payload["session_id"],
        )
    messages = []
    if snapshot:
        snapshot = snapshot.model_copy(deep=True)
        messages = [{"role": m.role, "content": m.learning_text} for m in snapshot.messages]
        if messages and messages[-1]["role"] == "user" and messages[-1]["content"] == prompt:
            snapshot.messages.pop()
            messages.pop()
        messages = [m for m in messages if m["content"].strip()]
    return CodexInput(
        connection_id=connection.id, started_at=started_at, user_prompt=prompt,
        snapshot=snapshot, warning=warning, recent_messages=messages,
        **{k: payload[k] for k in ("session_id", "turn_id", "cwd", "prompt")},
    )
