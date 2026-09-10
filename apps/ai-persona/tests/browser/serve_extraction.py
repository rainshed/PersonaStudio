"""Offline extraction UI fixture with the same real proposal service as production."""
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from persona_fixture import demo_workspace
from test_extraction import FixtureBackend

from ai_persona.compiler import PersonaCompiler
from ai_persona.extraction.backend import CodexBackend
from ai_persona.web import create_app

os.environ["AI_PERSONA_SEMANTIC_SEARCH"] = "0"
root = Path(tempfile.mkdtemp(prefix="persona-extraction-browser-"))
data, state = root / "data", root / "state"
shutil.copytree(demo_workspace().data_root, data)
PersonaCompiler(data, state).build()
CodexBackend.status = lambda self: {"available": True, "authenticated": True}
app = create_app(data, state)
app.state.extraction_service.backend = FixtureBackend()
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(("127.0.0.1", 0))
print(f"READY http://127.0.0.1:{sock.getsockname()[1]}", flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
finally:
    shutil.rmtree(root, ignore_errors=True)
