"""Versioned contracts shared by every capture adapter and transport."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..maintenance.contracts import ToolAction
from .input_text import learning_text

Identifier = Annotated[str, Field(min_length=1, max_length=256, pattern=r"^[^\x00-\x1f]+$")]


def encoded(value) -> str:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json", by_alias=True)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value) -> str:
    return hashlib.sha256(encoded(value).encode()).hexdigest()


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TextPart(Contract):
    type: Literal["text"] = "text"
    text: str = Field(max_length=120_000)


class Message(Contract):
    id: Identifier
    revision: Identifier = "1"
    role: Literal["user", "assistant", "tool", "system"]
    origin: Literal["human", "automation", "unknown"] = "unknown"
    content: list[TextPart] = Field(default_factory=list, max_length=20)
    reply_to_message_id: Identifier | None = None

    @property
    def text(self) -> str:
        return "\n".join(part.text for part in self.content)

    @property
    def learning_text(self) -> str:
        return learning_text(self.text, role=self.role)


class ContextRef(Contract):
    ref: Identifier | None = None
    boundary: Identifier | None = None


class ContextSnapshot(Contract):
    id: Identifier
    source_connection_id: Identifier
    conversation_id: Identifier
    boundary: Identifier
    messages: list[Message] = Field(default_factory=list, max_length=40)
    coverage: Literal["bounded", "partial", "unavailable"] = "partial"
    missing: list[str] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def bounded(self):
        keys = [(m.id, m.revision) for m in self.messages]
        if len(keys) != len(set(keys)) or len({m.id for m in self.messages}) != len(keys):
            raise ValueError("快照不能包含重复消息或同一消息的多个版本。")
        if len(encoded(self)) > 80_000:
            raise ValueError("上下文快照超过 80,000 字符。")
        return self


class ConversationEvent(Contract):
    schema_id: Literal["ai-persona.conversation-event/v1"] = Field(
        default="ai-persona.conversation-event/v1", alias="schema"
    )
    event_id: Identifier
    source_connection_id: Identifier
    event_type: Literal["message.submitted", "message.revised", "message.retracted"]
    conversation_id: Identifier
    scope_ref: Identifier | None = None
    message: Message
    occurred_at: datetime | None = None
    context: ContextRef = Field(default_factory=ContextRef)

    @model_validator(mode="after")
    def bounded(self):
        if len(encoded(self).encode()) > 256 * 1024:
            raise ValueError("事件超过 256 KiB。")
        return self


class Capabilities(Contract):
    stable_event_identity: bool = True
    message_revisions: bool = False
    verified_human_origin: bool = False
    context_snapshot: bool = True
    bounded_context_read: bool = False
    reply_links: bool = False


class SourceConnection(Contract):
    id: Identifier
    name: str = Field(min_length=1, max_length=100)
    adapter: str = Field(default="standard", pattern=r"^[a-z][a-z0-9_-]{0,50}$")
    enabled: bool = False
    # Additive opt-in: old connections never silently gain a broader capture scope.
    scope_mode: Literal["restricted", "all"] = "restricted"
    # User policy, not a claim that the adapter can verify human authorship.
    trust_user_messages: bool = False
    allowed_scopes: list[Identifier] = Field(default_factory=list, max_length=100)
    allowed_conversations: list[Identifier] = Field(default_factory=list, max_length=100)
    allow_all_conversations: bool = False  # Legacy fallback for unscoped standard events.
    capabilities: Capabilities = Field(default_factory=Capabilities)
    # Only the adapter interprets these. Never sent to an LLM or accepted in an event.
    adapter_config: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def scope_configuration(self):
        if len(encoded(self.adapter_config)) > 20_000:
            raise ValueError("适配器私有配置过大。")
        return self


class LearningSettings(Contract):
    enabled: bool = False
    allow_model_calls: bool = False
    daily_calls: int = Field(default=50, ge=1, le=10000)
    daily_tokens: int = Field(default=200_000, ge=1000, le=10_000_000)
    event_retention_days: int = Field(default=7, ge=1, le=365)
    observation_retention_days: int = Field(default=30, ge=1, le=3650)
    learning_types: list[Literal["knowledge_node", "preference", "relation"]] = Field(
        default_factory=lambda: ["knowledge_node", "preference", "relation"], max_length=3
    )


class Signal(Contract):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    kind: Literal[
        "behavior_requirement",
        "correction",
        "positive_feedback",
        "negative_feedback",
        "explicit_statement",
        "note_request",
        "knowledge_explanation_request",
    ]
    target_type: Literal["knowledge_node", "preference"]
    statement: str = Field(min_length=1, max_length=1000)
    topic: str = Field(default="", max_length=200)
    scope: str = Field(default="", max_length=300)
    temporary: bool = False


class ContextRequest(Contract):
    message_ids: list[Identifier] = Field(default_factory=list, max_length=4)
    recent_messages: int = Field(default=4, ge=0, le=12)


class SignalOutput(Contract):
    decision: Literal["ignore", "observe", "needs_context"]
    signals: list[Signal] = Field(default_factory=list, max_length=8)
    context_request: ContextRequest | None = None
    reason_code: str = Field(default="", max_length=100)

    @model_validator(mode="after")
    def shape(self):
        if (self.decision == "observe") != bool(self.signals):
            raise ValueError("observe 必须有信号，其余决策不能携带信号。")
        if (self.decision == "needs_context") != bool(self.context_request):
            raise ValueError("needs_context 必须有受限补读请求。")
        if len({s.id for s in self.signals}) != len(self.signals):
            raise ValueError("信号 ID 不能重复。")
        return self


class Candidate(Contract):
    client_ref: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    operation: Literal["create", "update", "relate"]
    entity_type: Literal["knowledge_node", "preference", "preference_context", "relation"]
    target_id: str | None = None
    expected_record_revision: int | None = Field(default=None, ge=1)
    values: dict = Field(default_factory=dict)
    signal_ids: list[str] = Field(min_length=1, max_length=8)
    note: str = Field(min_length=1, max_length=300)


class CandidateOutput(Contract):
    changes: list[Candidate] = Field(default_factory=list, max_length=10)
    waiting_signal_ids: list[str] = Field(default_factory=list, max_length=8)
    calls: list[ToolAction] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def separate_reads_and_results(self):
        if self.calls and (self.changes or self.waiting_signal_ids):
            raise ValueError("读取时只返回 calls；完成后单独返回 changes 和 waiting_signal_ids。")
        return self
