import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_persona import studio_web


def test_workbench_default_and_custom_origin(monkeypatch):
    monkeypatch.delenv("AI_PERSONA_PROMPT_WORKBENCH_URL", raising=False)
    assert studio_web.workbench_url() == "http://127.0.0.1:4318"
    monkeypatch.setenv("AI_PERSONA_PROMPT_WORKBENCH_URL", "https://workbench.example:8443/")
    assert studio_web.workbench_url() == "https://workbench.example:8443"


@pytest.mark.parametrize("value", ["javascript:alert(1)", "//example.org", "http://user:secret@example.org", "http://localhost:0", "http://localhost:bad", "http://localhost:4318/path", "http://localhost:4318?x=1", "http://localhost:4318#fragment", "http://localhost:4318\n"])
def test_workbench_rejects_ambiguous_or_unsafe_urls(monkeypatch, value):
    monkeypatch.setenv("AI_PERSONA_PROMPT_WORKBENCH_URL", value)
    with pytest.raises(ValueError, match="AI_PERSONA_PROMPT_WORKBENCH_URL"):
        studio_web.workbench_url()


def test_health_check_uses_configured_https_host_and_port(monkeypatch):
    monkeypatch.setenv("AI_PERSONA_PROMPT_WORKBENCH_URL", "https://workbench.example:9443")
    calls = []

    class Response:
        status = 200

        def read(self, limit):
            return b'{"service":"prompt-workbench"}'

    class Connection:
        def __init__(self, host, port, timeout):
            calls.append((host, port, timeout))

        def request(self, method, path):
            calls.append((method, path))

        def getresponse(self):
            return Response()

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(studio_web, "HTTPSConnection", Connection)
    assert studio_web.workbench_available()
    assert calls == [("workbench.example", 9443, 0.8), ("GET", "/api/health"), "closed"]


def test_workbench_redirect_keeps_project_and_does_not_accept_request_target(monkeypatch):
    monkeypatch.setenv("AI_PERSONA_PROMPT_WORKBENCH_URL", "http://127.0.0.1:5321")
    app = FastAPI()
    studio_web.mount_studio_routes(app, None, None, None, None)
    client = TestClient(app)
    response = client.get("/studio/workbench?url=https://untrusted.invalid", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "http://127.0.0.1:5321/?project=ai-persona"
    assert client.get("/studio/workbench", headers={"Origin": "https://untrusted.invalid"}).status_code == 403
