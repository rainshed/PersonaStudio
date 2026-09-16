import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  UI_LANGUAGE_KEY,
  readUiLanguage,
  resolveUiLanguage,
  saveUiLanguage,
} from '../lib/ui-language.ts';
import { translateUi } from '../lib/ui-messages.ts';
import { uiCatalog } from '../lib/ui-catalog.ts';
import { generationNotice, analysisDecisionNotice } from '../lib/daily-ui.ts';

// Render the actual components without a browser, network or model calls.
const root = fileURLToPath(new URL('../', import.meta.url));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css'))
      return { url: 'data:text/javascript,export{}', shortCircuit: true };
    let candidate;
    if (specifier.startsWith('@/')) candidate = root + specifier.slice(2);
    else if (
      specifier.startsWith('.') &&
      context.parentURL?.startsWith(pathToFileURL(root).href)
    )
      candidate = fileURLToPath(new URL(specifier, context.parentURL));
    if (candidate && !candidate.includes('/node_modules/')) {
      for (const suffix of ['', '.ts', '.tsx']) {
        if (existsSync(candidate + suffix))
          return next(pathToFileURL(candidate + suffix).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (
      url.startsWith(pathToFileURL(root).href) &&
      !url.includes('/node_modules/') &&
      /\.(tsx?|json)$/.test(url)
    ) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        shortCircuit: true,
        source: url.endsWith('.json')
          ? `export default ${source}`
          : ts.transpileModule(source, {
              compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                jsx: ts.JsxEmit.ReactJSX,
              },
            }).outputText,
      };
    }
    return next(url, context);
  },
});
after(() => hooks.deregister());
const { UiLanguageContext, LanguageSwitcher } =
  await import('../components/radar/ui-language.tsx');
const { FeedbackControl } = await import('../components/radar/feedback.tsx');
const { LiveRadarApp } = await import('../components/radar/daily-real.tsx');
const { ModelSettingsPage } =
  await import('../components/radar/model-settings.tsx');
const { PersonaConnectionNotice } =
  await import('../components/radar/persona-connection-status.tsx');
const { SettingsWorkspace } =
  await import('../components/radar/settings-workspace.tsx');
const { PromptSettingsPage } =
  await import('../components/radar/prompt-settings.tsx');
const { RealSingleAnalysis } =
  await import('../components/radar/single-analysis-real.tsx');
const { SummaryPreview } =
  await import('../components/radar/summary-preview.tsx');
const { DEFAULT_SUBSCRIPTIONS, PAPERS } = await import('../lib/radar.ts');
const { buildSummaryPreview } = await import('../lib/summary.ts');
const render = (component, language, props = {}) =>
  renderToStaticMarkup(
    React.createElement(
      UiLanguageContext.Provider,
      { value: { language, setLanguage() {} } },
      React.createElement(component, props),
    ),
  );

