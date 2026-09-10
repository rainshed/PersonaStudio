import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { ModelStore } from '../store.mjs';
import { ModelService, REQUEST_BUDGETS } from '../service.mjs';
import {
  ModelError,
  normalizeError,
  providerCatalog,
} from '../engine.mjs';
import { createModelServer } from '../daemon.mjs';
import {
  validateConnection,
  hydrateModelSettings,
  emptyModelSettings,
  withoutConnection,
  resolveConnection,
} from '../model-config.ts';

const connection = (id = 'primary', overrides = {}) => ({
  id,
  name: id,
  providerId: 'custom',
  authType: 'api_key',
  modelId: 'mock-model',
  baseUrl: 'http://127.0.0.1:9999/v1',
  api: 'openai-completions',
  contextWindow: 32000,
  maxTokens: 4096,
  status: 'untested',
  ...overrides,
});
const response = {
  text: 'OK',
  modelId: 'mock-model',
  providerId: 'custom',
  usage: { input: 8, output: 1, cost: null },
  stopReason: 'stop',
};

for (const [reason, expected] of [
  [Object.assign(new Error('Cannot find module /private/oauth.js'), { code: 'ERR_MODULE_NOT_FOUND' }), 'runtime_missing'],
  [Object.assign(new Error('Cannot find package private-sdk'), { code: 'MODULE_NOT_FOUND' }), 'runtime_missing'],
  [new Error('OAuth auth derivation failed: Cannot find module /private/oauth.js'), 'runtime_missing'],
  [new Error('fetch failed'), 'connection_error'],
  [Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }), 'connection_error'],
  [new Error('refresh timed out'), 'timeout'],
  [new Error('request aborted'), 'cancelled'],
  [new Error('401 unauthorized private-token'), 'auth_required'],
  [new Error('403 forbidden private-token'), 'auth_required'],
  [new Error('invalid_grant private-token'), 'auth_required'],
]) {
  void test(`OAuth wrapped failure keeps the underlying category: ${expected} (${reason.code ?? reason.message})`, () => {
    for (const error of [reason, new Error('OAuth operation failed', { cause: reason })]) {
      const safe = normalizeError(error);
      assert.equal(safe.code, expected);
      assert.ok(!safe.message.includes('private'));
      if (expected === 'runtime_missing') {
        assert.match(safe.message, /models-install/);
        assert.equal(safe.retryable, false);
      }
    }
  });
}

void test('cyclic error causes are bounded and do not expose provider details', () => {
  const error = new Error('private unsupported provider failure');
  error.cause = error;
  assert.equal(normalizeError(error).code, 'provider_error');
  assert.ok(!normalizeError(error).message.includes('private'));
});

void test('missing OAuth runtime reports its own code and preserves existing credentials', async (t) => {
  const missing = Object.assign(new Error('Cannot find module /private/oauth.js'), { code: 'ERR_MODULE_NOT_FOUND' });
  const { store, service } = await fixture(t, {
    login: async () => { throw new Error('OAuth initialization failed', { cause: missing }); },
  });
  await service.saveConnection(builtin('codex', 'openai-codex', 'oauth'));
  await store.transaction(s => { s.credentials.codex = { type: 'oauth', access: 'private-saved-token' }; });
  const before = structuredClone(store.state.credentials);
  const start = service.startLogin('codex');
  await service.logins.get(start.id).work;
  const result = service.loginState(start.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'runtime_missing');
  assert.match(result.error, /models-install/);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(store.state.credentials, before);
  assert.equal(service.activeLogin(), null);
});

void test('task budgets are distinct and timeout never blindly repeats the prompt', async (t) => {
  assert.equal(REQUEST_BUDGETS.activation.attempt, 15000);
  assert.equal(REQUEST_BUDGETS.test.attempt, 30000);
  assert.equal(REQUEST_BUDGETS.material.attempt, 420000);
  assert.equal(REQUEST_BUDGETS.maintenance.attempt, 420000);
  assert.equal(REQUEST_BUDGETS.material.total, 480000);
  assert.ok(REQUEST_BUDGETS.material.total < 510000);
  let calls = 0;
  const { service } = await fixture(t, { generate: async () => {
    calls++; throw new ModelError('timeout', 'safe timeout', true);
  } });
  await service.saveConnection({ ...connection(), apiKey: 'private-key' });
  await assert.rejects(service.run({ task: 'material', prompt: 'private paper', stage: '理解材料 1/2' }), { code: 'timeout' });
  assert.equal(calls, 1);
  const run = service.config().runs[0];
  assert.equal(run.attempts, 1);
  assert.equal(run.stage, '理解材料 1/2');
  assert.equal(run.firstContentMs, null);
  assert.ok(!JSON.stringify(run).includes('private'));
});

void test('long foreground reasoning can finish after the former three-minute cutoff', async (t) => {
  let enter, finish, signal;
  const entered = new Promise(resolve => { enter = resolve; });
  const finished = new Promise(resolve => { finish = resolve; });
  const { service } = await fixture(t, { generate: async (_c, request) => {
    signal = request.signal;
    request.onEvent('thinking_delta'); enter();
    await finished;
    return response;
  } });
  await service.saveConnection({ ...connection(), apiKey: 'private-key' });
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const running = service.run({task: 'material', prompt: 'paper', runId: 'long-analysis'});
  await entered;
  t.mock.timers.tick(240000);
  assert.equal(signal.aborted, false);
  assert.equal(service.activeRuns.get('long-analysis').phase, 'receiving');
  finish();
  const result = await running;
  assert.equal(result.durationMs, 240000);
  assert.equal(service.config().runs[0].status, 'succeeded');
  t.mock.timers.reset();
});

