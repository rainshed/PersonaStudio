"""Isolated inbox UI fixture. All ratings/reviews affect disposable fake data only."""
from __future__ import annotations

import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path

import uvicorn
from persona_fixture import demo_workspace
from test_evaluations import CANDIDATE, SIGNAL, Model, activation_trace, click, make_learning
from test_inbox import material_session
from test_learning_workspace import seed_tasks

from ai_persona.compiler import PersonaCompiler
from ai_persona.proposals import ProposalService
from ai_persona.web import create_app


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with tempfile.TemporaryDirectory(prefix="persona-inbox-ui-") as temporary:
        root = Path(temporary)
        data, state = root / "data", root / "state"
        os.environ["AI_PERSONA_LEARNING_DIR"] = str(root / "learning")
        shutil.copytree(demo_workspace().data_root, data)
        PersonaCompiler(data, state).build()
        learning, evaluations, result, _ = make_learning((data, state), [SIGNAL, CANDIDATE])
        seed_tasks(learning, evaluations, result, 6)
        activation = activation_trace(evaluations, False, False)
        click(evaluations, activation, "unsatisfied", "这次写 note 应该触发写作场景。")
        click(evaluations, result)
        activation_trace(evaluations, True, False)
        material_session(data, state)
        ProposalService(data, state).create_record("course", {"title":"量子计算入门", "interest_level":"unspecified"}, submitted_by="ai", reason="这条候选只需审核，不收集触发反馈。")
        app = create_app(data, state)
        app.state.ai_service.model = Model()
        app.state.learning_service = learning
        uvicorn.run(app, host="127.0.0.1", port=8881)


if __name__ == "__main__":
    main()
