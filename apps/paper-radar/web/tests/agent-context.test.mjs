import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers/daily-fixture.mjs';
import { PromptStore, defaultCatalog } from '../server/prompts/store.mjs';
import { promptSettingsRoute } from '../server/prompts/settings.mjs';
import { ResearchTools } from '../server/agents/research-tools.mjs';
import { runAutonomous } from '../server/agents/autonomous-task.mjs';
import { autonomousInput } from '../server/agents/task-input.mjs';
import { taskInstructions } from '../server/prompts/task-instructions.mjs';
import { hostContext } from '@paper-radar/host-contract/context';

const summaryId = 'paper-radar.task-summary.zh';
const summary = (id) => ({
  sections: Array.from({ length: 6 }, (_, i) => ({
    title: `章节${i}`,
    paragraphs: [
      `第${i + 1}节：论文在明确条件下研究测量输运，比较不同方法的动力学与实验结果。该发现适用于所测试模型，其他条件下的结论仍需进一步验证。`,
    ],
    evidence_ids: [id],
  })),
});
async function tempStore(t, catalog) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-context-'));
  const store = new PromptStore(dir, catalog);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

void test('batch edits reach actual execution and recorded source previews without any hidden task goal', async (t) => {
  const f = await fixture(t);
  const store = f.analyses.prompts;
  const input = {
    arxiv_input: '2501.12903v1',
    language: 'zh',
    scope: { tag_ids: [], tag_match: 'any' },
    summary_length: { min: 200, max: 500 },
  };
  const reader = await new ResearchTools({
    analyses: f.analyses,
    input,
    signal: new AbortController().signal,
  }).prepare();
  const oldSnapshot = store.snapshot();
  const changes = [summaryId, 'paper-radar.shared.zh'].map((id) => ({
    prompt_id: id,
    expected_active: store.version(id).id,
    templates:
      id === summaryId
        ? { system: '重点比较实验条件和适用边界。', user: '{{task}}' }
        : { text: '保留公式中的数学符号。' },
  }));
  promptSettingsRoute(store, 'POST', 'save-batch', { changes });
  let sent;
  f.models.runAgent = async (request, options) => {
    sent = structuredClone(request);
    options.onContext({
      kind: 'host_input',
      source: 'codex',
      content: hostContext('codex', request),
      delivery: 'accepted_by_host',
    });
    const metadata = await options.onTool('paper_get_metadata', {});
    const invalid = summary(metadata.source_ref);
    invalid.sections.pop();
    await assert.rejects(options.onTool('task_submit_result', invalid));
    const data = summary(metadata.source_ref);
    await options.onTool('task_submit_result', data);
    return { data };
  };
  await runAutonomous({
    analyses: f.analyses,
    task: 'summary',
    reader,
    settings: { codex: {} },
    snapshot: store.snapshot(),
    signal: new AbortController().signal,
    businessId: 'context-test',
  });
  assert.match(sent.systemPrompt, /重点比较实验条件/);
  assert.match(sent.systemPrompt, /保留公式/);
  assert.doesNotMatch(sent.prompt, /总结论文的研究问题|明确未证实的推测/);
  assert.equal(JSON.parse(sent.prompt).goal.description, undefined);
  const [list] = promptSettingsRoute(store, 'GET', 'runs').runs;
  const recorded = promptSettingsRoute(store, 'GET', `runs/${list.id}`);
  assert.equal(recorded.status, 'completed');
  assert.deepEqual(recorded.context.request.tools, sent.tools);
  assert.equal(recorded.context.request.prompt, sent.prompt);
  assert(recorded.events.some((e) => e.kind === 'tool_result'));
  assert(recorded.events.some((e) => e.kind === 'tool_error'));
  assert(recorded.events.some((e) => e.kind === 'host_input'));
  const preview = promptSettingsRoute(store, 'POST', `${summaryId}/preview`, {
    templates: store.version(summaryId).templates,
    source_id: list.id,
    host: 'codex',
  });
  assert.equal(preview.preview_source.kind, 'recomposition');
  assert.deepEqual(preview.context.request, recorded.context.request);
  const before = JSON.stringify(recorded);
  const current = store.version(summaryId);
  promptSettingsRoute(store, 'POST', `${summaryId}/save`, {
    templates: { ...current.templates, system: 'Changed again' },
    expected_active: current.id,
  });
  assert.equal(
    JSON.stringify(promptSettingsRoute(store, 'GET', `runs/${list.id}`)),
    before,
  );
  assert.doesNotMatch(
    store.preview(
      summaryId,
      {
        task: JSON.stringify(
          autonomousInput({ task: 'summary', reader, snapshot: oldSnapshot }),
        ),
      },
      { snapshot: oldSnapshot },
    ).rendered.system,
    /重点比较实验条件/,
  );
});

