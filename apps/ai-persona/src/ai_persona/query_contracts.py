"""Contracts shared by the six Agent query tools."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import Field, PrivateAttr

from .agent import AgentModel, AgentServiceError, ErrorDetail, TagScope, _request_id


class FileRef(AgentModel):
    source_id: str = Field(min_length=1, max_length=200)
    file_id: str = Field(min_length=1, max_length=200)


class LineRange(AgentModel):
    start: int = Field(ge=1)
    end: int = Field(ge=1)


class SourceSelector(AgentModel):
    lines: LineRange | None = None
    pages: list[int] | None = Field(default=None, min_length=1, max_length=100)
    section_id: str | None = None
    offset: int = Field(default=0, ge=0)
    length: int | None = Field(default=None, ge=1)
    range: str | None = None


class QueryResult(AgentModel):
    schema_version: Literal["ai-persona.query-result/v2"] = "ai-persona.query-result/v2"
    tool: str
    ok: bool = True
    request_id: str = Field(default_factory=_request_id)
    persona_revision: int | None = None
    scope: TagScope | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    coverage: dict[str, Any] = Field(default_factory=dict)
    next_cursor: str | None = None
    warnings: list[str] = Field(default_factory=list)
    error: ErrorDetail | None = None
    _images: list[bytes] = PrivateAttr(default_factory=list)


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def pack(value: dict) -> str:
    return base64.urlsafe_b64encode(encoded(value).encode()).decode().rstrip("=")


def unpack(value: str) -> dict:
    try:
        if len(value) > 16000:
            raise ValueError
        result = json.loads(base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True,
        ))
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (ValueError, TypeError, UnicodeError) as exc:
        raise AgentServiceError("invalid_arguments", "Invalid encoded reference.") from exc


def page_offset(cursor: str | None, signature: str) -> int:
    if cursor is None:
        return 0
    try:
        value = unpack(cursor)
    except AgentServiceError as exc:
        raise AgentServiceError("invalid_cursor", "Invalid continuation cursor.") from exc
    if (set(value) != {"signature", "offset"} or value.get("signature") != signature
            or type(value.get("offset")) is not int or value["offset"] < 0):
        raise AgentServiceError(
            "invalid_cursor", "Query, scope, data, or index changed; start a new read.",
        )
    return value["offset"]


def next_page(signature: str, offset: int) -> str:
    return pack({"signature": signature, "offset": offset})


def provenance(record, field: str | None = None) -> dict:
    result = {"kind": "record", "record_id": record.id, "record_revision": record.revision}
    if field:
        result["field"] = field
    return result


def bounded_int(value: int, low: int, high: int, name: str) -> None:
    if type(value) is not int or not low <= value <= high:
        raise AgentServiceError("invalid_arguments", f"{name} must be between {low} and {high}.")
