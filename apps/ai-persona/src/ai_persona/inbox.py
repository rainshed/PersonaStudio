"""Source-aware Studio inbox. A projection, not another task or feedback database."""
from __future__ import annotations

import base64
import json
import math
import re
import sqlite3
import time
from collections import Counter
from datetime import datetime, timedelta
from urllib.parse import urlencode

from .agent import AgentServiceError
from .candidate_review import CandidateReview
from .change_sets import ChangeSetRepository
from .conversation_learning.contracts import digest
from .conversation_learning.input_text import learning_text
from .conversation_learning.review import LearningReview
from .conversation_learning.views import LearningViews
from .evaluations.contracts import ACTIVATION
from .evaluations.store import EvaluationStore
from .models import PreferenceContext
from .proposals import ProposalError, ProposalRepository
from .review import proposal_presentation
from .store import PersonaStore
from .studio_locale import studio_text

TYPES = {"learning", "activation", "material", "maintenance", "proposal"}
OPEN = {"pending_review", "deferred"}
REF = re.compile(r"^(learning|application|assistant|change_set|proposal|result):[A-Za-z0-9_-]{1,160}$")


def stamp(value):
    return float(value) if isinstance(value, (int, float)) else datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def feedback_summary(result, *, supported, unavailable=False):
    if not supported:
        return {"supported": False, "state": "not_applicable", "total": 0, "rated": 0, "unrated": 0, "revision": 0}
    if unavailable:
        return {"supported": True, "state": "unavailable", "total": 0, "rated": 0, "unrated": 0, "revision": 0}
    decisions = [d for d in (result or {}).get("decisions", []) if type(d.get("triggered")) is bool]
    subjects = (result or {}).get("feedback", {}).get("subjects", {}).values()
    ratings = [f["rating"] for f in subjects if f.get("active") and any(f["subject"] == d["subject"] for d in decisions)]
    state = "waiting" if not decisions else "unrated" if not ratings else "partial" if len(ratings) < len(decisions) else "unsatisfied" if "unsatisfied" in ratings else "satisfied"
    return {"supported": True, "state": state, "total": len(decisions), "rated": len(ratings),
            "unrated": len(decisions) - len(ratings), "has_unsatisfied": "unsatisfied" in ratings,
            "revision": (result or {}).get("feedback", {}).get("revision", 0)}


def sqlite_rows(path, sql):
    if not path.exists():
        return []
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        return [json.loads(row[0]) for row in db.execute(sql)]
    finally:
        db.close()


