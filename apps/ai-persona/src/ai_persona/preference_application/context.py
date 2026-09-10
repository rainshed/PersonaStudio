"""Complete deterministic preference selection; no model, ranking or truncation."""

from __future__ import annotations

import hashlib

from ..agent import AgentServiceError
from ..models import Preference, PreferenceContext, PreferenceExample
from ..preference_sources import folder_members, is_folder_source
from .repository import encoded


def snapshot_signature(store):
    records = [
        item.record.model_dump(mode="json", by_alias=True)
        for item in store.records.values()
        if isinstance(item.record, (PreferenceContext, Preference, PreferenceExample))
    ]
    return hashlib.sha256(encoded({
        "records": sorted(records, key=lambda r: r["id"]),
        "sources": [store.sources[k].model_dump(mode="json", by_alias=True)
                    for k in sorted(store.sources)],
    }).encode()).hexdigest()


def resource_for(store, sample):
    source = store.sources.get(sample.source_ref)
    resource = {"source_ref": sample.source_ref, "available": False}
    if source is None:
        return resource
    folder = is_folder_source(source)
    resource.update(kind="folder" if folder else "file",
                    name=source.origin.identifier or source.canonical_file)
    try:
        path = store.source_file_path(source.id, source.canonical_file)
        if folder:
            resource.update(archive_location=str(path), file_count=len(folder_members(source)))
            root = (store.data_root / "sources" / source.id).resolve()
            directory = (root / "files" / source.origin.identifier).resolve()
            if directory.is_relative_to(root / "files") and directory.is_dir():
                resource.update(location=str(directory), available=True)
        else:
            info = next(item for item in source.files if item.path == source.canonical_file)
            resource.update(location=str(path), media_type=info.media_type, available=True)
    except (ValueError, OSError, StopIteration):
        pass
    return resource


def build_context(store, matched_ids, turn_id, max_bytes):
    contexts = {c.id: c for c in store.of_type(PreferenceContext, active_only=True)}
    selected = set(matched_ids)
    if not selected <= set(contexts):
        raise AgentServiceError("context_changed", "命中场景已不可用。")
    preferences = []
    for p in sorted(store.of_type(Preference, active_only=True), key=lambda p: p.id):
        if p.scope != "global" and not selected.intersection(p.context_refs):
            continue
        item = {key: getattr(p, key) for key in (
            "id", "scope", "context_refs", "behavior", "instruction", "condition", "rationale"
        )}
        preferences.append({k: v for k, v in item.items() if v != ""})
    samples = []
    for sample in sorted(store.of_type(PreferenceExample, active_only=True), key=lambda s: s.id):
        if selected.intersection(sample.context_refs):
            item = {key: getattr(sample, key) for key in (
                "id", "context_refs", "title", "example_type", "condition", "reasons"
            )}
            samples.append({**{k: v for k, v in item.items() if v != ""},
                            "resource": resource_for(store, sample)})
    if not preferences and not samples:
        return None
    payload = {
        "schema_version": "ai-persona.preference-context-payload/v1",
        "type": "user_preference_context",
        "source": {
            "kind": "saved_user_persona", "owner": "current_user", "time_scope": "long_term",
            "description": "以下信息来自用户保存或确认的长期偏好，为当前任务提供个性化参考。",
            "usage": "结合本次用户请求及适用条件使用这些信息；本次明确要求优先于历史默认偏好。参考样本用于理解用户期望的表现形式。",
        },
        "applies_to": {"turn_id": turn_id,
                       "description": "这是本轮任务的偏好快照；场景命中不代表后续所有任务持续适用。"},
        "matched_contexts": [{"id": contexts[k].id, "name": contexts[k].name,
                              "description": contexts[k].description} for k in sorted(selected)],
        "preferences": preferences, "reference_samples": samples,
    }
    if len(encoded(payload).encode()) > max_bytes:
        raise AgentServiceError("context_budget_exceeded", "完整偏好内容超过本轮提供上限。")
    return payload


def prepare_saved_context(data_root, state_root, result_id, turn_id, max_bytes=24000):
    """MCP uses the same builder, accepting only a completed, current activation."""
    from ..evaluations.contracts import ACTIVATION
    from ..evaluations.store import EvaluationStore
    from ..store import PersonaStore

    store = PersonaStore(data_root).load(verify_source_files=False)
    signature = snapshot_signature(store)
    contexts = sorted(store.of_type(PreferenceContext, active_only=True), key=lambda c: c.key)
    matched = []
    if result_id:
        result = EvaluationStore(data_root, state_root).result(result_id)
        source = result.get("input") or {}
        if (result["capability_id"] != ACTIVATION or result["state"] != "completed"
                or source.get("schema_version") != "ai-persona.activation/v2"):
            raise AgentServiceError("activation_incomplete", "需要已完成的二元场景判断，失败时不提供任何偏好。")
        catalog = [{"key": c.key, "name": c.name, "description": c.description,
                    "activation": c.activation.model_dump(), "revision": c.revision}
                   for c in contexts]
        decisions = result["decisions"]
        by_key = {c.key: c.id for c in contexts}
        keys = [d["subject"].get("context_key") for d in decisions]
        if catalog != source.get("catalog") or len(keys) != len(set(keys)) or set(keys) != set(by_key):
            raise AgentServiceError("context_changed", "场景目录已改变，请重新判断。")
        if any(type(d.get("triggered")) is not bool for d in decisions):
            raise AgentServiceError("activation_incomplete", "场景判断尚未完整完成。")
        matched = [by_key[d["subject"]["context_key"]] for d in decisions if d["triggered"]]
    elif contexts:
        raise AgentServiceError("activation_required", "请先调用场景判断并提供结果标识。")
    payload = build_context(store, matched, turn_id, max_bytes)
    if snapshot_signature(PersonaStore(data_root).load(verify_source_files=False)) != signature:
        raise AgentServiceError("context_changed", "偏好在准备过程中发生变化。")
    return {"ok": True, "context": payload, "activation_result_id": result_id}


def remote_context(payload):
    """Render resource references for clients without access to the Persona filesystem."""
    import copy

    result = copy.deepcopy(payload)
    if result:
        for sample in result.get("reference_samples", []):
            resource = sample.get("resource", {})
            for key in ("location", "archive_location"):
                resource.pop(key, None)
            if resource.get("source_ref"):
                resource["access"] = {
                    "transport": "mcp", "source_id": resource["source_ref"],
                    "list_tool": "list_source_files", "read_tool": "read_source",
                }
    return result
