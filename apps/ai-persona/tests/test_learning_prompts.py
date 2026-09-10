"""Prompt contract regression tests; semantic quality needs opt-in model replay."""

from __future__ import annotations

import json
from pathlib import Path

from ai_persona.conversation_learning.contracts import CandidateOutput, SignalOutput
from ai_persona.material_analysis import compact_schema
from ai_persona.prompt_api import validate_result
from ai_persona.prompt_store import PromptStore

CASES = json.loads(
    (Path(__file__).parent / "fixtures/conversation_learning_boundaries.json").read_text()
)["cases"]
SIGNAL = "ai-persona.conversation-signal"
CANDIDATE = "ai-persona.conversation-candidate"


def test_boundary_examples_fit_the_real_signal_input_budget(tmp_path):
    store = PromptStore(tmp_path / "prompts")
    assert len({c["id"] for c in CASES}) == len(CASES)
    for case in CASES:
        payload = {
            "current_user_prompt": case["prompt"],
            "context": case["context"],
            "output_schema": compact_schema(SignalOutput.model_json_schema()),
        }
        preview = store.preview(SIGNAL, {"payload": payload})
        assert json.loads(preview["rendered"]["user"]) == payload
        assert len(preview["rendered"]["system"]) + len(
            json.dumps(payload, ensure_ascii=False)
        ) < 12_000
        assert not {"expected_types", "expected_decision", "feedback", "reason"}.intersection(payload)


def test_prompt_edit_does_not_change_output_contracts_or_other_capabilities(tmp_path):
    store = PromptStore(tmp_path / "prompts")
    before = store.snapshot()
    value = store.save_version(SIGNAL, before["versions"][SIGNAL]["templates"], "boundary revision")
    store.activate([{"prompt_id": SIGNAL, "version": value["id"], "expected_active": value["id"]}])
    assert store.snapshot() == before
    ignored = validate_result(SIGNAL, '{"decision":"ignore","signals":[],"context_request":null}', {})
    assert ignored["parsed"]["decision"] == "ignore" and not ignored["issues"]
    empty = validate_result(CANDIDATE, '{"changes":[],"waiting_signal_ids":[]}', {})
    assert not empty["parsed"]["changes"] and not empty["issues"]
    assert set(SignalOutput.model_fields) == {"decision", "signals", "context_request", "reason_code"}
    assert set(CandidateOutput.model_fields) == {"changes", "waiting_signal_ids", "calls"}


def test_both_stages_keep_the_semantic_boundaries_and_review_guards(tmp_path):
    store = PromptStore(tmp_path / "prompts")
    signal = store.version(SIGNAL)["templates"]["system"]
    candidate = store.version(CANDIDATE)["templates"]["system"]
    for prompt in (signal, candidate):
        assert "current_user_prompt" in prompt or "CURRENT USER PROMPT" in prompt
        assert "one-off" in prompt and "collaboration" in prompt and "product" in prompt.lower()
        assert "output_schema JSON" in prompt
    assert '"以后", repetition and proof of long-term value are NOT required' in signal
    assert "cannot supply a missing learning intent" in signal
    assert "A requested deliverable is not itself a preference" in signal
    assert "never a third note-format preference" in signal
    assert "observations are provisional" in candidate.lower()
    assert "does not establish a preference for notes" in candidate
    assert "not rejected signals" in candidate
    assert "Never approve, delete or archive records" in candidate
    assert "Each change has client_ref, signal_ids" in candidate
