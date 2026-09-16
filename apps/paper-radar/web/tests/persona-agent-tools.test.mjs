import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  PERSONA_QUERY_TOOLS,
  personaArguments,
} from '@paper-radar/host-contract/persona-tools';
import { toolContent } from '@paper-radar/host-contract/tool-content';
import {
  PersonaAgentTools,
  emptyQueryContext,
} from '../server/persona/agent-tools.mjs';
import { PersonaClient } from '../server/persona/service.mjs';
import { ResearchTools } from '../server/agents/research-tools.mjs';
import { ScreeningEvidence } from '../server/daily/agent-screening.mjs';
import { fixture } from './helpers/daily-fixture.mjs';

const scope = { tag_ids: ['tag-physics'], tag_match: 'any' };
const node = (id, interest_level = 'high') => ({
  id,
  entity_type: 'knowledge_node',
  title: id,
  interest_level,
  knowledge_level: 'aware',
  tags: scope.tag_ids,
  record_revision: 2,
  provenance: { kind: 'record', record_id: id, record_revision: 2 },
});
const nodes = [node('tensor'), node('quantum', 'low')];
const source = {
  kind: 'source',
  source_id: 'source-a',
  file_id: 'file-a',
  file_hash: 'sha256:original',
  locator: { lines: { start: 1, end: 2 } },
};
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFf8AAAAASUVORK5CYII=';
function setup(change = (v) => v) {
  const calls = [];
  const range = {
    scope,
    revision: 7,
    tags: [],
    scoped: async (name, args) => {
      calls.push({ name, args });
      let data = {};
      if (name === 'search_knowledge') {
        const selected = nodes.filter(
          (n) =>
            !args.interest_levels ||
            args.interest_levels.includes(n.interest_level),
        );
        data = {
          hits: selected.map((n) => ({ id: n.id })),
          nodes: selected,
          edges: [],
          excerpts: [],
        };
      } else if (name === 'get_knowledge_map')
        data = { nodes, edges: [], domains: [], frontier: [] };
      else if (name === 'get_persona_records')
        data = {
          items: args.record_ids.map((id) => {
            const n = nodes.find((n) => n.id === id);
            return {
              id,
              entity_type: n.entity_type,
              record_revision: n.record_revision,
              provenance: n.provenance,
              record: Object.fromEntries(
                Object.entries(n).filter(
                  ([k]) => !args.fields || args.fields.includes(k),
                ),
              ),
              completeness: 'complete',
            };
          }),
        };
      else if (name === 'list_source_files')
        data = {
          source_id: 'source-a',
          entries: [
            { kind: 'file', file_id: 'file-a', file_hash: source.file_hash },
          ],
        };
      else if (name === 'search_source_content')
        data = {
          matches: [
            {
              file_ref: { source_id: 'source-a', file_id: 'file-a' },
              text: 'Source passage',
              provenance: source,
              passage_ref: 'passage-a',
            },
          ],
          index_coverage: [],
        };
      else if (name === 'read_source')
        data = {
          file_ref: { source_id: 'source-a', file_id: 'file-a' },
          text: 'Original source text',
          provenance: source,
          next_selector: null,
          ...(args.view === 'image'
            ? { images: [{ page: 1, provenance: source }] }
            : {}),
        };
      return change(
        structuredClone({
          schema_version: 'ai-persona.query-result/v2',
          tool: name,
          ok: true,
          scope,
          persona_revision: 7,
          data,
          coverage: { total_count: data.hits?.length ?? 1, truncated: false },
          warnings: [],
          next_cursor: null,
          ...(args.view === 'image'
            ? {
                _image_content: [
                  { type: 'image', mimeType: 'image/png', data: pixel },
                ],
              }
            : {}),
        }),
        name,
        args,
      );
    },
  };
  const context = emptyQueryContext(range, 'connection');
  return {
    calls,
    range,
    context,
    tools: new PersonaAgentTools({ context, getRange: async () => range }),
  };
}

