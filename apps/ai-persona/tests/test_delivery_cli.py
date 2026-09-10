import json

import pytest

from ai_persona import cli, diagnostics, onboarding
from ai_persona.initialization import initialize_persona
from ai_persona.workspace import PersonaWorkspace


def test_first_run_opens_setup_without_creating_or_selecting_data(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config.toml"))
    monkeypatch.delenv("AI_PERSONA_WORKSPACE", raising=False)
    monkeypatch.setattr(cli, "project_root", lambda: tmp_path)
    opened = []
    monkeypatch.setattr(onboarding, "run_setup", lambda **kwargs: opened.append(kwargs) or 0)
    assert cli.main([]) == 0
    assert opened == [{"open_browser": True}]
    assert list(tmp_path.iterdir()) == []


def test_explicit_missing_workspace_does_not_open_setup(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config.toml"))
    def forbidden(**kwargs):
        raise AssertionError("An explicit selection must not open setup")
    monkeypatch.setattr(onboarding, "run_setup", forbidden)
    assert cli.main(["start", "--workspace", str(tmp_path / "missing"), "--no-open"]) == 2
    assert not json.loads(capsys.readouterr().err)["ok"]


@pytest.mark.parametrize("option", [["--port", "-1"], ["--port", "9000"], ["--host", "0.0.0.0"]])
def test_first_run_does_not_silently_discard_advanced_options(tmp_path, monkeypatch, capsys, option):
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config.toml"))
    monkeypatch.delenv("AI_PERSONA_WORKSPACE", raising=False)
    monkeypatch.setattr(cli, "project_root", lambda: tmp_path)
    assert cli.main(["start", *option]) == 2
    assert "setup" in json.loads(capsys.readouterr().err)["error"]


def test_doctor_keeps_models_optional_and_never_reads_accounts(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    initialize_persona(root / "persona-data", root / "persona-state", persona_id="doctor-test")
    workspace = PersonaWorkspace(root, root / "persona-data", root / "persona-state")
    monkeypatch.setattr(diagnostics, "runtime_diagnostics", lambda: {
        "ok": False, "checks": [{"name": "model_runtime", "ok": False, "message": "Install optional runtime"}],
    })
    result = diagnostics.diagnose(workspace)
    assert result["ok"] and not result["ai_ready"]
    assert not diagnostics.diagnose(workspace, require_models=True)["ok"]
    assert not diagnostics.diagnose(None)["ok"]
