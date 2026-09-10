"""UI contracts on disposable data; never use real account/model calls."""
import copy

import pytest
from fastapi.testclient import TestClient
from test_evaluations import Model, activation_trace, click
from test_evaluations import work as work

from ai_persona.conversation_learning.service import ConversationLearningService
from ai_persona.evaluations.contracts import EvaluationError
from ai_persona.evaluations.runner import EvaluationRunner, resolve_selection
from ai_persona.evaluations.store import EvaluationStore
from ai_persona.preference_application.repository import ApplicationRepository, ApplicationSettings
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def studio(work):
    app = create_app(*work)
    model = Model()
    app.state.ai_service.model = model
    learning = ConversationLearningService(*work)
    app.state.learning_service = learning
    return app, TestClient(app), model, learning, EvaluationStore(*work)


def test_settings_and_trial_pages_only_read_existing_configuration(studio):
    app, client, model, learning, evaluations = studio
    settings = learning.repository.settings().model_dump()
    applications = ApplicationRepository(evaluations.state_root)
    applications.save_settings(ApplicationSettings(timeout_seconds=11.0))
    revision = PersonaStore(evaluations.data_root).load().config.revision
    for path in ['/settings', '/settings?tab=capabilities', '/settings?tab=retention', '/settings/models', '/preferences/try', '/evaluations?embedded=1']:
        assert client.get(path).status_code == 200
    assert client.get('/settings', follow_redirects=False).headers['location'] == '/settings/models'
    settings_page = client.get('/settings?tab=sources').text
    assert 'id="learning-connection"' in settings_page and 'id="pa-settings-form"' in settings_page
    assert 'id="learning-events"' not in settings_page and 'evaluation-run-form' not in settings_page
    assert 'id="activation-form"' not in client.get('/ai').text
    assert '/preferences/try' in client.get('/preferences').text
    assert learning.repository.settings().model_dump() == settings
    assert applications.settings().timeout_seconds == 11
    assert PersonaStore(evaluations.data_root).load().config.revision == revision
    assert not model.calls and not evaluations.cases() and app.state.evaluations._runner is None
    assert client.get('/settings', headers={'Origin':'https://elsewhere.invalid'}).status_code == 403


def test_evaluations_have_three_views_and_guided_checks(studio):
    _, client, _, _, _ = studio
    page = client.get('/evaluations').text
    for view in ['cases','run','reports']:
        assert f'id="evaluation-{view}-panel"' in page
    js = client.get('/static/evaluations.js').text
    assert '最近结果' not in page
    assert 'await render(' not in js and '/withdraw' not in js
    assert '修改原反馈／取消反馈' in js
    assert 'expected_plan' in js and '固定版本、模型与预算' in js
    assert '/inbox?view=feedback' in page


def test_reference_reasons_are_separate_and_retained_case_has_canonical_link(studio):
    _, client, model, _, store = studio
    result = activation_trace(store)
    case = click(store,result,'unsatisfied','只供改进参考的理由')
    before = store.projection(case['case_id'])
    values = client.get('/api/evaluations/v1/references?capability_id=persona.activation').json()['items']
    assert values[0]['reason'] == '只供改进参考的理由'
    detail = client.get('/api/evaluations/v1/cases/'+case['case_id']).json()
    assert detail['result']['display_input'] == '写一份 note'
    assert store.projection(case['case_id']) == before
    store.withdraw(case['case_id'],None,case['feedback']['revision'])
    assert client.get('/api/evaluations/v1/references?capability_id=persona.activation').json()['items'] == []
    assert client.get('/api/inbox/v1/items/result:'+result['id']).status_code == 200
    assert not model.calls


def test_preview_and_runner_share_exact_model_selection(studio):
    app, client, model, _, store = studio
    original = model.request('config')
    config = copy.deepcopy(original)
    config['settings']['overrides'] = {'activation':'fake'}
    config['settings']['overrideModelIds'] = {'activation':'chosen-model'}
    model.request = lambda route, raw=None: config if route == 'config' else (_ for _ in ()).throw(AssertionError('No generation'))
    preview = client.get('/api/evaluations/v1/selection?mode=activation').json()
    assert preview['selection']['modelId'] == 'chosen-model'
    assert resolve_selection(config,'activation',{})[0] == preview['selection']
    result = activation_trace(store)
    case = click(store,result)
    suite = store.save_suite('test',[{'case_id':case['case_id'],'benchmark_revision':case['benchmark_revision']}])
    runner = EvaluationRunner(store,model)
    try:
        with pytest.raises(EvaluationError,match='重新确认'):
            runner.start({'suite_id':suite['id'],'mode':'activation','confirmed_model_calls':True,'expected_selection':{**preview['selection'],'revision':'old'}})
        assert not store.documents('runs') and not model.calls
    finally:
        runner.close()
    assert app.state.evaluations._runner is None


def test_settings_remember_only_known_tabs_and_keep_explicit_links(studio):
    _, client, _, _, _ = studio
    client.cookies.set('persona-settings-tab', 'retention')
    assert client.get('/settings', follow_redirects=False).headers['location'] == '/settings?tab=retention'
    assert 'id="learning-settings"' in client.get('/settings?tab=capabilities').text
    client.cookies.set('persona-settings-tab', 'https://example.org')
    assert client.get('/settings', follow_redirects=False).headers['location'] == '/settings/models'
    assert client.get('/settings?tab=invalid', follow_redirects=False).headers['location'] == '/settings/models'
    page = client.get('/settings/models').text
    positions = [page.index('data-settings-location="'+tab+'"') for tab in ['models', 'sources', 'capabilities', 'retention']]
    assert positions == sorted(positions)
