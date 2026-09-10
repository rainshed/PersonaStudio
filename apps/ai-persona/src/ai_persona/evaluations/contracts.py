"""Small, provider/platform-independent feedback contract."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ACTIVATION = "persona.activation"
LEARNING = "persona.conversation_learning"
CAPABILITIES = [
    {
        "id": ACTIVATION,
        "name": "偏好场景触发",
        "modes": ["activation"],
        "prompts": ["ai-persona.activation"],
    },
    {
        "id": LEARNING,
        "name": "对话学习",
        "modes": ["learning_trigger", "learning_content", "learning_pipeline"],
        "prompts": ["ai-persona.conversation-signal", "ai-persona.conversation-candidate"],
    },
]


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def now():
    return datetime.now(UTC).isoformat()


class EvaluationError(ValueError):
    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", value):
        raise EvaluationError("记录标识无效。")
    return value


class Subject(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["learning_gate", "activation_context"]
    context_key: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def valid_key(self):
        if (self.kind == "activation_context") != (self.context_key is not None):
            raise ValueError("场景反馈需要场景 key；学习反馈不能携带 key。")
        return self

    def value(self):
        return self.model_dump(exclude_none=True)


class FeedbackInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    subject: Subject
    rating: Literal["satisfied", "unsatisfied"]
    reason: str = Field(default="", max_length=2000)
    idempotency_key: str = Field(min_length=1, max_length=150)
    expected_feedback_revision: int = Field(ge=0)


def derived_label(actual, rating):
    if type(actual) is not bool or rating not in {"satisfied", "unsatisfied"}:
        raise EvaluationError("当前结果尚无可评价的触发判断。", "not_decided", 409)
    return actual if rating == "satisfied" else not actual


def learning_gate(signal):
    if signal.decision == "needs_context":
        return None
    return signal.decision != "ignore" and any(not s.temporary for s in signal.signals)


def activation_decisions(parsed, catalog):
    names = {c["key"]: c.get("name", c["key"]) for c in catalog}
    keys = [c.key for c in parsed.contexts]
    if len(keys) != len(set(keys)) or set(keys) != set(names):
        raise EvaluationError("模型未完整判断所有场景，或返回未知场景。", "invalid_model_output")
    return [
        {
            "subject": {"kind": "activation_context", "context_key": c.key},
            "name": names[c.key],
            "triggered": c.matched if hasattr(c, "matched") else (
                None if c.decision == "uncertain" else c.decision == "match"
            ),
            "processing_state": "waiting_context" if (
                not hasattr(c, "matched") and c.decision == "uncertain"
            ) else "completed",
            "reason": c.reason,
        }
        for c in parsed.contexts
    ]
