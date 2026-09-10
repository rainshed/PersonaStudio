"""Bounded model/tool loop and an auditable ledger of content actually supplied."""

from __future__ import annotations

import copy
import hashlib
import json
import time

from pydantic import ValidationError

from ..agent import AgentServiceError
from ..query_contracts import unpack
from ..query_sources import file_id
from .contracts import Finish, ModelAction
from .tools import ToolRegistry


def loop(
    request, dispatch, finish, *, rounds=8, checkpoint=None, save=lambda _: None, result_type=Finish
):
    """Transport-independent loop shared with background candidate planning."""
    state = copy.deepcopy(checkpoint or {"messages": [], "round": 0})

    def reject(index, message):
        state["messages"].append({
            "role": "user",
            "content": json.dumps({"origin": "application_validation",
                                   "error": "invalid_model_output", "message": message}),
            "timestamp": int(time.time() * 1000),
        })
        state["round"] = index + 1
        save(state)

    for index in range(state.get("round", 0), rounds):
        try:
            raw = request(state)
        except AgentServiceError as exc:
            # Typed parsing/policy rejection inside a caller is still a malformed
            # response. Correct it within this same budget; transport errors escape.
            if exc.code != "invalid_model_output":
                raise
            reject(index, exc.message)
            continue
        message = raw.get("message")
        try:
            if "terminal" in raw:
                calls = [{"name": "finish_maintenance", "arguments": raw["terminal"]}]
            else:
                calls = [
                    {"name": c["name"], "arguments": c["arguments"], "id": c["id"]}
                    for c in (message or {}).get("content", [])
                    if c.get("type") == "toolCall"
                ]
                if not calls:
                    text = raw.get("text", "").strip()
                    if text.startswith("```") and text.endswith("```"):
                        text = text.split("\n", 1)[-1].rsplit("```", 1)[0]
                    action = ModelAction.model_validate_json(text)
                    calls = [c.model_dump() for c in action.calls]
                    if action.result:
                        calls.append(
                            {"name": "finish_maintenance", "arguments": action.result.model_dump()}
                        )
            if (
                not calls
                or len(calls) > 8
                or (len(calls) > 1 and any(c["name"] == "finish_maintenance" for c in calls))
            ):
                raise ValueError("Request reads first, or submit one complete result.")
        except (ValidationError, ValueError, KeyError, TypeError):
            reject(index, "Use the supplied schema: request reads or submit one complete result; never both.")
            continue
        if message:
            state["messages"].append(message)
        for call in calls:
            try:
                if call["name"] == "finish_maintenance":
                    return finish(result_type.model_validate(call["arguments"]))
                payload, images = dispatch(call["name"], call["arguments"])
            except (AgentServiceError, ValidationError, ValueError) as exc:
                if isinstance(exc, AgentServiceError) and exc.code in {
                    "cancelled",
                    "stale_record",
                    "version_changed",
                    "stale_source",
                    "source_changed",
                    "connection_changed",
                    "paused",
                }:
                    raise
                payload = {
                    "ok": False,
                    "error": {
                        "code": getattr(exc, "code", "invalid_arguments"),
                        "message": str(exc)[:1600],
                    },
                }
                images = []
            content = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
            content.extend(
                {"type": "image", "data": i["data"], "mimeType": i["mimeType"]} for i in images
            )
            if message and call.get("id"):
                state["messages"].append(
                    {
                        "role": "toolResult",
                        "toolCallId": call["id"],
                        "toolName": call["name"],
                        "content": content,
                        "isError": not payload.get("ok", True),
                        "timestamp": int(time.time() * 1000),
                    }
                )
            else:
                state["messages"].append(
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "origin": {"kind": "tool_result", "tool": call["name"]},
                                "result": payload,
                            },
                            ensure_ascii=False,
                        ),
                        "timestamp": int(time.time() * 1000),
                    }
                )
        state["round"] = index + 1
        save(state)
    raise AgentServiceError("analysis_limit", "本轮读取预算已用完；已保存进度，可以继续。")


