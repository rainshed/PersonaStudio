"""Preview and clear content while retaining application configuration."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from collections import Counter
from contextlib import closing
from pathlib import Path

from .agent import AgentServiceError
from .change_sets import proposal_lock
from .compiler import PersonaCompiler
from .conversation_learning.repository import LearningRepository
from .extraction.repository import Repository
from .proposals import ProposalRepository, record_content_hash
from .reset_storage import ContentTransaction, exclusive_content, reset_operation
from .store import PersonaStore


def rows(path, table, column="body"):
    if not path.exists():
        return []
    with closing(sqlite3.connect(path)) as db:
        return [json.loads(r[0]) for r in db.execute(f"SELECT {column} FROM {table}")]


def journal_entries(data):
    path = data / "revisions/changes.jsonl"
    return (
        [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        if path.exists()
        else []
    )


def record_title(loaded, records):
    record = loaded.record
    if record.entity_type == "relation":
        source, target = records.get(record.source_id), records.get(record.target_id)
        return f"{getattr(source.record, 'title', record.source_id) if source else record.source_id} → {getattr(target.record, 'title', record.target_id) if target else record.target_id}"
    return getattr(record, "title", record.id)


class ContentReset:
    def __init__(self, data, state, app=None):
        self.data, self.state, self.app = Path(data), Path(state), app
        self.learning = LearningRepository(self.data)
        self.tasks = Repository(self.state)

    def plan(self, task_id=None):
        store = PersonaStore(self.data).load()
        repo = ProposalRepository(self.data)
        proposals = [*repo.list_pending(), *repo.list_history(limit=None)]
        tasks = rows(self.tasks.path, "tasks")
        protected, groups, ids = {}, set(), set()
        if task_id:
            task = self.tasks.get(task_id)
            submissions = [
                *task["submissions"],
                *(s for h in task.get("history", []) for s in h.get("submissions", [])),
            ]
            groups = {s["change_set_id"] for s in submissions}
            ids = {p["proposal_id"] for s in submissions for p in s["proposals"]}
            owned = [p for p in proposals if p.id in ids]
            published = {}
            created_evidence = set()
            for entry in journal_entries(self.data):
                if set(entry.get("proposal_ids", [])) & ids:
                    for change in entry.get("changes", []):
                        rid = change["object_id"]
                        published[rid] = change.get("new_hash")
                        if (
                            change.get("old_hash") is None
                            and rid in store.records
                            and store.records[rid].record.entity_type == "evidence"
                        ):
                            created_evidence.add(rid)
            remove = set()
            for p in owned:
                loaded = store.records.get(p.target_id)
                if not loaded:
                    continue
                if p.operation not in {"create", "relate"}:
                    protected[p.target_id] = "这是对已有内容的修改，不自动撤销。"
                elif p.status == "edited_and_accepted" or published.get(
                    p.target_id
                ) != record_content_hash(loaded):
                    protected[p.target_id] = "审核时或之后已被修改，予以保留。"
                else:
                    remove.add(p.target_id)
            remove -= protected.keys()
            remove |= {
                rid
                for rid in created_evidence
                if published[rid] == record_content_hash(store.records[rid])
                and set(store.records[rid].record.supports) <= remove
            }
            # Never delete endpoints or evidence still referenced by other content.
            outside = [
                json.dumps(p.model_dump(mode="json"), ensure_ascii=False)
                for p in proposals
                if p.id not in ids
            ]
            outside += [json.dumps(t, ensure_ascii=False) for t in tasks if t["id"] != task_id]
            evaluation = self.data / "evaluations"
            if evaluation.exists():
                outside += [p.read_text() for p in evaluation.rglob("*.json")]
            changed = True
            while changed:
                changed = False
                refs = outside + [
                    json.dumps(v.record.model_dump(mode="json"), ensure_ascii=False)
                    for rid, v in store.records.items()
                    if rid not in remove
                ]
                for rid in list(remove):
                    if any('"' + rid + '"' in text for text in refs):
                        remove.remove(rid)
                        protected[rid] = "被其他记录、提案或任务引用，予以保留。"
                        changed = True
            selected = [p for p in proposals if p.id in ids]
        else:
            remove = set(store.records)
            selected = proposals
            groups = {p.stem for p in (self.data / "proposals/change-sets").glob("*.json")}
            ids = {p.id for p in proposals}
        counts = dict(Counter(store.records[rid].record.entity_type for rid in remove))
        editor_versions = []
        editor_path = self.state / "editor-drafts.sqlite3"
        if not task_id and editor_path.is_file():
            with closing(sqlite3.connect(editor_path)) as db:
                editor_versions = db.execute("SELECT id,revision FROM drafts WHERE closed=0 ORDER BY id").fetchall()
        state_counts = {
            "editor_drafts": len(editor_versions),
            "extraction_tasks": len(tasks) if not task_id else 1,
            "assistant_sessions": len(rows(self.state / "ai-assistant.sqlite3", "drafts"))
            if not task_id
            else 0,
        }
        with self.learning.connect() as db:
            learning_events = [r[0] for r in db.execute("SELECT id FROM events ORDER BY id")]
        state_counts["learning_events"] = len(learning_events) if not task_id else 0
        state_counts["evaluation_files"] = (
            sum(1 for _ in (self.data / "evaluations").rglob("*.json")) if not task_id else 0
        )
        signature = {
            "editor_drafts": editor_versions,
            "learning_events": learning_events,
            "assistant_ids": sorted(
                t["id"] for t in rows(self.state / "ai-assistant.sqlite3", "drafts")
            ),
            "evaluation_files": sorted(
                (str(p), hashlib.sha256(p.read_bytes()).hexdigest())
                for p in (self.data / "evaluations").rglob("*.json")
            ),
            "revision": store.config.revision,
            "records": sorted((k, record_content_hash(v)) for k, v in store.records.items()),
            "proposals": sorted(
                (p.id, hashlib.sha256(p.model_dump_json().encode()).hexdigest()) for p in proposals
            ),
            "task": task_id,
            "tasks": sorted(
                (
                    t["id"],
                    t["revision"],
                    t.get("draft"),
                    t.get("ledger"),
                    t.get("submissions"),
                    t.get("history"),
                )
                for t in tasks
            ),
            "sources": sorted((k, v.content_hash) for k, v in store.sources.items()),
            "delete": sorted(remove),
            "preserve": sorted(protected),
        }
        return {
            "mode": "batch" if task_id else "all",
            "task_id": task_id,
            "revision": store.config.revision,
            "token": hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest(),
            "counts": counts,
            "proposal_count": len(selected),
            "source_count": 0 if task_id else len(store.sources),
            **state_counts,
            "protected": [
                {
                    "id": rid,
                    "title": record_title(store.records[rid], store.records),
                    "reason": reason,
                }
                for rid, reason in protected.items()
                if store.records[rid].record.entity_type != "evidence"
            ],
            "record_ids": sorted(remove),
            "proposal_ids": sorted(ids),
            "group_ids": sorted(groups),
        }

    def stop_jobs(self):
        from .conversation_learning.service import ConversationLearningService
        from .conversation_learning.worker import stop_worker, worker_status

        learning = ConversationLearningService(self.data, self.state, repository=self.learning)
        worker_was_running = worker_status(self.learning)["running"]
        if worker_was_running:
            stop_worker(learning)
        if self.app:
            service = self.app.state.extraction_service
            for t in rows(self.tasks.path, "tasks"):
                if t["status"] == "running":
                    service.cancel(t["id"])
            ai = self.app.state.ai_service
            for item in rows(self.state / "ai-assistant.sqlite3", "drafts"):
                if item["status"] == "running":
                    ai.cancel(item["id"], item["version"])
            evaluations = getattr(self.app.state, "evaluations", None)
            runner = evaluations._runner if evaluations else None
            if runner:
                for rid in list(runner.active):
                    runner.cancel(rid)
            deadline = time.monotonic() + 20
            while (
                getattr(self.app.state, "extraction_jobs", {})
                or getattr(self.app.state, "ai_jobs", {})
                or (runner and runner.active)
            ):
                if time.monotonic() > deadline:
                    raise AgentServiceError(
                        "busy", "已请求停止任务，但任务尚未退出，内容未清理。请稍后重试。"
                    )
                time.sleep(0.05)
        deadline = time.monotonic() + 20
        while worker_status(self.learning)["running"]:
            if time.monotonic() > deadline:
                raise AgentServiceError(
                    "busy", "已请求停止自动学习，但尚未退出，内容未清理。请稍后重试。"
                )
            time.sleep(0.05)
        return worker_was_running

    def apply(self, *, token, task_id=None, backup=False):
        from .conversation_learning.service import ConversationLearningService
        from .conversation_learning.worker import start_worker

        worker = False
        result = None
        try:
            with reset_operation(self.state):
                if self.plan(task_id)["token"] != token:
                    raise AgentServiceError("changed", "内容已变化，请重新预览后再确认。")
                worker = self.stop_jobs()
                with exclusive_content(self.state), proposal_lock(self.state):
                    plan = self.plan(task_id)
                    if plan["token"] != token:
                        raise AgentServiceError(
                            "changed", "任务停止期间产生了新结果，请重新预览后再确认。"
                        )
                    result = self._execute(plan, backup)
        finally:
            if worker:
                try:
                    start_worker(
                        ConversationLearningService(self.data, self.state, repository=self.learning)
                    )
                except Exception:
                    if result is not None:
                        result["message"] += " 自动学习尚未恢复，请在设置中重新启动。"
        return result

    def _execute(self, plan, backup):
        tx = ContentTransaction(self.state)
        backup_path = None
        try:
            # Snapshot all data paths touched by compilation and publication before mutation.
            for name in [
                "records",
                "sources",
                "proposals",
                "revisions",
                "generated",
                "config/persona.toml",
                "evaluations",
            ]:
                tx.capture(self.data / name)
            for path in [
                self.state / "persona.sqlite3",
                self.tasks.path,
                self.state / "ai-assistant.sqlite3",
                self.state / "editor-drafts.sqlite3",
                self.state / "material-handoffs.sqlite3",
                self.state / "preference-applications.sqlite3",
                self.learning.path,
            ]:
                if path.exists():
                    tx.capture(path, database=True)
            caches = [
                "query-documents",
                "material-analysis",
                "material-imports",
                "evaluations",
                "extraction/runtime",
                "extraction/pdf",
            ]
            if plan["mode"] == "all":
                for name in caches:
                    tx.capture(self.state / name)
            if plan["task_id"]:
                tx.capture(self.state / "extraction/runtime" / plan["task_id"])
            if backup:
                folder = self.state.parent / "backups"
                folder.mkdir(parents=True, exist_ok=True)
                backup_path = folder / (
                    "persona-content-"
                    + time.strftime("%Y%m%d-%H%M%S")
                    + "-"
                    + uuid.uuid4().hex[:6]
                    + ".tar.gz"
                )
                from .backup import backup_quiesced

                backup_quiesced(self.data, self.state, self.learning.directory, backup_path)
            if plan["mode"] == "all":
                self._clear_all(tx)
            else:
                self._clear_batch(tx, plan)
            config = self.data / "config/persona.toml"
            text, n = re.subn(
                r"(?m)^(revision\s*=\s*)\d+(\s*)$",
                rf"\g<1>{plan['revision'] + 1}\g<2>",
                config.read_text(),
                count=1,
            )
            if n != 1:
                raise AgentServiceError("invalid_config", "找不到工作区版本，清理已取消。")
            config.write_text(text)
            PersonaCompiler(self.data, self.state).build()
            tx.commit()
        except BaseException:
            tx.rollback()
            raise
        return {
            "ok": True,
            "counts": plan["counts"],
            "protected": plan["protected"],
            "backup": str(backup_path) if backup_path else None,
            "url": "/extract?task=" + plan["task_id"] if plan["task_id"] else "/",
            "message": "本次提取结果已清除，输入材料已保留。"
            if plan["task_id"]
            else "内容已清空，模型连接与应用配置已保留。",
        }

    def _clear_all(self, tx):
        from .reset_storage import remove

        for name in ["records", "sources", "proposals", "revisions", "evaluations"]:
            remove(self.data / name)
            (self.data / name).mkdir()
        for name in [
            "query-documents",
            "material-analysis",
            "material-imports",
            "evaluations",
            "extraction/runtime",
            "extraction/pdf",
        ]:
            tx.delete(self.state / name)
        tx.clear_table(self.tasks.path, ["tasks"])
        tx.clear_table(self.state / "ai-assistant.sqlite3", ["drafts"])
        tx.clear_table(self.state / "material-handoffs.sqlite3", ["handoffs"])
        if (self.state / "editor-drafts.sqlite3").exists():
            # Keep closed ids so a late autosave cannot restore cleared private text.
            with closing(sqlite3.connect(self.state / "editor-drafts.sqlite3")) as db, db:
                db.execute("UPDATE drafts SET fields='{}',closed=1,revision=revision+1")
        tx.clear_table(self.state / "preference-applications.sqlite3", ["applications"])
        # Keep content-free replay tombstones so old hooks cannot refill the empty Persona.
        with self.learning.transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS reset_receipts (identity TEXT PRIMARY KEY)")
            for row in db.execute(
                "SELECT connection_id, conversation_id, message_id FROM events"
            ).fetchall():
                identity = hashlib.sha256(
                    json.dumps(list(row), ensure_ascii=False).encode()
                ).hexdigest()
                db.execute("INSERT OR IGNORE INTO reset_receipts VALUES (?)", (identity,))
            db.execute(
                "INSERT OR REPLACE INTO config VALUES ('content_reset_at',?)", (str(time.time()),)
            )
            for table in ["observations", "events", "diagnostics", "setup_checks"]:
                db.execute("DELETE FROM " + table)

    def _clear_batch(self, tx, plan):
        store = PersonaStore(self.data).load()
        ids = set(plan["record_ids"])
        proposals = set(plan["proposal_ids"])
        for rid in ids:
            store.records[rid].path.unlink()
        for pid in proposals:
            for directory in ["pending", "history"]:
                (self.data / "proposals" / directory / (pid + ".json")).unlink(missing_ok=True)
        for gid in plan["group_ids"]:
            (self.data / "proposals/change-sets" / (gid + ".json")).unlink(missing_ok=True)
        cleaned = []
        for entry in journal_entries(self.data):
            entry["changes"] = [
                c for c in entry.get("changes", []) if c.get("object_id") not in ids
            ]
            entry["proposal_ids"] = [p for p in entry.get("proposal_ids", []) if p not in proposals]
            if entry["changes"] or entry["proposal_ids"]:
                cleaned.append(entry)
        (self.data / "revisions/changes.jsonl").write_text(
            "".join(json.dumps(x, ensure_ascii=False) + "\n" for x in cleaned)
        )
        with self.tasks.edit(plan["task_id"]) as task:
            metadata = task["ledger"].get("material_metadata", {})
            task.update(
                revision=task["revision"] + 1,
                status="draft",
                draft=None,
                submissions=[],
                history=[],
                run_id=None,
                error=None,
                events=[],
                phase=None,
                phase_done=False,
            )
            for key in [
                "submission_intent",
                "run_policy",
                "result_sources",
                "partial",
                "error_location",
            ]:
                task.pop(key, None)
            task.update(owner_pid=None, persona_revision=None)
            task["ledger"] = {
                "records": {},
                "basis": {},
                "coverage": {},
                "material_metadata": metadata,
                "allow_unspecified_relationship": True,
            }
            for m in task["members"]:
                m.update(analysis=None, status="ready", error=None)
        tx.delete(self.state / "extraction/runtime" / plan["task_id"])
