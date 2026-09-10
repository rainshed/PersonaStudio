"""One authenticated application boundary for CLI, Studio and future connectors."""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from ..agent import AgentServiceError, PersonaProposalFacade
from ..change_sets import proposal_lock
from ..proposals import ProposalRepository
from .contracts import ContextSnapshot, ConversationEvent, digest, encoded
from .policy import authorized, origin_basis
from .repository import LearningRepository

SECRET = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"\bsk-[A-Za-z0-9_-]{20,}|\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}|"
    r"(?i:authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]{16,}"
)


class ConversationLearningService:
    def __init__(self, data_root: Path, state_root: Path, *, repository=None):
        from ..demo import check_demo_paths

        check_demo_paths(data_root, state_root)
        self.data_root = data_root.resolve()
        self.state_root = state_root.resolve()
        self.repository = repository or LearningRepository(data_root)

    def _principal(self, connection_id: str, principal: str):
        if principal != connection_id:
            raise AgentServiceError("forbidden", "来源连接与调用身份不匹配。")

    def _snapshot(self, event: ConversationEvent, snapshot: ContextSnapshot | None):
        if snapshot is None:
            return None
        if (
            snapshot.source_connection_id != event.source_connection_id
            or snapshot.conversation_id != event.conversation_id
            or not event.context.boundary
            or snapshot.boundary != event.context.boundary
        ):
            raise AgentServiceError("invalid_context", "上下文来源、会话或时间边界不匹配。")
        for message in snapshot.messages:
            if message.id == event.message.id and message != event.message:
                raise AgentServiceError("invalid_context", "上下文中的当前消息与事件不一致。")
        if SECRET.search(encoded(snapshot)):
            raise AgentServiceError("sensitive_content", "上下文疑似包含凭据，未采集。")
        return encoded(snapshot)

    def ingest_event(
        self, event: ConversationEvent, principal: str, snapshot: ContextSnapshot | None = None
    ) -> dict:
        from ..demo import is_demo_data

        if is_demo_data(self.data_root):
            raise AgentServiceError("demo_isolated", "Demo 不采集真实会话。")
        self._principal(event.source_connection_id, principal)
        repo = self.repository
        # Lifecycle invalidation uses the same lock as review to prevent a late acceptance.
        with proposal_lock(self.state_root), repo.transaction() as db:
            connection = repo.connection(event.source_connection_id, db)
            settings = repo.settings(db)
            if not settings.enabled or not authorized(connection, event):
                return {"status": "ignored_by_policy", "reason": "source_disabled_or_out_of_scope"}
            reset = db.execute("SELECT value FROM config WHERE key='content_reset_at'").fetchone()
            if reset:
                import hashlib
                import json

                identity = hashlib.sha256(json.dumps(
                    [principal, event.conversation_id, event.message.id], ensure_ascii=False
                ).encode()).hexdigest()
                old = db.execute("SELECT 1 FROM reset_receipts WHERE identity=?", (identity,)).fetchone()
                if old or (event.occurred_at and event.occurred_at.timestamp() <= float(reset[0])):
                    return {"status": "ignored_by_policy", "reason": "content_reset"}
                if snapshot:
                    # After a reset only retain context observed since the reset.
                    known = {r[0] for r in db.execute(
                        "SELECT message_id FROM events WHERE connection_id=? AND conversation_id=?",
                        (principal, event.conversation_id),
                    )} | {event.message.id}
                    first_new = next((i for i, m in enumerate(snapshot.messages) if m.id in known), len(snapshot.messages))
                    snapshot = snapshot.model_copy(update={
                        "messages": snapshot.messages[first_new:],
                        "coverage": "partial" if first_new else snapshot.coverage,
                    })
            identity_payload = event.model_dump(mode="json", by_alias=True)
            identity_payload.pop("event_id")
            identity_payload.pop("occurred_at")
            fingerprint = digest(identity_payload)
            existing = db.execute(
                """SELECT * FROM events WHERE connection_id=? AND
                (external_id=? OR (conversation_id=? AND message_id=? AND revision=? AND event_type=?))""",
                (
                    principal,
                    event.event_id,
                    event.conversation_id,
                    event.message.id,
                    event.message.revision,
                    event.event_type,
                ),
            ).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise AgentServiceError(
                        "idempotency_conflict", "同一事件或消息版本对应不同内容。"
                    )
                return {
                    "status": "duplicate",
                    "event_id": existing["id"],
                    "job_status": existing["status"],
                }
            if (
                event.event_type != "message.submitted"
                and not connection.capabilities.message_revisions
            ):
                raise AgentServiceError("unsupported_event", "来源未声明消息版本能力。")
            previous = db.execute(
                """SELECT id,change_set_id,event_type FROM events
                WHERE connection_id=? AND conversation_id=? AND message_id=?""",
                (principal, event.conversation_id, event.message.id),
            ).fetchall()
            if previous and (
                event.event_type == "message.submitted"
                or any(old["event_type"] == "message.retracted" for old in previous)
            ):
                raise AgentServiceError("stale_event", "消息已更新或撤回，不能用迟到事件重新激活。")
            sensitive = bool(SECRET.search(event.message.text))
            ignored = (
                event.message.role != "user" or event.message.origin == "automation" or sensitive
            )
            if event.event_type != "message.retracted" and not event.message.learning_text.strip():
                ignored = True
            status = "completed" if ignored else "queued"
            outcome = "sensitive_content" if sensitive else ("ignored" if ignored else None)
            if event.event_type in {"message.revised", "message.retracted"}:
                for old in previous:
                    self._invalidate_group(old["change_set_id"], old["id"])
                    db.execute(
                        """UPDATE events SET status='cancelled',outcome='superseded',
                        lease=NULL,version=version+1,updated=? WHERE id=?""",
                        (time.time(), old["id"]),
                    )
                    db.execute(
                        "UPDATE observations SET status='superseded' WHERE event_id=?", (old["id"],)
                    )
                if event.event_type == "message.retracted":
                    status, outcome = "completed", "retracted"
            identifier = "learn_" + uuid.uuid4().hex
            db.execute(
                """INSERT INTO events(id,connection_id,external_id,conversation_id,
                message_id,revision,event_type,fingerprint,payload,snapshot,status,outcome,created,updated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    identifier,
                    principal,
                    event.event_id,
                    event.conversation_id,
                    event.message.id,
                    event.message.revision,
                    event.event_type,
                    fingerprint,
                    None if ignored else encoded(event),
                    None if ignored else self._snapshot(event, snapshot),
                    status,
                    outcome,
                    time.time(),
                    time.time(),
                ),
            )
            return {"status": "accepted", "event_id": identifier, "job_status": status}

    def _invalidate_group(self, change_set_id, event_id=None):
        from datetime import UTC, datetime

        facade = PersonaProposalFacade(self.data_root, self.state_root)
        group = (
            facade.change_sets.get(change_set_id)
            if change_set_id
            else facade.change_sets.by_idempotency_key("conversation-learning:" + str(event_id))
        )
        if group is None:
            return
        proposals = ProposalRepository(self.data_root)
        for link in group.proposal_links:
            value = proposals.get(link.proposal_id)
            if value.status in {"pending_review", "deferred"}:
                proposals.complete(
                    value.model_copy(
                        update={
                            "status": "stale",
                            "decision_source": "system",
                            "decision_reason": "来源消息已修改或撤回，请重新检查依据。",
                            "updated_at": datetime.now(UTC),
                            "decided_at": datetime.now(UTC),
                            "proposal_revision": value.proposal_revision + 1,
                        }
                    )
                )

    def get_event_status(self, identifier: str, principal: str) -> dict:
        row = self.repository.get(identifier)
        self._principal(row["connection_id"], principal)
        result = {
            key: row[key]
            for key in (
                "id",
                "connection_id",
                "status",
                "outcome",
                "error_code",
                "version",
                "created",
                "updated",
                "attempts",
                "change_set_id",
                "human_confirmed",
            )
        }
        result["observations"] = [
            {"id": o["id"], "status": o["status"], "signal": json.loads(o["value"])}
            for o in self.repository.observations(identifier)
        ]
        if row["payload"]:
            result["event"] = json.loads(row["payload"])
        result["origin_basis"] = json.loads(row["checkpoint"]).get("origin_basis")
        result["evaluation_result_id"] = json.loads(row["checkpoint"]).get("evaluation_result_id")
        if row["change_set_id"]:
            result["review"] = (
                PersonaProposalFacade(self.data_root, self.state_root)
                .get_status(row["change_set_id"])
                .model_dump(mode="json")
            )
        return result

    def attach_context(self, identifier: str, snapshot: ContextSnapshot, principal: str) -> dict:
        with self.repository.transaction() as db:
            row = self.repository.get(identifier, db)
            self._principal(row["connection_id"], principal)
            if row["status"] != "waiting_context" or row["payload"] is None:
                raise AgentServiceError("conflict", "只有等待上下文的事件可以补充快照。")
            event = ConversationEvent.model_validate_json(row["payload"])
            if not authorized(self.repository.connection(principal, db), event):
                raise AgentServiceError("forbidden", "来源已暂停或不再允许该范围。")
            value = self._snapshot(event, snapshot)
            checkpoint = json.loads(row["checkpoint"])
            checkpoint.pop("signal", None)
            checkpoint.pop("candidate", None)
            db.execute(
                """UPDATE events SET snapshot=?,checkpoint=?,status='queued',error_code=NULL,
                version=version+1,updated=? WHERE id=?""",
                (value, encoded(checkpoint), time.time(), identifier),
            )
        return {"event_id": identifier, "status": "queued"}

    def retry_job(
        self, identifier: str, expected_version: int, principal: str, *, confirm_human: bool = False
    ) -> dict:
        with self.repository.transaction() as db:
            row = self.repository.get(identifier, db)
            self._principal(row["connection_id"], principal)
            if row["version"] != expected_version or row["payload"] is None:
                raise AgentServiceError("conflict", "任务已更新或原文已清理，请刷新。")
            allowed = {"retryable_failed", "failed", "paused_budget", "paused", "waiting_origin"}
            if row["status"] not in allowed:
                raise AgentServiceError("conflict", "该任务当前不能重试。")
            if row["status"] == "waiting_origin" and not confirm_human:
                connection = self.repository.connection(principal, db)
                event = ConversationEvent.model_validate_json(row["payload"])
                if not authorized(connection, event) or not origin_basis(connection, event):
                    raise AgentServiceError(
                        "unknown_origin", "请在来源连接中开启信任来源，或仅确认本条为人工输入。"
                    )
            db.execute(
                """UPDATE events SET status='queued',error_code=NULL,version=version+1,
                human_confirmed=max(human_confirmed,?),updated=? WHERE id=?""",
                (int(confirm_human), time.time(), identifier),
            )
        return {"event_id": identifier, "status": "queued"}

    def cancel(self, identifier: str, expected_version: int, principal: str):
        with proposal_lock(self.state_root), self.repository.transaction() as db:
            row = self.repository.get(identifier, db)
            self._principal(row["connection_id"], principal)
            if row["version"] != expected_version:
                raise AgentServiceError("conflict", "任务已更新，请刷新。")
            self._invalidate_group(row["change_set_id"], row["id"])
            db.execute(
                """UPDATE events SET status='cancelled',lease=NULL,version=version+1,
                updated=? WHERE id=?""",
                (time.time(), identifier),
            )
            db.execute("UPDATE observations SET status='dismissed' WHERE event_id=?", (identifier,))
        return {"event_id": identifier, "status": "cancelled"}

    def cleanup(self):
        """Forget transient inputs even after submission; keep proposals and short notes."""
        with self.repository.transaction() as db:
            settings = self.repository.settings(db)
            observations_cutoff = time.time() - settings.observation_retention_days * 86400
            events_cutoff = time.time() - settings.event_retention_days * 86400
            eligible = "status NOT IN ('running','queued')"
            db.execute(
                f"""DELETE FROM observations WHERE event_id IN
                (SELECT id FROM events WHERE {eligible} AND created<?)""",
                (observations_cutoff,),
            )
            result = db.execute(
                f"""UPDATE events SET payload=NULL,snapshot=NULL,checkpoint='{{}}',
                outcome=CASE WHEN change_set_id IS NULL THEN 'expired' ELSE outcome END,
                status=CASE WHEN change_set_id IS NULL THEN 'completed' ELSE status END,
                version=version+1 WHERE {eligible}
                AND payload IS NOT NULL AND created<? AND id NOT IN
                (SELECT event_id FROM observations)""",
                (events_cutoff,),
            )
        return {"expired_events": result.rowcount}
