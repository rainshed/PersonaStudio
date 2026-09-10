"""Codex learning adapter; accepts the shared Hook snapshot without re-reading it."""

from __future__ import annotations

from ...agent import AgentServiceError
from ...codex_input import capture_input, scope_for, turn_identity, validate_payload
from ..contracts import ContextRef, ConversationEvent, Message, TextPart


def capture(service, connection_id: str, payload: dict, *, captured=None):
    connection = service.repository.connection(connection_id)
    if connection.adapter != "codex":
        raise ValueError("该来源不是 Codex 适配器。")
    if not service.repository.settings().enabled or not connection.enabled:
        return {"status": "ignored_by_policy"}
    validate_payload(payload)
    scope, reason = scope_for(connection, payload["cwd"], payload["session_id"])
    if reason:
        return {"status": "ignored_by_policy", "reason": reason}
    identity = "codex_" + turn_identity(connection_id, payload,
                                       remote=bool(connection.adapter_config.get("remote_host")))
    previous = service.repository.external_receipt(connection_id, identity)
    if previous:
        return previous
    captured = captured or capture_input(connection, payload)
    captured.verify(connection_id, payload)
    snapshot = captured.snapshot.model_copy(deep=True) if captured.snapshot else None
    # Preserve original text for audit; Message.learning_text projects the body.
    message = Message(id=identity, role="user", origin="unknown",
                      content=[TextPart(text=captured.prompt)])
    event = ConversationEvent(
        event_id=identity, event_type="message.submitted", source_connection_id=connection_id,
        conversation_id=captured.session_id, scope_ref=scope, message=message,
        context=ContextRef(ref=snapshot.id, boundary=snapshot.boundary) if snapshot else ContextRef(),
    )
    try:
        result = service.ingest_event(event, connection_id, snapshot)
    except AgentServiceError as exc:
        # Concurrent redelivery can observe a later transcript boundary. The
        # first accepted event owns the snapshot; never enqueue a second job.
        previous = service.repository.external_receipt(connection_id, identity)
        if exc.code != "idempotency_conflict" or previous is None:
            raise
        return previous
    for code in [captured.warning, "codex_origin_unverified"]:
        if code:
            service.repository.diagnostic(connection_id, code)
    return result
