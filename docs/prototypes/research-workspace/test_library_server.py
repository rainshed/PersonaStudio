"""Exercise real-record integration using only disposable copies of the fixture."""
import hashlib
import shutil
from pathlib import Path

import pytest
from ai_persona.frontmatter import dump_markdown_record, load_markdown_record
from ai_persona.store import PersonaStore
from fastapi.testclient import TestClient
from library_server import create_app

ROOT = Path(__file__).resolve().parents[3]
ORIGIN = "https://test-machine.example.ts.net:10000"


def fingerprints(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


@pytest.fixture
def library(tmp_path):
    data = tmp_path / "persona-data"
    shutil.copytree(ROOT / "apps/ai-persona/tests/fixtures/legacy-demo/persona-data", data)
    with TestClient(create_app(data, public_origin=ORIGIN)) as client:
        yield data, client


def test_catalog_details_are_read_only_and_limited_to_library(library):
    data, client = library
    before = fingerprints(data)
    response = client.get("/api/library")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    catalog = response.json()
    assert catalog["mode"] == "live"
    assert catalog["counts"]["knowledge"] > 0
    assert catalog["counts"]["material"] > 0
    assert {i["kind"] for i in catalog["items"]} == {"knowledge", "material"}
    assert all(i["source"] == "live" and i["id"].startswith("ps_") for i in catalog["items"])
    assert all("body" not in i for i in catalog["items"])
    for item in catalog["items"]:
        detail = client.get(f'/api/library/items/{item["id"]}').json()
        assert detail["id"] == item["id"]
        assert detail["record_id"] == item["record_id"]
        assert "body" in detail
    assert str(data) not in response.text
    assert fingerprints(data) == before


def test_refresh_reads_changes_and_keeps_stable_identity(library):
    data, client = library
    first = client.get("/api/library").json()["items"][0]
    loaded = PersonaStore(data).load(verify_source_files=False).records[first["record_id"]]
    record, body = load_markdown_record(loaded.path)
    record["title"] = "更新后的条目标题"
    record["summary"] = "更新后的摘要"
    loaded.path.write_text(dump_markdown_record(record, body), encoding="utf-8")
    updated = client.get(f'/api/library/items/{first["id"]}').json()
    assert updated["title"] == record["title"]
    assert updated["summary"] == record["summary"]
    assert updated["id"] == first["id"]
    assert any(i["id"] == first["id"] and i["title"] == record["title"]
               for i in client.get("/api/library").json()["items"])


def test_private_proxy_origin_and_read_only_boundary(library):
    _, client = library
    assert client.get("/api/library", headers={"Host": ORIGIN.split("//")[1]}).status_code == 200
    for headers in [
        {"Host": "evil.example"}, {"Origin": "https://evil.example"},
        {"Sec-Fetch-Site": "cross-site"},
    ]:
        assert client.get("/api/library", headers=headers).status_code == 403
    assert client.post("/api/library", json={}).status_code == 405
    assert client.get("/library_server.py").status_code == 404
    assert client.get("/persona-data/config/persona.toml").status_code == 404
    assert client.get("/api/library/items/kn_missing").status_code == 404
    assert '"mode": "live"' in client.get("/runtime-config.js").text


def test_unavailable_workspace_returns_error_without_demo_fallback(library):
    data, client = library
    (data / "config/persona.toml").unlink()
    response = client.get("/api/library")
    assert response.status_code == 503
    assert "items" not in response.json()
    assert str(data) not in response.text
