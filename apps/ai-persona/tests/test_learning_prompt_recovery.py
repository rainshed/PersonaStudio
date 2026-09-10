"""Current-protocol execution and recovery, without external model calls."""

import copy
import json

import pytest
from pydantic import ValidationError
from test_conversation_learning import FakeModel, event, knowledge, signals
from test_conversation_learning import learning as learning

from ai_persona.agent import AgentServiceError
from ai_persona.conversation_learning.contracts import CandidateOutput
from ai_persona.conversation_learning.pipeline import PROMPT_VERSION, LearningPipeline
from ai_persona.conversation_learning.views import LearningViews
from ai_persona.conversation_learning.worker import LearningWorker
from ai_persona.evaluations.store import EvaluationStore
from ai_persona.maintenance.runner import loop
from ai_persona.prompt_store import PromptError, PromptStore
from ai_persona.proposals import ProposalRepository

CANDIDATE = "ai-persona.conversation-candidate"


@pytest.mark.parametrize("custom", [False, True])
def test_unsupported_protocol_uses_current_default_and_retains_history(tmp_path, custom):
    current = PromptStore(tmp_path)
    definitions = copy.deepcopy(list(current.definitions.values()))
    candidate = next(d for d in definitions if d["id"] == CANDIDATE)
    candidate["schema_version"] = "obsolete"
    candidate["templates"]["system"] += "\nPrevious instructions."
    old = PromptStore(tmp_path, definitions)
    version = old.version(CANDIDATE)
    if custom:
        version = old.save_version(CANDIDATE, {
            **version["templates"], "system": version["templates"]["system"] + " Custom text."
        })
        old.activate([{"prompt_id": CANDIDATE, "version": version["id"],
                       "expected_active": old.version(CANDIDATE)["id"]}])
    frozen = old.snapshot()
    upgraded = PromptStore(tmp_path)
    assert upgraded.version(CANDIDATE) == upgraded.version(CANDIDATE, "default")
    assert upgraded.detail(CANDIDATE)["active_compatible"] is True
    assert upgraded.version(CANDIDATE, version["id"]) == version
    with pytest.raises(PromptError, match="不兼容"):
        upgraded.preview(CANDIDATE, {"payload": {}}, snapshot=frozen)
    upgraded.preview(CANDIDATE, {"payload": {}})
    assert PromptStore(tmp_path).snapshot() == upgraded.snapshot()


def test_current_protocol_keeps_active_custom_text(tmp_path):
    prompts = PromptStore(tmp_path)
    default = prompts.version(CANDIDATE)
    custom = prompts.save_version(CANDIDATE, {
        **default["templates"], "system": default["templates"]["system"] + " Custom text."
    })
    prompts.activate([{"prompt_id": CANDIDATE, "version": custom["id"],
                      "expected_active": default["id"]}])
    assert PromptStore(tmp_path).version(CANDIDATE) == custom


@pytest.mark.parametrize("previous_protocol", [False, True])
def test_retry_uses_current_protocol_without_rewriting_history_or_duplicate_proposals(
    learning, previous_protocol
):
    receipt = learning.ingest_event(event(), "test")
    LearningWorker(learning, FakeModel(signals(), AgentServiceError("timeout", "timeout"))).run_once()
    row = learning.repository.get(receipt["event_id"])
    checkpoint = json.loads(row["checkpoint"])
    evaluations = EvaluationStore(learning.data_root, learning.state_root)
    original = evaluations.result(checkpoint["evaluation_result_id"])
    assert checkpoint["signal"] and row["error_code"] == "timeout"
    if previous_protocol:
        checkpoint.update(prompt_version="conversation-learning/v4-shared-maintenance",
                          prompt_snapshot={"versions": {}},
                          candidate={"read_ids": ["obsolete"], "search_queries": ["obsolete"]})
        with learning.repository.transaction() as db:
            db.execute("UPDATE events SET checkpoint=? WHERE id=?", (json.dumps(checkpoint), row["id"]))
    learning.retry_job(row["id"], row["version"], "test")
    responses = [signals()] if previous_protocol else []
    model = FakeModel(*responses, {"changes": [knowledge()]})
    LearningWorker(learning, model).run_once()
    recovered = learning.repository.get(row["id"])
    fresh = json.loads(recovered["checkpoint"])
    assert recovered["outcome"] == "submitted_review"
    expected = ["conversation_signal"] if previous_protocol else []
    assert [call[0] for call in model.calls] == [*expected, "conversation_candidate"]
    assert fresh["prompt_version"] == PROMPT_VERSION
    assert fresh["prompt_snapshot"]["versions"][CANDIDATE] == PromptStore(
        learning.state_root / "prompts"
    ).version(CANDIDATE)
    assert not {"read_ids", "search_queries"} & fresh["candidate"].keys()
    assert recovered["payload"] == row["payload"] and recovered["snapshot"] == row["snapshot"]
    assert fresh["evaluation_result_id"] != original["id"]
    assert evaluations.result(original["id"]) == original

    proposals = ProposalRepository(learning.data_root).list_pending()
    with learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='running',lease='recovery',checkpoint=? WHERE id=?",
                   (json.dumps({"prompt_version": "obsolete"}), row["id"]))
    no_calls = FakeModel()
    LearningPipeline(learning, no_calls).process(row["id"], "recovery")
    assert not no_calls.calls
    assert ProposalRepository(learning.data_root).list_pending() == proposals


