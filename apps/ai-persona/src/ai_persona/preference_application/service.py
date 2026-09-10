"""One binary decision run followed by a complete, versioned context snapshot."""

from __future__ import annotations

import time

from ..agent import AgentServiceError
from ..ai_service import PersonaAIService
from ..codex_input import capture_input, scope_for, turn_identity, validate_payload
from ..conversation_learning.input_text import INPUT_TEXT_VERSION, learning_text
from ..conversation_learning.repository import LearningRepository
from ..store import PersonaStore
from .context import build_context, snapshot_signature
from .repository import ApplicationRepository, encoded


class ApplicationService:
    def __init__(self, data_root, state_root, *, ai_service=None, connections=None):
        self.data_root, self.state_root = data_root, state_root
        self.repository = ApplicationRepository(state_root)
        self.connections = connections or LearningRepository(data_root)
        self.ai = ai_service or PersonaAIService(data_root, state_root)

    def allowed(self, connection_id, cwd, session_id):
        settings = self.repository.settings()
        if not settings.enabled or connection_id not in settings.connection_ids:
            return None
        connection = self.connections.connection(connection_id)
        if connection.adapter != "codex":
            return None
        # Learning's enabled/model/trust switches govern learning only.
        _, reason = scope_for(connection, cwd, session_id)
        return None if reason else connection

    def begin(self, connection_id, payload, *, captured=None):
        settings = self.repository.settings()
        if not settings.enabled or connection_id not in settings.connection_ids:
            return None, False
        validate_payload(payload)
        connection = self.allowed(connection_id, payload["cwd"], payload["session_id"])
        if not connection:
            return None, False
        if captured:
            captured.verify(connection_id, payload)
        request = {
            "connection_id": connection_id, "connection_name": connection.name,
            "session_id": payload["session_id"], "turn_id": payload["turn_id"],
            "cwd": payload["cwd"],
            "user_prompt": captured.user_prompt if captured else learning_text(payload["prompt"]),
            "recent_messages": [], "input_text_version": INPUT_TEXT_VERSION,
            "context_boundary": None,
        }
        identity = turn_identity(connection_id, payload,
                                 remote=bool(connection.adapter_config.get("remote_host")))
        # Freeze the first delivery. Later transcript appends must not create a second run.
        row, created = self.repository.claim(
            identity, request, settings, started_at=captured.started_at if captured else None,
        )
        if not created:
            return self.recover(row), False
        if not request["user_prompt"].strip():
            return self.repository.update(row["id"], {
                "status": "skipped", "decision_state": "not_run", "error_code": "empty_user_input"
            }), True
        try:
            captured = captured or capture_input(connection, payload, started_at=row["created_at"])
            if captured.warning and captured.warning != "context_unavailable":
                raise AgentServiceError(captured.warning, "无法取得本轮必要背景。")
            messages = list(captured.recent_messages[-8:])
            while messages and len(encoded(messages)) > 18000:
                messages.pop(0)
            request.update(
                recent_messages=messages, context_warning=captured.warning,
                context_boundary=captured.snapshot.boundary if captured.snapshot else None,
            )
            row = self.repository.update(row["id"], {"request": request})
        except Exception as exc:
            row = self.fail(row["id"], getattr(exc, "code", "input_error"))
        return row, True

    def fail(self, identifier, code):
        row = self.repository.get(identifier)
        if row["status"] not in {"running", "prepared"}:
            return row
        if row.get("result_id"):
            try:
                result = self.ai.evaluations.result(row["result_id"])
                if result["state"] == "running":
                    self.ai.evaluations.complete_result(result["id"], state="failed", error_code=code)
            except (ValueError, OSError):
                pass
        return self.repository.update(identifier, {
            "status": "failed", "error_code": code, "payload": None,
            "decision_state": "completed" if row.get("activation") else "failed",
        }, expected=("running", "prepared"))

    def recover(self, row):
        if row["status"] in {"running", "prepared"} and time.time() >= row["deadline"]:
            return self.fail(row["id"], "timeout")
        return row

    def process(self, identifier):
        row = self.recover(self.repository.get(identifier))
        if row["status"] != "running":
            return row
        request = row["request"]
        try:
            if not self.allowed(request["connection_id"], request["cwd"], request["session_id"]):
                raise AgentServiceError("disabled", "自动应用已关闭或来源范围已改变。")
            store = PersonaStore(self.data_root).load(verify_source_files=False)
            signature = snapshot_signature(store)
            started = time.time()
            result = self.ai.resolve_persona_activation(
                request["user_prompt"], recent_messages=request["recent_messages"],
                store=store, deadline=row["deadline"] - 0.15,
                run_id=identifier.replace("_", "-"), task_ref=identifier,
                on_result=lambda result_id: self.repository.update(identifier, {"result_id": result_id}),
            )
            self.repository.update(identifier, {
                "activation": result, "decision_state": "completed",
                "judgment_ms": round((time.time() - started) * 1000),
            })
            payload = build_context(store, [c["id"] for c in result["matched_contexts"]],
                                    request["turn_id"], row["settings"]["max_context_bytes"])
            if snapshot_signature(PersonaStore(self.data_root).load(verify_source_files=False)) != signature:
                raise AgentServiceError("context_changed", "偏好内容在准备过程中发生变化。")
            if time.time() >= row["deadline"]:
                raise AgentServiceError("timeout", "本轮等待时间已到。")
            return self.repository.update(identifier, {
                "status": "prepared" if payload else "no_content",
                "payload": payload, "snapshot_signature": signature,
            })
        except Exception as exc:
            return self.fail(identifier, getattr(exc, "code", "preparation_failed"))

    def output(self, identifier):
        row = self.recover(self.repository.get(identifier))
        if row["status"] != "prepared":
            return None
        request = row["request"]
        try:
            if not self.allowed(request["connection_id"], request["cwd"], request["session_id"]):
                raise AgentServiceError("disabled", "自动应用已关闭。")
            if snapshot_signature(PersonaStore(self.data_root).load(verify_source_files=False)) != row["snapshot_signature"]:
                raise AgentServiceError("context_changed", "偏好内容已改变。")
            if time.time() >= row["deadline"]:
                raise AgentServiceError("timeout", "本轮等待时间已到。")
            content = encoded(row["payload"])
            if len(content.encode()) > self.repository.settings().max_context_bytes:
                raise AgentServiceError("context_budget_exceeded", "完整上下文超出提供上限。")
            return {"hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit", "additionalContext": content,
            }}
        except Exception as exc:
            self.fail(identifier, getattr(exc, "code", "preparation_failed"))
            return None
