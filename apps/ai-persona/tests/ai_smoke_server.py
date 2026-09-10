"""Run an isolated Studio with a local model stub for manual browser verification.

From the project: PYTHONPATH=src .venv/bin/python tests/ai_smoke_server.py
Only temporary fixture data is changed; the user's model accounts are never opened.
"""

from __future__ import annotations

import argparse
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path

import uvicorn
from persona_fixture import demo_workspace
from test_model_bridge import configure, local_upstream, stop

from ai_persona.agent import AgentServiceError
from ai_persona.compiler import PersonaCompiler
from ai_persona.model_bridge import ModelClient
from ai_persona.proposals import ProposalService
from ai_persona.web import create_app


def main():
    # Uvicorn replays SIGTERM after graceful shutdown. Convert it to an exception
    # so our finally blocks stop the model daemon and remove temporary fixtures.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8879)
    parser.add_argument(
        "--oauth", action="store_true", help="Show a temporary Codex login; never sign in"
    )
    parser.add_argument(
        "--recovery-demo",
        action="store_true",
        help="Seed a staged draft with a simulated candidate timeout",
    )
    parser.add_argument("--learning-demo", action="store_true", help="Seed isolated conversation learning")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ai-persona-ui-check-") as directory:
        root = Path(directory)
        data, state = root / "data", root / "state"
        shutil.copytree(demo_workspace().data_root, data)
        PersonaCompiler(data, state).build()
        reviewer = ProposalService(data, state)
        reviewer.accept(
            reviewer.create_record(
                "preference_context",
                {
                    "key": "research.writing",
                    "name": "科研写作",
                    "description": "撰写或修改论文与研究笔记",
                    "activation": {
                        "intents": ["写论文", "研究笔记"],
                        "excludes": ["只讨论写作概念"],
                    },
                },
            ).id
        )
        client = ModelClient(root / "models")
        with local_upstream() as (url, _):
            try:
                configure(client, url)
                if args.oauth:
                    catalog = client.request("config")
                    provider = next(p for p in catalog["providers"] if p["id"] == "openai-codex")
                    model = next(
                        (m for m in provider["models"] if m["id"] == "gpt-5.6-sol"),
                        provider["models"][0],
                    )
                    client.request(
                        "connections",
                        {
                            "id": "oauth-ui-fixture",
                            "name": model["name"],
                            "modelId": model["id"],
                            "providerId": "openai-codex",
                            "authType": "oauth",
                            "api": "openai-responses",
                            "baseUrl": "",
                            "contextWindow": model["contextWindow"],
                            "maxTokens": model["maxTokens"],
                        },
                    )
                    client.request("auth/start", {"id": "oauth-ui-fixture"})
                app = create_app(data, state)
                app.state.ai_service.model = client
                if args.learning_demo:
                    from ai_persona.conversation_learning.contracts import (
                        Capabilities,
                        ConversationEvent,
                        LearningSettings,
                        SourceConnection,
                    )
                    from ai_persona.conversation_learning.repository import LearningRepository
                    from ai_persona.conversation_learning.service import ConversationLearningService
                    from ai_persona.conversation_learning.worker import LearningWorker

                    repository = LearningRepository(data, root / "learning")
                    repository.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
                    repository.save_connection(SourceConnection(
                        id="ui-demo", name="隔离测试连接", enabled=True,
                        allow_all_conversations=True, capabilities=Capabilities(verified_human_origin=True),
                    ))
                    learning = ConversationLearningService(data, state, repository=repository)
                    app.state.learning_service = learning
                    receipt = learning.ingest_event(ConversationEvent.model_validate({
                        "event_id": "ui-demo-event", "event_type": "message.submitted",
                        "conversation_id": "ui-demo-chat", "source_connection_id": "ui-demo",
                        "message": {"id": "m1", "role": "user", "origin": "human",
                                    "content": [{"type": "text", "text": "请讲解对话学习测试知识。"}]},
                    }), "ui-demo")
                    LearningWorker(learning, client).run_once()
                    result = learning.get_event_status(receipt["event_id"], "ui-demo")
                    assert result["outcome"] == "submitted_review", result
                if args.recovery_demo:
                    import ai_persona.ai_service as ai_module

                    ai_module.SHORT_TEXT_CHARS = 0
                    original = client.generate
                    failed_once = False

                    def generate(task, system, payload, **kwargs):
                        nonlocal failed_once
                        if task == "material" and "analysis_parts" in payload:
                            if not failed_once:
                                failed_once = True
                                raise AgentServiceError(
                                    "timeout", "模拟第二步超时：第一步材料分析已保存。"
                                )
                            time.sleep(2)  # Deliberate fixture delay to inspect live UI stages.
                        return original(task, system, payload, **kwargs)

                    client.generate = generate
                    service = app.state.ai_service
                    draft = service.create_session(material_id="mat_demo_tebd_note")
                    running = service.begin(
                        draft["id"], "整理材料摘要，保留原文证据。", draft["version"]
                    )
                    service.generate(draft["id"], running["run_id"])
                uvicorn.run(app, host="127.0.0.1", port=args.port)
            finally:
                stop(client)


if __name__ == "__main__":
    main()
