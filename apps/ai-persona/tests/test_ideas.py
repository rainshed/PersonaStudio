import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from ai_persona import ideas
from ai_persona.agent import AgentServiceError, PersonaQueryService
from ai_persona.ai_service import PersonaAIService
from ai_persona.backup import backup_workspace, restore_workspace
from ai_persona.compiler import PersonaCompiler
from ai_persona.editor_drafts import EditorDrafts
from ai_persona.ideas import IdeaService, payload
from ai_persona.initialization import initialize_persona
from ai_persona.models import Idea, IdeaResource
from ai_persona.query_service import KnowledgeQueryService
from ai_persona.query_sources import SourceReader
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv('AI_PERSONA_LEARNING_DIR', str(tmp_path / 'learning'))
    monkeypatch.setenv('AI_PERSONA_CONFIG', str(tmp_path / 'settings.toml'))
    root = tmp_path / 'workspace'
    initialize_persona(root / 'persona-data', root / 'persona-state', persona_id='ideas-test')
    return IdeaService(root / 'persona-data', root / 'persona-state')


def create(service, **values):
    return service.save('idea_test', 0, {'title': 'A research idea', **values})['item']


@pytest.mark.parametrize('outcome', ['success', 'partial', 'abandoned'])
def test_endings_atomic_and_reopen_preserves_complete_history(service, outcome):
    create(service, body='# hypothesis', novelty_reason='Reason without a rating',
           difficulty_reason='Depends on data')
    with pytest.raises(AgentServiceError):
        service.save('idea_test', 1, {'execution_status': 'ended',
                                    'closure': {'outcome': outcome, 'summary': '  \n '},
                                    'body': 'should not save'})
    assert service.get('idea_test').body == '# hypothesis'
    assert len(service.history('idea_test')) == 1
    ended = service.save('idea_test', 1, {'execution_status': 'ended',
          'closure': {'outcome': outcome, 'summary': ' Results '}, 'body': '# revised'})['item']
    assert ended['closure']['summary'] == 'Results'
    reopened = service.save('idea_test', 2, {'execution_status': 'in_progress'})['item']
    assert reopened['closure'] is None
    assert reopened['body'] == '# revised'
    assert reopened['novelty_reason'] == 'Reason without a rating'
    history = service.history('idea_test')
    assert [r['revision'] for r in history] == [3, 2, 1]
    assert history[1]['closure']['outcome'] == outcome
    assert history[-1]['body'] == '# hypothesis'
    assert 'Results' not in service.context('idea_test')
    with pytest.raises(AgentServiceError):
        service.save('idea_test', 3, {'execution_status': 'ended'})


def test_noop_stable_id_and_independent_reasons_archive(service):
    item = create(service, novelty='novel', novelty_reason='Keep this')
    before = service.get('idea_test').path.read_bytes()
    assert not service.save('idea_test', 1, {'title': ' A research idea '})['changed']
    assert before == service.get('idea_test').path.read_bytes()
    changed = service.save('idea_test', 1, {'title': 'Rename', 'novelty': 'unknown',
                                         'status': 'archived'})['item']
    assert changed['novelty_reason'] == 'Keep this' and changed['id'] == item['id']
    assert changed['execution_status'] == 'not_started'
    service.save('idea_test', 2, {'status': 'active'})
    assert len(service.history('idea_test')) == 3


def test_concurrent_saves_cannot_overwrite(service):
    create(service)
    def save(body):
        try:
            service.save('idea_test', 1, {'body': body})
            return 'ok'
        except AgentServiceError as exc:
            return exc.code
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(save, ['first', 'second'])) == ['conflict', 'ok']
    assert service.get('idea_test').record.revision == 2
    assert len(service.history('idea_test')) == 2


