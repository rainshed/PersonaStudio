"""Shared write gate and recoverable local content transactions."""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from contextvars import ContextVar
from pathlib import Path

from .agent import AgentServiceError

OWNER = ContextVar("persona_reset_owner", default=False)


@contextmanager
def content_access(state):
    if OWNER.get():
        yield
        return
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True)
    with (state / "content-access.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            if (state / "content-reset.active").exists():
                raise BlockingIOError()
        except BlockingIOError as exc:
            raise AgentServiceError("reset_busy", "正在清理内容，请稍后重试。") from exc
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


@contextmanager
def reset_operation(state):
    state = Path(state)
    state.mkdir(parents=True, exist_ok=True)
    with (state / "content-reset.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise AgentServiceError("reset_busy", "已有清理操作正在进行。") from exc
        _recover(state)
        token = OWNER.set(True)
        marker = state / "content-reset.active"
        marker.touch()
        try:
            yield
        finally:
            if not (state / "content-reset.json").exists():
                marker.unlink(missing_ok=True)
            OWNER.reset(token)


@contextmanager
def exclusive_content(state):
    with (Path(state) / "content-access.lock").open("a+b") as lock:
        deadline = time.monotonic() + 20
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise AgentServiceError(
                        "busy", "仍有保存操作未完成，尚未清理内容，请稍后重试。"
                    )
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def write_json(path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as f:
        json.dump(value, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def copy_db(source, target):
    with closing(sqlite3.connect(source)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)


class ContentTransaction:
    def __init__(self, state):
        self.state = Path(state)
        self.root = self.state / (".content-reset-" + uuid.uuid4().hex)
        self.root.mkdir(mode=0o700)
        self.journal = self.state / "content-reset.json"
        self.value = {"root": str(self.root), "entries": [], "committed": False}
        self.seen = set()
        write_json(self.journal, self.value)

    def capture(self, path, *, database=False):
        path = Path(path)
        if path in self.seen:
            return
        if path.is_symlink():
            raise AgentServiceError("invalid_path", "清理范围包含符号链接，请先检查数据目录。")
        saved = self.root / str(len(self.seen))
        exists = path.exists()
        if exists:
            if database:
                copy_db(path, saved)
            elif path.is_dir():
                shutil.copytree(path, saved, symlinks=True)
            else:
                shutil.copy2(path, saved)
        self.value["entries"].append(
            {"path": str(path), "saved": str(saved), "exists": exists, "database": database}
        )
        self.seen.add(path)
        write_json(self.journal, self.value)

    def delete(self, path):
        self.capture(path)
        remove(Path(path))

    def clear_table(self, path, tables):
        path = Path(path)
        if not path.exists():
            return
        self.capture(path, database=True)
        with sqlite3.connect(path) as db:
            available = {
                row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            for table in tables:
                if table in available:
                    db.execute('DELETE FROM "' + table + '"')

    def commit(self):
        self.value["committed"] = True
        write_json(self.journal, self.value)
        # The durable commit is authoritative even if temporary cleanup is interrupted.
        try:
            shutil.rmtree(self.root)
            self.journal.unlink()
        except OSError:
            pass

    def rollback(self):
        _recover(self.state)


def _recover(state):
    journal = state / "content-reset.json"
    if not journal.exists():
        return
    value = json.loads(journal.read_text())
    if not value["committed"]:
        for entry in reversed(value["entries"]):
            path, saved = Path(entry["path"]), Path(entry["saved"])
            if entry["exists"] and entry["database"]:
                copy_db(saved, path)
            else:
                remove(path)
                if entry["exists"]:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if saved.is_dir():
                        shutil.copytree(saved, path, symlinks=True)
                    else:
                        shutil.copy2(saved, path)
    shutil.rmtree(value["root"], ignore_errors=True)
    journal.unlink(missing_ok=True)


def recover(state):
    state = Path(state)
    if OWNER.get() or not state.exists():
        return
    # A live reset owns this lock; never mistake it for an interrupted one.
    with (state / "content-reset.lock").open("a+b") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        _recover(state)
        (state / "content-reset.active").unlink(missing_ok=True)
