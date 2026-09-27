"""Project persistence, browser migration and concurrent clients."""
import copy
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_persona.agent import AgentServiceError
from ai_persona.compiler import PersonaCompiler
from ai_persona.ideas import IdeaService
from ai_persona.projects import ProjectService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def service(tmp_path, monkeypatch):
    data, state = tmp_path / "persona-data", tmp_path / "persona-state"
    shutil.copytree(Path(__file__).parent / "fixtures/legacy-demo/persona-data", data)
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    PersonaCompiler(data, state).build()
    return ProjectService(data, state)


def change(kind, record, label="保存"):
    return {"collection": kind, "value": record, "label": label}


def test_empty_reads_never_seed_or_write(service):
    assert service.catalog()["projects"] == []
    assert not service.path.exists()
    assert service.catalog()["version"] == 0


def test_restart_preserves_tasks_progress_refs_and_history(service):
    p = {"id": "p_real", "title": "真实项目"}
    first = service.save(0, [change("projects", p)])
    ref = __import__("ai_persona.library_references", fromlist=["library_items"]).library_items(
        PersonaStore(service.data).load(), "http://localhost")[0]["id"]
    second = service.save(1, [
        change("projects", {**first["projects"][0], "current": "u_result", "related_refs": [ref]}),
        change("tasks", {"id": "t_one", "project": "p_real", "title": "验证保存", "state": "done",
                         "completed_at": "2026-09-27T12:00:00Z"}),
        change("updates", {"id": "u_result", "project": "p_real", "body": "保存后重启仍然存在。",
                           "occurred_at": "2026-09-27T12:00:00Z", "tasks": ["t_one"], "key": True}),
    ])
    restarted = ProjectService(service.data, service.state).load()
    assert restarted == second
    assert len(restarted["history"]["projects:p_real"]) == 2
    assert restarted["updates"][0]["key"] is True
    assert len(list((service.data / "revisions/projects").glob("*.json"))) == 2
    PersonaStore(service.data).load()  # Old strict Persona readers still work.


def test_stale_client_cannot_overwrite_other_device(service):
    service.save(0, [change("projects", {"id": "p_one", "title": "手机保存"})])
    before = service.path.read_bytes()
    with pytest.raises(AgentServiceError, match="另一设备"):
        service.save(0, [change("projects", {"id": "p_one", "title": "旧电脑版本"})])
    assert service.path.read_bytes() == before


def test_simultaneous_writers_publish_only_one_revision(service):
    def write(title):
        try:
            service.save(0, [change("projects", {"id": "p_one", "title": title})])
            return "saved"
        except AgentServiceError as exc:
            return exc.code
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(write, ["手机", "电脑"]))
    assert sorted(results) == ["conflict", "saved"]
    assert len(service.load()["history"]["projects:p_one"]) == 1


def test_project_ui_ships_with_native_studio_without_demo_seeding(service):
    with TestClient(create_app(service.data, service.state)) as client:
        page = client.get("/projects/")
        assert page.status_code == 200
        assert "demo-data.js" not in page.text
        # Projects must share the live Studio shell, including workspace switching
        # and mobile navigation, instead of recreating navigation in JavaScript.
        assert page.text.count('class="main-nav"') == 1
        assert 'class="workspace-menu"' in page.text
        assert 'href="/projects/#projects" class="active"' in page.text
        assert 'data-assets-active="true"' in page.text
        assert 'id="sidebar"' not in page.text
        assert 'id="topbar"' not in page.text
        assert '/static/projects/styles.css?' in page.text
        assert '/static/studio-navigation.js?' in page.text
        assert '"integrated": true' in client.get("/projects/runtime-config.js").text
        assert client.get("/projects/app.js").status_code == 200
        assert client.get("/projects/../projects.py").status_code == 404
        assert client.get("/research/", follow_redirects=False).headers["location"] == "/projects/"
        assert client.get("/api/projects/library").json()["mode"] == "live"
        assert not service.path.exists()


@pytest.mark.parametrize("record", [
    {"id": "../escape", "title": "无效"}, {"id": "p_one", "title": ""},
    {"id": "p_one", "title": "无效状态", "state": "running"},
    {"id": "p_one", "title": "无效知识", "related_refs": ["unknown"]},
    {"id": "p_one", "title": "无效链接", "entries": [
        {"id": "w_one", "kind": "repo", "label": "仓库", "target": "javascript:alert(1)"}]},
])
def test_invalid_project_never_publishes(service, record):
    with pytest.raises(AgentServiceError):
        service.save(0, [change("projects", record)])
    assert not service.path.exists()


