"""Bounded, source-grounded material analysis. No model or persistence side effects."""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .agent import AgentServiceError
from .models import Relation
from .prompt_store import default_text
from .proposals import CREATE_FIELDS, CREATE_TYPES, UPDATE_FIELDS

PROMPT_VERSION = "material-analysis/v2"
SHORT_TEXT_CHARS = 12000
CHUNK_CHARS = 60000
MAX_CHUNKS = 20
PERSONAL_FIELDS = {
    "knowledge_level",
    "interest_level",
    "preference_level",
    "scope_note",
    "preference_reasons",
    "user_relationships",
    "body",
}


class LineRange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    line_start: int = Field(ge=1)
    line_end: int = Field(ge=1)

    @model_validator(mode="after")
    def ordered(self):
        if not 0 <= self.line_end - self.line_start < 500:
            raise ValueError("range must contain 1–500 original lines")
        return self


class Concept(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    aliases: list[str] = Field(default_factory=list, max_length=8)
    meaning: str = Field(min_length=1, max_length=600)
    evidence: list[LineRange] = Field(min_length=1, max_length=3)


class Claim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["problem", "method", "result", "limitation", "relation"]
    statement: str = Field(min_length=1, max_length=800)
    evidence: list[LineRange] = Field(min_length=1, max_length=3)


class MaterialAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overview: str = Field(min_length=1, max_length=2400)
    concepts: list[Concept] = Field(default_factory=list, max_length=24)
    claims: list[Claim] = Field(default_factory=list, max_length=24)
    uncertainties: list[str] = Field(default_factory=list, max_length=10)


ANALYSIS_PROMPT = default_text("ai-persona.material-analysis")

MATERIAL_DRAFT_PROMPT = default_text("ai-persona.material-candidate")


def compact_schema(schema: dict) -> dict:
    """Remove decorative schema text only; retain constraints and reachable definitions."""

    def clean(value, names=False):
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, dict):
            return {
                k: clean(v, k in {"properties", "$defs"})
                for k, v in value.items()
                if names or k not in {"title", "description"}
            }
        return value

    return clean(schema)


def field_contracts(material: bool, allow_personal: bool) -> dict:
    contracts = {}
    for entity, model in {**CREATE_TYPES, "relation": Relation}.items():
        if (
            material
            and entity not in {"knowledge_node", "material", "relation"}
            and not (allow_personal and entity.startswith("preference"))
        ):
            continue
        create = set(CREATE_FIELDS.get(model, set()))
        update = set(UPDATE_FIELDS.get(model, set()))
        if entity == "relation":
            create = update | {"source_id", "target_id", "relation_type"}
        if material:
            update.discard("status")
            if not allow_personal:
                create -= PERSONAL_FIELDS
                update -= PERSONAL_FIELDS
            if entity == "material":
                create = set()
                update &= {"summary", "aliases", "tags"} | (
                    PERSONAL_FIELDS if allow_personal else set()
                )
        schema = model.model_json_schema()
        properties = {k: v for k, v in schema["properties"].items() if k in create | update}
        if "body" in create | update:
            properties["body"] = {"type": "string"}
        if entity == "relation":
            properties.update(source_ref={"type": "string"}, target_ref={"type": "string"})
            create |= {"source_ref", "target_ref"}
        if entity in {"preference", "preference_example"}:
            properties["context_client_refs"] = {"type": "array", "items": {"type": "string"}}
            create.add("context_client_refs")
            update.add("context_client_refs")
        definitions = {}
        pending = [properties]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                ref = item.get("$ref", "").removeprefix("#/$defs/")
                if ref and ref not in definitions:
                    definitions[ref] = schema["$defs"][ref]
                    pending.append(definitions[ref])
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
        contracts[entity] = compact_schema(
            {
                "create" if entity != "relation" else "relate": sorted(create),
                "update": sorted(update),
                "required_on_create": [
                    k
                    for k in schema.get("required", [])
                    if k in create
                    and not (entity == "relation" and k in {"source_id", "target_id"})
                ],
                "properties": properties,
                "$defs": definitions,
            }
        )
    return contracts


def source_chunks(numbered: str) -> list[dict]:
    lines = numbered.splitlines()
    chunks, start = [], 0
    while start < len(lines):
        end, size = start, 0
        boundary = None
        while end < len(lines) and size + len(lines[end]) + 1 <= CHUNK_CHARS:
            size += len(lines[end]) + 1
            end += 1
            if size > CHUNK_CHARS * 0.65 and (
                not lines[end - 1].partition(": ")[2].strip()
                or (end < len(lines) and re.match(r"\d+: #{1,6} ", lines[end]))
            ):
                boundary = end
        if end == start:
            raise AgentServiceError(
                "context_length", "原文包含超过单段预算的长行，请重新分行导入。"
            )
        if end < len(lines) and boundary:
            end = boundary
        chunks.append(
            {"line_start": start + 1, "line_end": end, "text": "\n".join(lines[start:end])}
        )
        if len(chunks) > MAX_CHUNKS:
            raise AgentServiceError("context_length", "材料超过 20 段分析预算，请按章节拆分材料。")
        start = end
    return chunks


def check_analysis(analysis: MaterialAnalysis, chunk: dict) -> dict:
    for item in [*analysis.concepts, *analysis.claims]:
        for span in item.evidence:
            if not chunk["line_start"] <= span.line_start <= span.line_end <= chunk["line_end"]:
                raise AgentServiceError("invalid_evidence", "分析证据不在本段原文范围内。")
    return {
        "line_start": chunk["line_start"],
        "line_end": chunk["line_end"],
        **analysis.model_dump(mode="json"),
    }


def normalized(text: str) -> str:
    return " ".join(re.findall(r"[\w]+", unicodedata.normalize("NFKC", text).casefold()))


def retrieve(catalog: list[dict], terms: list[str], limit=16) -> list[str]:
    phrases = {normalized(t) for t in terms if len(t.strip()) > 1}
    words = {w for p in phrases for w in p.split() if len(w) > 2}
    scored = []
    for item in catalog:
        names = [normalized(n) for n in [item["name"], *item["aliases"]]]
        summary = normalized(item["summary"])
        score = sum(30 for p in phrases if p in names)
        score += sum(5 for p in phrases if any(p in n or n in p for n in names if n))
        score += sum(1 for w in words if w in summary or any(w in n for n in names))
        if score:
            scored.append((-score, item["id"]))
    return [identifier for _, identifier in sorted(scored)[:limit]]


def excerpts(numbered: str, ranges: list[dict], budget=45000) -> tuple[list[dict], list[dict]]:
    lines = numbered.splitlines()
    merged = []
    for r in sorted(ranges, key=lambda r: r["line_start"]):
        if not 1 <= r["line_start"] <= r["line_end"] <= len(lines):
            raise AgentServiceError("invalid_evidence", "补读范围超出原文。")
        start, end = max(1, r["line_start"] - 2), min(len(lines), r["line_end"] + 2)
        if merged and start <= merged[-1]["line_end"] + 1:
            merged[-1]["line_end"] = max(end, merged[-1]["line_end"])
        else:
            merged.append({"line_start": start, "line_end": end})
    blocks, skipped, size = [], [], 0
    for span in merged:
        text = "\n".join(lines[span["line_start"] - 1 : span["line_end"]])
        if size + len(text) > budget:
            skipped.append(span)
        else:
            blocks.append({**span, "text": text})
            size += len(text)
    return blocks, skipped
