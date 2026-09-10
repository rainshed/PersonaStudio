"""Cross-language integration: Python -> authenticated daemon -> real Pi -> local SSE stub.

No account, external provider or API key is used. Skipped until models-install has run.
"""

from __future__ import annotations

import json
import shutil
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from urllib.error import URLError

import pytest
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError
from ai_persona.ai_service import PersonaAIService
from ai_persona.compiler import PersonaCompiler
from ai_persona.model_bridge import ModelClient
from ai_persona.proposals import ProposalService


@pytest.mark.parametrize("transport_error, expected_code", [
    (TimeoutError("socket read timed out"), "timeout"),
    (URLError(TimeoutError("connection timed out")), "timeout"),
    (URLError(ConnectionRefusedError("connection refused")), "runtime_unavailable"),
    (OSError("connection reset"), "runtime_unavailable"),
])
def test_model_transport_distinguishes_timeout_from_unavailable(tmp_path, transport_error, expected_code):
    client = ModelClient(tmp_path / "models")

    def unavailable(*args, **kwargs):
        raise transport_error

    client.opener = SimpleNamespace(open=unavailable)
    with pytest.raises(AgentServiceError) as error:
        client._request({"port": 1, "token": "test-token"}, "generate", {}, timeout=0.1)
    assert error.value.code == expected_code
    assert error.value.retryable is True
    assert str(transport_error) not in str(error.value)


def test_missing_runtime_cannot_reuse_a_healthy_old_daemon(tmp_path, monkeypatch):
    client = ModelClient(tmp_path / "models")
    client.runtime = tmp_path / "reinstalled-package"
    descriptor_calls = []

    def old_daemon():
        descriptor_calls.append(True)
        return {"pid": 12345}

    monkeypatch.setattr(client, "_descriptor", old_daemon)
    with pytest.raises(AgentServiceError) as error:
        client.ensure()
    assert error.value.code == "runtime_missing"
    assert "models-install" in str(error.value)
    assert "不需要重新授权" in str(error.value)
    assert not descriptor_calls


def test_installed_runtime_reuses_existing_daemon_without_spawning(tmp_path, monkeypatch):
    client = ModelClient(tmp_path / "models")
    client.runtime = tmp_path / "installed-package"
    dependency = client.runtime / "node_modules/@earendil-works/pi-ai/package.json"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("{}")
    descriptor = {"pid": 12345}
    monkeypatch.setattr(client, "_descriptor", lambda: descriptor)

    def no_start(*args, **kwargs):
        raise AssertionError("An existing healthy daemon should be reused")

    monkeypatch.setattr("ai_persona.model_bridge.subprocess.Popen", no_start)
    assert client.ensure() is descriptor


def test_missing_dependencies_do_not_prevent_stopping_old_daemon(tmp_path, monkeypatch):
    import signal

    client = ModelClient(tmp_path / "models")
    client.runtime = tmp_path / "reinstalled-package"
    monkeypatch.setattr(client, "_descriptor", lambda: {"pid": 12345})
    signals = []
    monkeypatch.setattr("ai_persona.model_bridge.os.kill", lambda *args: signals.append(args))
    client.stop()
    assert signals == [(12345, signal.SIGTERM)]


@contextmanager
def local_upstream():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(payload)
            messages = payload["messages"]
            if messages[-1]["content"] == "Reply with exactly the word OK.":
                answer = "OK"
            else:
                data = json.loads(messages[-1]["content"])
                if "current_user_prompt" in data:
                    if "observations" in data:
                        answer = json.dumps({"changes": [{
                            "client_ref": "new", "operation": "create",
                            "entity_type": "knowledge_node", "signal_ids": ["s1"],
                            "note": "用户请求解释该知识主题。",
                            "values": {"title": "对话学习测试知识", "semantic_role": "concept"},
                        }]})
                    else:
                        answer = json.dumps({"decision": "observe", "signals": [{
                            "id": "s1", "kind": "knowledge_explanation_request",
                            "target_type": "knowledge_node", "statement": "用户请求讲解新主题。",
                            "topic": "对话学习测试知识",
                        }]})
                elif "catalog" in data and "user_prompt" in data:
                    answer = json.dumps(
                        {
                            "contexts": [
                                {
                                    "key": c["key"],
                                    "matched": True,
                                    "reason": "Local integration fixture",
                                }
                                for c in data["catalog"]
                            ]
                        }
                    )
                elif data.get("segment"):
                    start = data["segment"]["line_start"]
                    answer = json.dumps(
                        {
                            "overview": "本机模拟分析，保留原文证据。",
                            "concepts": [
                                {
                                    "name": "MPS",
                                    "aliases": ["矩阵乘积态"],
                                    "meaning": "张量网络表示。",
                                    "evidence": [{"line_start": start, "line_end": start}],
                                }
                            ],
                            "claims": [],
                            "uncertainties": [],
                        }
                    )
                elif data.get("source"):
                    answer = json.dumps(
                        {
                            "reply": "已根据材料整理摘要草稿，等待人工审核。",
                            "changes": [
                                {
                                    "operation": "update",
                                    "entity_type": "material",
                                    "target_id": data["source"]["material_id"],
                                    "expected_record_revision": data["source"]["material_revision"],
                                    "values": {
                                        "summary": "本地模拟模型生成的摘要，用于验证真实 Pi 调用链。"
                                    },
                                    "reason": "根据材料原文整理。",
                                    "confidence": 0.8,
                                    "evidence": [
                                        {
                                            "file": data["source"]["file"],
                                            "line_start": 1,
                                            "line_end": 3,
                                            "evidence_kind": "read_signal",
                                            "confidence": 0.8,
                                        }
                                    ],
                                }
                            ],
                        }
                    )
                else:
                    answer = json.dumps(
                        {
                            "reply": "已准备一条写作偏好，请确认后提交审核。",
                            "changes": [
                                {
                                    "operation": "create",
                                    "entity_type": "preference",
                                    "values": {
                                        "behavior": "preferred",
                                        "instruction": "先给结论，再解释依据。",
                                    },
                                    "reason": "根据用户明确提出的表达偏好。",
                                    "confidence": 0.9,
                                }
                            ],
                        }
                    )
            base = {
                "id": "chatcmpl-local",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": payload["model"],
            }
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for item in [
                {
                    **base,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": answer},
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    **base,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 50, "completion_tokens": 25, "total_tokens": 75},
                },
            ]:
                self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=3)


