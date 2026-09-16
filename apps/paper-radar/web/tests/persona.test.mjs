import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PersonaClient,
  PERSONA_CONTEXT_VERSION,
  personaPromptContext,
} from '../server/persona/service.mjs';
import { QUERY_TOOLS, QUERY_VERSION } from '../server/persona/query-client.mjs';

const scope = { tag_ids: ['tag-a', 'tag-b'], tag_match: 'any' };
const node = (id, type = 'knowledge_node') => ({
  id,
  entity_type: type,
  title: id,
  record_revision: 2,
  tags: [id === 'knowledge-b' ? 'tag-b' : 'tag-a'],
  knowledge_level: 'unspecified',
  interest_level: 'high',
  scope_note: '仅限一维动力学',
  provenance: { kind: 'record', record_id: id, record_revision: 2 },
  ...(type === 'material' ? { source_ref: 'source-a' } : {}),
});
const knowledge = node('knowledge-a'),
  other = node('knowledge-b'),
  material = node('material-a', 'material');
const edge = {
  id: 'relation-a',
  source_id: material.id,
  target_id: knowledge.id,
  relation_type: 'covers',
  record_revision: 1,
  provenance: { kind: 'record', record_id: 'relation-a', record_revision: 1 },
};
const paper = {
  title: 'Dynamics',
  abstract: 'Tensor dynamics',
  references: [],
};
const envelope = (tool, args, data, extra = {}) => ({
  schema_version: QUERY_VERSION,
  tool,
  ok: true,
  request_id: 'test',
  persona_revision: 7,
  scope: args.scope ?? null,
  data,
  coverage: {
    total_count: 1,
    returned_count: 1,
    offset: 0,
    status: 'complete',
    truncated: false,
  },
  warnings: [],
  next_cursor: null,
  error: null,
  ...extra,
});
function response(name, args) {
  if (name === 'get_knowledge_map')
    return envelope(name, args, {
      domains: scope.tag_ids.map((id) => ({ id, label: id, aliases: [] })),
      nodes: [knowledge, material],
      edges: [edge],
      frontier: [],
    });
  if (name === 'search_knowledge') {
    if (args.query)
      return envelope(name, args, {
        hits: [{ id: material.id }],
        nodes: [knowledge, material],
        edges: [edge],
        excerpts: [],
        retrieval: { semantic: { status: 'disabled' } },
      });
    const current = args.cursor ? other : knowledge;
    return envelope(
      name,
      args,
      {
        hits: [{ id: current.id }],
        nodes: [current, material],
        edges: [],
        excerpts: [],
      },
      {
        next_cursor: args.cursor ? null : 'second',
        coverage: {
          total_count: 2,
          returned_count: 1,
          offset: args.cursor ? 1 : 0,
          truncated: !args.cursor,
          status: args.cursor ? 'complete' : 'partial',
        },
      },
    );
  }
  if (name === 'get_persona_records')
    return envelope(name, args, {
      items: args.record_ids.map((id) => {
        const record = [knowledge, other, material].find((r) => r.id === id);
        return {
          id,
          entity_type: record.entity_type,
          record,
          body: '保留我的个人备注',
          record_revision: 2,
          provenance: record.provenance,
          completeness: 'complete',
          omitted_fields: [],
          evidence: [],
        };
      }),
    });
  if (name === 'list_source_files')
    return envelope(name, args, {
      source_id: 'source-a',
      source_hash: 'sha256:source',
      entries: [
        {
          kind: 'file',
          file_id: 'file-a',
          relative_path: 'notes/original.md',
          file_hash: 'sha256:file',
          parse_status: 'ready',
          available_views: ['text'],
          role: 'original',
        },
      ],
    });
  if (name === 'search_source_content')
    return envelope(name, args, {
      matches: [
        {
          file_ref: { source_id: 'source-a', file_id: 'file-a' },
          passage_ref: 'opaque-passage',
        },
      ],
      index_coverage: [],
      semantic: { status: 'disabled' },
    });
  if (name === 'read_source')
    return envelope(name, args, {
      file_ref: { source_id: 'source-a', file_id: 'file-a' },
      text: 'Verified source 😀',
      provenance: {
        kind: 'source',
        source_id: 'source-a',
        file_id: 'file-a',
        file_hash: 'sha256:file',
        locator: { lines: { start: 2, end: 4 }, offset: 0, length: 17 },
      },
      truncated: false,
    });
  throw new Error(name);
}
async function fixture(
  t,
  change = (value) => value,
  availableTools = QUERY_TOOLS,
) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-persona-'));
  const config = join(directory, 'persona.json');
  await writeFile(config, JSON.stringify({ command: 'fixture', args: [] }));
  const calls = [];
  const client = new PersonaClient(config, {
    clientFactory: async () => ({
      listTools: async () => ({
        tools: availableTools.map((name) => ({
          name,
          inputSchema: {
            properties: { scope: {}, expected_persona_revision: {} },
          },
        })),
      }),
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        return {
          structuredContent: change(response(name, args), name, args, calls),
        };
      },
      async close() {},
    }),
  });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect();
  return {
    client,
    calls,
    input: { persona_connection_id: client.identity, scope },
  };
}

