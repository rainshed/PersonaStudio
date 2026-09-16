import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisDatabase } from '../../server/analyses/database.mjs';
import { AnalysisService } from '../../server/analyses/service.mjs';
import { hash, AnalysisError } from '../../server/analyses/contracts.mjs';
import { parseArxiv } from '../../lib/arxiv.ts';
import { DailyRepository } from '../../server/daily/repository.mjs';
import { DailyService } from '../../server/daily/service.mjs';
import { parseFeed } from '../../server/daily/discovery.mjs';
const subject = 'cond-mat.stat-mech';
const xmlEntry = (
  id = '2501.12903',
  type = 'new',
  version = 1,
  date = '2026-09-07',
  extra = '',
) =>
  `<entry><id>oai:arXiv.org:${id}v${version}</id><title>Measured transport ${id}</title><summary>arXiv:${id}v${version} Announce Type: ${type} Abstract: A controlled model of measured transport and fluctuations.</summary><category term="${subject}"/><published>${date}T00:00:00-04:00</published><arxiv:announce_type>${type}</arxiv:announce_type><dc:creator>Example Author</dc:creator>${extra}</entry>`;
const feed = (entries, updated = '2026-09-07T04:00:00Z') =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><id>http://rss.arxiv.org/atom/${subject}</id><updated>${updated}</updated>${entries}</feed>`;
const record = {
  id: 'record-physics',
  title: 'Measured transport',
  record_revision: 2,
  tags: ['tag-physics'],
  interest_level: 'medium',
  knowledge_level: 'familiar',
  user_relationships: ['authored'],
  entity_type: 'knowledge_node',
};
const context = {
  schema_version: 'paper-radar.persona-context/v2',
  knowledge_ids: [record.id],
  relations: [],
  retrieval: [],
  identity: 'persona-test',
  revision: 7,
  scope: { tag_ids: ['tag-physics'], tag_match: 'any' },
  tags: [{ id: 'tag-physics', label: 'Physics' }],
  records: [record],
  evidence: [
    {
      id: 'persona:record-physics:r2',
      record_id: record.id,
      title: record.title,
      kind: 'record',
      text: 'Measured transport; interest_level medium; user_relationships authored.',
    },
  ],
  coverage: {
    total_records: 1,
    searched_records: 1,
    complete_knowledge_scan: true,
  },
};
const subscription = {
  name: 'Transport',
  subject,
  persona_connection_id: context.identity,
  scope: context.scope,
  language: 'zh',
  summary_length: { min: 200, max: 400 },
  status: 'enabled',
  include_updates: false,
  max_model_calls: 200,
};
const screen = (paper, outcome = 'not_recommended') => ({
  paper_version: `${paper.id}v${paper.version}`,
  outcome,
  introduction:
    '论文研究 measurement-induced transport，比较动力学和 fluctuations。',
  reason: '本次论文与范围内材料研究对象不同。',
  paper_evidence_ids: [paper.evidence_id],
  persona_evidence_ids: [context.evidence[0].id],
  claims: [],
  questions_for_fulltext: [],
});
async function fixture(
  t,
  {
    count = 3,
    outcome = 'not_recommended',
    finalDecision = 'recommended',
    modelDelay = 0,
    mutateModel,
    personaError = false,
    maxCalls = 200,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-daily-test-')),
    db = await new AnalysisDatabase(dir).open();
  const repo = new DailyRepository(db),
    xml = feed(
      Array.from({ length: count }, (_, i) =>
        xmlEntry(`2501.${String(10000 + i)}`),
      ).join(''),
    );
  const revision = repo.archiveFeed({
    ...parseFeed(xml, subject),
    url: 'https://rss.arxiv.org/atom/' + subject,
    xml,
  })[0];
  const settings = {
    dsh: { protocol: 'paper-radar-harness/v1' },
    defaultConnectionId: 'test-model',
    overrides: { screen: null, summary: null, connections: null },
    fallback: { enabled: false, connectionId: null },
    connections: [
      {
        id: 'test-model',
        revision: 'r1',
        modelId: 'fixture-model',
        providerId: 'custom',
        contextWindow: 100000,
        maxTokens: 8192,
      },
    ],
  };
  let calls = 0;
  const models = {
    mode: 'dsh',
    supportsAgents: true,
    managesConcurrency: true,
    concurrency: 4,
    running: 0,
    store: { state: { settings } },
    async run(request, options) {
      const attemptId = randomUUID();
      await options.beforeAttempt?.(settings.connections[0], {
        id: attemptId,
        started_at: new Date().toISOString(),
      });
      calls++;
      if (modelDelay)
        await delay(modelDelay, undefined, { signal: options.signal });
      let data;
      if (request.task === 'screen') {
        const paper = JSON.parse(
          request.prompt.split('\nPAPER: ')[1].split('\nPERSONA EVIDENCE: ')[0],
        );
        data = screen(
          paper,
          typeof outcome === 'function' ? outcome(paper) : outcome,
        );
      } else if (request.prompt.startsWith('Review ')) data = { issues: [] };
      else if (request.task === 'summary')
        data = {
          sections: Array.from({ length: 6 }, (_, i) => ({
            title: '章节 ' + i,
            paragraphs: [
              `第${i + 1}节：论文在明确条件下研究测量输运，比较动力学的变化。该结果仅适用于文中模型，尚待进一步验证。`,
            ],
            evidence_ids: [request.prompt.match(/paper:[\w.]+:1/)[0]],
          })),
        };
      else
        data = {
          decision: finalDecision,
          reasons: [
            {
              text: '测量输运与所选材料有关。',
              paper_evidence_ids: [request.prompt.match(/paper:[\w.]+:1/)[0]],
              persona_evidence_ids: [context.evidence[0].id],
              claims: [],
            },
          ],
          connections: [],
          crossovers: [],
        };
      const output = {
        text: JSON.stringify(data),
        modelId: 'fixture-model',
        providerId: 'custom',
        requestId: 'req-' + calls,
      };
      mutateModel?.(output, request, calls);
      options.onAttempt?.({
        id: attemptId,
        model_id: output.modelId,
        status: 'succeeded',
        duration_ms: 1,
        usage: { input: 10, output: 20, cost: null },
      });
      return output;
    },
  };
  models.runAgent = async (request, options) => {
    const task = JSON.parse(request.prompt);
    if (task.output?.schema === 'screening.autonomous.v1') {
      const paper = {
        ...task.paper,
        version: Number(task.paper.version.split('v').at(-1)),
        evidence_id: task.paper.source_ref,
      };
      let page = task.persona;
      while (page.next_offset != null)
        page = await options.onTool('persona_list_scope', {
          offset: page.next_offset,
        });
      const raw = await models.run(
        {
          ...request,
          prompt:
            request.systemPrompt +
            '\nPAPER: ' +
            JSON.stringify(paper) +
            '\nPERSONA EVIDENCE: ' +
            JSON.stringify(context),
        },
        options,
      );
      const value = JSON.parse(raw.text);
      const data = {
        schema: task.output.schema,
        paper_version: value.paper_version,
        decision:
          value.outcome === 'needs_fulltext' ? 'needs_review' : value.outcome,
        introduction: value.introduction,
        reason: value.reason,
        criterion_ids: ['selected-knowledge'],
        paper_evidence_ids: value.paper_evidence_ids,
        persona_evidence_ids: value.persona_evidence_ids,
        persona_coverage_ref: page.source_ref,
        claims: value.claims,
        open_questions:
          value.outcome === 'needs_fulltext' &&
          !value.questions_for_fulltext.length
            ? ['需要全文核对研究条件。']
            : value.questions_for_fulltext,
      };
      await options.onTool('screening_submit_result', data);
      return { ...raw, data };
    }
    let page;
    if (task.persona_scope)
      page = await options.onTool('persona_search', { query: '' });
    if (request.task === 'discussion') {
      const history = await options.onTool('history_read', { offset: 0 });
      const outline = await options.onTool('paper_get_outline', {});
      const refs = new Map();
      for (const section of outline.sections)
        for (const block of section.blocks) {
          const read = await options.onTool('paper_read', {
            section_id: block.id,
          });
          refs.set(block.id, read.source_ref);
        }
      const raw = await models.run(
        {
          ...request,
          prompt:
            'CURRENT USER QUESTION: ' +
            task.goal.question +
            '\n' +
            JSON.stringify(history) +
            '\n' +
            JSON.stringify(task.anchor ?? null) +
            '\n' +
            task.paper.source_ref,
        },
        options,
      );
      const data = JSON.parse(raw.text);
      for (const paragraph of data.paragraphs ?? [])
        paragraph.evidence_ids = paragraph.evidence_ids.map(
          (id) => refs.get(id) ?? id,
        );
      await options.onTool('task_submit_result', data);
      return { ...raw, data };
    }
    // The deterministic Agent submits a complete report in one host attempt.
    const attemptId = randomUUID();
    await options.beforeAttempt?.(settings.connections[0], { id: attemptId });
    calls++;
    if (modelDelay)
      await delay(modelDelay, undefined, { signal: options.signal });
    const summary = {
      sections: Array.from({ length: 6 }, (_, i) => ({
        title: '章节 ' + i,
        paragraphs: [
          `第${i + 1}节：论文在明确条件下研究测量输运，比较动力学的变化。该结果仅适用于文中模型，尚待进一步验证。`,
        ],
        evidence_ids: [task.paper.source_ref],
      })),
    };
    const personalization = {
      decision: finalDecision,
      reasons: [
        {
          text: '测量输运与所选知识有关。',
          paper_evidence_ids: [task.paper.source_ref],
          persona_evidence_ids: page?.items?.[0]
            ? [page.items[0].source_ref]
            : [],
          claims: [],
        },
      ],
      connections: [],
      crossovers: [],
    };
    const data =
      request.task === 'summary'
        ? summary
        : request.task === 'connections'
          ? personalization
          : { summary, ...(task.persona_scope ? { personalization } : {}) };
    const output = {
      text: JSON.stringify(data),
      modelId: 'fixture-model',
      providerId: 'fixture-host',
      requestId: 'req-' + calls,
    };
    mutateModel?.(output, request, calls);
    const result = JSON.parse(output.text);
    await options.onTool('task_submit_result', result);
    options.onAttempt?.({
      id: attemptId,
      status: 'succeeded',
      usage: { input: 10, output: 20 },
    });
    return { ...output, data: result };
  };
  const persona = {
    async scopeReader(input) {
      return {
        tags: context.tags,
        scope: input.scope,
        revision: context.revision,
        scoped: async (name, args = {}) => {
          const records = context.records.map(r => ({ ...r, provenance: { kind: 'record', record_id: r.id, record_revision: r.record_revision } }));
          const envelope = data => ({ schema_version: 'ai-persona.query-result/v2', tool: name, ok: true, scope: input.scope, persona_revision: context.revision, data, next_cursor: null, warnings: [], coverage: { truncated: false } });
          if (name === 'search_knowledge')
            return envelope({ hits: records.map(r => ({ id: r.id })), nodes: records, edges: [], excerpts: [] });
          if (name === 'get_knowledge_map') return envelope({ domains: context.tags, nodes: records, edges: [], frontier: [] });
          if (name === 'get_persona_records') return envelope({ items: records.filter(r => args.record_ids.includes(r.id)).map(r => ({ id: r.id, entity_type: r.entity_type, record_revision: r.record_revision, provenance: r.provenance, record: r, completeness: 'complete', evidence: [] })) });
          throw new Error('Unsupported fixture tool ' + name);
        },
      };
    },
    async records(_range, ids) {
      return {
        records: structuredClone(
          context.records.filter((r) => ids.includes(r.id)),
        ),
        issues: [],
      };
    },
    async supplement(paper, input, saved) {
      return { context: saved, limitation: null };
    },
    async screeningSnapshot() {
      if (personaError)
        throw new AnalysisError(
          'persona_unavailable',
          'Persona disconnected',
          true,
        );
      return structuredClone(context);
    },
    async snapshot() {
      return { ...structuredClone(context), matches: [] };
    },
    async close() {},
    async status() {
      return { connected: true };
    },
  };
  const arxiv = {
    async get(input) {
      const p = parseArxiv(input);
      return {
        ...p,
        title: 'Measured transport',
        abstract: 'Controlled measurement',
        authors: ['Example Author'],
        source_hash: hash(p),
        parser_version: 'test-v1',
        blocks: [
          {
            id: `paper:${p.id}:1`,
            kind: 'paragraph',
            text: 'Controlled measured transport evidence.',
          },
        ],
        references: [],
        coverage: {
          format: 'html',
          block_count: 1,
          reference_count: 0,
          issues: [],
        },
      };
    },
  };
  const analyses = new AnalysisService(db, models, arxiv, persona),
    daily = new DailyService(analyses, {
      discovery: { latest: async () => revision },
      pollMs: 1,
    });
  t.after(async () => {
    await daily.close();
    await analyses.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const sub = await daily.saveSubscription({
    ...subscription,
    max_model_calls: maxCalls,
  });
  const create = (key = 'request-test', extra = {}) =>
    daily.create(
      {
        subscription_id: sub.id,
        expected_subscription_revision: sub.revision,
        source: { kind: 'latest_announcement' },
        ...extra,
      },
      key,
    );
  const finish = async (id) => {
    for (let i = 0; i < 5000; i++) {
      const run = daily.getRun(id);
      if (!['queued', 'running'].includes(run.status)) return run;
      await delay(2);
    }
    throw new Error('Task did not finish');
  };
  return {
    db,
    repo,
    daily,
    analyses,
    models,
    sub,
    revision,
    create,
    finish,
    async detail(itemId, key = 'explicit-detail-' + Date.now()) {
      daily.analyzeItem(itemId, key);
      for (let i = 0; i < 5000; i++) {
        const item = daily.getItem(itemId);
        if (!['queued', 'running'].includes(item.job?.status)) return item;
        await delay(2);
      }
      throw new Error('Detail did not finish');
    },
    get calls() {
      return calls;
    },
  };
}

export {
  fixture,
  subject,
  xmlEntry,
  feed,
  record,
  context,
  subscription,
  screen,
};
