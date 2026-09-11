
import pytest
from fastapi.testclient import TestClient

from ai_persona.agent import AgentServiceError
from ai_persona.demo import workspace_identity
from ai_persona.editor_drafts import EditorDrafts
from ai_persona.initialization import initialize_persona
from ai_persona.web import create_app


@pytest.fixture
def studio(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config/config.toml"))
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    monkeypatch.setenv("AI_PERSONA_MODEL_DATA_DIR", str(tmp_path / "models"))
    monkeypatch.setenv("AI_PERSONA_MODEL_RUNTIME_CACHE_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    root = tmp_path / "workspace"
    data, state = root / "persona-data", root / "persona-state"
    initialize_persona(data, state, persona_id="test-persona")
    app = create_app(data, state)
    client = TestClient(app)
    client.headers.update({"X-AI-Persona": "1", "Origin": "http://testserver"})
    yield app, client, data, state


def test_drafts_survive_reopen_and_are_independent(studio, tmp_path):
    _, client, _, state = studio
    value = {
        "id": "editor-tab-one",
        "page": "/preferences/new",
        "baseline": "",
        "revision": 0,
        "fields": {"instruction": ["回答先给结论。"], "scope": ["global"]},
    }
    saved = client.post("/api/studio/editor-drafts", json=value)
    assert saved.status_code == 200, saved.text
    assert saved.json()["revision"] == 1
    assert (
        client.post(
            "/api/studio/editor-drafts",
            json={
                "action": "close",
                "id": value["id"],
                "revision": 0,
            },
        ).json()["error"]["code"]
        == "conflict"
    )
    assert EditorDrafts(state).list("/preferences/new")[0]["fields"] == value["fields"]
    second = {
        **value,
        "id": "editor-tab-two",
        "fields": {"instruction": ["Keep explanations short."]},
    }
    assert client.post("/api/studio/editor-drafts", json=second).status_code == 200
    assert len(EditorDrafts(state).list("/preferences/new")) == 2
    assert EditorDrafts(tmp_path / "other-state").list("/preferences/new") == []
    assert (
        client.post("/api/studio/editor-drafts", json=value).json()["error"]["code"] == "conflict"
    )
    assert (
        client.post(
            "/api/studio/editor-drafts", json={"action": "close", "id": value["id"]}
        ).status_code
        == 200
    )
    assert (
        client.post("/api/studio/editor-drafts", json={**value, "revision": 2}).json()["error"][
            "code"
        ]
        == "conflict"
    )
    assert len(EditorDrafts(state).list("/preferences/new")) == 1


def test_closed_draft_cannot_be_resurrected_and_credentials_rejected(studio):
    _, client, _, _ = studio
    client.post("/api/studio/editor-drafts", json={"action": "close", "id": "late-request"})
    value = {
        "id": "late-request",
        "page": "/knowledge/new",
        "baseline": "",
        "revision": 0,
        "fields": {"title": ["new"]},
    }
    assert (
        client.post("/api/studio/editor-drafts", json=value).json()["error"]["code"] == "conflict"
    )
    value.update(id="other-request", fields={"apiKey": ["never-store-this"]})
    assert client.post("/api/studio/editor-drafts", json=value).status_code == 400
    value.update(page="/settings/models", fields={"title": ["x"]})
    assert client.post("/api/studio/editor-drafts", json=value).status_code == 400


def test_old_workspace_tab_cannot_write(studio):
    app, client, data, state = studio
    value = {
        "id": "editor-tab-one",
        "page": "/knowledge/new",
        "baseline": "",
        "revision": 0,
        "fields": {},
    }
    assert (
        client.post(
            "/api/studio/editor-drafts",
            json=value,
            headers={"X-Persona-Workspace": "previous-workspace"},
        ).status_code
        == 409
    )
    assert app.state.active_writes == 0
    assert (
        client.post(
            "/api/studio/editor-drafts",
            json=value,
            headers={"X-Persona-Workspace": workspace_identity(data, state)},
        ).status_code
        == 200
    )
    assert (
        client.post("/api/studio/editor-drafts?_workspace_id=wrong", json=value).status_code == 409
    )


def test_readiness_uses_maintenance_override_and_never_calls_model(studio, monkeypatch):
    app, client, _, _ = studio
    monkeypatch.setattr(app.state.model_setup, "status", lambda: {"status": "not_installed"})
    monkeypatch.setattr(
        app.state.ai_service.model,
        "request",
        lambda *a: pytest.fail("No model request before runtime is ready"),
    )
    assert client.get("/api/studio/readiness").json()["status"] == "not_installed"
    monkeypatch.setattr(app.state.model_setup, "status", lambda: {"status": "ready"})
    calls = []

    def config(route):
        calls.append(route)
        return {
            "settings": {
                "defaultConnectionId": "missing",
                "defaultModelId": "",
                "overrides": {"maintenance": "valid"},
                "overrideModelIds": {"maintenance": "example"},
                "connections": [{"id": "valid", "authType": "none"}],
            }
        }

    monkeypatch.setattr(app.state.ai_service.model, "request", config)
    assert client.get("/api/studio/readiness").json()["ready"] is True
    assert calls == ["config"]


def test_text_import_handoff_preserves_source_and_is_idempotent(studio):
    app, client, data, _ = studio
    response = client.post(
        "/materials/import-preview",
        data={
            "input_kind": "text",
            "source_title": "测试笔记",
            "source_text": "# 谱聚类\n\n谱聚类使用相似度矩阵的特征向量，对图的节点进行分组。",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303, response.text
    identifier = response.headers["location"].split("/")[-1]
    assert "测试笔记" in client.get(response.headers["location"]).text
    result = client.post(f"/api/studio/materials/{identifier}/use", json={"target": "extract"})
    assert result.status_code == 200, result.text
    assert (
        client.post(f"/api/studio/materials/{identifier}/use", json={"target": "extract"}).json()
        == result.json()
    )
    task = app.state.extraction_service.repository.get(result.json()["url"].split("=")[-1])
    assert task["status"] != "running"
    result2 = client.post(f"/api/studio/materials/{identifier}/use", json={"target": "ai"})
    assert result2.status_code == 200, result2.text
    session = app.state.ai_service.get_session(result2.json()["url"].split("=")[-1])
    assert session["attachments"][0]["id"] == task["members"][0]["source_id"]
    assert not session["messages"] and session["status"] == "idle"
    from ai_persona.store import PersonaStore

    assert not any(
        item.record.entity_type in {"material", "knowledge_node"}
        for item in PersonaStore(data).load().records.values()
    )


def test_invalid_encoding_and_scanned_pdf(studio):
    _, client, _, _ = studio
    response = client.post(
        "/materials/import-preview",
        data={"input_kind": "markdown"},
        files={"markdown_file": ("bad.txt", b"\xff\xfe", "text/plain")},
    )
    assert response.status_code == 422
    assert "UTF-8" in response.text
    import io

    import pypdfium2 as pdfium

    from ai_persona.extraction.sources import parse_file

    pdf = pdfium.PdfDocument.new()
    pdf.new_page(200, 200)
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    with pytest.raises(AgentServiceError, match="可靠"):
        parse_file(out.getvalue(), "scan.pdf")


def test_unfinished_editor_keeps_uploaded_source_past_expiry(studio):
    from datetime import datetime, timedelta, timezone

    from ai_persona.material_imports.service import MaterialImportService

    _, _, data, state = studio
    importer = MaterialImportService(data, state)
    draft = importer.create_file("note.txt", b"A durable source for an unfinished material edit.")
    editors = EditorDrafts(state)
    editors.save(
        {
            "id": "retained-upload",
            "page": f"/materials/imports/{draft.id}",
            "revision": 0,
            "baseline": "",
            "fields": {"authors": ["An author"]},
        }
    )
    draft.created_at = datetime.now(timezone.utc) - timedelta(days=3)
    draft.expires_at = datetime.now(timezone.utc) - timedelta(days=2)
    importer.repository.save(draft)
    assert importer.repository.cleanup_expired() == 0
    assert importer.get(draft.id).id == draft.id
    editors.close("retained-upload")
    assert importer.repository.cleanup_expired() == 1


def test_copied_read_observation_does_not_validate_another_workspace(studio, tmp_path):
    import shutil

    from ai_persona.mcp_setup import configuration, record_client_read

    _, client, data, state = studio
    record_client_read(data, state, configuration(data, state)[1], "get_knowledge_map")
    other_data, other_state = tmp_path / "other-data", tmp_path / "other-state"
    other_state.mkdir()
    shutil.copy2(state / "mcp-setup.sqlite3", other_state / "mcp-setup.sqlite3")
    assert configuration(data, state)[1] != configuration(other_data, other_state)[1]
    assert client.get("/api/studio/mcp-setup").json()["client_read"]["workspace_id"] == workspace_identity(data, state)


def test_full_content_reset_clears_editor_text_and_rejects_late_save(studio):
    from ai_persona.content_reset import ContentReset

    _, _, data, state = studio
    repository = EditorDrafts(state)
    draft = {
        "id": "reset-draft",
        "page": "/preferences/new",
        "revision": 0,
        "baseline": "",
        "fields": {"instruction": ["An unfinished private preference"]},
    }
    repository.save(draft)
    reset = ContentReset(data, state)
    preview = reset.plan()
    assert preview["editor_drafts"] == 1
    reset.apply(token=preview["token"])
    assert repository.list("/preferences/new") == []
    with pytest.raises(AgentServiceError, match="草稿已变化"):
        repository.save({**draft, "revision": 1})


def test_mcp_read_status_is_independent_from_self_check_hook_and_config_changes(studio, tmp_path):
    import asyncio

    from mcp import Client

    from ai_persona.mcp_server import create_mcp_server

    _, client, data, state = studio
    assert client.get("/api/studio/mcp-setup").json()["client_read"] is None
    checked = client.post("/api/studio/mcp-setup/diagnose", json={}).json()
    assert checked["ok"], checked
    assert client.get("/api/studio/mcp-setup").json()["client_read"] is None
    query = client.post("/api/studio/mcp-setup/probe", json={}).json()
    assert "verify_persona_connection" not in query["message"]

    async def scenario():
        async with Client(create_mcp_server(data, state), cache=None) as external:
            # Failed calls and enumeration do not count as a successful read.
            await external.list_tools()
            assert (await external.call_tool("search_knowledge", {})).is_error
            assert client.get("/api/studio/mcp-setup").json()["client_read"] is None
            read = await external.call_tool(query["tool"], query["arguments"])
            assert not read.is_error and read.structured_content["data"]["nodes"] == []
            observed = client.get("/api/studio/mcp-setup").json()["client_read"]
            assert set(observed) == {"received", "host", "tool", "workspace_id"}
            assert observed["tool"] == "get_knowledge_map"
            config = tmp_path / "codex/config.toml"
            config.parent.mkdir(exist_ok=True)
            config.write_text('[mcp_servers.other]\ncommand="python"\n')
            assert client.get("/api/studio/mcp-setup").json()["client_read"] is None
            # An already-running old server cannot validate the new configuration.
            await external.call_tool(query["tool"], query["arguments"])
            assert client.get("/api/studio/mcp-setup").json()["client_read"] is None
    asyncio.run(scenario())
    assert client.get("/api/studio/integrations").json()["connections"] == []


def test_generated_mcp_configuration_starts_and_reads_over_stdio(studio):
    import asyncio
    import os
    import tomllib
    from pathlib import Path

    from mcp import Client, StdioServerParameters

    from ai_persona.query_mcp import PUBLIC_QUERY_TOOLS

    _, studio_client, _, _ = studio
    snippet = studio_client.get("/api/studio/mcp-setup").json()["config"]
    home = Path(os.environ["CODEX_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.toml").write_text(snippet)
    settings = tomllib.loads(snippet)["mcp_servers"]["ai_persona"]
    assert set(settings.pop("enabled_tools")) == set(PUBLIC_QUERY_TOOLS)
    query = studio_client.post("/api/studio/mcp-setup/probe", json={}).json()

    async def scenario():
        env = {key: value for key, value in os.environ.items()
               if key.startswith("AI_PERSONA_") or key == "CODEX_HOME"}
        assert settings["env"]["PYTHONPATH"] == str(Path(__file__).resolve().parents[1] / "src")
        env.update(settings.pop("env"))
        async with Client(StdioServerParameters(**settings, env=env), read_timeout_seconds=10) as external:
            listed = await external.list_tools()
            assert tuple(t.name for t in listed.tools) == PUBLIC_QUERY_TOOLS
            result = await external.call_tool(query["tool"], query["arguments"])
            assert not result.is_error
            assert result.structured_content["data"]["nodes"] == []
    asyncio.run(scenario())
    status = studio_client.get("/api/studio/mcp-setup").json()
    assert status["configured"] and status["client_read"]
    assert status["client_read"]["workspace_id"] == query["workspace_id"]
    assert studio_client.get("/api/studio/integrations").json()["connections"] == []


def test_mcp_diagnostic_failure_does_not_report_a_client_read(studio, monkeypatch):
    from ai_persona import mcp_setup
    _, client, _, _ = studio
    monkeypatch.setattr(mcp_setup, "server_arguments", lambda *a: ["-c", "raise SystemExit(1)"])
    result = client.post("/api/studio/mcp-setup/diagnose", json={}).json()
    assert not result["ok"] and result["error"] == "service_unavailable"
    assert client.get("/api/studio/mcp-setup").json()["client_read"] is None


def test_mcp_observation_failure_does_not_break_read(studio, monkeypatch):
    import asyncio

    from mcp import Client

    from ai_persona import mcp_setup
    from ai_persona.mcp_server import create_mcp_server
    _, _, data, state = studio
    def failed(*args):
        raise OSError("diagnostics storage unavailable")
    monkeypatch.setattr(mcp_setup, "record_client_read", failed)
    async def scenario():
        async with Client(create_mcp_server(data, state)) as external:
            result = await external.call_tool("get_knowledge_map", {"scope": {"tag_ids": []}})
            assert not result.is_error
    asyncio.run(scenario())


def test_workspace_switch_blocks_writes_and_running_tasks(studio):
    app, client, data, state = studio
    value = {"workspace_id": workspace_identity(data, state)}
    app.state.ai_jobs["active"] = "test"
    assert (
        client.post("/api/studio/workspaces/prepare-switch", json=value).json()["error"]["code"]
        == "busy"
    )
    app.state.ai_jobs.clear()
    result = client.post("/api/studio/workspaces/prepare-switch", json=value)
    assert result.status_code == 200, result.text
    assert client.post("/api/studio/editor-drafts", json={}).status_code == 409
    assert client.get("/knowledge").status_code == 200
    assert (
        client.post(
            "/api/studio/workspaces/prepare-switch", json={**value, "release": True}
        ).status_code
        == 200
    )
    assert not app.state.switching


def test_friendly_workspace_name_and_failure_recovery(studio, tmp_path, monkeypatch):
    from ai_persona import launcher, onboarding, workspace_switch
    from ai_persona.workspace import PersonaWorkspace, configured_workspace

    _, _, data, state = studio
    original = PersonaWorkspace(data.parent, data, state)
    target = tmp_path / "new"
    order = []
    monkeypatch.setattr(workspace_switch, "prepare_original", lambda w: order.append("prepare"))
    monkeypatch.setattr(launcher, "stop_ui", lambda w: order.append("stop"))

    def start(w, **kwargs):
        order.append("start:" + str(w.root))
        if w.root == target:
            raise RuntimeError("target failed")
        return {"url": "http://127.0.0.1:8765"}

    monkeypatch.setattr(onboarding, "start_ui", start)
    app = onboarding.create_setup_app(default_workspace=target, switch_from=original)
    client = TestClient(app)
    client.headers.update({"Origin": "http://testserver", "X-Persona-Setup": app.state.setup_token})
    result = client.post(
        "/api/setup",
        json={"mode": "create", "path": str(target), "name": "研究笔记", "confirm_switch": True},
    )
    assert result.status_code == 400
    assert order == ["prepare", "stop", "start:" + str(target), "start:" + str(data.parent)]
    assert configured_workspace() is None
    assert (target / "persona-data/config/persona.toml").exists()
    monkeypatch.setattr(onboarding, "start_ui", lambda *a, **kw: {"url": "http://127.0.0.1:12345"})
    result = client.post(
        "/api/setup",
        json={"mode": "create", "path": str(target), "name": "研究笔记", "confirm_switch": True},
    )
    assert result.status_code == 200
    from ai_persona.workspace_registry import display_name

    assert display_name(target / "persona-data") == "研究笔记"
