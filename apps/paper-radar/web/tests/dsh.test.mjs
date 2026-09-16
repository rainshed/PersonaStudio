import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, context, record } from './helpers/daily-fixture.mjs';
import { DshModelService } from '../server/hosts/dsh/models.mjs';
import { DshOperations } from '../server/integrations/dsh/operations.mjs';
import { DiscussionService } from '../server/discussions/service.mjs';
import { HostModels } from 'paper-radar-dsh-plugin/host-models';
import { HostAgents } from 'paper-radar-dsh-plugin/host-agents';
import { fakeAgents } from './helpers/dsh-agent.mjs';
import { readJson, sendJson, PROTOCOL } from '../server/hosts/transport.mjs';
import { TASKS } from '@paper-radar/host-contract/routing';
import { safeError } from '../server/analyses/contracts.mjs';
import { PromptAPI } from '../server/prompts/http.mjs';
import { createModelServer } from '../server/index.mjs';

async function setup(t, { count = 1, onAgentRequest, compactAtStep, readingSteps = 0 } = {}) {
  const f = await fixture(t, { count });
  const root = await mkdtemp(join(tmpdir(), 'radar-dsh-')), socketPath = join(root, 'host.sock');
  const calls = [], defaults = { provider: 'fixture-host', model: 'summary', reasoningEffort: 'medium' };
  const info = (model) => ({ provider: 'fixture-host', id: model, name: model, context: { contextWindow: 500000 }, defaultMaxTokens: 12000, reasoning: { efforts: ['low', 'medium', 'high'].map((id) => ({ id, name: id })), defaultEffort: 'medium' } });
  const resolve = async (c) => {
    if (c.reasoningEffort && !info(c.model).reasoning.efforts.some((e) => e.id === c.reasoningEffort)) throw Object.assign(new Error('Unsupported effort'), { code: 'INVALID_REASONING_EFFORT' });
    return { ...c, reasoningEffort: c.reasoningEffort ?? 'medium' };
  };
  const hooks=new Map(),compactions=[];
  const host = new HostModels({ on:(name,fn)=>{hooks.set(name,fn);return ()=>hooks.delete(name);}, agentPresets:{serviceFor:()=>undefined}, agents: fakeAgents({readingSteps,beforeStep:async({step,sessionId})=>{
    if(compactAtStep===step){const call={sessionId,purpose:'compaction',provider:'wrong',model:'wrong'};for await(const _chunk of await hooks.get('llm/stream')(call,async function*(){compactions.push({...call});yield {type:'usage',usage:{inputTokens:11,outputTokens:5}};yield {type:'finish',reason:{kind:'stop'}};})){} }
  },onRequest:(request) => { calls.push(request); return onAgentRequest?.(request); }}), agentDefaultModel: { currentSelection: () => defaults }, llm: {
    listProviders: () => [{ id: 'fixture-host', name: 'Test DSH' }], listModels: async () => TASKS.map(({ id }) => info(id)), resolveModelInfo: async (_, model) => info(model), resolveCallConfig: resolve,
    prepareCall: async (config) => ({ config: await resolve(config), context: info(config.model).context, async *stream(options) {
      calls.push(options);
      const prompt = options.messages[0].content[0].text;
      const output = options.model === 'discussion' ? { text: JSON.stringify({ paragraphs: [{ text: 'The supplied evidence describes controlled transport.', evidence_ids: [prompt.match(/paper:[\w.]+:1/)[0]] }], limitations: [], claims: [] }) }
        : await f.models.run({ task: options.model, prompt }, { signal: options.signal });
      yield { type: 'text-delta', text: output.text }; yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 30 } }; yield { type: 'finish', reason: { kind: 'stop' } };
    } }),
  } });
  const agents = new HostAgents(host.ctx,host);
  const bridge = createServer(async (req, res) => {
    const input = await readJson(req), controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try { sendJson(res, 200, req.url === '/catalog' ? await host.catalog() : req.url === '/snapshot' ? await host.snapshot(input, controller.signal) : req.url === '/resolve' ? await host.resolve(input, controller.signal) : req.url === '/agent/start' ? agents.start(input) : req.url === '/agent/status' ? agents.status(input) : req.url === '/agent/cancel' ? agents.cancel(input) : await host.generate(input, controller.signal)); }
    catch (e) { sendJson(res, e.httpStatus ?? 400, safeError(e)); }
  });
  await new Promise((resolve) => bridge.listen(socketPath, resolve));
  const models = await new DshModelService({ socketPath, directory: join(root, 'preferences') }).open();
  const routing = structuredClone(models.routes);
  for (const { id } of TASKS) { routing.assignments[id] = 'custom'; routing.tasks[id] = { model: { provider: 'fixture-host', model: id }, reasoningEffort: id === 'screen' ? 'low' : 'high' }; }
  await models.routing(routing);
  f.analyses.models = models; f.daily.models = models;
  const discussions = new DiscussionService(f.analyses, f.daily);
  const operations = new DshOperations({ analyses: f.analyses, daily: f.daily, discussions, models, publicOrigin: 'https://papers.example.test' });
  t.after(async () => { await discussions.close(); await models.close(); await agents.close(); host.close(); bridge.closeAllConnections(); await new Promise((resolve) => bridge.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { ...f, models, host, bridge, calls, defaults, operations, discussions, compactions };
}
const hostRef = { protocol: PROTOCOL, runtimeId: 'test-runtime', sessionId: null };
async function waitJob(f, id) {
  for (let i = 0; i < 500; i++) { const job = f.analyses.getJob(id); if (!['running', 'queued'].includes(job.status)) return job; await delay(10); }
  throw new Error('Analysis did not settle');
}
void test('plugin path uses a daily agent and a single full-analysis agent without independent model accounts', async (t) => {
  const f = await setup(t);
  const response = await f.operations.dispatch({ operation: 'daily', host: hostRef, request_id: 'dsh-daily-request', input: { subscription_id: f.sub.id, expected_subscription_revision: f.sub.revision, source: { kind: 'latest_announcement' } } });
  const run = await f.finish(response.card.id); assert.equal(run.status, 'completed');
  const item = f.repo.items(run.id)[0];
  const detail = await f.operations.dispatch({ operation: 'detail', id: item.id, host: hostRef, request_id: 'dsh-detail-request' });
  const job = await waitJob(f, detail.card.id); assert.equal(job.status, 'succeeded');
  const contextRun = f.analyses.prompts.contextRuns().find(r => r.origin === job.id);
  const contextEvents = f.analyses.prompts.contextRun(contextRun.id).events;
  assert(contextEvents.some(event => event.kind === 'host_input' && event.source === 'dsh'));
  assert(contextEvents.some(event => event.kind === 'tool_result'));
  assert.ok(f.analyses.getResult(job.result_id).personalization.data.matched_knowledge_ids.length>0);
  assert.ok(f.calls.some((c) => c.model === 'screen' && c.reasoningEffort === 'low'));
  assert.ok(f.calls.some(c=>c.model==='single'&&c.reasoningEffort==='high'));
  assert.equal(f.calls.some(c=>['summary','connections','review'].includes(c.model)),false);
  assert.equal(f.models.store.state.credentials, undefined);
  assert.equal((await f.models.config()).mode, 'dsh');
  assert.ok(detail.card.url.startsWith('https://papers.example.test/'));
  const before = f.calls.length;
  const replay = await f.operations.dispatch({ operation: 'detail', id: item.id, host: hostRef, request_id: 'dsh-detail-request' });
  assert.equal(replay.card.id, detail.card.id); assert.equal(f.calls.length, before);
  const previous = f.daily.getItem(item.id);
  const rescreen = await f.operations.dispatch({operation:'rescreen',id:item.id,host:hostRef,request_id:'dsh-rescreen'});
  assert.equal((await f.finish(rescreen.card.id)).status,'completed');
  const changed = f.daily.getItem(item.id);
  assert.notEqual(changed.screening.id,previous.screening.id);
  assert.equal(changed.current_version_id,previous.current_version_id);
  assert.equal(changed.analysis_id,previous.analysis_id);
});
void test('task snapshots freeze effort and reject invalid saved choices before execution', async (t) => {
  const f = await setup(t), old = structuredClone(f.models.store.state.settings);
  const routing = structuredClone(f.models.routes); routing.tasks.summary.reasoningEffort = 'low';
  await f.models.routing(routing);
  assert.equal(old.dsh.selections.summary.reasoningEffort, 'high');
  assert.equal(f.models.store.state.settings.dsh.selections.summary.reasoningEffort, 'low');
  const bad = structuredClone(f.models.routes); bad.tasks.summary.reasoningEffort = 'unsupported';
  await assert.rejects(f.models.routing(bad), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(f.calls.length, 0);
  let attempts = 0;
  await assert.rejects(f.models.run({ task: 'summary', prompt: 'unused' }, { settings: old, beforeAttempt() { attempts++; throw Object.assign(new Error('budget exhausted'), { code: 'budget_exceeded' }); } }), { code: 'budget_exceeded' });
  assert.equal(attempts, 1); assert.equal(f.calls.length, 0);
});
void test('agent prompts cannot be accidentally run as tool-less workbench experiments', async (t) => {
  const f=await setup(t), api=new PromptAPI(f.analyses.prompts,f.models);
  assert.throws(()=>api.start({prompt_id:'paper-radar.screen-agent'}),{code:'agent_task_required'});
  assert.equal(f.calls.length,0);await api.close();
});
void test('the host callback blocks an agent follow-up beyond budget and releases all model permits', async (t) => {
  const f=await setup(t), selected=structuredClone(context);
  selected.records=Array.from({length:20},(_,i)=>({...record,id:`knowledge-${i}`}));
  selected.knowledge_ids=selected.records.map(r=>r.id);
  selected.evidence=selected.records.map(r=>({id:`persona:${r.id}:r2`,record_id:r.id,text:r.title}));
  f.daily.persona.screeningSnapshot=async()=>selected;
  f.sub.max_model_calls=2;f.repo.saveSubscription(f.sub);
  const run=await f.finish(f.create('host-agent-budget').run.id);
  assert.equal(run.status,'paused');assert.equal(run.actual_attempts,2);assert.equal(f.calls.length,2);assert.equal(f.models.running,0);
  assert.equal(f.models.agentClient.tasks.size,0);assert.equal(f.repo.items(run.id)[0].screening_version_id,null);
});
void test('DSH no longer exposes discussion operations or starts discussion model calls', async (t) => {
  const f = await setup(t);
  const status = await f.operations.dispatch({ operation: 'status' });
  assert.equal(status.capabilities.discussion, false);
  for (const operation of ['discussion', 'discussions', 'create-discussion', 'ask', 'cancel-answer', 'retry-answer']) {
    await assert.rejects(f.operations.dispatch({ operation, id: 'old-discussion', request_id: 'retired-discussion', input: { question: 'Old request' }, host: hostRef }), { code: 'invalid_request' });
  }
  assert.equal(f.calls.length, 0);
});
void test('host outage fails explicitly and never uses any legacy credentials', async (t) => {
  const f = await setup(t), settings = structuredClone(f.models.store.state.settings);
  f.models.socketPath += '.missing';
  await assert.rejects(f.models.run({ task: 'summary', prompt: 'hello' }, { settings }), { code: 'dsh_unavailable' });
  assert.equal(f.calls.length, 0);
  const config = await f.models.config(); assert.equal(config.connected, false); assert.equal(config.mode, 'dsh');
  assert.ok((await f.operations.dispatch({ operation: 'subscriptions' })).data.subscriptions.length);
});
void test('web and native submissions with different keys share an active analysis and preserve aliases', async (t) => {
  const f = await setup(t);
  const input = { arxiv_input: '2501.12903', scope: { tag_ids: [], tag_match: 'any' }, language: 'zh', summary_length: { min: 200, max: 400 } };
  const web = f.analyses.create(input, 'web-submit-once');
  const [native, reconnected] = await Promise.all([1, 2].map(() => f.operations.dispatch({ operation: 'analyze', host: hostRef, request_id: 'native-submit-once', input })));
  assert.equal(reconnected.card.id, native.card.id);
  assert.equal(native.card.id, web.job.id);
  await waitJob(f, web.job.id);
  assert.equal((await f.operations.dispatch({ operation: 'analyze', host: hostRef, request_id: 'native-submit-once', input })).card.id, web.job.id);
  assert.equal(f.db.listJobs().length, 1);
  assert.equal(f.calls.filter((c) => c.model === 'single').length, 1);
  assert.throws(() => f.analyses.create({ ...input, language: 'en' }, 'web-submit-once'), { code: 'conflict' });
});
void test('large scoped records are delivered through bounded tools instead of stuffing the analysis prompt', async (t) => {
  const f = await setup(t), original = f.analyses.persona.records.bind(f.analyses.persona);
  f.analyses.persona.records = async (...args) => {
    const value=await original(...args);value.records[0].body='x'.repeat(310000);return value;
  };
  const input = { arxiv_input: '2501.12903', persona_connection_id: 'persona-test', scope: { tag_ids: ['tag-physics'], tag_match: 'any' }, language: 'zh', summary_length: { min: 200, max: 400 } };
  const job = await waitJob(f, f.analyses.create(input, 'large-persona-once').job.id);
  assert.equal(job.status, 'succeeded',JSON.stringify(job.error));
  const result=f.analyses.getResult(job.result_id);assert.equal(result.summary.status,'available');assert.equal(result.personalization.status,'available');
  assert.ok(f.calls.every(c=>JSON.stringify(c.messages).length<10000));
  assert.equal(f.calls.some(c=>['connections','review'].includes(c.model)),false);
});
void test('full analysis completes beyond 200 calls and two hours, including metered compaction', async (t) => {
  let elapsed = 0;
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    const controller = new AbortController();
    deadlines.push({ at: elapsed + ms, controller });
    return controller.signal;
  });
  const f = await setup(t, { readingSteps: 204, compactAtStep: 13, onAgentRequest: () => {
    if (elapsed) return;
    // Advance while the model is thinking, after admission has completed.
    elapsed = 2 * 60 * 60000;
    for (const deadline of deadlines)
      if (deadline.at <= elapsed) deadline.controller.abort(new DOMException('Expired', 'TimeoutError'));
  } });
  const input = { arxiv_input: '2501.12903', scope: { tag_ids: [], tag_match: 'any' }, language: 'zh', summary_length: { min: 200, max: 400 } };
  const job = await waitJob(f, f.analyses.create(input, 'unlimited-full-analysis').job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(f.calls.length, 205);
  assert.equal(job.actual_attempts, 206);
  assert.equal(f.db.attempts(job.id).length, 206);
  assert.equal(f.compactions.length, 1);
  const contextRun = f.analyses.prompts.contextRuns().find(r => r.origin === job.id);
  const events = f.analyses.prompts.contextRun(contextRun.id).events;
  assert(events.some(event => event.kind === 'compaction'));
  assert.equal(f.analyses.getResult(job.result_id).summary.status, 'available');
  assert.equal(f.models.running, 0);
});
void test('unlimited analysis can be cancelled while waiting for model capacity', async (t) => {
  const f = await setup(t);
  await f.models.routing({ ...f.models.routes, concurrency: 1 });
  const release = await f.models.acquire(new AbortController().signal);
  const input = { arxiv_input: '2501.12903', scope: { tag_ids: [], tag_match: 'any' }, language: 'zh', summary_length: { min: 200, max: 400 } };
  const { job } = f.analyses.create(input, 'cancel-unlimited-analysis');
  await waitUntil(() => f.models.waiters.length === 1);
  assert.equal(f.analyses.cancel(job.id).status, 'cancelled');
  await waitUntil(() => f.models.waiters.length === 0);
  release();
  await waitUntil(() => f.models.agentClient.tasks.size === 0);
  assert.equal(f.analyses.getJob(job.id).status, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(f.models.running, 0);
});
void test('prompt workbench lists host task choices and runs a pinned review without legacy accounts', async (t) => {
  const f = await setup(t), api = new PromptAPI(f.analyses.prompts, f.models);
  t.after(() => api.close());
  const config = await api.dispatch('GET', 'models');
  assert.equal(config.settings.accounts, undefined);
  assert.equal(config.settings.connections.length, 6);
  assert.ok(config.settings.connections.every((c) => c.id.startsWith('dsh:')));
  const experiment = api.start({ prompt_id: 'paper-radar.review', connection_id: 'dsh:review' });
  for (let i = 0; i < 200 && api.active.has(experiment.id); i++) await delay(10);
  const result = f.analyses.prompts.record('experiments', experiment.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.model.reasoningEffort, 'high');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, 'review');
});

async function waitUntil(check) {
  for (let i=0;i<500;i++) { if(check()) return; await delay(2); }
  throw new Error('Expected concurrency state did not arrive');
}
void test('one saved limit controls real adapter agent creation and simultaneous model requests at 1 and 6', async(t)=>{
  for(const concurrency of [1,6]) await t.test(`limit ${concurrency}`,async(t)=>{
    let active=0,peak=0;const sessions=new Set();
    const gate=Promise.withResolvers();
    t.after(()=>gate.resolve());
    const f=await setup(t,{count:8,onAgentRequest:async()=>{
      active++;peak=Math.max(peak,active);
      for(const item of f.repo.items(f.daily.listRuns({limit:1})[0].id)) if(item.agent_progress?.session_id) sessions.add(item.agent_progress.session_id);
      await gate.promise;active--;
    }});
    await f.models.routing({...f.models.routes,concurrency});
    const id=f.create(`configured-concurrency-${concurrency}`).run.id;
    try { await waitUntil(()=>peak===concurrency); }
    finally { gate.resolve(); }
    const run=await f.finish(id);
    assert.equal(run.status,'completed');assert.equal(run.actual_attempts,8);
    assert.equal(peak,concurrency);assert.equal(sessions.size,8);assert.equal(f.models.running,0);
    assert.equal(f.models.concurrencyListeners.size,0);
  });
});
void test('saving concurrency resizes the live request queue, preserves active work and cleans up cancelled waiters',async(t)=>{
  const f=await setup(t),started=[],release=new Map();
  await f.models.routing({...f.models.routes,concurrency:2});
  const originalSettings=structuredClone(f.models.store.state.settings);
  f.models.runConnection=async(c,r)=>{started.push(r.prompt);await new Promise(resolve=>release.set(r.prompt,resolve));return {text:r.prompt};};
  const controllers=Array.from({length:6},()=>new AbortController());
  const jobs=controllers.map((controller,i)=>f.models.run({task:'summary',prompt:String(i)},{signal:controller.signal}));
  const finished=Promise.allSettled(jobs);
  await waitUntil(()=>started.length===2);
  await f.models.routing({...f.models.routes,concurrency:4});await waitUntil(()=>started.length===4);
  assert.deepEqual(f.models.store.state.settings,originalSettings);
  await f.models.routing({...f.models.routes,concurrency:1});
  controllers[5].abort();
  for(const id of ['0','1','2']) release.get(id)();
  await waitUntil(()=>f.models.running===1);assert.equal(started.length,4);
  release.get('3')();await waitUntil(()=>started.length===5);assert.equal(started.at(-1),'4');
  release.get('4')();const outcomes=await finished;
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,5);assert.equal(outcomes[5].status,'rejected');
  assert.equal(f.models.running,0);assert.equal(f.models.waiters.length,0);
  const reopened=await new DshModelService({directory:f.models.directory,socketPath:f.models.socketPath}).open();
  assert.equal((await reopened.config()).routing.concurrency,1);await reopened.close();
});
void test('concurrency validates integers, supports old settings and rejects stale saves without changing models',async(t)=>{
  const f=await setup(t),before=structuredClone(f.models.routes);
  assert.equal(before.concurrency,4);
  for(const concurrency of [0,-1,1.5,17,'4',null]) await assert.rejects(f.models.routing({...before,concurrency}),{code:'invalid_settings'});
  assert.deepEqual(f.models.routes,before);
  await f.models.routing({...before,concurrency:6});
  await assert.rejects(f.models.routing({...before,concurrency:3}),{code:'conflict'});
  const {concurrency:_concurrency,...oldClient}=f.models.routes;
  await f.models.routing(oldClient);assert.equal(f.models.concurrency,6);
  const file=join(f.models.directory,'routes.json'),saved=JSON.parse(await readFile(file,'utf8'));
  delete saved.concurrency;await writeFile(file,JSON.stringify(saved));
  const reopened=await new DshModelService({directory:f.models.directory,socketPath:f.models.socketPath}).open();
  assert.equal(reopened.concurrency,4);assert.deepEqual(reopened.routes.tasks,before.tasks);await reopened.close();
  assert.equal(f.calls.length,0);
});
void test('a lost agent run cancels its queued admission so lowering the limit cannot leave a stale slot owner',async(t)=>{
  const f=await setup(t);await f.models.routing({...f.models.routes,concurrency:1});
  const release=await f.models.acquire(new AbortController().signal),call=f.models.call.bind(f.models);
  f.models.call=(path,...args)=>{if(path==='/agent/status')throw Object.assign(new Error('host run disappeared'),{code:'agent_run_missing'});return call(path,...args);};
  const id=f.create('disappeared-queued-agent').run.id;
  await waitUntil(()=>f.models.waiters.length===1);
  assert.equal((await f.finish(id)).status,'partial');assert.equal(f.models.waiters.length,0);
  release();await delay(10);assert.equal(f.models.running,0);assert.equal(f.calls.length,0);
});
void test('native compaction stream is metered on the same task route and cannot exceed the shared budget',async t=>{
  const f=await setup(t,{compactAtStep:2}),selected=structuredClone(context);
  selected.records=Array.from({length:20},(_,i)=>({...record,id:`knowledge-${i}`}));selected.knowledge_ids=selected.records.map(r=>r.id);selected.evidence=selected.records.map(r=>({id:`persona:${r.id}:r2`,record_id:r.id,text:r.title}));
  f.daily.persona.screeningSnapshot=async()=>selected;f.sub.max_model_calls=2;f.repo.saveSubscription(f.sub);
  const run=await f.finish(f.create('native-compaction-meter').run.id);
  assert.equal(run.status,'paused');assert.equal(run.actual_attempts,2);assert.equal(f.calls.length,1);assert.equal(f.compactions.length,1);
  assert.equal(f.compactions[0].model,'screen');assert.equal(f.compactions[0].provider,'fixture-host');assert.equal(f.compactions[0].reasoningEffort,'low');
  assert.equal(f.models.running,0);assert.ok(f.models.runs.some(a=>a.purpose==='compaction'&&a.usage.input===11));
});

void test('preset routing persists, resolves real task selections and rejects invalid unused presets atomically', async t => {
  const f = await setup(t), draft = structuredClone(f.models.routes);
  draft.presets.fast = { model: { provider: 'fixture-host', model: 'screen' }, reasoningEffort: 'low' };
  draft.presets.deep = { model: { provider: 'fixture-host', model: 'single' }, reasoningEffort: 'high' };
  for (const { id } of TASKS) if (id !== 'discussion') draft.assignments[id] = id === 'screen' ? 'fast' : 'deep';
  const response = await f.models.routing(draft);
  assert.equal(response.routing.version, 2);
  for (const id of ['single', 'summary', 'connections', 'review']) assert.equal(f.models.base.dsh.selections[id].model, 'single');
  assert.equal(f.models.base.dsh.selections.discussion.model, 'discussion');
  const oldSnapshot = structuredClone(f.models.base), changed = structuredClone(f.models.routes);
  changed.presets.deep.reasoningEffort = 'medium'; await f.models.routing(changed);
  assert.equal(f.models.base.dsh.selections.summary.reasoningEffort, 'medium');
  assert.equal(oldSnapshot.dsh.selections.summary.reasoningEffort, 'high');
  const saved = await readFile(join(f.models.directory, 'routes.json'), 'utf8');
  const invalid = structuredClone(f.models.routes); for (const id of Object.keys(invalid.assignments)) invalid.assignments[id] = 'custom';
  invalid.presets.fast.reasoningEffort = 'unsupported';
  await assert.rejects(f.models.routing(invalid), { code: 'INVALID_REASONING_EFFORT' });
  assert.equal(await readFile(join(f.models.directory, 'routes.json'), 'utf8'), saved);
  const invalidAssignment = structuredClone(f.models.routes); invalidAssignment.assignments.single = 'unknown';
  await assert.rejects(f.models.routing(invalidAssignment), { code: 'invalid_settings' });
  const reopened = await new DshModelService({ directory: f.models.directory, socketPath: f.models.socketPath }).open();
  assert.deepEqual(reopened.routes, f.models.routes); await reopened.close();
  assert.equal(f.calls.length, 0);
});

void test('HTTP settings failures preserve actionable DSH error codes and status', async t => {
  const f = await setup(t), server = createModelServer(f.models, { publicDirectory: f.models.directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/models/routing`;
  const send = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paper-radar': '1' }, body: JSON.stringify(body) });
  const stale = await send({ ...f.models.routes, revision: -1 });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'conflict');
  const invalid = await send({ ...f.models.routes, concurrency: 0 });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, 'invalid_settings');
  const incompatible = structuredClone(f.models.routes); incompatible.presets.fast.reasoningEffort = 'unsupported';
  const effort = await send(incompatible);
  assert.equal(effort.status, 502); assert.equal((await effort.json()).code, 'INVALID_REASONING_EFFORT');
  assert.equal(f.calls.length, 0);
});

void test('discussion runs beyond the previous time and call caps through the host, including compaction', async t => {
  let elapsed = 0; const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    const controller = new AbortController(); deadlines.push({ at: elapsed + ms, controller }); return controller.signal;
  });
  const f = await setup(t, { readingSteps: 15, compactAtStep: 13, onAgentRequest: () => {
    if (elapsed) return;
    elapsed = 20 * 60000;
    for (const deadline of deadlines) if (deadline.at <= elapsed) deadline.controller.abort(new DOMException('Expired', 'TimeoutError'));
  } });
  assert.equal(f.discussions.executionMs, null); assert.equal(f.discussions.maxAttempts, null);
  const input = { arxiv_input: '2501.12903', scope: {tag_ids:[],tag_match:'any'}, language:'en',summary_length:{min:200,max:400} };
  const topic = f.discussions.create({input}).conversation;
  const {turn} = f.discussions.send(topic.id,{question:'Read as much as needed.'},'long-discussion-round');
  assert.equal(turn.max_attempts,null);
  await waitUntil(()=>!['running','queued'].includes(f.discussions.repo.turn(turn.id).status));
  const saved=f.discussions.repo.turn(turn.id);
  assert.equal(saved.status,'succeeded',JSON.stringify(saved.error));assert.equal(saved.actual_attempts,17);assert.equal(f.compactions.length,1);
  assert.ok(saved.started_at);assert.ok(saved.answer);assert.equal(f.models.running,0);
});

void test('retry removes an old discussion call cap and an unbounded discussion can be cancelled in the model queue',async t=>{
  const f=await setup(t); await f.models.routing({...f.models.routes,concurrency:1});
  const input={arxiv_input:'2501.12903',scope:{tag_ids:[],tag_match:'any'},language:'en',summary_length:{min:200,max:400}};
  const c=f.discussions.create({input}).conversation;
  const release=await f.models.acquire(new AbortController().signal);
  const {turn}=f.discussions.send(c.id,{question:'Check the result.'},'cancel-long-discussion');
  await waitUntil(()=>f.models.waiters.length===1);
  assert.equal(f.discussions.cancel(turn.id).status,'cancelled');
  await waitUntil(()=>f.models.waiters.length===0&&f.models.agentClient.tasks.size===0&&!f.discussions.controllers.has(turn.id));
  const old=f.discussions.repo.turn(turn.id);old.max_attempts=12;old.actual_attempts=12;f.discussions.repo.saveTurn(old);
  const retry=f.discussions.retry(turn.id,'retry-old-discussion-budget').turn;
  assert.equal(retry.max_attempts,null);assert.equal(retry.started_at,null);
  release();await waitUntil(()=>!['queued','running'].includes(f.discussions.repo.turn(turn.id).status));
  const result=f.discussions.repo.turn(turn.id);assert.equal(result.status,'succeeded',JSON.stringify(result.error));assert.equal(result.actual_attempts,13);
  assert.equal(f.models.running,0);assert.equal(f.models.waiters.length,0);
});
