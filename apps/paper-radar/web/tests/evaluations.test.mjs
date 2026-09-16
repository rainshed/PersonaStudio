import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers/daily-fixture.mjs';
import { hash } from '../server/analyses/contracts.mjs';
import { usageForItems } from '../server/evaluations/scoring.mjs';
import { scoreItems, expectedOutcome } from '../server/evaluations/scoring.mjs';

const answer = (task, decision = 'recommended') => ({
  schema: task.output.schema,
  paper_version: task.paper.version,
  decision,
  introduction: 'A controlled synthetic test.',
  reason: 'Selected knowledge is relevant.',
  criterion_ids: ['selected-knowledge'],
  paper_evidence_ids: [task.paper.source_ref],
  persona_evidence_ids: [task.persona.records[0].source_ref],
  persona_coverage_ref: task.persona.source_ref,
  claims: [],
  open_questions: decision === 'needs_review' ? ['Unresolved comparison'] : [],
});
async function setup(t, { count = 2, readPaper = false } = {}) {
  const f = await fixture(t, { count });
  f.models.mode = 'dsh';
  const state = {
    requests: [],
    decision: () => 'recommended',
    delay: 0,
    readPaper,
    fail: false,
  };
  f.models.runAgent = async (request, options) => {
    const task = JSON.parse(request.prompt);
    state.requests.push({
      request: structuredClone(request),
      task,
      settings: structuredClone(options.settings),
    });
    const id = randomUUID();
    await options.beforeAttempt(options.settings.connections[0], {
      id,
      started_at: new Date().toISOString(),
    });
    if (state.delay)
      await delay(state.delay, undefined, { signal: options.signal });
    if (state.readPaper) {
      const outline = await options.onTool('paper_get_outline', {});
      await options.onTool('paper_read_section', {
        section_id: outline.sections[0].id,
      });
    }
    if (state.fail)
      throw Object.assign(new Error('fixture provider result unknown'), {
        code: 'network_failed',
      });
    const data = answer(task, state.decision(task, options.settings));
    await options.onTool('screening_submit_result', data);
    options.onAttempt({
      id,
      status: 'succeeded',
      duration_ms: 3,
      usage: { input: 13, output: 7, cost: null },
    });
    return {
      data,
      providerId: 'fixture',
      modelId: 'fixture-model',
      requestId: id,
    };
  };
  const run = await f.finish(f.create().run.id);
  const versions = f.repo.items(run.id).map((i) => i.screening_version_id);
  return { ...f, e: f.daily.evaluations, state, run, versions };
}
const request = (value, revision = 0, reason = '') => ({
  value,
  reason,
  expected_feedback_revision: revision,
  idempotency_key: randomUUID(),
});
async function finish(e, id) {
  await e.work;
  const run = e.report(id);
  assert.ok(!['queued', 'running'].includes(run.status), run.status);
  return run;
}
function start(e, raw) {
  return e.start({
    ...raw,
    ...(!raw.preview_id
      ? { idempotency_key: raw.idempotency_key ?? randomUUID() }
      : {}),
  });
}
function suite(f, values = ['positive', 'negative']) {
  const cases = f.versions.map(
    (id, index) =>
      f.e.feedback(id, request(values[index % values.length])).case,
  );
  return {
    cases,
    suite: f.e.freeze({
      name: 'Synthetic only',
      case_ids: cases.map((c) => c.id),
    }),
  };
}