void test('tag union enumerates every knowledge point, excluding material context hits, without paper keywords', async (t) => {
  const { client, calls, input } = await fixture(t);
  const saved = await client.screeningSnapshot(input);
  assert.equal(saved.schema_version, PERSONA_CONTEXT_VERSION);
  assert.deepEqual(saved.knowledge_ids, [knowledge.id, other.id]);
  assert.equal(saved.coverage.total_knowledge, 2);
  assert.equal(saved.coverage.complete_knowledge_scan, true);
  assert.ok(saved.records.every((r) => r.entity_type === 'knowledge_node'));
  assert.equal(saved.records[0].scope_note, knowledge.scope_note);
  assert.equal(saved.records[0].knowledge_level, 'unspecified');
  assert.equal(saved.records[0].body, '保留我的个人备注');
  assert.ok(
    calls.every((c) => JSON.stringify(c.args.scope) === JSON.stringify(scope)),
  );
  assert.ok(
    calls
      .filter((c) => c.name !== 'get_knowledge_map')
      .every((c) => c.args.expected_persona_revision === 7),
  );
  assert.ok(
    calls
      .filter((c) => c.name === 'search_knowledge')
      .every((c) => c.args.query === ''),
  );
  assert.ok(!calls.some((c) => c.name.includes('source')));
  assert.deepEqual(
    personaPromptContext(saved).recommendation_knowledge_ids,
    saved.knowledge_ids,
  );
});

void test('full analysis uses graph and source references with saved file hash and location', async (t) => {
  const { client, input, calls } = await fixture(t);
  const saved = await client.snapshot(paper, input);
  assert.deepEqual(saved.knowledge_ids, [knowledge.id, other.id]);
  assert.ok(saved.records.some((r) => r.entity_type === 'material'));
  assert.deepEqual(saved.relations, [edge]);
  const excerpt = saved.evidence.find((e) => e.kind === 'excerpt');
  assert.equal(excerpt.text, 'Verified source 😀');
  assert.equal(excerpt.file_hash, 'sha256:file');
  assert.deepEqual(excerpt.lines, [2, 4]);
  assert.ok(
    calls.some((c) => c.name === 'get_knowledge_map' && c.args.focus_ids),
  );
  assert.ok(
    calls.some(
      (c) =>
        c.name === 'read_source' &&
        c.args.passage_ref === 'opaque-passage' &&
        !c.args.path,
    ),
  );
});

void test('partially expanded graph preserves the full knowledge basis and reports unread endpoints', async (t) => {
  const { client, input } = await fixture(t, (value, name, args) => {
    if (name === 'get_knowledge_map' && args.focus_ids) {
      value.data.edges.push({
        ...edge,
        id: 'unread-relation',
        target_id: 'unread-material',
        provenance: {
          kind: 'record',
          record_id: 'unread-relation',
          record_revision: 1,
        },
      });
      value.data.frontier = [
        { id: 'unread-material', title: 'Unread material' },
      ];
      value.coverage.truncated = true;
      value.next_cursor = 'graph-page';
    }
    return value;
  });
  const saved = await client.snapshot(paper, input);
  assert.deepEqual(saved.knowledge_ids, [knowledge.id, other.id]);
  assert.deepEqual(saved.relations, [edge]);
  assert.ok(
    saved.coverage.issues.some((issue) => issue.includes('另一端尚未读取')),
  );
});

void test('record continuation reconstructs Unicode notes with Python code-point offsets', async (t) => {
  const text = '😀甲😀乙';
  const { client, input } = await fixture(t, (value, name, args) => {
    if (name !== 'get_persona_records') return value;
    if (!args.cursor) {
      value.data.items[0] = {
        ...value.data.items[0],
        body: null,
        completeness: 'partial',
        continued_fields: ['body'],
      };
      value.data.items.push({
        id: knowledge.id,
        record_revision: 2,
        provenance: knowledge.provenance,
        field: 'body',
        value: '😀甲',
        offset: 0,
        total_chars: 4,
      });
      value.next_cursor = 'notes';
      value.coverage.truncated = true;
    } else
      value.data.items = [
        {
          id: knowledge.id,
          record_revision: 2,
          provenance: knowledge.provenance,
          field: 'body',
          value: '😀乙',
          offset: 2,
          total_chars: 4,
        },
      ];
    return value;
  });
  assert.equal((await client.screeningSnapshot(input)).records[0].body, text);
});

for (const scenario of [
  'out_of_scope',
  'missing_record',
  'incomplete_page',
  'legacy_envelope',
  'missing_provenance',
]) {
  void test(`rejects ${scenario} before recommendation`, async (t) => {
    const { client, input } = await fixture(t, (value, name) => {
      if (scenario === 'legacy_envelope') return { result: value };
      if (scenario === 'out_of_scope')
        value.scope = { tag_ids: ['outside'], tag_match: 'any' };
      if (name === 'get_persona_records' && scenario === 'missing_record')
        value.data.items = [];
      if (name === 'get_persona_records' && scenario === 'missing_provenance')
        value.data.items[0].provenance = null;
      if (name === 'search_knowledge' && scenario === 'incomplete_page')
        value.next_cursor = null;
      return value;
    });
    await assert.rejects(client.screeningSnapshot(input));
  });
}

