import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { emptyQueryContext } from '../server/persona/agent-tools.mjs';
import { fixture, context } from './helpers/daily-fixture.mjs';
import { evaluationRoute } from '../server/evaluations/http.mjs';

async function analyze(f, id = '2501.10000', changes = {}) {
  const { job } = f.analyses.create(
    {
      arxiv_input: id,
      persona_connection_id: f.sub.persona_connection_id,
      scope: f.sub.scope,
      language: 'zh',
      summary_length: { min: 200, max: 400 },
      ...changes,
    },
    randomUUID(),
  );
  for (let n = 0; n < 1000; n++) {
    const current = f.analyses.getJob(job.id);
    if (!['queued', 'running'].includes(current.status)) {
      assert.equal(current.status, 'succeeded', JSON.stringify(current.error));
      return f.analyses.getResult(current.result_id);
    }
    await delay(2);
  }
  throw new Error('Analysis did not finish');
}
async function run(f, suite) {
  const e = f.daily.evaluations;
  const started = e.start({
    suite_id: suite.id,
    candidates: [{ current: true }, {}],
    idempotency_key: randomUUID(),
  });
  await e.work;
  return e.report(started.id);
}

void test('single analysis feedback automatically produces a sample tested with current sources', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  const before = f.calls;
  const feedback = f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  assert.equal(f.calls, before);
  assert.equal(feedback.accuracy.expected_outcome, 'recommended');
  const e = f.daily.evaluations,
    [c] = e.dataset();
  assert.equal(c.source.kind, 'analysis');
  assert.equal(c.replay_status, 'ready');
  assert.equal(c.source.paper.id, r.paper.id);
  const saved = e.repo.get('screening_inputs', c.input_snapshot_id);
  assert.equal(saved.prompt.prompt_id, 'paper-radar.task-single');
  assert.equal(
    JSON.parse(saved.variables.task).available_results.report,
    false,
  );
  const originalRead = f.analyses.arxiv.get;
  let currentReads = 0;
  f.analyses.arxiv.get = async (...args) => {
    currentReads++;
    return originalRead(...args);
  };
  const originalAgent = f.models.runAgent;
  f.models.runAgent = async (request, options) => {
    assert.ok(request.tools.some((tool) => tool.name === 'task_save_result'));
    return originalAgent(request, {
      ...options,
      onTool: async (name, args) => {
        if (name === 'task_submit_result')
          await options.onTool('task_save_result', { summary: args.summary });
        return options.onTool(name, args);
      },
    });
  };
  const report = await run(f, e.freezeDataset());
  assert.equal(report.status, 'completed', report.error);
  assert.deepEqual(
    report.items.map((i) => i.status),
    ['completed', 'completed'],
    JSON.stringify(report.items),
  );
  assert.ok(currentReads > 0);
  assert.equal(report.scores.A.correct, 1);
  assert.equal(report.scores.B.correct, 1);
  assert.equal(
    f.analyses.getResult(r.id).personalization.data.decision,
    'recommended',
  );
});

void test('same paper and scope deduplicate across daily and single analysis, latest explicit answer wins', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  const item = f.daily.items(daily.id).items[0];
  const v = item.screening_version_id;
  f.daily.feedback(v, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations,
    original = e.dataset()[0];
  assert.equal(original.expected_outcome, 'not_recommended');
  const r = await analyze(f, item.paper.id);
  assert.equal(r.feedback.accuracy.value, 'negative');
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const updated = e.dataset();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, original.id);
  assert.equal(updated[0].expected_outcome, 'recommended');
  assert.equal(updated[0].source.kind, 'analysis');
  assert.equal(updated[0].source.scope_key, original.source.scope_key);
  assert.equal(f.daily.getVersion(v).feedback.accuracy.value, 'negative');
  f.daily.feedback(v, 'accuracy', null);
  assert.equal(e.dataset().length, 0);
  assert.deepEqual(f.analyses.getResult(r.id).feedback, {});
  f.analyses.feedback(r.id, 'accuracy', { value: 'negative' });
  assert.equal(e.dataset().length, 1);
  assert.equal(e.dataset()[0].expected_outcome, 'not_recommended');
  const backup = e.export();
  const other = await fixture(t, { count: 1 });
  other.daily.evaluations.import(backup);
  assert.equal(other.daily.evaluations.dataset().length, 1);
});

