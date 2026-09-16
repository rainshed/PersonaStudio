import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './helpers/daily-fixture.mjs';
import { AnalysisError } from '../server/analyses/contracts.mjs';
import { ResearchTools } from '../server/agents/research-tools.mjs';
import { DiscussionService } from '../server/discussions/service.mjs';
import { PromptAPI } from '../server/prompts/http.mjs';
import { promptSettingsRoute } from '../server/prompts/settings.mjs';
const input = {
  arxiv_input: '2501.12903v1',
  scope: { tag_ids: [], tag_match: 'any' },
  language: 'zh',
  summary_length: { min: 200, max: 400 },
};
const summary = (id) => ({
  sections: Array.from({ length: 6 }, (_, i) => ({
    title: '章节 ' + i,
    paragraphs: [
      `第${i + 1}节：论文在明确条件下研究测量输运，比较动力学的变化。该结果仅适用于文中模型，尚待进一步验证。`,
    ],
    evidence_ids: [id],
  })),
});
async function setup(t, script) {
  const f = await fixture(t);
  const requests = [];
  f.models.mode = 'dsh';
  f.models.store.state.settings.dsh = { protocol: 'test' };
  f.models.store.state.settings.overrides.single =
    f.models.store.state.settings.defaultConnectionId;
  const get = f.analyses.arxiv.get.bind(f.analyses.arxiv);
  f.analyses.arxiv.metadata = async (...args) => {
    const {
      blocks: _blocks,
      references: _references,
      ...p
    } = await get(...args);
    return p;
  };
  f.analyses.arxiv.get = async () => {
    throw new Error('Full paper must be optional');
  };
  f.models.run = () => {
    throw new Error('Autonomous tasks must not call the raw LLM');
  };
  f.models.runAgent = async (request, options) => {
    requests.push(request);
    const task = JSON.parse(request.prompt),
      c = f.models.store.state.settings.connections[0];
    const attempt = {
      id: randomUUID(),
      started_at: new Date().toISOString(),
      purpose: request.task,
    };
    await options.beforeAttempt?.(c, attempt);
    options.onAttempt?.({
      ...attempt,
      status: 'succeeded',
      usage: { input: 10, output: 20 },
    });
    const data = script
      ? await script({ request, options, task, f })
      : { summary: summary(task.paper.source_ref) };
    if (data) await options.onTool('task_submit_result', data);
    return {
      data,
      providerId: 'fixture',
      modelId: 'fixture',
      requestId: randomUUID(),
    };
  };
  return { ...f, requests };
}
async function settle(service, id) {
  for (let i = 0; i < 200; i++) {
    const j = service.getJob(id);
    if (!['queued', 'running'].includes(j.status)) return j;
    await delay(5);
  }
  throw new Error('Job did not settle');
}

