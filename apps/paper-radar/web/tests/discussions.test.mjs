import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DiscussionService } from '../server/discussions/service.mjs';
import { parseAnswer } from '../server/discussions/contracts.mjs';
import { createModelServer } from '../server/index.mjs';
import { fixture, context, subscription } from './helpers/daily-fixture.mjs';
import { OUTPUT_POLICY_VERSION } from '../server/output-policy.mjs';
async function setup(t, options = {}) {
  const f = await fixture(t, { count: 1, ...options });
  const discussions = new DiscussionService(f.analyses, f.daily, {
    executionMs: options.executionMs ?? 3000,
  });
  t.after(() => discussions.close());
  let calls = 0;
  const seen = [];
  const oldRun = f.models.run.bind(f.models);
  f.models.run = async (req, opts) => {
    if (req.task !== 'discussion') return oldRun(req, opts);
    await opts.beforeAttempt(f.models.store.state.settings.connections[0], { id: 'chat-' + (calls + 1), purpose: 'discussion' });
    calls++;
    seen.push(req);
    if (options.delay)
      await delay(options.delay, undefined, { signal: opts.signal });
    const out = {
      text: JSON.stringify({
        paragraphs: [
          {
            text: '这里需要保留 measurement-induced transport 的条件，不能外推为普遍定理。',
            evidence_ids: ['paper:2501.10000:1'],
          },
        ],
        limitations: ['仅依据当前论文和选定材料，尚未检索其他文献。'],
        claims: [],
      }),
      modelId: 'discussion-fixture',
      providerId: 'custom',
      requestId: 'chat-' + calls,
    };
    options.mutate?.(out, req, calls);
    opts.onAttempt?.({
      id: 'chat-' + calls,
      model_id: out.modelId,
      status: 'succeeded',
      usage: { input: 100, output: 50, cost: null },
    });
    return out;
  };
  const input = {
    arxiv_input: 'https://arxiv.org/abs/2501.10000v1',
    persona_connection_id: subscription.persona_connection_id,
    scope: subscription.scope,
    language: 'zh',
    summary_length: subscription.summary_length,
  };
  async function finish(turnId) {
    for (let i = 0; i < 3000; i++) {
      const v = discussions.repo.turn(turnId);
      if (!['queued', 'running'].includes(v.status)) return v;
      await delay(2);
    }
    throw Error('Discussion not finished');
  }
  return {
    ...f,
    discussions,
    input,
    seen,
    finishChat: finish,
    get chatCalls() {
      return calls;
    },
  };
}
void test('opening discussion never invokes a model or full analysis; explicit question persists only a scoped conversation', async (t) => {
  const f = await setup(t),
    c = f.discussions.create({ input: f.input }).conversation;
  assert.equal(f.chatCalls, 0);
  assert.equal(f.db.listJobs().length, 0);
  assert.equal(c.output_policy, OUTPUT_POLICY_VERSION);
  const sent = f.discussions.send(
    c.id,
    { question: '解释核心方法' },
    'chat-first-question',
  );
  await f.finishChat(sent.turn.id);
  const saved = f.discussions.get(c.id);
  assert.equal(saved.turns[0].status, 'succeeded');
  assert.equal(f.chatCalls, 1);
  assert.equal(f.db.listJobs().length, 0);
  assert.deepEqual(saved.input.scope, context.scope);
  assert.equal(saved.persona.revision, context.revision);
  assert(!('context' in saved));
  assert(!('model_settings' in saved.turns[0]));
  assert(saved.turns[0].evidence_index.every((e) => !('text' in e)));
  assert.match(f.seen[0].systemPrompt, /canonical English/);
  assert.match(f.seen[0].prompt, /CURRENT USER QUESTION/);
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM feedback').get().n, 0);
});
void test('same question key is idempotent, conflicts are rejected and later questions receive the earlier discussion', async (t) => {
  const f = await setup(t),
    c = f.discussions.create({ input: f.input }).conversation;
  const first = f.discussions.send(
    c.id,
    { question: '第一个问题' },
    'chat-idempotent-one',
  );
  assert.equal(
    f.discussions.send(c.id, { question: '第一个问题' }, 'chat-idempotent-one')
      .turn.id,
    first.turn.id,
  );
  assert.throws(
    () =>
      f.discussions.send(c.id, { question: '不同问题' }, 'chat-idempotent-one'),
    { code: 'conflict' },
  );
  assert.throws(
    () =>
      f.discussions.send(
        c.id,
        { question: '另一个问题' },
        'chat-idempotent-two',
      ),
    { code: 'conflict' },
  );
  await f.finishChat(first.turn.id);
  const second = f.discussions.send(
    c.id,
    { question: '这个条件为什么重要？' },
    'chat-second-question',
  );
  await f.finishChat(second.turn.id);
  assert.equal(f.chatCalls, 2);
  assert.match(f.seen[1].prompt, /第一个问题/);
  assert.match(f.seen[1].prompt, /不能外推/);
  assert.equal(f.discussions.create({ input: f.input }).conversation.id, c.id);
  const other = f.discussions.create({
    input: f.input,
    new_conversation: true,
  }).conversation;
  assert.notEqual(other.id, c.id);
  assert.equal(other.turns.length, 0);
});
void test('report anchors pin exact report and evidence; different problems have separate resumable topics', async (t) => {
  const f = await setup(t);
  const run = await f.finish(f.create().run.id);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  const source = { daily_item_id: item.id, analysis_id: item.analysis_id };
  const c = f.discussions.create({
    ...source,
    anchor: { kind: 'summary', index: 0 },
  }).conversation;
  assert.equal(c.anchor.analysis_id, item.analysis_id);
  assert.match(c.anchor.text, /第1节/);
  assert.equal(
    f.discussions.create({ ...source, anchor: { kind: 'summary', index: 0 } })
      .conversation.id,
    c.id,
  );
  assert.notEqual(
    f.discussions.create({ ...source, anchor: { kind: 'summary', index: 1 } })
      .conversation.id,
    c.id,
  );
  const sent = f.discussions.send(
    c.id,
    { question: '这个前提是否成立？' },
    'chat-anchor-question',
  );
  await f.finishChat(sent.turn.id);
  assert.match(f.seen[0].prompt, /第1节/);
  assert.match(f.seen[0].systemPrompt, /challenge false premises/i);
  assert.throws(
    () =>
      f.discussions.create({
        ...source,
        anchor: { kind: 'summary', index: 90 },
      }),
    { code: 'invalid_anchor' },
  );
  assert.throws(
    () =>
      f.discussions.create({
        ...source,
        anchor: { kind: 'selection', quote: '不是报告里的文字' },
      }),
    { code: 'invalid_anchor' },
  );
  assert(
    f.discussions.create({
      ...source,
      anchor: { kind: 'selection', quote: '论文在明确条件下研究测量输运' },
    }).conversation.anchor,
  );
  const archived = f.db.db.prepare('SELECT id,data FROM discussions').all();
  assert.ok(archived.length > 0);
  await f.daily.deleteReport(run.report_id);
  for (const record of archived) {
    const kept = f.db.db.prepare('SELECT data,analysis_id,daily_item_id FROM discussions WHERE id=?').get(record.id);
    assert.equal(kept.data, record.data);
    assert.equal(kept.analysis_id, null);
    assert.equal(kept.daily_item_id, null);
  }
  assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(), []);
});
void test('citations and personal claims must match the exact supplied evidence and original record fields', () => {
  const base = {
    paragraphs: [{ text: 'claim', evidence_ids: [context.evidence[0].id] }],
    limitations: [],
    claims: [
      {
        record_id: context.records[0].id,
        field: 'interest_level',
        value: 'medium',
      },
    ],
  };
  assert(parseAnswer(JSON.stringify(base), context.evidence, context.records));
  assert.throws(
    () =>
      parseAnswer(
        JSON.stringify({
          ...base,
          claims: [{ ...base.claims[0], value: 'high' }],
        }),
        context.evidence,
        context.records,
      ),
    { code: 'invalid_claim' },
  );
  assert.throws(
    () =>
      parseAnswer(
        JSON.stringify({
          ...base,
          paragraphs: [
            { text: 'claim', evidence_ids: ['private-other-record'] },
          ],
        }),
        context.evidence,
        context.records,
      ),
    { code: 'invalid_reference' },
  );
});
void test('invalid Agent citations fail validation and never become accepted', async (t) => {
  const f = await setup(t, {
    mutate: (out) => {
      out.text = JSON.stringify({
        paragraphs: [{ text: 'unsupported', evidence_ids: ['unknown'] }],
        limitations: [],
        claims: [],
      });
    },
  });
  const c = f.discussions.create({ input: f.input }).conversation,
    s = f.discussions.send(c.id, { question: '核查' }, 'chat-invalid-ref');
  const finished = await f.finishChat(s.turn.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.answer, null);
  assert.equal(f.chatCalls, 1);
  assert.equal(finished.error.code, 'invalid_reference');
});
void test('cancelled questions do not accept late answers and explicit retry can finish', async (t) => {
  const f = await setup(t, { delay: 60 }),
    c = f.discussions.create({ input: f.input }).conversation;
  const sent = f.discussions.send(
    c.id,
    { question: '解释假设' },
    'chat-cancel-me',
  );
  await delay(10);
  f.discussions.cancel(sent.turn.id);
  await delay(70);
  assert.equal(f.discussions.repo.turn(sent.turn.id).status, 'cancelled');
  assert.equal(f.discussions.repo.turn(sent.turn.id).answer, null);
  f.discussions.retry(sent.turn.id, 'chat-retry-me');
  const completed = await f.finishChat(sent.turn.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(f.discussions.get(c.id).turns.length, 1);
});
void test('timeout terminates a turn and service interruption leaves a resumable persisted message', async (t) => {
  const f = await setup(t, { delay: 80, executionMs: 15 }),
    c = f.discussions.create({ input: f.input }).conversation;
  const sent = f.discussions.send(
    c.id,
    { question: '超时测试' },
    'chat-timeout-test',
  );
  const turn = await f.finishChat(sent.turn.id);
  assert.equal(turn.status, 'failed');
  assert.equal(turn.error.code, 'timeout');
  f.discussions.executionMs = 3000;
  const second = f.discussions.send(
    c.id,
    { question: '重启测试' },
    'chat-restart-test',
  );
  await delay(10);
  await f.discussions.close();
  assert.equal(f.discussions.repo.turn(second.turn.id).status, 'interrupted');
  const restored = new DiscussionService(f.analyses, f.daily);
  restored.retry(second.turn.id, 'chat-restart-retry');
  for (
    let i = 0;
    i < 500 && restored.repo.turn(second.turn.id).status !== 'succeeded';
    i++
  )
    await delay(2);
  assert.equal(restored.repo.turn(second.turn.id).status, 'succeeded');
  await restored.close();
});
void test('scope changes isolate conversations and evidence cannot be fetched through another conversation', async (t) => {
  const f = await setup(t),
    c = f.discussions.create({ input: f.input }).conversation,
    s = f.discussions.send(c.id, { question: '读取' }, 'chat-scope-one');
  await f.finishChat(s.turn.id);
  const other = f.discussions.create({
    input: {
      ...f.input,
      scope: { tag_ids: [], tag_match: 'any' },
      persona_connection_id: null,
    },
  }).conversation;
  assert.notEqual(other.id, c.id);
  assert.equal(other.related.length, 1);
  const evidence = f.discussions.evidence(
    c.id,
    s.turn.id,
    'paper:2501.10000:1',
  );
  assert.match(evidence.text, /Controlled/);
  assert.throws(
    () => f.discussions.evidence(other.id, s.turn.id, 'paper:2501.10000:1'),
    { code: 'not_found' },
  );
  await f.discussions.delete(c.id);
  assert.throws(() => f.discussions.get(c.id), { code: 'not_found' });
  assert.equal(f.discussions.get(other.id).turns.length, 0);
});
void test('a Persona service returning another scope is rejected before a model call', async (t) => {
  const f = await setup(t);
  const scopeReader = f.analyses.persona.scopeReader;
  f.analyses.persona.scopeReader = async (...args) => ({ ...(await scopeReader(...args)), scope: { tag_ids: ['unselected'], tag_match: 'any' } });
  const c = f.discussions.create({ input: f.input }).conversation,
    s = f.discussions.send(c.id, { question: '材料联系' }, 'chat-wrong-scope');
  const turn = await f.finishChat(s.turn.id);
  assert.equal(turn.error.code, 'out_of_scope');
  assert.equal(f.chatCalls, 0);
});
void test('removed discussion endpoints reject legacy links without changing stored history or calling models', async (t) => {
  const f = await setup(t);
  const c = f.discussions.create({ input: f.input }).conversation;
  const before = f.db.db.prepare('SELECT data FROM discussions WHERE id=?').get(c.id).data;
  const server = createModelServer(f.models, { analyses: f.analyses, daily: f.daily, publicDirectory: '/none' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' };
  const cap = await (await fetch(base + '/api/capabilities')).json();
  assert.equal(cap.paper_discussion, false);
  for (const [method, path] of [
    ['POST', '/api/discussions'],
    ['GET', '/api/discussions/' + c.id],
    ['POST', '/api/discussions/' + c.id + '/messages'],
    ['POST', '/api/discussion-messages/old-turn/retry'],
    ['POST', '/api/discussion-handoff/prepare'],
    ['GET', '/api/discussion-handoff/destinations'],
  ]) {
    const response = await fetch(base + path, { method, headers, ...(method === 'POST' ? { body: JSON.stringify({ input: f.input, question: 'Old client request' }) } : {}) });
    assert.equal(response.status, 404, path);
  }
  assert.equal(f.chatCalls, 0);
  assert.equal(f.db.db.prepare('SELECT data FROM discussions WHERE id=?').get(c.id).data, before);
});

void test('a follow-up on a long paper retains the previous answer source even without repeating keywords', async (t) => {
  const f = await setup(t, {
    mutate: (out) => {
      out.text = JSON.stringify({
        paragraphs: [
          { text: '依据关键方法讨论。', evidence_ids: ['paper:2501.10000:16'] },
        ],
        limitations: [],
        claims: [],
      });
    },
  });
  const original = f.analyses.arxiv.get.bind(f.analyses.arxiv);
  f.analyses.arxiv.get = async (...args) => ({
    ...(await original(...args)),
    blocks: Array.from({ length: 16 }, (_, i) => ({
      id: `paper:2501.10000:${i + 1}`,
      kind: 'paragraph',
      text: (i === 15 ? 'specialmethod ' : 'irrelevant ') + 'x'.repeat(12000),
    })),
  });
  const c = f.discussions.create({ input: f.input }).conversation;
  const first = f.discussions.send(
    c.id,
    { question: '解释 specialmethod' },
    'long-paper-first',
  );
  await f.finishChat(first.turn.id);
  const second = f.discussions.send(
    c.id,
    { question: '你刚才的论证为什么成立？' },
    'long-paper-followup',
  );
  const t2 = await f.finishChat(second.turn.id);
  assert.equal(t2.status, 'succeeded');
  assert.equal(t2.coverage.complete, false);
  assert(t2.evidence.some((e) => e.id.startsWith('paper:2501.10000:16')));
});