void test('default dataset supports both original workflows and keeps each experiment answer frozen', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  f.daily.feedback(
    f.daily.items(daily.id).items[0].screening_version_id,
    'accuracy',
    { value: 'positive' },
  );
  const r = await analyze(f, '2501.10001');
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations,
    frozen = e.freezeDataset();
  assert.equal(frozen.members.length, 2);
  f.analyses.feedback(r.id, 'accuracy', { value: 'negative' });
  const report = await run(f, frozen);
  assert.equal(report.status, 'completed', JSON.stringify(report));
  assert.ok(
    report.items.every((i) => i.status === 'completed'),
    JSON.stringify(report.items),
  );
  assert.equal(report.scores.A.correct, 2);
  assert.equal(report.scores.B.correct, 2);
  const member = frozen.members.find(
    (m) => m.expected_outcome === 'recommended',
  );
  assert.equal(
    e.repo.get('evaluation_cases', member.case_id).expected_outcome,
    'not_recommended',
  );
  assert.ok(
    report.items
      .filter((i) => i.case_id === member.case_id)
      .every((i) => i.expected_outcome === 'recommended'),
  );
});

void test('different knowledge scopes retain different correct answers for the same paper', async (t) => {
  const f = await fixture(t, { count: 1 });
  const a = await analyze(f);
  const b = await analyze(f, '2501.10000', {
    scope: { ...f.sub.scope, tag_ids: ['tag-other'] },
  });
  f.analyses.feedback(a.id, 'accuracy', { value: 'positive' });
  f.analyses.feedback(b.id, 'accuracy', { value: 'negative' });
  assert.equal(f.daily.evaluations.dataset().length, 2);
});

void test('dataset HTTP answer editing and removal enforce revisions without calling the model', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations,
    [c] = e.dataset(),
    calls = f.calls;
  const route = (path, method, value) =>
    evaluationRoute(
      e,
      { method },
      new URL('http://localhost/api/evaluations/v1/' + path),
      async () => value,
    );
  const response = await route('cases/' + c.id + '/answer', 'PUT', {
    expected_outcome: 'not_recommended',
    expected_feedback_revision: c.feedback_revision,
  });
  assert.equal(response.case.expected_outcome, 'not_recommended');
  await assert.rejects(
    route('cases/' + c.id + '/answer', 'PUT', {
      expected_outcome: 'recommended',
      expected_feedback_revision: c.feedback_revision,
    }),
    { code: 'conflict' },
  );
  const dataset = await route('dataset', 'GET');
  assert.equal(dataset.items.length, 1);
  assert.equal(dataset.suite.id, 'dataset');
  await route('subjects/' + r.id + '/feedback', 'DELETE', {
    expected_feedback_revision: response.case.feedback_revision,
  });
  assert.equal((await route('dataset', 'GET')).items.length, 0);
  assert.equal(f.calls, calls);
});

void test('baseline uses the saved model for each task and candidate settings stay isolated', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  f.daily.feedback(f.repo.items(daily.id)[0].screening_version_id, 'accuracy', {
    value: 'positive',
  });
  const r = await analyze(f, '2501.10001');
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const settings = f.models.store.state.settings;
  settings.connections.push({
    ...settings.connections[0],
    id: 'single-model',
    modelId: 'single-model',
    reasoningEffort: 'high',
  });
  settings.overrides.single = 'single-model';
  const frozen = structuredClone(settings);
  const e = f.daily.evaluations;
  const configuration = e.prepare({
    suite_id: e.freezeDataset().id,
    candidates: [{ current: true }, { connection_id: 'test-model' }],
  });
  assert.equal(
    configuration.candidates[0].task_models.single.modelId,
    'single-model',
  );
  assert.equal(
    configuration.candidates[0].settings.overrides.single,
    'single-model',
  );
  assert.equal(
    configuration.candidates[1].settings.overrides.single,
    'test-model',
  );
  assert.deepEqual(settings, frozen);
  assert.ok(
    configuration.candidates[0].prompt_fields.some((p) =>
      p.id.includes('single'),
    ),
  );
});