void test('single agent can submit from abstract; results reuse ignores unrelated routes and honours force regeneration', async (t) => {
  const f = await setup(t);
  let job = await settle(
    f.analyses,
    f.analyses.create(input, 'autonomy-first').job.id,
  );
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].task, 'single');
  assert.ok(f.requests[0].tools.some((t) => t.name === 'paper_search'));
  assert.ok(f.requests[0].prompt.length < 10000);
  assert.equal(
    f.db.result(job.result_id).summary.validation.content_review,
    'not_requested',
  );
  f.models.store.state.settings.connections.push({
    ...f.models.store.state.settings.connections[0],
    id: 'other',
    modelId: 'different',
  });
  f.models.store.state.settings.overrides.discussion = 'other';
  job = await settle(
    f.analyses,
    f.analyses.create(input, 'autonomy-second').job.id,
  );
  assert.equal(job.status, 'succeeded');
  assert.equal(job.actual_attempts, 0);
  assert.equal(f.db.result(job.result_id).summary.cache_hit, true);
  assert.equal(f.requests.length, 1);
  await settle(
    f.analyses,
    f.analyses.create({ ...input, force_regenerate: true }, 'autonomy-force')
      .job.id,
  );
  assert.equal(f.requests.length, 2);
});
void test('prompt settings affect the next real task dispatch while an already created task keeps its snapshot', async (t) => {
  const f = await setup(t);
  const id = 'paper-radar.task-single.zh';
  const old = f.analyses.create(input, 'prompt-settings-old').job;
  const initial = promptSettingsRoute(f.analyses.prompts, 'GET', id);
  const saved = promptSettingsRoute(f.analyses.prompts, 'POST', `${id}/save`, {
    templates: { ...initial.active.templates, system: initial.active.templates.system + '\nCUSTOM: Emphasize limitations.' },
    expected_active: initial.active_version,
  });
  assert.equal((await settle(f.analyses, old.id)).status, 'succeeded');
  assert.doesNotMatch(f.requests[0].systemPrompt, /CUSTOM:/);
  const next = await settle(f.analyses, f.analyses.create(input, 'prompt-settings-new').job.id);
  assert.equal(next.status, 'succeeded');
  assert.equal(f.requests.length, 2, 'Changed prompts must not reuse the previous analysis cache');
  assert.match(f.requests[1].systemPrompt, /CUSTOM: Emphasize limitations/);
  assert.equal(f.db.job(old.id).prompt_snapshot.versions[id].id, initial.active_version);
  assert.equal(f.db.job(next.id).prompt_snapshot.versions[id].id, saved.active_version);
});

