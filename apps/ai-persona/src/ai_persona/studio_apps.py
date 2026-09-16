"""Open another installed PersonaStudio application using a fixed local launcher."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


def radar_launcher() -> Path | None:
    configured = os.environ.get("PERSONASTUDIO_ROOT")
    installed = os.environ.get("AI_PERSONA_INSTALL_ROOT")
    root = (Path(installed) / "current" if installed else
            Path(configured) if configured else Path(__file__).resolve().parents[4])
    launcher = root / "apps/paper-radar/scripts/launcher.mjs"
    return launcher if launcher.is_file() else None


def open_paper_radar(workspace: Path) -> str:
    launcher = radar_launcher()
    managed_node = launcher.parent.parent.parent.parent / "runtime/node/bin/node" if launcher else None
    node = str(managed_node) if managed_node and managed_node.is_file() else shutil.which("node")
    if launcher is None or node is None:
        raise ValueError("Paper Radar is not installed in this PersonaStudio workspace")
    result = subprocess.run(
        [node, str(launcher), "start", "--no-open"],
        env={**os.environ, "AI_PERSONA_WORKSPACE": str(workspace)},
        capture_output=True, text=True, timeout=50, check=True,
    )
    url = json.loads(result.stdout)["url"]
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or not parsed.port or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("Paper Radar did not return a local application address")
    return url
