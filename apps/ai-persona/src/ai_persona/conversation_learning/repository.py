"""Machine-local durable inbox, stage checkpoints and bounded model reservations."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from ..agent import AgentServiceError
from .contracts import ConversationEvent, LearningSettings, SourceConnection, digest, encoded
from .policy import authorized, origin_basis


class LearningRepository:
    def __init__(self, data_root: Path, directory: Path | None = None):
        base = Path(
            os.environ.get(
                "AI_PERSONA_LEARNING_DIR", str(Path.home() / ".local/share/ai-persona/learning")
            )
        )
        # Different checkouts, even those sharing a persona_id, must not share a worker.
        self.directory = directory or base / digest(str(data_root.resolve()))[:32]
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.path = self.directory / "conversation-learning.sqlite3"
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in {0, 1}:
                raise ValueError("对话学习数据库版本不支持，请升级程序。")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS connections (
                    id TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, external_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, revision TEXT NOT NULL,
                    event_type TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT,
                    snapshot TEXT, status TEXT NOT NULL, outcome TEXT, error_code TEXT,
                    version INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, updated REAL NOT NULL,
                    lease TEXT, lease_until REAL, attempts INTEGER NOT NULL DEFAULT 0,
                    checkpoint TEXT NOT NULL DEFAULT '{}', change_set_id TEXT,
                    human_confirmed INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(connection_id, external_id),
                    UNIQUE(connection_id, conversation_id, message_id, revision, event_type)
                );
                CREATE INDEX IF NOT EXISTS event_jobs ON events(status, created);
                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, signal_id TEXT NOT NULL,
                    value TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                    UNIQUE(event_id, signal_id)
                );
                CREATE TABLE IF NOT EXISTS model_calls (
                    id TEXT PRIMARY KEY, day TEXT NOT NULL, task TEXT NOT NULL,
                    reserved_tokens INTEGER NOT NULL, actual_tokens INTEGER, created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS diagnostics (
                    id INTEGER PRIMARY KEY, connection_id TEXT, code TEXT NOT NULL, created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS setup_checks (
                    connection_id TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                PRAGMA user_version=1;
            """)
            db.execute(
                "INSERT OR IGNORE INTO config VALUES ('settings', ?)",
                (encoded(LearningSettings()),),
            )
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=0.15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            yield db

    def settings(self, db=None) -> LearningSettings:
        if db is None:
            with self.connect() as db:
                return self.settings(db)
        return LearningSettings.model_validate_json(
            db.execute("SELECT value FROM config WHERE key='settings'").fetchone()[0]
        )

    def save_settings(self, value: LearningSettings):
        with self.transaction() as db:
            db.execute("UPDATE config SET value=? WHERE key='settings'", (encoded(value),))

    def connection(self, identifier: str, db=None) -> SourceConnection:
        if db is None:
            with self.connect() as db:
                return self.connection(identifier, db)
        row = db.execute("SELECT value FROM connections WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise AgentServiceError("not_found", "来源连接不存在。")
        return SourceConnection.model_validate_json(row[0])

    def connections(self):
        with self.connect() as db:
            return [
                SourceConnection.model_validate_json(row[0])
                for row in db.execute("SELECT value FROM connections ORDER BY id")
            ]

    def save_connection(self, value: SourceConnection, *, expected_revision: str | None = None) -> int:
        with self.transaction() as db:
            current = db.execute("SELECT value FROM connections WHERE id=?", (value.id,)).fetchone()
            if expected_revision is not None:
                actual = digest(json.loads(current[0])) if current else ""
                if actual != expected_revision:
                    raise AgentServiceError("conflict", "接入设置已变化，请重新打开后再保存。")
            if current:
                previous = SourceConnection.model_validate_json(current[0])
                if previous.adapter != value.adapter:
                    raise AgentServiceError("conflict", "不能改变既有连接的平台类型，请新建连接。")
            db.execute(
                """INSERT INTO connections(id,value) VALUES (?,?)
                ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=version+1""",
                (value.id, encoded(value)),
            )
            # Resume only this source's still-valid waiting inputs. Preserve stage
            # checkpoints and actual provenance; do not revive cancelled/failed jobs.
            resumed = 0
            if value.enabled and value.trust_user_messages:
                waiting = db.execute(
                    "SELECT id,payload FROM events WHERE connection_id=? "
                    "AND status='waiting_origin' AND payload IS NOT NULL",
                    (value.id,),
                ).fetchall()
                for row in waiting:
                    event = ConversationEvent.model_validate_json(row["payload"])
                    if not authorized(value, event) or not origin_basis(value, event):
                        continue
                    db.execute(
                        """UPDATE events SET status='queued',outcome=NULL,error_code=NULL,
                        lease=NULL,lease_until=NULL,version=version+1,updated=? WHERE id=?""",
                        (time.time(), row["id"]),
                    )
                    db.execute(
                        "UPDATE observations SET status='new' "
                        "WHERE event_id=? AND status='waiting_origin'",
                        (row["id"],),
                    )
                    resumed += 1
            return resumed

    def get(self, identifier: str, db=None) -> dict:
        if db is None:
            with self.connect() as db:
                return self.get(identifier, db)
        row = db.execute("SELECT * FROM events WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise AgentServiceError("not_found", "学习事件不存在。")
        return dict(row)

    def recent(self, limit=100):
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM events ORDER BY created DESC LIMIT ?", (min(limit, 100),)
                )
            ]

    def external_receipt(self, connection_id, external_id):
        with self.connect() as db:
            row = db.execute(
                "SELECT id,status FROM events WHERE connection_id=? AND external_id=?",
                (connection_id, external_id),
            ).fetchone()
        return {"status": "duplicate", "event_id": row["id"], "job_status": row["status"]} if row else None

    def diagnostic(self, connection_id: str | None, code: str):
        with self.transaction() as db:
            db.execute(
                "INSERT INTO diagnostics(connection_id,code,created) VALUES (?,?,?)",
                (connection_id, code[:100], time.time()),
            )
            db.execute(
                "DELETE FROM diagnostics WHERE id NOT IN "
                "(SELECT id FROM diagnostics ORDER BY id DESC LIMIT 100)"
            )

    def claim(self, token: str) -> dict | None:
        with self.transaction() as db:
            settings = self.settings(db)
            if not settings.enabled or not settings.allow_model_calls:
                return None
            # Expired workers cannot write using their old fencing token.
            db.execute(
                """UPDATE events SET status='queued',lease=NULL,lease_until=NULL,
                version=version+1 WHERE status='running' AND lease_until < ?""",
                (time.time(),),
            )
            row = db.execute("""SELECT e.* FROM events e
                WHERE e.status='queued' AND e.payload IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM events active WHERE active.status='running'
                    AND active.connection_id=e.connection_id
                    AND active.conversation_id=e.conversation_id)
                ORDER BY e.created LIMIT 1""").fetchone()
            if row is None:
                return None
            checkpoint = json.loads(row["checkpoint"])
            checkpoint.pop("evaluation_result_id", None)
            db.execute(
                """UPDATE events SET status='running',lease=?,lease_until=?,
                attempts=attempts+1,version=version+1,updated=?,checkpoint=? WHERE id=?""",
                (token, time.time() + 600, time.time(), encoded(checkpoint), row["id"]),
            )
            return self.get(row["id"], db)

    def fenced_update(self, identifier: str, token: str, **updates):
        allowed = {"status", "outcome", "error_code", "checkpoint", "snapshot", "change_set_id"}
        if not updates or set(updates) - allowed:
            raise ValueError("invalid job update")
        with self.transaction() as db:
            result = db.execute(
                "UPDATE events SET "
                + ",".join(f"{key}=?" for key in updates)
                + ",updated=?,version=version+1 WHERE id=? AND lease=? AND status='running'",
                (*updates.values(), time.time(), identifier, token),
            )
            if result.rowcount != 1:
                raise AgentServiceError("cancelled", "任务已停止或被较新的任务接管。")

    def heartbeat(self, identifier: str, token: str):
        with self.transaction() as db:
            return db.execute(
                """UPDATE events SET lease_until=? WHERE id=?
                AND lease=? AND status='running'""",
                (time.time() + 600, identifier, token),
            ).rowcount

    def reserve_call(self, call_id: str, task: str, tokens: int):
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self.transaction() as db:
            settings = self.settings(db)
            if not settings.enabled or not settings.allow_model_calls:
                raise AgentServiceError("paused", "学习或模型外发已暂停。")
            used = db.execute(
                """SELECT count(*),coalesce(sum(
                coalesce(actual_tokens,reserved_tokens)),0) FROM model_calls WHERE day=?""",
                (day,),
            ).fetchone()
            if used[0] >= settings.daily_calls or used[1] + tokens > settings.daily_tokens:
                raise AgentServiceError("paused_budget", "已达到每日学习模型预算。")
            db.execute(
                "INSERT INTO model_calls VALUES (?,?,?,?,NULL,?)",
                (call_id, day, task, tokens, time.time()),
            )

    def finish_call(self, call_id: str, actual_tokens: int | None):
        if isinstance(actual_tokens, int) and actual_tokens >= 0:
            with self.transaction() as db:
                db.execute(
                    "UPDATE model_calls SET actual_tokens=? WHERE id=?", (actual_tokens, call_id)
                )

    def observations(self, identifier: str):
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM observations WHERE event_id=? ORDER BY id", (identifier,)
                )
            ]

    def save_observations(self, identifier: str, token: str, signals):
        with self.transaction() as db:
            row = self.get(identifier, db)
            if row["status"] != "running" or row["lease"] != token:
                raise AgentServiceError("cancelled", "任务已停止。")
            for signal in signals:
                db.execute(
                    """INSERT INTO observations VALUES (?,?,?,?,?,?)
                    ON CONFLICT(event_id,signal_id) DO UPDATE SET value=excluded.value""",
                    (
                        "obs_" + digest([identifier, signal.id])[:32],
                        identifier,
                        signal.id,
                        encoded(signal),
                        "new",
                        time.time(),
                    ),
                )

    def mark_observations(self, identifier: str, status: str):
        with self.transaction() as db:
            db.execute("UPDATE observations SET status=? WHERE event_id=?", (status, identifier))

    def health(self):
        with self.connect() as db:
            counts = dict(db.execute("SELECT status,count(*) FROM events GROUP BY status"))
            diagnostics = [
                dict(row)
                for row in db.execute(
                    "SELECT connection_id,code,created FROM diagnostics ORDER BY id DESC LIMIT 10"
                )
            ]
        return {"counts": counts, "diagnostics": diagnostics}