class InboxService:
    def __init__(self, data_root, state_root, learning, locale="zh-CN"):
        self.data_root, self.state_root, self.learning = data_root, state_root, learning
        self.locale = locale
        self.evaluations = EvaluationStore(data_root, state_root)

    def collect(self):
        warnings = []

        def read(name, fn, fallback):
            try:
                return fn()
            except Exception:
                warnings.append(name + "暂不可读取；相关记录或状态可能不完整，请重试。")
                return fallback

        repo = ProposalRepository(self.data_root)
        # Failure here must not look like an empty review queue.
        proposals = {p.id: p for p in [*repo.list_history(limit=None), *repo.list_pending()]}
        manifests = ChangeSetRepository(self.data_root).list()
        store = PersonaStore(self.data_root).load(verify_source_files=False)
        results = read("反馈数据", self.evaluations.inbox_summaries, {})
        feedback_unavailable = bool(warnings)
        names = read("来源名称", lambda: {c.id: c.name for c in self.learning.repository.connections()}, {})

        def event_rows():
            with self.learning.repository.connect() as db:
                return [dict(r) for r in db.execute("SELECT * FROM events ORDER BY created DESC,id DESC")]

        events = read("对话学习", event_rows, [])
        applications = read("偏好应用", lambda: sqlite_rows(self.state_root / "preference-applications.sqlite3", "SELECT json_set(body,'$._turn_identity',identity) FROM applications ORDER BY created DESC"), [])
        sessions = read("维护任务", lambda: sqlite_rows(self.state_root / "ai-assistant.sqlite3", "SELECT body FROM drafts ORDER BY rowid DESC"), [])
        session_by_id = {s["id"]: s for s in sessions}
        by_change = {m.id: m for m in manifests}
        items, used_changes, used_proposals, used_results, task_refs = [], set(), set(), set(), set()

        def add(ref, kind, text, created, source, status, *, result=None, result_id=None,
                supported=False, change=None, selected=None, raw=None, source_url=None, turn=None):
            members = [proposals[link.proposal_id] for link in change.proposal_links] if change else selected or []
            used_proposals.update(p.id for p in members)
            if change:
                used_changes.add(change.id)
            if result_id:
                used_results.add(result_id)
            counts = Counter(p.status for p in members)
            decisions = [d for d in (result or {}).get("decisions", []) if type(d.get("triggered")) is bool]
            normalized = learning_text(text or "")
            material_ids = {p.proposal_context.material_id for p in members if p.proposal_context and p.proposal_context.material_id}
            if (raw or {}).get("material_id"):
                material_ids.add(raw["material_id"])
            materials = [{"id": i, "name": getattr(store.records[i].record, "title", i) if i in store.records else i} for i in sorted(material_ids)]
            items.append({"id": ref, "type": kind, "input_preview": normalized[:180],
                          "created": stamp(created), "source_name": source, "status": status,
                          "result_id": result_id, "feedback": feedback_summary(result, supported=supported, unavailable=feedback_unavailable),
                          "triggered": decisions[0]["triggered"] if kind == "learning" and len(decisions) == 1 else None,
                          "matched_count": sum(d["triggered"] for d in decisions) if kind == "activation" else None,
                          "review": {"total": len(members), "pending": sum(counts[s] for s in OPEN), "statuses": dict(counts)},
                          "review_key": change.id if change else members[0].id if members else None,
                          "generation": change.generation if change else None,
                          "materials": materials, "context_keys": (result or {}).get("context_keys", []),
                          "_pending_ids": [p.id for p in members if p.status in OPEN], "_turn": turn,
                          "source_url": source_url, "_text": normalized, "_raw": raw, "_result": result})

        views = LearningViews(self.learning)
        for event in events:
            item, text, _ = views._project(event, results, feedback_unavailable, names)
            result = results.get(item["current_result_id"])
            task_refs.add(event["id"])
            add("learning:" + event["id"], "learning", text, event["created"], item["source_name"], event["status"],
                result=result, result_id=item["current_result_id"], supported=True,
                change=by_change.get(event["change_set_id"]), raw=event,
                turn=(event["connection_id"], event["external_id"][6:]) if event["external_id"].startswith("codex_") else None)
            items[-1]["input_state"] = item["input_state"]

        for row in applications:
            task_refs.add(row["id"])
            if row["status"] in {"running", "prepared"} and row.get("deadline", float("inf")) < time.time():
                row = {**row, "status": "failed", "error_code": "timeout"}
            add("application:" + row["id"], "activation", row["request"].get("user_prompt", ""), row["created_at"],
                row["request"].get("connection_name", "偏好应用"), row["status"],
                result=results.get(row.get("result_id")), result_id=row.get("result_id"), supported=True, raw=row,
                turn=(row["request"].get("connection_id"), row.get("_turn_identity")))

        for session in sessions:
            if not session.get("messages") and not session.get("submission"):
                continue
            change = next((m for m in manifests if m.assistant_session_id == session["id"]), None)
            # A changeset summary identifies the actual generated batch, not a later user turn.
            text = change.summary if change else session["title"]
            add("assistant:" + session["id"], "material" if session.get("material_id") else "maintenance",
                text, session["created_at"], "AI 维护助手", session["status"], change=change, raw=session,
                source_url="/ai?session=" + session["id"])

        for manifest in manifests:
            if manifest.id in used_changes:
                continue
            session = session_by_id.get(manifest.assistant_session_id)
            kind = "material" if session and session.get("material_id") else "maintenance" if manifest.assistant_session_id else "proposal"
            add("change_set:" + manifest.id, kind, manifest.summary, manifest.created_at.isoformat(),
                "AI／MCP 提案", "completed", change=manifest,
                raw=session, source_url="/ai?session=" + manifest.assistant_session_id if manifest.assistant_session_id else None)

        for proposal in proposals.values():
            if proposal.id in used_proposals or (proposal.submitted_by != "ai" and proposal.status not in OPEN):
                continue
            title = proposal_presentation(proposal, store, "zh-CN")["title"]
            add("proposal:" + proposal.id, "proposal", title, proposal.created_at.isoformat(),
                "独立候选", "completed", selected=[proposal])

        for result in results.values():
            if result["id"] in used_results or result["task_ref"] in task_refs:
                continue
            # Manual scene tests and retained cases with an expired source stay reachable.
            add("result:" + result["id"], "activation" if result["capability_id"] == ACTIVATION else "learning",
                result["input_text"], result["created_at"], "已保存结果", result["state"],
                result=result, result_id=result["id"], supported=True)
        by_turn = {}
        for item in items:
            turn = item["_turn"]
            if turn and turn[1]:
                by_turn.setdefault(turn, []).append(item)
        for item in items:
            item["related"] = [
                {"id": other["id"], "type": other["type"]}
                for other in by_turn.get(item["_turn"], ())
                if other["id"] != item["id"]
            ]
        return items, warnings

    @staticmethod
    def public(item):
        return {k: v for k, v in item.items() if not k.startswith("_")}

    def list(self, query):
        filters = {k: query.get(k, default) for k, default in (("view", "review"), ("type", ""), ("q", ""), ("feedback", ""), ("status", ""), ("source", ""), ("from", ""), ("to", ""), ("order", "newest"), ("material", ""), ("context", ""))}
        try:
            limit = int(query.get("limit", 20))
            if not 1 <= limit <= 100 or filters["view"] not in {"review", "feedback", "all"} or filters["type"] not in {"", *TYPES} or filters["feedback"] not in {"", "rated", "unrated", "satisfied", "unsatisfied"} or filters["status"] not in {"", "failed", "running", "reviewed"} or any(len(v) > 300 for v in filters.values()):
                raise ValueError()
            if filters["order"] not in {"newest", "oldest"}:
                raise ValueError()
            start = datetime.strptime(filters["from"], "%Y-%m-%d").timestamp() if filters["from"] else None
            end = (datetime.strptime(filters["to"], "%Y-%m-%d") + timedelta(days=1)).timestamp() if filters["to"] else None
            if start is not None and end is not None and start >= end:
                raise ValueError()
            signature = digest([filters, limit])
            boundary, after = time.time(), None
            if query.get("cursor"):
                if len(query["cursor"]) > 2000:
                    raise ValueError()
                token = json.loads(base64.urlsafe_b64decode(query["cursor"]))
                boundary, after = token["boundary"], token["after"]
                if token["query"] != signature or not math.isfinite(boundary) or (after is not None and (len(after) != 2 or not math.isfinite(after[0]) or not REF.fullmatch(after[1]))):
                    raise ValueError()
            ids = set(filter(None, query.get("ids", "").split(",")))
            if len(ids) > 100 or any(not REF.fullmatch(i) for i in ids):
                raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError):
            raise AgentServiceError("invalid_request", "筛选或分页条件无效，请重新读取列表。") from None
        items, warnings = self.collect()

        def matches(item):
            feedback = item["feedback"]
            return not (
                (filters["view"] == "review" and not item["review"]["pending"])
                or (filters["view"] == "feedback" and not feedback["unrated"])
                or (filters["type"] and item["type"] != filters["type"])
                or (filters["source"] and filters["source"] != item["source_name"])
                or (start is not None and item["created"] < start)
                or (end is not None and item["created"] >= end)
                or (filters["material"] and filters["material"] not in [m["id"] for m in item["materials"]])
                or (filters["context"] and filters["context"] not in item["context_keys"])
                or (filters["q"].casefold() not in (item["_text"] + "\n" + item["source_name"]).casefold())
                or (filters["feedback"] == "rated" and not feedback["rated"])
                or (filters["feedback"] == "unrated" and not feedback["unrated"])
                or (filters["feedback"] == "unsatisfied" and not feedback.get("has_unsatisfied"))
                or (filters["feedback"] == "satisfied" and feedback["state"] != "satisfied")
                or (filters["status"] == "failed" and item["status"] not in {"failed", "retryable_failed", "submission_failed"})
                or (filters["status"] == "running" and item["status"] not in {"running", "queued", "submitting"})
                or (filters["status"] == "reviewed" and (not item["review"]["total"] or item["review"]["pending"]))
            )

        newest = filters["order"] == "newest"
        matching = sorted([i for i in items if matches(i) and i["created"] <= boundary], key=lambda i: (i["created"], i["id"]), reverse=newest)
        remaining = [i for i in matching if after is None or ((i["created"], i["id"]) < tuple(after) if newest else (i["created"], i["id"]) > tuple(after))]
        page = remaining[:limit]

        def cursor(position):
            return base64.urlsafe_b64encode(json.dumps({"query": signature, "boundary": boundary, "after": position}).encode()).decode()

        return {"items": [self.public(i) for i in page], "total": len(matching), "all_count": len(items),
                "updates": [{**self.public(i), "matches": matches(i)} for i in items if i["id"] in ids],
                "pending_count": len({pid for i in items for pid in i["_pending_ids"]}), "warnings": warnings,
                "sources": sorted({i["source_name"] for i in items}),
                "materials": list({m["id"]: m for i in items for m in i["materials"]}.values()),
                "contexts": sorted({key for i in items for key in i["context_keys"]}),
                "new_count": sum(matches(i) and i["created"] > boundary for i in items),
                "cursor": cursor(after), "has_more": len(remaining) > limit,
                "next_cursor": cursor([page[-1]["created"], page[-1]["id"]]) if len(remaining) > limit else None}

    def item(self, ref):
        if not REF.fullmatch(ref):
            raise AgentServiceError("invalid_request", "记录标识无效。")
        items, warnings = self.collect()
        item = next((i for i in items if i["id"] == ref), None)
        kind, key = ref.split(":", 1)
        if item is None and kind in {"proposal", "change_set"}:
            manifest = ChangeSetRepository(self.data_root).find_by_proposal_id(key) if kind == "proposal" else None
            change_key = manifest.id if manifest else key
            item = next((i for i in items if i["review_key"] == change_key), None)
            if item is None and kind == "proposal":
                try:
                    proposal = ProposalRepository(self.data_root).get(key)
                except ProposalError:
                    proposal = None
                if proposal:
                    store = PersonaStore(self.data_root).load(verify_source_files=False)
                    title = proposal_presentation(proposal, store, self.locale)["title"]
                    item = {"id": ref, "type": "proposal", "input_preview": title, "_text": title,
                            "created": stamp(proposal.created_at.isoformat()), "source_name": "审核历史", "status": "completed",
                            "result_id": None, "_result": None, "_raw": None, "review_key": proposal.id,
                            "feedback": feedback_summary(None, supported=False), "source_url": None, "related": [], "materials": [],
                            "review": {"total": 1, "pending": int(proposal.status in OPEN), "statuses": {proposal.status: 1}},
                            "triggered": None, "matched_count": None}
        if item is None and kind == "result":
            item = next((i for i in items if i["result_id"] == key), None)
            if item is None:
                result = self.evaluations.inbox_summaries().get(key)
                if result:
                    item = {"id": ref, "type": "activation" if result["capability_id"] == ACTIVATION else "learning",
                            "input_preview": result["input_text"][:180], "created": stamp(result["created_at"]),
                            "source_name": "历史判断", "status": result["state"], "result_id": key,
                            "feedback": feedback_summary(result, supported=True), "review": {"total": 0, "pending": 0, "statuses": {}},
                            "review_key": None, "source_url": None, "triggered": None, "matched_count": None,
                            "_text": result["input_text"], "_result": result, "_raw": None}
        if item is None:
            if warnings:
                raise AgentServiceError("unavailable", "记录来源暂不可用，请重试。")
            raise AgentServiceError("not_found", "记录不存在或已清理。")
        return item

    def detail(self, ref):
        item = self.item(ref)
        ref = item["id"]
        detail = {**self.public(item), "input_text": item["_text"], "feedback_value": item["_result"], "context": None, "history": [], "actions": []}
        if ref.startswith("learning:"):
            original = LearningViews(self.learning).detail(ref.split(":", 1)[1])
            detail.update(input_text=original["user_input"] or item["_text"], input_state=original["input_state"], context=original.get("context_snapshot"), history=original["history"], runtime={k: original.get(k) for k in ("status", "outcome", "error_code", "version")})
            actions = []
            if original["status"] == "waiting_origin":
                actions.append(("confirm-human", "确认本条来自本人"))
            if original["status"] in {"failed", "retryable_failed", "paused", "paused_budget"} and item["_raw"]["payload"]:
                actions.append(("retry", "重新分析（可能调用模型）"))
            if original["status"] not in {"completed", "cancelled"}:
                actions.append(("cancel", "取消此任务"))
            detail["actions"] = [{"label": label, "url": f"/api/learning/v1/events/{ref.split(':', 1)[1]}/{action}", "body": {"version": original["version"]}} for action, label in actions]
        elif ref.startswith("application:"):
            row = item["_raw"]
            detail.update(context=row["request"].get("recent_messages"), provided_context=row.get("payload"), runtime={k: row.get(k) for k in ("status", "decision_state", "error_code", "duration_ms")})
        elif ref.startswith("assistant:"):
            row = item["_raw"]
            detail.update(context=row.get("messages"), coverage=row.get("coverage"), material_source=row.get("source"),
                          runtime={k: row.get(k) for k in ("status", "error", "stage", "version")})
            origin = row.get("review_origin")
            if origin and origin.get("change_set_id") == item["review_key"] and origin.get("generation") == item.get("generation"):
                messages = row.get("messages", [])[:origin["message_count"]]
                detail.update(input_text=learning_text(next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")),
                              context=messages, coverage=origin.get("coverage"), material_source=origin.get("source"),
                              input_note=studio_text("本批候选对应维护会话版本 {0}；不使用后续对话替换来源。", self.locale).format(origin.get('run_start_version') or '—'))
            elif item["review"]["total"]:
                detail["input_note"] = studio_text("本批候选摘要；旧任务没有记录精确输入版本，下方完整会话仅供参考。", self.locale)
        if item.get("_result"):
            result = self.evaluations.result(item["result_id"])
            if item["type"] == "learning" and result.get("case_id"):
                case = self.evaluations.case(result["case_id"])
                expected = set()
                repo = ProposalRepository(self.data_root)
                for binding in result.get("proposal_bindings", []):
                    try:
                        proposal = repo.get(binding["proposal_id"])
                    except ProposalError:
                        continue
                    if proposal.status in {"accepted", "edited_and_accepted"} and proposal.approved_content and proposal.approved_content.get("candidate_version_ref") == binding["candidate_version_ref"]:
                        expected.add(proposal.id)
                saved = {g["proposal_id"] for g in case.get("content_gold", [])}
                if case["status"] == "active" and expected:
                    detail["answer_sync"] = {"state": "pending" if expected - saved else "synced", "expected": len(expected), "saved": len(expected & saved), "case_id": result["case_id"]}
            if item["type"] == "activation":
                contexts = {c.key: c for c in PersonaStore(self.data_root).load(verify_source_files=False).of_type(PreferenceContext)}
                detail["scenes"] = {}
                for scene in (result.get("input") or {}).get("catalog", []):
                    current = contexts.get(scene["key"])
                    detail["scenes"][scene["key"]] = {
                        **scene, "current_url": "/preferences?" + urlencode({"context": current.id}) if current else None,
                        "changed": not current or current.status != "active" or current.revision != scene.get("revision"),
                    }
            detail["stages"] = result.get("stages")
            detail["snapshot_available"] = bool(result.get("input"))
        return detail

    def review_service(self, ref):
        item = self.item(ref)
        if not item["review_key"]:
            raise AgentServiceError("invalid_request", "此结果没有待审核内容。")
        if item["id"].startswith("learning:"):
            return LearningReview(self.learning, locale=self.locale), item["id"].split(":", 1)[1]
        return CandidateReview(self.data_root, self.state_root, locale=self.locale), item["review_key"]

    def review(self, ref, proposal_id=None, body=None):
        service, key = self.review_service(ref)
        return service.list(key) if proposal_id is None else service.decide(key, proposal_id, body)