void test('all binary mappings and deterministic denominators include failure/abstention', () => {
  assert.equal(expectedOutcome('recommended', 'positive'), 'recommended');
  assert.equal(expectedOutcome('recommended', 'negative'), 'not_recommended');
  assert.equal(
    expectedOutcome('not_recommended', 'positive'),
    'not_recommended',
  );
  assert.equal(expectedOutcome('not_recommended', 'negative'), 'recommended');
  assert.throws(() => expectedOutcome('needs_fulltext', 'negative'));
  const items = [
    ['recommended', 'recommended'],
    ['not_recommended', 'not_recommended'],
    ['recommended', 'not_recommended'],
    ['not_recommended', 'recommended'],
  ].map(([expected_outcome, outcome]) => ({
    status: 'completed',
    expected_outcome,
    outcome,
  }));
  items.push(
    {
      status: 'needs_fulltext',
      expected_outcome: 'recommended',
      outcome: null,
    },
    {
      status: 'request_failed',
      expected_outcome: 'not_recommended',
      outcome: null,
    },
  );
  const s = scoreItems(items);
  assert.deepEqual([s.TP, s.TN, s.FP, s.FN], [1, 1, 1, 1]);
  assert.deepEqual(s.pass_rate, { numerator: 2, denominator: 6, value: 1 / 3 });
  assert.equal(s.coverage.value, 4 / 6);
  assert.equal(s.accuracy.value, 0.5);
  assert.equal(
    Object.values(s.states).reduce((a, b) => a + b),
    6,
  );
  assert.equal(scoreItems([]).accuracy.value, null);
});
void test('accuracy feedback is atomic, idempotent, revisioned, and never invokes models', async (t) => {
  const f = await setup(t, { count: 1 });
  const before = f.state.requests.length,
    raw = request('negative', 0, 'Private judgement');
  const first = f.e.feedback(f.versions[0], raw);
  assert.equal(first.case.expected_outcome, 'not_recommended');
  assert.equal(first.case.replay_status, 'ready');
  assert.deepEqual(f.e.feedback(f.versions[0], raw), first);
  assert.equal(f.e.cases().length, 1);
  assert.throws(
    () => f.e.feedback(f.versions[0], { ...raw, reason: 'changed' }),
    { code: 'conflict' },
  );
  assert.throws(() => f.e.feedback(f.versions[0], request('positive', 0)), {
    code: 'conflict',
  });
  const reason = f.e.feedback(
    f.versions[0],
    request('negative', 1, 'Only new reason'),
  ).case;
  assert.equal(reason.benchmark_revision, 1);
  assert.equal(reason.input_hash, first.case.input_hash);
  const flipped = f.e.feedback(f.versions[0], request('positive', 2)).case;
  assert.equal(flipped.expected_outcome, 'recommended');
  assert.equal(flipped.benchmark_revision, 2);
  assert.equal(f.state.requests.length, before);
  const saved = f.repo.feedback(f.versions[0]).accuracy;
  assert.equal(saved.feedback_revision, 3);
});
void test('nonbinary targets have no implicit correct answer', async (t) => {
  const f = await setup(t, { count: 1 });
  const v = f.repo.get('daily_item_versions', f.versions[0]);
  v.data.outcome = 'needs_fulltext';
  f.db.db
    .prepare('UPDATE daily_item_versions SET data=? WHERE id=?')
    .run(JSON.stringify(v), v.id);
  assert.throws(() => f.e.feedback(v.id, { value: 'negative' }), {
    code: 'ineligible',
  });
  assert.throws(
    () => f.daily.feedback(v.id, 'accuracy', { value: 'negative' }),
    { code: 'invalid_request' },
  );
  assert.deepEqual(f.daily.getVersion(v.id).feedback_dimensions, []);
  assert.equal(f.e.cases().length, 0);
});
void test('A/B uses current knowledge with no private labels or production mutation, paired improvements and regressions', async (t) => {
  const f = await setup(t);
  const { suite: s, cases } = suite(f);
  const settings = f.models.store.state.settings;
  settings.connections.push({ ...settings.connections[0], id: 'candidate-b' });
  const beforeVersions = f.db.db
    .prepare('SELECT count(*) n FROM daily_item_versions')
    .get().n;
  const beforePersona = f.repo.get('daily_runs', f.run.id).context;
  beforePersona.records[0].title = 'LIVE UPDATED PERSONA';
  const live = f.repo.get('daily_runs', f.run.id);
  live.context = beforePersona;
  f.repo.saveRun(live);
  const snapshot = f.analyses.persona.screeningSnapshot;
  f.analyses.persona.screeningSnapshot = async (...args) => {
    const current = await snapshot(...args);
    current.records[0].title = 'CURRENT KNOWLEDGE';
    return current;
  };
  f.state.decision = (task, settings) =>
    settings.overrides.screen === 'candidate-b'
      ? 'not_recommended'
      : 'recommended';
  const input = {
    suite_id: s.id,
    candidates: [
      { version: 'active' },
      { version: 'active', connection_id: 'candidate-b' },
    ],
  };
  const preview = f.e.preview(input);
  assert.equal(preview.cases, 2);
  assert.equal(f.state.requests.length, 2);
  const report = await finish(f.e, start(f.e, input).id);
  assert.equal(report.status, 'completed');
  assert.equal(report.scores.A.correct, 1, JSON.stringify(report.items));
  assert.equal(report.scores.B.correct, 1);
  assert.deepEqual(report.comparisons.map((v) => v.change).sort(), [
    'improvement',
    'regression',
  ]);
  assert.equal(report.actual_calls, 4);
  assert.equal(report.usage.input, 52);
  assert.equal(report.usage.cost, null);
  for (const { request, task, settings } of f.state.requests.slice(2)) {
    assert.ok(!JSON.stringify(request).includes('LIVE UPDATED PERSONA'));
    assert.ok(JSON.stringify(request).includes('CURRENT KNOWLEDGE'));
    assert.ok(!('expected_outcome' in task));
    assert.ok(!('feedback' in task));
    assert.equal(settings.fallback.enabled, false);
  }
  assert.equal(
    f.db.db.prepare('SELECT count(*) n FROM daily_item_versions').get().n,
    beforeVersions,
  );
  assert.equal(f.e.cases()[0].benchmark_revision, 1);
  assert.equal(cases.length, 2);
});
void test('current paper retrieval failure is distinct from an incorrect decision and never reports completed', async (t) => {
  const f = await setup(t, { count: 1 });
  const { suite: s } = suite(f);
  f.state.readPaper = true;
  f.analyses.arxiv.get = async () => {
    throw new Error('MUST NOT fetch');
  };
  const report = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}] }).id,
  );
  assert.equal(
    report.items[0].status,
    'input_failed',
    JSON.stringify(report.items),
  );
  assert.equal(report.status, 'failed');
  assert.equal(report.scores.A.accuracy.value, null);
  assert.equal(report.actual_calls, 0);
  assert.equal(report.scores.A.valid, 0);
  assert.equal(report.scores.A.total, 1);
});
void test('current paper remains testable after production history deletion', async (t) => {
  const f = await setup(t, { count: 1, readPaper: true });
  const { suite: s } = suite(f);
  await f.daily.deleteReport(f.run.report_id);
  const report = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}] }).id,
  );
  assert.equal(
    report.items[0].status,
    'completed',
    JSON.stringify(report.items),
  );
  assert.equal(report.scores.A.correct, 1, JSON.stringify(report.items));
});
void test('withdrawal invalidates explicit suites; reason-only updates preserve them; legacy cases run without snapshots', async (t) => {
  const f = await setup(t);
  const prepared = suite(f),
    cases = prepared.cases;
  let s = prepared.suite;
  f.e.feedback(f.versions[1], request('negative', 1, 'Reworded'));
  assert.equal(f.e.preview({ suite_id: s.id, candidates: [{}] }).cases, 2);
  f.e.withdraw(cases[0].id, {
    expected_feedback_revision: 1,
    idempotency_key: randomUUID(),
  });
  assert.throws(() => f.e.preview({ suite_id: s.id, candidates: [{}] }), {
    code: 'suite_changed',
  });
  const v = f.repo.get('daily_item_versions', f.versions[1]);
  delete v.input_snapshot_id;
  f.db.db
    .prepare('UPDATE daily_item_versions SET data=? WHERE id=?')
    .run(JSON.stringify(v), v.id);
  // A historical source without a snapshot still runs against current inputs.
  const first = f.e.cases().find((c) => c.id === cases[1].id);
  first.input_snapshot_id = null;
  first.input_hash = null;
  first.replay_status = 'input_missing';
  first.benchmark_revision++;
  f.e.repo.putCase(first);
  s = f.e.freeze({ name: 'Legacy synthetic', case_ids: [first.id] });
  const report = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}] }).id,
  );
  assert.equal(report.items[0].status, 'completed');
  assert.equal(report.scores.A.pass_rate.denominator, 1);
  assert.equal(report.actual_calls, 1);
});
void test('frozen suites enforce paper grouping across development and holdout', async (t) => {
  const f = await setup(t, { count: 1 });
  const { cases } = suite(f);
  f.e.freeze({ name: 'Dev', purpose: 'development', case_ids: [cases[0].id] });
  assert.throws(
    () =>
      f.e.freeze({ name: 'Held', purpose: 'holdout', case_ids: [cases[0].id] }),
    { code: 'conflict' },
  );
});
void test('budget pause and explicit resume retain attempts and fixed scoring denominator', async (t) => {
  const f = await setup(t);
  const { suite: s } = suite(f);
  let report = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}], max_calls: 1 }).id,
  );
  assert.equal(report.status, 'paused');
  assert.equal(report.actual_calls, 1);
  assert.equal(report.scores.A.total, 2);
  f.e.resume(report.id, { max_calls: 2 });
  report = await finish(f.e, report.id);
  assert.equal(report.status, 'completed');
  assert.equal(report.actual_calls, 2);
  assert.equal(
    report.items.reduce((n, i) => n + i.attempts.length, 0),
    2,
  );
});
void test('backup hashes are validated and withdrawal cannot be resurrected by import', async (t) => {
  const f = await setup(t, { count: 1 });
  const { cases } = suite(f);
  const backup = f.e.export();
  f.e.withdraw(cases[0].id, {
    expected_feedback_revision: 1,
    idempotency_key: randomUUID(),
  });
  assert.equal(f.e.import(backup).skipped, 1);
  assert.equal(f.e.cases()[0].state, 'withdrawn');
  const corrupt = structuredClone(backup);
  corrupt.inputs[0].item.paper.abstract = 'Tampered';
  assert.throws(() => f.e.import(corrupt), { code: 'invalid_request' });
});
void test('explicit cancel stops in-flight work and leaves fixed denominator; withdrawn sample stops only its calls', async (t) => {
  const f = await setup(t);
  const { suite: s, cases } = suite(f);
  f.state.delay = 100;
  const started = start(f.e, { suite_id: s.id, candidates: [{}] });
  while (f.state.requests.length < 3) await delay(1);
  f.e.withdraw(cases[0].id, {
    expected_feedback_revision: 1,
    idempotency_key: randomUUID(),
  });
  const report = await finish(f.e, started.id);
  assert.equal(report.status, 'partial');
  assert.equal(
    report.items.find((i) => i.case_id === cases[0].id).status,
    'withdrawn',
  );
  assert.equal(
    report.items.find((i) => i.case_id === cases[1].id).status,
    'completed',
  );
  assert.equal(report.scores.A.total, 2);
  const again = f.e.freeze({ name: 'Only active', case_ids: [cases[1].id] });
  const second = start(f.e, { suite_id: again.id, candidates: [{}] });
  while (f.e.report(second.id).actual_calls === 0) await delay(1);
  f.e.cancel(second.id);
  const cancelled = await finish(f.e, second.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.items[0].status, 'cancelled');
  assert.equal(cancelled.scores.A.pass_rate.denominator, 1);
});
void test('preview pins prompt content and rejected configuration change makes zero calls', async (t) => {
  const f = await setup(t, { count: 1 });
  const { suite: s } = suite(f);
  const raw = { suite_id: s.id, candidates: [{}] };
  const preview = f.e.preview(raw),
    before = f.state.requests.length;
  assert.throws(
    () => start(f.e, { ...raw, max_calls: 30, preview_id: preview.preview_id }),
    { code: 'preview_changed' },
  );
  assert.equal(f.state.requests.length, before);
  const pending = start(f.e, { ...raw, preview_id: preview.preview_id });
  assert.equal((await finish(f.e, pending.id)).scores.A.correct, 1);
});
void test('delete purges benchmark reference material and keeps a tombstone against backup resurrection', async (t) => {
  const f = await setup(t, { count: 1 });
  const { cases } = suite(f);
  const backup = f.e.export();
  f.e.withdraw(cases[0].id, {
    expected_feedback_revision: 1,
    idempotency_key: randomUUID(),
    remove: true,
  });
  const cleaned = f.e.export();
  assert.equal(cleaned.inputs.length, 0);
  assert.equal(cleaned.cases[0].source.original_result, undefined);
  assert.ok(
    !JSON.stringify(cleaned).includes('Selected knowledge is relevant'),
  );
  assert.equal(f.e.import(backup).skipped, 1);
  assert.equal(f.e.cases()[0].state, 'deleted');
});
void test('feedback and sample rollback together when event storage fails', async (t) => {
  const f = await setup(t, { count: 1 });
  f.db.db.exec(
    "CREATE TRIGGER fail_eval_event BEFORE INSERT ON evaluation_feedback_events BEGIN SELECT RAISE(ABORT,'fixture event failure'); END",
  );
  assert.throws(() => f.e.feedback(f.versions[0], request('positive')));
  assert.equal(f.e.cases().length, 0);
  assert.equal(f.repo.feedback(f.versions[0]).accuracy, undefined);
});
void test('current screening correlates hosts without a preflight attempt id', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await f.finish(f.create().run.id),
    v = f.repo.items(r.id)[0].screening_version_id,
    e = f.daily.evaluations;
  const c = e.feedback(v, request('positive')).case,
    s = e.freeze({ name: 'Legacy mock', case_ids: [c.id] });
  const report = await finish(
    e,
    start(e, { suite_id: s.id, candidates: [{}] }).id,
  );
  assert.equal(report.items[0].status, 'completed');
  assert.equal(report.actual_calls, 1);
  assert.equal(report.items[0].attempts.length, 1);
  assert.equal(report.usage.input, 10);
});
void test('persistent start idempotency avoids double spending and conflicts on changed configuration', async (t) => {
  const f = await setup(t, { count: 1 });
  const { suite: s } = suite(f),
    raw = { suite_id: s.id, candidates: [{}], idempotency_key: randomUUID() };
  const a = f.e.start(raw),
    b = f.e.start(raw);
  assert.equal(a.id, b.id);
  await finish(f.e, a.id);
  assert.equal(f.e.start(raw).id, a.id);
  assert.equal(f.state.requests.length, 2);
  assert.throws(() => f.e.start({ ...raw, max_calls: 2 }), {
    code: 'conflict',
  });
});
void test('known partial costs remain visibly incomplete and duplicate attempt callbacks are not double counted', async (t) => {
  const u = usageForItems([
    {
      attempts: [
        { id: 'a', usage: { input: 2, output: 3, cost: 0.1 } },
        { id: 'b', usage: { input: 4, output: 5, cost: null } },
        { id: 'a', usage: { input: 2, output: 3, cost: 0.1 } },
      ],
    },
  ]);
  assert.equal(u.input, 6);
  assert.equal(u.known_cost, 0.1);
  assert.equal(u.cost, null);
  assert.equal(u.cost_complete, false);
  assert.equal(u.calls, 2);
  const f = await setup(t, { count: 1 });
  const { suite: s } = suite(f),
    original = f.models.runAgent;
  f.models.runAgent = (req, opts) =>
    original(req, {
      ...opts,
      onAttempt: (a) => {
        opts.onAttempt(a);
        opts.onAttempt(a);
      },
    });
  const r = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}] }).id,
  );
  assert.equal(r.actual_calls, 1);
  assert.equal(r.usage.input, 13);
  assert.equal(r.items[0].attempts.length, 1);
});
void test('imports cannot alter frozen expected labels or restore deleted evidence payloads', async (t) => {
  const f = await setup(t, { count: 1 });
  const { suite: s, cases } = suite(f),
    bad = {
      schema: 'paper-radar.evaluations/v1',
      cases: [],
      inputs: [],
      suites: [structuredClone(s)],
    };
  bad.suites[0].id = 'tampered-suite';
  bad.suites[0].members[0].expected_outcome = 'not_recommended';
  bad.suites[0].hash = hash(bad.suites[0].members);
  assert.throws(() => f.e.import(bad), { code: 'invalid_request' });
  const backup = f.e.export();
  await f.daily.deleteReport(f.run.report_id);
  f.e.withdraw(cases[0].id, {
    remove: true,
    expected_feedback_revision: 1,
    idempotency_key: randomUUID(),
  });
  assert.equal(f.e.repo.all('screening_inputs').length, 0);
  f.e.import(backup);
  assert.equal(f.e.repo.all('screening_inputs').length, 0);
});
void test('autonomous benchmark rejects unsupported hosts before any model call', async (t) => {
  const f = await setup(t, { count: 1 });
  const { suite: s } = suite(f),
    before = f.state.requests.length;
  f.models.supportsAgents = false;
  assert.throws(() => f.e.preview({ suite_id: s.id, candidates: [{}] }), {
    code: 'incompatible',
  });
  assert.equal(f.state.requests.length, before);
});
void test('importing a truncated report retains the frozen denominator for every candidate', async (t) => {
  const f = await setup(t);
  const { suite: s } = suite(f);
  const r = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}, {}] }).id,
  );
  const backup = f.e.export();
  backup.runs[0].id = 'imported-truncated-run';
  backup.items = [];
  f.e.import(backup);
  const report = f.e.report('imported-truncated-run');
  assert.equal(report.items.length, 4);
  assert.equal(report.scores.A.total, 2);
  assert.equal(report.scores.B.total, 2);
  assert.equal(report.scores.A.correct, 0);
  assert.ok(report.items.every((i) => i.status === 'result_unknown'));
  assert.equal(r.scores.A.total, 2);
});
void test('a token-budget pause resumes only after an explicit valid budget increase', async (t) => {
  const f = await setup(t);
  const { suite: s } = suite(f);
  let r = await finish(
    f.e,
    start(f.e, { suite_id: s.id, candidates: [{}], token_budget: 1 }).id,
  );
  assert.equal(r.status, 'paused');
  assert.equal(r.actual_calls, 1);
  assert.throws(() => f.e.resume(r.id, { token_budget: 0 }), {
    code: 'invalid_request',
  });
  f.e.resume(r.id, { token_budget: 100 });
  r = await finish(f.e, r.id);
  assert.equal(r.status, 'completed');
  assert.equal(r.actual_calls, 2);
  assert.equal(r.token_budget, 100);
});