void test('timeout aborts the provider, returns safe telemetry, and clears live progress', async (t) => {
  let signal;
  const { service } = await fixture(t, { generate: async (_c, request) => {
    signal = request.signal;
    request.onEvent('start');
    await delay(5000, undefined, { signal });
    return response;
  } });
  service.budgets = { ...REQUEST_BUDGETS, material: { attempt: 20, total: 30 } };
  await service.saveConnection({ ...connection(), apiKey: 'private-key' });
  await assert.rejects(service.run({ task: 'material', prompt: 'paper', runId: 'timeout-test' }), e => {
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /尚未收到模型内容/);
    assert.equal(e.modelRun.lastContentMs, null);
    assert.equal(e.modelRun.attemptTimeoutMs, 20);
    assert.equal(e.modelRun.firstContentMs, null); // SDK start is not a provider content event.
    assert.equal(e.modelRun.attempts, 1);
    return true;
  });
  assert.ok(signal.aborted);
  assert.equal(service.activeRuns.size, 0);
  assert.equal(service.config().runs[0].status, 'timeout');
});

void test('unfinished streaming has a bounded timeout and never claims partial text is saved', async (t) => {
  let calls = 0;
  const { service } = await fixture(t, { generate: async (_c, request) => {
    calls++;
    request.onEvent('thinking_delta');
    await delay(5000, undefined, { signal: request.signal });
    return response;
  } });
  service.budgets = { ...REQUEST_BUDGETS, material: { attempt: 30, total: 50 } };
  await service.saveConnection({ ...connection(), apiKey: 'private-key' });
  await assert.rejects(service.run({ task: 'material', prompt: 'paper' }), e => {
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /已收到部分内容但尚未形成完整结果/);
    assert.doesNotMatch(e.message, /已保留|已保存/);
    assert.ok(e.modelRun.lastContentMs >= 0);
    return true;
  });
  assert.equal(calls, 1);
});

void test('streaming progress exposes timing only; content errors are not automatically retried', async (t) => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const block = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { service } = await fixture(t, { generate: async (_c, request) => {
    calls++;
    request.onEvent('start'); request.onEvent('thinking_delta', {chars: 17});
    entered(); await block;
    throw new ModelError('rate_limited', 'safe', true);
  } });
  await service.saveConnection({ ...connection(), apiKey: 'private-key' });
  const url = await listen(t, createModelServer(service, 'local-token'));
  const running = service.run({ task: 'material', prompt: 'private paper', runId: 'live-test' });
  await started;
  const progress = await (await fetch(url + '/progress/live-test', { headers: { Authorization: 'Bearer local-token' } })).json();
  assert.equal(progress.phase, 'receiving');
  assert.ok(progress.firstContentMs >= 0);
  assert.ok(progress.firstThinkingMs >= 0);
  assert.equal(progress.firstTextMs, null);
  assert.equal(progress.thinkingChars, 17);
  assert.equal(progress.textChars, 0);
  assert.deepEqual(progress.eventCounts, {start: 1, thinking_delta: 1});
  assert.ok(progress.lastContentMs >= progress.firstContentMs);
  assert.equal(progress.attemptTimeoutMs, 420000);
  assert.ok(!JSON.stringify(progress).includes('private'));
  release();
  await assert.rejects(running, { code: 'rate_limited' });
  assert.equal(calls, 1);
  assert.equal(service.activeRuns.size, 0);
});

void test('only pre-content transient failures retry, and fallback shares the total deadline', async (t) => {
  const calls = [];
  let retry = true;
  const { service } = await fixture(t, { generate: async (c, request) => {
    calls.push(c.id);
    if (retry && calls.length === 1) throw new ModelError('connection_error', 'safe', true);
    if (retry) return response;
    await delay(5000, undefined, { signal: request.signal });
    return response;
  } });
  for (const id of ['primary', 'alternate']) await service.saveConnection({ ...connection(id), apiKey: 'private-key' });
  const result = await service.run({ task: 'maintenance', prompt: 'paper' });
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls, ['primary', 'primary']);
  retry = false; calls.length = 0;
  service.budgets = { ...REQUEST_BUDGETS, material: { attempt: 20, total: 25 } };
  await service.routing({ defaultConnectionId: 'primary', overrides: {}, fallback: { enabled: true, connectionId: 'alternate' } });
  await assert.rejects(service.run({ task: 'material', prompt: 'paper' }), { code: 'timeout' });
  assert.deepEqual(calls, ['primary']);
});
async function fixture(t, engine) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-persona-model-test-'));
  const store = await new ModelStore(directory).open();
  const service = new ModelService(store, engine);
  t.after(async () => {
    await service.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, service };
}
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
function builtin(id, providerId, authType) {
  const model = providerCatalog().find((p) => p.id === providerId).models[0];
  return connection(id, {
    providerId,
    authType,
    modelId: model.id,
    contextWindow: model.contextWindow,
  });
}

void test('provider coverage includes all requested platforms and distinct Kimi regions', () => {
  const catalog = providerCatalog();
  for (const id of [
    'openai',
    'openai-codex',
    'anthropic',
    'google',
    'deepseek',
    'openrouter',
    'moonshotai',
    'moonshotai-cn',
    'kimi-coding',
  ]) {
    assert.ok(catalog.find((p) => p.id === id)?.models.length, id);
  }
  assert.deepEqual(catalog.find((p) => p.id === 'kimi-coding').auth, [
    'api_key',
    'oauth',
  ]);
});

void test('validation rejects invalid auth, endpoints and limits; browser hydration strips credentials', () => {
  assert.equal(validateConnection(connection()), null);
  for (const patch of [
    { baseUrl: 'http://example.com/v1' },
    { baseUrl: 'https://secret@example.com/v1' },
    { baseUrl: 'https://example.com/v1?api_key=secret' },
    { baseUrl: 'file:///tmp/model' },
    { maxTokens: 32001 },
    { providerId: 'anthropic', authType: 'oauth' },
    { api: 'unknown' },
    { id: '__proto__' },
  ])
    assert.ok(validateConnection(connection('a', patch)));
  const settings = hydrateModelSettings({
    ...emptyModelSettings(),
    credentials: 'hidden',
    connections: [
      connection('a', { apiKey: 'secret', refreshToken: 'secret' }),
    ],
    defaultConnectionId: 'missing',
  });
  assert.equal(settings.defaultConnectionId, null);
  assert.ok(!JSON.stringify(settings).includes('secret'));
  assert.equal(
    hydrateModelSettings({ connections: [connection('a'), connection('a')] }),
    null,
  );
});

