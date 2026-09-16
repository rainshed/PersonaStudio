import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_evaluations import work as work
from test_studio import studio as studio

from ai_persona import studio_apps


def test_companion_launcher_uses_a_fixed_command_and_passes_workspace_without_shell(monkeypatch, tmp_path):
    root = tmp_path / "Studio with spaces"
    launcher = root / "apps/paper-radar/scripts/launcher.mjs"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("// fixture")
    monkeypatch.setenv("PERSONASTUDIO_ROOT", str(root))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout=json.dumps({"url": "http://127.0.0.1:12345/"}))

    monkeypatch.setattr(studio_apps.subprocess, "run", run)
    workspace = tmp_path / "my persona"
    assert studio_apps.open_paper_radar(workspace) == "http://127.0.0.1:12345/"
    assert calls[0][0] == ["/usr/bin/node", str(launcher), "start", "--no-open"]
    assert calls[0][1]["env"]["AI_PERSONA_WORKSPACE"] == str(workspace)
    assert not calls[0][1].get("shell")


def test_companion_launcher_rejects_nonlocal_redirects(monkeypatch):
    monkeypatch.setattr(studio_apps, "radar_launcher", lambda: Path("/safe/launcher.mjs"))
    monkeypatch.setattr(studio_apps.shutil, "which", lambda _: "/usr/bin/node")
    for url in ["https://example.org", "http://user@127.0.0.1:3000", "http://127.0.0.1:3000/unexpected"]:
        monkeypatch.setattr(studio_apps.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=json.dumps({"url": url})))
        with pytest.raises(ValueError, match="local application"):
            studio_apps.open_paper_radar(Path("/workspace"))


def test_application_switch_requires_protected_local_post(studio, monkeypatch):
    _, client, _, _, _ = studio
    calls = []
    monkeypatch.setattr(studio_apps, "open_paper_radar", lambda workspace: calls.append(workspace) or "http://127.0.0.1:12345/")
    assert client.post("/studio/paper-radar", json={}).status_code == 403
    assert client.post("/studio/paper-radar", json={}, headers={"X-AI-Persona": "1", "Origin": "https://elsewhere.invalid"}).status_code == 403
    assert not calls
    response = client.post("/studio/paper-radar", json={}, headers={"X-AI-Persona": "1"})
    assert response.status_code == 200
    assert response.json()["url"] == "http://127.0.0.1:12345/"
    assert len(calls) == 1