void test('legacy recommendation feedback is collected automatically and withdrawn answers never reappear', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  f.db.setFeedback(r.id, 'accuracy', {
    value: 'negative',
    updatedAt: '2026-09-01T00:00:00Z',
  });
  const { EvaluationService } =
    await import('../server/evaluations/service.mjs');
  await f.daily.evaluations.close();
  const e = new EvaluationService(f.daily);
  t.after(() => e.close());
  assert.equal(e.dataset().length, 1);
  assert.equal(e.dataset()[0].expected_outcome, 'not_recommended');
  e.feedback(r.id, null);
  e.importLegacy();
  assert.equal(e.dataset().length, 0);
});

void test('single-analysis candidates can issue new current knowledge queries without seeing feedback labels', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  const e = f.daily.evaluations;
  f.analyses.feedback(r.id, 'accuracy', {
    value: 'positive',
    reason: 'PRIVATE_EXPECTED_ANSWER_991',
  });
  const originalAgent = f.models.runAgent;
  let liveReads = 0;
  const originalScope = f.analyses.persona.scopeReader;
  f.analyses.persona.scopeReader = async (...args) => {
    liveReads++;
    return originalScope(...args);
  };
  f.models.runAgent = async (request, options) => {
    assert.ok(!JSON.stringify(request).includes('PRIVATE_EXPECTED_ANSWER_991'));
    await options.onTool('persona_search', { query: 'uncaptured' });
    return originalAgent(request, options);
  };
  const report = await run(f, e.freezeDataset());
  assert.ok(liveReads > 0);
  assert.ok(
    report.items.every((i) => i.status === 'completed'),
    JSON.stringify(report.items),
  );
  assert.equal(report.scores.A.correct, 1);
});

void test('mixed historical samples with no snapshots use both current task prompts and actually run', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  const version = f.repo.get(
    'daily_item_versions',
    f.repo.items(daily.id)[0].screening_version_id,
  );
  delete version.input_snapshot_id;
  f.db.db
    .prepare('UPDATE daily_item_versions SET data=? WHERE id=?')
    .run(JSON.stringify(version), version.id);
  const analysis = await analyze(f, '2501.10001');
  const result = f.db.result(analysis.id);
  delete result.input_snapshot_id;
  f.db.db
    .prepare('UPDATE results SET data=? WHERE id=?')
    .run(JSON.stringify(result), result.id);
  f.daily.feedback(version.id, 'accuracy', { value: 'positive' });
  f.analyses.feedback(result.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations;
  assert.ok(e.dataset().every((c) => !c.input_snapshot_id));
  const options = await e.experimentOptions('dataset');
  assert.ok(
    options.prompt_fields.some((p) => p.id === 'paper-radar.task-single.zh'),
  );
  assert.ok(
    options.prompt_fields.some(
      (p) => p.id === 'paper-radar.screen-autonomous.zh',
    ),
  );
  const beforeCalls = f.calls;
  const suite = e.freezeDataset();
  assert.equal(
    e.preview({ suite_id: suite.id, candidates: [{ current: true }] })
      .input_missing,
    0,
  );
  assert.equal(f.calls, beforeCalls);
  const report = await run(f, suite);
  assert.equal(report.status, 'completed', JSON.stringify(report.items));
  assert.equal(report.actual_calls, 4);
  assert.equal(report.scores.A.valid, 2);
  assert.equal(report.scores.B.valid, 2);
  assert.ok(!('current_inputs' in report));
});

void test('tag scopes match as sets; different scopes require choosing a dataset group', async (t) => {
  const f = await fixture(t, { count: 1 });
  const first = await analyze(f, '2501.10000', {
    scope: { tag_ids: ['a', 'b'], tag_match: 'any' },
  });
  const same = await analyze(f, '2501.10001', {
    scope: { tag_ids: ['b', 'a'], tag_match: 'any' },
  });
  const different = await analyze(f, '2501.10002', {
    scope: { tag_ids: ['c'], tag_match: 'any' },
  });
  for (const r of [first, same, different])
    f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations;
  assert.throws(
    () => e.prepare({ suite_id: e.freezeDataset().id, candidates: [{}] }),
    { code: 'scope_mismatch' },
  );
  const key = e.dataset().find((c) => c.source.paper.id === first.paper.id)
    .source.scope_key;
  const group = e.freezeDataset({ scope_key: key });
  assert.equal(group.members.length, 2);
  assert.equal(
    e.prepare({ suite_id: group.id, candidates: [{}] }).suite.members.length,
    2,
  );
});