def configure(client: ModelClient, url: str):
    return client.request(
        "connections",
        {
            "id": "local-fixture",
            "name": "本地验证模型 · 不使用真实账号",
            "providerId": "custom",
            "authType": "none",
            "modelId": "local-fixture",
            "baseUrl": url,
            "api": "openai-completions",
            "contextWindow": 262144,
            "maxTokens": 16000,
            "status": "untested",
        },
    )


def stop(client):
    client.stop()
    for _ in range(50):
        if not (client.directory / "runtime.json").exists():
            return
        time.sleep(0.05)
    raise AssertionError("Model runtime did not stop")


@pytest.mark.parametrize("staged", [False, True])
def test_python_bridge_uses_real_pi_for_all_three_workflows(tmp_path, monkeypatch, staged):
    if staged:
        monkeypatch.setattr("ai_persona.ai_service.SHORT_TEXT_CHARS", 0)
    client = ModelClient(tmp_path / "models")
    if not shutil.which("node") or not (client.runtime / "node_modules").exists():
        pytest.skip("Run ai-persona models-install for the Pi integration test")
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    reviewer = ProposalService(data, state)
    reviewer.accept(
        reviewer.create_record(
            "preference_context",
            {
                "key": "research.writing",
                "name": "科研写作",
                "activation": {"intents": ["写论文"]},
            },
        ).id
    )
    with local_upstream() as (url, requests):
        try:
            initial = client.request("config")
            assert [t["id"] for t in initial["tasks"]] == [
                "maintenance", "conversation_learning", "conversation_signal", "activation"
            ]
            with pytest.raises(AgentServiceError) as error:
                client.generate("activation", "system", {"input": "none"})
            assert error.value.code == "not_configured"
            configure(client, url)
            signature = client.configuration_signature("material")
            second = ModelClient(client.directory)
            assert client.ensure()["pid"] == second.ensure()["pid"]
            assert client.request("test", {"id": "local-fixture"})["text"] == "OK"
            assert client.configuration_signature("material") == signature
            service = PersonaAIService(data, state, client)
            result = service.resolve_persona_activation("帮我写论文")
            assert result["matched_contexts"][0]["key"] == "research.writing"
            for scope, task in [
                ({}, "maintenance"),
                ({"material_id": "mat_demo_tebd_note"}, "material"),
            ]:
                session = service.create_session(**scope)
                running = service.begin(session["id"], "请整理候选草稿", session["version"])
                draft = service.generate(session["id"], running["run_id"])
                assert draft["status"] == "submitted", draft
                assert draft["model_runs"][0]["modelId"] == "local-fixture"
                assert draft["model_runs"][0]["firstContentMs"] is not None
                assert draft["model_runs"][0]["firstEventMs"] is not None
                submitted = service.submit(draft["id"], draft["version"])
                assert submitted["submission"]["effective_change"] is False
            assert len(requests) == (5 if staged else 4)
            assert {r["task"] for r in client.request("config")["runs"]} == {
                "test",
                "activation",
                "maintenance",
                "material",
            }
            assert (client.directory / "runtime.json").stat().st_mode & 0o777 == 0o600
            configure(client, url)
            assert client.configuration_signature("material") != signature
        finally:
            stop(client)
