"""Private projects, tasks and progress in the selected Persona data directory.

One atomic JSON document is the commit point, with snapshot-first revisions.
Kept outside records/ so existing strict Persona/MCP readers remain compatible.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import AgentServiceError
from .change_sets import proposal_lock
from .compiler import _atomic_write
from .ideas import IdeaService, sync_directory
from .library_references import library_items, workspace_key
from .models import Idea
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

    def import_browser(self, expected_revision, snapshot, project_ids, origin="http://127.0.0.1:8765"):
        """Explicit selection only. Preserve browser history and never overwrite IDs.

        Associated legacy ideas use the same stable IDs as the Ideas importer.
        The original browser snapshot is archived before publishing any records.
        """
        if (not isinstance(snapshot, dict) or not isinstance(project_ids, list) or not project_ids or
                any(not isinstance(pid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", pid) for pid in project_ids)):
            invalid("请选择需要导入的浏览器项目。")
        with proposal_lock(self.state):
            old = self.load()
            self._check_revision(old, expected_revision)
            value = copy.deepcopy(old)
            selected = set(project_ids)
            if not selected <= {p.get("id") for p in snapshot.get("projects", [])}:
                invalid("所选项目不在浏览器备份中。")
            imported = set(value["imports"])
            selected -= imported
            if not selected:
                return value
            for kind, model in MODELS.items():
                existing = {r["id"] for r in value[kind]}
                rows = snapshot.get(kind, [])
                if not isinstance(rows, list):
                    invalid("浏览器备份格式无效。")
                for row in rows:
                    if (row.get("id") if kind == "projects" else row.get("project")) not in selected:
                        continue
                    if row["id"] in existing:
                        raise AgentServiceError("conflict", "导入记录与正式项目 ID 冲突，原记录未被覆盖。")
                    try:
                        parsed = model.model_validate(row).model_dump(mode="json")
                    except ValidationError as exc:
                        raise AgentServiceError("invalid_request", "浏览器项目格式无效，原备份仍保留。") from exc
                    if not parsed["created_at"] or not parsed["updated_at"]:
                        invalid("浏览器记录缺少创建或更新时间。")
                    # Demo reference IDs are not valid knowledge-library links.
                    parsed["related_refs"] = [r for r in parsed["related_refs"] if re.fullmatch(r"ps_[a-f0-9]{16}_[a-f0-9]{32}", r)]
                    value[kind].append(parsed)
                    key = f"{kind}:{parsed['id']}"
                    history = snapshot.get("history", {}).get(key, [])
                    preserved = []
                    for revision in history:
                        raw = {k: v for k, v in revision.items() if k != "action_label"}
                        model.model_validate(raw)
                        if raw["id"] != parsed["id"] or raw["revision"] > parsed["revision"]:
                            invalid("浏览器历史与当前记录不一致。")
                        preserved.append(revision)
                    value["history"][key] = preserved or [{**parsed, "action_label": "导入浏览器项目"}]
            self._validate_links(value, value)
            # Archive the exact original, including legacy ideas, drafts-independent history and events.
            # No paths or arbitrary files from the browser are executed or accessed.
            archive_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
            _atomic_write(self.data / "projects/imports" / f"{archive_id}.json",
                          json.dumps(snapshot, ensure_ascii=False, indent=2).encode())
            service = IdeaService(self.data, self.state)
            store = service.store()
            key = workspace_key(store)
            refs = {i["id"] for i in library_items(store, origin) if not i["archived"]}
            mapping = value.setdefault("idea_imports", {})
            legacy = snapshot.get("legacy_ideas", snapshot.get("ideas", []))
            referenced = {t["idea"] for t in value["tasks"] if t["project"] in selected and t["idea"]}
            referenced.update(i for u in value["updates"] if u["project"] in selected for i in u["ideas"])
            referenced.update(p["origin"]["id"] for p in value["projects"] if p["id"] in selected and p["origin"])
            pending = []
            for idea in legacy:
                if idea.get("project") not in selected and idea.get("id") not in referenced:
                    continue
                legacy_id = idea.get("id", "")
                if legacy_id.startswith("idea_"):
                    continue
                identifier = "idea_import_" + hashlib.sha256((key + "\n" + legacy_id).encode()).hexdigest()[:32]
                mapping[legacy_id] = identifier
                ended = idea.get("state") in {"closed", "abandoned"}
                project = next((p for p in value["projects"] if p["id"] == idea.get("project")), None)
                values = {
                    "title": idea.get("title", ""),
                    "body": (idea.get("body", "") + "\n\n---\n\n## 浏览器记录中的判断\n\n"
                             + "原探索状态：" + idea.get("state", "pending") + "\n\n"
                             + idea.get("verdict_note", "") + "\n\n" + idea.get("closure_note", "")),
                    "novelty": idea.get("novelty", "unknown"), "novelty_reason": idea.get("novelty_reason", ""),
                    "difficulty": idea.get("difficulty", "unknown"), "difficulty_reason": idea.get("difficulty_reason", ""),
                    "status": "archived" if idea.get("archived") else "active",
                    "execution_status": "ended" if ended else "in_progress" if idea.get("state") == "exploring" else "not_started",
                    "closure": {"outcome": "abandoned" if idea.get("state") == "abandoned" else "partial",
                                "summary": idea.get("closure_note") or "从浏览器记录导入，结果待补充。"} if ended else None,
                    "related_refs": [r for r in idea.get("related_refs", []) if r in refs],
                    "project": {"id": project["id"], "title": project["title"]} if project else None,
                }
                # Validate all new ideas before writing any of them.
                if identifier not in store.records:
                    Idea.model_validate({"schema": "ai-persona.idea/v1", "entity_type": "idea",
                                         "id": identifier, "revision": 1, "created_at": datetime.now(timezone.utc),
                                         "updated_at": datetime.now(timezone.utc),
                                         **{k: v for k, v in values.items() if k not in {"body", "related_refs", "project"}}})
                    pending.append((identifier, values))
            for identifier, values in pending:
                service.save(identifier, 0, values, origin, _locked=True)
            for task in value["tasks"]:
                if task["project"] in selected:
                    task["idea"] = mapping.get(task["idea"], task["idea"])
            for update in value["updates"]:
                if update["project"] in selected:
                    update["ideas"] = [mapping.get(i, i) for i in update["ideas"]]
            for project in value["projects"]:
                if project["id"] in selected and project["origin"]:
                    project["origin"]["id"] = mapping.get(project["origin"]["id"], project["origin"]["id"])
            # Original historic references remain unchanged in the archived snapshot.
            for event in snapshot.get("events", []):
                if (isinstance(event, dict) and event.get("project") in selected and
                        event.get("type") in MODELS and
                        f"{event['type']}:{event.get('target')}" in value["history"]):
                    value["events"].append({k: event.get(k) for k in (
                        "id", "project", "type", "target", "revision", "label", "time", "progress", "note")})
            for pid in selected:
                value["imports"][pid] = archive_id
            value["version"] += 1
            self._publish(value)
            return value
