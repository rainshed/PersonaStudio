"""Interactive entry adapter, preserving existing drafts and review ownership."""

from __future__ import annotations

import hashlib
import json
import time

from ..agent import AgentServiceError
from ..material_analysis import compact_schema, field_contracts
from ..query_sources import file_id
from ..store import PersonaStore
from .compiler import compile_candidates
from .contracts import Basis, Candidate, Finish, MaintenanceInput, ModelAction
from .runner import MaintenanceReader, loop
from .sources import save_text


def validate_input(service, raw, attachments):
    spec = MaintenanceInput.model_validate(raw)
    store = PersonaStore(service.data_root).load()
    for rid in [
        *spec.record_ids,
        *spec.material_ids,
        *([spec.knowledge_root] if spec.knowledge_root else []),
    ]:
        if rid not in store.records:
            raise AgentServiceError("not_found", "选定记录不存在。")
    if any(store.records[r].record.entity_type != "material" for r in spec.material_ids):
        raise AgentServiceError("invalid_request", "参考材料类型不符。")
    if (
        spec.knowledge_root
        and store.records[spec.knowledge_root].record.entity_type != "knowledge_node"
    ):
        raise AgentServiceError("invalid_request", "请选择知识分支。")
    for rid in spec.record_ids:
        kind = store.records[rid].record.entity_type
        if ("preference" if kind.startswith("preference") else kind) not in spec.target_types:
            raise AgentServiceError("out_of_scope", "选定记录与维护对象类型不一致。")
    if spec.knowledge_root and "knowledge_node" not in spec.target_types:
        raise AgentServiceError("out_of_scope", "限定知识分支时需选中知识维护类型。")
    owned = {a["id"] for a in attachments}
    if not set(spec.attachment_ids) <= owned or not set(spec.collect_attachment_ids) <= set(
        spec.attachment_ids
    ):
        raise AgentServiceError("out_of_scope", "附件不属于当前任务。")
    if spec.collect_attachment_ids and "material" not in spec.target_types:
        raise AgentServiceError("out_of_scope", "收录附件需要选中材料维护类型。")
    if not set(spec.attachment_relationships) <= set(spec.collect_attachment_ids):
        raise AgentServiceError("out_of_scope", "阅读状态只用于选定收录的附件。")
    if not set(spec.collect_attachment_ids) <= set(spec.attachment_relationships):
        raise AgentServiceError(
            "needs_input", "收录材料前，请选择你与这份材料的关系；仅作为参考时可以取消收录。"
        )
    return spec.model_dump()


def update_input(service, session_id, raw, version):
    value = service.get_session(session_id)
    service._require_refinable(value)
    if value["status"] in {"running", "submitting"} or value["version"] != version:
        raise AgentServiceError("busy", "请等待处理完成并使用当前任务版本。")
    config = validate_input(service, raw, value.get("attachments", []))
    return service.repository.update(session_id, {"maintenance": config}, version)


def attach(service, session_id, text, title, version):
    value = service.get_session(session_id)
    service._require_refinable(value)
    if value["status"] in {"running", "submitting"} or value["version"] != version:
        raise AgentServiceError("busy", "请等待处理完成并使用当前任务版本。")
    if len(value.get("attachments", [])) >= 20:
        raise AgentServiceError("input_limit", "每个任务最多 20 份附件。")
    source = save_text(
        service.data_root, service.state_root, text=text, title=title, kind="attachment"
    )
    return service.repository.update(
        session_id, {"attachments": [*value.get("attachments", []), source]}, version
    )


def validate_edit(value, output, store):
    """Edits use the same compiler; the browser cannot expand IDs, sources or scope."""
    ledger = value["checkpoint"]["ledger"]
    candidates = []
    for c in output.changes:
        basis = []
        for evidence in c.evidence:
            ref = next(
                (
                    ref
                    for ref, item in ledger["basis"].items()
                    if all(
                        getattr(evidence, k) == item[k]
                        for k in ("source_id", "file", "line_start", "line_end")
                    )
                ),
                None,
            )
            if ref is None:
                raise AgentServiceError("invalid_evidence", "编辑引用了本轮未读取的依据。")
            basis.append(Basis(ref=ref))
        candidates.append(
            Candidate(
                client_ref=c.client_ref,
                operation=c.operation,
                entity_type=c.entity_type,
                target_id=c.target_id,
                values=c.values,
                basis=basis,
                reason=c.reason,
                conflicts=c.conflicts,
            )
        )
    result = Finish(
        kind="propose" if candidates else "no_change",
        summary=output.reply,
        changes=candidates,
        questions=output.questions,
    )
    output.changes = compile_candidates(
        result, MaintenanceInput.model_validate(value["result_input"]), store, ledger
    )
    return output