void test('changed revision restarts a complete snapshot; saved discussions keep their original evidence', async (t) => {
  let changed = false;
  const { client, input, calls } = await fixture(t, (value, name) => {
    if (name === 'get_persona_records' && !changed) {
      changed = true;
      value.persona_revision = 8;
    }
    return value;
  });
  const saved = await client.screeningSnapshot(input);
  assert.equal(calls.filter((c) => c.name === 'get_knowledge_map').length, 2);
  const original = structuredClone(saved);
  const supplement = await client.supplement(
    paper,
    input,
    { ...saved, revision: 6 },
    'New question',
  );
  assert.match(supplement.limitation, /Persona 已更新/);
  assert.deepEqual(saved, original);
  assert.equal(supplement.context.revision, 6);
});

void test('source hash mismatch is rejected after one fresh retry', async (t) => {
  const { client, input, calls } = await fixture(t, (value, name) => {
    if (name === 'read_source')
      value.data.provenance.file_hash = 'sha256:changed';
    return value;
  });
  await assert.rejects(client.snapshot(paper, input), {
    code: 'source_changed',
  });
  assert.equal(calls.filter((c) => c.name === 'read_source').length, 2);
});

void test('a server exposing only legacy capabilities is rejected at connection', async (t) => {
  await assert.rejects(
    fixture(t, undefined, [
      'list_tags',
      'prepare_persona_context',
      'search_knowledge',
      'get_persona_record',
      'get_material_source',
    ]),
    { code: 'persona_version' },
  );
});

void test('source text continues with the returned selector and preserves both locations', async (t) => {
  const { client, input, calls } = await fixture(t, (value, name, args) => {
    if (name !== 'read_source') return value;
    const offset = args.selector?.offset ?? 0;
    value.data.text = offset ? 'second part' : 'first 😀 part';
    value.data.provenance.locator = {
      lines: { start: 2, end: 4 },
      offset,
      length: Array.from(value.data.text).length,
    };
    value.data.truncated = !offset;
    value.data.next_selector = offset
      ? null
      : { lines: { start: 2, end: 4 }, offset: 12, length: 11 };
    return value;
  });
  const saved = await client.snapshot(paper, input);
  assert.deepEqual(
    saved.evidence.filter((e) => e.kind === 'excerpt').map((e) => e.text),
    ['first 😀 part', 'second part'],
  );
  assert.equal(
    calls.filter((c) => c.name === 'read_source')[1].args.selector.offset,
    12,
  );
  assert.equal(saved.coverage.source_characters, 23);
});

void test('no selected knowledge never falls back to scoped materials', async (t) => {
  const { client, input } = await fixture(t, (value, name, args) => {
    if (name === 'search_knowledge' && !args.query) {
      value.data.hits = [];
      value.data.nodes = [material];
      value.next_cursor = null;
      value.coverage = {
        total_count: 0,
        returned_count: 0,
        truncated: false,
        status: 'complete',
      };
    }
    return value;
  });
  await assert.rejects(client.screeningSnapshot(input), {
    code: 'insufficient_context',
  });
});

void test(
  'actual AI Persona MCP round trip on isolated demo data (no model or personal data)',
  { timeout: 60000 },
  async (t) => {
    const project = resolve(
      fileURLToPath(new URL('../../../ai-persona', import.meta.url)),
    );
    const python =
      process.env.AI_PERSONA_TEST_PYTHON || join(project, '.venv/bin/python');
    try {
      await access(python);
    } catch {
      if (process.env.PAPER_RADAR_REQUIRE_PERSONA_TESTS === '1')
        throw new Error(
          'AI Persona integration dependencies are required by this check. Run npm run setup:radar.',
        );
      t.skip(
        'Set AI_PERSONA_TEST_PYTHON to run the sibling Persona integration.',
      );
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'radar-persona-real-'));
    const config = join(directory, 'connection.json');
    await writeFile(
      config,
      JSON.stringify({
        command: python,
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
    assert.ok(tags.tags.some((t) => t.id === 'tag_physics'));
    const input = {
      persona_connection_id: tags.connection_id,
      scope: { tag_ids: ['tag_physics'], tag_match: 'any' },
    };
    const screening = await client.screeningSnapshot(input);
    assert.ok(screening.knowledge_ids.length >= 4);
    assert.ok(
      screening.records.every((r) => r.entity_type === 'knowledge_node'),
    );
    const full = await client.snapshot(
      {
        title: 'TEBD tensor network quantum dynamics',
        abstract: 'TEBD 张量网络 非平衡动力学',
        references: [],
      },
      input,
    );
    assert.ok(full.relations.length > 0);
    assert.ok(full.records.some((r) => r.entity_type === 'material'));
    assert.ok(
      full.evidence.some(
        (e) => e.kind === 'excerpt' && e.file_hash && e.locator,
      ),
    );
    assert.ok(
      full.retrieval.some((r) => r.retrieval?.semantic?.status === 'disabled'),
    );
  },
);