void test('full query parameters reach Persona; interest filtering and field projections preserve actual facts only', async () => {
  const f = setup();
  const args = {
    query: '',
    interest_levels: ['high'],
    knowledge_levels: ['aware'],
    entity_types: ['knowledge_node'],
    focus_ids: ['tensor'],
    focus_mode: 'only',
    max_hops: 2,
    relation_types: ['related_to'],
    direction: 'both',
    limit: 23,
    max_chars: 32000,
  };
  const result = await f.tools.call('search_knowledge', args);
  assert.deepEqual(f.calls[0].args, args);
  assert.deepEqual(
    result.data.hits.map((n) => n.id),
    ['tensor'],
  );
  assert.equal(result.data.nodes[0].citation_ref, 'persona:tensor:r2');
  assert.equal(f.context.coverage.complete_knowledge_scan, false);
  const isolated = setup();
  const records = await isolated.tools.call('get_persona_records', {
    record_ids: ['tensor', 'quantum'],
    fields: ['title'],
  });
  assert.equal(records.data.items.length, 2);
  assert.deepEqual(
    isolated.tools.delivered.get('persona:tensor:r2').fact_fields,
    {},
  );
  assert.equal(isolated.context.records[0].interest_level, undefined);
  await isolated.tools.call('get_persona_records', {
    record_ids: ['tensor'],
    fields: ['interest_level'],
  });
  assert.equal(
    isolated.tools.delivered.get('persona:tensor:r2').fact_fields
      .interest_level,
    'high',
  );
  assert.equal(isolated.context.records[0].title, 'tensor');
});

void test('query schema blocks preferences, mutations, range overrides and excessive budgets before access', async () => {
  const f = setup();
  assert.equal(PERSONA_QUERY_TOOLS.length, 6);
  for (const [name, args] of [
    ['search_preferences', {}],
    ['get_preference_records', { record_ids: ['p'] }],
    ['prepare_preference_context', {}],
    ['resolve_persona_activation', {}],
    ['propose_change_set', {}],
    ['search_knowledge', { scope: { tag_ids: ['outside'] } }],
    ['search_knowledge', { expected_persona_revision: 8 }],
    ['search_knowledge', { interest_levels: ['favorite'] }],
    ['search_knowledge', { max_chars: 60001 }],
    ['read_source', { source_id: 'source-a' }],
    ['read_source', { evidence_id: 'e', passage_ref: 'p' }],
    ['search_source_content', { query: 'x', files: [], source_ids: ['s'] }],
  ])
    await assert.rejects(f.tools.call(name, args), {
      code: 'invalid_arguments',
    });
  assert.equal(f.calls.length, 0);
});

void test('failed scope, revision and source checks do not turn rejected output into delivered evidence', async () => {
  for (const [change, code] of [
    [
      (v) => ({ ...v, scope: { ...scope, tag_ids: ['outside'] } }),
      'out_of_scope',
    ],
    [(v) => ({ ...v, persona_revision: 8 }), 'version_changed'],
    [
      (v) => ({
        ...v,
        data: {
          ...v.data,
          nodes: [...v.data.nodes, { ...nodes[1], tags: ['outside'] }],
        },
      }),
      'out_of_scope',
    ],
  ]) {
    const f = setup(change);
    await assert.rejects(f.tools.call('get_knowledge_map'), { code });
    assert.equal(f.context.evidence.length, 0);
    assert.equal(f.context.records.length, 0);
  }
  const f = setup((v, name) => {
    if (name === 'read_source') v.data.provenance.file_hash = 'sha256:changed';
    return v;
  });
  await f.tools.call('list_source_files', { source_id: 'source-a' });
  const previous = f.context.evidence.length;
  await assert.rejects(
    f.tools.call('read_source', { source_id: 'source-a', file_id: 'file-a' }),
    { code: 'source_changed' },
  );
  assert.equal(f.context.evidence.length, previous);
});

void test('files and evidence can be read directly; multi-source search and image blocks retain provenance', async () => {
  const f = setup();
  const result = await f.tools.call('read_source', {
    source_id: 'source-a',
    file_id: 'file-a',
    view: 'image',
    selector: { pages: [1] },
    max_images: 4,
  });
  assert.equal(f.calls.length, 1);
  assert.ok(f.tools.delivered.has(result.data.citation_ref));
  const content = toolContent(result);
  assert.equal(content[1].data, pixel);
  assert.equal(content[1].type, 'image');
  assert.ok(!content[0].text.includes(pixel));
  await f.tools.call('read_source', {
    evidence_id: 'evidence-a',
    view: 'text',
    selector: { lines: { start: 1, end: 2 } },
  });
  await f.tools.call('search_source_content', {
    query: 'tensor',
    source_ids: ['source-a', 'source-b'],
    context_chars: 3000,
    limit: 40,
  });
  assert.deepEqual(f.calls.at(-1).args.source_ids, ['source-a', 'source-b']);
});