def test_prompt_errors_keep_their_cause_and_historical_views_do_not_rewrite_storage(learning):
    receipt = learning.ingest_event(event(), "test")
    LearningWorker(learning, FakeModel(signals(), PromptError("版本不兼容", "incompatible", 409))).run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["status"] == "failed" and row["error_code"] == "incompatible"
    with learning.repository.transaction() as db:
        db.execute("UPDATE events SET error_code='internal_error' WHERE id=?", (row["id"],))
    detail = LearningViews(learning).detail(row["id"])
    assert detail["error_code"] == "incompatible" and detail["triggered"] is True
    assert learning.repository.get(row["id"])["error_code"] == "internal_error"


@pytest.mark.parametrize("output", [
    {"read_ids": []}, {"search_queries": []},
    {"calls": [{"name": "search_knowledge", "arguments": {"query": "topic"}}],
     "changes": [knowledge()]},
    {"calls": [{"name": "search_knowledge", "arguments": {"query": "topic"}}],
     "waiting_signal_ids": ["s1"]},
])
def test_candidate_contract_rejects_removed_fields_and_mixed_reads_with_results(output):
    with pytest.raises(ValidationError):
        CandidateOutput.model_validate(output)


def test_malformed_result_is_corrected_before_tools_and_submission(learning):
    receipt = learning.ingest_event(event(), "test")
    read = {"name": "search_knowledge", "arguments": {"query": "测试新知识", "limit": 6}}
    fake = FakeModel(signals(), {"calls": [read], "waiting_signal_ids": ["s1"]},
                     {"calls": [read]}, {"changes": [knowledge()]})
    LearningWorker(learning, fake).run_once()
    row = learning.repository.get(receipt["event_id"])
    assert row["outcome"] == "submitted_review"
    correction = json.loads(fake.calls[2][2]["tool_results"][0]["content"])
    assert correction["origin"] == "application_validation"
    assert correction["error"] == "invalid_model_output"
    assert json.loads(fake.calls[3][2]["tool_results"][1]["content"])["origin"]["tool"] == "search_knowledge"
    assert len(ProposalRepository(learning.data_root).list_pending()) == 1


@pytest.mark.parametrize("size,allowed", [(60_000, True), (120_000, False)])
def test_candidate_context_budget_supports_multiple_tool_rounds_without_truncation(learning, size, allowed):
    receipt = learning.ingest_event(event(), "test")
    model = FakeModel({"changes": []})
    pipeline = LearningPipeline(learning, model)
    learning.repository.claim("budget-test")
    learning.repository.fenced_update(receipt["event_id"], "budget-test",
        checkpoint=json.dumps({"prompt_snapshot": pipeline.prompts.snapshot()}))
    payload = {"tool_results": [{"content": "x" * size}]}

    def generate():
        return pipeline.call(receipt["event_id"], "budget-test", "conversation_candidate",
                             "", payload, CandidateOutput, 6000)

    if allowed:
        assert generate().changes == []
        assert model.calls[0][2] == payload
    else:
        with pytest.raises(AgentServiceError) as error:
            generate()
        assert error.value.code == "context_length" and not model.calls


@pytest.mark.parametrize("code,expected_calls", [("invalid_model_output", 3), ("timeout", 1)])
def test_response_corrections_are_bounded_and_transport_failures_are_not_repeated(code, expected_calls):
    requests, dispatched = [], []

    def request(state):
        requests.append(copy.deepcopy(state))
        raise AgentServiceError(code, "Failed response")

    with pytest.raises(AgentServiceError) as error:
        loop(request, lambda *args: dispatched.append(args), lambda output: output, rounds=3)
    assert len(requests) == expected_calls and not dispatched
    assert error.value.code == ("analysis_limit" if code == "invalid_model_output" else code)