def test_cross_project_results_and_cycles_rejected(service):
    service.save(0, [change("projects", {"id": "p_one", "title": "一"}),
                     change("projects", {"id": "p_two", "title": "二"})])
    u = {"body": "说明", "occurred_at": "2026-09-27T12:00:00Z", "validity": "superseded", "status_note": "新结果"}
    with pytest.raises(AgentServiceError):
        service.save(1, [change("updates", {**u, "id": "u_one", "project": "p_one", "superseded_by": "u_two"}),
                         change("updates", {**u, "id": "u_two", "project": "p_two", "superseded_by": "u_one"})])
    assert service.load()["version"] == 1


def test_failed_atomic_publish_retains_previous_commit(service, monkeypatch):
    old = service.save(0, [change("projects", {"id": "p_one", "title": "保存的版本"})])
    import ai_persona.projects as module
    write = module._atomic_write
    def fail_canonical(path, content):
        if path == service.path:
            raise OSError("disk full")
        write(path, content)
    monkeypatch.setattr(module, "_atomic_write", fail_canonical)
    with pytest.raises(OSError):
        service.save(1, [change("projects", {"id": "p_one", "title": "未提交"})])
    assert service.load() == old
    assert not (service.data / "revisions/projects/00000002.json").exists()


def browser_snapshot():
    metadata = {"revision": 1, "created_at": "2026-09-26T12:00:00Z", "updated_at": "2026-09-26T12:00:00Z"}
    project = {**metadata, "id": "p_old", "title": "浏览器里的研究", "origin": {"id": "i_old", "revision": 1}}
    task = {**metadata, "id": "t_old", "title": "原待办", "project": "p_old", "idea": "i_old"}
    return {"projects": [project, {**metadata, "id": "p_example", "title": "未选择的示例"}],
            "tasks": [task], "updates": [], "events": [],
            "legacy_ideas": [{"id": "i_old", "project": "p_old", "title": "原想法", "body": "原正文",
                              "state": "closed", "closure_note": "原结束说明"}],
            "history": {"projects:p_old": [{**project, "action_label": "创建"}],
                        "tasks:t_old": [{**task, "action_label": "创建"}]}}


def test_selected_import_is_idempotent_preserves_history_and_resolves_ideas(service):
    snapshot = browser_snapshot()
    original = copy.deepcopy(snapshot)
    value = service.import_browser(0, snapshot, ["p_old"])
    assert [p["id"] for p in value["projects"]] == ["p_old"]
    target = value["tasks"][0]["idea"]
    assert target.startswith("idea_import_")
    idea = IdeaService(service.data, service.state).get(target)
    assert idea.record.closure.summary == "原结束说明"
    assert "原正文" in idea.body
    assert value["projects"][0]["origin"]["id"] == target
    assert value["history"]["tasks:t_old"][0]["action_label"] == "创建"
    assert json.loads(next((service.data / "projects/imports").glob("*.json")).read_text()) == original
    assert service.import_browser(1, snapshot, ["p_old"]) == value
    assert snapshot == original


def test_api_requires_origin_workspace_and_revision(service):
    with TestClient(create_app(service.data, service.state)) as client:
        catalog = client.get("/api/projects").json()
        body = {"expected_revision": 0, "workspace_key": catalog["workspace_key"],
                "changes": [change("projects", {"id": "p_api", "title": "API 项目"})]}
        assert client.post("/api/projects", json=body).status_code == 403
        headers = {"X-AI-Persona": "1"}
        assert client.post("/api/projects", json={**body, "workspace_key": "wrong"}, headers=headers).status_code == 409
        assert client.post("/api/projects", json=body, headers={**headers, "Origin": "https://evil.example"}).status_code == 403
        assert client.post("/api/projects", json=body, headers=headers).status_code == 200
        assert client.post("/api/projects", json=body, headers=headers).status_code == 409
    with TestClient(create_app(service.data, service.state)) as other_device:
        assert other_device.get("/api/projects").json()["projects"][0]["title"] == "API 项目"
