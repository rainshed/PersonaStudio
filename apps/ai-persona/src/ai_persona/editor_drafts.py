"""Workspace-local editor drafts with optimistic versions and deletion tombstones."""

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .agent import AgentServiceError


class EditorDrafts:
    def __init__(self, state_root):
        self.path = state_root / "editor-drafts.sqlite3"
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS drafts (
                id TEXT PRIMARY KEY, page TEXT NOT NULL, revision INTEGER NOT NULL,
                baseline TEXT NOT NULL, fields TEXT NOT NULL, updated TEXT NOT NULL,
                closed INTEGER NOT NULL DEFAULT 0)""")

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def list(self, page):
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM drafts WHERE page=? AND closed=0 ORDER BY updated DESC", (page,)
            ).fetchall()
        return [{**dict(r), "fields": json.loads(r["fields"])} for r in rows]

    def save(self, value):
        identifier, page = value.get("id", ""), value.get("page", "")
        revision = value.get("revision")
        fields = value.get("fields", {})
        baseline = value.get("baseline", "")
        if (
            not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", identifier)
            or not re.fullmatch(
                r"/(?:knowledge|courses|materials|preferences|ai|extract)(?:[/?].*)?", page
            )
            or len(page) > 1000
            or type(revision) is not int
            or revision < 0
            or not isinstance(fields, dict)
            or len(fields) > 10000
            or not isinstance(baseline, str)
            or len(baseline) > 100
        ):
            raise AgentServiceError("invalid_request", "无效的编辑草稿。")
        for key, items in fields.items():
            if (
                not isinstance(key, str)
                or len(key) > 200
                or re.search(
                    r"password|api.?key|secret|credential|token|authorization|(?:^|[-_])auth(?:$|[-_])",
                    key,
                    re.I,
                )
                or not isinstance(items, list)
                or any(not isinstance(x, (str, bool)) for x in items)
            ):
                raise AgentServiceError("invalid_request", "草稿字段无效；账号凭据不保存为草稿。")
        encoded = json.dumps(fields, ensure_ascii=False)
        if len(encoded.encode()) > 1_000_000:
            raise AgentServiceError("input_limit", "草稿内容过大，请分段保存。")
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM drafts WHERE id=?", (identifier,)).fetchone()
            if old and (old["closed"] or old["revision"] != revision):
                raise AgentServiceError("conflict", "草稿已变化，请保留输入并重新打开编辑页面。")
            if not old and revision:
                raise AgentServiceError("conflict", "草稿不存在，请保留当前输入。")
            db.execute(
                """INSERT INTO drafts VALUES (?,?,?,?,?,?,0)
                ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
                fields=excluded.fields,page=excluded.page,updated=excluded.updated""",
                (identifier, page, revision + 1, baseline, encoded, now),
            )
        return {"id": identifier, "revision": revision + 1, "updated": now}

    def close(self, identifier, revision=None):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", identifier):
            raise AgentServiceError("invalid_request", "无效的草稿标识。")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if revision is not None:
                current = db.execute(
                    "SELECT revision FROM drafts WHERE id=?", (identifier,)
                ).fetchone()
                if current and current["revision"] != revision:
                    raise AgentServiceError("conflict", "原草稿有更新，已保留，请重新查看。")
            # Also close an as-yet-unseen id: an in-flight save cannot resurrect it.
            db.execute(
                """INSERT INTO drafts VALUES (?, '', 1, '', '{}', '', 1)
                ON CONFLICT(id) DO UPDATE SET closed=1,fields='{}',revision=revision+1""",
                (identifier,),
            )


def mount_draft_routes(app, state_root):
    from fastapi import Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool

    from .ai_web import check_request, failure, input_json

    repository = EditorDrafts(state_root)
    app.state.editor_drafts = repository

    @app.get("/api/studio/editor-drafts")
    async def drafts(request: Request):
        try:
            check_request(request)
            return JSONResponse(
                {
                    "items": await run_in_threadpool(
                        repository.list, request.query_params.get("page", "")
                    )
                },
                headers={"Cache-Control": "no-store"},
            )
        except Exception as exc:
            return failure(exc)

    @app.post("/api/studio/editor-drafts")
    async def save(request: Request):
        try:
            value = await input_json(request)
            if value.get("action") == "close":
                await run_in_threadpool(
                    repository.close, value.get("id", ""), value.get("revision")
                )
                return {"ok": True}
            return await run_in_threadpool(repository.save, value)
        except Exception as exc:
            return failure(exc)
