from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import uuid
from pathlib import Path

from ..agent import AgentServiceError, PersonaProposalFacade
from ..change_sets import proposal_lock
from ..maintenance.compiler import PERSONAL, compile_candidates
from ..maintenance.contracts import MaintenanceInput
from ..models import ProposalContext
from ..proposals import ProposalError, ProposalRepository
from ..store import PersonaStore
from .contracts import Policy, ToolInput, output_contract
from .repository import Repository, event
from .sources import TEXT_FILE, import_source


def safe_error(exc):
    from ..material_imports.arxiv import ArxivImportError
    from ..materials import MaterialSourceError

    if isinstance(exc, AgentServiceError):
        return exc.message
    if isinstance(exc, (ArxivImportError, MaterialSourceError, ProposalError)):
        return str(exc)
    return "整理未完成。进度已保存，可继续；请检查 Codex 登录、网络和材料格式。"


def members(task):
    return [m for m in task["members"] if not m["removed"] and not m.get("duplicate_of")]


class ExtractionService:
    def __init__(self, data_root, state_root, backend=None):
        self.data_root, self.state_root = Path(data_root), Path(state_root)
        self.repository = Repository(self.state_root)
        self.backend = backend

    def store(self):
        # Reads verify the selected file; proposal submission verifies the complete store.
        # Rehashing every PDF on each progress poll would make large collections sluggish.
        return PersonaStore(self.data_root).load(verify_source_files=False)

    def recover_submission(self, task):
        if not task.get("submission_intent") or task["submissions"]:
            return False
        facade = PersonaProposalFacade(self.data_root, self.state_root)
        with proposal_lock(self.state_root):
            manifest = facade.change_sets.by_idempotency_key(
                f"extraction:{task['id']}:{task['revision']}"
            )
            if not manifest:
                return False
            task.update(
                submissions=[facade._submission_result(manifest).model_dump(mode="json")],
                status="review",
                phase_done=True,
                run_id=None,
                error=None,
            )
        event(task, "recovered", "已恢复上次保存的提案，无需再次生成。")
        return True

    @staticmethod
    def editable(task):
        if task["status"] in {"running", "importing"}:
            raise AgentServiceError("busy", "请先停止当前整理，再调整材料集合。")

    @staticmethod
    def revise(task):
        if task["draft"] or task["submissions"]:
            task.setdefault("history", []).append(
                {
                    "revision": task["revision"],
                    "draft": task["draft"],
                    "submissions": task["submissions"],
                }
            )
        task.update(
            revision=task["revision"] + 1, draft=None, submissions=[], status="draft", error=None
        )
        task.pop("submission_intent", None)

    def add(self, task_id, revision, **source):
        # Import work occurs outside the transaction; edits/runs are excluded until it finishes.
        with self.repository.edit(task_id, revision=revision) as task:
            self.recover_submission(task)
            self.editable(task)
            if len(members(task)) >= 20:
                raise AgentServiceError("limit", "每个集合最多 20 份材料。")
            previous_status = task["status"]
            task.update(status="importing", owner_pid=os.getpid())
        try:
            member = import_source(self.data_root, self.state_root, **source)
        except Exception as exc:
            with self.repository.edit(task_id) as task:
                task.update(status=previous_status, error=safe_error(exc), error_location="input")
                event(task, "import_failed", task["error"])
            raise
        with self.repository.edit(task_id) as task:
            self.revise(task)
            member["id"] = "member_" + uuid.uuid4().hex
            duplicate = next(
                (
                    m
                    for m in members(task)
                    if m["identity"] == member["identity"] or m["hash"] == member["hash"]
                ),
                None,
            )
            if duplicate:
                member.update(duplicate_of=duplicate["id"], status="duplicate")
            task["members"].append(member)
            task["ledger"]["material_metadata"][member["source_id"]] = member["metadata"]
            event(task, "imported", "已添加：" + member["title"], source_id=member["source_id"])
        return self.view(task_id)

    def modify(self, task_id, revision, *, policy=None, remove=None, retry=None, same_as=None):
        with self.repository.edit(task_id, revision=revision) as task:
            self.recover_submission(task)
            self.editable(task)
            self.revise(task)
            if policy is not None:
                value = Policy.model_validate(policy).model_dump()
                if value != task["policy"]:
                    event(
                        task,
                        "policy_changed",
                        f"整理设置已更新；新增知识点上限 {task['policy']['max_nodes']} → {value['max_nodes']}。",
                        before_max_nodes=task["policy"]["max_nodes"],
                        after_max_nodes=value["max_nodes"],
                    )
                    task["policy"] = value
                    for m in members(task):
                        m.update(analysis=None, status="ready", error=None)
            if remove or retry or same_as:
                mid = remove or retry or same_as[0]
                member = next((m for m in task["members"] if m["id"] == mid), None)
                if member is None:
                    raise AgentServiceError("not_found", "材料已不存在。")
                if remove:
                    member["removed"] = True
                    copies = [
                        m
                        for m in task["members"]
                        if not m["removed"] and m.get("duplicate_of") == mid
                    ]
                    if copies:
                        copies[0].pop("duplicate_of")
                        copies[0]["status"] = "ready"
                        for other in copies[1:]:
                            other["duplicate_of"] = copies[0]["id"]
                if retry:
                    checkpoint = member["analysis"]
                    member.update(
                        status="ready",
                        analysis=checkpoint if checkpoint and not checkpoint["complete"] else None,
                        error=None,
                    )
                if same_as:
                    primary = next(
                        (m for m in members(task) if m["id"] == same_as[1] and m["id"] != mid), None
                    )
                    if not primary:
                        raise AgentServiceError("invalid_request", "请选择集合中另一份有效材料。")
                    member.update(duplicate_of=primary["id"], status="duplicate")
                    for other in task["members"]:
                        if other.get("duplicate_of") == mid:
                            other["duplicate_of"] = primary["id"]
            event(task, "revised", "材料集合已更新；继续时将重新核对已有知识。")
        return self.view(task_id)

    def start(self, task_id, revision, *, partial=False, expected_max_nodes=None):
        with self.repository.edit(task_id, revision=revision) as task:
            if self.recover_submission(task):
                return None
            self.editable(task)
            if expected_max_nodes is not None and (
                type(expected_max_nodes) is not int
                or expected_max_nodes != task["policy"]["max_nodes"]
            ):
                raise AgentServiceError(
                    "policy_mismatch", "页面显示的知识点上限与已保存设置不一致，请核对后再开始。"
                )
            if not members(task):
                raise AgentServiceError("needs_input", "请先添加至少一份材料。")
            if task["submissions"]:
                raise AgentServiceError(
                    "already_submitted",
                    "本修订已提交，请先审核；新增或重试材料会建立新的结果修订。",
                )
            pending = ProposalRepository(self.data_root)
            for old in task.get("history", []):
                for submission in old["submissions"]:
                    if any(
                        pending.get(p["proposal_id"]).status == "pending_review"
                        for p in submission["proposals"]
                    ):
                        raise AgentServiceError(
                            "review_required",
                            "此集合上一版仍有待审核提案，请先处理，避免重复候选。",
                        )
            task.update(
                status="running",
                run_id=uuid.uuid4().hex,
                phase=None,
                error=None,
                error_location="run",
                owner_pid=os.getpid(),
                partial=partial,
                persona_revision=self.store().config.revision,
                tool_calls=0,
                phase_done=False,
            )
            # Record versions must be read again; immutable source excerpts remain reusable.
            task["ledger"]["records"] = {}
            task["run_policy"] = dict(task["policy"])
            event(
                task,
                "started",
                f"开始整理 {len(members(task))} 份材料；整个集合最多新增 {task['policy']['max_nodes']} 个知识点。",
                max_nodes=task["policy"]["max_nodes"],
                phase_timeout_seconds=task["policy"]["phase_timeout_seconds"],
            )
            run_id = task["run_id"]
        return run_id

    def cancel(self, task_id):
        with self.repository.edit(task_id) as task:
            if task["status"] == "running":
                task.update(
                    status="review" if task["submissions"] else "paused", run_id=None, error=None
                )
                for member in members(task):
                    if member["status"] == "running":
                        member["status"] = "ready"
                event(task, "paused", "已停止，已完成的分析和检查点保留。")
        if self.backend:
            self.backend.cancel(task_id)
        return self.view(task_id)

    def run(self, task_id, run_id):
        if run_id is None:
            return
        if self.backend is None:
            from ..demo import is_demo_data
            from .backend import CodexBackend

            self.backend = CodexBackend(
                codex_home=self.repository.root / "codex-demo"
                if is_demo_data(self.data_root)
                else None
            )
        try:
            with self.repository.edit(task_id, run_id=run_id) as task:
                task.update(phase="autonomous", phase_done=False)
                event(task, "reading", "Codex 正在自主安排阅读与跨材料整理。")
            self.backend.start(self, task_id, run_id, "autonomous")
            with self.repository.edit(task_id, run_id=run_id) as task:
                if not task["phase_done"]:
                    raise AgentServiceError(
                        "incomplete", "Codex 尚未通过工具提交结果；检查点已保存，可继续。"
                    )
                clarification = (task["draft"] or {}).get("kind") == "clarify"
                task.update(
                    status="review"
                    if task["submissions"]
                    else "paused"
                    if clarification
                    else "complete",
                    run_id=None,
                    error="请根据待核对问题补充整理目标，再继续。" if clarification else None,
                )
                event(
                    task,
                    "completed",
                    "结果已保存，等待审核。"
                    if task["submissions"]
                    else "整理完成，没有需要提交的变更。",
                )
        except Exception as exc:
            current = self.repository.get(task_id)
            if current["run_id"] == run_id and current["status"] == "running":
                with self.repository.edit(task_id, run_id=run_id) as task:
                    done = bool(task["submissions"])
                    task.update(
                        status="review" if done else "paused",
                        run_id=None,
                        error=None if done else safe_error(exc),
                    )
                    event(
                        task,
                        "completed" if done else "paused",
                        "提案已保存，等待审核。" if done else task["error"],
                    )

    def notify(self, task_id, run_id, message, **details):
        with self.repository.edit(task_id, run_id=run_id) as task:
            event(task, "agent", message, **details)

    def tool(self, task_id, run_id, raw, *, expected_phase=None):
        args = ToolInput.model_validate(raw)
        exhausted = False
        with self.repository.edit(task_id, run_id=run_id) as task:
            if expected_phase is not None and task["phase"] != expected_phase:
                raise AgentServiceError("cancelled", "此阶段已经结束。")
            exhausted = task["tool_calls"] >= 500
            if exhausted:
                task.update(
                    status="paused",
                    run_id=None,
                    error="本轮已达到 500 次工具操作上限，检查点已保留，可继续下一轮。",
                )
                for m in members(task):
                    if m["status"] == "running":
                        m["status"] = "ready"
                event(task, "paused", task["error"])
            else:
                # Attempts count even when validation in the following transaction fails.
                task["tool_calls"] += 1
        if exhausted:
            raise AgentServiceError("budget", "本轮已达到工具操作上限，检查点已保留。")
        if args.action == "page":
            # A first arXiv page request can fetch a PDF. Never hold the task lock over I/O.
            with self.repository.edit(task_id, run_id=run_id) as task:
                phase = task["phase"]
                if expected_phase is not None and expected_phase != phase:
                    raise AgentServiceError("cancelled", "此阶段已经结束。")
                member = next(
                    (
                        m
                        for m in members(task)
                        if m["source_id"] == args.source_id
                        and (
                            m["source_id"] == phase
                            or phase == "autonomous"
                            or phase == "merge"
                            and m["status"] == "complete"
                        )
                    ),
                    None,
                )
                if member is None:
                    raise AgentServiceError("out_of_scope", "此来源不在当前阶段范围内。")
            result = self.pdf_page(self.store(), member, args.page)
            with self.repository.edit(task_id, run_id=run_id) as task:
                if task["phase"] != phase:
                    raise AgentServiceError("cancelled", "此阶段已经结束，旧响应已丢弃。")
                event(
                    task,
                    "page",
                    f"已核对 {member['title']}：PDF 第 {args.page} 页。",
                    source_id=member["source_id"],
                )
            return result
        if args.action == "submit" and args.draft:
            # Persist intent before the cross-store proposal write. A process crash after
            # that write can recover by idempotency key, even if the task transaction rolls back.
            with self.repository.edit(task_id, run_id=run_id) as task:
                if task["phase"] not in {"merge", "autonomous"} or (
                    expected_phase is not None and task["phase"] != expected_phase
                ):
                    raise AgentServiceError("out_of_scope", "只有当前整合阶段可以提交结果。")
                if self.recover_submission(task):
                    return {"saved": True, "submissions": task["submissions"]}
                if task["submissions"] and task["draft"] != args.draft.model_dump():
                    raise AgentServiceError("already_submitted", "结果已经提交，不能覆盖。")
                self.validate_omissions(
                    args.draft.budget_omissions,
                    task,
                    {
                        m["source_id"]
                        for m in members(task)
                        if task["phase"] == "autonomous" or m["status"] == "complete"
                    },
                )
                task["draft"] = args.draft.model_dump()
                task["submission_intent"] = True
        with self.repository.edit(task_id, run_id=run_id) as task:
            if expected_phase is not None and task["phase"] != expected_phase:
                raise AgentServiceError("cancelled", "此阶段已经结束，旧响应不能修改下一阶段。")
            store = self.store()
            if store.config.revision != task["persona_revision"]:
                raise AgentServiceError(
                    "version_changed", "知识库已更新，请停止并继续整理，重新核对已有节点。"
                )
            if args.action == "schema":
                return output_contract()
            available = members(task)
            phase = task["phase"]
            allowed = [
                m
                for m in available
                if (
                    phase == "autonomous" and (not task.get("partial") or m["status"] == "complete")
                )
                or phase == "merge"
                and m["status"] == "complete"
                or m["source_id"] == phase
            ]
            member = next((m for m in allowed if m["source_id"] == args.source_id), None)
            if args.source_id and not member:
                raise AgentServiceError("out_of_scope", "此来源不在当前任务阶段的读取范围内。")
            if args.action == "overview":
                if member:
                    analysis = member["analysis"] or {}
                    return {
                        "origin": member["source_id"],
                        "title": member["title"],
                        "metadata": member["metadata"],
                        "url": member["url"],
                        "version": member["version"],
                        "sections": member["index"]["sections"][
                            args.start - 1 : args.start - 1 + args.count
                        ],
                        "section_total": len(member["index"]["sections"]),
                        "line_count": member["index"]["line_count"],
                        "warnings": member["warnings"],
                        "analysis_summary": analysis.get("summary"),
                        "limitations": analysis.get("limitations", []),
                        "budget_omissions": analysis.get("budget_omissions", []),
                        "candidates": analysis.get("changes", [])[
                            args.start - 1 : args.start - 1 + min(args.count, 10)
                        ],
                        "candidate_total": len(analysis.get("changes", [])),
                    }
                if not any(
                    e.get("kind") == "policy_used"
                    and e.get("run_id") == run_id
                    and e.get("phase") == phase
                    for e in task["events"]
                ):
                    event(
                        task,
                        "policy_used",
                        f"当前整理设置：整个集合最多新增 {task['policy']['max_nodes']} 个知识点。",
                        run_id=run_id,
                        phase=phase,
                        max_nodes=task["policy"]["max_nodes"],
                    )
                return {
                    "origin": "application:task",
                    "phase": phase,
                    "policy": task["policy"],
                    "sources": [
                        {
                            "origin": m["source_id"],
                            "title": m["title"],
                            "status": m["status"],
                            "version": m["version"],
                            "summary": (m["analysis"] or {}).get("summary", "")[:400],
                        }
                        for m in allowed
                    ],
                    "excluded": [
                        {"title": m["title"], "status": m["status"]}
                        for m in available
                        if m not in allowed
                    ],
                    "draft": {
                        "summary": (task["draft"] or {}).get("summary"),
                        "changes": (task["draft"] or {}).get("changes", [])[
                            args.start - 1 : args.start - 1 + 10
                        ],
                    },
                }
            if args.action == "find_records":
                query = args.query.casefold().strip()
                hits = [
                    r.record
                    for r in store.records.values()
                    if r.record.entity_type in {"knowledge_node", "material", "relation"}
                    and r.record.status == "active"
                    and (
                        not query
                        or query
                        in json.dumps(
                            {
                                k: v
                                for k, v in r.record.model_dump(mode="json").items()
                                if k not in PERSONAL
                            },
                            ensure_ascii=False,
                        ).casefold()
                    )
                ]
                return {
                    "origin": "persona:index",
                    "items": [
                        {
                            "origin": r.id,
                            "id": r.id,
                            "title": getattr(r, "title", None),
                            "aliases": getattr(r, "aliases", []),
                            "entity_type": r.entity_type,
                            "source_id": getattr(r, "source_id", None),
                            "target_id": getattr(r, "target_id", None),
                            "source_ref": getattr(r, "source_ref", None),
                        }
                        for r in hits[args.start - 1 : args.start - 1 + min(args.count, 30)]
                    ],
                    "total": len(hits),
                }
            if args.action == "record":
                loaded = store.records.get(args.record_id)
                if not loaded or loaded.record.entity_type not in {
                    "knowledge_node",
                    "material",
                    "relation",
                }:
                    raise AgentServiceError("out_of_scope", "只能读取相关知识、关系和材料记录。")
                record = loaded.record.model_dump(mode="json", by_alias=True)
                # Personal state is not needed to identify academic entities.
                record = {k: v for k, v in record.items() if k not in PERSONAL}
                if len(json.dumps(record)) > 30000:
                    raise AgentServiceError(
                        "record_too_large", "记录过长，暂不能自动修改；请保留为待核对项。"
                    )
                task["ledger"]["records"][args.record_id] = loaded.record.revision
                return {"origin": args.record_id, "record": record}
            if args.action in {"read", "search", "page"}:
                if not member:
                    raise AgentServiceError("needs_input", "请指定 source_id。")
                manifest = store.sources[member["source_id"]]
                if manifest.content_hash != member["hash"]:
                    raise AgentServiceError("source_changed", "来源已改变，请重新导入。")
                if args.action == "page":
                    return self.pdf_page(store, member, args.page)
                content = store.source_file_path(member["source_id"], TEXT_FILE).read_bytes()
                declared = next(f for f in manifest.files if f.path == TEXT_FILE)
                if hashlib.sha256(content).hexdigest() != declared.sha256:
                    raise AgentServiceError("source_changed", "来源文本已改变，请重新导入。")
                lines = content.decode("utf-8").splitlines()
                if args.action == "search":
                    if not args.query.strip():
                        raise AgentServiceError("needs_input", "请输入检索词。")
                    hits = [
                        {"origin": member["source_id"], "line": i + 1, "text": line}
                        for i, line in enumerate(lines)
                        if args.query.casefold() in line.casefold()
                    ]
                    return {
                        "origin": member["source_id"],
                        "hits": hits[args.start - 1 : args.start - 1 + min(args.count, 30)],
                        "total": len(hits),
                        "note": "搜索片段不是证据；请用 read 获取完整、可引用的行。",
                    }
                selected, size = [], 0
                for line in lines[args.start - 1 : args.start - 1 + args.count]:
                    if size + len(line) > 18000:
                        break
                    selected.append(line)
                    size += len(line)
                if not selected:
                    raise AgentServiceError("invalid_range", "行号超出材料范围。")
                end = args.start + len(selected) - 1
                excerpt = dict(
                    source_id=member["source_id"],
                    file=TEXT_FILE,
                    line_start=args.start,
                    line_end=end,
                    source_hash="sha256:" + manifest.content_hash,
                    text="\n".join(selected),
                    kind="material",
                )
                ref = (
                    "b_"
                    + hashlib.sha256(json.dumps(excerpt, sort_keys=True).encode()).hexdigest()[:20]
                )
                task["ledger"]["basis"][ref] = excerpt
                task["ledger"]["coverage"].setdefault(member["source_id"], []).append(
                    [args.start, end]
                )
                event(
                    task,
                    "read",
                    f"已读取 {member['title']}：第 {args.start}–{end} 行。",
                    source_id=member["source_id"],
                )
                return {
                    "origin": member["source_id"],
                    "file": TEXT_FILE,
                    "version": member["version"],
                    "start": args.start,
                    "end": end,
                    "next_start": end + 1 if end < len(lines) else None,
                    "basis_ref": ref,
                    "text": excerpt["text"],
                }
            if args.action == "checkpoint":
                if phase in {"merge", "autonomous"} and args.draft:
                    self.validate_omissions(
                        args.draft.budget_omissions, task, {m["source_id"] for m in allowed}
                    )
                    task["draft"] = args.draft.model_dump()
                    return {"saved": True, "submitted": False}
                if (
                    not member
                    or (phase != "autonomous" and member["source_id"] != phase)
                    or not args.analysis
                ):
                    raise AgentServiceError("needs_input", "请为当前来源提供 analysis。")
                if args.analysis.complete and not task["ledger"]["coverage"].get(
                    member["source_id"]
                ):
                    raise AgentServiceError("read_required", "保存完整分析前，请先读取原文片段。")
                if (
                    phase != "autonomous"
                    and args.analysis.complete
                    and task["policy"].get("reading") == "full"
                ):
                    intervals = sorted(task["ledger"]["coverage"].get(member["source_id"], []))
                    end = 0
                    for left, right in intervals:
                        if left > end + 1:
                            break
                        end = max(end, right)
                    if end < member["index"]["line_count"]:
                        raise AgentServiceError(
                            "read_required", f"全文模式尚未读完，请从第 {end + 1} 行继续。"
                        )
                self.validate_scope(args.analysis.changes, task, {member["source_id"]})
                self.validate_omissions(args.analysis.budget_omissions, task, {member["source_id"]})
                member["analysis"] = args.analysis.model_dump()
                member["status"] = "complete" if args.analysis.complete else "running"
                if phase != "autonomous":
                    task["phase_done"] = args.analysis.complete
                event(task, "checkpoint", "分析检查点已保存。", source_id=member["source_id"])
                return {"saved": True, "complete": args.analysis.complete, "submitted": False}
            if args.action == "submit":
                if phase not in {"merge", "autonomous"} or not args.draft:
                    raise AgentServiceError("out_of_scope", "只有整合阶段可以提交最终 draft。")
                return self.submit(task, store, args.draft, allowed)
        raise AgentServiceError("invalid_tool", "未知操作。")

    @staticmethod
    def validate_scope(changes, task, source_ids):
        for c in changes:
            if c.entity_type not in {
                "knowledge_node",
                "material",
                "relation",
            } or c.operation not in {"create", "update", "relate"}:
                raise AgentServiceError("out_of_scope", "材料整理只能新增或补充知识、材料与关系。")
            if any(k in c.values for k in PERSONAL):
                raise AgentServiceError(
                    "personal_scope", "材料提取不能设置个人阅读、掌握、兴趣或偏好状态。"
                )
            if not c.basis:
                raise AgentServiceError("evidence_required", "每项候选都需要已读取的来源依据。")
            for basis in c.basis:
                item = task["ledger"]["basis"].get(basis.ref)
                if not item or item["source_id"] not in source_ids:
                    raise AgentServiceError(
                        "invalid_evidence", "候选引用了未读取或不在结果范围内的依据。"
                    )

    @staticmethod
    def validate_omissions(omissions, task, source_ids):
        for omission in omissions:
            for basis in omission.basis:
                item = task["ledger"]["basis"].get(basis.ref)
                if not item or item["source_id"] not in source_ids:
                    raise AgentServiceError(
                        "invalid_evidence",
                        "因上限暂缓的概念也需要已读取、且属于当前结果的原文依据。",
                    )

    def submit(self, task, store, draft, included):
        if task["submissions"]:
            if task["draft"] != draft.model_dump():
                raise AgentServiceError("already_submitted", "结果已提交，不能覆盖已保存的提案。")
            return {"saved": True, "submissions": task["submissions"]}
        source_ids = {m["source_id"] for m in included}
        self.validate_scope(draft.changes, task, source_ids)
        self.validate_omissions(draft.budget_omissions, task, source_ids)
        if (
            len(
                [
                    c
                    for c in draft.changes
                    if c.entity_type == "knowledge_node" and c.operation == "create"
                ]
            )
            > task["policy"]["max_nodes"]
        ):
            raise AgentServiceError(
                "too_many_nodes", "新增知识点超过用户设置的上限；请合并、筛选，保留延后项。"
            )
        collect = sorted(source_ids) if task["policy"]["collect_materials"] else []
        spec = MaintenanceInput(
            target_types=["knowledge_node", "material"], collect_attachment_ids=collect
        )
        changes = compile_candidates(draft, spec, store, task["ledger"])
        if draft.kind == "clarify":
            task.update(draft=draft.model_dump(), phase_done=True)
            return {"saved": True, "questions": draft.questions, "submitted": False}
        if changes:
            facade = PersonaProposalFacade(self.data_root, self.state_root)
            with proposal_lock(self.state_root):
                if self.store().config.revision != task["persona_revision"]:
                    raise AgentServiceError("version_changed", "知识库已更新，请重新核对后提交。")
                result = facade._propose_change_set_locked(
                    idempotency_key=f"extraction:{task['id']}:{task['revision']}",
                    observed_persona_revision=task["persona_revision"],
                    summary=draft.summary[:4000],
                    changes=changes,
                    proposal_context=ProposalContext(
                        kind="maintenance",
                        source_versions={
                            sid: "sha256:" + store.sources[sid].content_hash for sid in source_ids
                        },
                    ),
                    max_changes=300,
                    max_inline_evidence=600,
                )
            task["submissions"] = [result.model_dump(mode="json")]
        for member in included:
            if task["ledger"]["coverage"].get(member["source_id"]):
                member["status"] = "complete"
        task.update(draft=draft.model_dump(), phase_done=True, result_sources=sorted(source_ids))
        event(task, "submitted", f"已保存 {len(changes)} 项待审核变更；正式知识库尚未改变。")
        return {"saved": True, "submissions": task["submissions"], "no_change": not changes}

    def pdf_page(self, store, member, number):
        import pypdfium2 as pdfium

        from ..query_sources import _pdf_lock

        manifest = store.sources[member["source_id"]]
        file = next((f for f in manifest.files if f.media_type == "application/pdf"), None)
        if file:
            pdf_content = store.source_file_path(member["source_id"], file.path).read_bytes()
            if hashlib.sha256(pdf_content).hexdigest() != file.sha256:
                raise AgentServiceError("source_changed", "PDF 内容已改变，请重新导入。")
        elif member["identity"].startswith("arxiv:"):
            from ..material_imports.arxiv import _read_official_url, normalize_arxiv_input
            from ..materials import MAX_SOURCE_BYTES

            normalized = normalize_arxiv_input(member["identity"][6:])
            url = "https://arxiv.org/pdf/" + normalized.requested_id
            folder = self.repository.root / "pdf" / member["source_id"]
            folder.mkdir(parents=True, exist_ok=True)
            path, meta = folder / "paper.pdf", folder / "metadata.json"
            if path.is_file() and meta.is_file():
                pdf_content = path.read_bytes()
                metadata = json.loads(meta.read_text(encoding="utf-8"))
                if (
                    metadata["url"] != url
                    or hashlib.sha256(pdf_content).hexdigest() != metadata["sha256"]
                ):
                    raise AgentServiceError(
                        "source_changed", "PDF 核对副本已改变，请重新导入材料。"
                    )
            else:
                pdf_content, _ = _read_official_url(
                    url, max_bytes=MAX_SOURCE_BYTES, accept="application/pdf"
                )
                if not pdf_content.startswith(b"%PDF-"):
                    raise AgentServiceError("invalid_pdf", "arXiv 没有返回有效 PDF。")
                temporary = folder / (uuid.uuid4().hex + ".tmp")
                temporary.write_bytes(pdf_content)
                temporary.replace(path)
                metadata = {"url": url, "sha256": hashlib.sha256(pdf_content).hexdigest()}
                temporary.write_text(json.dumps(metadata), encoding="utf-8")
                temporary.replace(meta)
        else:
            raise AgentServiceError("no_pdf", "此来源没有 PDF；请读取文本片段。")
        with _pdf_lock:
            document = pdfium.PdfDocument(pdf_content)
            try:
                if number > len(document):
                    raise AgentServiceError("invalid_range", "PDF 页码超出范围。")
                page = document[number - 1]
                try:
                    bitmap = page.render(scale=min(1.5, 1400 / max(page.get_size())))
                    try:
                        output = io.BytesIO()
                        bitmap.to_pil().save(output, format="PNG")
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            finally:
                document.close()
        return {
            "origin": member["source_id"],
            "page": number,
            "version": member["version"],
            "pdf_hash": "sha256:" + hashlib.sha256(pdf_content).hexdigest(),
            "image": base64.b64encode(output.getvalue()).decode(),
            "note": "用于核对版式、图表和公式。扫描图内容不能冒充可引用的文本行；没有文本证据的结论放入 limitations。",
        }

    def view(self, task_id):
        task = self.repository.get(task_id)
        if task.get("submission_intent") and not task["submissions"]:
            with self.repository.edit(task_id) as current:
                if self.recover_submission(current):
                    task = current.copy()
        store = self.store()
        task.pop("ledger", None)
        task.pop("run_id", None)
        task.pop("owner_pid", None)
        # Review status is authoritative, including later edits/acceptance/rejection.
        repository = ProposalRepository(self.data_root)
        statuses = {}
        for group in task["submissions"]:
            for p in group["proposals"]:
                proposal = repository.get(p["proposal_id"])
                p["status"] = proposal.status
                statuses[p["client_ref"]] = {
                    "status": proposal.status,
                    "proposal_id": proposal.id,
                    "candidate_record_id": p["candidate_record_id"],
                }
        graph = {"nodes": [], "edges": []}
        changes = (task["draft"] or {}).get("changes", []) if task["submissions"] else []
        nodes = {}
        for change in changes:
            values, ref = change["values"], change["client_ref"]
            status = statuses.get(ref, {})
            rid = status.get("candidate_record_id")
            if status.get("status") in {"accepted", "edited_and_accepted"} and rid in store.records:
                values = store.records[rid].record.model_dump(mode="json")
            detail = {**change, **status, "values": values}
            if change["entity_type"] == "relation":
                graph["edges"].append(
                    {
                        "id": ref,
                        "source": values.get("source_ref", values.get("source_id")),
                        "target": values.get("target_ref", values.get("target_id")),
                        "label": values.get("relation_type"),
                        "detail": detail,
                    }
                )
            else:
                nodes[ref] = {
                    "id": ref,
                    "record_id": rid,
                    "title": values.get("title", ref),
                    "kind": change["entity_type"],
                    "detail": detail,
                }
        id_to_ref = {n["record_id"]: n["id"] for n in nodes.values() if n["record_id"]}
        # Incremental/no-change results still show the reviewed graph of the included papers.
        # Proposal-backed elements win over these background records.
        included_sources = set(task.get("result_sources", []))
        material_ids = {
            r.record.id
            for r in store.records.values()
            if r.record.entity_type == "material"
            and r.record.status == "active"
            and r.record.source_ref in included_sources
        }
        known_relations = [
            r.record
            for r in store.records.values()
            if r.record.entity_type == "relation" and r.record.status == "active"
        ]
        relevant_ids = set(material_ids)
        relevant_ids.update(
            r.target_id
            for r in known_relations
            if r.source_id in material_ids and r.relation_type == "covers"
        )
        omitted = max(0, len(relevant_ids) - 200)
        relevant_ids = set(
            sorted(relevant_ids, key=lambda rid: (rid not in material_ids, rid))[:200]
        )
        for rid in relevant_ids:
            if rid in id_to_ref:
                continue
            r = store.records[rid].record
            nodes[rid] = {
                "id": rid,
                "record_id": rid,
                "title": r.title,
                "kind": r.entity_type,
                "detail": {
                    "status": "existing",
                    "record_id": rid,
                    "entity_type": r.entity_type,
                    "values": {
                        k: v for k, v in r.model_dump(mode="json").items() if k not in PERSONAL
                    },
                },
            }
        changed_relation_ids = {
            d.get("target_id") for d in changes if d["entity_type"] == "relation"
        }
        candidate_relation_ids = {v["candidate_record_id"] for v in statuses.values()}
        for r in known_relations:
            if (
                r.id in changed_relation_ids
                or r.id in candidate_relation_ids
                or not {r.source_id, r.target_id} <= relevant_ids
            ):
                continue
            graph["edges"].append(
                {
                    "id": r.id,
                    "source": r.source_id,
                    "target": r.target_id,
                    "label": r.relation_type,
                    "detail": {
                        "status": "existing",
                        "entity_type": "relation",
                        "values": r.model_dump(mode="json"),
                    },
                }
            )
        if omitted:
            graph["notice"] = (
                f"本次预览显示最多 200 个已有节点，另有 {omitted} 个可在正式知识图查看。待审核变更仍完整列出。"
            )
        for edge in graph["edges"]:
            for key in ["source", "target"]:
                rid = edge[key]
                edge[key] = id_to_ref.get(rid, rid)
                if edge[key] not in nodes and rid in store.records:
                    r = store.records[rid].record
                    nodes[rid] = {
                        "id": rid,
                        "record_id": rid,
                        "title": getattr(r, "title", rid),
                        "kind": r.entity_type,
                        "detail": {
                            "status": "existing",
                            "values": {"title": getattr(r, "title", rid)},
                        },
                    }
        graph["nodes"] = list(nodes.values())
        task["graph"] = graph
        ledger = self.repository.get(task_id)["ledger"]
        for member in task["members"]:
            ranges = ledger["coverage"].get(member["source_id"], [])
            covered = set(i for a, b in ranges for i in range(a, b + 1))
            member["coverage"] = {
                "read_lines": len(covered),
                "total_lines": member["index"]["line_count"],
            }
            member["unread_sections"] = [
                s["title"]
                for s in member["index"]["sections"]
                if not any(i in covered for i in range(s["start"], s["end"] + 1))
            ]
            member.pop("analysis", None)
        evidence_items = [*changes, *(task.get("draft") or {}).get("budget_omissions", [])]
        evidence_refs = {b["ref"] for c in evidence_items for b in c.get("basis", [])}
        task["evidence"] = {
            ref: {**{k: v for k, v in item.items() if k != "text"}, "text": item["text"][:2000]}
            for ref, item in ledger["basis"].items()
            if ref in evidence_refs
        }
        return task
