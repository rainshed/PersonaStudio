from __future__ import annotations

import json
import re

import pytest
from test_review_usability import workspace as workspace

from ai_persona.knowledge_graph import knowledge_graph_data
from ai_persona.models import KnowledgeNode, Relation
from ai_persona.store import PersonaStore


def graph_payload(html):
    return json.loads(re.search(
        r'<script type="application/json" data-graph-data>(.*?)</script>', html, re.S,
    ).group(1))


@pytest.mark.parametrize('locale', ['zh-CN', 'en'])
def test_map_uses_all_active_records_and_existing_detail_routes(workspace, locale):
    data, _, client = workspace
    client.cookies.set('ai_persona_locale', locale)
    page = client.get('/knowledge?q=not-a-concept&knowledge_level=aware')
    assert page.status_code == 200
    graph = graph_payload(page.text)
    store = PersonaStore(data).load()
    ids = {n.id for n in store.of_type(KnowledgeNode, active_only=True)}
    assert {n['id'] for n in graph['nodes']} == ids
    expected = {r.id for r in store.of_type(Relation, active_only=True)
                if r.source_id in ids and r.target_id in ids}
    assert {r['id'] for r in graph['edges']} == expected
    for node in graph['nodes']:
        assert node['href'] == f"/knowledge/{node['id']}"
        detail = client.get(node['href'])
        assert detail.status_code == 200
        assert node['title'] in detail.text
    assert 'id="knowledge-list"' in page.text
    assert 'data-knowledge-view="graph"' in page.text
    assert 'class="knowledge-fallback-link"' in page.text
    assert 'knowledge_map.' not in page.text
    assert ('Two-sided tree' if locale == 'en' else '双向树') in page.text
    for relation in ['broader_than', 'requires', 'applied_in', 'related_to']:
        assert f'data-relation-key="{relation}"' in page.text
    assert 'id="relations"' not in page.text  # All relationship types are displayed.
    assert 'id="map-arrow-related_to"' not in page.text  # An association has no direction.


def test_graph_json_escapes_titles_and_preserves_user_content(workspace):
    data, service, client = workspace
    title = '</script><script>alert("unsafe")</script> & Quantum'
    change = service.create_update('kn_demo_tebd', {'title': title})
    service.accept(change.id)
    page = client.get('/knowledge')
    assert title not in page.text
    graph = graph_payload(page.text)
    assert next(n for n in graph['nodes'] if n['id'] == 'kn_demo_tebd')['title'] == title
    assert graph == knowledge_graph_data(PersonaStore(data).load())


def test_empty_graph_keeps_add_and_list_views(workspace, monkeypatch):
    _, _, client = workspace
    monkeypatch.setattr('ai_persona.web.knowledge_graph_data', lambda _: {'nodes': [], 'edges': []})
    page = client.get('/knowledge')
    assert page.status_code == 200
    assert 'graph-empty' in page.text
    assert 'href="/knowledge/new"' in page.text
    assert 'id="knowledge-list"' in page.text
    assert 'id="map"' not in page.text


def test_layout_assets_are_packaged_and_served_locally(workspace):
    _, _, client = workspace
    for path in ['knowledge-map.css', 'knowledge-graph.js', 'knowledge-map/layout-core.js',
                 'knowledge-map/layout-worker.js', 'knowledge-map/vendor/elk-api.js',
                 'knowledge-map/vendor/elk-worker.min.js', 'knowledge-map/vendor/d3.min.js',
                 'knowledge-map/vendor/ELK-LICENSE.md', 'knowledge-map/vendor/D3-LICENSE']:
        response = client.get('/static/' + path)
        assert response.status_code == 200, path
        assert response.content
