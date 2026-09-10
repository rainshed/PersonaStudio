"""Exercise the proxy boundary with disposable data and a stub model."""
import re

import pytest
from fastapi.testclient import TestClient
from test_evaluations import Model
from test_evaluations import work as work

from ai_persona.web import create_app
from ai_persona.web_access import StudioAccess

ORIGIN = "https://my-mac.example.ts.net:8443"
HOST = "my-mac.example.ts.net:8443"
HEADERS = {"Host": HOST, "Origin": ORIGIN, "Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def remote(work, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_PUBLIC_ORIGIN", ORIGIN)
    app = create_app(*work)
    app.state.ai_service.model = Model()
    with TestClient(app) as client:
        yield app, client


def test_local_default_and_unconfigured_remote_host(work, monkeypatch):
    monkeypatch.delenv("AI_PERSONA_PUBLIC_ORIGIN", raising=False)
    with TestClient(create_app(*work)) as client:
        assert client.get("/healthz").status_code == 200
        assert client.get("/", headers=HEADERS).status_code == 403
        assert client.post("/language", data={"locale": "en"}, headers={
            "Origin": "https://evil.example",
        }).status_code == 403


def test_proxy_pages_assets_and_read_apis(remote):
    _, client = remote
    for path in ["/", "/preferences", "/materials", "/knowledge", "/inbox",
                 "/settings", "/settings/models", "/ai", "/evaluations"]:
        response = client.get(path, headers={"Host": HOST})
        assert response.status_code == 200, (path, response.text[:200])
        assert "http://my-mac" not in response.text
        for asset in re.findall(r'(?:src|href)="(/static/[^\"]+)"', response.text):
            assert client.get(asset, headers={"Host": HOST}).status_code == 200
    for path in ["/api/models/config", "/api/inbox/v1/items", "/api/studio/v1/health",
                 "/api/prompts/v1"]:
        assert client.get(path, headers=HEADERS).status_code == 200, path
    assert "http://127.0.0.1:4318" not in client.get("/evaluations", headers=HEADERS).text
    assert client.get("/api/studio/v1/workbench", headers=HEADERS).json() == {
        "available": False, "remote": True,
    }
    redirect = client.get("/settings/", headers=HEADERS, follow_redirects=False)
    assert redirect.headers["location"] == ORIGIN + "/settings"


def test_remote_json_and_form_writes(remote):
    app, client = remote
    response = client.post("/language", headers=HEADERS, data={
        "locale": "en", "return_to": "/settings",
    }, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/settings"
    assert "en" in response.headers["set-cookie"]
    response = client.post("/api/ai/sessions", headers={**HEADERS, "X-AI-Persona": "1"},
                           json={})
    assert response.status_code == 200, response.text
    assert not app.state.ai_service.model.calls
    assert client.post("/api/ai/sessions", headers=HEADERS, json={}).status_code == 403
    response = client.post("/materials/import-preview", headers=HEADERS,
                           data={"input_kind": "markdown"},
                           files={"markdown_file": ("mobile.md", b"# Mobile upload\n\nTest source.", "text/markdown")},
                           follow_redirects=False)
    assert response.status_code == 303
    preview = client.get(response.headers["location"], headers=HEADERS)
    assert preview.status_code == 200 and "Mobile upload" in preview.text


@pytest.mark.parametrize("origin", ["https://evil.example", "null", ORIGIN + "/",
                                    "http://" + HOST, "https://my-mac.example.ts.net",
                                    ORIGIN + ".evil.example", ORIGIN + "?", ORIGIN + "#"])
def test_foreign_origins_rejected_for_reads_and_forms(remote, origin):
    _, client = remote
    headers = {**HEADERS, "Origin": origin}
    assert client.get("/api/models/config", headers=headers).status_code == 403
    response = client.post("/language", headers=headers, data={"locale": "en"})
    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_cross_site_missing_origin_and_ambiguous_headers(remote):
    _, client = remote
    assert client.get("/", headers={**HEADERS, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/language", headers={"Host": HOST}, data={"locale": "en"}).status_code == 403
    for headers in [[("Host", HOST), ("Host", "evil.example")],
                    [("Host", HOST), ("Origin", ORIGIN), ("Origin", "https://evil.example")]]:
        assert client.get("/", headers=headers).status_code == 403


def test_proxy_rewritten_host_and_forwarded_headers(remote):
    app, client = remote
    assert client.get("/api/models/config", headers={
        **HEADERS, "Host": "127.0.0.1:8765",
    }).status_code == 200
    assert client.get("/", headers={"Host": "evil.example", "X-Forwarded-Host": HOST,
                                   "X-Forwarded-Proto": "https"}).status_code == 403
    # Socket peer must be local even if headers claim otherwise.
    with TestClient(app, client=("100.64.0.2", 12345)) as external:
        assert external.get("/", headers={**HEADERS, "X-Forwarded-For": "127.0.0.1"}).status_code == 403


@pytest.mark.parametrize("value", ["https://example.com/", "https://u:p@example.com",
                                   "https://example.com?q=1", "https://example.com#x",
                                   "ftp://example.com", "https://example.com:0",
                                   "https://example.com:99999", "*", "https://example.com\n"])
def test_invalid_public_origin_fails_closed(value):
    with pytest.raises(ValueError):
        StudioAccess(value)
