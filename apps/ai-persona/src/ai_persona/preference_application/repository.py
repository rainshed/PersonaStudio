"""Local settings and immutable turn snapshots with compare-and-set completion."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import contextmanager

from pydantic import BaseModel, ConfigDict, Field

from ..agent import AgentServiceError


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class ApplicationSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool = False
    connection_ids: list[str] = Field(default_factory=list, max_length=100)
    timeout_seconds: float = Field(default=5.0, ge=1, le=60)
    max_context_bytes: int = Field(default=24000, ge=1000, le=100000)


class ApplicationRepository:
    def __init__(self, state_root):
        self.path = state_root / "preference-applications.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS applications (
                    id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL,
                    created REAL NOT NULL, body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS applications_created ON applications(created DESC);
            """)
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=0.15)
        try:
            with db:
                yield db
        finally:
            db.close()

    def settings(self):
        with self.connect() as db:
            row = db.execute("SELECT body FROM settings WHERE id=1").fetchone()
        return ApplicationSettings.model_validate_json(row[0]) if row else ApplicationSettings()

    def save_settings(self, value):
        with self.connect() as db:
            db.execute("INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
                       (value.model_dump_json(),))

    def claim(self, identity, request, settings, *, started_at=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT body FROM applications WHERE identity=?", (identity,)).fetchone()
            if row:
                return json.loads(row[0]), False
            created = time.time() if started_at is None else started_at
            value = {
                "id": "application_" + uuid.uuid4().hex,
                "created_at": created, "updated_at": created,
                "deadline": created + settings.timeout_seconds,
                "status": "running", "decision_state": "running",
                "request": request, "settings": settings.model_dump(),
                "activation": None, "result_id": None, "payload": None,
                "error_code": None, "duration_ms": None,
            }
            db.execute("INSERT INTO applications VALUES (?,?,?,?)",
                       (value["id"], identity, created, encoded(value)))
        return value, True

    def get(self, identifier):
        with self.connect() as db:
            row = db.execute("SELECT body FROM applications WHERE id=?", (identifier,)).fetchone()
        if not row:
            raise AgentServiceError("not_found", "偏好应用记录不存在。")
        return json.loads(row[0])

    def update(self, identifier, updates, *, expected=("running",)):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT body FROM applications WHERE id=?", (identifier,)).fetchone()
            if not row:
                raise AgentServiceError("not_found", "偏好应用记录不存在。")
            value = json.loads(row[0])
            if value["status"] not in expected:
                return value
            value.update(updates, updated_at=time.time())
            if value["status"] != "running":
                value["duration_ms"] = round((time.time() - value["created_at"]) * 1000)
            db.execute("UPDATE applications SET body=? WHERE id=?", (encoded(value), identifier))
        return value

    def recent(self, offset=0, limit=30):
        with self.connect() as db:
            rows = db.execute("SELECT body FROM applications ORDER BY created DESC LIMIT ? OFFSET ?",
                              (min(100, max(1, limit)), max(0, offset))).fetchall()
            total = db.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
        return [json.loads(row[0]) for row in rows], total
