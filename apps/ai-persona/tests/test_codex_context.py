"""Compatibility and read boundaries shared by local and standalone remote readers."""

import json

import pytest

from ai_persona import remote_client
from ai_persona.conversation_learning.adapters import codex_context


@pytest.fixture(params=["local", "remote"])
def capture(request, tmp_path):
    def read(path, session="chat"):
        if request.param == "local":
            snapshot, warning = codex_context.capture_context(
                str(path), [str(tmp_path)], "test", session,
            )
            return snapshot.model_dump() if snapshot else None, warning
        return remote_client.capture_context(
            {"connection_id": "test", "transcript_roots": [str(tmp_path)]},
            {"session_id": session, "transcript_path": str(path)},
        )
    return read


def transcript(tmp_path, header_size):
    path = tmp_path / "chat.jsonl"
    entries = [{"type": "session_meta", "payload": {
        "id": "chat", "base_instructions": {"text": "x" * header_size},
    }}]
    for role, channel, text in [
        ("user", None, "Explain this concept."),
        ("assistant", "analysis", "Private reasoning"),
        ("assistant", "final", "An explanation."),
    ]:
        entries.append({"type": "response_item", "payload": {
            "type": "message", "role": role, "channel": channel,
            "content": [{"type": "input_text" if role == "user" else "output_text",
                         "text": text}],
        }})
    path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
    return path


def test_large_session_metadata_preserves_context_and_identity_checks(capture, tmp_path):
    path = transcript(tmp_path, 40_000)
    snapshot, warning = capture(path)
    assert warning is None
    assert [message["content"][0]["text"] for message in snapshot["messages"]] == [
        "Explain this concept.", "An explanation.",
    ]
    assert capture(path, "another-session") == (None, "context_session_mismatch")


def test_session_metadata_read_remains_bounded(capture, tmp_path):
    path = transcript(tmp_path, 2 * 1024 * 1024)
    assert capture(path) == (None, "context_format_unsupported")


def test_incomplete_metadata_is_not_accepted_as_a_session(capture, tmp_path):
    path = tmp_path / "chat.jsonl"
    path.write_text('{"type":"session_meta","payload":{"id":"chat","instructions":"')
    assert capture(path) == (None, "context_format_unsupported")
