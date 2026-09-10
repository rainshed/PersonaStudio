"""Compile model candidates using application-owned scope, versions and sources."""

from __future__ import annotations

from ..agent import AgentServiceError, InlineEvidenceInput, ProposalChangeInput
from ..material_analysis import normalized
from ..models import Relation
from .matching import preference_key

PERSONAL = {
    "knowledge_level",
    "interest_level",
    "preference_level",
    "user_relationships",
    "preference_reasons",
}


def descendants(store, root):
    ids = {root}
    changed = True
    while changed:
        changed = False
        for r in store.of_type(Relation, active_only=True):
            if r.relation_type == "broader_than" and r.source_id in ids and r.target_id not in ids:
                ids.add(r.target_id)
                changed = True
    return ids


def compile_candidates(result, spec, store, ledger):
    collected = {
        v.record.source_ref for v in store.records.values() if v.record.entity_type == "material"
    }
    requested = set(spec.collect_attachment_ids) - collected
    proposed = {
        c.values.get("source_ref")
        for c in result.changes
        if c.entity_type == "material" and c.operation == "create"
    }
    if result.kind != "clarify" and not requested <= proposed:
        raise AgentServiceError("missing_collection", "请为每份选定收录的附件生成材料候选。")
    if result.kind != "propose":
        if (
            result.changes
            or (result.kind == "clarify" and not result.questions)
            or (result.kind == "no_change" and result.questions)
        ):
            raise AgentServiceError("invalid_model_output", "澄清与无变更不能携带候选。")
        return []
    if not result.changes or result.questions:
        raise AgentServiceError("invalid_model_output", "请提交有效候选，或先澄清阻断性问题。")
    allowed = set(spec.target_types)
    if "preference" in allowed:
        allowed.update({"preference_context", "preference_example"})
    if allowed & {"knowledge_node", "material", "course"}:
        allowed.add("relation")
    refs = {c.client_ref: c for c in result.changes}
    if len(refs) != len(result.changes):
        raise AgentServiceError("duplicate_change", "候选临时引用重复。")
    scope = descendants(store, spec.knowledge_root) if spec.knowledge_root else None
    scoped_new = set(scope or ())
    if scope:
        for _ in result.changes:
            for r in result.changes:
                if r.entity_type == "relation" and r.values.get("relation_type") == "broader_than":
                    source = r.values.get("source_id", r.values.get("source_ref"))
                    target = r.values.get("target_ref")
                    if (
                        source in scoped_new
                        and target in refs
                        and refs[target].entity_type == "knowledge_node"
                    ):
                        scoped_new.add(target)
    selected = [store.records[r].record for r in spec.record_ids]
    changes = []
    known_names = {
        normalized(name): loaded.record.id
        for loaded in store.records.values()
        if loaded.record.entity_type == "knowledge_node" and loaded.record.status == "active"
        for name in [loaded.record.title, *loaded.record.aliases]
    }
    for c in result.changes:
        if c.entity_type not in allowed:
            raise AgentServiceError("out_of_scope", "候选修改了未选择的类型：" + c.entity_type)
        if c.operation == "create" and any(r.entity_type == c.entity_type for r in selected):
            raise AgentServiceError(
                "out_of_scope", "已限定具体记录；如需新增同类条目，请调整维护范围。"
            )
        if c.target_id:
            current = store.records.get(c.target_id)
            if not current or ledger["records"].get(c.target_id) != current.record.revision:
                raise AgentServiceError("read_required", "修改前请完整读取当前记录：" + c.target_id)
            if current.record.entity_type != c.entity_type:
                raise AgentServiceError("invalid_reference", "目标对象类型不符。")
            same_type = [r.id for r in selected if r.entity_type == c.entity_type]
            if same_type and c.target_id not in same_type:
                raise AgentServiceError("out_of_scope", "候选不属于指定记录范围。")
            if scope and c.entity_type == "knowledge_node" and c.target_id not in scope:
                raise AgentServiceError("out_of_scope", "候选不属于指定知识分支。")
        evidence = []
        kinds = set()
        for basis in c.basis:
            item = ledger["basis"].get(basis.ref)
            if not item:
                raise AgentServiceError("invalid_evidence", "依据未实际提供给模型：" + basis.ref)
            kinds.add(item["kind"])
            if item["line_end"] - item["line_start"] >= 500:
                raise AgentServiceError(
                    "invalid_evidence", "请补读更精确的证据片段（最多 500 行）。"
                )
            evidence.append(
                InlineEvidenceInput(
                    source_id=item["source_id"],
                    file=item["file"],
                    line_start=item["line_start"],
                    line_end=item["line_end"],
                    evidence_kind="explicit_user_statement"
                    if item["kind"] == "user_statement"
                    else "read_signal",
                )
            )
        if not evidence and c.operation in {"create", "update", "relate"}:
            raise AgentServiceError("evidence_required", "请引用用户要求或实际读取的来源。")
        personal = {
            k
            for k in PERSONAL & c.values.keys()
            if c.values[k] not in (None, "", "unspecified", [])
        }
        if (
            c.entity_type == "material"
            and c.operation == "create"
            and c.values.get("source_ref") in spec.collect_attachment_ids
        ):
            personal.discard("user_relationships")
        if personal and "user_statement" not in kinds:
            raise AgentServiceError("personal_scope_required", "个人状态需要用户明确陈述作为依据。")
        if c.entity_type.startswith("preference") and "user_statement" not in kinds:
            raise AgentServiceError("personal_scope_required", "偏好需要用户明确表达或采用意图。")
        context_ids = [r.id for r in selected if r.entity_type == "preference_context"]
        if context_ids and c.entity_type in {"preference", "preference_example"}:
            current_values = store.records[c.target_id].record.model_dump() if c.target_id else {}
            resolved = {**current_values, **c.values}
            if not set(resolved.get("context_refs", [])) <= set(context_ids) or not resolved.get(
                "context_refs"
            ):
                raise AgentServiceError("out_of_scope", "偏好必须保持在选定场景内。")
        if scope and c.operation == "create" and c.entity_type == "knowledge_node":
            if c.client_ref not in scoped_new:
                raise AgentServiceError("out_of_scope", "新知识需通过关系明确归入选定分支。")
        values = dict(c.values)
        if c.entity_type == "knowledge_node" and c.operation == "create":
            values.setdefault("knowledge_level", "unspecified")
            values.setdefault("interest_level", "unspecified")
            names = [values.get("title", ""), *values.get("aliases", [])]
            if any(normalized(name) in known_names for name in names if name):
                raise AgentServiceError("duplicate_change", "请读取并复用已有的同名知识或别名。")
            known_names.update({normalized(n): c.client_ref for n in names if n})
        if c.entity_type == "preference_context" and c.operation == "create":
            if any(
                r.record.entity_type == "preference_context" and r.record.key == values.get("key")
                for r in store.records.values()
            ):
                raise AgentServiceError(
                    "duplicate_change", "请读取并复用已有场景，包括已暂停场景。"
                )
        if c.entity_type == "preference" and c.operation == "create":
            context_keys = {
                r.record.id: r.record.key
                for r in store.records.values()
                if r.record.entity_type == "preference_context"
            }
            context_keys.update(
                {
                    item.client_ref: item.values.get("key", item.client_ref)
                    for item in result.changes
                    if item.entity_type == "preference_context"
                }
            )
            if any(
                r.record.entity_type == "preference"
                and r.record.status != "archived"
                and preference_key(r.record.model_dump(), context_keys)
                == preference_key(values, context_keys)
                for r in store.records.values()
            ):
                raise AgentServiceError(
                    "duplicate_change", "请复用已有偏好；暂停的偏好也不能重复新增。"
                )
        if c.entity_type == "material" and c.operation == "create":
            values = {
                **ledger.get("material_metadata", {}).get(values.get("source_ref"), {}),
                **values,
            }
            values.setdefault("bibliography", {})
            relationship = spec.attachment_relationships.get(values.get("source_ref"))
            if not relationship and not ledger.get("allow_unspecified_relationship"):
                raise AgentServiceError("needs_input", "收录材料前需要用户明确选择阅读或作者关系。")
            values["user_relationships"] = [relationship] if relationship else []
            values.setdefault("preference_level", "unspecified")
            if values.get("source_ref") not in spec.collect_attachment_ids:
                raise AgentServiceError("out_of_scope", "只有明确选择收录的附件才能成为材料。")
        relation_values = {
            **(store.records[c.target_id].record.model_dump() if c.target_id else {}),
            **values,
        }
        for field in ("source_id", "target_id"):
            if c.entity_type == "relation" and relation_values.get(field):
                rid = relation_values[field]
                if rid not in ledger["records"]:
                    raise AgentServiceError("read_required", "建立关系前请读取端点：" + rid)
                if (
                    scope
                    and store.records[rid].record.entity_type == "knowledge_node"
                    and rid not in scope
                ):
                    raise AgentServiceError("out_of_scope", "关系超出选定知识分支。")
        if c.entity_type == "relation" and selected:
            endpoint_ids = {relation_values.get("source_id"), relation_values.get("target_id")}
            domain_selected = {
                r.id for r in selected if r.entity_type in {"knowledge_node", "course", "material"}
            }
            if domain_selected and not endpoint_ids & domain_selected:
                raise AgentServiceError("out_of_scope", "关系必须关联选定的维护记录。")
        changes.append(
            ProposalChangeInput(
                client_ref=c.client_ref,
                operation=c.operation,
                entity_type=c.entity_type,
                target_id=c.target_id,
                values=values,
                reason=c.reason,
                conflicts=c.conflicts,
                expected_record_revision=ledger["records"].get(c.target_id)
                if c.target_id
                else None,
                evidence=evidence if c.operation in {"create", "update", "relate"} else [],
            )
        )
    return changes
