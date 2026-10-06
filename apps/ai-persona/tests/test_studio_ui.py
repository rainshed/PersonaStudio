"""Classic and Studio interfaces share every page; only the shell and styles differ."""
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_evaluations import work as work

from ai_persona.store import PersonaStore
from ai_persona.studio_theme import (
    build_remap,
    parse_color,
    prefix_selector,
    remap_rules,
    token_for,
)
from ai_persona.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "src/ai_persona/static"
PAGES = ["/", "/knowledge", "/courses", "/materials", "/preferences", "/ideas", "/inbox",
         "/evaluations", "/ai", "/settings/models", "/settings?tab=sources",
         "/settings/extensions", "/settings/appearance", "/projects/", "/knowledge/new",
         "/preferences/new", "/materials/new", "/workspaces"]


@pytest.fixture
def client(work):
    return TestClient(create_app(*work))


def studio(client, theme="light"):
    client.cookies.set("persona_ui", "studio")
    client.cookies.set("persona_theme", theme)
    return client


def test_classic_is_default_and_appearance_is_only_in_settings(client):
    page = client.get("/").text
    assert "data-ui=" not in page and '<aside class="sidebar">' in page
    assert 'action="/appearance"' not in page
    assert "studio-ui.css" not in page and 'class="ps-sidebar"' not in page
    for html in (client.get("/settings/models").text, studio(client).get("/settings/models").text):
        assert 'href="/settings/appearance"' in html
    for path in ("/", "/knowledge", "/preferences"):
        html = client.get(path).text
        assert 'action="/appearance"' not in html and "data-ps-theme-toggle" not in html
    settings = client.get("/settings/appearance").text
    assert 'name="ui" value="classic"' in settings and 'name="theme" value="dark"' in settings


