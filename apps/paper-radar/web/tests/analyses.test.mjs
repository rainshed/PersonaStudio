import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisDatabase } from '../server/analyses/database.mjs';
import { AnalysisService } from '../server/analyses/service.mjs';
import { referenceMatches } from '../server/persona/service.mjs';
import {
  ArxivReader,
  parseHTML,
  parseAtom,
  officialURL,
  parsePDF,
} from '../server/analyses/arxiv.mjs';
import {
  validateInput,
  parseOutput,
  summarySchema,
  validateSummary,
  validatePersonal,
} from '../server/analyses/contracts.mjs';
import { testHost } from './helpers/agent-host.mjs';
import { createModelServer } from '../server/index.mjs';

const paper = {
  id: '2501.12903',
  version: 3,
  url: 'https://arxiv.org/abs/2501.12903v3',
  title: 'Synthetic monitored transport paper',
  authors: ['Example Author'],
  abstract: 'Measured transport and nodal decay',
  source_hash: 'fixture-source',
  parser_version: 'fixture-v1',
  blocks: [
    {
      id: 'paper:test:1',
      kind: 'paragraph',
      section: 'Results',
      text: 'Synthetic controlled evidence for measurement and transport.',
      url: 'https://arxiv.org/html/2501.12903v3#S1',
    },
    {
      id: 'paper:test:2',
      kind: 'reference',
      section: 'References',
      text: 'Example Author, Exact reference title for transport experiments',
      url: 'https://arxiv.org/html/2501.12903v3#bib1',
    },
  ],
  references: [
    {
      evidence_id: 'paper:test:2',
      text: 'Example Author. Exact reference title for transport experiments.',
      links: [],
    },
  ],
  coverage: { format: 'html', reference_count: 1, block_count: 2, issues: [] },
};
const record = {
  id: 'material-1',
  entity_type: 'material',
  title: 'Exact reference title for transport experiments',
  record_revision: 2,
  tags: ['tag-physics'],
  interest_level: 'medium',
  knowledge_level: 'familiar',
  user_relationships: ['authored'],
  bibliography: {},
  description: 'Monitored nodal transport',
  abstract: '',
  summary: '',
  source: null,
};
const knowledge = {
  id: 'knowledge-transport',
  entity_type: 'knowledge_node',
  title: 'Transport',
  tags: ['tag-physics'],
  record_revision: 1,
  knowledge_level: 'aware',
  interest_level: 'high',
  scope_note: 'Focus on superdiffusion',
};
const persona = {
  schema_version: 'paper-radar.persona-context/v2',
  knowledge_ids: [knowledge.id],
  relations: [],
  retrieval: [],
  identity: 'persona-test',
  revision: 7,
  scope: { tag_ids: ['tag-physics'], tag_match: 'any' },
  tags: [{ id: 'tag-physics', label: 'Physics' }],
  records: [record, knowledge],
  evidence: [
    {
      id: 'persona:knowledge-transport:r1',
      kind: 'record',
      record_id: knowledge.id,
      text: JSON.stringify(knowledge),
      title: knowledge.title,
    },
    {
      id: 'persona:material-1:r2',
      record_id: record.id,
      title: record.title,
      kind: 'record',
      text: 'Recorded interest medium; relationship authored.',
    },
  ],
  matches: [
    {
      material_id: record.id,
      evidence_id: 'paper:test:2',
      basis: 'exact_unique_title',
    },
  ],
  coverage: {
    total_records: 1,
    searched_records: 1,
    selected_records: 1,
    complete_knowledge_scan: true,
    issues: [],
  },
};
const input = {
  arxiv_input: paper.url,
  persona_connection_id: null,
  scope: { tag_ids: [], tag_match: 'any' },
  language: 'zh',
  summary_length: { min: 400, max: 1000 },
  force_regenerate: false,
};
const summary = {
  sections: Array.from({ length: 6 }, (_, i) => ({
    title: '研究部分 ' + (i + 1),
    paragraphs: [
      `第${i + 1}部分：` +
        '研究围绕明确的模型和条件展开，比较不同设置下的结果，并根据原文证据区分结论与尚未验证的推测。'.repeat(
          2,
        ),
    ],
    evidence_ids: ['paper:test:1'],
  })),
};
const personal = {
  decision: 'recommended',
  reasons: [
    {
      text: 'This paper cites a material recorded as authored.',
      paper_evidence_ids: ['paper:test:2'],
      persona_evidence_ids: [
        'persona:material-1:r2',
        'persona:knowledge-transport:r1',
      ],
      claims: [
        {
          record_id: record.id,
          field: 'user_relationships',
          value: 'authored',
        },
      ],
    },
  ],
  connections: [
    {
      material_id: record.id,
      relation_type: 'direct_citation',
      explanation: 'Direct citation and distinct measured observables.',
      paper_evidence_ids: ['paper:test:2'],
      persona_evidence_ids: ['persona:material-1:r2'],
    },
  ],
  crossovers: [],
};
function engine(fn) {
  return {
    generate: async (c, r) => {
      const text = fn
        ? await fn(c, r)
        : JSON.stringify(
            r.prompt.startsWith('Review ')
              ? { issues: [] }
              : r.task === 'summary'
                ? summary
                : personal,
          );
      return {
        text,
        modelId: c.modelId,
        providerId: c.providerId,
        usage: { input: 10, output: 10, cost: null },
        stopReason: 'stop',
      };
    },
  };
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'paper-radar-analysis-'));
  const db = await new AnalysisDatabase(join(dir, 'data')).open();
  const models = testHost({
    agent: async ({ request, options: call, task, c }) => {
      const outline = await call.onTool('paper_get_outline', {});
      for (const section of outline.sections)
        for (const block of section.blocks)
          await call.onTool('paper_read', { section_id: block.id });
      if (task.persona_scope) {
        const found = await call.onTool('persona_search', { query: '' });
        for (const item of found.items)
          await call.onTool('persona_read_record', {
            record_id: item.record_id,
          });
      }
      const generator = options.engine ?? engine();
      const summaryOutput = await generator.generate(c, {
        ...request,
        task: 'summary',
      });
      const data = { summary: JSON.parse(summaryOutput.text) };
      if (task.persona_scope)
        data.personalization = JSON.parse(
          (await generator.generate(c, { ...request, task: 'connections' }))
            .text,
        );
      await call.onTool('task_submit_result', data);
      return data;
    },
  });
  const app = new AnalysisService(
    db,
    models,
    options.arxiv ?? { get: async () => structuredClone(paper) },
    options.persona ?? {
      snapshot: async () => structuredClone(persona),
      status: async () => ({ connected: true }),
      tags: async () => ({ tags: persona.tags }),
      close: async () => {},
    },
    options.limits,
  );
  t.after(async () => {
    await app.close();
    await models.close();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, db, models, app };
}
async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await delay(5);
  }
  throw Error('Test timed out');
}
const terminal = async (app, id) =>
  until(() => {
    const j = app.getJob(id);
    return !['queued', 'running'].includes(j.status) && j;
  });