class MaintenanceReader:
    def __init__(self, data_root, state_root, store, sources, ledger=None, *, snapshot_store=None):
        self.store = store
        self.sources = sources
        self.allowed_sources = set(sources)
        self.registry = ToolRegistry(
            data_root, state_root, source_ids=self.allowed_sources, snapshot_store=snapshot_store
        )
        self.ledger = copy.deepcopy(ledger or {"records": {}, "basis": {}, "coverage": {}})
        self.allowed_sources.update(item["source_id"] for item in self.ledger["basis"].values())
        for rid in self.ledger["records"]:
            source = getattr(store.records[rid].record, "source_ref", None)
            if source:
                self.allowed_sources.add(source)

    def call(self, name, arguments):
        if name not in self.registry.entries:
            raise AgentServiceError("invalid_tool", "未知查询工具。")
        args = self.registry.entries[name][1].model_validate(arguments).model_dump(mode="json", exclude_unset=True)
        # Pin workspace/revision in application code; caller cannot replace them.
        if (
            args.get("expected_persona_revision") is not None
            and args["expected_persona_revision"] != self.store.config.revision
        ):
            raise AgentServiceError("version_changed", "请使用本轮 Persona 版本。")
        args["expected_persona_revision"] = self.store.config.revision
        args["max_chars"] = min(args.get("max_chars", 24000), 48000)
        if name == "search_source_content" and not args.get("source_ids") and not args.get("files"):
            args["source_ids"] = sorted(self.allowed_sources)
            if not args["source_ids"]:
                raise AgentServiceError("out_of_scope", "请先选择依据或读取相关来源记录。")
        source_ids = set(args.get("source_ids") or [])
        source_ids.update(f["source_id"] for f in args.get("files", []) or [])
        if args.get("source_id"):
            source_ids.add(args["source_id"])
        if args.get("passage_ref"):
            source_ids.add(unpack(args["passage_ref"])["source_id"])
        if args.get("evidence_id"):
            loaded = self.store.records.get(args["evidence_id"])
            if loaded:
                source_ids.add(getattr(loaded.record, "source_id", ""))
        if not source_ids <= self.allowed_sources:
            raise AgentServiceError("out_of_scope", "此来源尚未选为依据或从相关记录中读取。")
        payload, images = self.registry.call(name, args)
        if not payload.get("ok"):
            error = payload.get("error") or {}
            if error.get("code") in {"version_changed", "source_changed", "stale_source"}:
                raise AgentServiceError(error["code"], error["message"])
            return payload, images
        if name in {"get_persona_records", "get_preference_records"}:
            for item in payload.get("data", {}).get("items", []):
                if item.get("completeness") == "complete" and not item.get("omitted_fields"):
                    rid = item["id"]
                    self.ledger["records"][rid] = item["record_revision"]
                    source = item.get("record", {}).get("source_ref")
                    if source:
                        self.allowed_sources.add(source)
                elif item.get("completeness") == "partial" and not item.get("omitted_fields"):
                    parts = self.ledger.setdefault("parts", {}).setdefault(item["id"], {})
                    if "continued_fields" in item:
                        parts["fields"] = item["continued_fields"]
                        parts["revision"] = item["record_revision"]
                    if "field" in item:
                        field = parts.setdefault(
                            item["field"], {"ranges": [], "total": item["total_chars"]}
                        )
                        field["ranges"].append(
                            [item["offset"], item["offset"] + len(item["value"])]
                        )
                    if "fields" in parts and all(
                        self.covered(
                            parts.get(f, {}).get("ranges", []), parts.get(f, {}).get("total", 1)
                        )
                        for f in parts["fields"]
                    ):
                        self.ledger["records"][item["id"]] = parts["revision"]
        if name == "read_source":
            self.record_excerpt(payload["data"])
        return payload, images

    @staticmethod
    def covered(ranges, total):
        end = 0
        for start, stop in sorted(ranges):
            if start > end:
                return False
            end = max(end, stop)
        return end >= total

    def record_excerpt(self, data):
        if data.get("view") != "text" or not data.get("text"):
            return
        source_id = data["file_ref"]["source_id"]
        manifest = self.store.sources[source_id]
        file = next(f for f in manifest.files if file_id(f) == data["file_ref"]["file_id"])
        selection = data.get("selection", {})
        lines = selection.get("lines")
        # A partial line or PDF page cannot be converted to a line Evidence claim.
        if not lines or selection.get("offset") or data.get("truncated"):
            return
        evidence = {
            "source_id": source_id,
            "file": file.path,
            "line_start": lines["start"],
            "line_end": lines["end"],
            "source_hash": "sha256:" + manifest.content_hash,
            "text": data["text"],
            "kind": self.sources.get(source_id, {}).get("kind", "material"),
        }
        ref = "b_" + hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()[:20]
        self.ledger["basis"][ref] = evidence
        self.ledger["coverage"].setdefault(source_id, []).append([lines["start"], lines["end"]])
        data["basis_ref"] = ref

    def full_record(self, rid):
        loaded = self.store.records[rid]
        name = (
            "get_preference_records"
            if loaded.record.entity_type.startswith("preference")
            else "get_persona_records"
        )
        return self.call(name, {"record_ids": [rid], "max_chars": 48000})[0]
