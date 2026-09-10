from __future__ import annotations

import hashlib
import json
from collections import Counter

import pytest
from fastapi.testclient import TestClient

from ai_persona import cli, demo
from ai_persona.ai_service import PersonaAIService
from ai_persona.compiler import PersonaCompiler
from ai_persona.human_edits import HumanEditService
from ai_persona.model_bridge import ModelClient
from ai_persona.models import (
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
)
from ai_persona.store import PersonaStore
from ai_persona.web import create_app
from ai_persona.workspace import demo_workspace, resolve_workspace


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_DEMO_HOME", str(tmp_path / "demo-home"))
    return tmp_path


def fingerprints(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


def test_public_demo_is_complete_and_rebuildable(isolated):
    workspace = demo_workspace()
    store = PersonaStore(workspace.data_root).load()
    assert len(store.of_type(KnowledgeNode)) == 30
    assert len(store.of_type(Material)) == 5
    assert all(m.material_type == "article" for m in store.of_type(Material))
    contexts = {c.id: c.name for c in store.of_type(PreferenceContext)}
    assert set(contexts.values()) == {"Research Figures", "Academic Notes", "Numerical Computing"}
    assert Counter(contexts[c] for p in store.of_type(Preference) for c in p.context_refs) == {
        "Research Figures": 4, "Academic Notes": 4, "Numerical Computing": 6,
    }
    assert Counter((contexts[c], e.example_type)
                   for e in store.of_type(PreferenceExample) for c in e.context_refs) == {
        (name, polarity): 1 for name in contexts.values() for polarity in ("positive", "negative")
    }
    assert len(store.sources) == 11  # Hash-verified articles and reference samples.
    numerical = [p.instruction for p in store.of_type(Preference)
                 if p.context_refs == ["pctx_demo_numerics"]]
    assert any("ITensorMPS.jl" in p and "ITensors.jl" in p for p in numerical)
    assert any("scripts/submit_job.sh" in p and "fictional" in p for p in numerical)
    first = PersonaCompiler(workspace.data_root, workspace.state_root).build()
    snapshot = first.snapshot_path.read_bytes()
    PersonaCompiler(workspace.data_root, workspace.state_root).build()
    assert first.snapshot_path.read_bytes() == snapshot


def test_demo_edit_is_persistent_and_cannot_touch_seed_or_real_data(isolated, monkeypatch):
    real = isolated / "real"
    (real / "persona-data").mkdir(parents=True)
    (real / "persona-data/private.md").write_text("keep private")
    config = isolated / "config.toml"
    config.write_text(f'[defaults]\nworkspace = {json.dumps(str(real))}\n')
    monkeypatch.chdir(real)
    monkeypatch.setenv("AI_PERSONA_WORKSPACE", str(real))
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(config))
    before_real, before_seed = fingerprints(real), fingerprints(demo.demo_seed())
    selected = demo_workspace()
    assert selected.is_demo and selected.root != real and selected.data_root != demo.demo_seed()
    PersonaCompiler(selected.data_root, selected.state_root).build()
    HumanEditService(selected.data_root, selected.state_root).create_update(
        "kn_demo_berry", {"knowledge_level": "proficient"}
    )
    assert demo_workspace() == selected
    assert PersonaStore(selected.data_root).load().records["kn_demo_berry"].record.knowledge_level == "proficient"
    assert fingerprints(real) == before_real
    assert fingerprints(demo.demo_seed()) == before_seed
    assert json.loads(config.read_text().split(" = ", 1)[1]) == str(real)


def test_missing_packaged_demo_never_uses_real_data(isolated, monkeypatch):
    installed = isolated / "installed/src/ai_persona/demo.py"
    installed.parent.mkdir(parents=True)
    (isolated / "persona-data").mkdir()
    (isolated / "persona-data/private.md").write_text("private")
    monkeypatch.setattr(demo, "__file__", str(installed))
    monkeypatch.chdir(isolated)
    with pytest.raises(ValueError, match="缺少 Demo"):
        demo_workspace()
    assert (isolated / "persona-data/private.md").read_text() == "private"


def test_existing_unmarked_directory_is_not_overwritten(isolated):
    root = demo.demo_root()
    (root / "persona-data").mkdir(parents=True)
    marker = root / "persona-data/private.md"
    marker.write_text("private")
    with pytest.raises(ValueError, match="Demo 标识"):
        demo_workspace()
    assert marker.read_text() == "private"