void test('analysis inputs validate ranges and preserve explicit empty scope', () => {
  assert.deepEqual(validateInput(input).scope, {
    tag_ids: [],
    tag_match: 'any',
  });
  for (const patch of [
    { arxiv_input: 'https://example.org/abs/2501.12903' },
    { summary_length: { min: 900, max: 800 } },
    {
      scope: { tag_ids: ['tag-physics'], tag_match: 'any' },
      persona_connection_id: null,
    },
    { language: 'fr' },
    { prompt: 'untrusted override' },
  ])
    assert.throws(() => validateInput({ ...input, ...patch }));
});
void test('output checks reject nonexistent evidence, fabricated facts and unconfirmed citations', () => {
  assert.throws(() => parseOutput('{"sections":', summarySchema));
  assert.equal(
    validateSummary(summary, input, new Set(['paper:test:1'])).issues.length,
    0,
  );
  assert.ok(validateSummary(summary, input, new Set()).issues.length);
  assert.ok(
    validateSummary(
      summary,
      { ...input, summary_length: { min: 200, max: 300 } },
      new Set(['paper:test:1']),
    ).issues.length,
  );
  assert.deepEqual(validatePersonal(personal, paper, persona), []);
  for (const decision of ['recommended', 'not_recommended', 'undetermined']) {
    const materialOnly = structuredClone(personal);
    materialOnly.decision = decision;
    materialOnly.reasons.forEach((reason) => {
      reason.persona_evidence_ids = [
        `persona:${record.id}:r${record.record_revision}`,
      ];
    });
    assert.ok(
      validatePersonal(materialOnly, paper, persona).some((issue) =>
        issue.includes('知识点'),
      ),
    );
  }
  const bad = structuredClone(personal);
  bad.reasons[0].claims = [
    { record_id: record.id, field: 'interest_level', value: 'high' },
  ];
  bad.connections[0].paper_evidence_ids = ['paper:test:1'];
  assert.ok(validatePersonal(bad, paper, persona).length >= 2);
  assert.equal(referenceMatches(paper, [record]).length, 1);
  assert.equal(
    referenceMatches(paper, [record, { ...record, id: 'ambiguous' }]).length,
    0,
  );
});
void test('HTML extraction retains math, captions, references and unique source locations', () => {
  const html =
    '<article><section id="S1"><h2 class="ltx_title">Methods</h2><div class="ltx_para" id="P1"><p>Model <math alttext="N=L/2"><mi>bad duplicate</mi></math> with precise assumptions.</p><div class="ltx_equation">included equation</div></div><figcaption class="ltx_caption" id="F1">Measured result with finite size.</figcaption></section><li class="ltx_bibitem" id="B1">Exact reference title for transport experiments <a href="https://doi.org/10.1234/example">DOI</a></li></article>';
  const p = parseHTML(html, 'https://arxiv.org/html/2501.12903v3', 'abcd');
  assert.equal(p.blocks.length, 3);
  assert.match(p.blocks[0].text, /N=L\/2/);
  assert.ok(!p.blocks[0].text.includes('bad duplicate'));
  assert.equal(p.references.length, 1);
  assert.ok(p.blocks[0].url.endsWith('#P1'));
  assert.equal(new Set(p.blocks.map((b) => b.id)).size, 3);
  assert.throws(() => officialURL('https://arxiv.org.evil.test/a'));
  assert.throws(() => officialURL('https://user@arxiv.org/a'));
});
void test('HTML detects a supplemental title embedded in a paragraph without treating citations as supplements', () => {
  const reference =
    '<li class="ltx_bibitem">Supplemental Materials: see the publisher website for details.</li>';
  const mention =
    '<div class="ltx_para">See supplemental materials for additional details of this calculation.</div>';
  const title =
    '<div class="ltx_para" id="p22"><b>Supplemental Materials: Example research paper</b><br>Example Author</div>';
  const section =
    '<section><h2 class="ltx_title">I Detailed calculations</h2><div class="ltx_para">Additional mathematical derivations with explicit conditions.</div></section>';
  const withoutSupplement = parseHTML(
    reference + mention,
    'https://arxiv.org/html/2302.01355v2',
    'example',
  );
  assert.equal(withoutSupplement.coverage.supplement_detected, false);
  const withSupplement = parseHTML(
    reference + mention + title + section,
    'https://arxiv.org/html/2302.01355v2',
    'example',
  );
  assert.equal(withSupplement.coverage.supplement_detected, true);
  assert.ok(
    withSupplement.blocks.some((b) => b.section === 'I Detailed calculations'),
  );
});
void test('arXiv version cache avoids repeated body downloads and rechecks unversioned input', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-radar-arxiv-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const xml =
    '<feed><entry><id>http://arxiv.org/abs/2501.12903v3</id><title>Test paper</title><summary>Abstract</summary><author><name>Example</name></author><published>2025-01-01</published></entry></feed>';
  const html =
    '<article>' +
    Array.from(
      { length: 7 },
      (_, i) =>
        `<div class="ltx_para" id="P${i}">${'Measured results and full experimental assumptions. '.repeat(12)}</div>`,
    ).join('') +
    '</article>';
  const r = new ArxivReader(dir, {
    interval: 0,
    fetcher: async (url) => {
      calls++;
      return new Response(url.includes('/api/query') ? xml : html, {
        headers: { 'Content-Type': 'text/html' },
      });
    },
  });
  const p = await r.get(paper.url, AbortSignal.timeout(3000));
  assert.equal(p.version, 3);
  assert.equal(calls, 2);
  assert.equal(
    (await r.get(paper.url, AbortSignal.timeout(3000))).cache_hit,
    true,
  );
  assert.equal(calls, 2);
  await r.get('2501.12903', AbortSignal.timeout(3000));
  assert.equal(calls, 3);
  assert.throws(() => parseAtom(xml, { id: '2501.12903', version: 1 }), /版本/);
});
void test('PDF fallback parser extracts page evidence without interpreting images', async () => {
  const content =
    'BT /F1 12 Tf 50 700 Td (A controlled PDF text extraction example.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const p = await parsePDF(
    Buffer.from(pdf),
    'https://arxiv.org/pdf/2501.12903v3',
    'sample',
    AbortSignal.timeout(5000),
  );
  assert.match(p.blocks[0].text, /controlled PDF/);
  assert.equal(p.blocks[0].page, 1);
  assert.equal(p.coverage.figures_interpreted, false);
});
void test('summary-only job persists actual content and never reads Persona; cached repeat makes no new model requests', async (t) => {
  let personaCalls = 0;
  const { app, db } = await fixture(t, {
    persona: {
      snapshot: async () => {
        personaCalls++;
        throw Error();
      },
      close: async () => {},
    },
  });
  const first = app.create(input, 'request-summary-1');
  const job = await terminal(app, first.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const result = app.getResult(job.result_id);
  assert.equal(result.summary.status, 'available');
  assert.equal(result.personalization.status, 'not_requested');
  assert.deepEqual(result.feedback_dimensions, []);
  assert.equal(personaCalls, 0);
  assert.equal(result.attempts.length, 1);
  const again = app.create(
    { ...input, arxiv_input: '2501.12903v3' },
    'request-summary-1',
  );
  assert.equal(again.job.id, job.id);
  assert.throws(
    () => app.create({ ...input, language: 'en' }, 'request-summary-1'),
    /不同/,
  );
  const repeat = await terminal(
    app,
    app.create(input, 'request-summary-2').job.id,
  );
  assert.equal(app.getResult(repeat.result_id).summary.cache_hit, true);
  assert.equal(db.attempts(repeat.id).length, 0);
  const existing = app.getJob(job.id);
  assert.equal(existing.model_settings, undefined);
  assert.equal(app.getResult(job.result_id).evidence, undefined);
});
void test('Persona initialization failure stops the Agent before generation and hides private error details', async (t) => {
  const { app } = await fixture(t, {
    persona: {
      snapshot: async () => {
        throw Error('private source path must not escape');
      },
      close: async () => {},
    },
  });
  const job = await terminal(
    app,
    app.create(
      { ...input, persona_connection_id: 'persona-test', scope: persona.scope },
      'request-persona-failure',
    ).job.id,
  );
  assert.equal(job.status, 'failed');
  assert.equal(job.actual_attempts, 0);
  assert.ok(!JSON.stringify(job).includes('private source path'));
});
void test('full analysis accepts recommendation feedback only and keeps its independent test sample', async (t) => {
  const { app, db } = await fixture(t);
  const job = await terminal(
    app,
    app.create(
      { ...input, persona_connection_id: 'persona-test', scope: persona.scope },
      'request-full-analysis',
    ).job.id,
  );
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const r = app.getResult(job.result_id);
  assert.equal(r.personalization.data.connections.length, 1);
  assert.deepEqual(r.feedback_dimensions, ['accuracy']);
  assert.deepEqual(r.feedback, {});
  app.feedback(r.id, 'accuracy', { value: 'positive' });
  for (const dimension of ['summary', 'reason', 'connections'])
    assert.throws(() => app.feedback(r.id, dimension, { value: 'negative' }), {code:'invalid_request'});
  assert.equal(app.recommendationEvaluations().dataset().length, 1);
  assert.deepEqual(Object.keys(app.getResult(r.id).feedback), ['accuracy']);
  assert.throws(() => app.evidence(r.id, 'persona:outside'), /没有/);
  assert.ok(app.evidence(r.id, 'persona:material-1:r2').text);
  const archived = JSON.stringify({ id: 'archived-discussion', paper: r.paper, analysis_id: r.id });
  db.db.prepare('INSERT INTO discussions VALUES (?,?,?,?,?,?,?)').run('archived-discussion', 'archived-source', 'archived-topic', null, r.id, new Date().toISOString(), archived);
  db.deleteResult(r.id);
  const kept = db.db.prepare('SELECT analysis_id,data FROM discussions WHERE id=?').get('archived-discussion');
  assert.equal(kept.analysis_id, null);
  assert.equal(kept.data, archived);
  assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.result(r.id), null);
  assert.deepEqual(db.feedback(r.id), {});
  assert.equal(db.job(job.id), null);
});
void test('repeated bad citations stop within budget and expose review state', async (t) => {
  const invalid = structuredClone(summary);
  invalid.sections[0].evidence_ids = ['paper:invented'];
  const { app } = await fixture(t, {
    engine: engine(() => JSON.stringify(invalid)),
  });
  const job = await terminal(
    app,
    app.create(input, 'request-bad-citations').job.id,
  );
  assert.equal(job.status, 'failed');
  const r = app.getResult(job.result_id);
  assert.equal(r.summary.status, 'needs_review');
  assert.equal(r.attempts.length, 1);
  assert.deepEqual(r.feedback_dimensions, []);
});
void test('cancellation propagates to model and late output cannot publish a successful job', async (t) => {
  let started = false;
  const { app, db } = await fixture(t, {
    engine: engine(async () => {
      started = true;
      await delay(60);
      return JSON.stringify(summary);
    }),
  });
  const id = app.create(input, 'request-cancel-late').job.id;
  await until(() => started);
  assert.equal(app.cancel(id).status, 'cancelled');
  await app.work;
  assert.equal(app.getJob(id).status, 'cancelled');
  const j = db.job(id);
  assert.notEqual(db.result(j.result_id)?.summary.status, 'available');
  assert.equal(db.attempts(id).length, 1);
});
void test('HTTP business endpoints enforce origin, idempotency, evidence ownership and feedback availability', async (t) => {
  const { app, models } = await fixture(t);
  const server = createModelServer(models, {
    publicDirectory: '.',
    analyses: app,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Paper-Radar': '1',
    'Idempotency-Key': 'http-single-request',
  };
  const prompts = await fetch(base + '/api/prompts/v1');
  assert.equal(prompts.status, 200);
  const promptCatalog = (await prompts.json()).prompts;
  assert.ok(promptCatalog.some((p) => p.id === 'paper-radar.task-single'));
  assert.ok(promptCatalog.some((p) => p.id === 'paper-radar.screen-agent'));
  assert.equal(
    (
      await fetch(base + '/api/prompts/v1', {
        headers: { Origin: 'https://evil.test' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + '/api/prompts/v1/activate', {
        method: 'POST',
        body: '{}',
      })
    ).status,
    403,
  );
  const preview = await fetch(base + '/api/prompts/v1/preview', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt_id: 'paper-radar.extract',
      variables: { blocks: [{ id: 'example', text: 'Synthetic evidence' }] },
    }),
  });
  assert.equal(preview.status, 200);
  assert.match((await preview.json()).rendered.user, /Synthetic evidence/);

  assert.equal(
    (
      await fetch(base + '/api/analyses', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.test' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  const create = await fetch(base + '/api/analyses', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });
  assert.equal(create.status, 202);
  const { job } = await create.json();
  const done = await terminal(app, job.id);
  assert.equal(
    (
      await fetch(
        base + '/api/analyses/' + done.result_id + '/evidence/unknown',
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(
        base + '/api/analyses/' + done.result_id + '/feedback/accuracy',
        { method: 'PUT', headers, body: '{"value":"positive"}' },
      )
    ).status,
    400,
  );
  assert.equal((await fetch(base + '/api/jobs?limit=-1')).status, 400);
  assert.equal(
    (await fetch(base + '/api/capabilities').then((r) => r.json()))
      .single_analysis,
    true,
  );
});
void test('SQLite migration recovers interrupted jobs and restricts file permissions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-radar-recover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await new AnalysisDatabase(dir).open();
  const j = {
    id: 'job-interrupted',
    status: 'running',
    created_at: new Date().toISOString(),
    stages: [],
    input,
  };
  first.insertJob(j, 'restart-request', 'hash');
  await first.close();
  const next = await new AnalysisDatabase(dir).open();
  try {
    assert.equal(next.job(j.id).status, 'interrupted');
    assert.equal((await stat(join(dir, 'radar.sqlite'))).mode & 0o777, 0o600);
    assert.match(
      next.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT data FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1",
        )
        .get().detail,
      /USING INDEX/,
    );
  } finally {
    await next.close();
  }
});
void test('force regenerate skips valid cache while retaining the paper recommendation answer', async (t) => {
  const { app } = await fixture(t);
  const personalInput = {...input, persona_connection_id:'persona-test', scope:persona.scope};
  const first = await terminal(
    app,
    app.create(personalInput, 'request-force-original').job.id,
  );
  app.feedback(first.result_id, 'accuracy', { value: 'positive' });
  const regenerated = await terminal(
    app,
    app.create({ ...personalInput, force_regenerate: true }, 'request-force-new').job
      .id,
  );
  const output = app.getResult(regenerated.result_id);
  assert.equal(output.summary.cache_hit, false);
  assert.equal(output.attempts.length, 1);
  assert.equal(output.feedback.accuracy.value, 'positive');
  assert.equal(app.recommendationEvaluations().dataset().length, 1);
  assert.equal(
    app.getResult(first.result_id).feedback.accuracy.value,
    'positive',
  );
});

void test('a cancelled result has no indefinitely pending components and the connection stays healthy', async (t) => {
  let started = false;
  const { app, models } = await fixture(t, {
    engine: engine(async () => {
      started = true;
      await delay(30);
      return JSON.stringify(summary);
    }),
  });
  const id = app.create(input, 'request-cancel-status').job.id;
  await until(() => started);
  const cancelled = app.cancel(id);
  await app.work;
  assert.equal(
    app.getResult(cancelled.result_id).summary.error.code,
    'cancelled',
  );
  assert.ok(
    app
      .getJob(id)
      .stages.every((s) => !['running', 'pending'].includes(s.status)),
  );
  assert.notEqual(
    models.store.state.settings.connections[0].status,
    'cancelled',
  );
});

void test('recovery closes unfinished result components without losing completed content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paper-radar-recovery-result-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await new AnalysisDatabase(dir).open();
  const job = {
    id: 'job-recovery',
    status: 'running',
    created_at: new Date().toISOString(),
    result_id: 'result-recovery',
    stages: [{ id: 'personalization', status: 'running' }],
    input,
  };
  first.insertJob(job, 'request-recovery-result', 'hash');
  first.saveResult({
    id: job.result_id,
    job_id: job.id,
    created_at: job.created_at,
    summary: { status: 'available', data: summary },
    personalization: { status: 'pending' },
  });
  await first.close();
  const reopened = await new AnalysisDatabase(dir).open();
  try {
    assert.equal(reopened.job(job.id).stages[0].status, 'interrupted');
    assert.equal(reopened.result(job.result_id).summary.status, 'available');
    assert.equal(
      reopened.result(job.result_id).personalization.error.code,
      'interrupted',
    );
  } finally {
    await reopened.close();
  }
});

void test('changing the selected Persona scope cannot reuse another personal analysis', async (t) => {
  const { app } = await fixture(t, {
    persona: {
      snapshot: async (p, i) => ({
        ...structuredClone(persona),
        scope: i.scope,
      }),
      close: async () => {},
    },
  });
  const first = await terminal(
    app,
    app.create(
      { ...input, persona_connection_id: 'persona-test', scope: persona.scope },
      'request-scope-first',
    ).job.id,
  );
  const second = await terminal(
    app,
    app.create(
      {
        ...input,
        persona_connection_id: 'persona-test',
        scope: { tag_ids: ['different-scope'], tag_match: 'any' },
      },
      'request-scope-second',
    ).job.id,
  );
  assert.equal(
    app.getResult(first.result_id).personalization.status,
    'available',
  );
  const output = app.getResult(second.result_id);
  assert.equal(output.summary.cache_hit, false);
  assert.equal(output.personalization.cache_hit, false);
  assert.equal(output.attempts.length, 1);
});

void test('prompt changes affect new jobs and cache identity, never a job already started', async (t) => {
  const calls = [];
  const { app } = await fixture(t, {
    engine: engine((c, r) => {
      calls.push(r);
    }),
  });
  const old = app.prompts.version('paper-radar.task-single.zh');
  const first = app.create(input, 'prompt-old').job;
  const version = app.prompts.saveVersion('paper-radar.task-single.zh', {
    ...old.templates,
    system: 'CUSTOM TEST ' + old.templates.system,
  });
  app.prompts.activate([
    {
      prompt_id: version.prompt_id,
      version: version.id,
      expected_active: old.id,
    },
  ]);
  await terminal(app, first.id);
  assert.ok(calls.length);
  assert.ok(!calls.some((c) => c.systemPrompt.includes('CUSTOM TEST')));
  const second = app.create(input, 'prompt-new').job;
  await terminal(app, second.id);
  assert.ok(calls.some((c) => c.systemPrompt.includes('CUSTOM TEST')));
  assert.notEqual(
    app.getJob(first.id).prompt_fingerprint,
    app.getJob(second.id).prompt_fingerprint,
  );
  assert.equal('prompt_snapshot' in app.getJob(second.id), false);
  const capture = app.prompts.records('captures', 'paper-radar.task-single')[0];
  assert.equal(
    capture.snapshot.versions['paper-radar.task-single.zh'].id,
    version.id,
  );
});
