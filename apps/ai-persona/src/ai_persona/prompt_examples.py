"""Synthetic inputs use the current code contracts; never read Persona records."""

from copy import deepcopy


def with_example(detail):
    from .ai_service import ActivationOutput, DraftOutput
    from .conversation_learning.contracts import CandidateOutput, SignalOutput
    from .maintenance.contracts import ModelAction
    from .material_analysis import MaterialAnalysis, compact_schema, field_contracts

    key = detail["id"].split(".")[-1]
    classes = {
        "activation": ActivationOutput,
        "maintenance": DraftOutput,
        "maintenance-agent": ModelAction,
        "material-analysis": MaterialAnalysis,
        "material-candidate": DraftOutput,
        "conversation-signal": SignalOutput,
        "conversation-candidate": CandidateOutput,
    }
    if key not in classes:
        return detail
    schema = compact_schema(classes[key].model_json_schema())
    payload = {"output_schema": schema}
    if key == "activation":
        payload.update(
            user_prompt="请解释示例方法的适用条件。",
            task_summary="",
            recent_messages=[],
            artifact_type=None,
            catalog=[
                {
                    "key": "example.explanation",
                    "name": "概念解释",
                    "description": "解释概念、方法及其适用条件",
                    "activation": {
                        "intents": ["请帮我解释这个概念，并说明它适用于什么情况。"],
                        "excludes": ["仅列出词语"],
                    },
                }
            ],
        )
    elif key == "material-analysis":
        payload.update(
            source={"file": "synthetic-example.md"},
            segment={
                "line_start": 1,
                "line_end": 2,
                "text": "1: This synthetic example studies diffusion on a one-dimensional chain.\n2: The model assumes nearest-neighbor coupling and does not establish results for higher dimensions.",
            },
            total_lines=2,
            goal=[{"role": "user", "content": "概括方法与限制，保留原文证据。"}],
        )
    elif key == "conversation-signal":
        payload.update(current_user_prompt="以后解释数学概念时，请先定义符号再给公式。", context=[])
    elif key == "conversation-candidate":
        contracts = field_contracts(False, True)
        contracts = {
            k: v
            for k, v in contracts.items()
            if k in {"knowledge_node", "preference", "preference_context", "relation"}
        }
        for contract in contracts.values():
            for field in ("evidence_refs", "knowledge_level", "interest_level", "status"):
                contract.get("properties", {}).pop(field, None)
                for action in ("create", "update", "relate", "required_on_create"):
                    if field in contract.get(action, []):
                        contract[action].remove(field)
        payload.update(
            current_user_prompt="请解释 diffusion。",
            observations=[
                {
                    "id": "example-signal",
                    "kind": "knowledge",
                    "statement": "用户请求解释 diffusion。",
                    "topic": "diffusion",
                    "scope": "",
                    "temporary": False,
                }
            ],
            records=[],
            catalog=[],
            catalog_may_be_partial=False,
            existing_relations=[],
            review_history=[],
            field_contracts=contracts,
        )
    else:
        payload.update(
            messages=[{"role": "user", "content": "解释时先给结论，再说明适用范围。"}],
            previous_draft=None,
            catalog=[],
            catalog_complete=True,
            records=[],
            persona_revision=0,
            allow_personal=key == "maintenance",
            field_contracts=field_contracts(key == "material-candidate", key == "maintenance"),
        )
        if key == "material-candidate":
            payload.update(
                messages=[{"role": "user", "content": "仅解释所需证据，资料不足时不要生成修改。"}],
                source=None,
                analysis_parts=[],
                original_excerpts=[],
            )
    return {
        **deepcopy(detail),
        "example": {"payload": payload},
        "example_note": "内置虚构示例；真实任务可从运行记录载入输入。",
        "output_schema": schema,
    }