@pytest.mark.parametrize('point', ['snapshot', 'canonical'])
def test_write_failure_preserves_record_and_visible_history(service, monkeypatch, point):
    create(service)
    before = payload(service.get('idea_test'))
    write = ideas._atomic_write
    def fail(path, content):
        if (point == 'snapshot' and path.name == '00000002.md') or (
                point == 'canonical' and path.name == 'idea_test.md'):
            raise OSError('disk full')
        write(path, content)
    monkeypatch.setattr(ideas, '_atomic_write', fail)
    with pytest.raises(OSError):
        service.save('idea_test', 1, {'title': 'Must not publish', 'execution_status': 'ended',
                                   'closure': {'outcome': 'partial', 'summary': 'Half worked'}})
    assert payload(service.get('idea_test')) == before
    assert len(service.history('idea_test')) == 1


def test_interrupted_uncommitted_snapshot_not_visible(service):
    create(service)
    history = service.data / 'revisions/ideas/idea_test'
    (history / '00000002.md').write_text('interrupted snapshot')
    assert len(service.history('idea_test')) == 1
    service.save('idea_test', 1, {'body': 'recover on the next save'})
    assert service.history('idea_test')[0]['body'] == 'recover on the next save'


def test_resources_missing_files_and_historical_references(service):
    resource = service.upload('../notes.html', b'<script>alert(1)</script>', 'text/html')
    create(service, resources=[resource])
    path, name = service.file(resource['source_ref'], resource['file_path'])
    assert name == 'notes.html' and path.is_relative_to(service.data / 'sources')
    service.save('idea_test', 1, {'resources': []})
    assert service.history('idea_test')[1]['resources'][0]['source_ref'] == resource['source_ref']
    assert path.exists()
    path.unlink()
    PersonaCompiler(service.data, service.state).build()
    assert service.get('idea_test').record.title == 'A research idea'
    with pytest.raises(AgentServiceError, match='文件缺失'):
        service.file(resource['source_ref'], resource['file_path'])
    service.save('idea_test', 2, {'body': 'Still editable'})


def test_private_notes_never_enter_automatic_queries_or_context(service):
    resource = service.upload('private.txt', b'private-source-canary', 'text/plain')
    create(service, title='private-title-canary', body='private-body-canary', resources=[resource])
    PersonaCompiler(service.data, service.state).build()
    generated = '\n'.join(p.read_text() for p in (service.data / 'generated').rglob('*') if p.is_file())
    assert 'private-title-canary' not in generated and 'private-body-canary' not in generated
    store = PersonaStore(service.data).load()
    query = PersonaQueryService(service.data, service.state)
    with pytest.raises(AgentServiceError):
        query.get_persona_record(record_id='idea_test')
    modern = KnowledgeQueryService(service.data, service.state)
    result = modern.get_persona_records(record_ids=['idea_test'])
    assert 'private-body-canary' not in result.model_dump_json()
    reader = SourceReader(store, service.state, {resource['source_ref']})
    with pytest.raises(AgentServiceError):
        reader.manifest(resource['source_ref'])
    ai = PersonaAIService(service.data, service.state)
    with pytest.raises(AgentServiceError):
        ai.create_session(record_id='idea_test')
    assert not any(r['id'] == 'idea_test' for r in ai._catalog({'material_id': ''}, store))
    with pytest.raises(AgentServiceError):
        ai._full_record(store, 'idea_test')
    service.save('idea_test', 1, {'resources': []})
    with pytest.raises(AgentServiceError):
        SourceReader(service.store(), service.state, {resource['source_ref']}).manifest(resource['source_ref'])
    config = service.data / 'config/persona.toml'
    config.write_text(config.read_text().replace('include_human_notes_in_snapshot = true',
                                               'include_human_notes_in_snapshot = false'))
    assert 'private-body-canary' in service.context('idea_test')


@pytest.mark.parametrize('values', [
    {'kind': 'link', 'url': 'javascript:alert(1)'},
    {'kind': 'file', 'source_ref': 'src_a', 'file_path': '../secret'},
    {'kind': 'file', 'source_ref': 'src_a', 'file_path': '/tmp/secret'},
    {'kind': 'link', 'url': 'file:///etc/passwd'},
])
def test_unsafe_resource_references_rejected(values):
    with pytest.raises(ValidationError):
        IdeaResource(id='res_test', **values)