void test('screening uses the same six tools, keeps each paper isolated, and replays queries without live access', async () => {
  const f = setup();
  const run = {
    context: f.context,
    subscription: {
      scope,
      persona_connection_id: 'connection',
      language: 'en',
    },
  };
  const item = {
    id: 'item',
    paper: {
      id: '2501.00001',
      version: 1,
      title: 'Paper',
      abstract: 'Abstract',
      evidence_id: 'paper:abstract',
      authors: [],
      categories: [],
    },
  };
  const reader = new ScreeningEvidence(
    { persona: { scopeReader: async () => f.range } },
    run,
    item,
    new AbortController().signal,
  );
  reader.saveProgress = () => {};
  const task = reader.initial();
  assert.equal(task.persona.records.length, 0);
  assert.deepEqual(
    reader
      .toolset()
      .filter((t) => PERSONA_QUERY_TOOLS.some((p) => p.name === t.name)),
    PERSONA_QUERY_TOOLS,
  );
  const found = await reader.call('search_knowledge', {
    interest_levels: ['high'],
  });
  assert.equal(run.context.records.length, 0);
  const answer = {
    schema: task.output.schema,
    paper_version: task.paper.version,
    decision: 'recommended',
    introduction: 'Paper introduction',
    reason: 'Relevant to the marked interest',
    criterion_ids: ['selected-knowledge'],
    paper_evidence_ids: [task.paper.source_ref],
    persona_evidence_ids: [found.data.hits[0].citation_ref],
    persona_coverage_ref: task.persona.source_ref,
    claims: [{ record_id: 'tensor', field: 'interest_level', value: 'high' }],
    open_questions: [],
  };
  assert.equal(reader.validate(answer).outcome, 'recommended');
  assert.throws(
    () =>
      reader.validate({
        ...answer,
        claims: [
          { record_id: 'quantum', field: 'interest_level', value: 'high' },
        ],
      }),
    { code: 'invalid_claim' },
  );
  let unavailable = false;
  const replay = new ScreeningEvidence(
    null,
    run,
    item,
    new AbortController().signal,
    {
      replay: true,
      frozenQueries: reader.queries.transcript,
      onUnavailable: () => {
        unavailable = true;
      },
    },
  );
  replay.initial();
  assert.deepEqual(
    await replay.call('search_knowledge', { interest_levels: ['high'] }),
    found,
  );
  assert.equal(replay.validate(answer).outcome, 'recommended');
  await assert.rejects(
    replay.call('search_knowledge', { interest_levels: ['low'] }),
    { code: 'input_unavailable' },
  );
  assert.equal(unavailable, true);
});

void test('production daily preparation is on demand and saved input contains the actual query transcript', async (t) => {
  const f = await fixture(t, { count: 1 });
  const q = setup();
  // Use the subscription's actual scope in the isolated query fixture.
  const taskScope = f.sub.scope;
  const range = {
    ...q.range,
    scope: taskScope,
    scoped: async (name, args) => {
      const value = await q.range.scoped(name, args);
      value.scope = taskScope;
      for (const n of value.data.nodes ?? []) n.tags = taskScope.tag_ids;
      return value;
    },
  };
  f.daily.persona.queryContext = async () =>
    emptyQueryContext(range, f.sub.persona_connection_id);
  f.daily.persona.scopeReader = async () => range;
  f.daily.persona.screeningSnapshot = () => {
    throw new Error('No full scan');
  };
  f.models.mode = 'dsh';
  f.models.runAgent = async (request, options) => {
    const task = JSON.parse(request.prompt);
    assert.equal(task.persona.records.length, 0);
    assert.ok(request.tools.some((t) => t.name === 'get_knowledge_map'));
    const attempt = { id: randomUUID(), started_at: new Date().toISOString() };
    options.beforeAttempt(
      f.models.store.state.settings.connections[0],
      attempt,
    );
    options.onAttempt({
      ...attempt,
      status: 'succeeded',
      usage: { input: 1, output: 1 },
    });
    const found = await options.onTool('search_knowledge', {
      interest_levels: ['high'],
    });
    const data = {
      schema: task.output.schema,
      paper_version: task.paper.version,
      decision: 'recommended',
      introduction: 'Introduction',
      reason: 'Explicit interest',
      criterion_ids: ['selected-knowledge'],
      paper_evidence_ids: [task.paper.source_ref],
      persona_evidence_ids: [found.data.hits[0].citation_ref],
      persona_coverage_ref: task.persona.source_ref,
      claims: [],
      open_questions: [],
    };
    await options.onTool('screening_submit_result', data);
    return {
      data,
      providerId: 'fixture',
      modelId: 'fixture',
      requestId: randomUUID(),
    };
  };
  const run = await f.finish(f.create('query-daily').run.id);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const item = f.repo.items(run.id)[0];
  const version = f.repo.get('daily_item_versions', item.screening_version_id);
  const saved = JSON.parse(
    f.db.db
      .prepare('SELECT data FROM screening_inputs WHERE id=?')
      .get(version.input_snapshot_id).data,
  );
  assert.equal(saved.context.records.length, 0);
  assert.equal(saved.persona_queries[0].name, 'search_knowledge');
  assert.ok(version.evidence.some((e) => e.id === 'persona:tensor:r2'));
});

