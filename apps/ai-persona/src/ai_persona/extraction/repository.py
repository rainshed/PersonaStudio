"""Durable task checkpoints shared by Studio and the task-scoped MCP process."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from ..agent import AgentServiceError
from .contracts import Policy


def now():
    return time.time()


def event(task, kind, message, **details):
    task["events"].append({"at": now(), "kind": kind, "message": message, **details})
    task["events"] = task["events"][-300:]


class Repository:
    def __init__(self, state_root: Path):
        self.root = Path(state_root) / "extraction"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "tasks.sqlite3"
        with self.connect() as db:
            db.executescript(
                "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL);"
            )

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute("PRAGMA journal_mode=WAL")
        return db

    def policy(self):
        with self.connect() as db:
            row = db.execute("SELECT body FROM settings WHERE id=1").fetchone()
        return Policy.model_validate_json(row[0]) if row else Policy()

    def save_policy(self, policy):
        value = Policy.model_validate(policy)
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (1,?)", (value.model_dump_json(),))
        return value.model_dump()

    def create(self, policy=None):
        task = dict(
            id="extract_" + uuid.uuid4().hex,
            revision=1,
            status="draft",
            policy=Policy.model_validate(policy or self.policy().model_dump()).model_dump(),
            members=[],
            ledger={
                "records": {},
                "basis": {},
                "coverage": {},
                "material_metadata": {},
                "allow_unspecified_relationship": True,
            },
            events=[],
            draft=None,
            submissions=[],
            run_id=None,
            phase=None,
            error=None,
            created_at=now(),
            updated_at=now(),
            owner_pid=None,
            persona_revision=None,
        )
        event(
            task,
            "created",
            f"材料集合已创建；新增知识点上限 {task['policy']['max_nodes']}。",
            max_nodes=task["policy"]["max_nodes"],
        )
        with self.connect() as db:
            db.execute(
                "INSERT INTO tasks VALUES (?,?)", (task["id"], json.dumps(task, ensure_ascii=False))
            )
        return task

    def get(self, task_id):
        with self.connect() as db:
            row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise AgentServiceError("not_found", "找不到此材料整理任务。")
        return json.loads(row[0])

    def list(self):
        with self.connect() as db:
            rows = db.execute("SELECT body FROM tasks ORDER BY rowid DESC LIMIT 100").fetchall()
        return [json.loads(row[0]) for row in rows]

    @contextmanager
    def edit(self, task_id, *, run_id=None, revision=None):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT body FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise AgentServiceError("not_found", "找不到此材料整理任务。")
            task = json.loads(row[0])
            if run_id is not None and (task["run_id"] != run_id or task["status"] != "running"):
                raise AgentServiceError("cancelled", "此轮整理已停止，进度已保留。")
            if revision is not None and task["revision"] != revision:
                raise AgentServiceError("version_changed", "材料集合已改变，请刷新后重试。")
            yield task
            task["updated_at"] = now()
            db.execute(
                "UPDATE tasks SET body=? WHERE id=?",
                (json.dumps(task, ensure_ascii=False), task_id),
            )
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def recover(self):
        for task in self.list():
            if task["status"] not in {"running", "importing"}:
                continue
            try:
                os.kill(task.get("owner_pid") or 0, 0)
            except ProcessLookupError:
                with self.edit(task["id"]) as current:
                    current.update(
                        status="paused",
                        run_id=None,
                        error="Studio 上次运行已中断；已保存的分析可继续。",
                    )
                    event(current, "paused", current["error"])
