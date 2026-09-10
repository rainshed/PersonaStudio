"""Read-only task workspace projections; feedback remains in EvaluationStore."""

from __future__ import annotations

import base64
import json
import math
import time
from collections import Counter

from ..agent import AgentServiceError
from ..change_sets import ChangeSetRepository
from ..evaluations.store import EvaluationStore
from ..proposals import ProposalRepository
from .contracts import digest
from .input_text import learning_text

STATES = {
    "queued",
    "running",
    "completed",
    "waiting_context",
    "waiting_origin",
    "paused",
    "paused_budget",
    "retryable_failed",
    "failed",
    "cancelled",
}
FIELDS = (
    "id",
    "connection_id",
    "status",
    "outcome",
    "error_code",
    "version",
    "created",
    "updated",
    "change_set_id",
)


def invalid(message="查询条件无效，请刷新列表。"):
    raise AgentServiceError("invalid_request", message)


class LearningViews:
    def __init__(self, service):
        self.service = service
        self.evaluations = EvaluationStore(service.data_root, service.state_root)

    def _read(self, rows):
        try:
            return self.evaluations.learning_summaries(r["id"] for r in rows), False
        except Exception:
            # A missing/corrupt feedback store must never be presented as "unrated".
            return {}, True

    def _project(self, row, results, unavailable, connections):
        checkpoint = json.loads(row["checkpoint"])
        history = sorted(
            (r for r in results.values() if r["task_ref"] == row["id"]),
            key=lambda r: (r["created_at"], r["id"]),
            reverse=True,
        )
        current_id = checkpoint.get("evaluation_result_id")
        if row["status"] == "queued":
            current_id = None
        elif not row["payload"] and not current_id and len(history) == 1 and row["attempts"] == 1:
            # Only an unambiguous single attempt may recover a cleared pointer.
            # A later failed attempt must never inherit an older saved result.
            current_id = history[0]["id"]
        result = results.get(current_id)
        decision = next(
            (
                d
                for d in (result or {}).get("decisions", [])
                if d["subject"] == {"kind": "learning_gate"}
            ),
            None,
        )
        triggered = (decision or {}).get("triggered")
        if type(triggered) is not bool:
            triggered = None
        previous = next(
            (
                f
                for f in (result or {}).get("feedback", {}).get("subjects", {}).values()
                if f["subject"] == {"kind": "learning_gate"} and f["active"]
            ),
            None,
        )
        reason = ""
        if unavailable:
            reason = "反馈状态暂不可用，请重试读取"
        elif not result:
            reason = (
                "等待本轮判定"
                if row["status"] in {"queued", "running"}
                else "反馈数据已过期或不可用"
                if current_id or not row["payload"]
                else "历史结果缺少反馈数据"
            )
        elif triggered is None:
            reason = "暂无有效触发判断"
        event = json.loads(row["payload"]) if row["payload"] else None
        text = "\n".join(
            p.get("text", "") for p in (event or {}).get("message", {}).get("content", [])
        )
        input_state = "available" if event else "expired"
        if not event and result and result["case_id"]:
            text, input_state = result["input_text"], "benchmark"
        text = learning_text(text)
        item = {k: row[k] for k in FIELDS}
        item.update(
            source_name=connections.get(row["connection_id"], row["connection_id"]),
            input_preview=text[:180],
            input_state=input_state,
            current_result_id=current_id,
            triggered=triggered,
            feedback={
                "state": "unavailable"
                if unavailable
                else previous["rating"]
                if previous
                else "unrated",
                "revision": (result or {}).get("feedback", {}).get("revision", 0),
                "case_id": (result or {}).get("case_id"),
                "can_rate": not reason,
                "can_withdraw": bool(previous) and not unavailable,
                "disabled_reason": reason,
            },
            feedback_value={k: v for k, v in result.items() if k != "input_text"}
            if result
            else None,
            has_previous_feedback=any(r["id"] != current_id and r["case_id"] for r in history),
        )
        return item, text, history

    def review_summary(self, change_set_id):
        if not change_set_id:
            return {"total": 0, "types": {}, "statuses": {}}
        try:
            manifest = ChangeSetRepository(self.service.data_root).get(change_set_id)
            repo = ProposalRepository(self.service.data_root)
            proposals = [repo.get(link.proposal_id) for link in manifest.proposal_links]
            return {
                "total": len(proposals),
                "types": dict(Counter(p.target_entity_type or "unknown" for p in proposals)),
                "statuses": dict(Counter(p.status for p in proposals)),
            }
        except Exception:
            return {"unavailable": True}

    def list(self, query):
        try:
            limit = int(query.get("limit", 20))
        except (ValueError, TypeError):
            invalid()
        if not 1 <= limit <= 100:
            invalid()
        filters = {k: query.get(k, "") for k in ("feedback", "status", "connection_id", "q")}
        visible_ids = set(filter(None, query.get("ids", "").split(",")))
        if len(visible_ids) > 100 or any(
            len(i) > 100 or not i.startswith("learn_") for i in visible_ids
        ):
            invalid()
        if (
            filters["feedback"] not in {"", "unrated", "rated", "satisfied", "unsatisfied"}
            or filters["status"] not in {"", *STATES}
            or len(filters["q"]) > 300
            or len(filters["connection_id"]) > 200
        ):
            invalid()
        signature = digest([filters, limit])
        boundary, after = time.time(), None
        if query.get("cursor"):
            try:
                if len(query["cursor"]) > 2000:
                    invalid()
                cursor = json.loads(base64.urlsafe_b64decode(query["cursor"]))
                boundary, after = cursor["boundary"], cursor["after"]
                if (
                    cursor["query"] != signature
                    or not math.isfinite(boundary)
                    or (
                        after is not None
                        and (
                            len(after) != 2
                            or not isinstance(after[0], (int, float))
                            or not math.isfinite(after[0])
                            or not isinstance(after[1], str)
                        )
                    )
                ):
                    invalid()
            except (ValueError, TypeError, KeyError, OverflowError):
                invalid()
        with self.service.repository.connect() as db:
            rows = [
                dict(r) for r in db.execute("SELECT * FROM events ORDER BY created DESC,id DESC")
            ]
        connections = {c.id: c.name for c in self.service.repository.connections()}
        results, unavailable = self._read(rows)
        matches, updates, new_count = [], [], 0
        for row in rows:
            item, text, _ = self._project(row, results, unavailable, connections)
            if row["id"] in visible_ids:
                updates.append(item)
            if filters["status"] and row["status"] != filters["status"]:
                continue
            if filters["connection_id"] and row["connection_id"] != filters["connection_id"]:
                continue
            if filters["q"].casefold() not in (text + "\n" + item["source_name"]).casefold():
                continue
            if filters["feedback"] and (
                (item["feedback"]["state"] not in {"satisfied", "unsatisfied"} if filters["feedback"] == "rated" else item["feedback"]["state"] != filters["feedback"]) or not item["feedback"]["can_rate"]
            ):
                continue
            if row["created"] > boundary:
                new_count += 1
            else:
                matches.append(item)
        remaining = [i for i in matches if after is None or (i["created"], i["id"]) < tuple(after)]
        items = remaining[:limit]
        for item in {i["id"]: i for i in [*items, *updates]}.values():
            item["review_summary"] = self.review_summary(item["change_set_id"])

        def token(position):
            return base64.urlsafe_b64encode(
                json.dumps(
                    {
                        "boundary": boundary,
                        "after": position,
                        "query": signature,
                    }
                ).encode()
            ).decode()

        more = len(remaining) > limit
        return {
            "events": items,
            "updates": updates,
            "total": len(matches),
            "all_count": len(rows),
            "cursor": token(after),
            "has_more": more,
            "new_count": new_count,
            "next_cursor": token([items[-1]["created"], items[-1]["id"]]) if more else None,
        }

    def detail(self, identifier):
        row = self.service.repository.get(identifier)
        results, unavailable = self._read([row])
        names = {c.id: c.name for c in self.service.repository.connections()}
        item, _, history = self._project(row, results, unavailable, names)
        detail = self.service.get_event_status(identifier, row["connection_id"])
        detail.update(item)
        detail["review_summary"] = self.review_summary(row["change_set_id"])
        detail["history"] = [
            {k: v for k, v in r.items() if k != "input_text"}
            for r in history
            if r["id"] != item["current_result_id"]
        ]
        result = results.get(item["current_result_id"])
        if result:
            full = self.evaluations.result(result["id"])
            # Older workers collapsed PromptError into internal_error, but the
            # matching immutable attempt retained its precise failure code.
            if (row["status"] == "failed" and row["error_code"] == "internal_error"
                    and full.get("state") == "failed" and full.get("error_code") == "incompatible"):
                detail["error_code"] = "incompatible"
            detail["judgment_input"] = (
                full.get("input", {}).get("event", {}).get("message", {}).get("content", [])
            )
            detail["context_snapshot"] = full.get("input", {}).get("snapshot")
        content = detail.get(
            "judgment_input", detail.get("event", {}).get("message", {}).get("content", [])
        )
        detail["user_input"] = learning_text("\n".join(p.get("text", "") for p in content))
        return detail