def test_appearance_choice_is_a_cookie_and_never_changes_persona_data(client, work):
    revision = PersonaStore(work[0]).load().config.revision
    response = client.post("/appearance", data={"ui": "studio", "theme": "dark",
                                                "return_to": "/knowledge?view=list"},
                           follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"] == "/knowledge?view=list"
    cookies = response.headers.get_list("set-cookie")
    assert any(c.startswith("persona_ui=studio") for c in cookies)
    assert any(c.startswith("persona_theme=dark") for c in cookies)
    unsafe = client.post("/appearance", data={"ui": "bogus", "return_to": "//evil.example/"},
                         follow_redirects=False)
    assert unsafe.headers["location"] == "/" and not unsafe.headers.get_list("set-cookie")
    assert PersonaStore(work[0]).load().config.revision == revision


@pytest.mark.parametrize("path", PAGES)
def test_every_page_renders_in_both_interfaces(client, path):
    classic = client.get(path)
    assert classic.status_code == 200 and "data-ui=" not in classic.text
    page = studio(client).get(path)
    assert page.status_code == 200
    html = page.text
    assert '<html lang="zh-CN" data-ui="studio" data-theme="light">' in html
    assert 'class="ps-sidebar"' in html and 'class="ps-topbar"' in html
    assert '<aside class="sidebar">' not in html and 'class="mobile-header"' not in html
    assert json.loads(re.search(r'id="ps-palette-data">(.*?)</script>', html, re.S).group(1))["pages"]


def test_studio_shell_keeps_existing_hooks(client):
    html = studio(client).get("/knowledge").text
    assert 'data-inbox-pending' in html and 'meta name="persona-workspace"' in html
    assert 'class="ps-nav-item is-active" href="/knowledge" aria-current="page"' in html
    assert 'data-graph-data' in html and 'action="/appearance"' not in html
    home = client.get("/").text
    assert 'id="persona-home"' in home and 'class="ps-home"' in home
    assert 'class="persona-home"' not in home


def test_embedded_pages_render_content_without_shell(client):
    html = studio(client).get("/ai?embed=1").text
    assert 'class="evaluation-embedded"' in html and '<base target="_top">' in html
    assert 'class="ps-sidebar"' not in html and 'class="ps-topbar"' not in html
    assert 'id="ps-palette"' not in html and 'id="ai-message-form"' in html


def test_theme_cookie_is_validated(client):
    assert 'data-theme="dark"' in studio(client, "dark").get("/").text
    assert 'data-theme="light"' in studio(client, "neon").get("/").text


def test_palette_index_lists_titles_and_links_only(client, work):
    items = client.get("/api/studio-ui/v1/index").json()["items"]
    kinds = {item["kind"] for item in items}
    assert {"knowledge", "material"} <= kinds
    assert all(set(item) == {"kind", "title", "aliases", "url"} for item in items)
    assert all(item["url"].startswith("/") for item in items)


def test_remap_stylesheet_is_current():
    committed = (STATIC / "studio-ui" / "remap.css").read_text(encoding="utf-8")
    assert committed == build_remap(STATIC), "Run scripts/build_studio_remap.py"


def test_remap_maps_literals_to_tokens_and_keeps_precedence():
    rules = remap_rules(
        ":root { --ink: #17243a; font-size: 12px }"
        ".a { color: #6d7584; padding: 3px; background: #fff }"
        ".x .a { color: inherit }"
        "@media (max-width: 600px) { .b { border: 1px solid #e4e6ea } }"
        "@keyframes pulse { from { color: #fff } }",
        page_file=False,
    )
    assert rules[0] == 'html[data-ui="studio"] { --ink: var(--s-ink) }'
    assert rules[1] == 'html[data-ui="studio"] .a { color: var(--s-ink-3); background: var(--s-surface) }'
    assert rules[2] == 'html[data-ui="studio"] .x .a { color: inherit }'
    assert rules[3].startswith("@media (max-width: 600px)") and "var(--s-line)" in rules[3]
    assert len(rules) == 4
    assert remap_rules("a { color: red } .context :is(a, b) { color: #4967d8 }", page_file=True) == [
        'html[data-ui="studio"] .context :is(a, b) { color: var(--s-accent) }'
    ]
    assert prefix_selector("body.x") == 'html[data-ui="studio"] body.x'
    assert token_for(parse_color("rgba(73, 103, 216, .12)"), "bg") == (
        "color-mix(in srgb, var(--s-accent) 12%, transparent)"
    )
    assert token_for(parse_color("#fff"), "text") == "var(--s-on-accent)"
    assert token_for(parse_color("#fcece8"), "bg") == "var(--s-red-soft)"


def test_knowledge_graph_card_is_studio_only(client):
    classic = client.get("/knowledge").text
    assert "data-studio-node-card" not in classic and "data-studio-graph-details" not in classic
    page = studio(client).get("/knowledge").text
    assert "data-studio-node-card" in page and 'data-ps-level="proficient"' in page
    payload = json.loads(re.search(r"data-studio-graph-details>(.*?)</script>", page, re.S).group(1))
    graph = json.loads(re.search(r"data-graph-data>(.*?)</script>", page, re.S).group(1))
    assert set(payload["details"]) == {node["id"] for node in graph["nodes"]}
    assert all("summary" in item and "materials" in item for item in payload["details"].values())


def test_preferences_list_scenes_in_a_column_only_in_studio(client):
    assert "pw-context-label" not in client.get("/preferences").text
    assert 'class="pw-context-label"' in studio(client).get("/preferences").text


def test_quick_approval_returns_to_overview(client, work):
    from ai_persona.proposals import ProposalRepository, ProposalService

    proposal = ProposalService(*work).create_record(
        "knowledge_node",
        {"title": "Quick approval topic", "semantic_role": "concept", "interest_level": "high"},
        reason="test", submitted_by="ai", confidence=0.8,
    )
    home = studio(client).get("/").text
    assert f'action="/review/{proposal.id}/accept"' in home
    response = client.post(f"/review/{proposal.id}/accept", data={"return_to": "/"},
                           follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"].startswith("/?message=")
    assert ProposalRepository(work[0]).get(proposal.id).status == "accepted"
    assert "Quick approval topic" not in client.get("/").text.split('id="ps-changes-title"')[0]


def test_demo_settings_keep_navigation_in_studio(tmp_path, monkeypatch):
    from ai_persona.demo import prepare_demo

    monkeypatch.setenv("AI_PERSONA_DEMO_HOME", str(tmp_path / "demo"))
    root = prepare_demo()
    demo = TestClient(create_app(root / "persona-data", root / "persona-state"))
    classic = demo.get("/settings?tab=sources").text
    assert "demo-settings-badge" not in classic and "settings-tabs" not in classic
    page = studio(demo).get("/settings?tab=capabilities").text
    assert "demo-settings-badge" in page and 'class="studio-tabs settings-tabs"' in page
    assert 'data-settings-tab="capabilities" data-settings-location="capabilities" aria-current="page"' in page