void test('language preference persists separately and tolerates unavailable or corrupt storage', () => {
  const values = new Map([
    ['paper-radar.single.real.draft.v1', '{"language":"zh"}'],
  ]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(readUiLanguage(storage, ['en-US']), 'en');
  saveUiLanguage(storage, 'zh');
  assert.equal(readUiLanguage(storage, ['en-US']), 'zh');
  saveUiLanguage(storage, 'en');
  assert.equal(readUiLanguage(storage, ['zh-CN']), 'en');
  assert.equal(
    values.get('paper-radar.single.real.draft.v1'),
    '{"language":"zh"}',
  );
  assert.equal(values.get(UI_LANGUAGE_KEY), 'en');
  assert.equal(resolveUiLanguage('invalid', ['zh-TW']), 'zh');
  assert.equal(resolveUiLanguage(null, ['de-AT']), 'zh');
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.equal(readUiLanguage(blocked, ['en-GB']), 'en');
  assert.doesNotThrow(() => saveUiLanguage(blocked, 'zh'));
});

void test('dynamic notices translate without translating interpolated user content', () => {
  assert.equal(
    translateUi('为「{0}」整理的研究线索', 'en', ['推荐']),
    'Research leads for “推荐”',
  );
  assert.equal(
    translateUi(' Evidence from my own paper ', 'en'),
    ' Evidence from my own paper ',
  );
  assert.equal(translateUi(' 输入 ', 'en'), ' Input ');
  assert.equal(
    translateUi('后台请求失败（HTTP 503），请重试。', 'en'),
    'Backend request failed (HTTP 503). Please retry.',
  );
  const notice = generationNotice(
    { status: 'cancelled', date: '2026-09-07' },
    true,
  );
  const english = translateUi(notice, 'en');
  assert.match(english, /2026-09-07/);
  assert.match(english, /cancelled/);
  assert.doesNotMatch(english, /[\p{Script=Han}]/u);
  assert.equal(translateUi(notice, 'zh'), notice);
  assert.doesNotMatch(
    translateUi(
      analysisDecisionNotice({
        analysis_decision: 'recommended',
        final_decision: 'recommended',
      }),
      'en',
    ),
    /[\p{Script=Han}]/u,
  );
  for (const [key, value] of Object.entries(uiCatalog)) {
    assert.deepEqual(
      [...key.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
      [...value.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort(),
      key,
    );
  }
});

void test('language switcher and navigation render in either interface language', () => {
  assert.match(
    render(LanguageSwitcher, 'en'),
    /aria-label="Interface language"/,
  );
  assert.match(render(LanguageSwitcher, 'zh'), /aria-label="界面语言"/);
  const en = render(LiveRadarApp, 'en');
  for (const text of [
    'Daily papers',
    'My subscriptions',
    'Settings',
    'Evaluation and feedback',
    'Interface language',
  ])
    assert.ok(en.includes(text), text);
  for (const text of ['每日论文', '我的订阅', '设置'])
    assert.ok(!en.includes(text), text);
  const zh = render(LiveRadarApp, 'zh');
  for (const text of ['每日论文', '我的订阅', '设置'])
    assert.ok(zh.includes(text), text);
});

void test('home Persona status distinguishes connection failures from checks and links to its settings in both languages', () => {
  const props = { onSettings() {}, onRetry() {} };
  const disconnected = render(PersonaConnectionNotice, 'en', {
    ...props,
    state: 'disconnected',
  });
  assert.match(disconnected, /Disconnected/);
  assert.match(disconnected, /Connect AI Persona in Settings/);
  assert.match(disconnected, />Connect<\/button>/);
  assert.doesNotMatch(disconnected, /未连接|去连接|设置/);
  const checking = render(PersonaConnectionNotice, 'en', {
    ...props,
    state: 'checking',
  });
  assert.match(checking, /Checking connection/);
  assert.doesNotMatch(checking, /Disconnected/);
  const unavailable = render(PersonaConnectionNotice, 'en', {
    ...props,
    state: 'unavailable',
  });
  assert.match(unavailable, /Connection status unavailable/);
  assert.doesNotMatch(unavailable, /Disconnected/);
  const connected = render(PersonaConnectionNotice, 'zh', {
    ...props,
    state: 'connected',
  });
  assert.match(connected, /已连接/);
  assert.doesNotMatch(connected, /去连接|尚未连接/);
  const settings = render(SettingsWorkspace, 'en', {
    demo: true,
    tab: 'persona',
  });
  assert.match(settings, /aria-current="page"[^>]*>AI Persona<\/button>/);
});

void test('feedback language follows the interface and preserves written feedback', () => {
  const value = {
    value: 'negative',
    reason: '保留我写的原文',
    updatedAt: '2026-09-07',
  };
  const en = render(FeedbackControl, 'en', {
    dimension: 'accuracy',
    language: 'zh',
    value,
    onChange() {},
  });
  assert.match(en, /Do you agree with this recommendation decision/);
  assert.match(en, /保留我写的原文/);
  assert.doesNotMatch(en, /你认可这个推荐判断吗/);
  const zh = render(FeedbackControl, 'zh', {
    dimension: 'accuracy',
    language: 'en',
    value,
    onChange() {},
  });
  assert.match(zh, /你认可这个推荐判断吗/);
});

void test('model settings and single paper forms use interface language', () => {
  const models = render(ModelSettingsPage, 'en');
  assert.match(models, /Connecting to the local service/);
  assert.match(models, /Analysis host/);
  assert.doesNotMatch(models, /模型设置|添加账号|默认模型/);
  const analysis = render(RealSingleAnalysis, 'en', {
    subscriptions: [],
    onModels() {},
  });
  assert.match(analysis, /Start analysis/);
  assert.match(analysis, /Content language/);
  assert.doesNotMatch(analysis, /开始分析|设置分析范围/);
});

void test('prompt settings translate interface copy and clearly separate demo from live editing', () => {
  const english = render(PromptSettingsPage, 'en', { demo: true });
  assert.match(english, /Prompt settings/);
  assert.match(english, /The demo does not connect to local prompts/);
  assert.doesNotMatch(english, /[\p{Script=Han}]/u);
  assert.match(
    render(PromptSettingsPage, 'zh', { demo: true }),
    /演示页面不连接本机提示词/,
  );
  assert.match(render(PromptSettingsPage, 'en'), /Loading prompts/);
});

void test('changing interface language leaves the report language and paragraphs intact', () => {
  const subscription = { ...DEFAULT_SUBSCRIPTIONS[0], language: 'zh' };
  const summary = buildSummaryPreview(PAPERS[0], subscription);
  const props = { paper: PAPERS[0], subscription, onEdit() {} };
  const english = render(SummaryPreview, 'en', props);
  const chinese = render(SummaryPreview, 'zh', props);
  assert.match(english, /Set length/);
  assert.match(chinese, /调整字数/);
  assert.match(english, /characters/);
  for (const section of summary.sections)
    for (const paragraph of section.paragraphs) {
      const escaped = renderToStaticMarkup(
        React.createElement('p', null, paragraph),
      );
      assert.ok(english.includes(escaped));
      assert.ok(chinese.includes(escaped));
    }
  assert.equal(subscription.language, 'zh');
});

const { PaperWorkspace } =
  await import('../components/radar/paper-workspace.tsx');
const { EvaluationsPage } = await import('../components/radar/evaluations.tsx');
void test('shared paper reader keeps generated language, report identity and feedback separate from UI language', () => {
  const report = {
    id: 'saved-report-v2',
    created_at: '2026-09-09T12:00:00Z',
    paper: {
      id: '2609.00001',
      version: 2,
      title: 'Saved paper',
      authors: ['A. Author'],
      url: 'https://arxiv.org/abs/2609.00001v2',
      abstract: 'Original abstract',
      coverage: { format: 'html', issues: [] },
    },
    settings_snapshot: {
      language: 'zh',
      summary_length: { min: 800, max: 1200 },
    },
    summary: {
      status: 'available',
      data: {
        sections: [
          {
            title: '原文标题',
            paragraphs: ['保留已经生成的中文研究总结。'],
            evidence_ids: ['paper:block1'],
          },
        ],
      },
    },
    personalization: {
      status: 'available',
      data: {
        decision: 'recommended',
        reasons: [
          {
            text: '保留原有推荐理由。',
            paper_evidence_ids: [],
            persona_evidence_ids: [],
          },
        ],
        connections: [],
        crossovers: [],
      },
    },
    persona: null,
    evidence_index: [],
    feedback_dimensions: ['accuracy'],
    feedback: {
      accuracy: {
        value: 'negative',
        reason: '保留用户反馈原文。',
        updatedAt: '2026-09-09',
      },
    },
  };
  const en = render(PaperWorkspace, 'en', { result: report });
  for (const label of [
    'Overview',
    'Full report',
    'saved-report-v2',
    '保留已经生成的中文研究总结。',
    '保留用户反馈原文。',
  ])
    assert.ok(en.includes(label), label);
  assert.doesNotMatch(
    en,
    /生成详细分析|完整报告|概览|Discuss|discussion|codex:\/\/|chatgpt\.com/,
  );
  assert.match(en, /role="tablist"/);
  assert.match(en, /aria-selected="true"/);
  assert.equal(report.settings_snapshot.language, 'zh');
});

void test('segmented language control exposes both choices and evaluation has an honest empty state', () => {
  const zh = render(LanguageSwitcher, 'zh', { segmented: true });
  assert.match(zh, />中文<\/button>/);
  assert.match(zh, />EN<\/button>/);
  assert.match(zh, /aria-pressed="true"/);
  const evaluation = render(EvaluationsPage, 'en', {
    demoItems: [],
    onOpen() {},
  });
  assert.match(evaluation, /No matching feedback/);
  assert.match(evaluation, /Connect the local service to run experiments/);
  assert.doesNotMatch(evaluation, /Prompt Workbench/);
  assert.doesNotMatch(evaluation, /Run evaluation|Start A\/B/);
});

const { HostRoutingSettings } =
  await import('../components/radar/host-routing-settings.tsx');
const { upgradeRoutes, HOST_TASKS } = await import('../lib/host-settings.ts');
void test('DSH settings render both presets, all advanced fields and failures in the chosen language', () => {
  const blank = { model: null, reasoningEffort: null };
  const routing = upgradeRoutes({
    revision: 1,
    tasks: Object.fromEntries(
      HOST_TASKS.map((task) => [task, structuredClone(blank)]),
    ),
    fallback: { ...blank, enabled: false },
  });
  routing.presets.fast = {
    model: { provider: 'test-provider', model: 'fast-id' },
    reasoningEffort: 'low',
  };
  routing.presets.deep = {
    model: { provider: 'test-provider', model: 'deep-id' },
    reasoningEffort: 'high',
  };
  routing.assignments.single = 'custom';
  routing.tasks.single = {
    model: { provider: 'test-provider', model: 'removed' },
    reasoningEffort: 'ultra',
  };
  const initial = {
    mode: 'dsh',
    connected: true,
    routing,
    tasks: HOST_TASKS.map((id) => ({ id, name: '不要显示后端中文' })),
    catalog: {
      defaults: { provider: 'test-provider', model: 'fast-id' },
      settingsUrl: 'http://127.0.0.1:3080',
      groups: [
        {
          id: 'test-provider',
          name: '中文厂商',
          models: ['fast', 'deep'].map((id) => ({
            provider: 'test-provider',
            model: `${id}-id`,
            name: `[Provider] ${id === 'fast' ? 'Fast Model' : 'Deep Model'}`,
            reasoning: {
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
              ],
            },
          })),
        },
      ],
    },
  };
  const en = render(HostRoutingSettings, 'en', { initial });
  for (const label of [
    'Fast &amp; economical',
    'Deep analysis',
    'Advanced settings',
    'Single-paper analysis',
    'Parallel tasks',
    'Fallback model',
    'Fast Model',
    'Deep Model',
    'This model is unavailable',
    'This thinking effort is unavailable',
  ])
    assert.ok(en.includes(label), label);
  assert.doesNotMatch(
    en.replace(/<[^>]*>/g, ''),
    /[\p{Script=Han}]|\[Provider\]/u,
  );
  for (const trigger of en.matchAll(
    /<button[^>]*data-slot="select-trigger"[\s\S]*?<\/button>/g,
  ))
    assert.doesNotMatch(
      trigger[0].replace(/<[^>]*>/g, ''),
      /test-provider|fast-id|deep-id|\[Provider\]/,
    );
  assert.doesNotMatch(en, /class="dsh-advanced" open/);
  const zh = render(HostRoutingSettings, 'zh', { initial });
  assert.match(zh, /快速省钱|深入分析/);
  const offline = render(HostRoutingSettings, 'en', {
    initial: {
      ...initial,
      catalog: null,
      connected: false,
      error: { message: '宿主错误原文' },
    },
  });
  assert.match(offline, /Start DSH/);
  assert.doesNotMatch(offline.replace(/<[^>]*>/g, ''), /[\p{Script=Han}]/u);
});

void test('saved agent stages, coverage, validation and error notices translate while source text stays intact', () => {
  for (const text of [
    '自主分析',
    'Agent 正在思考',
    'DSH 正在整理上下文',
    'Agent 正在查阅所选知识与材料',
    'Agent 正在查阅论文',
    'Agent 正在查阅讨论记录',
    'Agent 正在查阅已有分析',
    'Agent 正在整理笔记',
    'Agent 正在核对依据',
    'Agent 正在处理问题',
    '正文尚未读取；当前依据为论文元数据与摘要。',
    '无法连接 DSH 的 PaperRadar 插件，请检查宿主是否运行。',
    '宿主中的 Agent 运行已中断，请查看原任务后明确重试。',
    '引用、格式和个人事实由程序校验；阅读方式由 Agent 决定，未自动执行独立内容复核。',
    '部分完成，请查看待处理项或来源缺口',
    '正文实际 143 words，目标 200–400。',
    '不存在的论文引用：paper:2501.12345:v1',
    '材料 record.123 原文未读取：材料来源已变化，不能混用旧证据。',
  ])
    assert.doesNotMatch(translateUi(text, 'en'), /[\u3400-\u9fff]/, text);
  assert.equal(translateUi('筛选：推荐', 'en'), 'Screening: 推荐');
  assert.equal(
    translateUi('无效论文证据：paper.中文.v1', 'en'),
    'Invalid paper evidence: paper.中文.v1',
  );
  assert.equal(
    translateUi('阅读结果中的中文研究内容', 'en'),
    '阅读结果中的中文研究内容',
  );
});

void test('runtime and notification states use the selected language without advertising unlimited budgets', async () => {
  const { TaskRuntime } = await import('../components/radar/task-runtime.tsx');
  const { elapsedTime } = await import('../lib/task-runtime.ts');
  const { notificationLabel } = await import('../lib/task-notifications.ts');
  const { TaskNotifications } =
    await import('../components/radar/task-notifications.tsx');
  const started = '2026-09-10T12:00:00Z';
  assert.equal(
    elapsedTime(started, Date.parse(started) + 1000 * 3661),
    '1:01:01',
  );
  assert.equal(elapsedTime(started, Date.parse(started) - 1000), '00:00');
  assert.equal(elapsedTime(undefined, Date.now()), '—');
  const en = render(TaskRuntime, 'en', {
    status: 'running',
    started_at: started,
    actual_attempts: 27,
  });
  assert.match(en, /Elapsed/);
  assert.match(en, /Model calls: 27/);
  assert.doesNotMatch(en, /无限|unlimited|[\u3400-\u9fff]/i);
  assert.match(
    render(TaskRuntime, 'zh', {
      status: 'running',
      started_at: started,
      actual_attempts: 27,
    }),
    /模型调用 27 次/,
  );
  assert.match(
    render(TaskRuntime, 'en', {
      status: 'queued',
      created_at: started,
      actual_attempts: 0,
    }),
    /Waiting/,
  );
  for (const kind of ['analysis', 'daily', 'discussion'])
    for (const status of [
      'succeeded',
      'completed',
      'partial',
      'failed',
      'interrupted',
      'paused',
      'cancelled',
    ]) {
      const label = notificationLabel({ kind, status });
      assert.doesNotMatch(
        translateUi(label.kind, 'en') + ' ' + translateUi(label.status, 'en'),
        /[\u3400-\u9fff]/,
      );
      if (['partial', 'failed', 'cancelled'].includes(status))
        assert.notEqual(label.status, '已完成');
    }
  assert.match(render(TaskNotifications, 'en'), /Task notifications, 0 unread/);
  assert.match(render(TaskNotifications, 'zh'), /任务通知，0 条未读/);
});

void test('recommendation feedback shows the derived answer for all four binary cases and no label for uncertain decisions', () => {
  for (const decision of ['recommended', 'not_recommended']) {
    for (const value of ['positive', 'negative']) {
      const html = render(FeedbackControl, 'en', {
        dimension: 'accuracy',
        decision,
        value: { value, reason: '', updatedAt: '2026-09-15' },
        onChange() {},
      });
      const positive = (decision === 'recommended') === (value === 'positive');
      assert.ok(
        html.includes(
          positive
            ? 'Answer: should recommend'
            : 'Answer: should not recommend',
        ),
      );
      assert.match(html, /Do you agree with this recommendation decision/);
      assert.match(html, /Satisfied/);
    }
  }
  const uncertain = render(FeedbackControl, 'en', {
    dimension: 'accuracy',
    decision: 'needs_fulltext',
    value: { value: 'negative', reason: '', updatedAt: '2026-09-15' },
    onChange() {},
  });
  assert.doesNotMatch(uncertain, /Answer: should/);
});

const { HostModelSettings } =
  await import('../components/radar/host-model-settings.tsx');
const { EvaluationRunReport } =
  await import('../components/radar/evaluation-run-report.tsx');
const { EvidenceSource } =
  await import('../components/radar/evidence-source.tsx');
const { thinkingEffortLabel } = await import('../lib/host-settings-copy.ts');
const { notificationTitle } = await import('../lib/task-notifications.ts');
const { experimentName } = await import('../lib/evaluation-display.ts');

void test('loaded model failures and evaluation reports switch language while preserving user names', () => {
  const blank = { model: null, reasoningEffort: null };
  const backend = {
    connected: false,
    routing: upgradeRoutes({
      revision: 1,
      tasks: Object.fromEntries(HOST_TASKS.map((id) => [id, blank])),
      fallback: { ...blank, enabled: false },
    }),
    tasks: [],
    catalog: null,
    error: {
      code: 'codex_start_failed',
      message: '无法启动 Codex，请确认本机已经安装 Codex。',
    },
  };
  const initial = {
    mode: 'host-router',
    activeBackend: 'codex',
    revision: 1,
    backends: { codex: backend, dsh: backend },
  };
  const english = render(HostModelSettings, 'en', { initial });
  assert.match(english, /Could not start Codex/);
  assert.doesNotMatch(english, /\p{Script=Han}/u);
  assert.match(render(HostModelSettings, 'zh', { initial }), /无法启动 Codex/);
  const report = {
    status: 'failed',
    title: '我的实验',
    name: '我的实验',
    created_at: '2026-09-15T10:00:00Z',
    items: [],
    candidates: [],
    scores: {},
    comparisons: [],
    actual_calls: 0,
    usage: { input: 0, output: 0, cost: null },
    error: '知识库返回的 tag 范围与测试样例不一致。',
  };
  const result = render(EvaluationRunReport, 'en', { report, cases: [] });
  assert.match(result, /我的实验/);
  assert.match(
    result,
    /The tag scope returned by the knowledge base does not match the test cases/,
  );
  assert.doesNotMatch(result.replaceAll('我的实验', ''), /\p{Script=Han}/u);
});

void test('known effort IDs and system names translate; source names and custom experiment names remain verbatim', () => {
  assert.equal(thinkingEffortLabel('low', 'en'), 'Low');
  assert.equal(thinkingEffortLabel('low', 'zh'), '低');
  assert.equal(
    thinkingEffortLabel('provider-specific', 'en'),
    'provider-specific',
  );
  const value = { name: '我的推荐测试集 · 新实验', name_is_default: true };
  assert.equal(
    experimentName(value, 'en'),
    'My recommendation dataset · New experiment',
  );
  assert.equal(experimentName(value, 'zh'), value.name);
  assert.equal(
    experimentName({ ...value, name_is_default: false }, 'en'),
    value.name,
  );
  const notice = {
    kind: 'evaluation',
    status: 'failed',
    title: '我的推荐测试集',
  };
  assert.equal(
    notificationTitle({ ...notice, title_is_default: true }, 'en'),
    'My recommendation dataset',
  );
  assert.equal(notificationTitle(notice, 'en'), notice.title);
  for (const [kind, label] of [
    ['abstract', 'Paper abstract'],
    ['reference', 'References'],
  ]) {
    const evidence = {
      kind,
      section: '用户章节名称',
      locator: {},
      file_name: '中文论文.pdf',
    };
    const result = render(EvidenceSource, 'en', { evidence });
    assert.ok(result.includes(label));
    assert.match(result, />Section</);
    assert.match(result, /用户章节名称/);
    assert.match(result, /中文论文.pdf/);
  }
  assert.equal(translateUi('生成语言', 'en'), 'Output language');
  assert.equal(translateUi('平衡', 'en'), 'Balanced');
  assert.equal(
    translateUi('Codex 模型 推荐 当前不可用。', 'en'),
    'Codex model 推荐 is currently unavailable.',
  );
});

const { FirstUse } = await import('../components/radar/first-use.tsx');
void test('first use starts with Persona connection and subscription guidance in both languages', () => {
  const zh = render(FirstUse, 'zh', { onFinished() {} });
  const en = render(FirstUse, 'en', { onFinished() {} });
  assert.match(zh, /接入 AI Persona/);
  assert.match(zh, /创建订阅/);
  assert.doesNotMatch(zh, /体验示例|模拟数据/);
  assert.match(en, /Connect AI Persona/);
  assert.match(en, /Create a subscription/);
  assert.doesNotMatch(en.replaceAll('中文', ''), /[\u3400-\u9fff]/u);
});