void test('deleting a connection clears every route that refers to it', () => {
  const settings = {
    ...emptyModelSettings(),
    connections: [connection('a'), connection('b')],
    defaultConnectionId: 'a',
    overrides: { activation: null, maintenance: 'b', material: 'a' },
    fallback: { enabled: true, connectionId: 'a' },
  };
  assert.equal(resolveConnection(settings, 'maintenance').id, 'b');
  assert.equal(resolveConnection(settings, 'activation').id, 'a');
  const removed = withoutConnection(settings, 'a');
  assert.equal(removed.defaultConnectionId, null);
  assert.equal(removed.overrides.material, null);
  assert.equal(removed.overrides.maintenance, 'b');
  assert.deepEqual(removed.fallback, { enabled: false, connectionId: null });
});

void test('vault persists encrypted secrets with restrictive permissions and exclusive ownership', async (t) => {
  const { directory, store, service } = await fixture(t);
  await service.saveConnection({
    ...connection(),
    apiKey: 'test-secret-never-expose',
  });
  assert.ok(
    !JSON.stringify(service.config()).includes('test-secret-never-expose'),
  );
  assert.ok(
    !(await readFile(join(directory, 'vault.enc'), 'utf8')).includes(
      'test-secret-never-expose',
    ),
  );
  assert.equal((await stat(join(directory, 'vault.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'vault.enc'))).mode & 0o777, 0o600);
  await assert.rejects(new ModelStore(directory).open(), /另一个模型服务/);
  await store.close();
  await store.open();
  assert.equal(store.state.credentials.primary.key, 'test-secret-never-expose');
  assert.equal(service.config().settings.connections[0].hasCredential, true);
});

void test('serialized refresh updates cannot lose rotated credentials', async (t) => {
  const { store, service } = await fixture(t);
  await service.saveConnection({ ...connection(), apiKey: 'initial' });
  const credentials = store.credentialStore('primary');
  await Promise.all(
    Array.from({ length: 8 }, () =>
      credentials.modify('custom', async (current) => {
        await delay(2);
        return { ...current, version: (current.version ?? 0) + 1 };
      }),
    ),
  );
  assert.equal((await credentials.read('custom')).version, 8);
  await assert.rejects(
    credentials.modify(
      'custom',
      () => ({ type: 'api_key', key: 'cancelled' }),
      { signal: AbortSignal.abort() },
    ),
  );
  assert.equal((await credentials.read('custom')).key, 'initial');
});

void test('connection edits retain keys, changing service clears them, disconnect removes them', async (t) => {
  const { store, service } = await fixture(t);
  await service.saveConnection({ ...connection(), apiKey: 'secret' });
  await service.saveConnection(connection('primary', { name: 'Renamed' }));
  assert.equal(store.state.credentials.primary.key, 'secret');
  await service.saveConnection(
    connection('primary', { baseUrl: 'https://example.org/v1' }),
  );
  assert.equal(store.state.credentials.primary, undefined);
  assert.equal(
    service.config().settings.connections[0].status,
    'auth_required',
  );
  await service.saveConnection({ ...connection(), apiKey: 'replacement' });
  await service.disconnect('primary');
  assert.equal(store.state.credentials.primary, undefined);
  await assert.rejects(service.routing({ defaultConnectionId: 'missing' }), {
    code: 'invalid_request',
  });
});

void test('task routes, explicit fallback and sanitized run records reflect actual calls', async (t) => {
  const calls = [];
  let failure = 'quota_exceeded';
  const { service } = await fixture(t, {
    generate: async (c) => {
      calls.push(c.id);
      if (c.id === 'primary') throw new ModelError(failure, 'safe message');
      return response;
    },
  });
  for (const id of ['primary', 'alternate'])
    await service.saveConnection({ ...connection(id), apiKey: 'secret' });
  const request = { task: 'maintenance', prompt: 'private manuscript text' };
  await assert.rejects(service.run(request), { code: 'quota_exceeded' });
  assert.deepEqual(calls, ['primary']);
  await service.routing({
    defaultConnectionId: 'primary',
    overrides: { activation: 'alternate' },
    fallback: { enabled: true, connectionId: 'alternate' },
  });
  const output = await service.run(request);
  assert.equal(output.connectionId, 'alternate');
  assert.equal(output.fallbackFrom, 'primary');
  assert.equal(
    (await service.run({ ...request, task: 'activation' })).connectionId,
    'alternate',
  );
  failure = 'auth_required';
  const before = calls.length;
  await assert.rejects(service.run(request), { code: 'auth_required' });
  assert.equal(calls.length, before + 1);
  assert.ok(!JSON.stringify(service.config().runs).includes(request.prompt));
  assert.ok(service.config().runs.some((r) => r.status === 'quota_exceeded'));
});

void test('OAuth sends prompt answers to provider, saves credentials, supports cancellation', async (t) => {
  const { store, service } = await fixture(t);
  service.engine = {
    login: async (c, interaction) => {
      interaction.notify({
        type: 'auth',
        url: 'https://example.org/authorize',
        userCode: 'CODE',
      });
      const answer = await interaction.prompt({
        type: 'text',
        message: 'Verification code',
      });
      assert.equal(answer, 'verified');
      await store.credentialStore(c.id).modify(
        c.providerId,
        () => ({
          type: 'oauth',
          access: 'access-secret',
          refresh: 'refresh-secret',
          expires: Date.now() + 60000,
        }),
        { signal: interaction.signal },
      );
    },
  };
  await service.saveConnection(builtin('kimi', 'kimi-coding', 'oauth'));
  const originalRevision = service.connection('kimi').revision;
  const session = service.startLogin('kimi');
  assert.ok(session.prompt?.id);
  assert.equal(service.startLogin('kimi').id, session.id);
  assert.throws(
    () =>
      service.answerLogin(session.id, { answer: 'verified', promptId: 'old' }),
    { code: 'stale_prompt' },
  );
  service.answerLogin(session.id, {
    answer: 'verified',
    promptId: session.prompt.id,
  });
  await service.logins.get(session.id).work;
  assert.equal(service.loginState(session.id).status, 'succeeded');
  assert.equal(service.config().settings.connections[0].hasCredential, true);
  assert.notEqual(service.connection('kimi').revision, originalRevision);
  assert.ok(!JSON.stringify(service.config()).includes('access-secret'));
  await service.disconnect('kimi');
  const cancelled = service.startLogin('kimi');
  service.cancelLogin(cancelled.id);
  await service.logins.get(cancelled.id).work;
  assert.equal(service.loginState(cancelled.id).status, 'cancelled');
  assert.equal(store.state.credentials.kimi, undefined);
});

void test('OAuth select prompts resume through the API, validate option IDs and cancel safely', async (t) => {
  const answers = [];
  const { service } = await fixture(t, {
    login: async (_c, interaction) => {
      answers.push(await interaction.prompt({ type: 'select', message: 'Select login method',
        options: [{ id: 'browser', label: 'Browser login' }, { id: 'device_code', label: 'Device code' }] }));
      interaction.notify({ type: 'auth_url', url: 'https://example.org/authorize' });
      await interaction.prompt({ type: 'manual_code', message: 'Authorization result' });
    },
  });
  for (const id of ['first', 'second']) await service.saveConnection(builtin(id, 'openai-codex', 'oauth'));
  const url = await listen(t, createModelServer(service, 'test-token'));
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const getActive = async () => (await (await fetch(url + '/auth/active', { headers })).json()).session;
  const post = async (path, body) => (await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })).json();
  assert.equal((await fetch(url + '/auth/active')).status, 403);
  assert.equal(await getActive(), null);
  for (const answer of ['browser', 'device_code']) {
    const state = await post('/auth/start', { id: 'first' });
    assert.equal(state.prompt.type, 'select');
    assert.deepEqual(await getActive(), state); // Reload can recover the full continuation state.
    assert.equal((await post('/auth/start', { id: 'first' })).id, state.id);
    assert.equal((await post('/auth/start', { id: 'second' })).code, 'login_busy');
    assert.equal((await post('/auth/answer', { id: state.id, promptId: state.prompt.id, answer: 'Browser login' })).code, 'invalid_request');
    assert.equal((await getActive()).prompt.id, state.prompt.id);
    assert.equal((await post('/auth/answer', { id: state.id, promptId: state.prompt.id, answer })).ok, true);
    const next = await getActive();
    assert.equal(next.prompt.type, 'manual_code');
    assert.equal(next.events[0].type, 'auth_url');
    assert.equal((await post('/auth/answer', { id: state.id, promptId: state.prompt.id, answer })).code, 'stale_prompt');
    assert.equal((await post('/auth/cancel', { id: state.id })).ok, true);
    assert.equal(await getActive(), null);
    await service.logins.get(state.id).work;
    assert.equal(service.loginState(state.id).status, 'cancelled');
  }
  assert.deepEqual(answers, ['browser', 'device_code']);
});

void test('real Pi Codex adapter exposes the login method selector before any network/login', async (t) => {
  const { service } = await fixture(t);
  await service.saveConnection(builtin('codex', 'openai-codex', 'oauth'));
  const start = service.startLogin('codex');
  for (let i = 0; i < 100 && !service.loginState(start.id).prompt; i++) await delay(10);
  const state = service.activeLogin();
  assert.equal(state.prompt.type, 'select');
  assert.deepEqual(state.prompt.options.map(o => o.id), ['browser', 'device_code']);
  assert.equal(service.startLogin('codex').id, start.id);
  service.cancelLogin(start.id);
  await service.logins.get(start.id).work;
  assert.equal(service.activeLogin(), null);
  assert.equal(service.config().settings.connections[0].hasCredential, false);
});

void test('model labels suppress repeated Codex names but preserve different connection names', async () => {
  const context = { window: {}, document: { documentElement: { lang: 'zh-CN' } } };
  runInNewContext(await readFile(new URL('../../static/ai-common.js', import.meta.url), 'utf8'), context);
  const { modelLabel } = context.window.PersonaAI;
  assert.equal(modelLabel('GPT 5.6 Sol', 'gpt-5.6-sol'), 'GPT 5.6 Sol');
  assert.equal(modelLabel('gpt-5.6-sol', 'gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(modelLabel('Work account', 'gpt-5.6-sol'), 'Work account · gpt-5.6-sol');
  assert.equal(modelLabel('GPT 5.6', 'gpt-5.6-sol'), 'GPT 5.6 · gpt-5.6-sol');
  assert.equal(modelLabel('', 'gpt-5.6-sol'), 'gpt-5.6-sol');
});

void test('real Pi adapter calls a compatible HTTP model, handles no-auth and rejects truncated output', async (t) => {
  const requests = [];
  let finish = 'stop';
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(body),
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock-model',
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  const url = await listen(t, upstream);
  const { store, service } = await fixture(t);
  const c = connection('real-adapter', { baseUrl: url + '/v1' });
  await service.saveConnection({ ...c, apiKey: 'mock-only-key' });
  const result = await service.run({ connectionId: c.id });
  assert.equal(result.text, 'OK');
  assert.equal(result.usage.output, 1);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer mock-only-key');
  assert.equal(requests[0].headers['user-agent'], 'AIPersona/0.1');
  assert.equal(requests[0].body.model, 'mock-model');
  await service.routing({ defaultConnectionId: c.id, defaultModelId: 'model-a',
    overrides: { maintenance: c.id }, overrideModelIds: { maintenance: 'model-b' } });
  for (const task of ['activation', 'maintenance']) await service.run({ task, prompt: 'test' });
  assert.deepEqual(requests.slice(1, 3).map(r => r.body.model), ['model-a', 'model-b']);
  assert.ok(requests.slice(1, 3).every(r => r.headers.authorization === 'Bearer mock-only-key'));
  assert.deepEqual(Object.keys(store.state.credentials), [c.id]);
  await service.saveConnection({ ...c, authType: 'none' });
  assert.equal((await service.run({ connectionId: c.id })).text, 'OK');
  assert.equal(requests[3].headers.authorization, undefined);
  assert.equal(store.state.credentials[c.id], undefined);
  finish = 'length';
  await assert.rejects(service.run({ connectionId: c.id }), {
    code: 'output_limit',
  });
  assert.equal(service.config().settings.connections[0].status, 'error');
  assert.equal(
    normalizeError(new Error('401 leaked-key')).code,
    'auth_required',
  );
  assert.ok(
    !normalizeError(new Error('401 leaked-key')).message.includes('leaked-key'),
  );
});

void test('daemon requires bearer credentials and refuses foreign hosts/origins', async (t) => {
  const { service } = await fixture(t, { generate: async () => response });
  const token = 'a'.repeat(64);
  const url = await listen(t, createModelServer(service, token));
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  assert.equal((await fetch(url + '/config')).status, 403);
  assert.equal((await fetch(url + '/config', { headers })).status, 200);
  assert.equal((await fetch(url + '/config', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const foreign = await new Promise((resolve, reject) => {
    httpRequest(url + '/config', { headers: { ...headers, Host: 'evil.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(foreign, 403);
  const saved = await fetch(url + '/connections', { method: 'POST', headers,
    body: JSON.stringify({ ...connection(), apiKey: 'daemon-secret' }) });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes('daemon-secret'));
  const result = await fetch(url + '/generate', { method: 'POST', headers,
    body: JSON.stringify({ task: 'activation', prompt: 'classify', runId: 'test-run' }) });
  assert.equal((await result.json()).text, 'OK');
  assert.equal((await fetch(url + '/routing', { method: 'POST', headers, body: 'null' })).status, 400);
});

void test('cancelling a generation aborts Pi and never starts a fallback', async (t) => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const calls = [];
  const { service } = await fixture(t, { generate: async (c, request) => {
    calls.push(c.id); started();
    await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return response;
  } });
  for (const id of ['primary', 'alternate']) await service.saveConnection({ ...connection(id), apiKey: 'test' });
  await service.routing({ defaultConnectionId: 'primary', overrides: {}, fallback: { enabled: true, connectionId: 'alternate' } });
  const url = await listen(t, createModelServer(service, 'token'));
  const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };
  const result = fetch(url + '/generate', { method: 'POST', headers,
    body: JSON.stringify({ task: 'material', prompt: 'analyze', runId: 'cancel-test' }) });
  await entered;
  assert.equal((await fetch(url + '/cancel', { method: 'POST', headers, body: JSON.stringify({ runId: 'cancel-test' }) })).status, 200);
  assert.equal((await (await result).json()).code, 'cancelled');
  assert.deepEqual(calls, ['primary']);
  assert.equal(service.running, 0);
});

void test('old connection revisions cannot read replacement credentials or update status', async (t) => {
  const { service, store } = await fixture(t);
  await service.saveConnection({ ...connection(), apiKey: 'first' });
  const old = service.connection('primary');
  const oldCredentials = store.credentialStore('primary', old.revision);
  await service.routing({
    defaultConnectionId: 'primary',
    overrides: {},
    fallback: { enabled: false },
  });
  assert.equal((await oldCredentials.read('custom')).key, 'first');
  await service.saveConnection({ ...connection('other'), apiKey: 'other' });
  await service.remove('other');
  assert.equal((await oldCredentials.read('custom')).key, 'first');
  await service.saveConnection({ ...connection(), apiKey: 'replacement' });
  await assert.rejects(oldCredentials.read('custom'), /Connection changed/);
  await assert.rejects(
    oldCredentials.modify('custom', () => ({
      type: 'api_key',
      key: 'old-refresh',
    })),
    /Connection changed/,
  );
  await service.status(old, 'ready');
  assert.equal(service.connection('primary').status, 'untested');
  assert.equal(store.state.credentials.primary.key, 'replacement');
  await service.remove('primary');
  await service.saveConnection({ ...connection(), apiKey: 'recreated' });
  await assert.rejects(oldCredentials.read('custom'), /Connection changed/);
});

void test('one API account routes multiple models, validates provider boundaries and persists choices', async (t) => {
  const calls = [];
  const { store, service } = await fixture(t);
  service.engine = { generate: async c => {
    const credential = await store.credentialStore(c.id, c.revision).read(c.providerId);
    calls.push({ id: c.id, modelId: c.modelId, key: credential.key, maxTokens: c.maxTokens });
    return response;
  } };
  const [first, second] = providerCatalog().find(p => p.id === 'openai').models;
  // The account form no longer needs a model or capacity fields.
  await service.saveConnection({ id: 'account', name: 'My API account', providerId: 'openai', authType: 'api_key', apiKey: 'one-test-key' });
  const revision = service.connection('account').revision;
  await service.routing({
    defaultConnectionId: 'account', defaultModelId: first.id,
    overrides: { maintenance: 'account', conversation_candidate: 'account' },
    overrideModelIds: { maintenance: second.id, conversation_candidate: second.id },
  });
  for (const task of ['activation', 'maintenance', 'conversation_candidate']) await service.run({ task, prompt: 'test' });
  assert.deepEqual(calls.map(c => c.modelId), [first.id, second.id, second.id]);
  assert.ok(calls.every(c => c.key === 'one-test-key' && c.id === 'account'));
  assert.equal(calls[1].maxTokens, second.maxTokens);
  assert.equal(service.connection('account').revision, revision);
  assert.deepEqual(Object.keys(store.state.credentials), ['account']);
  const saved = structuredClone(store.state.settings);
  for (const patch of [
    { defaultModelId: 'not-a-provider-model' },
    { overrideModelIds: { maintenance: 'not-a-provider-model' } },
    { fallback: { enabled: true, connectionId: 'account', modelId: 'not-a-provider-model' } },
    { defaultModelId: 3 },
    { defaultConnectionId: null, defaultModelId: first.id },
  ]) {
    await assert.rejects(service.routing({ ...saved, ...patch }));
    assert.deepEqual(store.state.settings, saved);
  }
  await store.close(); await store.open();
  assert.deepEqual(store.state.settings, saved);
  assert.equal(store.state.credentials.account.key, 'one-test-key');
  const url = await listen(t, createModelServer(service, 'test-token'));
  const result = await (await fetch(url + '/test', { method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'account', modelId: second.id }),
  })).json();
  assert.equal(result.modelId, second.id);
  assert.equal(service.config().runs[0].modelId, second.id);
  assert.ok(!JSON.stringify(service.config()).includes('one-test-key'));
  await service.remove('account');
  assert.equal(store.state.settings.defaultModelId, null);
  assert.equal(store.state.settings.overrideModelIds.maintenance, null);
  assert.equal(store.state.credentials.account, undefined);
});

void test('one OAuth login shares refreshed credentials across models while other accounts stay isolated', async (t) => {
  const { store, service } = await fixture(t);
  let logins = 0;
  const used = [];
  service.engine = {
    login: async c => {
      logins++;
      await store.credentialStore(c.id, c.revision).modify(c.providerId,
        () => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', version: 0 }));
    },
    generate: async c => {
      const credentials = store.credentialStore(c.id, c.revision);
      await credentials.modify(c.providerId, current => {
        used.push([c.modelId, current.version]);
        return { ...current, version: current.version + 1 };
      });
      return response;
    },
  };
  const [first, second] = providerCatalog().find(p => p.id === 'openai-codex').models;
  for (const id of ['personal', 'work']) await service.saveConnection(builtin(id, 'openai-codex', 'oauth'));
  const session = service.startLogin('personal');
  await service.logins.get(session.id).work;
  assert.equal(service.loginState(session.id).status, 'succeeded');
  await service.routing({ defaultConnectionId: 'personal', defaultModelId: first.id,
    overrides: { maintenance: 'personal' }, overrideModelIds: { maintenance: second.id } });
  await Promise.all(['activation', 'maintenance'].map(task => service.run({ task, prompt: 'test' })));
  assert.equal(logins, 1);
  assert.deepEqual(new Set(used.map(x => x[0])), new Set([first.id, second.id]));
  assert.deepEqual(used.map(x => x[1]), [0, 1]);
  assert.equal(store.state.credentials.personal.version, 2);
  await assert.rejects(service.run({ connectionId: 'work', modelId: first.id }), { code: 'auth_required' });
  await service.disconnect('personal');
  for (const modelId of [first.id, second.id])
    await assert.rejects(service.run({ connectionId: 'personal', modelId }), { code: 'auth_required' });
});

void test('legacy encrypted vault keeps accounts, revisions, original models and routes on upgrade', async (t) => {
  const { store, service } = await fixture(t, { generate: async () => response });
  for (const [id, modelId] of [['one', 'old-model-one'], ['two', 'old-model-two']])
    await service.saveConnection({ ...connection(id, { modelId }), apiKey: id + '-test-key' });
  const connections = structuredClone(store.state.settings.connections);
  await store.transaction(s => {
    s.settings = { connections, defaultConnectionId: 'one', overrides: { material: 'two' },
      fallback: { enabled: true, connectionId: 'two' } };
  });
  await store.close(); await store.open();
  assert.deepEqual(store.state.settings.connections, connections);
  assert.equal(store.state.credentials.one.key, 'one-test-key');
  assert.equal(store.state.credentials.two.key, 'two-test-key');
  assert.equal((await service.run({ task: 'activation', prompt: 'test' })).modelId, 'old-model-one');
  assert.equal((await service.run({ task: 'material', prompt: 'test' })).modelId, 'old-model-two');
  await service.routing({ ...store.state.settings, defaultModelId: 'new-model' });
  assert.equal((await service.run({ task: 'activation', prompt: 'test' })).modelId, 'new-model');
  assert.equal(store.state.settings.connections[0].revision, connections[0].revision);
});

void test('fallback can use another model on the same account but cannot repeat the identical model', async (t) => {
  const calls = [];
  const { store, service } = await fixture(t, { generate: async c => {
    calls.push([c.id, c.modelId]);
    if (c.modelId === 'primary-model') throw new ModelError('provider_error', 'safe');
    return response;
  } });
  await service.saveConnection({ ...connection(), apiKey: 'shared-key' });
  await service.routing({ defaultConnectionId: 'primary', defaultModelId: 'primary-model',
    fallback: { enabled: true, connectionId: 'primary', modelId: 'backup-model' } });
  assert.equal((await service.run({ task: 'material', prompt: 'test' })).modelId, 'backup-model');
  assert.deepEqual(calls, [['primary', 'primary-model'], ['primary', 'backup-model']]);
  assert.deepEqual(Object.keys(store.state.credentials), ['primary']);
  calls.length = 0;
  await service.routing({ ...store.state.settings, fallback: { enabled: true, connectionId: 'primary', modelId: 'primary-model' } });
  await assert.rejects(service.run({ task: 'material', prompt: 'test' }), { code: 'provider_error' });
  assert.equal(calls.length, 1);
});

void test('changing account access method clears credentials and selected models without touching other accounts', async (t) => {
  const { store, service } = await fixture(t);
  const openai = providerCatalog().find(p => p.id === 'openai').models[0].id;
  for (const id of ['one', 'two']) await service.saveConnection({ ...builtin(id, 'openai', 'api_key'), apiKey: id + '-key' });
  await service.routing({ defaultConnectionId: 'one', defaultModelId: openai,
    overrides: { maintenance: 'one', material: 'two' }, overrideModelIds: { maintenance: openai, material: openai },
    fallback: { enabled: true, connectionId: 'one', modelId: openai } });
  await service.saveConnection({ id: 'one', name: 'Subscription', providerId: 'openai-codex', authType: 'oauth' });
  assert.equal(store.state.credentials.one, undefined);
  assert.equal(store.state.credentials.two.key, 'two-key');
  assert.equal(store.state.settings.defaultModelId, null);
  assert.equal(store.state.settings.overrideModelIds.maintenance, null);
  assert.equal(store.state.settings.fallback.modelId, undefined);
  assert.equal(store.state.settings.overrideModelIds.material, openai);
});

void test('prompt experiments pin a connection revision and disable retry and fallback', async t => {
  const calls=[];
  const {service,store}=await fixture(t,{generate:async(c,r)=>{calls.push(c.id);throw new ModelError('provider_error','Mock failure',true);}});
  await service.saveConnection({...connection('first'),apiKey:'fake-key'});
  await service.saveConnection({...connection('backup'),apiKey:'fake-key'});
  await store.transaction(s=>{s.settings.fallback={enabled:true,connectionId:'backup'};});
  const c=service.config().settings.connections.find(c=>c.id==='first');
  assert.equal(service.config().capabilities.promptExperiments,1);
  const request={task:'maintenance',systemPrompt:'Test',prompt:'Test',maxTokens:512,experimentSelection:{connectionId:c.id,modelId:c.modelId,revision:c.revision}};
  await assert.rejects(service.run(request),{code:'provider_error'});
  assert.deepEqual(calls,['first']);
  await service.saveConnection({...c,name:'Edited'});
  await assert.rejects(service.run(request),{code:'connection_changed'});
  assert.deepEqual(calls,['first']);
});

void test('activation respects the caller deadline and never switches to a fallback', async t => {
  const calls = [];
  let aborted = false;
  const { service } = await fixture(t, {
    generate: async (c, request) => {
      calls.push(c.id);
      await new Promise(resolve => request.signal.addEventListener('abort', () => {aborted = true; resolve();}, {once: true}));
      return response;
    },
  });
  for (const id of ['primary', 'alternate']) await service.saveConnection({...connection(id), apiKey: 'fixture'});
  await service.routing({defaultConnectionId: 'primary', overrides: {}, fallback: {enabled: true, connectionId: 'alternate'}});
  const start = Date.now();
  await assert.rejects(service.run({task: 'activation', prompt: 'classify', deadline: Date.now() + 40}), {code: 'timeout'});
  assert.ok(Date.now() - start < 1000);
  assert.equal(aborted, true);
  assert.deepEqual(calls, ['primary']);
});

void test('an expired activation deadline never reaches the provider', async t => {
  let calls = 0;
  const { service } = await fixture(t, {generate: async () => {calls++; return response;}});
  await service.saveConnection({...connection(), apiKey: 'fixture'});
  await assert.rejects(service.run({task: 'activation', prompt: 'old request', deadline: Date.now() - 10}), {code: 'timeout'});
  assert.equal(calls, 0);
});

void test('real Pi tool call IDs survive the next provider request', async (t) => {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const first = requests.length === 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const base = { id:'chatcmpl-tools', object:'chat.completion.chunk', created:1, model:'mock-model' };
    const delta = first ? {role:'assistant', tool_calls:[{index:0,id:'call-source-1',type:'function',function:{name:'search_preferences',arguments:'{"query":"symbols"}'}}]} : {role:'assistant',content:'{"kind":"no_change","summary":"Already recorded"}'};
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const url = await listen(t, upstream);
  const {service} = await fixture(t);
  await service.saveConnection({...connection('tool-model',{baseUrl:url+'/v1'}),apiKey:'test-key'});
  const tools = [{name:'search_preferences',description:'Read existing preferences',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}];
  const messages = [{role:'user',content:'Maintain my preferences.',timestamp:Date.now()}];
  const first = await service.run({task:'maintenance',prompt:JSON.stringify(messages),messages,tools});
  assert.equal(first.text,'');
  const call = first.message.content.find(c=>c.type==='toolCall');
  assert.equal(call.id,'call-source-1');
  assert.deepEqual(call.arguments,{query:'symbols'});
  messages.push(first.message,{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:'{"ok":true,"items":[]}'}],isError:false,timestamp:Date.now()});
  const next = await service.run({task:'maintenance',prompt:JSON.stringify(messages),messages,tools});
  assert.match(next.text,/Already recorded/);
  assert.equal(requests[0].tools[0].function.name,'search_preferences');
  const returned = requests[1].messages.find(m=>m.role==='tool');
  assert.equal(returned.tool_call_id,'call-source-1');
  assert.match(returned.content,/"ok":true/);
  await assert.rejects(service.run({task:'maintenance',prompt:'x',messages:[{role:'system',content:'not allowed'}],tools}),{code:'invalid_request'});
});

void test('version 2 routes remain compatible and preserve accounts and dormant choices', async t => {
  const calls = [];
  const {service, store} = await fixture(t, {generate: async (c, request) => {
    calls.push([request.task, c.modelId]); return {...response, modelId:c.modelId};
  }});
  await service.saveConnection({...connection('account'), apiKey:'fixture-secret'});
  await service.routing({defaultConnectionId:'account', defaultModelId:'default',
    overrides:{maintenance:'account',material:'account',conversation_signal:'account',conversation_candidate:'account'},
    overrideModelIds:{maintenance:'editor',material:'paper',conversation_signal:'fast',conversation_candidate:'careful'},
    fallback:{enabled:false,connectionId:null}});
  const before = structuredClone(store.state.credentials), revision = store.state.settings.connections[0].revision;
  assert.deepEqual(service.config().tasks.map(t=>t.id), ['maintenance','conversation_learning','conversation_signal','activation']);
  assert.equal(service.config().taskRoutes.filter(t=>t.conflict).length,1);
  await service.run({task:'material',prompt:'paper'});
  await service.run({task:'conversation_signal',prompt:'signal'});
  assert.deepEqual(calls.splice(0),[['material','paper'],['conversation_signal','fast']]);
  await service.routing({routingVersion:2,defaultConnectionId:'account',defaultModelId:'default',
    overrides:{maintenance:'account',conversation_learning:'account',activation:'account'},
    overrideModelIds:{maintenance:'unified-maintenance',conversation_learning:'unified-learning',activation:'fast'},
    fallback:{enabled:false,connectionId:null}});
  for(const task of ['maintenance','material','conversation_signal','conversation_candidate','activation'])await service.run({task,prompt:'test'});
  assert.deepEqual(calls,[['maintenance','unified-maintenance'],['material','unified-maintenance'],['conversation_signal','unified-learning'],['conversation_candidate','unified-learning'],['activation','fast']]);
  assert.equal(store.state.settings.overrideModelIds.material,'paper');
  assert.equal(store.state.settings.overrideModelIds.conversation_signal,'fast');
  assert.deepEqual(store.state.credentials,before);
  assert.equal(store.state.settings.connections[0].revision,revision);
  assert.ok(service.config().taskRoutes.every(t=>!t.conflict));
  assert.equal(store.state.runs.find(r=>r.task==='conversation_candidate').taskGroup,'conversation_learning');
});

void test('default changes propagate to both learning stages without overriding maintenance or activation', async t => {
  const {service}=await fixture(t,{generate:async c=>({...response,modelId:c.modelId})});
  await service.saveConnection({...connection(),apiKey:'fixture'});
  const route={routingVersion:2,defaultConnectionId:'primary',defaultModelId:'first',
    overrides:{maintenance:'primary',activation:'primary',conversation_learning:null},
    overrideModelIds:{maintenance:'research',activation:'fast'},fallback:{enabled:false,connectionId:null}};
  await service.routing(route);
  await service.routing({...route,defaultModelId:'second'});
  for(const task of ['conversation_signal','conversation_candidate'])assert.equal((await service.run({task,prompt:'test'})).modelId,'second');
  assert.equal((await service.run({task:'material',prompt:'test'})).modelId,'research');
  assert.equal((await service.run({task:'activation',prompt:'test'})).modelId,'fast');
});

for (const previousVersion of [1, 2]) void test(`four routes preserve effective learning selections from version ${previousVersion} and allow independent changes`, async t => {
  const {service,store}=await fixture(t,{generate:async c=>({...response,modelId:c.modelId})});
  await service.saveConnection({...connection('account'),apiKey:'fixture-secret'});
  await service.routing({routingVersion:previousVersion,defaultConnectionId:'account',defaultModelId:'default',
    overrides:{maintenance:'account',material:'account',conversation_learning:'account',conversation_signal:'account',conversation_candidate:'account'},
    overrideModelIds:{maintenance:'editor',material:'paper',conversation_learning:'current-learning',conversation_signal:'old-fast',conversation_candidate:'old-careful'},
    fallback:{enabled:false,connectionId:null}});
  const credentials=structuredClone(store.state.credentials), account=structuredClone(store.state.settings.connections[0]);
  const routes=service.config().taskRoutes;
  const detector=routes.find(t=>t.id==='conversation_signal'), learner=routes.find(t=>t.id==='conversation_learning');
  assert.equal(detector.modelId,previousVersion===1?'old-fast':'current-learning');
  assert.equal(learner.modelId,previousVersion===1?'old-careful':'current-learning');
  // Reading the new page must not activate dormant overrides from version 2.
  assert.equal(store.state.settings.routingVersion,previousVersion);
  assert.equal((await service.run({task:'conversation_signal',prompt:'detect'})).modelId,detector.modelId);
  const updated={routingVersion:3,defaultConnectionId:'account',defaultModelId:'default',
    overrides:Object.fromEntries(routes.map(t=>[t.id,t.connectionId])),
    overrideModelIds:Object.fromEntries(routes.map(t=>[t.id,t.modelId])),fallback:{enabled:false,connectionId:null}};
  await service.routing(updated);
  assert.equal(hydrateModelSettings(store.state.settings).routingVersion,3);
  assert.equal((await service.run({task:'conversation_candidate',prompt:'learn'})).modelId,learner.modelId);
  await service.routing({...updated,overrideModelIds:{...updated.overrideModelIds,conversation_signal:'new-fast'}});
  assert.equal((await service.run({task:'conversation_signal',prompt:'detect'})).modelId,'new-fast');
  assert.equal((await service.run({task:'conversation_candidate',prompt:'learn'})).modelId,learner.modelId);
  assert.equal(store.state.runs.find(r=>r.task==='conversation_signal').taskGroup,'conversation_signal');
  await service.routing({...updated,defaultModelId:'new-default',overrides:{...updated.overrides,conversation_signal:null},
    overrideModelIds:{...updated.overrideModelIds,conversation_signal:null}});
  assert.equal((await service.run({task:'conversation_signal',prompt:'detect'})).modelId,'new-default');
  assert.equal((await service.run({task:'conversation_candidate',prompt:'learn'})).modelId,learner.modelId);
  assert.equal((await service.run({task:'material',prompt:'paper'})).modelId,'editor');
  assert.deepEqual(store.state.credentials,credentials);
  assert.equal(store.state.settings.connections[0].revision,account.revision);
  assert.equal(store.state.settings.overrideModelIds.conversation_candidate,'old-careful');
});

void test('image declarations are model-specific and unsupported images never reach the provider',async t=>{
  const calls=[];
  const {service,store}=await fixture(t,{generate:async(c)=>{calls.push(c.modelId);return response;}});
  await service.saveConnection({...connection(),apiKey:'fixture',imageModelIds:['vision']});
  const route={routingVersion:2,defaultConnectionId:'primary',defaultModelId:'text',overrides:{},fallback:{enabled:false,connectionId:null}};
  await service.routing(route);
  const request={task:'material',prompt:'read image',messages:[{role:'user',content:[{type:'image',data:'aGVsbG8=',mimeType:'image/png'}]}]};
  await assert.rejects(service.run(request),{code:'unsupported_image'});
  assert.deepEqual(calls,[]);
  await service.routing({...route,defaultModelId:'vision'});
  await service.run(request);
  assert.deepEqual(calls,['vision']);
  assert.deepEqual(service.config().settings.connections[0].imageModelIds,['vision']);
  assert.deepEqual(hydrateModelSettings(store.state.settings).connections[0].imageModelIds,['vision']);
  assert.equal(validateConnection(connection('bad',{imageModelIds:[null]})),'请填写有效的图片模型 ID，每行一个，最多 50 个');
});

void test('real compatible adapter forwards images for a declared custom model',async t=>{
  const requests=[];
  const upstream=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push(JSON.parse(body));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const base={id:'image-test',object:'chat.completion.chunk',created:1,model:'vision-model'};
    res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]})}\n\n`);
    res.end(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  const url=await listen(t,upstream),{service}=await fixture(t);
  await service.saveConnection({...connection('vision',{baseUrl:url+'/v1',modelId:'vision-model',authType:'none',imageModelIds:['vision-model']})});
  const pixels='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZyQAAAAASUVORK5CYII=';
  await service.run({task:'material',prompt:'Read screenshot',messages:[{role:'user',content:[{type:'text',text:'Read screenshot'},{type:'image',data:pixels,mimeType:'image/png'}]}]});
  const user=requests[0].messages.find(m=>m.role==='user');
  assert.ok(user.content.some(p=>p.type==='image_url'&&p.image_url.url==='data:image/png;base64,'+pixels));
  assert.equal(requests[0].model,'vision-model');
});
