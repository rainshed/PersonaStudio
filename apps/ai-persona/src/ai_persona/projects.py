"""Private projects, tasks and progress in the selected Persona data directory.

One atomic JSON document is the commit point, with snapshot-first revisions.
Kept outside records/ so existing strict Persona/MCP readers remain compatible.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import AgentServiceError
from .change_sets import proposal_lock
from .compiler import _atomic_write
from .ideas import sync_directory
from .library_references import library_items, workspace_key
from .store import PersonaStore

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")]
Text = Annotated[str, Field(max_length=800_000)]


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    title: Annotated[str, Field(max_length=1000)] = ""
    body: Text = ""
    revision: int = Field(default=0, ge=0)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    archived: bool = False
    related_refs: list[Identifier] = Field(default_factory=list, max_length=150)


class Entry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    kind: Literal["repo", "local", "remote"]
    label: Annotated[str, Field(max_length=1000)]
    target: Annotated[str, Field(max_length=4000)]
    detail: Annotated[str, Field(max_length=1000)] = ""


class Origin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    revision: int = Field(ge=1)


class Project(Record):
    state: Literal["active", "paused", "completed", "stopped"] = "active"
    subtitle: Text = ""
    goal: Text = ""
    focus: Text = ""
    blocker: Text = ""
    next: Text = ""
    current: Identifier | None = None
    origin: Origin | None = None
    entries: list[Entry] = Field(default_factory=list, max_length=100)
    questions: list[Text] = Field(default_factory=list, max_length=1000)


class Task(Record):
    project: Identifier
    idea: Identifier | None = None
    state: Literal["todo", "doing", "done", "cancelled"] = "todo"
    completed_at: datetime | None = None
    order: int = Field(default=0, ge=0)
    resources: list[Identifier] = Field(default_factory=list, max_length=150)


class Progress(Record):
    project: Identifier
    occurred_at: datetime
    key: bool = False
    validity: Literal["valid", "withdrawn", "superseded"] = "valid"
    review: Literal["preliminary", "reviewed"] = "preliminary"
    superseded_by: Identifier | None = None
    status_note: Text = ""
    review_note: Text = ""
    ideas: list[Identifier] = Field(default_factory=list, max_length=1000)
    tasks: list[Identifier] = Field(default_factory=list, max_length=1000)
    resources: list[Identifier] = Field(default_factory=list, max_length=150)


MODELS = {"projects": Project, "tasks": Task, "updates": Progress}


def empty_workspace():
    return {"schema": "ai-persona.projects/v1", "version": 0, "projects": [],
            "tasks": [], "updates": [], "history": {}, "events": [], "imports": {}, "idea_imports": {}}


def invalid(message):
    raise AgentServiceError("invalid_request", message)


class ProjectService:
    def __init__(self, data_root: Path, state_root: Path):
        self.data, self.state = Path(data_root).resolve(), Path(state_root).resolve()
        self.path = self.data / "projects/workspace.json"

    def load(self):
        if not self.path.exists():
            return empty_workspace()
        try:
            value = json.loads(self.path.read_text())
            if value["schema"] != "ai-persona.projects/v1" or type(value["version"]) is not int:
                raise ValueError("Unsupported projects schema")
            if not isinstance(value["history"], dict) or not isinstance(value["events"], list) or not isinstance(value["imports"], dict):
                raise ValueError("Invalid project history")
            for kind, model in MODELS.items():
                if not isinstance(value[kind], list) or len({row["id"] for row in value[kind]}) != len(value[kind]):
                    raise ValueError("Duplicate project records")
                for row in value[kind]:
                    model.model_validate(row)
            return value
        except (ValueError, KeyError, TypeError, OSError) as exc:
            raise AgentServiceError("save_failed", "项目数据无法读取，请检查工作区或恢复备份。现有数据未被覆盖。") from exc

    def catalog(self):
        result = self.load()
        store = PersonaStore(self.data).load(verify_source_files=False)
        return {**result, "workspace_key": workspace_key(store)}

    def _publish(self, value):
        content = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
        history = self.data / "revisions/projects"
        history.mkdir(parents=True, exist_ok=True)
        snapshot = history / f"{value['version']:08d}.json"
        try:
            _atomic_write(snapshot, content)
            sync_directory(history)
            _atomic_write(self.path, content)
            sync_directory(self.path.parent)
        except Exception:
            if not self.path.exists() or self.path.read_bytes() != content:
                snapshot.unlink(missing_ok=True)
                raise

    def _check_revision(self, old, revision):
        if type(revision) is not int or revision < 0:
            invalid("保存需要当前项目版本号。")
        if old["version"] != revision:
            raise AgentServiceError("conflict", "项目已在另一设备更新。你的输入已保留，请读取最新记录后核对再保存。")

    def _validate_links(self, value, old):
        projects = {p["id"]: p for p in value["projects"]}
        tasks = {t["id"]: t for t in value["tasks"]}
        updates = {u["id"]: u for u in value["updates"]}
        store = PersonaStore(self.data).load(verify_source_files=False)
        catalog = {i["id"] for i in library_items(store, "") if not i["archived"]}
        for kind in MODELS:
            previous = {r["id"]: r for r in old[kind]}
            for row in value[kind]:
                if kind != "updates" and not row["title"].strip():
                    invalid("请填写项目或待办名称。")
                if any(ref not in catalog and ref not in previous.get(row["id"], {}).get("related_refs", [])
                       for ref in row.get("related_refs", [])):
                    invalid("请选择当前知识库中的知识或材料；已有引用可以保留。")
                if kind != "projects" and row["project"] not in projects:
                    invalid("待办与进展必须属于已有项目。")
        for project in projects.values():
            if project["current"] and (project["current"] not in updates or
                                       updates[project["current"]]["project"] != project["id"]):
                invalid("置顶进展必须属于当前项目。")
            for entry in project["entries"]:
                if entry["kind"] == "repo":
                    url = urlparse(entry["target"])
                    if url.scheme not in {"http", "https"} or not url.netloc or url.username:
                        invalid("代码仓库请填写有效的 HTTP(S) 链接。")
        for task in tasks.values():
            if task["state"] == "done" and not task["completed_at"]:
                invalid("已完成待办需要完成时间。")
        for update in updates.values():
            if not update["body"].strip():
                invalid("请填写进展正文。")
            if update["validity"] != "valid" and not update["status_note"].strip():
                invalid("撤回或替代进展需要填写原因。")
            if update["validity"] == "superseded" and not update["superseded_by"]:
                invalid("请选择替代进展。")
            for task_id in update["tasks"]:
                if task_id not in tasks or tasks[task_id]["project"] != update["project"]:
                    invalid("关联待办必须属于当前项目。")
            seen, target = {update["id"]}, update["superseded_by"]
            while target:
                if target in seen or target not in updates or updates[target]["project"] != update["project"]:
                    invalid("替代进展必须在同一项目中，且不能形成循环。")
                seen.add(target)
                target = updates[target]["superseded_by"]

    def save(self, expected_revision, changes):
        if not isinstance(changes, list) or not 1 <= len(changes) <= 2000:
            invalid("请提交项目、待办或进展的修改。")
        with proposal_lock(self.state):
            old = self.load()
            self._check_revision(old, expected_revision)
            value, now = copy.deepcopy(old), datetime.now(timezone.utc).isoformat()
            changed = set()
            for change in changes:
                if not isinstance(change, dict) or set(change) - {"collection", "value", "label", "progress", "note"}:
                    invalid("项目修改格式无效。")
                kind = change.get("collection")
                if kind not in MODELS:
                    invalid("不支持的项目记录类型。")
                try:
                    record = MODELS[kind].model_validate(change.get("value")).model_dump(mode="json")
                except ValidationError as exc:
                    raise AgentServiceError("invalid_request", "项目字段无效，请检查名称、状态、日期与关联内容。") from exc
                key = f"{kind}:{record['id']}"
                if key in changed:
                    invalid("一次保存不能重复修改同一条记录。")
                changed.add(key)
                previous = next((r for r in old[kind] if r["id"] == record["id"]), None)
                label, note = change.get("label", "保存"), change.get("note", "")
                if not isinstance(label, str) or len(label) > 1000 or not isinstance(note, str) or len(note) > 30000:
                    invalid("记录说明过长或格式无效。")
                record.update(revision=(previous["revision"] if previous else 0) + 1,
                              created_at=previous["created_at"] if previous else now, updated_at=now)
                value[kind] = [r for r in value[kind] if r["id"] != record["id"]]
                value[kind].insert(0, record)
                value["history"].setdefault(key, []).append({**record, "action_label": label})
                value["events"].insert(0, {
                    "id": f"{key}:{record['revision']}", "project": record["id"] if kind == "projects" else record["project"],
                    "type": kind, "target": record["id"], "revision": record["revision"],
                    "label": f"{label}：{record['title'] or '进展'}", "time": now,
                    "progress": bool(change.get("progress", False)), "note": note, "verdict": None,
                })
            self._validate_links(value, old)
            value["version"] += 1
            self._publish(value)
            return value