def test_backend_invariants_cannot_be_bypassed(service):
    item = create(service)
    with pytest.raises(ValidationError):
        Idea.model_validate({k: v for k, v in {**item, 'execution_status': 'paused'}.items() if k != 'body'})
    for change in [{'execution_status': 'ended'}, {'title': '  '},
                   {'closure': {'outcome': 'success', 'summary': 'Unexpected'}}]:
        with pytest.raises(AgentServiceError):
            service.save('idea_test', 1, change)
    with pytest.raises(AgentServiceError):
        service.save('idea_../../outside', 0, {'title': 'invalid'})


def test_web_validation_filters_download_and_source_boundary(service):
    resource = service.upload('unsafe.html', b'<script>test</script>', 'text/html')
    create(service, novelty_reason='unique reason', resources=[resource])
    with TestClient(create_app(service.data, service.state)) as client:
        for url in ['/ideas/new', '/ideas', '/ideas/idea_test']:
            assert client.get(url).status_code == 200
        assert 'A research idea' in client.get('/ideas?q=unique+reason').text
        assert 'A research idea' not in client.get('/ideas?execution_status=ended').text
        assert 'A research idea' in client.get('/ideas?execution_status=ended&execution_status=not_started').text
        result = client.post('/api/ideas/idea_test', headers={'X-AI-Persona': '1'}, json={
            'expected_revision': 0, 'values': {'title': 'Overwrite'}})
        assert result.status_code == 409
        assert client.post('/api/ideas/idea_test', json={}).status_code == 403
        assert client.post('/api/ideas/upload?filename=bad', content=b'bad').status_code == 403
        response = client.get('/api/ideas/file', params={
            'source_ref': resource['source_ref'], 'file_path': resource['file_path']})
        assert response.headers['content-disposition'].startswith('attachment')
        assert response.headers['content-type'] == 'application/octet-stream'
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert client.get('/api/ideas/file', params={
            'source_ref': resource['source_ref'], 'file_path': '../manifest.yaml'}).status_code == 404


def test_backup_restores_full_note_revisions_files_and_drafts(service, tmp_path):
    resource = service.upload('note.txt', b'file bytes', 'text/plain')
    create(service, body='v1', resources=[resource], novelty_reason='because')
    service.save('idea_test', 1, {'body': 'v2', 'resources': []})
    drafts = EditorDrafts(service.state)
    drafts.save({'id': str(uuid.uuid4()), 'page': '/ideas/idea_test', 'revision': 0,
                 'baseline': '2', 'fields': {'body': ['draft text'], 'ending_summary': ['pending ending']}})
    PersonaCompiler(service.data, service.state).build()
    assert len(drafts.list('/ideas/idea_test')) == 1
    archive, restored = tmp_path / 'backup.tar.gz', tmp_path / 'restored'
    backup_workspace(service.data.parent, archive)
    restore_workspace(archive, restored)
    other = IdeaService(restored / 'persona-data', restored / 'persona-state')
    assert payload(other.get('idea_test')) == payload(service.get('idea_test'))
    assert other.history('idea_test') == service.history('idea_test')
    assert other.file(resource['source_ref'], resource['file_path'])[0].read_bytes() == b'file bytes'
    assert EditorDrafts(other.state).list('/ideas/idea_test')[0]['fields']['ending_summary'] == ['pending ending']


def test_content_reset_preview_counts_ideas_and_protects_stale_preview(service):
    from ai_persona.content_reset import ContentReset
    create(service)
    reset = ContentReset(service.data, service.state)
    plan = reset.plan()
    assert plan['counts']['idea'] == 1
    assert 'idea_test' in plan['record_ids']
    service.save('idea_test', 1, {'body': 'changed after preview'})
    assert reset.plan()['token'] != plan['token']
