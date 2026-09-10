from __future__ import annotations

import copy
import json

import pytest
from test_conversation_learning import FakeModel, codex_scope_fixture, event, knowledge, signals
from test_conversation_learning import learning as learning
from test_evaluations import click

from ai_persona.conversation_learning.adapters.codex import capture
from ai_persona.conversation_learning.adapters.codex_context import capture_context
from ai_persona.conversation_learning.contracts import ContextSnapshot, ConversationEvent, encoded
from ai_persona.conversation_learning.input_text import INPUT_TEXT_VERSION, learning_text
from ai_persona.conversation_learning.pipeline import PROMPT_VERSION
from ai_persona.conversation_learning.views import LearningViews
from ai_persona.conversation_learning.worker import LearningWorker
from ai_persona.evaluations.replay import replay
from ai_persona.evaluations.store import EvaluationStore

BROWSER = """<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.
# In app browser:
- The user has the in-app browser open with 1 tab.
- Current URL: http://127.0.0.1:8765/preferences?context=private-context
</in-app-browser-context>"""


def wrapped(text):
    return "\n" + BROWSER + "\n\n## My request:\n" + text


@pytest.mark.parametrize(
    "raw, expected",
    [
        (wrapped("请解释贝叶斯更新。"), "请解释贝叶斯更新。"),
        (wrapped("  保留缩进\n\n"), "  保留缩进\n\n"),
        (wrapped("正文\r\n").replace("\n", "\r\n").replace("\r\r", "\r"), "正文\r\n"),
        (wrapped("正文").replace('source="ambient-ui-state"', "source='ambient-ui-state'"), "正文"),
        (BROWSER, ""),
        ("\n" + BROWSER + "\n\n", ""),
        (wrapped(""), ""),
        (wrapped("为什么出现这个：\n" + BROWSER), "为什么出现这个：\n" + BROWSER),
        # The user's body may itself be an exact example of the host envelope.
        (wrapped(wrapped("示例正文")), wrapped("示例正文")),
    ],
)
def test_extracts_only_the_host_envelope(raw, expected):
    assert learning_text(raw) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "  普通正文\n",
        "## My request:\n用户自己的标题",
        "为什么会出现 " + BROWSER,
        "```xml\n" + wrapped("示例") + "\n```",
        "> " + BROWSER.replace("\n", "\n> "),
        "\\" + BROWSER,
        BROWSER.replace("<", "&lt;"),
        wrapped("示例").replace("ambient-ui-state", "user-example"),
        wrapped("示例").replace("automatically supplied", "manually supplied"),
        BROWSER + "\n请解释上面这段",  # No host request separator: ambiguous quotation.
        wrapped("示例").replace("</in-app-browser-context>", ""),
        '<in-app-browser-context source="ambient-ui-state">用户写的 XML</in-app-browser-context>',
    ],
)
def test_preserves_quoted_escaped_and_ambiguous_text(text):
    assert learning_text(text) == text


def test_non_user_messages_are_not_unwrapped():
    for role in ("assistant", "system", "tool"):
        assert learning_text(wrapped("正文"), role=role) == wrapped("正文")


def test_codex_capture_preserves_identity_but_exposes_user_text(learning, tmp_path):
    connection, raw = codex_scope_fixture(learning, tmp_path)
    path = tmp_path / "chat.jsonl"
    raw["prompt"] = wrapped("请解释贝叶斯更新。")
    path.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "chat"}})
        + "\n"
        + json.dumps(
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": raw["prompt"]}],
                },
            }
        )
        + "\n"
    )
    raw["transcript_path"] = str(path)
    connection.adapter_config["transcript_roots"] = [str(tmp_path)]
    learning.repository.save_connection(connection)
    receipt = capture(learning, "codex", raw)
    assert capture(learning, "codex", raw)["status"] == "duplicate"
    row = learning.repository.get(receipt["event_id"])
    stored = ConversationEvent.model_validate_json(row["payload"])
    assert stored.message.text == raw["prompt"]
    assert stored.message.learning_text == "请解释贝叶斯更新。"
    assert ContextSnapshot.model_validate_json(row["snapshot"]).messages == []


def test_ambient_only_capture_is_ignored_without_model_calls(learning):
    receipt = learning.ingest_event(event(text=BROWSER), "test")
    assert receipt["job_status"] == "completed"
    assert learning.repository.get(receipt["event_id"])["outcome"] == "ignored"
    assert not LearningWorker(learning, FakeModel()).run_once()


def test_context_capture_drops_ambient_only_records_before_tail_limit(tmp_path):
    path = tmp_path / "chat.jsonl"
    records = [{"type": "session_meta", "payload": {"id": "chat"}}]
    for text in [wrapped("真实问题"), *([BROWSER] * 15)]:
        records.append(
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            }
        )
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    snapshot, warning = capture_context(str(path), [str(tmp_path)], "test", "chat")
    assert warning is None
    assert [m.learning_text for m in snapshot.messages] == ["真实问题"]