void test(
  'real AI Persona query tools support filters, graph, projections and direct source reads on isolated demo data',
  { timeout: 60000 },
  async (t) => {
    const project = fileURLToPath(
      new URL('../../../ai-persona', import.meta.url),
    );
    const directory = await mkdtemp(join(tmpdir(), 'radar-query-tools-'));
    const config = join(directory, 'connection.json');
    await writeFile(
      config,
      JSON.stringify({
        command:
          process.env.AI_PERSONA_TEST_PYTHON ||
          join(project, '.venv/bin/python'),
        args: [
          fileURLToPath(new URL('./helpers/persona-mcp.py', import.meta.url)),
          project,
          directory,
        ],
      }),
    );
    const client = new PersonaClient(config);
    t.after(async () => {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    });
    const tags = await client.tags();
    const input = {
      persona_connection_id: tags.connection_id,
      scope: { tag_ids: ['tag_physics'], tag_match: 'any' },
    };
    const context = await client.queryContext(input);
    assert.equal(context.records.length, 0);
    const range = await client.scopeReader(input, undefined, context.revision);
    const tools = new PersonaAgentTools({
      context,
      getRange: async () => range,
    });
    const map = await tools.call('get_knowledge_map', { max_hops: 2 });
    assert.ok(map.data.edges.length);
    const search = await tools.call('search_knowledge', {
      interest_levels: ['high'],
      entity_types: ['knowledge_node'],
      limit: 50,
      max_chars: 60000,
    });
    assert.ok(search.data.hits.length);
    const ids = search.data.hits.map((h) => h.id).slice(0, 2);
    const records = await tools.call('get_persona_records', {
      record_ids: ids,
      fields: ['title', 'interest_level'],
      include_evidence: true,
    });
    assert.ok(
      records.data.items.every(
        (i) => i.record.interest_level === 'high' && i.citation_ref,
      ),
    );
    const materials = await tools.call('search_knowledge', {
      entity_types: ['material'],
      limit: 50,
      max_chars: 60000,
    });
    const material = materials.data.nodes.find(
      (n) => n.entity_type === 'material' && n.source_ref,
    );
    assert.ok(material);
    const files = await tools.call('list_source_files', {
      source_id: material.source_ref,
      recursive: true,
      limit: 100,
    });
    const file = files.data.entries.find(
      (f) => f.kind === 'file' && f.available_views.includes('text'),
    );
    assert.ok(file);
    const read = await tools.call('read_source', {
      source_id: material.source_ref,
      file_id: file.file_id,
      view: 'text',
      max_chars: 4000,
    });
    assert.ok(read.data.text.length && read.data.citation_ref);
    const passages = await tools.call('search_source_content', {
      source_ids: [material.source_ref],
      query: 'TEBD',
      context_chars: 1000,
    });
    assert.ok(Array.isArray(passages.data.matches));
    const research = new ResearchTools({
      analyses: { persona: client },
      input,
      persona: context,
      paper: {
        id: '2501.00001',
        version: 1,
        abstract: 'x',
        title: 'p',
        references: [],
      },
      signal: new AbortController().signal,
    });
    assert.deepEqual(
      research
        .toolset()
        .filter((t) => PERSONA_QUERY_TOOLS.some((p) => p.name === t.name)),
      PERSONA_QUERY_TOOLS,
    );
    const delivered = await research.call('get_persona_records', {
      record_ids: ids,
    });
    assert.ok(
      research
        .evidence()
        .some((e) => e.id === delivered.data.items[0].citation_ref),
    );
    assert.throws(() =>
      personaArguments('read_source', {
        source_id: material.source_ref,
        file_id: file.file_id,
        selector: { lines: { start: 3, end: 1 } },
      }),
    );
  },
);