void test('current configuration and current Persona identity are fixed for one run without historic checks', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations;
  const originalScope = f.analyses.persona.scopeReader;
  f.analyses.persona.identity = 'current-persona-connection';
  f.analyses.persona.scopeReader = async (input, ...rest) => {
    assert.equal(input.persona_connection_id, 'current-persona-connection');
    assert.deepEqual(input.scope, f.sub.scope);
    return originalScope(input, ...rest);
  };
  const settings = f.models.store.state.settings;
  settings.connections[0].modelId = 'current-model';
  settings.connections[0].reasoningEffort = 'high';
  const originalAgent = f.models.runAgent;
  const seen = [];
  f.models.runAgent = async (request, options) => {
    seen.push(structuredClone(options.settings.connections[0]));
    settings.connections[0].modelId = 'next-experiment-model';
    return originalAgent(request, options);
  };
  const report = await run(f, e.freezeDataset());
  assert.equal(report.status, 'completed', JSON.stringify(report.items));
  assert.deepEqual(
    seen.map((m) => m.modelId),
    ['current-model', 'current-model'],
  );
  assert.ok(seen.every((m) => m.reasoningEffort === 'high'));
  assert.equal(
    e.prepare({
      suite_id: e.freezeDataset().id,
      candidates: [{ current: true }],
    }).candidates[0].model.modelId,
    'next-experiment-model',
  );
});

void test('new paper metadata is shared by A/B and refreshed for the next experiment', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations;
  let reads = 0;
  const originalRead = f.analyses.arxiv.get;
  f.analyses.arxiv.get = async (...args) => {
    const paper = await originalRead(...args);
    paper.title = 'Current paper read ' + ++reads;
    return paper;
  };
  const seen = [];
  const originalAgent = f.models.runAgent;
  f.models.runAgent = async (request, options) => {
    seen.push(JSON.parse(request.prompt).paper.title);
    return originalAgent(request, options);
  };
  const first = await run(f, e.freezeDataset());
  const second = await run(f, e.freezeDataset());
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.deepEqual(seen, [
    'Current paper read 1',
    'Current paper read 1',
    'Current paper read 2',
    'Current paper read 2',
  ]);
  const backup = e.export();
  const deleted = e.dataset()[0];
  e.withdraw(deleted.id, {
    remove: true,
    expected_feedback_revision: deleted.feedback_revision,
    idempotency_key: randomUUID(),
  });
  e.import(backup);
  assert.ok(
    e.repo
      .all('evaluation_runs')
      .every((run) => !run.current_inputs?.[deleted.id]),
  );
});

