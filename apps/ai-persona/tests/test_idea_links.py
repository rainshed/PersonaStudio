"""Relationships must retain the v1 record contract and original Idea workflows."""
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_persona.agent import AgentServiceError
from ai_persona.compiler import PersonaCompiler
from ai_persona.frontmatter import dump_markdown_record, load_markdown_record
from ai_persona.idea_links import linked_payload
from ai_persona.ideas import IdeaService, payload
from ai_persona.library_references import library_items
from ai_persona.models import Idea
from ai_persona.web import create_app


@pytest.fixture
def linked_service(tmp_path, monkeypatch):
    data, state = tmp_path / 'data', tmp_path / 'state'
    shutil.copytree(Path(__file__).parent / 'fixtures/legacy-demo/persona-data', data)
    monkeypatch.setenv('AI_PERSONA_LEARNING_DIR', str(tmp_path / 'learning'))
    monkeypatch.setenv('AI_PERSONA_CONFIG', str(tmp_path / 'config.toml'))
    PersonaCompiler(data, state).build()
    return IdeaService(data, state)


def test_links_share_revision_and_keep_v1_attachments(linked_service):
    s = linked_service
    ref = library_items(s.store(), 'http://localhost')[0]
    attachment = s.upload('evidence.txt', b'Fixture evidence', 'text/plain')
    result = s.save('idea_linked', 0, {'title': 'Existing idea', 'body': 'Original note',
        'resources': [attachment], 'related_refs': [ref['id'], ref['id']],
        'project': {'id': 'p_test', 'title': 'Project A'}, 'novelty_reason': 'Keep the original reason'})
    loaded = s.get('idea_linked')
    raw, body = load_markdown_record(loaded.path)
    Idea.model_validate(raw)  # No extra fields, readable by old strict v1 clients.
    assert body == 'Original note'
    assert len(raw['resources']) == 3
    item = linked_payload(result['item'])
    assert item['related_refs'] == [ref['id']]
    assert item['project'] == {'id': 'p_test', 'title': 'Project A'}
    assert item['resources'][0] == attachment
    assert not s.save('idea_linked', 1, {'related_refs': [ref['id']], 'project': item['project']})['changed']
    s.save('idea_linked', 1, {'project': None, 'related_refs': []})
    assert s.get('idea_linked').record.resources == [loaded.record.resources[0]]
    history = s.history('idea_linked')
    assert linked_payload(history[1])['project']['id'] == 'p_test'
    assert history[0]['novelty_reason'] == 'Keep the original reason'
    with pytest.raises(AgentServiceError, match='别处更新'):
        s.save('idea_linked', 1, {'project': {'id': 'p_other', 'title': 'Conflict'}})


def test_archived_renamed_missing_and_foreign_references(linked_service):
    s = linked_service
    source = library_items(s.store(), 'http://localhost')[0]
    original = s.store().records[source['record_id']]
    record, body = load_markdown_record(original.path)
    record['id'] = 'kn_idea_link_fixture'
    path = original.path.with_name('idea-link-fixture.md')
    path.write_text(dump_markdown_record(record, body))
    ref = next(i for i in library_items(s.store(), 'http://localhost') if i['record_id'] == record['id'])
    s.save('idea_linked', 0, {'title': 'References', 'related_refs': [ref['id']]})
    loaded = s.store().records[ref['record_id']]
    record, body = load_markdown_record(loaded.path)
    record['title'] = 'New title'
    record['status'] = 'archived'
    loaded.path.write_text(dump_markdown_record(record, body))
    assert any(i['id'] == ref['id'] and i['title'] == 'New title' for i in library_items(s.store(), 'http://localhost'))
    assert not s.save('idea_linked', 1, {'related_refs': [ref['id']]})['changed']
    with pytest.raises(AgentServiceError):
        s.save('idea_new', 0, {'title': 'No archived additions', 'related_refs': [ref['id']]})
    for refs in [['ps_'+'a'*16+'_'+'b'*32], ['kn_fake'], 'wrong', [None]]:
        with pytest.raises(AgentServiceError):
            s.save('idea_new', 0, {'title': 'Invalid', 'related_refs': refs})
    # Missing targets in old resources remain editable; unrelated field edits cannot erase them.
    old = payload(s.get('idea_linked'))['resources']
    loaded.path.unlink()
    s.save('idea_linked', 1, {'body': 'Keep older references'})
    assert payload(s.get('idea_linked'))['resources'] == old


def test_native_routes_filter_projects_and_use_shared_catalog(linked_service):
    s = linked_service
    with TestClient(create_app(s.data, s.state)) as c:
        catalog = c.get('/api/ideas/library').json()
        ref = catalog['items'][0]
        assert c.get('/api/ideas/library/'+ref['id']).json()['record_id'] == ref['record_id']
        assert c.get('/api/ideas/library/missing').status_code == 404
        response = c.post('/api/ideas/idea_web', headers={'X-AI-Persona': '1'}, json={
            'expected_revision': 0, 'values': {'title': 'Linked HTTP idea', 'related_refs': [ref['id']],
                'project': {'id': 'p_fixture', 'title': 'Fixture project'}}})
        assert response.status_code == 200, response.text
        item = response.json()['item']
        assert item['related_refs'] == [ref['id']]
        assert c.get('/api/ideas').json()['items'][0]['project']['id'] == 'p_fixture'
        assert 'Linked HTTP idea' in c.get('/ideas?project=p_fixture').text
        assert 'Linked HTTP idea' not in c.get('/ideas?project=independent').text
        page = c.get('/ideas/idea_web').text
        for control in ['idea-project-select', 'idea-related', 'idea-history', 'idea-context', 'idea-file', 'idea-edit-ending']:
            assert f'id="{control}"' in page
        assert c.get('/api/ideas/library', headers={'Origin': 'https://evil.example'}).status_code == 403