@pytest.mark.parametrize("linked", ["workspace", "record", "state"])
@pytest.mark.parametrize("explicit", [False, True])
def test_demo_rejects_links_to_real_data(isolated, linked, explicit):
    private = isolated / "private"
    private.mkdir()
    if linked == "workspace":
        root = demo.demo_root()
        root.parent.mkdir(parents=True)
        root.symlink_to(private, target_is_directory=True)
    else:
        selected = demo_workspace()
        if linked == "record":
            (selected.data_root / "records/private").symlink_to(private, target_is_directory=True)
        else:
            selected.state_root.rmdir()
            selected.state_root.symlink_to(private, target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        if explicit:
            resolve_workspace(workspace=demo.demo_root(), data_root=None, state_root=None,
                              demo=False, require_data=True, require_state=True)
        else:
            demo_workspace()
    assert not list(private.iterdir())


def test_explicit_demo_cannot_mix_state_or_become_real_default(isolated, capsys):
    selected = demo_workspace()
    resolved = resolve_workspace(workspace=selected.root, data_root=None, state_root=None,
                                 demo=False, require_data=True, require_state=True)
    assert resolved.is_demo
    with pytest.raises(ValueError, match="状态目录"):
        resolve_workspace(workspace=None, data_root=selected.data_root, state_root=isolated / "real-state",
                          demo=False, require_data=True, require_state=True)
    assert cli.main(["configure", "--workspace", str(selected.root)]) == 2
    assert "Demo" in capsys.readouterr().err
    with pytest.raises(ValueError, match="模板"):
        create_app(demo.demo_seed(), isolated / "template-state")


def test_demo_models_ignore_real_credentials_and_public_origin(isolated, monkeypatch):
    private = isolated / "private-models"
    private.mkdir()
    (private / "settings.json").write_text("private model settings")
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(private))
    monkeypatch.setenv("AI_PERSONA_PUBLIC_ORIGIN", "https://private.example")
    selected = demo_workspace()
    PersonaCompiler(selected.data_root, selected.state_root).build()
    service = PersonaAIService(selected.data_root, selected.state_root)
    assert service.model.directory == selected.state_root / "models"
    assert ModelClient().directory == private
    app = create_app(selected.data_root, selected.state_root)
    assert app.state.studio_access.public_origin == ""
    before = fingerprints(private)
    with TestClient(app) as client:
        assert client.get("/settings/models").status_code == 200
        assert "DEMO" in client.get("/").text
        assert client.get("/", headers={"Host": "private.example"}).status_code == 403
    assert fingerprints(private) == before


def test_demo_blocks_host_discovery_hook_install_and_automatic_capture(isolated, monkeypatch):
    selected = demo_workspace()
    PersonaCompiler(selected.data_root, selected.state_root).build()
    def forbidden(*args, **kwargs):
        pytest.fail("Demo must not inspect or modify the real host")
    monkeypatch.setattr("ai_persona.codex_setup.environment", forbidden)
    monkeypatch.setattr("ai_persona.codex_setup.install", forbidden)
    headers = {"X-AI-Persona": "1"}
    with TestClient(create_app(selected.data_root, selected.state_root)) as client:
        assert client.get("/api/learning/v1/codex/environment").status_code == 403
        for path in ["/api/learning/v1/connections/test/setup/install",
                     "/api/learning/v1/connections", "/api/learning/v1/events",
                     "/api/learning/v1/settings", "/api/preferences/application/config"]:
            response = client.post(path, json={}, headers=headers)
            assert response.status_code == 403
            assert response.json()["error"]["code"] == "demo_isolated"
        assert client.get("/preferences").status_code == 200
        assert client.get("/preferences/try").status_code == 200
    assert cli.main(["learning", "start-worker", "--demo"]) == 2


def test_demo_start_preserves_automatic_port_selection_and_model_stop(isolated, monkeypatch):
    observed = {}
    def start(workspace, **kwargs):
        assert workspace.is_demo
        observed.update(kwargs)
        return {"ok": True}
    monkeypatch.setattr(cli, "start_ui", start)
    assert cli.main(["start", "--demo", "--no-open"]) == 0
    assert observed["port"] is None
    assert cli.main(["start", "--demo", "--port", "9988", "--no-open"]) == 0
    assert observed["port"] == 9988
    stopped = []
    monkeypatch.setattr(ModelClient, "stop", lambda self: stopped.append(self.directory))
    assert cli.main(["models-stop", "--demo"]) == 0
    assert stopped == [demo_workspace().state_root / "models"]