void test('submitted components and notes survive a later provider failure and explicit retry', async (t) => {
  let run = 0;
  const f = await setup(t, async ({ options, task }) => {
    if (run++ === 0) {
      await options.onTool('notes_save', {
        title: '重点',
        text: '检查边界条件',
      });
      await options.onTool('task_save_result', {
        summary: summary(task.paper.source_ref),
      });
      throw new AnalysisError('PROVIDER_ERROR', 'fixture interruption', true);
    }
    assert.equal(task.available_results.report, true);
    assert.equal(task.available_results.notes.length, 1);
    const saved = await options.onTool('report_read', { component: 'summary' });
    assert.match(saved.text, /available/);
    return { summary: summary(task.paper.source_ref) };
  });
  const first = await settle(
    f.analyses,
    f.analyses.create(input, 'partial-saved').job.id,
  );
  assert.equal(first.status, 'partial');
  assert.equal(f.db.result(first.result_id).summary.status, 'available');
  assert.equal(f.db.result(first.result_id).agent_context.notes.length, 1);
  const next = await settle(
    f.analyses,
    f.analyses.retry(first.id, 'partial-retry').job.id,
  );
  assert.equal(next.status, 'succeeded');
  assert.equal(f.db.result(first.result_id).summary.status, 'available');
});
void test('a malformed final component does not discard a valid submitted summary', async (t) => {
  const f = await setup(t, async ({ task }) => ({
    summary: summary(task.paper.source_ref),
    personalization: { decision: 'wrong' },
  }));
  const j = await settle(
    f.analyses,
    f.analyses.create(input, 'mixed-invalid').job.id,
  );
  assert.equal(j.status, 'partial');
  assert.equal(f.db.result(j.result_id).summary.status, 'available');
  assert.ok(f.db.result(j.result_id).agent_draft);
});
void test('actual evidence slices are bounded; unissued references are rejected and reading order is unrestricted', async (t) => {
  const f = await setup(t);
  const paper = {
    id: '2501.12903',
    version: 1,
    url: input.arxiv_input,
    title: 'test',
    abstract: 'Short abstract',
    source_hash: 'one',
    blocks: Array.from({ length: 4 }, (_, i) => ({
      id: 'b' + i,
      section: 'Section ' + i,
      kind: 'paragraph',
      text: 'q'.repeat(9000),
    })),
    references: [],
  };
  const r = await new ResearchTools({
    analyses: f.analyses,
    input,
    signal: new AbortController().signal,
    paper,
  }).prepare();
  for (const id of ['b3', 'b1', 'b0', 'b2'])
    assert.equal(
      (await r.call('paper_read', { section_id: id })).text.length,
      6500,
    );
  assert.equal(r.reads.length, 4);
  assert.equal(
    r.evidence().find((e) => e.id === 'b0:slice:0:6500').text.length,
    6500,
  );
  await assert.rejects(r.call('evidence_read', { evidence_id: 'foreign' }), {
    code: 'invalid_reference',
  });
  const search = await r.call('paper_search', { query: 'qq' });
  assert.equal(search.items[0].text.length, 1000);
  assert.equal(r.delivered.get(search.items[0].id).text.length, 1000);
});
void test('shared task budget includes compaction and prevents another request', async (t) => {
  const f = await setup(t, async ({ options, f }) => {
    const c = f.models.store.state.settings.connections[0];
    await options.beforeAttempt(c, { id: randomUUID(), purpose: 'compaction' });
    options.onAttempt({
      id: randomUUID(),
      purpose: 'compaction',
      status: 'succeeded',
    });
    await options.beforeAttempt(c, { id: randomUUID(), purpose: 'single' });
    throw new Error('unreachable');
  });
  f.analyses.maxAttempts = 2;
  const j = await settle(
    f.analyses,
    f.analyses.create(input, 'compaction-budget').job.id,
  );
  assert.equal(j.actual_attempts, 2);
  assert.equal(j.error.code, 'budget_exceeded');
  assert.ok(f.db.attempts(j.id).some((a) => a.phase === 'compaction'));
});
void test('discussion exposes long history as a tool and retains its question and scope', async (t) => {
  const f = await setup(t, async ({ request, options, task }) => {
    assert.equal(request.task, 'discussion');
    assert.ok(request.prompt.length < 10000);
    assert.equal(task.goal.question, '继续解释');
    const history = await options.onTool('history_read', {});
    assert.ok(history.next_offset);
    assert.ok(history.text.length <= 6500);
    return {
      paragraphs: [
        { text: '依据论文说明。', evidence_ids: [task.paper.source_ref] },
      ],
      limitations: [],
      claims: [],
    };
  });
  const d = new DiscussionService(f.analyses, f.daily);
  t.after(() => d.close());
  const c = d.create({ input }).conversation;
  d.repo.saveTurn({
    id: 'old-turn',
    conversation_id: c.id,
    question: 'x'.repeat(1300000),
    answer: null,
    status: 'failed',
    created_at: new Date(0).toISOString(),
    attempts: [],
    actual_attempts: 0,
  });
  const turn = d.send(
    c.id,
    { question: '继续解释' },
    'long-history-agent',
  ).turn;
  for (
    let i = 0;
    i < 200 && ['running', 'queued'].includes(d.repo.turn(turn.id).status);
    i++
  )
    await delay(5);
  assert.equal(
    d.repo.turn(turn.id).status,
    'succeeded',
    JSON.stringify(d.repo.turn(turn.id).error),
  );
  assert.equal(d.repo.turn(turn.id).coverage.complete, false);
});
void test('autonomous prompt experiments honour A/B templates and never create a business report', async (t) => {
  const f = await setup(t, async ({ request, task }) => {
    assert.match(request.systemPrompt, /VARIANT-/);
    return { summary: summary(task.paper.source_ref) };
  });
  const api = new PromptAPI(f.analyses.prompts, f.models, f.analyses);
  t.after(() => api.close());
  const templates = f.analyses.prompts.version(
    'paper-radar.task-single',
  ).templates;
  const variants = ['A', 'B'].map((x) => ({
    templates: { ...templates, system: templates.system + ' VARIANT-' + x },
  }));
  const e = api.start({
    prompt_id: 'paper-radar.task-single',
    variables: { task: { input } },
    variants,
  });
  for (let i = 0; i < 200 && api.active.has(e.id); i++) await delay(5);
  const saved = api.store.record('experiments', e.id);
  assert.equal(saved.status, 'succeeded', JSON.stringify(saved.results));
  assert.equal(saved.results.length, 2);
  assert.match(f.requests[0].systemPrompt, /VARIANT-A/);
  assert.match(f.requests[1].systemPrompt, /VARIANT-B/);
  assert.equal(f.db.listJobs().length, 0);
});
void test('scoped source tools validate file ownership and expose real continuation selectors', async (t) => {
  const f = await setup(t),
    rec = {
      id: 'material-source',
      entity_type: 'material',
      title: 'Material',
      record_revision: 1,
      source_ref: 'source-1',
      tags: ['tag-physics'],
      interest_level: 'high',
    };
  const calls = [];
  let changed = false;
  f.analyses.persona.scopeReader = async (i) => ({
    scope: i.scope,
    revision: 7,
    tags: [],
    scoped: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_source_files')
        return {
          data: {
            source_id: 'source-1',
            entries: [{ kind: 'file', file_id: 'file-1', file_hash: 'hash-1' }],
          },
        };
      if (name === 'search_source_content')
        return {
          data: {
            matches: [
              {
                file_ref: { source_id: 'source-1', file_id: 'file-1' },
                passage_ref: { id: 'passage-1' },
              },
            ],
          },
        };
      if (name === 'read_source')
        return {
          data: {
            text: 'Source passage',
            file_ref: { source_id: 'source-1', file_id: 'file-1' },
            provenance: {
              source_id: 'source-1',
              file_id: 'file-1',
              file_hash: changed ? 'other' : 'hash-1',
              locator: { lines: { start: 1, end: 3 } },
            },
            truncated: true,
            next_selector: { lines: { start: 4, end: 6 } },
          },
        };
      throw new Error(name);
    },
  });
  f.analyses.persona.records = async () => ({ records: [rec], issues: [] });
  const r = await new ResearchTools({
    analyses: f.analyses,
    input: {
      ...input,
      persona_connection_id: 'persona-test',
      scope: { tag_ids: ['tag-physics'], tag_match: 'any' },
    },
    signal: new AbortController().signal,
  }).prepare();
  await assert.rejects(
    r.call('persona_search_source', { file_id: 'foreign', query: 'x' }),
    { code: 'invalid_reference' },
  );
  await r.call('persona_sources', { record_id: rec.id });
  const page = await r.call('persona_search_source', {
    file_id: 'file-1',
    query: 'transport',
  });
  const part = await r.call('persona_read_source', {
    passage_id: page.matches[0].passage_id,
  });
  assert.deepEqual(part.continuation, { lines: { start: 4, end: 6 } });
  await r.call('persona_read_source', {
    passage_id: page.matches[0].passage_id,
    selector: part.continuation,
  });
  assert.deepEqual(calls.at(-1).args.selector, part.continuation);
  changed = true;
  await assert.rejects(
    r.call('persona_read_source', { passage_id: page.matches[0].passage_id }),
    { code: 'source_changed' },
  );
});
void test('cancelled analysis rejects a late submission while preserving previously saved output', async (t) => {
  let started = false;
  const f = await setup(t, async ({ options, task }) => {
    await options.onTool('task_save_result', {
      summary: summary(task.paper.source_ref),
    });
    started = true;
    await delay(60);
    return { summary: summary(task.paper.source_ref) };
  });
  const j = f.analyses.create(input, 'cancel-autonomy').job;
  while (!started) await delay(2);
  f.analyses.cancel(j.id);
  await f.analyses.work;
  const saved = f.analyses.getJob(j.id);
  assert.equal(saved.status, 'cancelled');
  assert.equal(f.db.result(saved.result_id).summary.status, 'available');
  assert.equal(f.analyses.controllers.size, 0);
});