void test('screening agents can fetch new knowledge queries and full paper content in current mode', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  f.daily.feedback(f.repo.items(daily.id)[0].screening_version_id, 'accuracy', {
    value: 'positive',
  });
  const e = f.daily.evaluations;
  const range = f.analyses.persona.scopeReader;
  const queries = [];
  f.analyses.persona.scopeReader = async (input, ...args) => {
    assert.deepEqual(input.scope, f.sub.scope);
    const r = await range(input, ...args);
    const scoped = r.scoped;
    r.scoped = async (name, args) => {
      if (name === 'search_knowledge') queries.push(args.query);
      return scoped(name, args);
    };
    return r;
  };
  f.analyses.persona.queryContext = async (input, signal) =>
    emptyQueryContext(
      await f.analyses.persona.scopeReader(input, signal),
      input.persona_connection_id,
    );
  const get = f.analyses.arxiv.get;
  f.analyses.arxiv.metadata = async (...args) => {
    const {
      blocks: _blocks,
      references: _references,
      ...paper
    } = await get(...args);
    return paper;
  };
  let paperReads = 0;
  f.analyses.arxiv.get = async (...args) => {
    paperReads++;
    return get(...args);
  };
  let agent = 0;
  f.models.runAgent = async (request, options) => {
    const task = JSON.parse(request.prompt);
    assert.deepEqual(task.persona.records, []);
    const id = randomUUID();
    options.beforeAttempt(options.settings.connections[0], { id });
    await options.onTool('search_knowledge', { query: 'new-query-' + ++agent });
    const outline = await options.onTool('paper_get_outline', {});
    await options.onTool('paper_read_section', {
      section_id: outline.sections[0].id,
    });
    const data = {
      schema: task.output.schema,
      paper_version: task.paper.version,
      decision: 'not_recommended',
      introduction: 'Current paper',
      reason: 'Current knowledge',
      criterion_ids: ['selected-knowledge'],
      paper_evidence_ids: [task.paper.source_ref],
      persona_evidence_ids: [context.evidence[0].id],
      persona_coverage_ref: task.persona.source_ref,
      claims: [],
      open_questions: [],
    };
    await options.onTool('screening_submit_result', data);
    options.onAttempt({
      id,
      status: 'succeeded',
      usage: { input: 1, output: 1 },
    });
    return { data, modelId: 'fixture-model', providerId: 'fixture' };
  };
  const report = await run(f, e.freezeDataset());
  assert.equal(report.status, 'completed', JSON.stringify(report.items));
  assert.deepEqual(queries, ['new-query-1', 'new-query-2']);
  assert.equal(paperReads, 1);
});

void test('startup corrects old completed-but-skipped runs and existing notifications without new model calls', async (t) => {
  const f = await fixture(t, { count: 1 });
  const r = await analyze(f);
  f.analyses.feedback(r.id, 'accuracy', { value: 'positive' });
  const e = f.daily.evaluations;
  f.analyses.arxiv.get = async () => {
    throw new Error('source unavailable');
  };
  const report = await run(f, e.freezeDataset());
  const old = e.repo.get('evaluation_runs', report.id);
  old.status = 'completed';
  e.repo.put('evaluation_runs', old);
  f.db.db
    .prepare("UPDATE notifications SET status='completed' WHERE task_id=?")
    .run(old.id);
  const before = f.db.db
    .prepare('SELECT count(*) n FROM notifications')
    .get().n;
  const calls = f.calls;
  await e.close();
  const { EvaluationService } =
    await import('../server/evaluations/service.mjs');
  const restarted = new EvaluationService(f.daily);
  t.after(() => restarted.close());
  assert.equal(restarted.repo.get('evaluation_runs', old.id).status, 'failed');
  assert.equal(
    f.db.db
      .prepare('SELECT status FROM notifications WHERE task_id=?')
      .get(old.id).status,
    'failed',
  );
  assert.equal(
    f.db.db.prepare('SELECT count(*) n FROM notifications').get().n,
    before,
  );
  assert.equal(f.calls, calls);
});

void test('automatic experiment names remain identifiable after saving and running without relabeling custom names', async (t) => {
  const f = await fixture(t, { count: 1 });
  const daily = await f.finish(f.create().run.id);
  f.daily.feedback(
    f.daily.items(daily.id).items[0].screening_version_id,
    'accuracy',
    { value: 'positive' },
  );
  const e = f.daily.evaluations;
  const suite = e.freezeDataset();
  const configuration = {
    name: '我的推荐测试集 · 新实验',
    name_is_default: true,
    suite_id: suite.id,
    candidates: [{ current: true }, {}],
  };
  const draft = e.saveDraft({
    name: configuration.name,
    name_is_default: true,
    configuration,
  });
  assert.equal(draft.name_is_default, true);
  const started = e.start({
    ...draft.configuration,
    idempotency_key: randomUUID(),
  });
  await e.work;
  assert.equal(e.report(started.id).name_is_default, true);
  const { NotificationService } =
    await import('../server/notifications/service.mjs');
  const notification = new NotificationService(f.db)
    .list()
    .items.find((item) => item.task_id === started.id);
  assert.equal(notification.title_is_default, true);
  assert.equal(notification.title, suite.name);
  const custom = e.saveDraft({
    name: configuration.name,
    configuration: { ...configuration, name_is_default: false },
  });
  assert.equal(custom.name_is_default, false);
  assert.equal(custom.name, configuration.name);
});
