from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from ai_persona import model_setup
from ai_persona.initialization import initialize_persona
from ai_persona.web import create_app


def diagnostics(ready=False, node=True):
    return {'ok': ready and node, 'checks': [
        {'name': 'node', 'ok': node, 'version': '24.13.0', 'path': '/private/node'},
        {'name': 'npm', 'ok': node, 'version': '11.6.2', 'path': '/private/npm'},
        {'name': 'model_runtime', 'ok': ready, 'version': 'fixture', 'path': '/private/cache'},
    ]}


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setattr(model_setup, 'runtime_diagnostics', lambda: diagnostics())
    monkeypatch.setenv('AI_PERSONA_PUBLIC_ORIGIN', 'https://studio.example.test')
    data, state = tmp_path / 'persona-data', tmp_path / 'persona-state'
    initialize_persona(data, state, persona_id='setup-test')
    app = create_app(data, state)
    client = TestClient(app, headers={'X-AI-Persona': '1', 'Origin': 'http://testserver'})
    return app, client


def test_missing_runtime_can_be_diagnosed_without_loading_accounts(local, monkeypatch):
    app, client = local
    monkeypatch.setattr(app.state.ai_service.model, 'request', lambda *a: pytest.fail('No model daemon or account access'))
    response = client.get('/api/models/runtime')
    assert response.status_code == 200
    assert response.json()['status'] == 'not_installed'
    assert '/private' not in response.text
    assert response.headers['cache-control'] == 'no-store'
    assert not app.state.model_setup._installing


@pytest.mark.parametrize('headers', [
    {'Origin': 'https://evil.example'}, {'X-AI-Persona': ''},
    {'Sec-Fetch-Site': 'cross-site'},
    {'Host': 'studio.example.test', 'Origin': 'https://studio.example.test'},
])
def test_installer_rejects_untrusted_or_remote_browser_writes(local, monkeypatch, headers):
    app, client = local
    monkeypatch.setattr(app.state.model_setup, 'install', lambda: pytest.fail('Must not install'))
    assert client.post('/api/models/runtime/install', json={}, headers=headers).status_code == 403


def test_remote_can_see_status_but_cannot_install(local):
    _, client = local
    response = client.get('/api/models/runtime', headers={
        'Host': 'studio.example.test', 'Origin': 'https://studio.example.test',
    })
    assert response.status_code == 200 and response.json()['can_install'] is False
    assert client.post('/api/models/runtime/install', json={'command': 'anything'}).status_code == 400
    assert client.get('/api/models/runtime/install').status_code == 400
    assert client.post('/api/models/runtime', json={}).status_code == 400


@pytest.mark.parametrize('ready,node,status', [(True, True, 'ready'), (False, False, 'needs_node')])
def test_ready_or_missing_node_never_starts_an_install(monkeypatch, ready, node, status):
    monkeypatch.setattr(model_setup, 'runtime_diagnostics', lambda: diagnostics(ready, node))
    monkeypatch.setattr(model_setup.subprocess, 'Popen', lambda *a, **k: pytest.fail('No install required/possible'))
    assert model_setup.ModelSetup().install()['status'] == status


def test_install_is_async_deduplicated_recoverable_and_does_not_expose_output(local, monkeypatch):
    app, client = local
    started, release = threading.Event(), threading.Event()
    calls = []
    good = False
    monkeypatch.setattr(model_setup, 'runtime_diagnostics', lambda: diagnostics(good))

    def spawn(command, **kwargs):
        calls.append(command)
        assert command[-3:] == ['-m', 'ai_persona', 'models-install']
        kwargs['stdout'].write(b'private proxy credentials should never reach the browser')
        def wait(timeout):
            started.set()
            assert release.wait(5)
            return 0 if good else 1
        return SimpleNamespace(wait=wait)

    monkeypatch.setattr(model_setup.subprocess, 'Popen', spawn)
    assert client.post('/api/models/runtime/install', json={}).json()['status'] == 'installing'
    assert started.wait(2)
    assert client.post('/api/models/runtime/install', json={}).json()['status'] == 'installing'
    assert client.get('/api/models/runtime').json()['status'] == 'installing'
    assert len(calls) == 1
    release.set()
    deadline = time.monotonic() + 3
    while app.state.model_setup._installing and time.monotonic() < deadline:
        time.sleep(.01)
    failed = client.get('/api/models/runtime')
    assert failed.json()['status'] == 'failed' and 'private' not in failed.text
    release.clear()
    client.post('/api/models/runtime/install', json={})
    good = True
    release.set()
    deadline = time.monotonic() + 3
    while app.state.model_setup._installing and time.monotonic() < deadline:
        time.sleep(.01)
    assert client.get('/api/models/runtime').json()['status'] == 'ready'
    assert len(calls) == 2


def test_timed_out_install_stops_only_its_own_process_group(monkeypatch):
    monkeypatch.setattr(model_setup, 'runtime_diagnostics', lambda: diagnostics())
    waits, killed = [], []
    def wait(timeout=None):
        waits.append(timeout)
        if len(waits) == 1:
            raise model_setup.subprocess.TimeoutExpired('fixed installer', timeout)
        return -9
    monkeypatch.setattr(model_setup.subprocess, 'Popen', lambda *a, **k: SimpleNamespace(pid=12345, wait=wait))
    monkeypatch.setattr(model_setup.os, 'killpg', lambda pid, sig: killed.append((pid, sig)))
    manager = model_setup.ModelSetup()
    manager._install()
    assert killed == [(12345, model_setup.signal.SIGKILL)]
    assert manager.status()['error'] == 'install_timeout'
    assert manager.status()['status'] == 'failed'
