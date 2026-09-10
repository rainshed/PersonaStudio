from __future__ import annotations

from typing import Literal

from pydantic import Field

from ..maintenance.contracts import Basis, Candidate, Contract, Finish

DEFAULT_KNOWLEDGE = "提取材料中重要、可独立检索和复用的专有名词，包括领域、方法、概念和研究对象。优先广泛使用且与现有知识相关的术语；复用已有节点，避免泛词、临时表述和过度细分。新提出但重要的术语需标明其适用范围。"
DEFAULT_RELATIONS = "只提取有原文依据、语义明确的关系，说明方向与适用条件；共同出现不等于存在关系。保留分歧与不确定性，不推断我的掌握、兴趣或阅读状态。"


class Policy(Contract):
    knowledge: str = Field(default=DEFAULT_KNOWLEDGE, min_length=1, max_length=3000)
    relations: str = Field(default=DEFAULT_RELATIONS, min_length=1, max_length=3000)
    goal: str = Field(
        default="整理材料、知识点及其关系，生成一套可审核的知识图。", min_length=1, max_length=3000
    )
    collect_materials: bool = True
    output_language: Literal["zh", "en"] = "zh"
    focus: str = Field(default="", max_length=1000)
    reading: Literal["targeted", "full"] = "targeted"
    max_nodes: int = Field(default=20, ge=1, le=100, strict=True)
    phase_timeout_seconds: int = Field(default=900, ge=60, le=3600)


class BudgetOmission(Contract):
    title: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=2000)
    basis: list[Basis] = Field(min_length=1, max_length=30)


class Draft(Finish):
    changes: list[Candidate] = Field(default_factory=list, max_length=300)
    budget_omissions: list[BudgetOmission] = Field(default_factory=list, max_length=100)


class SourceAnalysis(Contract):
    summary: str = Field(min_length=1, max_length=12000)
    changes: list[Candidate] = Field(default_factory=list, max_length=150)
    budget_omissions: list[BudgetOmission] = Field(default_factory=list, max_length=100)
    limitations: list[str] = Field(default_factory=list, max_length=30)
    complete: bool = True


class ToolInput(Contract):
    action: Literal[
        "schema",
        "overview",
        "read",
        "search",
        "record",
        "find_records",
        "page",
        "checkpoint",
        "submit",
    ]
    source_id: str | None = None
    start: int = Field(default=1, ge=1)
    count: int = Field(default=80, ge=1, le=200)
    query: str = Field(default="", max_length=500)
    record_id: str | None = None
    page: int = Field(default=1, ge=1)
    analysis: SourceAnalysis | None = None
    draft: Draft | None = None


def output_contract():
    """Application-owned output vocabulary, independent of agent reading strategy."""
    from ..material_analysis import PERSONAL_FIELDS, field_contracts

    contracts = {
        k: v
        for k, v in field_contracts(False, True).items()
        if k in {"knowledge_node", "material", "relation"}
    }
    application_fields = PERSONAL_FIELDS | {"evidence_refs"}
    for entity, contract in contracts.items():
        for key in ("create", "relate", "update", "required_on_create"):
            if key in contract:
                contract[key] = [f for f in contract[key] if f not in application_fields]
        contract["properties"] = {
            k: v for k, v in contract["properties"].items() if k not in application_fields
        }
        if entity == "material":
            contract["application_defaults"] = (
                "Source metadata supplies material_type and bibliography; source_ref must be an actual task source ID."
            )
    return {
        "entities": contracts,
        "tool_limits": {
            "read_count_max": 200,
            "read_characters_max": 18000,
            "overview_candidates_page_max": 10,
        },
        "evidence": "Use candidate basis references from read results. evidence_refs is assigned by the application; never put it in values.",
        "references": "New candidate endpoints use source_ref/target_ref = client_ref. Existing endpoints use source_id/target_id = record ID.",
        "relations": "covers is directed from material to knowledge, with knowledge_role and salience. Other relation types connect knowledge nodes. statement, knowledge_role and salience are only valid for covers. For knowledge-to-knowledge relations, put the precise supported meaning and qualifications in the candidate reason; relation_type must use an allowed enum.",
        "submission": "Submit the complete intended proposal. Submit is a final write to review, not a validation probe. Validation failures save no proposals and return correctable errors; do not discard supported candidates to test the endpoint.",
    }