void test('all task previews expose real tool schemas and host additions; conditional messages stay separate', async (t) => {
  const { store } = await tempStore(t);
  const before = store.snapshot();
  for (const entry of store.catalog().filter((d) => d.settings_visible && d.settings_role === 'task'))
    for (const host of ['codex', 'dsh']) {
      const preview = promptSettingsRoute(
        store,
        'POST',
        `${entry.id}/preview`,
        { templates: store.version(entry.id).templates, host, personal: false },
      );
      const { context } = preview;
      const submit = context.request.tools.find(
        (tool) => tool.name === context.request.submitTool,
      );
      assert(submit.parameters.properties);
      assert.deepEqual(
        context.sections.find((s) => s.id === 'output').content.schema,
        submit.parameters,
      );
      assert(
        context.sections.some((s) => s.id === 'tools' && s.editable === false),
      );
      assert(
        context.sections.some(
          (s) => s.id === 'tool-results' && s.status === 'conditional',
        ),
      );
      assert.equal(context.runtime.messages.length, host === 'codex' ? 3 : 2);
      assert.equal(
        context.runtime.conditional_messages.length,
        host === 'dsh' ? 1 : 0,
      );
      if (entry.task !== 'screen')
        assert.equal(
          context.sections.find((s) => s.id === 'persona').status,
          'omitted',
        );
      const data = JSON.parse(context.request.prompt);
      if (entry.task === 'summary')
        assert.deepEqual(data.output.schema, submit.parameters);
    }
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.contextRuns().length, 0);
});

void test('batch activation is atomic on conflicts and on invalid shared combinations', async (t) => {
  const { store } = await tempStore(t);
  const ids = [summaryId, 'paper-radar.shared.zh'];
  const changes = ids.map((id) => ({
    prompt_id: id,
    expected_active: store.version(id).id,
    templates: structuredClone(store.version(id).templates),
  }));
  changes[0].templates.system = 'new task';
  changes[1].templates.text = 'new shared';
  const before = store.snapshot();
  changes[1].expected_active = 'stale';
  assert.throws(
    () => promptSettingsRoute(store, 'POST', 'save-batch', { changes }),
    { code: 'conflict' },
  );
  assert.deepEqual(store.snapshot(), before);
  changes[1].expected_active = store.version(ids[1]).id;
  changes[1].templates.text = 'x'.repeat(10001);
  assert.throws(() =>
    promptSettingsRoute(store, 'POST', 'save-batch', { changes }),
  );
  assert.deepEqual(store.snapshot(), before);
});

void test('existing custom instructions migrate once and frozen old task input remains unchanged', async (t) => {
  const { dir, store } = await tempStore(t);
  const version = store.saveVersion(summaryId, {
    system: 'My earlier customization',
    user: '{{task}}',
  });
  store.activate([
    {
      prompt_id: summaryId,
      version: version.id,
      expected_active: store.version(summaryId).id,
    },
  ]);
  store.db
    .prepare('DELETE FROM migrations WHERE id LIKE ?')
    .run('editable-task-instructions/v1:%');
  const old = store.snapshot();
  delete old.context_policy;
  const variables = {
    task: {
      goal: { description: 'Old pinned goal' },
      input: { language: 'zh' },
    },
  };
  const rendered = store.preview(summaryId, variables, { snapshot: old });
  store.close();
  const reopened = new PromptStore(dir, defaultCatalog());
  const active = reopened.version(summaryId);
  assert(active.templates.system.includes(taskInstructions.zh.summary));
  assert(active.templates.system.includes('My earlier customization'));
  assert.deepEqual(
    reopened.preview(summaryId, variables, { snapshot: old }),
    rendered,
  );
  const input = {
    language: 'zh',
    scope: { tag_ids: [] },
    summary_length: { min: 200, max: 500 },
  };
  const reader = { input, persona: null, initial: () => ({}) };
  assert(
    autonomousInput({ task: 'summary', reader, snapshot: old }).goal
      .description,
  );
  assert.equal(
    autonomousInput({ task: 'summary', reader, snapshot: reopened.snapshot() })
      .goal.description,
    undefined,
  );
  reopened.close();
  const again = new PromptStore(dir);
  t.after(() => again.close());
  assert.equal(again.version(summaryId).id, active.id);
});

void test('legacy captures are labeled incomplete and events paginate without changing the stored input', async (t) => {
  const { store } = await tempStore(t);
  const capture = store.capture(
    'paper-radar.task-summary',
    store.definition(summaryId).example,
    store.snapshot(),
    { task: 'summary' },
  );
  assert.equal(
    promptSettingsRoute(store, 'GET', `runs/legacy:${capture.id}`).recording,
    'initial_prompt_only',
  );
  const recomposed = promptSettingsRoute(
    store,
    'POST',
    `${summaryId}/preview`,
    {
      templates: store.version(summaryId).templates,
      source_id: `legacy:${capture.id}`,
    },
  );
  assert.equal(recomposed.preview_source.tool_source, 'current_contract');
  assert.equal(recomposed.preview_source.kind, 'recomposition');
  assert.equal(JSON.parse(recomposed.rendered.user).goal, undefined);
  const preview = promptSettingsRoute(store, 'POST', `${summaryId}/preview`, {
    templates: store.version(summaryId).templates,
  });
  const run = store.startContextRun({ context: preview.context });
  for (let i = 0; i < 102; i++)
    store.appendContextEvent(run.id, {
      kind: 'tool_result',
      source: 'fixture',
      content: { index: i },
    });
  const first = store.contextRun(run.id);
  assert.equal(first.events.length, 100);
  assert.equal(first.next_after, 100);
  assert.deepEqual(
    store.contextRun(run.id, { after: 100 }).events.map((e) => e.content.index),
    [100, 101],
  );
});
