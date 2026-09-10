"""Model choices participate in cache identity independently of account credentials."""

from copy import deepcopy

from ai_persona.model_bridge import ModelClient


def test_model_switch_invalidates_only_affected_tasks_and_fallback(tmp_path, monkeypatch):
    settings = {
        "connections": [
            {
                "id": "account",
                "revision": "unchanged-auth-revision",
                "providerId": "custom",
                "modelId": "legacy-model",
                "authType": "api_key",
                "baseUrl": "http://localhost/v1",
                "api": "openai-completions",
                "contextWindow": 32000,
                "maxTokens": 8192,
            }
        ],
        "defaultConnectionId": "account",
        "overrides": {"material": "account"},
        "fallback": {"enabled": False, "connectionId": None},
    }
    client = ModelClient(tmp_path)
    monkeypatch.setattr(client, "request", lambda *_: {"settings": deepcopy(settings)})
    legacy = client.configuration_signature("material")
    settings["defaultModelId"] = "legacy-model"
    settings["overrideModelIds"] = {"material": "legacy-model"}
    assert client.configuration_signature("material") == legacy
    settings["defaultModelId"] = "fast-model"
    fast = client.configuration_signature("activation")
    assert fast != legacy
    assert client.configuration_signature("material") == legacy
    settings["overrideModelIds"]["material"] = "large-model"
    large = client.configuration_signature("material")
    assert large != legacy
    assert client.configuration_signature("activation") == fast
    settings["connections"][0].update(status="ready", checkedAt="now")
    assert client.configuration_signature("material") == large
    settings["fallback"] = {"enabled": True, "connectionId": "account", "modelId": "backup-one"}
    backup = client.configuration_signature("material")
    settings["fallback"]["modelId"] = "backup-two"
    assert client.configuration_signature("material") != backup
    settings["fallback"]["enabled"] = False
    assert client.configuration_signature("material") == large
    settings["overrides"]["material"] = None
    assert client.configuration_signature("material") == fast


def test_grouped_signatures_and_evaluation_match_effective_models(tmp_path, monkeypatch):
    from ai_persona.evaluations.runner import resolve_selection

    settings = {
        'routingVersion': 2,
        'connections': [{'id': 'account', 'revision': 'stable', 'modelId': 'default', 'providerId': 'custom'}],
        'defaultConnectionId': 'account', 'defaultModelId': 'default',
        'overrides': {'maintenance': 'account', 'conversation_learning': 'account', 'material': 'account', 'conversation_signal': 'account'},
        'overrideModelIds': {'maintenance': 'research', 'conversation_learning': 'learning', 'material': 'dormant', 'conversation_signal': 'dormant'},
        'fallback': {'enabled': False, 'connectionId': None},
    }
    config = {'settings': settings, 'capabilities': {'promptExperiments': 1}}
    client = ModelClient(tmp_path)
    monkeypatch.setattr(client, 'request', lambda *_: deepcopy(config))
    assert client.configuration_signature('material') == client.configuration_signature('maintenance')
    assert client.configuration_signature('conversation_signal') == client.configuration_signature('conversation_candidate')
    before = client.configuration_signature('conversation_signal')
    settings['overrideModelIds']['conversation_signal'] = 'ignored'
    assert client.configuration_signature('conversation_signal') == before
    settings['overrideModelIds']['conversation_learning'] = 'new-learning'
    assert client.configuration_signature('conversation_signal') != before
    for mode in ['learning_content', 'learning_signal']:
        assert resolve_selection(config, mode, {})[0]['modelId'] == 'new-learning'
    settings['connections'][0]['imageModelIds'] = ['research']
    assert client.configuration_signature('material') == client.configuration_signature('maintenance')


def test_separate_learning_models_invalidate_only_the_changed_stage(tmp_path, monkeypatch):
    from ai_persona.evaluations.runner import resolve_selection

    settings = {
        'routingVersion': 3,
        'connections': [{'id': 'account', 'revision': 'stable', 'modelId': 'default', 'providerId': 'custom'}],
        'defaultConnectionId': 'account', 'defaultModelId': 'default',
        'overrides': {'conversation_learning': 'account', 'conversation_signal': 'account', 'conversation_candidate': 'account'},
        'overrideModelIds': {'conversation_learning': 'careful', 'conversation_signal': 'fast', 'conversation_candidate': 'dormant'},
        'fallback': {'enabled': False, 'connectionId': None},
    }
    config = {'settings': settings, 'capabilities': {'promptExperiments': 1}}
    client = ModelClient(tmp_path)
    monkeypatch.setattr(client, 'request', lambda *_: deepcopy(config))
    generation = client.configuration_signature('conversation_candidate')
    detection = client.configuration_signature('conversation_signal')
    assert generation != detection
    settings['overrideModelIds']['conversation_learning'] = 'new-careful'
    assert client.configuration_signature('conversation_candidate') != generation
    assert client.configuration_signature('conversation_signal') == detection
    assert resolve_selection(config, 'learning_content', {})[0]['modelId'] == 'new-careful'
    assert resolve_selection(config, 'learning_signal', {})[0]['modelId'] == 'fast'
    generation = client.configuration_signature('conversation_candidate')
    settings['overrides']['conversation_signal'] = None
    assert resolve_selection(config, 'learning_signal', {})[0]['modelId'] == 'default'
    assert client.configuration_signature('conversation_candidate') == generation