def test_learning_and_context_use_body_while_audit_and_identity_stay_raw(learning):
    submitted = event(text=wrapped("请解释测试新知识"))
    submitted.context.ref = "context"
    submitted.context.boundary = "boundary"
    snapshot = ContextSnapshot(
        id="context",
        source_connection_id="test",
        conversation_id="chat",
        boundary="boundary",
        messages=[
            event("prior", wrapped("上一个问题")).message,
            event("noise", BROWSER).message,
            event("answer", "回答里引用了 " + BROWSER).message.model_copy(
                update={"role": "assistant"}
            ),
        ],
    )
    receipt = learning.ingest_event(submitted, "test", snapshot)
    before = learning.repository.get(receipt["event_id"])
    model = FakeModel(signals(), {"changes": [knowledge()]})
    LearningWorker(learning, model).run_once()
    assert [c[2]["current_user_prompt"] for c in model.calls] == ["请解释测试新知识"] * 2
    assert model.calls[0][2]["context"] == [
        {"id": "prior", "role": "user", "text": "上一个问题"},
        {"id": "answer", "role": "assistant", "text": "回答里引用了 " + BROWSER},
    ]
    after = learning.repository.get(receipt["event_id"])
    for key in ("payload", "snapshot", "fingerprint", "external_id", "message_id"):
        assert after[key] == before[key]
    assert learning.ingest_event(submitted, "test", snapshot)["status"] == "duplicate"
    store = EvaluationStore(learning.data_root, learning.state_root)
    result = store.result(json.loads(after["checkpoint"])["evaluation_result_id"])
    assert result["input"]["event"] == submitted.model_dump(mode="json", by_alias=True)
    assert result["input"]["input_text_version"] == INPUT_TEXT_VERSION


@pytest.mark.parametrize("context_only", [False, True])
def test_legacy_checkpoints_are_recomputed_for_changed_inputs(learning, context_only):
    submitted = event(text="继续" if context_only else wrapped("继续"))
    receipt = learning.ingest_event(submitted, "test")
    snapshot = (
        ContextSnapshot(
            id="old",
            source_connection_id="test",
            conversation_id="chat",
            boundary="old",
            messages=[event("prior", wrapped("旧问题")).message],
        )
        if context_only
        else None
    )
    with learning.repository.transaction() as db:
        db.execute(
            "UPDATE events SET checkpoint=?,snapshot=? WHERE id=?",
            (
                json.dumps(
                    {
                        "prompt_version": PROMPT_VERSION,
                        "signal": signals(),
                        "candidate": {"changes": [knowledge()]},
                    }
                ),
                encoded(snapshot) if snapshot else None,
                receipt["event_id"],
            ),
        )
    model = FakeModel({"decision": "ignore"})
    LearningWorker(learning, model).run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["outcome"] == "ignored"
    assert len(model.calls) == 1
    assert json.loads(row["checkpoint"])["input_text_version"] == INPUT_TEXT_VERSION


def test_legacy_ambient_only_job_finishes_without_model_config_or_call(learning):
    receipt = learning.ingest_event(event(), "test")
    with learning.repository.transaction() as db:
        db.execute(
            "UPDATE events SET payload=? WHERE id=?",
            (encoded(event(text=BROWSER)), receipt["event_id"]),
        )

    class NoModel:
        def configuration_signature(self, task):
            raise AssertionError("Ambient state must not contact the model service")

    LearningWorker(learning, NoModel()).run_once()
    assert learning.repository.get(receipt["event_id"])["outcome"] == "ignored"


def test_history_preview_detail_search_and_expired_benchmark_use_body(learning):
    raw = wrapped("请解释测试新知识")
    receipt = learning.ingest_event(event(text=raw), "test")
    LearningWorker(learning, FakeModel({"decision": "ignore"})).run_once()
    views = LearningViews(learning)
    assert views.list({})["events"][0]["input_preview"] == "请解释测试新知识"
    assert views.list({"q": "测试新知识"})["total"] == 1
    assert views.list({"q": "private-context"})["total"] == 0
    detail = views.detail(receipt["event_id"])
    assert detail["user_input"] == "请解释测试新知识"
    assert detail["judgment_input"][0]["text"] == raw
    store = views.evaluations
    result = store.result(detail["current_result_id"])
    assert store.input_preview(result) == "请解释测试新知识"
    click(store, result)
    with learning.repository.transaction() as db:
        db.execute(
            "UPDATE events SET payload=NULL,snapshot=NULL WHERE id=?", (receipt["event_id"],)
        )
    expired = views.list({})["events"][0]
    assert expired["input_state"] == "benchmark"
    assert expired["input_preview"] == "请解释测试新知识"
    assert views.detail(receipt["event_id"])["user_input"] == "请解释测试新知识"
    assert store.result(result["id"])["input"] == result["input"]


def test_legacy_replay_normalizes_prompt_and_expanded_context_without_mutation():
    result = {
        "input": {"event": event(text=wrapped("请解释刚才那个概念")).model_dump()},
        "expanded_context": [{"id": "prior", "role": "user", "text": wrapped("贝叶斯更新")}],
    }
    case = {"result": result, "replay_capabilities": ["learning_trigger"]}
    original = copy.deepcopy(case)
    calls = []

    def call(prompt, payload, output_type, tokens):
        calls.append(copy.deepcopy(payload))
        return output_type.model_validate(
            {"decision": "needs_context", "context_request": {}}
            if len(calls) == 1
            else {"decision": "ignore"}
        )

    replay(case, "learning_trigger", call)
    assert calls[0]["current_user_prompt"] == "请解释刚才那个概念"
    assert calls[1]["context"][0]["text"] == "贝叶斯更新"
    assert case == original
