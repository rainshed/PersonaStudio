"""Isolated source server for browser tests; receives all locations from its runner."""

from __future__ import annotations

import argparse
import socket
from pathlib import Path

import uvicorn

from ai_persona.compiler import PersonaCompiler
from ai_persona.model_bridge import ModelClient
from ai_persona.onboarding import create_setup_app
from ai_persona.web import create_app
from ai_persona.workspace import demo_workspace

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["demo", "setup"])
args = parser.parse_args()
workspace = None
if args.mode == "demo":
    workspace = demo_workspace()
    PersonaCompiler(workspace.data_root, workspace.state_root).build()
    app = create_app(workspace.data_root, workspace.state_root)
else:
    app = create_setup_app(default_workspace=Path("/path/to/my-persona"))

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           proxy_headers=False, log_level="warning"))
    print(f"READY http://127.0.0.1:{port}", flush=True)
    try:
        server.run(sockets=[listener])
    finally:
        if workspace is not None:
            ModelClient.for_workspace(workspace.data_root, workspace.state_root).stop()
