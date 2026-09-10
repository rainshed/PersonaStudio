"""Isolated feedback UI fixture: fake model, temporary Persona, no real accounts.

PYTHONPATH=src .venv/bin/python tests/evaluations_smoke_server.py
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import tempfile
import time
from pathlib import Path

import uvicorn
from persona_fixture import demo_workspace
from test_automatic_improvement import examples
from test_evaluation_workflow import RepeatedModel
from test_evaluations import CANDIDATE, SIGNAL, activation_trace, click, make_learning
from test_learning_workspace import seed_tasks

from ai_persona.compiler import PersonaCompiler
from ai_persona.web import create_app


class DemoModel(RepeatedModel):
    def generate(self, task, system, payload, **kwargs):
        time.sleep(0.25)
        if task == "maintenance" and "templates" in payload:
            output = {"templates": {**payload["templates"], "system": "逐一判断输入是否符合各场景，按给定协议返回 JSON。"}, "summary": "合并重复判断说明", "hypothesis": "保持判断边界，减少重复规定"}
        elif task == "activation":
            output = {
                "contexts": [
                    {
                        "key": c["key"],
                        "matched": "note" in c["key"],
                        "reason": "本地模拟结果",
                    }
                    for c in payload["catalog"]
                ]
            }
        elif task == "conversation_signal":
            output = SIGNAL
        else:
            output = CANDIDATE
        self.calls.append({"task": task, "payload": payload})
        return {"text": json.dumps(output), "modelId": "mock", "usage": {"totalTokens": 100}}


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with tempfile.TemporaryDirectory(prefix="persona-evaluations-ui-") as temporary:
        root = Path(temporary)
        data, state = root / "data", root / "state"
        os.environ["AI_PERSONA_LEARNING_DIR"] = str(root / "learning")
        shutil.copytree(demo_workspace().data_root, data)
        PersonaCompiler(data, state).build()
        learning, store, result, _ = make_learning((data, state), [SIGNAL, CANDIDATE])
        seed_tasks(learning, store, result)
        click(store, result)
        first = activation_trace(store)
        click(store, first)
        click(store, first, subject=first["decisions"][1]["subject"])
        click(store, activation_trace(store, False), "unsatisfied", "写作场景应触发")
        examples(store)
        app = create_app(data, state)
        app.state.ai_service.model = DemoModel()
        app.state.learning_service = learning
        uvicorn.run(app, host="127.0.0.1", port=8879)


if __name__ == "__main__":
    main()
