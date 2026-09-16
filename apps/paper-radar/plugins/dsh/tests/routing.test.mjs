import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRoutes, selectRoute, validateChoice } from '../src/routing.mjs';
import { HostModels } from '../src/host-models.mjs';

const defaults = { provider: 'host', model: 'base', reasoningEffort: 'medium' };
test('task overrides and explicit effort are independent and do not mutate host defaults', () => {
  const routes = emptyRoutes(); routes.tasks.single = { model: { provider: 'host', model: 'full' }, reasoningEffort: 'high' };
  routes.tasks.summary = { model: { provider: 'host', model: 'fast' }, reasoningEffort: 'low' };
  const selected = selectRoute('summary', routes, defaults, { parent: 'single', explicit: { reasoningEffort: 'high' } });
  assert.equal(selected.model, 'fast'); assert.equal(selected.reasoningEffort, 'high'); assert.equal(defaults.model, 'base');
  assert.equal(selectRoute('connections', routes, defaults, { parent: 'single' }).model, 'full');
  assert.equal(selectRoute('screen', routes, defaults).model, 'base');
});
test('a different model never inherits the parent session effort', () => {
  const routes = emptyRoutes(); routes.tasks.summary.model = { provider: 'host', model: 'fast' };
  assert.equal(selectRoute('summary', routes, defaults, { session: { ...defaults, reasoningEffort: 'high' } }).reasoningEffort, undefined);
  assert.equal(selectRoute('screen', routes, defaults, { session: { ...defaults, reasoningEffort: 'high' } }).reasoningEffort, 'high');
  assert.throws(() => validateChoice({ apiKey: 'unwanted' }), { code: 'invalid_selection' });
});
function host() {
  const calls = [], metadata = { provider: 'host', id: 'base', context: { contextWindow: 100000 }, defaultMaxTokens: 4000, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } };
  const resolve = async (config) => {
    if (config.reasoningEffort && !metadata.reasoning.efforts.some((e) => e.id === config.reasoningEffort)) throw Object.assign(new Error('invalid effort'), { code: 'INVALID_REASONING_EFFORT' });
    return { ...config, reasoningEffort: config.reasoningEffort ?? 'medium' };
  };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ ...defaults }) }, llm: {
    resolveCallConfig: resolve, resolveModelInfo: async () => metadata,
    prepareCall: async (config) => ({ config: await resolve(config), context: metadata.context, async *stream(options) { calls.push(options); yield { type: 'text-delta', text: 'OK' }; yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } }),
  } };
  return { models: new HostModels(ctx), calls };
}
test('host rejects unsupported effort before provider I/O', async () => {
  const { models, calls } = host();
  await assert.rejects(models.resolve({ ...defaults, reasoningEffort: 'ultra' }), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(calls.length, 0);
});
test('actual host call receives selected model and effort; duplicate ID is not replayed', async () => {
  const { models, calls } = host();
  const input = { id: 'request-once', selection: { ...defaults, reasoningEffort: 'low' }, prompt: 'Hello', systemPrompt: 'Check', maxTokens: 128 };
  const result = await models.generate(input, new AbortController().signal);
  assert.equal(result.text, 'OK'); assert.equal(calls[0].reasoningEffort, 'low'); assert.equal(calls[0].model, 'base');
  assert.equal(calls[0].messages.length, 1); assert.equal(calls[0].messages[0].source.plugin, 'paper-radar');
  await assert.rejects(models.generate(input, new AbortController().signal), { code: 'duplicate_request' });
  assert.equal(calls.length, 1);
});
test('host context overflow never reaches a provider', async () => {
  const { models, calls } = host();
  await assert.rejects(models.generate({ id: 'too-large-request', selection: defaults, prompt: 'x'.repeat(300001), systemPrompt: '', maxTokens: 128 }, new AbortController().signal), { code: 'context_length' });
  assert.equal(calls.length, 0);
});
test('simultaneous duplicate requests cannot both enter provider preparation', async () => {
  const { models, calls } = host();
  const input = { id: 'concurrent-request', selection: defaults, prompt: 'Hello', systemPrompt: '', maxTokens: 128 };
  const first = models.generate(input, new AbortController().signal);
  await assert.rejects(models.generate(input, new AbortController().signal), { code: 'duplicate_request' });
  await first;
  assert.equal(calls.length, 1);
});
