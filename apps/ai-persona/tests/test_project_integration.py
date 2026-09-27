"""New research routes must preserve native Studio pages and editing workflows."""
import shutil
from pathlib import Path

import pytest
from bs4 import BeautifulSoup
from fastapi.testclient import TestClient

from ai_persona.asgi import create_app as create_service
from ai_persona.compiler import PersonaCompiler
from ai_persona.models import KnowledgeNode
from ai_persona.store import PersonaStore
from ai_persona.web import create_app as create_studio

FIXTURE = Path(__file__).parent / "fixtures/legacy-demo/persona-data"
ORIGIN = "https://research.example.ts.net:10000"
HEADERS = {"Host": "research.example.ts.net:10000", "Origin": ORIGIN}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    data, state = tmp_path / "persona-data", tmp_path / "persona-state"
    shutil.copytree(FIXTURE, data)
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    monkeypatch.setenv("AI_PERSONA_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("AI_PERSONA_PUBLIC_ORIGIN", ORIGIN)
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "config.toml"))
    PersonaCompiler(data, state).build()
    return data, state


def test_native_routes_preserve_modules_and_projects_are_built_in(workspace):
    native = create_studio(*workspace)
    integrated = create_service()
    def contracts(app):
        return {(r.path, tuple(sorted(r.methods)))
                for r in app.routes if hasattr(r, "methods")}
    assert contracts(native) <= contracts(integrated)
    with TestClient(native) as client:
        assert 'class="research-nav-addition"' not in client.get("/").text
    with TestClient(integrated) as client:
        for page in ["/", "/knowledge", "/courses", "/materials", "/ideas", "/preferences",
                     "/inbox", "/evaluations", "/settings", "/ai", "/projects/", "/workspaces"]:
            response = client.get(page, headers=HEADERS)
            assert response.status_code == 200, page
            if page != "/workspaces":
                soup = BeautifulSoup(response.text, "html.parser")
                hrefs = {a.get("href") for a in soup.select(".main-nav a")}
                assert {"/knowledge", "/courses", "/materials", "/ideas", "/preferences",
                        "/inbox", "/evaluations", "/settings"} <= hrefs
                assert "/projects/#projects" in hrefs
                assert [a["href"] for a in soup.select(".persona-nav-items a")] == ["/knowledge", "/courses", "/materials", "/preferences", "/ideas", "/projects/#projects"]
                assert "试用" not in soup.select_one(".main-nav").get_text()
                assert "/research/#ideas" not in hrefs
                assert len(soup.select('.main-nav a[href="/ideas"]')) == 1
        assert "data-graph-data" in client.get("/knowledge").text
        assert "data-preference-workspace" in client.get("/preferences").text
        assert 'href="/ideas/new"' in client.get("/ideas").text


def test_native_edit_is_visible_to_new_reference_picker(workspace):
    data, _ = workspace
    with TestClient(create_service()) as client:
        before = client.get("/api/projects/library", headers=HEADERS).json()["counts"]["knowledge"]
        response = client.post("/knowledge/proposals", headers=HEADERS, data={
            "title": "Integration fixture concept", "semantic_role": "concept",
            "interest_level": "high", "knowledge_level": "aware", "summary": "Fixture summary",
        }, follow_redirects=False)
        assert response.status_code == 303
        assert "/knowledge/kn_" in response.headers["location"]
        store = PersonaStore(data).load()
        record = next(n for n in store.of_type(KnowledgeNode)
                      if n.title == "Integration fixture concept")
        catalog = client.get("/api/projects/library", headers=HEADERS).json()
        assert catalog["counts"]["knowledge"] == before + 1
        item = next(i for i in catalog["items"] if i["record_id"] == record.id)
        assert item["detail_url"] == f"{ORIGIN}/knowledge/{record.id}"
        assert client.get(f"/knowledge/{record.id}", headers=HEADERS).status_code == 200
        assert client.post("/api/projects/library", headers=HEADERS, json={}).status_code == 405


def test_mounted_assets_and_origin_checks(workspace):
    with TestClient(create_service()) as client:
        for route in ["/research/", "/projects/app.js", "/projects/library-client.js",
                      "/static/idea-reference-rules.js", "/api/projects/library"]:
            assert client.get(route, headers=HEADERS).status_code == 200, route
        assert client.get("/projects/runtime-config.js", headers=HEADERS).status_code == 404
        assert client.get("/projects/integration.css", headers=HEADERS).status_code == 404
        for route in ["/knowledge", "/preferences", "/api/projects/library"]:
            assert client.get(route, headers={"Host": "evil.example"}).status_code == 403
            assert client.get(route, headers={**HEADERS, "Origin": "https://evil.example"}).status_code == 403


def test_supervised_service_workspace_selection(workspace, monkeypatch, tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('[defaults]\nworkspace = "/unused-workspace"\n')
    app = create_service()
    assert app.state.data_root == workspace[0]
    assert app.state.state_root == workspace[1]
    monkeypatch.delenv("AI_PERSONA_WORKSPACE")
    config.write_text(f'[defaults]\nworkspace = "{tmp_path}"\n')
    assert create_service().state.data_root == workspace[0]
    config.unlink()
    with pytest.raises(ValueError, match="请选择 Persona 工作区"):
        create_service()
