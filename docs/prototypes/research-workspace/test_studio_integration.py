"""New research routes must preserve native Studio pages and editing workflows."""
import shutil
from pathlib import Path

import pytest
from ai_persona.compiler import PersonaCompiler
from ai_persona.models import KnowledgeNode
from ai_persona.store import PersonaStore
from ai_persona.web import create_app as create_studio
from bs4 import BeautifulSoup
from fastapi.testclient import TestClient
from library_server import create_integrated_app

ROOT = Path(__file__).resolve().parents[3]
ORIGIN = "https://research.example.ts.net:10000"
HEADERS = {"Host": "research.example.ts.net:10000", "Origin": ORIGIN}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    data, state = tmp_path / "persona-data", tmp_path / "persona-state"
    shutil.copytree(ROOT / "apps/ai-persona/tests/fixtures/legacy-demo/persona-data", data)
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    PersonaCompiler(data, state).build()
    return data, state


def test_native_routes_preserve_modules_and_projects_are_built_in(workspace):
    native = create_studio(*workspace)
    integrated = create_integrated_app(*workspace, public_origin=ORIGIN)
    def contracts(app):
        return {(r.path, tuple(sorted(r.methods)), r.endpoint.__code__)
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
    with TestClient(create_integrated_app(*workspace, public_origin=ORIGIN)) as client:
        before = client.get("/research/api/library", headers=HEADERS).json()["counts"]["knowledge"]
        response = client.post("/knowledge/proposals", headers=HEADERS, data={
            "title": "Integration fixture concept", "semantic_role": "concept",
            "interest_level": "high", "knowledge_level": "aware", "summary": "Fixture summary",
        }, follow_redirects=False)
        assert response.status_code == 303
        assert "/knowledge/kn_" in response.headers["location"]
        store = PersonaStore(data).load()
        record = next(n for n in store.of_type(KnowledgeNode)
                      if n.title == "Integration fixture concept")
        catalog = client.get("/research/api/library", headers=HEADERS).json()
        assert catalog["counts"]["knowledge"] == before + 1
        item = next(i for i in catalog["items"] if i["record_id"] == record.id)
        assert item["detail_url"] == f"{ORIGIN}/knowledge/{record.id}"
        assert client.get(f"/knowledge/{record.id}", headers=HEADERS).status_code == 200
        assert client.post("/research/api/library", headers=HEADERS, json={}).status_code == 405


def test_mounted_assets_and_origin_checks(workspace):
    with TestClient(create_integrated_app(*workspace, public_origin=ORIGIN)) as client:
        for route in ["/research/", "/research/integration.css", "/research/app.js",
                      "/research/library-client.js", "/research/api/library"]:
            assert client.get(route, headers=HEADERS).status_code == 200, route
        config = client.get("/research/runtime-config.js", headers=HEADERS).text
        assert '"apiBase": "/research/api/library"' in config
        assert '"integrated": true' in config
        for route in ["/knowledge", "/preferences", "/research/api/library"]:
            assert client.get(route, headers={"Host": "evil.example"}).status_code == 403
            assert client.get(route, headers={**HEADERS, "Origin": "https://evil.example"}).status_code == 403
