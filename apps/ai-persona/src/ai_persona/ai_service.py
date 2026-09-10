"""Model-assisted routing and editable drafts; publication stays in human review."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .agent import (
    AgentServiceError,
    PersonaProposalFacade,
    PersonaQueryService,
    ProposalChangeInput,
)
from .change_sets import ChangeSetRepository, proposal_lock
from .evaluations.contracts import ACTIVATION, activation_decisions
from .evaluations.store import EvaluationStore
from .material_analysis import (
    PERSONAL_FIELDS,
    PROMPT_VERSION,
    SHORT_TEXT_CHARS,
    LineRange,
    MaterialAnalysis,
    check_analysis,
    compact_schema,
    excerpts,
    field_contracts,
    normalized,
    retrieve,
    source_chunks,
)
from .model_bridge import ModelClient
from .models import PreferenceContext, ProposalContext, Relation
from .pending_sync import require_unreviewed, sync_pending
from .prompt_store import PromptStore, default_text
from .proposals import (
    CREATE_FIELDS,
    CREATE_TYPES,
    SCHEMA_BY_TYPE,
    ProposalError,
    ProposalService,
    _new_id,
)
from .store import PersonaStore


def now() -> str:
    return datetime.now(UTC).isoformat()


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class OutputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ContextDecision(OutputModel):
    key: str
    matched: bool = Field(strict=True)
    reason: str = Field(min_length=1, max_length=400)


class ActivationOutput(OutputModel):
    contexts: list[ContextDecision]


class LegacyContextDecision(OutputModel):
    """Read frozen v1 experiments without admitting a third live decision."""

    key: str
    decision: Literal["match", "no_match", "uncertain"]
    reason: str = Field(min_length=1, max_length=400)


class LegacyActivationOutput(OutputModel):
    contexts: list[LegacyContextDecision]


class DraftOutput(OutputModel):
    reply: str = Field(min_length=1, max_length=5000)
    changes: list[ProposalChangeInput] = Field(default_factory=list, max_length=30)
    questions: list[str] = Field(default_factory=list, max_length=10)
    read_ids: list[str] = Field(default_factory=list, max_length=20)
    source_reads: list[LineRange] = Field(default_factory=list, max_length=10)
    search_queries: list[str] = Field(default_factory=list, max_length=10)


def parse_output(result: dict, model: type[BaseModel]) -> Any:
    text = result.get("text", "").strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    elif text.startswith("```\n") and text.endswith("```"):
        text = text[4:-3].strip()
    try:
        return model.model_validate_json(text)
    except (ValidationError, ValueError, TypeError):
        raise AgentServiceError(
            "invalid_model_output", "模型返回的结构不完整或不符合要求，请重试。"
        ) from None


class DraftRepository:
    def __init__(self, state_root: Path):
        self.path = state_root / "ai-assistant.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL)"
            )
        self.path.chmod(0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=20)

    def create(self, value: dict) -> dict:
        with self.connect() as db:
            db.execute("INSERT INTO drafts VALUES (?, ?)", (value["id"], encoded(value)))
        return value

    def get(self, identifier: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT body FROM drafts WHERE id=?", (identifier,)).fetchone()
        if not row:
            raise AgentServiceError("not_found", "维护草稿不存在。")
        return json.loads(row[0])

    def update(
        self,
        identifier: str,
        updates: dict,
        expected: int | None = None,
        *,
        expected_run: str | None = None,
    ) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT body FROM drafts WHERE id=?", (identifier,)).fetchone()
            if not row:
                raise AgentServiceError("not_found", "维护草稿不存在。")
            value = json.loads(row[0])
            if expected_run is not None and (
                value["status"] != "running" or value.get("run_id") != expected_run
            ):
                raise AgentServiceError("cancelled", "本轮分析已结束。")
            if expected is not None and value["version"] != expected:
                raise AgentServiceError("stale_draft", "草稿已被更新，请刷新后继续。")
            value.update(updates)
            value["version"] += 1
            value["updated_at"] = now()
            db.execute("UPDATE drafts SET body=? WHERE id=?", (encoded(value), identifier))
        return value

    def recent(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT body FROM drafts ORDER BY rowid DESC LIMIT 30").fetchall()
        return [
            {
                key: d[key]
                for key in ("id", "title", "status", "updated_at", "material_id", "record_id")
            }
            for row in rows
            for d in [json.loads(row[0])]
        ]


ROUTING_PROMPT = default_text("ai-persona.activation")

DRAFT_PROMPT = default_text("ai-persona.maintenance")


class PersonaAIService:
    def __init__(self, data_root: Path, state_root: Path, model_client: Any = None):
        from .demo import check_demo_paths

        check_demo_paths(data_root, state_root)
        self.data_root = data_root
        self.state_root = state_root
        self.query = PersonaQueryService(data_root, state_root)
        self.model = model_client or ModelClient.for_workspace(data_root, state_root)
        self.prompts = PromptStore(state_root / "prompts")
        self.evaluations = EvaluationStore(data_root, state_root)
        self._repository = None
        self._repo_lock = threading.Lock()

    @property
    def repository(self) -> DraftRepository:
        with self._repo_lock:
            if self._repository is None:
                self._repository = DraftRepository(self.state_root)
            return self._repository

    def resolve_persona_activation(
        self,
        user_prompt: str,
        task_summary: str = "",
        recent_messages: list[dict] | None = None,
        artifact_type: str | None = None,
        *,
        store: PersonaStore | None = None,
        deadline: float | None = None,
        run_id: str | None = None,
        task_ref: str | None = None,
        on_result=None,
    ) -> dict:
        if (
            not isinstance(user_prompt, str)
            or not isinstance(task_summary, str)
            or not user_prompt.strip()
            or len(user_prompt) > 24000
            or len(task_summary) > 12000
            or (
                artifact_type is not None
                and (not isinstance(artifact_type, str) or len(artifact_type) > 200)
            )
        ):
            raise AgentServiceError("invalid_request", "请输入不超过 24000 字符的任务内容。")
        messages = recent_messages or []
        if (
            len(messages) > 12
            or len(encoded(messages)) > 24000
            or any(
                set(m) != {"role", "content"}
                or m["role"] not in {"user", "assistant"}
                or not isinstance(m["content"], str)
                for m in messages
            )
        ):
            raise AgentServiceError("invalid_request", "近期对话格式或长度无效。")
        store = store or PersonaStore(self.data_root).load()
        contexts = sorted(store.of_type(PreferenceContext, active_only=True), key=lambda c: c.key)
        catalog = [
            {
                "key": c.key,
                "name": c.name,
                "description": c.description,
                "activation": c.activation.model_dump(),
                "revision": c.revision,
            }
            for c in contexts
        ]
        if len(encoded(catalog)) > 100000:
            raise AgentServiceError("context_length", "场景目录超出当前完整判定预算。")
        version = hashlib.sha256(encoded(catalog).encode()).hexdigest()
        result = {
            "ok": True,
            "schema_version": "ai-persona.activation/v2",
            "persona_revision": self.query._revision(store),
            "catalog_version": version,
            "decision": "no_match",
            "matched_contexts": [],
            "contexts": [],
            "evaluated_context_count": len(contexts),
        }
        if not contexts:
            return result
        activation_payload = {
            "schema_version": "ai-persona.activation/v2",
            "user_prompt": user_prompt,
            "task_summary": task_summary,
            "recent_messages": messages,
            "artifact_type": artifact_type,
            "catalog": catalog,
            "output_schema": ActivationOutput.model_json_schema(),
        }
        snapshot = self.prompts.snapshot()
        from .trigger_plans import generation_options
        preview = self.prompts.preview(
            "ai-persona.activation", {"payload": activation_payload}, snapshot=snapshot
        )
        self.prompts.capture("ai-persona.activation", {"payload": activation_payload}, snapshot)
        evaluation = self.evaluations.create_result(
            ACTIVATION,
            task_ref=task_ref,
            run_id=run_id,
            input_data=activation_payload,
            prompt_snapshot=snapshot,
        )
        by_key = {c.key: c for c in contexts}
        try:
            if on_result:
                on_result(evaluation["id"])
            if deadline is not None and time.time() >= deadline:
                raise AgentServiceError("timeout", "场景判断超过等待上限。")
            raw = self.model.generate(
                "activation",
                preview["rendered"]["system"],
                activation_payload
                if preview["templates"]["user"] == "{{payload}}"
                else preview["rendered"]["user"],
                max_tokens=min(16000, max(2048, len(contexts) * 160)),
                **generation_options(snapshot, "ai-persona.activation"),
                **({"deadline": deadline, "run_id": run_id} if deadline is not None else {}),
            )
            if deadline is not None and time.time() >= deadline:
                raise AgentServiceError("timeout", "场景判断超过等待上限。")
            result["prompt_versions"] = preview["versions"]
            parsed = parse_output(raw, ActivationOutput)
            returned = [c.key for c in parsed.contexts]
            if len(returned) != len(set(returned)) or set(returned) != set(by_key):
                raise AgentServiceError(
                    "invalid_model_output", "模型未完整判断所有场景，或返回未知场景。"
                )
            decisions = activation_decisions(parsed, catalog)
        except Exception as exc:
            self.evaluations.complete_result(
                evaluation["id"], state="failed", error_code=getattr(exc, "code", "model_error")
            )
            raise
        self.evaluations.complete_result(
            evaluation["id"],
            decisions=decisions,
            state="completed",
            stage={
                "prompt_id": "ai-persona.activation",
                "payload": activation_payload,
                "output": parsed.model_dump(mode="json"),
                "model": {k: v for k, v in raw.items() if k != "text"},
            },
        )
        result.update(
            result_id=evaluation["id"],
            run_id=evaluation["run_id"],
            feedback_url="/evaluations?result=" + evaluation["id"],
            contexts=decisions,
        )
        for item in parsed.contexts:
            if not item.matched:
                continue
            context = by_key[item.key]
            result["matched_contexts"].append(
                {
                    "id": context.id,
                    "key": context.key,
                    "name": context.name,
                    "context_revision": context.revision,
                    "reason": item.reason,
                }
            )
        result["decision"] = "match" if result["matched_contexts"] else "no_match"
        result["model_run"] = {k: v for k, v in raw.items() if k != "text"}
        return result

    def create_session(
        self,
        *,
        record_id: str | None = None,
        material_id: str | None = None,
        allow_personal: bool = False,
        maintenance: dict | None = None,
    ) -> dict:
        if type(allow_personal) is not bool or any(
            identifier is not None and (not isinstance(identifier, str) or len(identifier) > 200)
            for identifier in [record_id, material_id]
        ):
            raise AgentServiceError("invalid_request", "记录标识或个人偏好选项格式无效。")
        store = PersonaStore(self.data_root).load()
        for identifier in [record_id, material_id]:
            if identifier and identifier not in store.records:
                raise AgentServiceError("not_found", "记录不存在。")
        if material_id:
            self.query.get_material_source(material_id=material_id)
        value = {
            "id": f"ai_{uuid.uuid4().hex}",
            "version": 1,
            "status": "idle",
            "title": "材料智能整理" if material_id else "自然语言维护",
            "record_id": record_id,
            "material_id": material_id,
            "allow_personal": allow_personal,
            "messages": [],
            "draft": None,
            "base_revision": self.query._revision(store),
            "source": None,
            "coverage": None,
            "model_runs": [],
            "checkpoint": None,
            "created_at": now(),
            "updated_at": now(),
            "submission": None,
            "error": None,
            "owner_pid": None,
        }
        if maintenance is not None:
            from .maintenance.service import validate_input
            value.update(maintenance=validate_input(self, maintenance, []),
                         attachments=[], message_sources=[], title="AI 维护助手")
        return self.repository.create(value)

    def get_session(self, session_id: str) -> dict:
        value = self.repository.get(session_id)
        if value["status"] in {"submitting", "submission_failed"} and value.get("submission_key"):
            facade = PersonaProposalFacade(self.data_root, self.state_root)
            with proposal_lock(self.state_root):
                manifest = facade.change_sets.by_idempotency_key(value["submission_key"])
            if manifest:
                try:
                    value = self.repository.update(
                        session_id,
                        {
                            "status": "submitted",
                            "stage": "已进入待审核区",
                            "error": None,
                            "submission": facade._submission_result(manifest).model_dump(
                                mode="json"
                            ),
                        },
                        value["version"],
                    )
                except AgentServiceError:
                    value = self.repository.get(session_id)
            elif value["status"] == "submitting" and value.get("owner_pid"):
                try:
                    os.kill(value["owner_pid"], 0)
                except ProcessLookupError:
                    value = self.repository.update(
                        session_id,
                        {
                            "status": "submission_failed",
                            "error": {
                                "code": "interrupted",
                                "message": "送审中断，候选已保存，可重试送审。",
                            },
                        },
                        value["version"],
                    )
        if value["status"] == "running" and value.get("owner_pid"):
            try:
                os.kill(value["owner_pid"], 0)
            except ProcessLookupError:
                value = self.repository.update(
                    session_id,
                    {
                        "status": "failed",
                        "error": {"code": "interrupted", "message": "分析进程已退出，请重试。"},
                    },
                    value["version"],
                )
        if value["status"] == "running" and hasattr(self.model, "progress"):
            try:
                value["model_progress"] = self.model.progress(value["run_id"])
            except AgentServiceError:
                pass
        value["can_refine"] = True
        if value.get("submission"):
            facade = PersonaProposalFacade(self.data_root, self.state_root)
            with proposal_lock(self.state_root):
                request_id = value["submission"].get("request_id")
                value["submission"] = facade._submission_result(
                    facade.change_sets.get(value["submission"]["change_set_id"])
                ).model_dump(mode="json")
                if request_id:
                    value["submission"]["request_id"] = request_id
                try:
                    require_unreviewed(facade, session_id, value["submission"]["change_set_id"])
                except AgentServiceError:
                    value["can_refine"] = False
        return value

    @staticmethod
    def _require_refinable(value: dict) -> None:
        if not value.get("can_refine", True):
            raise AgentServiceError(
                "already_reviewed", "这组候选已有审核决定，不能覆盖。请新建维护任务。"
            )

    def begin(self, session_id: str, message: str, version: int) -> dict:
        value = self.get_session(session_id)
        if value["status"] in {"running", "submitting"}:
            raise AgentServiceError("busy", "该草稿正在处理，请等待或取消。")
        self._require_refinable(value)
        if not message.strip() or len(message) > 20000:
            raise AgentServiceError("invalid_request", "请输入不超过 20000 字符的维护要求。")
        messages = [*value["messages"], {"role": "user", "content": message}]
        if len(encoded(messages)) > 90000:
            raise AgentServiceError("context_length", "对话过长，请新建维护会话。")
        extra = {}
        if value.get("maintenance"):
            from .maintenance.service import validate_input
            from .maintenance.sources import save_text
            if value["version"] != version:
                raise AgentServiceError("stale_draft", "任务已更新，请刷新后继续。")
            validate_input(self, value["maintenance"], value.get("attachments", []))
            source = save_text(self.data_root, self.state_root, text=message,
                               title="维护要求.txt", kind="user_statement")
            extra["message_sources"] = [*value.get("message_sources", []), source]
        return self.repository.update(
            session_id,
            {
                "status": "running",
                "stage": "读取相关记录",
                "error": None,
                "messages": messages,
                "title": message[:70],
                "owner_pid": os.getpid(),
                "run_id": uuid.uuid4().hex,
                "checkpoint": None,
                "prompt_snapshot": self.prompts.snapshot(),
                "source": None,
                "coverage": None,
                "started_at": now(),
                "stage_started_at": now(),
                "run_start_version": version + 1,
                **extra,
            },
            version,
        )

    def resume(self, session_id: str, version: int) -> dict:
        value = self.get_session(session_id)
        if value["status"] not in {"failed", "cancelled"} or not value["messages"]:
            raise AgentServiceError("invalid_request", "只有失败或取消的分析可以继续。")
        self._require_refinable(value)
        return self.repository.update(
            session_id,
            {
                "status": "running",
                "stage": "检查已保存的分析",
                "error": None,
                "owner_pid": os.getpid(),
                "run_id": uuid.uuid4().hex,
                "started_at": now(),
                "stage_started_at": now(),
                "run_start_version": version + 1,
            },
            version,
        )

    def _source(self, material_id: str) -> tuple[dict, dict, str]:
        source = self.query.get_material_source(material_id=material_id)
        file = next(
            (f for f in source.files if f.preferred_for_text and f.evidence_locator == "lines"),
            None,
        )
        if not file:
            raise AgentServiceError("source_text_required", "请先为材料导入可定位的提取文本。")
        content = Path(file.path).read_bytes()
        if "sha256:" + hashlib.sha256(content).hexdigest() != file.sha256:
            raise AgentServiceError("stale_source", "材料原文已变化，请重新导入。")
        lines = content.decode("utf-8", errors="replace").splitlines()
        if len(content) > 5000000:
            raise AgentServiceError("context_length", "提取文本超过 5 MB，请按章节拆分材料。")
        numbered = [f"{number}: {line}" for number, line in enumerate(lines, 1)]
        metadata = {
            "material_id": source.material_id,
            "source_id": source.source_id,
            "source_hash": source.source_hash,
            "material_revision": source.material_revision,
            "file": file.relative_path,
            "file_hash": file.sha256,
        }
        coverage = {
            "file": file.relative_path,
            "line_start": 1,
            "line_end": 0,
            "total_lines": len(lines),
            "complete": False,
        }
        if not numbered:
            raise AgentServiceError("source_text_required", "材料没有可在预算内读取的文本行。")
        return metadata, coverage, "\n".join(numbered)

    @staticmethod
    def _full_record(store: PersonaStore, identifier: str) -> dict:
        loaded = store.records[identifier]
        return {
            **loaded.record.model_dump(mode="json", by_alias=True),
            "body": loaded.body,
            "relationships": [
                r.model_dump(mode="json", by_alias=True)
                for r in store.of_type(Relation, active_only=True)
                if identifier in {r.source_id, r.target_id}
            ],
        }

    def _catalog(self, value: dict, store: PersonaStore) -> list[dict]:
        catalog = []
        for loaded in store.records.values():
            r = loaded.record
            if r.entity_type in {"evidence", "relation"}:
                continue
            if value["material_id"] and (
                r.status != "active"
                or (
                    r.entity_type not in {"knowledge_node", "course", "material", "tag"}
                    and not value["allow_personal"]
                )
            ):
                continue
            catalog.append(
                {
                    "id": r.id,
                    "type": r.entity_type,
                    "status": r.status,
                    "name": getattr(r, "title", getattr(r, "name", getattr(r, "label", ""))),
                    "aliases": getattr(r, "aliases", []),
                    "summary": getattr(r, "instruction", getattr(r, "summary", ""))[:160],
                }
            )
        return catalog

    def _record(self, value: dict, store: PersonaStore, identifier: str) -> dict:
        record = self._full_record(store, identifier)
        if value["material_id"] and not value["allow_personal"]:
            if (
                record["entity_type"].startswith("preference")
                or record["entity_type"] == "evidence"
            ):
                raise AgentServiceError(
                    "personal_scope_required", "此分析不能读取个人偏好或独立证据记录。"
                )
            record = {k: v for k, v in record.items() if k not in PERSONAL_FIELDS}
        return record

    def _payload(self, value: dict, store: PersonaStore) -> dict:
        catalog = self._catalog(value, store)
        if not value["material_id"] and len(encoded(catalog)) > 100000:
            raise AgentServiceError("context_length", "Persona 目录过大，请先缩小整理范围。")
        full_ids = {v for v in [value["record_id"], value["material_id"]] if v}
        if value["draft"]:
            full_ids.update(c["target_id"] for c in value["draft"]["changes"] if c.get("target_id"))

        def full(identifier):
            return self._record(value, store, identifier)

        return {
            "messages": value["messages"],
            "previous_draft": value["draft"],
            "catalog": catalog if not value["material_id"] else catalog[:100],
            "catalog_complete": len(catalog) <= 100 if value["material_id"] else True,
            "records": [full(i) for i in sorted(full_ids)],
            "persona_revision": self.query._revision(store),
            "allow_personal": value["allow_personal"],
            "output_schema": compact_schema(DraftOutput.model_json_schema()),
            "field_contracts": field_contracts(bool(value["material_id"]), value["allow_personal"]),
        }

    def _validate_changes(self, draft: DraftOutput, value: dict, store: PersonaStore) -> list[dict]:
        source = value.get("source")
        if value["material_id"] and not source:
            raise AgentServiceError("stale_source", "请先重新分析材料，恢复来源与阅读范围。")
        refs = {c.client_ref: c for c in draft.changes if c.client_ref}
        if len(refs) != len([c for c in draft.changes if c.client_ref]):
            raise AgentServiceError("invalid_model_output", "草稿包含重复的 client_ref。")
        targets = [c.target_id for c in draft.changes if c.target_id]
        if len(targets) != len(set(targets)):
            raise AgentServiceError("invalid_model_output", "同一记录的变化需要合并到一个候选中。")
        changes = []
        known_names = {
            normalized(name)
            for loaded in store.records.values()
            if loaded.record.entity_type == "knowledge_node" and loaded.record.status == "active"
            for name in [loaded.record.title, *loaded.record.aliases]
        }
        service = ProposalService(self.data_root, self.state_root)
        for index, change in enumerate(draft.changes):
            change = change.model_copy(deep=True)
            if source and change.operation == "create" and change.entity_type == "knowledge_node":
                change.values.setdefault("interest_level", "unspecified")
                change.values.setdefault("knowledge_level", "unspecified")
            if not change.client_ref:
                change.client_ref = f"item-{uuid.uuid4().hex}"
            if change.operation == "create":
                model = CREATE_TYPES.get(change.entity_type)
                if not model or set(change.values) - CREATE_FIELDS[model] - {"context_client_refs"}:
                    raise AgentServiceError(
                        "invalid_model_output", "草稿包含不支持的创建字段或类型。"
                    )
            if change.target_id:
                loaded = store.records.get(change.target_id)
                if loaded is None or loaded.record.entity_type != change.entity_type:
                    raise AgentServiceError(
                        "invalid_model_output", "草稿引用未知记录或对象类型不符。"
                    )
                change.expected_record_revision = loaded.record.revision
                if change.operation == "update":
                    allowed = service._allowed_update_fields(loaded.record)
                    if set(change.values) - allowed - {"context_client_refs"}:
                        raise AgentServiceError("invalid_model_output", "草稿包含不可修改的字段。")
            if source:
                if change.operation not in {"create", "update", "relate"}:
                    raise AgentServiceError(
                        "invalid_model_output", "材料分析仅支持新增、补充和关联。"
                    )
                if not value["allow_personal"]:
                    personal = {
                        "knowledge_level",
                        "interest_level",
                        "preference_level",
                        "scope_note",
                        "preference_reasons",
                        "user_relationships",
                        "body",
                    }
                    changed = {
                        k
                        for k in change.values
                        if k in personal
                        and (
                            change.operation == "update"
                            or change.values[k] not in (None, "", "unspecified", [])
                        )
                    }
                    if changed or change.entity_type.startswith("preference"):
                        raise AgentServiceError(
                            "personal_scope_required", "此分析未启用个人状态或偏好候选。"
                        )
                if change.entity_type in {"knowledge_node", "relation"} and not change.evidence:
                    raise AgentServiceError("evidence_required", "材料知识及关系候选需要原文证据。")
                for evidence in change.evidence:
                    if (
                        evidence.file != source["file"]
                        or evidence.line_end > value["coverage"]["line_end"]
                    ):
                        raise AgentServiceError(
                            "invalid_evidence", "证据必须位于本次实际读取的材料范围。"
                        )
                    material = store.records[value["material_id"]].record
                    if evidence.evidence_kind != "read_signal" and not (
                        evidence.evidence_kind == "authored_material"
                        and "authored" in material.user_relationships
                    ):
                        raise AgentServiceError(
                            "invalid_evidence", "材料原文不能被标记为用户明确声明或人工确认。"
                        )
                if (
                    change.entity_type == "material"
                    and change.operation == "update"
                    and set(change.values) & {"abstract", "title", "bibliography", "source_ref"}
                ):
                    raise AgentServiceError(
                        "protected_source", "材料整理不可覆盖原始标题、摘要或来源信息。"
                    )
                if change.entity_type not in {"knowledge_node", "material", "relation"} and not (
                    value["allow_personal"] and change.entity_type.startswith("preference")
                ):
                    raise AgentServiceError(
                        "invalid_model_output", "该对象类型不在材料整理范围内。"
                    )
                if change.entity_type == "material" and (
                    change.operation != "update" or change.target_id != value["material_id"]
                ):
                    raise AgentServiceError(
                        "protected_source", "材料整理只修改当前材料的候选摘要与允许字段。"
                    )
                if change.operation == "create" and change.entity_type == "knowledge_node":
                    names = {
                        normalized(n)
                        for n in [change.values.get("title", ""), *change.values.get("aliases", [])]
                    } - {""}
                    if names & known_names:
                        raise AgentServiceError(
                            "duplicate_concept", "知识名称或别名与已有概念重复，请复用已有概念。"
                        )
                    known_names |= names
            for field in ("source_ref", "target_ref"):
                if (
                    change.operation == "relate"
                    and field in change.values
                    and change.values[field] not in refs
                ):
                    raise AgentServiceError("invalid_dependency", "关系引用了未选择的新知识候选。")
            for ref in change.values.get("context_client_refs", []):
                if ref not in refs or refs[ref].entity_type != "preference_context":
                    raise AgentServiceError("invalid_dependency", "偏好引用的场景候选不存在。")
            data = change.model_dump(mode="json")
            data["before"] = (
                {
                    k: (
                        store.records[change.target_id].body
                        if k == "body"
                        else getattr(store.records[change.target_id].record, k, None)
                    )
                    for k in change.values
                    if k != "context_client_refs"
                }
                if change.target_id
                else {}
            )
            # Convert nested Pydantic fields in the preview without changing the proposal payload.
            if change.target_id:
                full = store.records[change.target_id].record.model_dump(mode="json")
                data["before"] = {
                    k: full.get(k) if k != "body" else store.records[change.target_id].body
                    for k in change.values
                    if k != "context_client_refs"
                }
            changes.append(data)
        self._validate_candidates(changes, store)
        return changes

    def _validate_candidates(self, changes: list[dict], store: PersonaStore) -> None:
        """Validate without creating proposals/files; temporary IDs never leave this method."""
        service = ProposalService(self.data_root, self.state_root)
        ids = {
            c["client_ref"]: _new_id(c["entity_type"])
            for c in changes
            if c["operation"] == "create"
        }
        types = {
            ids[c["client_ref"]]: c["entity_type"] for c in changes if c["operation"] == "create"
        }
        contexts, relations = [], []
        ordered = sorted(
            changes,
            key=lambda c: (c["entity_type"] != "preference_context" or c["operation"] != "create",),
        )
        try:
            for change in ordered:
                operation = change["operation"]
                if operation not in {"create", "update", "relate"}:
                    continue
                fields = dict(change["values"])
                context_refs = fields.pop("context_client_refs", None)
                if context_refs is not None:
                    if change["entity_type"] not in {
                        "preference",
                        "preference_example",
                    } or not isinstance(context_refs, list):
                        raise ValueError("invalid context dependencies")
                    fields["context_refs"] = list(
                        dict.fromkeys(
                            [
                                *fields.get("context_refs", []),
                                *(ids[ref] for ref in context_refs),
                            ]
                        )
                    )
                body = fields.pop("body", "")
                if operation == "update":
                    loaded = store.records[change["target_id"]]
                    payload = loaded.record.model_dump(mode="json", by_alias=True)
                    body = change["values"].get("body", loaded.body)
                    payload.update(fields)
                else:
                    if operation == "relate":
                        for side in ("source", "target"):
                            ref, direct = fields.pop(side + "_ref", None), fields.get(side + "_id")
                            if bool(ref) == bool(direct):
                                raise ValueError("provide one endpoint reference")
                            if ref:
                                fields[side + "_id"] = ids[ref]
                        if fields.get("relation_type") == "related_to":
                            fields["source_id"], fields["target_id"] = sorted(
                                [fields["source_id"], fields["target_id"]]
                            )
                        PersonaProposalFacade._validate_relation_candidate(
                            store, fields, types, relations
                        )
                        relations.append(
                            (fields["source_id"], fields["relation_type"], fields["target_id"])
                        )
                    payload = {
                        "schema": SCHEMA_BY_TYPE[change["entity_type"]],
                        "entity_type": change["entity_type"],
                        "status": "active",
                        "revision": 1,
                        "id": ids[change["client_ref"]]
                        if operation == "create"
                        else _new_id("relation"),
                        "created_at": now(),
                        "updated_at": now(),
                        **fields,
                    }
                candidate = service._parse_candidate(payload)
                service._validate_candidate(
                    store,
                    candidate,
                    body,
                    replacing_id=change["target_id"],
                    context_candidates=contexts,
                )
                if isinstance(candidate, PreferenceContext) and operation == "create":
                    contexts.append(candidate)
                PersonaProposalFacade._check_evidence(store, change.get("evidence_refs", []))
            PersonaProposalFacade._validate_pending_broader_cycles(store, relations)
        except (ProposalError, ValueError, TypeError, KeyError) as exc:
            raise AgentServiceError(
                "invalid_model_output", "候选字段或引用无效：" + str(exc)[:600]
            ) from None

    def _save_running(self, session_id: str, run_id: str, **updates) -> dict:
        current = self.repository.get(session_id)
        if current["status"] != "running" or current["run_id"] != run_id:
            raise AgentServiceError("cancelled", "本轮分析已结束。")
        return self.repository.update(session_id, updates, expected_run=run_id)

    def _call(
        self,
        value: dict,
        stage: str,
        prompt_id: str,
        payload: dict,
        output_type,
        tokens: int,
        validator=None,
    ):
        preview = self.prompts.preview(
            prompt_id, {"payload": payload}, snapshot=value["prompt_snapshot"]
        )
        system = preview["rendered"]["system"]
        capture = self.prompts.capture(
            prompt_id, {"payload": payload}, value["prompt_snapshot"], origin=value["id"]
        )
        if len(encoded(payload)) > 220000:
            raise AgentServiceError("context_length", "本阶段上下文超过预算，请缩小分析范围。")
        self._save_running(value["id"], value["run_id"], stage=stage, stage_started_at=now())
        started = time.monotonic()
        metadata = {
            "stage": stage,
            "prompt_versions": preview["versions"],
            "prompt_capture_id": capture["id"],
            "at": now(),
            "inputChars": len(encoded(payload)) + len(system),
            "maxTokens": tokens,
            "status": "succeeded",
        }
        try:
            self._check_model_signature(value)
            raw = self.model.generate(
                "material" if value["material_id"] or (
                    value.get("maintenance", {}).get("material_ids")
                    or value.get("maintenance", {}).get("attachment_ids")
                ) else "maintenance",
                system,
                payload
                if preview["templates"]["user"] == "{{payload}}"
                else preview["rendered"]["user"],
                max_tokens=tokens,
                run_id=value["run_id"],
                stage=stage,
            )
            metadata.update({k: v for k, v in raw.items() if k != "text"})
            self._check_model_signature(value)
            parsed = parse_output(raw, output_type)
            return validator(parsed) if validator else parsed
        except Exception as exc:
            metadata.update(getattr(exc, "details", {}).get("model_run", {}))
            metadata["status"] = (
                exc.code if isinstance(exc, AgentServiceError) else "analysis_failed"
            )
            raise
        finally:
            metadata["durationMs"] = round((time.monotonic() - started) * 1000)
            current = self.repository.get(value["id"])
            if current["status"] == "running" and current["run_id"] == value["run_id"]:
                self._save_running(
                    value["id"],
                    value["run_id"],
                    model_runs=[*current["model_runs"], metadata][-100:],
                )

    def _check_model_signature(self, value: dict) -> None:
        if "model_signature" in value and hasattr(self.model, "configuration_signature"):
            if self.model.configuration_signature("material") != value["model_signature"]:
                raise AgentServiceError(
                    "connection_changed", "模型配置在分析期间已变化，请继续以重新分析。"
                )

    def _analyze_material_source(self, value, source, numbered, parts, save):
        """Reuse the existing bounded extraction protocol for any selected source."""
        chunks = source_chunks(numbered)
        if len(numbered) > SHORT_TEXT_CHARS:
            for index in range(len(parts), len(chunks)):
                chunk = chunks[index]
                analysis = self._call(
                    value, f"理解材料 {index + 1}/{len(chunks)}",
                    "ai-persona.material-analysis",
                    {
                        "output_schema": compact_schema(MaterialAnalysis.model_json_schema()),
                        "source": source, "segment": chunk,
                        "total_lines": len(numbered.splitlines()), "goal": value["messages"],
                    },
                    MaterialAnalysis, 6000,
                    validator=lambda parsed: check_analysis(parsed, chunk),
                )
                parts.append(analysis)
                save()
        return chunks

    def _material_payload(self, value: dict, store: PersonaStore) -> tuple[dict, dict, str]:
        source, coverage, text = self._source(value["material_id"])
        chunks = source_chunks(text)
        signature = (
            self.model.configuration_signature("material")
            if hasattr(self.model, "configuration_signature")
            else "test-model"
        )
        value["model_signature"] = signature
        key = hashlib.sha256(
            encoded(
                {
                    "prompt_version": PROMPT_VERSION,
                    "prompt_fingerprint": value["prompt_snapshot"]["fingerprint"],
                    "source": source,
                    "messages": value["messages"],
                    "allow_personal": value["allow_personal"],
                    "model": signature,
                }
            ).encode()
        ).hexdigest()
        checkpoint = value.get("checkpoint") or {}
        if checkpoint.get("key") != key:
            checkpoint = {
                "key": key,
                "parts": [],
                "read_ids": [],
                "source_reads": [],
                "search_queries": [],
                "persona_revision": self.query._revision(store),
            }
        candidate_key = hashlib.sha256(
            encoded(
                {
                    "persona_revision": self.query._revision(store),
                    "previous_draft": value["draft"],
                }
            ).encode()
        ).hexdigest()
        if checkpoint.get("candidate_key") != candidate_key:
            checkpoint.update(
                read_ids=[],
                source_reads=[],
                search_queries=[],
                persona_revision=self.query._revision(store),
                candidate_key=candidate_key,
            )
        value["source"], value["coverage"] = source, coverage
        coverage.update(
            chunks_total=len(chunks),
            chunks_done=len(checkpoint["parts"]),
            line_end=checkpoint["parts"][-1]["line_end"] if checkpoint["parts"] else 0,
        )
        coverage["complete"] = coverage["line_end"] == coverage["total_lines"]
        self._save_running(
            value["id"],
            value["run_id"],
            source=source,
            coverage=coverage,
            checkpoint=checkpoint,
            stage="准备材料文本",
        )
        def save_analysis():
            end = checkpoint["parts"][-1]["line_end"]
            coverage.update(line_end=end, chunks_done=len(checkpoint["parts"]),
                            complete=end == coverage["total_lines"])
            self._save_running(
                value["id"], value["run_id"], coverage=coverage, checkpoint=checkpoint
            )

        self._analyze_material_source(value, source, text, checkpoint["parts"], save_analysis)
        self._save_running(value["id"], value["run_id"], stage="匹配已有概念与证据")
        payload = self._payload(value, store)
        catalog = self._catalog(value, store)
        terms = [value["messages"][-1]["content"]]
        for part in checkpoint["parts"]:
            for concept in part["concepts"]:
                terms.extend([concept["name"], *concept["aliases"]])
        if not checkpoint["parts"]:
            terms.append(text)
        recalled = retrieve(catalog, terms)
        # A bounded catalog still includes every recalled item, rather than only its first page.
        ordered = sorted(catalog, key=lambda r: (r["id"] not in recalled, r["id"]))
        payload.update(
            catalog=ordered[:100],
            source=source,
            coverage=coverage,
            analysis_parts=checkpoint["parts"],
            search_results=[],
        )
        existing = {r["id"] for r in payload["records"]}
        for identifier in sorted(set(recalled + checkpoint["read_ids"]) - existing):
            payload["records"].append(self._record(value, store, identifier))
        if not checkpoint["parts"]:
            payload["source_text"] = text
            payload["exposed_ranges"] = [{"line_start": 1, "line_end": coverage["total_lines"]}]
        else:
            self._material_excerpts(payload, checkpoint, text)
        for query in checkpoint["search_queries"]:
            self._search_records(value, store, payload, query)
        return payload, checkpoint, text

    @staticmethod
    def _material_excerpts(payload: dict, checkpoint: dict, text: str) -> None:
        explicit, missing = excerpts(text, checkpoint["source_reads"])
        if missing:
            raise AgentServiceError("context_length", "请求补读的原文超过预算，请缩小整理范围。")
        ranges = [
            e
            for p in checkpoint["parts"]
            for item in [*p["concepts"], *p["claims"]]
            for e in item["evidence"]
        ]
        remaining = 45000 - sum(len(b["text"]) for b in explicit)
        automatic, skipped = excerpts(text, ranges, budget=remaining)
        payload["source_excerpts"] = explicit + automatic
        payload["exposed_ranges"] = [
            {k: b[k] for k in ("line_start", "line_end")} for b in explicit + automatic
        ]
        payload["omitted_evidence_ranges"] = skipped

    def _search_records(self, value: dict, store: PersonaStore, payload: dict, query: str) -> None:
        if not query.strip() or len(query) > 300:
            raise AgentServiceError("invalid_model_output", "补充检索词过长或为空。")
        catalog = self._catalog(value, store)
        ids = retrieve(catalog, [query], limit=12)
        payload["search_results"].append(
            {"query": query, "ids": ids, "method": "lexical_not_semantic"}
        )
        loaded = {r["id"] for r in payload["records"]}
        for identifier in set(ids) - loaded:
            payload["records"].append(self._record(value, store, identifier))

    def generate(self, session_id: str, run_id: str) -> dict:
        value = self.repository.get(session_id)
        if value.get("maintenance"):
            from .maintenance.service import run_session
            return run_session(self, session_id, run_id)
        if value["status"] != "running" or value["run_id"] != run_id:
            return value
        try:
            if not value.get("prompt_snapshot"):
                value = self._save_running(
                    session_id, run_id, prompt_snapshot=self.prompts.snapshot()
                )
            store = PersonaStore(self.data_root).load()
            checkpoint, source_text = {}, ""
            if value["material_id"]:
                payload, checkpoint, source_text = self._material_payload(value, store)
            else:
                payload = self._payload(value, store)
                cp_key = hashlib.sha256(
                    encoded(
                        {
                            "messages": value["messages"],
                            "prompt_fingerprint": value["prompt_snapshot"]["fingerprint"],
                            "draft": value["draft"],
                            "revision": self.query._revision(store),
                        }
                    ).encode()
                ).hexdigest()
                checkpoint = value.get("checkpoint") or {}
                if checkpoint.get("key") != cp_key:
                    checkpoint = {
                        "key": cp_key,
                        "read_ids": [],
                        "source_reads": [],
                        "search_queries": [],
                    }
                payload["records"].extend(
                    self._record(value, store, i)
                    for i in checkpoint["read_ids"]
                    if i not in {r["id"] for r in payload["records"]}
                )
            for round_index in range(3):
                payload["rounds_remaining"] = 3 - round_index
                draft = self._call(
                    value,
                    f"生成候选 {round_index + 1}/3",
                    "ai-persona.material-candidate" if source_text else "ai-persona.maintenance",
                    payload,
                    DraftOutput,
                    8000,
                )
                if source_text and not checkpoint["parts"]:
                    value["coverage"].update(
                        line_end=value["coverage"]["total_lines"], complete=True, chunks_done=1
                    )
                    self._save_running(session_id, run_id, coverage=value["coverage"])
                loaded_ids = {r["id"] for r in payload["records"]}
                requested = set(draft.read_ids) | {
                    c.target_id for c in draft.changes if c.target_id
                }
                if not requested <= set(store.records):
                    raise AgentServiceError("invalid_model_output", "模型请求了不存在的记录。")
                missing = requested - loaded_ids
                source_reads = [r.model_dump() for r in draft.source_reads]
                if source_text:
                    source_reads.extend(
                        {"line_start": e.line_start, "line_end": e.line_end}
                        for c in draft.changes
                        for e in c.evidence
                    )
                elif source_reads or draft.search_queries:
                    raise AgentServiceError(
                        "invalid_model_output", "此任务不支持原文补读或额外材料检索。"
                    )
                unseen = [
                    r
                    for r in source_reads
                    if not any(
                        span["line_start"] <= r["line_start"] <= r["line_end"] <= span["line_end"]
                        for span in payload.get("exposed_ranges", [])
                    )
                ]
                queries = [q for q in draft.search_queries if q not in checkpoint["search_queries"]]
                if not missing and not unseen and not queries:
                    break
                checkpoint["read_ids"] = sorted(set(checkpoint["read_ids"]) | requested)
                checkpoint["source_reads"] = list(
                    {encoded(r): r for r in [*checkpoint["source_reads"], *unseen]}.values()
                )
                checkpoint["search_queries"] = list(
                    dict.fromkeys([*checkpoint["search_queries"], *queries])
                )
                if (
                    len(checkpoint["read_ids"]) > 60
                    or len(checkpoint["source_reads"]) > 30
                    or len(checkpoint["search_queries"]) > 30
                ):
                    raise AgentServiceError("analysis_limit", "补读数量超过预算，请缩小整理范围。")
                payload["records"].extend(self._record(value, store, i) for i in sorted(missing))
                if source_text:
                    for query in queries:
                        self._search_records(value, store, payload, query)
                    if checkpoint["parts"]:
                        self._material_excerpts(payload, checkpoint, source_text)
                    elif unseen:
                        raise AgentServiceError("invalid_evidence", "证据超出本次材料原文。")
                self._save_running(
                    session_id, run_id, checkpoint=checkpoint, stage="补读相关记录与原文"
                )
            else:
                raise AgentServiceError(
                    "analysis_limit", "模型需要读取更多对象，请缩小维护范围后重试。"
                )
            self._save_running(session_id, run_id, stage="校验候选、版本与证据")
            latest = PersonaStore(self.data_root).load()
            if self.query._revision(latest) != self.query._revision(store):
                raise AgentServiceError(
                    "stale_record", "Persona 在分析期间已更新，请继续分析以重新匹配。"
                )
            if source_text and self._source(value["material_id"])[0] != value["source"]:
                raise AgentServiceError("stale_source", "原文在分析期间已变化，请重新分析。")
            draft_data = draft.model_dump(mode="json")
            draft_data["changes"] = self._validate_changes(draft, value, store)
            draft_data["read_ids"] = []
            draft_data["source_reads"] = []
            draft_data["search_queries"] = []
            current = self.repository.get(session_id)
            if current["status"] != "running" or current["run_id"] != run_id:
                return current
            ready = self.repository.update(
                session_id,
                {
                    "status": "ready",
                    "stage": "需要补充信息" if draft.questions else "候选校验完成",
                    "draft": draft_data,
                    "submission_key": None,
                    "base_revision": self.query._revision(store),
                    "source": value["source"],
                    "coverage": value["coverage"],
                    "messages": [*value["messages"], {"role": "assistant", "content": draft.reply}],
                },
                current["version"],
            )
            return self._auto_submit(ready)
        except Exception as exc:
            current = self.repository.get(session_id)
            if current["status"] != "running" or current["run_id"] != run_id:
                return current
            code = exc.code if isinstance(exc, AgentServiceError) else "analysis_failed"
            message = (
                str(exc)
                if isinstance(exc, (AgentServiceError, ProposalError))
                else "分析未完成，请重试。"
            )
            if code == "timeout":
                checkpoint = current.get("checkpoint") or {}
                completed = len(checkpoint.get("parts", [])) + sum(
                    len(parts) for parts in checkpoint.get("analyses", {}).values()
                )
                message += (
                    f" 已保存 {completed} 段完整分析；点击“继续分析”重试未完成阶段。"
                    if completed else
                    " 本轮尚无完整材料分段分析可保存；资料和需求仍保留，点击“继续分析”重试。"
                )
            return self.repository.update(
                session_id,
                {
                    "status": "failed",
                    "error": {"code": code, "message": message},
                },
                current["version"],
            )

    def edit(self, session_id: str, draft: dict, version: int) -> dict:
        value = self.get_session(session_id)
        if value["status"] in {"running", "submitting"}:
            raise AgentServiceError("busy", "请等待任务结束后再编辑。")
        self._require_refinable(value)
        cleaned = dict(draft)
        cleaned["changes"] = [
            {k: v for k, v in c.items() if k != "before"} for c in draft.get("changes", [])
        ]
        output = DraftOutput.model_validate(cleaned)
        store = PersonaStore(self.data_root).load()
        if value["base_revision"] != self.query._revision(store):
            raise AgentServiceError("stale_record", "Persona 已更新，请通过对话重新准备草稿。")
        if value.get("maintenance"):
            from .maintenance.service import validate_edit
            output = validate_edit(value, output, store)
            value = {**value, "source": None, "material_id": None}
        if value["material_id"] and self._source(value["material_id"])[0] != value["source"]:
            raise AgentServiceError("stale_source", "材料来源已变化，请重新分析后编辑。")
        content = output.model_dump(mode="json")
        content["changes"] = self._validate_changes(output, value, store)
        if value["submission"] and not content["changes"]:
            raise AgentServiceError("empty_draft", "如需放弃整组候选，请在待审核区拒绝。")
        saved = self.repository.update(
            session_id,
            {"draft": content, "status": "ready", "error": None, "submission_key": None},
            version,
        )
        return self._auto_submit(saved)

    def _auto_submit(self, value: dict) -> dict:
        if value["draft"]["changes"] and not value["draft"]["questions"]:
            try:
                return self.submit(value["id"], value["version"])
            except Exception as exc:
                current = self.repository.get(value["id"])
                # Do not overwrite a newer user action or a successfully recovered commit.
                if (
                    current["status"] not in {"ready", "submission_failed"}
                    or current["version"] not in {value["version"], value["version"] + 2}
                    or current["draft"] != value["draft"]
                ):
                    return self.get_session(value["id"])
                return self.repository.update(
                    value["id"],
                    {
                        "status": "submission_failed",
                        "stage": "候选已保存，尚未送审",
                        "error": {
                            "code": exc.code
                            if isinstance(exc, AgentServiceError)
                            else "submission_failed",
                            "message": str(exc)
                            if isinstance(exc, (AgentServiceError, ProposalError))
                            else "候选已保存，送审失败。可重试送审，无需重新调用模型。",
                        },
                    },
                    current["version"],
                )
        return self.get_session(value["id"])

    def cancel(self, session_id: str, version: int) -> dict:
        value = self.get_session(session_id)
        if value["status"] != "running":
            raise AgentServiceError("invalid_request", "只有运行中的分析可以取消。")
        if not value.get("run_start_version", value["version"]) <= version <= value["version"]:
            raise AgentServiceError("stale_draft", "分析已切换到新一轮，请刷新后再取消。")
        cancelled = self.repository.update(
            session_id, {"status": "cancelled"}, expected_run=value["run_id"]
        )
        try:
            self.model.cancel(value["run_id"])
        except (AgentServiceError, AttributeError):
            pass  # A cancelled draft never accepts late results, even if transport fails.
        return cancelled

    def submit(self, session_id: str, version: int) -> dict:
        value = self.get_session(session_id)
        if value["submission"] and value["status"] == "submitted":
            return value
        self._require_refinable(value)
        if (
            value["version"] != version
            or value["status"] not in {"ready", "submission_failed"}
            or not value["draft"]
        ):
            raise AgentServiceError("stale_draft", "请使用最新的已完成草稿提交。")
        if value["draft"]["questions"]:
            raise AgentServiceError("needs_input", "请先在对话中补充待澄清的信息。")
        store = PersonaStore(self.data_root).load()
        if self.query._revision(store) != value["base_revision"]:
            raise AgentServiceError("stale_record", "Persona 已更新，请重新准备草稿后提交。")
        if not value["draft"]["changes"]:
            raise AgentServiceError("empty_draft", "草稿没有需要提交的变化。")
        changes = []
        for candidate in value["draft"]["changes"]:
            payload = {k: v for k, v in candidate.items() if k != "before"}
            if candidate["operation"] == "relate":
                # Relation's record schema exposes evidence_refs in values, whereas
                # the proposal API accepts them at the change envelope level.
                payload["values"] = dict(candidate["values"])
                nested_refs = payload["values"].pop("evidence_refs", [])
                if not isinstance(nested_refs, list) or not all(
                    isinstance(ref, str) for ref in nested_refs
                ):
                    raise AgentServiceError("invalid_model_output", "关系证据引用必须是标识列表。")
                payload["evidence_refs"] = list(
                    dict.fromkeys([*payload.get("evidence_refs", []), *nested_refs])
                )
            changes.append(ProposalChangeInput.model_validate(payload))
        context = ProposalContext()
        if value.get("maintenance"):
            context = ProposalContext(kind="maintenance", source_versions=value["maintenance_sources"])
        elif value["source"]:
            context = ProposalContext(
                kind="material",
                **{k: value["source"][k] for k in ("material_id", "source_id", "source_hash")},
            )
        submission_key = (
            f"ai-draft:{session_id}:"
            + hashlib.sha256(
                encoded(
                    {
                        "draft": value["draft"],
                        "base_revision": value["base_revision"],
                        "source": value["source"],
                        "maintenance_sources": value.get("maintenance_sources"),
                    }
                ).encode()
            ).hexdigest()
        )
        reserved = self.repository.update(
            session_id,
            {
                "status": "submitting",
                "stage": "正在送入待审核区",
                "owner_pid": os.getpid(),
                "submission_key": submission_key,
            },
            version,
        )
        try:
            submission = sync_pending(
                PersonaProposalFacade(self.data_root, self.state_root),
                session_id=session_id,
                change_set_id=value["submission"]["change_set_id"] if value["submission"] else None,
                idempotency_key=submission_key,
                observed_persona_revision=value["base_revision"],
                summary=value["draft"]["reply"][:2000],
                changes=changes,
                proposal_context=context,
            )
        except Exception as exc:
            self.repository.update(
                session_id,
                {
                    "status": "submission_failed",
                    "stage": "候选已保存，尚未送审",
                    "error": {
                        "code": exc.code
                        if isinstance(exc, AgentServiceError)
                        else "submission_failed",
                        "message": str(exc)
                        if isinstance(exc, (AgentServiceError, ProposalError))
                        else "候选已保存，送审失败。可重试送审，无需重新调用模型。",
                    },
                },
                reserved["version"],
            )
            raise
        current = self.repository.get(session_id)
        if current["status"] == "submitted":
            return self.get_session(session_id)
        self.repository.update(
            session_id,
            {
                "status": "submitted",
                "stage": "已进入待审核区",
                "error": None,
                "submission": submission.model_dump(mode="json"),
                "review_origin": {
                    "change_set_id": submission.change_set_id,
                    "generation": ChangeSetRepository(self.data_root).get(submission.change_set_id).generation,
                    "run_id": value.get("run_id"),
                    "run_start_version": value.get("run_start_version"),
                    "message_count": len(value.get("messages", [])),
                    "source": value.get("source"), "coverage": value.get("coverage"),
                },
            },
            reserved["version"],
        )
        return self.get_session(session_id)
