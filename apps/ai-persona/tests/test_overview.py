"""Home page uses real records, without model calls or mutation on page load."""
import json

from test_evaluations import work as work
from test_inbox import inbox as inbox
from test_studio import studio as studio

from ai_persona.human_edits import HumanEditService
from ai_persona.models import KnowledgeNode, Material, Preference
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore


def test_home_counts_are_separate_and_links_resolve(studio):
    _, client, model, _, evaluations = studio
    store = PersonaStore(evaluations.data_root).load()
    before = store.config.revision
    response = client.get('/')
    assert response.status_code == 200
    counts = response.context['active_counts']
    assert counts['knowledge_node'] == len(store.of_type(KnowledgeNode, active_only=True))
    assert counts['material'] == len(store.of_type(Material, active_only=True))
    assert counts.get('preference', 0) == len(store.of_type(Preference, active_only=True))
    assert response.text.count('href="/ai"') == 1
    assert 'home-clear' in response.text and 'class="home-review-notice"' not in response.text
    for path in ('/knowledge', '/preferences', '/materials', '/courses'):
        assert client.get(path).status_code == 200
    assert not model.calls and not evaluations.cases()
    assert PersonaStore(evaluations.data_root).load().config.revision == before


def test_home_pending_is_counted_but_not_in_assets_or_recent_changes(studio):
    _, client, _, _, evaluations = studio
    before = client.get('/').context['active_counts']
    ProposalService(evaluations.data_root, evaluations.state_root).create_record(
        'knowledge_node', {'title': 'Pending only', 'interest_level': 'unspecified', 'semantic_role': 'concept'}, submitted_by='ai', reason='Private raw prompt',
    )
    response = client.get('/')
    assert response.context['pending_count'] == 1
    assert response.context['active_counts'] == before
    assert '1 条候选，等你确认' in response.text and '1 条知识点' in response.text
    assert 'Pending only' not in response.text and 'Private raw prompt' not in response.text
    assert 'class="home-clear"' not in response.text


def test_home_recent_changes_use_content_titles_and_final_human_edits(studio):
    _, client, model, _, evaluations = studio
    data, state = evaluations.data_root, evaluations.state_root
    publisher = HumanEditService(data, state)
    for index in range(5):
        publisher.create_record('knowledge_node', {'title': f'Confirmed topic {index}', 'summary': f'Summary {index}', 'interest_level': 'unspecified', 'semantic_role': 'concept'})
    response = client.get('/')
    changes = response.context['recent_changes']
    assert [c['title'] for c in changes[:5]] == [f'Confirmed topic {i}' for i in reversed(range(5))]
    for change in changes:
        assert client.get(change['url']).status_code == 200
    assert 'home-expand-changes' in response.text
    assert 'home-extra-changes' in response.text
    assert changes[0]['summary'] == 'Summary 4'
    assert 'Revision ' not in response.text.split('id="persona-home"')[1]
    assert not model.calls


def test_home_missing_history_and_archived_record_have_safe_fallbacks(studio):
    _, client, _, _, evaluations = studio
    data, state = evaluations.data_root, evaluations.state_root
    publisher = HumanEditService(data, state)
    saved = publisher.create_record('knowledge_node', {'title': 'Archived topic', 'interest_level': 'unspecified', 'semantic_role': 'concept'})
    publisher.create_archive(saved.target_id)
    changes = client.get('/').context['recent_changes']
    assert changes[0]['url'].startswith('/inbox?')
    assert client.get(changes[0]['url']).status_code == 200
    repository = ProposalRepository(data)
    # Disposable fixture: missing history must not make the home page fail.
    (repository.history_root / f'{saved.id}.json').unlink()
    assert client.get('/').status_code == 200


def test_home_uses_reviewed_answer_not_original_ai_candidate(studio):
    _, client, model, _, evaluations = studio
    publisher = ProposalService(evaluations.data_root, evaluations.state_root)
    candidate = publisher.create_record('knowledge_node', {
        'title': 'Original AI title', 'summary': 'Original AI summary',
        'interest_level': 'unspecified', 'semantic_role': 'concept',
    }, submitted_by='ai', reason='Private instruction, not a change summary')
    publisher.accept(candidate.id, review_updates={
        'title': 'Human confirmed title', 'summary': 'Human corrected summary',
    })
    page = client.get('/')
    latest = page.context['recent_changes'][0]
    assert latest['title'] == 'Human confirmed title'
    assert latest['summary'] == 'Human corrected summary'
    assert 'Original AI' not in page.text and 'Private instruction' not in page.text
    assert not model.calls


def test_home_health_distinguishes_current_worker_from_historical_failure(inbox, monkeypatch):
    service, _, result, model, client = inbox
    monkeypatch.setattr('ai_persona.studio_web.worker_status', lambda _: {'running': False})
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='failed', error_code='timeout' WHERE id=?", (result['task_ref'],))
    health = client.get('/api/studio/v1/health').json()
    assert health['failure_count'] == 1 and health['waiting_for_worker'] == 0
    assert health['learning']['worker_running'] is False
    with service.learning.repository.transaction() as db:
        db.execute("UPDATE events SET status='queued' WHERE id=?", (result['task_ref'],))
    health = client.get('/api/studio/v1/health').json()
    assert health['waiting_for_worker'] == 1 and health['learning']['queued_count'] == 1
    assert len(model.calls) == 2
    assert json.loads(json.dumps(health))['learning']['enabled'] is True