def run_session(service, session_id, run_id):
    from ..ai_service import DraftOutput, now

    value = service.repository.get(session_id)
    if value["status"] != "running" or value["run_id"] != run_id:
        return value
    try:
        spec = MaintenanceInput.model_validate(value["maintenance"])
        store = PersonaStore(service.data_root).load()
        task = "material" if spec.material_ids or spec.attachment_ids else "maintenance"
        model_signature = (
            service.model.configuration_signature(task)
            if hasattr(service.model, "configuration_signature")
            else None
        )
        sources = {
            a["id"]: a for a in value.get("attachments", []) if a["id"] in spec.attachment_ids
        }
        for rid in spec.material_ids:
            r = store.records[rid].record
            sources[r.source_ref] = {
                "id": r.source_ref,
                "title": r.title,
                "kind": "material",
                "material_id": rid,
                "source_hash": "sha256:" + store.sources[r.source_ref].content_hash,
            }
        # Explicit foreground messages have a separate origin from quoted attachments.
        for source in value.get("message_sources", []):
            sources[source["id"]] = source
        signature = hashlib.sha256(
            json.dumps(
                {
                    "input": spec.model_dump(),
                    "sources": sources,
                    "revision": store.config.revision,
                    "messages": value["messages"],
                    "draft": value["draft"],
                    "prompts": value.get("prompt_snapshot"),
                    "model": model_signature,
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        cp = value.get("checkpoint") or {}
        if cp.get("key") != signature:
            cp = {"key": signature}
        reader = MaintenanceReader(
            service.data_root, service.state_root, store, sources, cp.get("ledger")
        )
        reader.ledger["material_metadata"] = {
            sid: item["material_metadata"]
            for sid, item in sources.items()
            if item.get("material_metadata")
        }

        def alive():
            current = service.repository.get(session_id)
            if current["status"] != "running" or current["run_id"] != run_id:
                raise AgentServiceError("cancelled", "任务已取消或进入新一轮。")
            if (
                hasattr(service.model, "configuration_signature")
                and service.model.configuration_signature(task) != model_signature
            ):
                raise AgentServiceError(
                    "connection_changed", "模型配置在本轮中变化，请继续重新匹配。"
                )

        def save(state):
            alive()
            cp.update(loop=state, ledger=reader.ledger)
            service._save_running(session_id, run_id, checkpoint=cp, stage="读取与整理维护候选")

        def dispatch(name, args):
            alive()
            return reader.call(name, args)

        if "context" not in cp:
            context = {
                "schema_version": "ai-persona.maintenance-context/v1",
                "persona_revision": store.config.revision,
                "origin": {"kind": "maintenance_task", "id": session_id},
                "request": {"origin": "user_messages", "messages": value["messages"]},
                "scope": {"origin": "user_selection", **spec.model_dump()},
                "sources": [],
                "records": [],
                "source_content": [],
                "analysis_parts": [],
                "previous_draft": value["draft"],
                "field_contracts": {
                    k: v
                    for k, v in field_contracts(False, True).items()
                    if k
                    in {*spec.target_types, "relation", "preference_context", "preference_example"}
                },
                "output_schema": compact_schema(ModelAction.model_json_schema()),
            }
            for rid in spec.record_ids:
                context["records"].append(reader.full_record(rid))
            query = next(m["content"] for m in reversed(value["messages"]) if m["role"] == "user")[
                :4000
            ]
            searches = []
            if "preference" in spec.target_types:
                searches.append(("search_preferences", {"query": query, "limit": 8}))
            domains = [k for k in spec.target_types if k != "preference"]
            if domains:
                searches.append(
                    ("search_knowledge", {"query": query, "entity_types": domains, "limit": 8})
                )
            context["initial_searches"] = [
                dispatch(name, {**args, "max_chars": 12000})[0] for name, args in searches
            ]
            used = 0
            for sid, item in sources.items():
                manifest = store.sources[sid]
                file = next(
                    (
                        f
                        for f in manifest.files
                        if f.role == "extracted_text" and f.media_type.startswith("text/")
                    ),
                    next((f for f in manifest.files if f.media_type.startswith("text/")), None),
                )
                if file is None:
                    raise AgentServiceError(
                        "source_text_required", "请为材料补充可定位的文本：" + item["title"]
                    )
                content = store.source_file_path(sid, file.path).read_bytes()
                if hashlib.sha256(content).hexdigest() != file.sha256:
                    raise AgentServiceError("source_changed", "资料内容已变化，请重新添加。")
                text = content.decode("utf-8-sig")
                lines = text.splitlines()
                context["sources"].append(
                    {
                        "source_id": sid,
                        "file_id": file_id(file),
                        "origin": item,
                        "line_count": len(lines),
                    }
                )
                ranges = [{"line_start": 1, "line_end": len(lines)}]
                if item["kind"] != "user_statement":
                    continue
                for span in ranges:
                    for start in range(span["line_start"], span["line_end"] + 1, 100):
                        result, _ = dispatch(
                            "read_source",
                            {
                                "source_id": sid,
                                "file_id": file_id(file),
                                "view": "text",
                                "selector": {
                                    "lines": {
                                        "start": start,
                                        "end": min(start + 99, span["line_end"]),
                                    }
                                },
                                "max_chars": 48000,
                            },
                        )
                        if not result.get("ok") or result["data"].get("truncated"):
                            raise AgentServiceError(
                                "context_length", "文本段无法完整读取，请拆分长行或选择按需读取。"
                            )
                        used += len(result["data"].get("text", ""))
                        if used > 150000:
                            raise AgentServiceError(
                                "context_length", "候选阶段原文超过容量，请减少本轮资料。"
                            )
                        context["source_content"].append(result)
            cp["context"] = context
            save({"messages": [], "round": 0})
        context = cp["context"]
        definitions = reader.registry.definitions()
        definitions.append(
            {
                "name": "finish_maintenance",
                "description": "Submit the complete candidate result for validation; never approves or publishes.",
                "parameters": Finish.model_json_schema(),
            }
        )
        preview = service.prompts.preview(
            "ai-persona.maintenance-agent",
            {"payload": context},
            snapshot=value.get("prompt_snapshot"),
        )
        prompt = preview["rendered"]["system"]
        service.prompts.capture(
            "ai-persona.maintenance-agent",
            {"payload": context},
            value.get("prompt_snapshot"),
            origin=session_id,
        )

        def request(state):
            alive()
            started = time.monotonic()
            service._save_running(session_id, run_id, stage="生成维护建议", stage_started_at=now())
            raw = None
            if hasattr(service.model, "step") and cp.get("transport") != "json":
                try:
                    raw = service.model.step(
                        task,
                        prompt,
                        [
                            {
                                "role": "user",
                                "content": preview["rendered"]["user"],
                                "timestamp": int(time.time() * 1000),
                            },
                            *state["messages"],
                        ],
                        definitions,
                        max_tokens=8000,
                        run_id=run_id,
                        stage="维护工具调用",
                    )
                except AgentServiceError as exc:
                    if exc.code != "tools_unsupported":
                        raise
                    cp["transport"] = "json"
                    save(state)
            if raw is None:
                raw = service.model.generate(
                    task,
                    prompt,
                    {**context, "tools": definitions, "tool_results": state["messages"]},
                    max_tokens=8000,
                    run_id=run_id,
                    stage="维护工具调用",
                )
            current = service.repository.get(session_id)
            service._save_running(
                session_id,
                run_id,
                model_runs=[
                    *current.get("model_runs", []),
                    {
                        "stage": "维护核心",
                        "status": "succeeded",
                        "durationMs": int((time.monotonic() - started) * 1000),
                        **{k: raw[k] for k in ("modelId", "usage") if k in raw},
                    },
                ][-100:],
            )
            return raw

        def finish(result):
            alive()
            latest = PersonaStore(service.data_root).load()
            if latest.config.revision != store.config.revision:
                raise AgentServiceError("stale_record", "Persona 已变化，请继续以重新匹配。")
            changes = compile_candidates(result, spec, store, reader.ledger)
            output = DraftOutput(reply=result.summary, changes=changes, questions=result.questions)
            clean = output.model_dump(mode="json")
            clean["changes"] = service._validate_changes(
                output, {**value, "material_id": None, "source": None}, store
            )
            return result, clean

        state = cp.get("loop") or {"messages": [], "round": 0}
        result, clean = loop(
            request, dispatch, finish, checkpoint=state, rounds=state.get("round", 0) + 8, save=save
        )
        alive()
        cp["ledger"] = reader.ledger
        ready = service.repository.update(
            session_id,
            {
                "status": "ready",
                "stage": "候选校验完成",
                "draft": clean,
                "base_revision": store.config.revision,
                "submission_key": None,
                "maintenance_result": result.model_dump(),
                "result_input": spec.model_dump(),
                "maintenance_sources": {
                    sid: "sha256:" + store.sources[sid].content_hash
                    for sid in reader.allowed_sources
                },
                "checkpoint": cp,
                "messages": [*value["messages"], {"role": "assistant", "content": result.summary}],
            },
            expected_run=run_id,
        )
        return service._auto_submit(ready)
    except Exception as exc:
        current = service.repository.get(session_id)
        if current["status"] != "running" or current["run_id"] != run_id:
            return current
        return service.repository.update(
            session_id,
            {
                "status": "failed",
                "error": {
                    "code": getattr(exc, "code", "analysis_failed"),
                    "message": str(exc)[:1200],
                },
            },
            expected_run=run_id,
        )
