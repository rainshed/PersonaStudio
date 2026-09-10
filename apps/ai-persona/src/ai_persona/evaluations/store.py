"""File-first benchmark data. Reasons have a separate, never-executed store.

All public operations serialize across processes. A redo journal makes a feedback
click (blobs + case revision + feedback) recoverable as one logical transaction.
Temporary traces are not cases and cannot be selected by the replay service.
"""

from __future__ import annotations

import copy
import fcntl
import json
import os
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from ..conversation_learning.input_text import learning_text
from .contracts import (
    ACTIVATION,
    CAPABILITIES,
    LEARNING,
    EvaluationError,
    FeedbackInput,
    Subject,
    derived_label,
    digest,
    encoded,
    identifier,
    now,
)

_locks_guard = threading.Lock()
_locks = {}
MAX_DOCUMENT_BYTES = 32_000_000


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    content = encoded(value).encode()
    if len(content) > MAX_DOCUMENT_BYTES:
        raise EvaluationError("评测数据超过单条保存上限，请缩小范围。", "too_large", 413)
    fd, temporary = tempfile.mkstemp(prefix=".evaluation-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, default=None):
    if not path.exists():
        return copy.deepcopy(default)
    if path.stat().st_size > MAX_DOCUMENT_BYTES:
        raise EvaluationError("评测数据文件过大。", "too_large", 413)
    return json.loads(path.read_text(encoding="utf-8"))


class EvaluationStore:
    def __init__(self, data_root, state_root):
        self.data_root = Path(data_root).resolve()
        self.state_root = Path(state_root).resolve()
        self.root = self.data_root / "evaluations"
        self.local = self.state_root / "evaluations"
        with _locks_guard:
            self.mutex = _locks.setdefault(str(self.root), threading.RLock())

    def _path(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root.resolve()) or path == self.root.resolve():
            raise EvaluationError("评测数据路径无效。")
        return path

    @contextmanager
    def locked(self):
        with self.mutex:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            with (self.root / ".lock").open("a+b") as stream:
                fcntl.flock(stream, fcntl.LOCK_EX)
                try:
                    for path in sorted((self.root / ".transactions").glob("*.json")):
                        self._apply(read_json(path))
                        path.unlink()
                    yield
                finally:
                    fcntl.flock(stream, fcntl.LOCK_UN)

    def _apply(self, transaction):
        for relative, value in transaction["writes"].items():
            atomic_json(self._path(relative), value)
        for relative in transaction.get("deletes", []):
            self._path(relative).unlink(missing_ok=True)

    def _commit(self, writes, deletes=()):
        for relative in [*writes, *deletes]:
            self._path(relative)
        # Validate all documents before a durable journal is published.
        transaction = {"writes": writes, "deletes": list(deletes)}
        path = self.root / ".transactions" / (uuid.uuid4().hex + ".json")
        atomic_json(path, transaction)
        self._apply(transaction)
        path.unlink()

    def _blob(self, value, writes):
        key = digest(value)
        relative = f"blobs/{key}.json"
        if not self._path(relative).exists():
            writes[relative] = value
        return key

    def _read_blob(self, key):
        if (
            not isinstance(key, str)
            or len(key) != 64
            or any(c not in "0123456789abcdef" for c in key)
        ):
            raise EvaluationError("样例附件标识无效。")
        value = read_json(self._path(f"blobs/{key}.json"))
        if value is None or digest(value) != key:
            raise EvaluationError("样例附件缺失或校验失败。", "missing_snapshot", 409)
        return value

    @staticmethod
    def case_id(result_id):
        return "case_" + identifier(result_id)

    def _case(self, case_id):
        value = read_json(self._path(f"cases/{identifier(case_id)}.json"))
        if value is None:
            raise EvaluationError("测试样例不存在。", "not_found", 404)
        return value

    def _feedback(self, case_id):
        return read_json(
            self._path(f"feedback/{identifier(case_id)}.json"),
            {
                "case_id": case_id,
                "revision": 0,
                "subjects": {},
                "history": [],
                "requests": {},
            },
        )

    def _result(self, result_id):
        identifier(result_id)
        if self._path(f"deleted/{result_id}.json").exists():
            raise EvaluationError("该结果的样例已删除，不能再次自动保存。", "deleted", 410)
        case = read_json(self._path(f"cases/{self.case_id(result_id)}.json"))
        if case:
            return self._read_blob(case["revisions"][-1]["result_ref"])
        result = read_json(self.local / "traces" / f"{result_id}.json")
        if result is None:
            raise EvaluationError("结果不存在或临时输入已清理。", "not_found", 404)
        return result

    def create_result(
        self,
        capability_id,
        *,
        task_ref=None,
        run_id=None,
        input_data=None,
        environment=None,
        prompt_snapshot=None,
        group_id=None,
        parent_case_id=None,
    ):
        if capability_id not in {ACTIVATION, LEARNING}:
            raise EvaluationError("此能力尚未接入反馈。")
        result_id = "result_" + uuid.uuid4().hex
        value = {
            "id": result_id,
            "capability_id": capability_id,
            "task_ref": task_ref,
            "run_id": run_id or "run_" + uuid.uuid4().hex,
            "created_at": now(),
            "updated_at": now(),
            "state": "running",
            "decisions": [],
            "input": input_data,
            "environment": environment,
            "prompt_snapshot": prompt_snapshot,
            "group_id": group_id or digest([capability_id, input_data]),
            "stages": [],
            "generation": None,
            "proposal_bindings": [],
            "parent_case_id": parent_case_id,
        }
        with self.locked():
            if parent_case_id and self._case(parent_case_id)["revisions"][-1]["status"] != "active":
                raise EvaluationError("原样例反馈已撤回。", "withdrawn", 409)
            atomic_json(self.local / "traces" / f"{result_id}.json", value)
        return value

    def complete_result(self, result_id, **updates):
        """Append stages/final generation. The original input and gate never change."""
        allowed = {
            "decisions",
            "state",
            "stage",
            "generation",
            "proposal_bindings",
            "candidate_input",
            "expanded_context",
            "environment_changed",
            "error_code",
        }
        if set(updates) - allowed:
            raise EvaluationError("结果更新字段无效。")
        with self.locked():
            result = self._result(result_id)
            if result["state"] in {"completed", "failed", "cancelled"}:
                # Late proposal bindings can be recovered after the business file commit.
                if set(updates) - {"proposal_bindings"}:
                    raise EvaluationError("已完成结果不可覆盖。", "conflict", 409)
            if (
                "decisions" in updates
                and result["decisions"]
                and result["decisions"] != updates["decisions"]
            ):
                raise EvaluationError("原触发判断不可覆盖。", "conflict", 409)
            if (
                "generation" in updates
                and result["generation"] is not None
                and result["generation"] != updates["generation"]
            ):
                raise EvaluationError("原生成内容不可覆盖。", "conflict", 409)
            if "stage" in updates:
                result["stages"].append(updates.pop("stage"))
            result.update(updates, updated_at=now())
            case_id = self.case_id(result_id)
            case = read_json(self._path(f"cases/{case_id}.json"))
            if case:
                writes = {}
                projection = copy.deepcopy(case["revisions"][-1])
                projection["result_ref"] = self._blob(result, writes)
                projection["replay_capabilities"] = self._replay_modes(result)
                self._append(case, projection)
                writes[f"cases/{case_id}.json"] = case
                self._commit(writes)
            else:
                atomic_json(self.local / "traces" / f"{result_id}.json", result)
            return result

    @staticmethod
    def _replay_modes(result):
        if result.get("input") is None:
            return []
        if result["capability_id"] == ACTIVATION:
            return ["activation"]
        modes = ["learning_trigger"]
        if result.get("environment") and not result.get("environment_changed"):
            modes.append("learning_pipeline")
            if result.get("candidate_input"):
                modes.append("learning_content")
        return modes

    @staticmethod
    def _append(case, projection):
        projection["benchmark_revision"] = len(case["revisions"]) + 1
        projection["updated_at"] = now()
        case["revisions"].append(projection)

    def result(self, result_id):
        with self.locked():
            result = self._result(result_id)
            feedback = self._feedback(self.case_id(result_id))
            result["feedback"] = {k: feedback[k] for k in ("revision", "subjects")}
            result["case_id"] = self.case_id(result_id) if feedback["revision"] else None
            return result

    def learning_summaries(self, task_refs):
        """One coherent read for a task page; never creates cases or exposes environments."""
        wanted = set(task_refs)
        values = {}
        with self.locked():
            paths = list((self.local / "traces").glob("*.json"))
            for path in paths:
                value = read_json(path)
                if (value.get("capability_id") == LEARNING
                        and value.get("task_ref") in wanted
                        and not self._path(f"deleted/{identifier(value['id'])}.json").exists()):
                    values[value["id"]] = value
            for path in (self.root / "cases").glob("*.json"):
                projection = read_json(path)["revisions"][-1]
                if projection["capability_id"] != LEARNING:
                    continue
                value = self._read_blob(projection["result_ref"])
                if value.get("task_ref") in wanted:
                    values[value["id"]] = value
            summaries = {}
            for value in values.values():
                feedback = self._feedback(self.case_id(value["id"]))
                payload = value.get("input") or {}
                text = "\n".join(
                    p.get("text", "")
                    for p in payload.get("event", {}).get("message", {}).get("content", [])
                )
                summaries[value["id"]] = {
                    **{k: value[k] for k in ("id", "task_ref", "created_at", "state", "decisions")},
                    "feedback": {k: feedback[k] for k in ("revision", "subjects")},
                    "case_id": self.case_id(value["id"]) if feedback["revision"] else None,
                    "input_text": text,
                }
            return summaries

    @staticmethod
    def input_text(result):
        payload = result.get("input") or {}
        text = (
            payload.get("current_user_prompt") or payload.get("user_prompt")
            or "\n".join(
                part.get("text", "")
                for part in payload.get("event", {}).get("message", {}).get("content", [])
            )
            or ""
        )
        return learning_text(text)

    @staticmethod
    def input_preview(result):
        return EvaluationStore.input_text(result)[:180]

    def inbox_summaries(self):
        """Read real business results once; never promote replay traces into daily work."""
        with self.locked():
            values = {}
            for path in (self.local / "traces").glob("*.json"):
                value = read_json(path)
                if not self._path(f"deleted/{identifier(value['id'])}.json").exists():
                    values[value["id"]] = value
            for path in (self.root / "cases").glob("*.json"):
                value = self._read_blob(read_json(path)["revisions"][-1]["result_ref"])
                values[value["id"]] = value
            summaries = {}
            for value in values.values():
                if str(value.get("task_ref") or "").startswith("evaluation:") or value.get("parent_case_id"):
                    continue
                feedback = self._feedback(self.case_id(value["id"]))
                payload = value.get("input") or {}
                text = payload.get("current_user_prompt") or payload.get("user_prompt") or "\n".join(
                    p.get("text", "") for p in payload.get("event", {}).get("message", {}).get("content", [])
                )
                summaries[value["id"]] = {
                    **{k: value.get(k) for k in ("id", "task_ref", "created_at", "state", "decisions", "capability_id")},
                    "feedback": {k: feedback[k] for k in ("revision", "subjects")},
                    "case_id": self.case_id(value["id"]) if feedback["revision"] else None,
                    "input_text": learning_text(text),
                    "context_keys": [c["key"] for c in payload.get("catalog", [])],
                }
            return summaries

    def results(self, capability_id=None, task_ref=None, limit=30, offset=0):
        with self.locked():
            values = {}
            for path in (self.local / "traces").glob("*.json"):
                value = read_json(path)
                if not self._path(f"deleted/{value['id']}.json").exists():
                    values[value["id"]] = value
            for path in (self.root / "cases").glob("*.json"):
                value = self._read_blob(read_json(path)["revisions"][-1]["result_ref"])
                values[value["id"]] = value
            values = sorted(
                (
                    v
                    for v in values.values()
                    if (not capability_id or v["capability_id"] == capability_id)
                    and (not task_ref or v["task_ref"] == task_ref)
                ),
                key=lambda v: v["created_at"],
                reverse=True,
            )
            return [
                {
                    "input_preview": self.input_preview(v),
                    **{
                        k: v[k]
                        for k in (
                            "id",
                            "capability_id",
                            "task_ref",
                            "run_id",
                            "created_at",
                            "state",
                            "decisions",
                        )
                    },
                }
                for v in values[offset : offset + min(limit, 100)]
            ]

    def feedback(self, result_id, raw):
        request = FeedbackInput.model_validate(raw)
        subject = request.subject.value()
        subject_key = digest(subject)
        case_id = self.case_id(result_id)
        with self.locked():
            result = self._result(result_id)
            decision = next((d for d in result["decisions"] if d["subject"] == subject), None)
            if decision is None:
                raise EvaluationError("反馈对象不属于本次结果。")
            expected = derived_label(decision["triggered"], request.rating)
            record = self._feedback(case_id)
            fingerprint = digest(raw)
            seen = record["requests"].get(request.idempotency_key)
            if seen:
                if seen != fingerprint:
                    raise EvaluationError("相同请求标识不能用于不同反馈。", "conflict", 409)
                return self._case_detail(case_id)
            if record["revision"] != request.expected_feedback_revision:
                raise EvaluationError("反馈已更新，请刷新后重试。", "conflict", 409)
            feedback = {
                "subject": subject,
                "rating": request.rating,
                "reason": request.reason if request.rating == "unsatisfied" else "",
                "active": True,
                "submitted_via": "studio_explicit_rating",
                "at": now(),
            }
            record["revision"] += 1
            record["subjects"][subject_key] = feedback
            record["history"].append(feedback)
            record["requests"][request.idempotency_key] = fingerprint
            writes = {f"feedback/{case_id}.json": record}
            case = read_json(self._path(f"cases/{case_id}.json")) or {
                "schema": "ai-persona.evaluation-case/v1",
                "id": case_id,
                "revisions": [],
            }
            if case["revisions"]:
                projection = copy.deepcopy(case["revisions"][-1])
            else:
                projection = {
                    "case_id": case_id,
                    "capability_id": result["capability_id"],
                    "group_id": result["group_id"],
                    "result_id": result_id,
                    "result_ref": self._blob(result, writes),
                    "trigger_labels": [],
                    "content_gold": [],
                    "replay_capabilities": self._replay_modes(result),
                    "created_at": now(),
                    "status": "active",
                }
            label = {
                "subject": subject,
                "actual_trigger": decision["triggered"],
                "rating": request.rating,
                "expected_trigger": expected,
                "label_source": "explicit_rating",
            }
            labels = [old for old in projection["trigger_labels"] if old["subject"] != subject] + [
                label
            ]
            labels.sort(key=lambda value: digest(value["subject"]))
            changed = labels != projection["trigger_labels"] or projection["status"] != "active"
            projection.update(trigger_labels=labels, status="active")
            if not case["revisions"] or changed:
                self._append(case, projection)
                writes[f"cases/{case_id}.json"] = case
            self._commit(writes)
            return self._case_detail(case_id)

    def _case_detail(self, case_id, revision=None):
        case = self._case(case_id)
        if revision is None:
            projection = case["revisions"][-1]
        else:
            if type(revision) is not int or not 1 <= revision <= len(case["revisions"]):
                raise EvaluationError("样例版本不存在。", "not_found", 404)
            projection = case["revisions"][revision - 1]
        return {
            **copy.deepcopy(projection),
            "feedback": self._feedback(case_id),
            "result": self._read_blob(projection["result_ref"]),
            "revision_count": len(case["revisions"]),
        }

    def case(self, case_id):
        with self.locked():
            return self._case_detail(case_id)

    def cases(self, capability_id=None):
        with self.locked():
            values = [read_json(p)["revisions"][-1] for p in (self.root / "cases").glob("*.json")]
            return sorted(
                (
                    {**v, "input_preview": self.input_preview(self._read_blob(v["result_ref"]))}
                    for v in values
                    if not capability_id or v["capability_id"] == capability_id
                ),
                key=lambda v: v["created_at"],
                reverse=True,
            )

    def reason(self, case_id, subject, reason, expected_revision):
        subject = Subject.model_validate(subject).value()
        if not isinstance(reason, str) or len(reason) > 2000:
            raise EvaluationError("理由不超过 2000 字符。")
        with self.locked():
            self._case(case_id)
            record = self._feedback(case_id)
            previous = record["subjects"].get(digest(subject))
            if not previous or not previous["active"] or previous["rating"] != "unsatisfied":
                raise EvaluationError("请先对该判断点击不满意。", "conflict", 409)
            if type(expected_revision) is not int or record["revision"] != expected_revision:
                raise EvaluationError("反馈已更新，请刷新。", "conflict", 409)
            value = {**previous, "reason": reason, "at": now()}
            record["subjects"][digest(subject)] = value
            record["history"].append(value)
            record["revision"] += 1
            self._commit({f"feedback/{case_id}.json": record})
            return self._case_detail(case_id)

    def withdraw(self, case_id, subject, expected_revision):
        selected = Subject.model_validate(subject).value() if subject else None
        with self.locked():
            case = self._case(case_id)
            record = self._feedback(case_id)
            if type(expected_revision) is not int or record["revision"] != expected_revision:
                raise EvaluationError("反馈已更新，请刷新。", "conflict", 409)
            for key, value in record["subjects"].items():
                if selected is None or selected == value["subject"]:
                    record["subjects"][key] = {**value, "active": False, "at": now()}
                    record["history"].append(record["subjects"][key])
            record["revision"] += 1
            projection = copy.deepcopy(case["revisions"][-1])
            projection["trigger_labels"] = [
                label
                for label in projection["trigger_labels"]
                if selected is not None and label["subject"] != selected
            ]
            projection["status"] = "active" if projection["trigger_labels"] else "withdrawn"
            self._append(case, projection)
            self._commit({f"cases/{case_id}.json": case, f"feedback/{case_id}.json": record})
            return self._case_detail(case_id)

    def projection(self, case_id, revision=None):
        """The only replay input boundary. Never opens feedback/reason files."""
        with self.locked():
            case = self._case(case_id)
            current = case["revisions"][-1]
            if current["status"] != "active":
                raise EvaluationError("样例反馈已撤回。", "withdrawn", 409)
            if revision is not None and (
                type(revision) is not int or not 1 <= revision <= len(case["revisions"])
            ):
                raise EvaluationError("样例版本不存在。")
            value = copy.deepcopy(case["revisions"][revision - 1] if revision else current)
            active = {digest(label["subject"]) for label in current["trigger_labels"]}
            value["trigger_labels"] = [
                label for label in value["trigger_labels"] if digest(label["subject"]) in active
            ]
            if not value["trigger_labels"]:
                raise EvaluationError("该版本中的反馈已撤回。", "withdrawn", 409)
            value["result"] = self._read_blob(value["result_ref"])
            return value

    def add_gold(self, case_id, gold):
        with self.locked():
            case = self._case(case_id)
            projection = copy.deepcopy(case["revisions"][-1])
            if projection["status"] != "active":
                return False
            existing = {g["proposal_id"]: g for g in projection["content_gold"]}
            for value in gold:
                existing.setdefault(value["proposal_id"], value)
            values = sorted(existing.values(), key=lambda v: v["proposal_id"])
            if values == projection["content_gold"]:
                return False
            projection["content_gold"] = values
            self._append(case, projection)
            self._commit({f"cases/{case_id}.json": case})
            return True

    def save_suite(self, name, cases):
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise EvaluationError("请填写不超过 200 字符的测试集名称。")
        if not isinstance(cases, list) or not 1 <= len(cases) <= 200:
            raise EvaluationError("请选择 1–200 条样例。")
        selected = []
        for item in cases:
            value = self.projection(item["case_id"], item.get("benchmark_revision"))
            selected.append(
                {"case_id": value["case_id"], "benchmark_revision": value["benchmark_revision"]}
            )
        if len({v["case_id"] for v in selected}) != len(selected):
            raise EvaluationError("同一测试集不能重复包含样例。")
        value = {
            "id": "suite_" + uuid.uuid4().hex,
            "version": 1,
            "name": name.strip(),
            "cases": selected,
            "created_at": now(),
        }
        with self.locked():
            self._commit({f"suites/{value['id']}.json": value})
        return value

    def documents(self, kind):
        if kind not in {"suites", "runs"}:
            raise EvaluationError("记录类型无效。")
        with self.locked():
            return sorted(
                (read_json(p) for p in (self.root / kind).glob("*.json")),
                key=lambda v: v.get("created_at", ""),
                reverse=True,
            )

    def document(self, kind, key):
        if kind not in {"suites", "runs"}:
            raise EvaluationError("记录类型无效。")
        with self.locked():
            value = read_json(self._path(f"{kind}/{identifier(key)}.json"))
            if value is None:
                raise EvaluationError("记录不存在。", "not_found", 404)
            return value

    def save_run(self, value):
        with self.locked():
            value = copy.deepcopy(value)
            path = f"runs/{identifier(value['id'])}.json"
            previous = read_json(self._path(path))
            if previous and previous["status"] in {"cancelled", "interrupted"}:
                return previous
            self._scrub_run(value)
            self._commit({path: value})
        return value

    def _scrub_run(self, run, deleted_case=None):
        """Late worker writes cannot restore deleted case bodies or snapshots."""
        if run.get("lineage_case_ids") and any(
            key == deleted_case or (key.startswith("case_") and self._path(f"deleted/{identifier(key[5:])}.json").exists())
            for key in run["lineage_case_ids"]
        ):
            # Generated text can incorporate any development example. Scrub the
            # entire derived archive, not just that example's replay row.
            for field in ("variants", "rounds", "results", "planned_scores", "optimization", "stages"):
                run.pop(field, None)
            run.update(private_content_deleted=True, report={}, outcome="insufficient")
        for key in list(run.get("planned_scores", {})):
            if key == deleted_case or (
                key.startswith("case_")
                and self._path(f"deleted/{identifier(key[5:])}.json").exists()
            ):
                run["planned_scores"].pop(key)
        for item in run.get("results", []):
            key = item.get("case_id", "")
            deleted = key == deleted_case or (
                key.startswith("case_")
                and self._path(f"deleted/{identifier(key[5:])}.json").exists()
            )
            if deleted:
                identity = {
                    k: item[k] for k in ("case_id", "variant", "repeat_index", "id") if k in item
                }
                item.clear()
                item.update(**identity, status="deleted")
        for variant in run.get("variants", []):
            for key in list(variant.get("snapshots", {})):
                if key == deleted_case or (
                    key.startswith("case_")
                    and self._path(f"deleted/{identifier(key[5:])}.json").exists()
                ):
                    variant["snapshots"].pop(key)
        if run.get("report"):
            from .replay import summarize

            run["report"] = summarize(run.get("results", []))

    def cleanup(self, retention_days=7, max_bytes=100_000_000):
        with self.locked():
            traces = sorted((self.local / "traces").glob("*.json"), key=lambda p: p.stat().st_mtime)
            total, removed = sum(p.stat().st_size for p in traces), 0
            for path in traces:
                value = read_json(path)
                # Protect in-flight work, but abandoned workers cannot retain
                # unevaluated conversation bodies indefinitely.
                if value["state"] == "running" and path.stat().st_mtime > time.time() - 86400:
                    continue
                if path.stat().st_mtime < time.time() - retention_days * 86400 or total > max_bytes:
                    total -= path.stat().st_size
                    path.unlink()
                    removed += 1
            return {"removed_traces": removed}

    def delete(self, case_id):
        with self.locked():
            case = self._case(case_id)
            result_id = case["revisions"][-1]["result_id"]
            writes = {f"deleted/{result_id}.json": {"deleted_at": now()}}
            for path in (self.root / "runs").glob("*.json"):
                run = read_json(path)
                self._scrub_run(run, case_id)
                writes[str(path.relative_to(self.root))] = run
            refs = {r["result_ref"] for r in case["revisions"]}
            for path in (self.root / "cases").glob("*.json"):
                other = read_json(path)
                if other["id"] != case_id:
                    refs -= {r["result_ref"] for r in other["revisions"]}
            self._commit(
                writes,
                [
                    f"cases/{case_id}.json",
                    f"feedback/{case_id}.json",
                    *(f"blobs/{ref}.json" for ref in refs),
                ],
            )
            (self.local / "traces" / f"{result_id}.json").unlink(missing_ok=True)
            for path in (self.local / "traces").glob("*.json"):
                if read_json(path).get("parent_case_id") == case_id:
                    path.unlink()
            return {"deleted": case_id}

    def export(self, mode="backup", case_ids=None):
        if mode not in {"backup", "benchmark"}:
            raise EvaluationError("导出类型无效。")
        with self.locked():
            paths = list((self.root / "cases").glob("*.json"))
            cases = [read_json(p) for p in paths if case_ids is None or p.stem in case_ids]
            blobs = {
                r["result_ref"]: self._read_blob(r["result_ref"])
                for c in cases
                for r in c["revisions"]
            }
            keys = {c["id"] for c in cases}
            suites = [read_json(p) for p in (self.root / "suites").glob("*.json")]
            suites = [s for s in suites if all(c["case_id"] in keys for c in s["cases"])]
            runs = [read_json(p) for p in (self.root / "runs").glob("*.json")]
            runs = [r for r in runs if all(c["case_id"] in keys for c in r["suite"]["cases"])]
            if mode == "benchmark":
                # Optimizer inputs and derived prompts can contain private reasons.
                runs = [r for r in runs if r.get("kind") != "optimization" and not r.get("parent_id")]
            return {
                "schema": "ai-persona.evaluation-export/v1",
                "mode": mode,
                "cases": cases,
                "blobs": blobs,
                "suites": suites,
                "runs": runs,
                "feedback": {c["id"]: self._feedback(c["id"]) for c in cases}
                if mode == "backup"
                else {},
                "created_at": now(),
            }

    def import_data(self, raw):
        if raw.get("schema") != "ai-persona.evaluation-export/v1" or raw.get("mode") != "backup":
            raise EvaluationError("仅支持包含原始明确反馈的用户备份导入。")
        if len(encoded(raw).encode()) > MAX_DOCUMENT_BYTES:
            raise EvaluationError("导入数据超过上限。", "too_large", 413)
        writes = {}
        cases = raw.get("cases", [])
        if not isinstance(cases, list) or len(cases) > 200:
            raise EvaluationError("导入样例数量无效。")
        with self.locked():
            for case in cases:
                key = identifier(case["id"])
                if (
                    set(case) != {"schema", "id", "revisions"}
                    or case["schema"] != "ai-persona.evaluation-case/v1"
                ):
                    raise EvaluationError("样例格式无效。")
                if self._path(f"cases/{key}.json").exists() or f"cases/{key}.json" in writes:
                    raise EvaluationError("样例已存在，导入不会覆盖已有反馈。", "conflict", 409)
                feedback = raw.get("feedback", {}).get(key)
                if not feedback or not feedback.get("history") or not case.get("revisions"):
                    raise EvaluationError("备份缺少明确反馈历史。")
                if any(
                    v.get("submitted_via") != "studio_explicit_rating" for v in feedback["history"]
                ):
                    raise EvaluationError("反馈来源不符合导入协议。")
                for entry in feedback["history"]:
                    Subject.model_validate(entry["subject"])
                    if (
                        entry["rating"] not in {"satisfied", "unsatisfied"}
                        or type(entry["active"]) is not bool
                        or not isinstance(entry["reason"], str)
                        or len(entry["reason"]) > 2000
                    ):
                        raise EvaluationError("反馈历史无效。")
                if (
                    feedback["case_id"] != key
                    or type(feedback["revision"]) is not int
                    or feedback["revision"] < 1
                ):
                    raise EvaluationError("反馈版本无效。")
                for index, revision in enumerate(case["revisions"], 1):
                    if set(revision) != {
                        "case_id",
                        "capability_id",
                        "group_id",
                        "result_id",
                        "result_ref",
                        "trigger_labels",
                        "content_gold",
                        "replay_capabilities",
                        "created_at",
                        "status",
                        "benchmark_revision",
                        "updated_at",
                    }:
                        raise EvaluationError("评测投影包含未知字段。")
                    if (
                        revision["case_id"] != key
                        or revision["benchmark_revision"] != index
                        or revision["status"] not in {"active", "withdrawn"}
                    ):
                        raise EvaluationError("样例修订无效。")
                    result = raw.get("blobs", {}).get(revision["result_ref"])
                    if result is None or digest(result) != revision["result_ref"]:
                        raise EvaluationError("样例快照校验失败。")
                    identifier(result["id"])
                    if (
                        self.case_id(result["id"]) != key
                        or self._path(f"deleted/{result['id']}.json").exists()
                    ):
                        raise EvaluationError("备份样例归属无效，或样例已被删除。")
                    if result["capability_id"] not in {c["id"] for c in CAPABILITIES}:
                        raise EvaluationError("备份能力不支持。")
                    if (
                        revision["result_id"] != result["id"]
                        or revision["capability_id"] != result["capability_id"]
                        or revision["group_id"] != result["group_id"]
                        or revision["replay_capabilities"] != self._replay_modes(result)
                    ):
                        raise EvaluationError("样例与运行快照不一致。")
                    subjects = set()
                    for label in revision["trigger_labels"]:
                        if (
                            set(label)
                            != {
                                "subject",
                                "actual_trigger",
                                "rating",
                                "expected_trigger",
                                "label_source",
                            }
                            or label["label_source"] != "explicit_rating"
                        ):
                            raise EvaluationError("评测标签包含未知字段。")
                        subject = Subject.model_validate(label["subject"]).value()
                        decision = next(
                            (d for d in result["decisions"] if d["subject"] == subject), None
                        )
                        if (
                            not decision
                            or type(label["actual_trigger"]) is not bool
                            or type(label["expected_trigger"]) is not bool
                            or decision["triggered"] != label["actual_trigger"]
                            or derived_label(decision["triggered"], label["rating"])
                            != label["expected_trigger"]
                        ):
                            raise EvaluationError("备份触发标签无效。")
                        if digest(subject) in subjects or not any(
                            h["active"]
                            and h["subject"] == subject
                            and h["rating"] == label["rating"]
                            for h in feedback["history"]
                        ):
                            raise EvaluationError("评测标签缺少对应的明确反馈。")
                        subjects.add(digest(subject))
                    if (revision["status"] == "active") != bool(subjects):
                        raise EvaluationError("样例状态和有效反馈不一致。")
                    writes[f"blobs/{revision['result_ref']}.json"] = result
                active_feedback = {
                    digest(f["subject"]): f["rating"]
                    for f in feedback["subjects"].values()
                    if f["active"]
                }
                if active_feedback != {
                    digest(label["subject"]): label["rating"]
                    for label in case["revisions"][-1]["trigger_labels"]
                }:
                    raise EvaluationError("当前反馈和评测标签不一致。")
                writes[f"cases/{key}.json"] = case
                writes[f"feedback/{key}.json"] = feedback
            keys = {c["id"]: len(c["revisions"]) for c in cases}
            for kind in ("suites", "runs"):
                for document in raw.get(kind, []):
                    doc = copy.deepcopy(document)
                    key = identifier(doc["id"])
                    refs = doc["cases"] if kind == "suites" else doc["suite"]["cases"]
                    if any(
                        r["case_id"] not in keys
                        or type(r["benchmark_revision"]) is not int
                        or not 1 <= r["benchmark_revision"] <= keys[r["case_id"]]
                        for r in refs
                    ):
                        raise EvaluationError("备份测试集引用无效。")
                    if self._path(f"{kind}/{key}.json").exists() or f"{kind}/{key}.json" in writes:
                        raise EvaluationError("测试集或报告已存在，不能覆盖。", "conflict", 409)
                    if kind == "runs" and doc["status"] in {"queued", "running"}:
                        doc["status"] = "interrupted"
                    if kind == "runs":
                        doc["imported"] = True  # Viewing a backup never authorizes publication.
                    writes[f"{kind}/{key}.json"] = doc
            self._commit(writes)
        return {"imported": len(cases)}