async function experimentFixture(t) {
  const f = await setup(t);
  let routes = {
    revision: 0,
    tasks: { screen: { model: null, reasoningEffort: null } },
    fallback: { enabled: false, model: null, reasoningEffort: null },
  };
  const catalog = {
    defaults: {
      provider: 'fixture',
      model: 'fixture-model',
      reasoningEffort: 'low',
    },
    groups: [
      {
        models: [
          {
            name: 'Fixture model',
            provider: 'fixture',
            model: 'fixture-model',
            reasoning: {
              defaultEffort: 'low',
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
            },
          },
          {
            name: 'Other model',
            provider: 'fixture',
            model: 'other-model',
            reasoning: {
              defaultEffort: 'high',
              efforts: [{ id: 'high', name: 'High' }],
            },
          },
        ],
      },
    ],
  };
  f.models.config = async () => ({
    connected: true,
    catalog,
    routing: structuredClone(routes),
  });
  f.models.routing = async (raw) => {
    if (raw.revision !== routes.revision)
      throw Object.assign(new Error('conflict'), { code: 'conflict' });
    routes = { ...structuredClone(raw), revision: routes.revision + 1 };
    const c = routes.tasks.screen;
    f.models.store.state.settings.connections = [
      {
        id: 'test-model',
        providerId: c.model?.provider ?? 'fixture',
        modelId: c.model?.model ?? 'fixture-model',
        reasoningEffort: c.reasoningEffort ?? 'low',
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ];
    return f.models.config();
  };
  const set = suite(f);
  const options = await f.e.experimentOptions(set.suite.id);
  const selection = {
    backend: 'dsh',
    providerId: 'fixture',
    modelId: 'fixture-model',
    reasoningEffort: 'low',
  };
  return { ...f, ...set, options, selection };
}

void test('drafts and preview preserve settings; language prompt edits and effort reach only the candidate', async (t) => {
  const f = await experimentFixture(t);
  const prompt = f.options.prompt_fields.find(
    (p) => p.settings_role === 'task',
  );
  assert.ok(prompt.id.endsWith('.zh'));
  const beforePrompts = f.e.prompts.snapshot(),
    beforeSettings = structuredClone(f.models.store.state.settings);
  const marker = 'EXPERIMENT_ONLY_54831';
  const raw = {
    name: 'Prompt and effort trial',
    suite_id: f.suite.id,
    candidates: [
      { selection: f.selection },
      {
        selection: { ...f.selection, reasoningEffort: 'high' },
        prompt_overrides: {
          [prompt.id]: {
            ...prompt.templates,
            system: prompt.templates.system + '\n' + marker,
          },
        },
      },
    ],
  };
  const count = f.state.requests.length;
  const draft = f.e.saveDraft({ name: raw.name, configuration: raw });
  assert.deepEqual(
    f.e.repo.get('evaluation_drafts', draft.id).configuration,
    raw,
  );
  assert.throws(
    () =>
      f.e.saveDraft({
        id: draft.id,
        revision: 0,
        name: raw.name,
        configuration: raw,
      }),
    { code: 'conflict' },
  );
  const preview = f.e.preview(raw);
  assert.equal(f.state.requests.length, count);
  assert.deepEqual(f.e.prompts.snapshot(), beforePrompts);
  assert.deepEqual(f.models.store.state.settings, beforeSettings);
  const result = await finish(
    f.e,
    f.e.start({ ...raw, preview_id: preview.preview_id }).id,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.scores.A.valid, 2);
  assert.equal(result.scores.B.valid, 2);
  for (const entry of f.state.requests.slice(count)) {
    assert.equal(
      entry.request.systemPrompt.includes(marker),
      entry.settings.connections[0].reasoningEffort === 'high',
    );
    assert.equal(entry.request.prompt.includes('expected_outcome'), false);
    assert.equal(entry.settings.fallback.enabled, false);
  }
  assert.equal(
    result.candidates[1].prompt_fields
      .find((p) => p.id === prompt.id)
      .templates.system.includes(marker),
    true,
  );
  assert.deepEqual(f.e.prompts.snapshot(), beforePrompts);
  assert.deepEqual(f.models.store.state.settings, beforeSettings);
});

void test('unavailable models, unsupported efforts and unrelated prompt edits fail without calls', async (t) => {
  const f = await experimentFixture(t),
    count = f.state.requests.length;
  for (const selection of [
    { ...f.selection, backend: 'missing' },
    { ...f.selection, modelId: 'missing' },
    { ...f.selection, reasoningEffort: 'unsupported' },
  ])
    assert.throws(() =>
      f.e.preview({ suite_id: f.suite.id, candidates: [{ selection }] }),
    );
  assert.throws(() =>
    f.e.preview({
      suite_id: f.suite.id,
      candidates: [
        {
          selection: f.selection,
          prompt_overrides: { 'paper-radar.task-single.zh': {} },
        },
      ],
    }),
  );
  assert.equal(f.state.requests.length, count);
});

void test('reviewed application updates screening and edited prompts, restores them, and rejects stale previews', async (t) => {
  const { previewApplication, applyConfiguration } =
    await import('../server/evaluations/applications.mjs');
  const f = await experimentFixture(t);
  const prompt = f.options.prompt_fields.find(
    (p) => p.settings_role === 'task',
  );
  const before = f.e.prompts.version(prompt.id);
  const raw = {
    suite_id: f.suite.id,
    candidates: [
      {
        selection: {
          ...f.selection,
          modelId: 'other-model',
          reasoningEffort: 'high',
        },
        prompt_overrides: {
          [prompt.id]: {
            ...prompt.templates,
            system: prompt.templates.system + '\nAPPLIED_FROM_EXPERIMENT',
          },
        },
      },
    ],
  };
  const report = await finish(f.e, start(f.e, raw).id);
  const plan = await previewApplication(f.e, report.id, { candidate_id: 'A' });
  assert.equal(f.e.prompts.version(prompt.id).id, before.id);
  assert.equal(plan.to_model.modelId, 'other-model');
  const applied = await applyConfiguration(f.e, report.id, {
    token: plan.token,
  });
  assert.equal(
    f.models.store.state.settings.connections[0].modelId,
    'other-model',
  );
  assert.match(
    f.e.prompts.version(prompt.id).templates.system,
    /APPLIED_FROM_EXPERIMENT/,
  );
  assert.ok(applied.application.applied_at);
  assert.equal(
    (await applyConfiguration(f.e, report.id, { token: plan.token }))
      .application.applied_at,
    applied.application.applied_at,
  );
  const restore = await previewApplication(f.e, report.id, {
    candidate_id: 'A',
    restore: true,
  });
  const restored = await applyConfiguration(f.e, report.id, {
    token: restore.token,
  });
  assert.ok(restored.application.restored_at);
  assert.equal(f.e.prompts.version(prompt.id).id, before.id);
  assert.equal(
    f.models.store.state.settings.connections[0].modelId,
    'fixture-model',
  );
  const stale = await previewApplication(f.e, report.id, { candidate_id: 'A' });
  const edit = f.e.prompts.saveVersion(prompt.id, {
    ...prompt.templates,
    system: prompt.templates.system + '\nNEWER_EDIT',
  });
  f.e.prompts.activate([
    { prompt_id: prompt.id, version: edit.id, expected_active: before.id },
  ]);
  await assert.rejects(
    applyConfiguration(f.e, report.id, { token: stale.token }),
    { code: 'conflict' },
  );
  assert.equal(f.e.prompts.version(prompt.id).id, edit.id);
});

void test('suite versions retain previous answers; positive feedback accepts an optional reason', async (t) => {
  const f = await experimentFixture(t),
    original = structuredClone(f.suite),
    c = f.cases[0];
  f.e.feedback(
    c.source.version_id,
    request('negative', c.feedback_revision, 'Changed my decision'),
  );
  const next = f.e.freeze({
    name: f.suite.name,
    parent_id: f.suite.id,
    case_ids: f.cases.map((v) => v.id),
  });
  assert.equal(next.version, 2);
  assert.equal(next.parent_id, f.suite.id);
  assert.deepEqual(f.e.repo.get('evaluation_suites', original.id), original);
  assert.notEqual(
    next.members[0].expected_outcome,
    original.members[0].expected_outcome,
  );
  const changed = f.e.cases().find((v) => v.id === c.id);
  assert.equal(
    f.e.feedback(
      c.source.version_id,
      request('positive', changed.feedback_revision, 'Useful topic'),
    ).case.feedback.reason,
    'Useful topic',
  );
});

void test('A/B can use different hosts without switching production; explicit application and restoration preserve the other host', async (t) => {
  const { HostModelService } = await import('../server/hosts/service.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const nodePath = await import('node:path');
  const { previewApplication, applyConfiguration } =
    await import('../server/evaluations/applications.mjs');
  const f = await experimentFixture(t);
  const directory = await mkdtemp(nodePath.join(tmpdir(), 'evaluation-hosts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldSettings = structuredClone(f.models.store.state.settings);
  let codexRoutes = (await f.models.config()).routing;
  const codexSettings = {
    ...structuredClone(oldSettings),
    codex: { protocol: 'fixture' },
  };
  delete codexSettings.dsh;
  let codexCalls = 0;
  const codex = {
    mode: 'codex',
    supportsAgents: true,
    store: { state: { settings: codexSettings } },
    async config() {
      return {
        ...(await f.models.config()),
        routing: structuredClone(codexRoutes),
      };
    },
    async routing(raw) {
      assert.equal(raw.revision, codexRoutes.revision);
      codexRoutes = {
        ...structuredClone(raw),
        revision: codexRoutes.revision + 1,
      };
      const selected = raw.tasks.screen;
      codexSettings.connections = [
        {
          ...codexSettings.connections[0],
          providerId: selected.model?.provider ?? 'fixture',
          modelId: selected.model?.model ?? 'fixture-model',
          reasoningEffort: selected.reasoningEffort ?? null,
        },
      ];
      return this.config();
    },
    async runAgent(request, options) {
      codexCalls++;
      return f.models.runAgent(request, options);
    },
  };
  const router = new HostModelService({
    directory,
    dsh: f.models,
    codex,
    defaultBackend: 'dsh',
  });
  f.e.models = router;
  await f.e.experimentOptions(f.suite.id);
  const raw = {
    suite_id: f.suite.id,
    candidates: [
      { selection: f.selection },
      {
        selection: {
          ...f.selection,
          backend: 'codex',
          modelId: 'other-model',
          reasoningEffort: 'high',
        },
      },
    ],
  };
  const run = await finish(f.e, start(f.e, raw).id);
  assert.equal(run.scores.A.valid, 2);
  assert.equal(run.scores.B.valid, 2);
  assert.equal(codexCalls, 2);
  assert.equal(router.activeBackend, 'dsh');
  assert.deepEqual(f.models.store.state.settings, oldSettings);
  const plan = await previewApplication(f.e, run.id, { candidate_id: 'B' });
  assert.equal(plan.from_backend, 'dsh');
  assert.equal(plan.to_backend, 'codex');
  await applyConfiguration(f.e, run.id, { token: plan.token });
  assert.equal(router.activeBackend, 'codex');
  assert.deepEqual(f.models.store.state.settings, oldSettings);
  const restore = await previewApplication(f.e, run.id, { restore: true });
  await applyConfiguration(f.e, run.id, { token: restore.token });
  assert.equal(router.activeBackend, 'dsh');
  assert.deepEqual(f.models.store.state.settings, oldSettings);
});

void test('a prompt activation failure rolls back model routing and does not claim application', async (t) => {
  const { previewApplication, applyConfiguration } =
    await import('../server/evaluations/applications.mjs');
  const f = await experimentFixture(t);
  const prompt = f.options.prompt_fields.find(
    (p) => p.settings_role === 'task',
  );
  const raw = {
    suite_id: f.suite.id,
    candidates: [
      {
        selection: {
          ...f.selection,
          modelId: 'other-model',
          reasoningEffort: 'high',
        },
        prompt_overrides: {
          [prompt.id]: {
            ...prompt.templates,
            system: prompt.templates.system + '\nTest rollback',
          },
        },
      },
    ],
  };
  const run = await finish(f.e, start(f.e, raw).id);
  const plan = await previewApplication(f.e, run.id, { candidate_id: 'A' });
  const activate = f.e.prompts.activate;
  f.e.prompts.activate = () => {
    throw new Error('synthetic activation failure');
  };
  try {
    await assert.rejects(
      applyConfiguration(f.e, run.id, { token: plan.token }),
      /synthetic activation failure/,
    );
    assert.equal(
      f.models.store.state.settings.connections[0].modelId,
      'fixture-model',
    );
    assert.equal(f.e.prompts.version(prompt.id).id, prompt.active_version);
    assert.equal(f.e.report(run.id).application, undefined);
  } finally {
    f.e.prompts.activate = activate;
  }
});
