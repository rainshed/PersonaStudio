import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { PersonaQueryClient, protocolError } from './query-client.mjs';
import { emptyQueryContext } from './agent-tools.mjs';

export const PERSONA_CONTEXT_VERSION = 'paper-radar.persona-context/v2';
const MAX_RECORDS = 1000;
const MAX_CONTEXT_BYTES = 400000;
const RECORD_BUDGET = 60000;
const SOURCE_BUDGET = 45000;
// The Python query protocol counts Unicode code points, not UTF-16 units.
const charCount = (value) => Array.from(value).length;
const validProvenance = (value) =>
  value.provenance?.kind === 'record' &&
  value.provenance.record_id === value.id &&
  value.provenance.record_revision === value.record_revision;
const normalize = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
const recordId = (record) => `persona:${record.id}:r${record.record_revision}`;
const retryableRead = (error) =>
  ['version_changed', 'source_changed', 'invalid_cursor'].includes(error.code);
const budgetError = () =>
  new AnalysisError(
    'persona_budget',
    '所选范围的知识点未完整读取，请缩小标签范围后运行。',
    true,
  );
const scopedNode = (node, scope) =>
  Array.isArray(node.tags) &&
  node.tags.some((id) => scope.tag_ids.includes(id));
const recordFields = [
  'id',
  'entity_type',
  'title',
  'aliases',
  'description',
  'summary',
  'abstract',
  'syllabus',
  'scope_note',
  'semantic_role',
  'knowledge_level',
  'interest_level',
  'preference_level',
  'user_relationships',
  'material_type',
  'tags',
  'bibliography',
  'source_ref',
  'evidence_refs',
];

export function referenceMatches(paper, records) {
  const matches = [];
  for (const record of records.filter((r) => r.entity_type === 'material')) {
    const identifiers = [
      ...JSON.stringify(record.bibliography || {}).matchAll(
        /(?:\d{4}\.\d{4,5}|10\.\d{4,9}\/[\w.()/:;-]+)/g,
      ),
    ].map((m) => m[0].replace(/[.,;)]+$/, '').toLowerCase());
    const title = normalize(record.title);
    const unique =
      records.filter((r) => normalize(r.title) === title).length === 1;
    for (const ref of paper.references ?? []) {
      const raw = (ref.text + ' ' + ref.links.join(' ')).toLowerCase();
      const identifier = identifiers.find((id) => raw.includes(id));
      if (
        identifier ||
        (unique && title.length >= 25 && normalize(ref.text).includes(title))
      )
        matches.push({
          material_id: record.id,
          evidence_id: ref.evidence_id,
          basis: identifier ? 'identifier:' + identifier : 'exact_unique_title',
        });
    }
  }
  return matches;
}

export function personaPromptContext(context) {
  return {
    schema_version: context.schema_version,
    scope: context.scope,
    persona_revision: context.revision,
    recommendation_knowledge_ids: context.knowledge_ids,
    records: context.records,
    relations: context.relations,
    evidence: context.evidence,
    reference_matches: context.matches,
    retrieval: context.retrieval,
    coverage: context.coverage,
  };
}

export class PersonaClient extends PersonaQueryClient {
  async status() {
    try {
      await this.connect();
      return {
        connected: true,
        connection_id: this.identity,
        query_schema: 'ai-persona.query-result/v2',
      };
    } catch (error) {
      return { connected: false, connection_id: null, error: error.message };
    }
  }
  async tags({ query = '', cursor, expected_persona_revision } = {}, signal) {
    if (cursor)
      throw new AnalysisError('invalid_cursor', '请重新读取标签目录。');
    // The current map includes all domain descriptors on every page. Only this
    // local setup endpoint may discover domains without a selected scope. No
    // map nodes from discovery are retained, returned to the UI, or sent to a model.
    const result = await this.call(
      'get_knowledge_map',
      {
        max_chars: RECORD_BUDGET,
        ...(expected_persona_revision ? { expected_persona_revision } : {}),
      },
      signal,
    );
    const tags = result.data.domains.filter(
      (t) =>
        !query ||
        [t.label, ...(t.aliases ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
    return {
      connection_id: this.identity,
      persona_revision: result.persona_revision,
      tags,
      total_count: tags.length,
      next_cursor: null,
    };
  }
  async scopeReader(input, signal, expectedRevision) {
    if (!input.scope.tag_ids.length) return null;
    await this.connect();
    if (input.persona_connection_id !== this.identity)
      throw new AnalysisError(
        'persona_changed',
        'Persona 连接已变化，请刷新标签后重新分析。',
      );
    const scope = structuredClone(input.scope);
    const first = await this.call(
      'get_knowledge_map',
      {
        scope,
        max_chars: RECORD_BUDGET,
        ...(expectedRevision
          ? { expected_persona_revision: expectedRevision }
          : {}),
      },
      signal,
    );
    const revision = first.persona_revision;
    const scoped = (name, args = {}) =>
      this.call(
        name,
        { ...args, scope, expected_persona_revision: revision },
        signal,
      );
    return { scope, revision, tags: first.data.domains, scoped };
  }
  async pages(range, tool, args, receive) {
    let cursor;
    const seen = new Set();
    for (let page = 0; page < 200; page++) {
      const value = await range.scoped(tool, {
        ...args,
        ...(cursor ? { cursor } : {}),
      });
      receive(value);
      if (!value.next_cursor) {
        if (value.coverage.truncated) throw protocolError();
        return;
      }
      if (seen.has(value.next_cursor)) throw protocolError();
      seen.add(value.next_cursor);
      cursor = value.next_cursor;
    }
    throw budgetError();
  }
  checkNode(node, scope) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      !Number.isInteger(node.record_revision) ||
      !validProvenance(node) ||
      !scopedNode(node, scope)
    )
      throw new AnalysisError(
        'out_of_scope',
        'Persona 返回的记录不属于所选标签范围。',
      );
  }
  async records(range, ids) {
    const result = [],
      issues = [];
    for (let offset = 0; offset < ids.length; offset += 10) {
      const requested = ids.slice(offset, offset + 10),
        items = new Map(),
        fragments = new Map();
      await this.pages(
        range,
        'get_persona_records',
        {
          record_ids: requested,
          include_evidence: true,
          max_chars: RECORD_BUDGET,
        },
        (page) => {
          for (const item of page.data.items) {
            if (!requested.includes(item.id)) throw protocolError();
            if (item.error) {
              issues.push({ id: item.id, ...item.error });
              continue;
            }
            if (item.field) {
              if (
                typeof item.value !== 'string' ||
                !Number.isInteger(item.offset) ||
                !Number.isInteger(item.total_chars)
              )
                throw protocolError();
              const key = item.id + ':' + item.field;
              const fragment = fragments.get(key) ?? {
                value: '',
                total: item.total_chars,
                revision: item.record_revision,
              };
              if (
                !validProvenance(item) ||
                charCount(fragment.value) !== item.offset ||
                fragment.total !== item.total_chars ||
                fragment.revision !== item.record_revision
              )
                throw protocolError();
              fragment.value += item.value;
              fragments.set(key, fragment);
            } else {
              if (!item.record || items.has(item.id)) throw protocolError();
              items.set(item.id, structuredClone(item));
            }
          }
          if (
            Buffer.byteLength(JSON.stringify([...items, ...fragments])) >
            MAX_CONTEXT_BYTES
          )
            throw budgetError();
        },
      );
      for (const id of requested) {
        const item = items.get(id);
        if (!item) {
          if (!issues.some((issue) => issue.id === id)) throw protocolError();
          continue;
        }
        for (const field of item.continued_fields ?? []) {
          const fragment = fragments.get(id + ':' + field);
          if (
            !fragment ||
            charCount(fragment.value) !== fragment.total ||
            fragment.revision !== item.record_revision
          )
            throw protocolError();
          if (field === 'body') item.body = fragment.value;
          else item.record[field] = fragment.value;
        }
        if (item.completeness !== 'complete' && !item.continued_fields?.length)
          throw protocolError();
        const record = Object.fromEntries(
          recordFields
            .filter((f) => Object.hasOwn(item.record, f))
            .map((f) => [f, item.record[f]]),
        );
        Object.assign(record, {
          record_revision: item.record_revision,
          provenance: item.provenance,
          supporting_evidence: item.evidence ?? [],
          body: item.body ?? '',
        });
        if (
          record.id !== id ||
          item.entity_type !== record.entity_type ||
          item.omitted_fields?.length
        )
          throw protocolError();
        this.checkNode(record, range.scope);
        result.push(record);
      }
    }
    return { records: result, issues };
  }
  async knowledgeContext(input, signal, expectedRevision) {
    const range = await this.scopeReader(input, signal, expectedRevision);
    if (!range) return null;
    const nodes = new Map();
    let totalKnowledge;
    await this.pages(
      range,
      'search_knowledge',
      {
        query: '',
        entity_types: ['knowledge_node'],
        limit: 50,
        max_chars: RECORD_BUDGET,
      },
      (page) => {
        if (
          !Number.isInteger(page.coverage.total_count) ||
          (totalKnowledge !== undefined &&
            totalKnowledge !== page.coverage.total_count)
        )
          throw protocolError();
        totalKnowledge = page.coverage.total_count;
        for (const node of page.data.nodes) this.checkNode(node, range.scope);
        // Search returns graph context nodes as well as hits. Only knowledge hits
        // define the subscription's recommendation basis, never adjacent materials.
        for (const hit of page.data.hits) {
          const node = page.data.nodes.find((n) => n.id === hit.id);
          if (node?.entity_type !== 'knowledge_node') throw protocolError();
          nodes.set(node.id, node);
        }
        if (
          nodes.size > MAX_RECORDS ||
          Buffer.byteLength(JSON.stringify([...nodes.values()])) >
            MAX_CONTEXT_BYTES
        )
          throw budgetError();
      },
    );
    if (nodes.size !== totalKnowledge) throw protocolError();
    if (!nodes.size)
      throw new AnalysisError(
        'insufficient_context',
        '所选标签下没有知识点，无法进行个性化推荐。材料不会代替知识点。',
        true,
      );
    const details = await this.records(range, [...nodes.keys()]);
    if (
      details.issues.length ||
      details.records.length !== nodes.size ||
      details.records.some(
        (r) =>
          r.entity_type !== 'knowledge_node' ||
          r.record_revision !== nodes.get(r.id)?.record_revision,
      )
    )
      throw new AnalysisError(
        'insufficient_context',
        '部分推荐知识点未能完整读取，请重新准备依据。',
        true,
      );
    if (Buffer.byteLength(JSON.stringify(details.records)) > MAX_CONTEXT_BYTES)
      throw budgetError();
    const context = {
      schema_version: PERSONA_CONTEXT_VERSION,
      identity: this.identity,
      revision: range.revision,
      scope: range.scope,
      tags: range.tags,
      knowledge_ids: [...nodes.keys()],
      records: details.records,
      relations: [],
      matches: [],
      evidence: [],
      retrieval: [],
      coverage: {
        total_knowledge: nodes.size,
        complete_knowledge_scan: true,
        selected_records: nodes.size,
        source_characters: 0,
        source_reading: 'not_requested',
        issues: [],
      },
    };
    this.recordEvidence(context);
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES)
      throw budgetError();
    return { range, context };
  }
  recordEvidence(context) {
    const other = context.evidence.filter((e) => e.kind !== 'record');
    context.evidence = [
      ...context.records.map((record) => ({
        id: recordId(record),
        record_id: record.id,
        record_revision: record.record_revision,
        title: record.title,
        kind: 'record',
        provenance: record.provenance,
        text: JSON.stringify(record),
      })),
      ...other,
    ];
  }
  async stableRead(operation, onProgress = () => {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt || !retryableRead(error)) throw error;
        onProgress('Persona 已更新，正在重新读取同一标签下的知识点');
      }
    }
  }
  async screeningSnapshot(input, signal) {
    if (!input.scope.tag_ids.length)
      throw new AnalysisError('empty_scope', '请选择推荐依据的知识点标签。');
    return this.stableRead(async () => {
      const { range, context } = await this.knowledgeContext(input, signal);
      await range.scoped('search_knowledge', {
        query: '',
        entity_types: ['knowledge_node'],
        limit: 1,
        max_chars: RECORD_BUDGET,
      });
      return context;
    });
  }
  async queryContext(input, signal) {
    if (!input.scope.tag_ids.length) throw new AnalysisError('empty_scope', '请选择推荐依据的知识点标签。');
    const range = await this.scopeReader(input, signal);
    return emptyQueryContext(range, this.identity);
  }
  async snapshot(paper, input, signal, onProgress = () => {}, question = '') {
    if (!input.scope.tag_ids.length) return null;
    return this.stableRead(async () => {
      onProgress('完整读取所选标签下的推荐知识点');
      const { range, context } = await this.knowledgeContext(input, signal);
      await this.enrich(range, context, paper, question, onProgress);
      return context;
    }, onProgress);
  }
  async enrich(range, context, paper, question, onProgress) {
    const query = [question, paper.title, paper.abstract]
      .filter(Boolean)
      .join('\n')
      .slice(0, 11000);
    onProgress('围绕论文与知识点检索相关关系和材料');
    const search = await range.scoped('search_knowledge', {
      query,
      max_hops: 2,
      limit: 12,
      max_chars: RECORD_BUDGET,
    });
    for (const node of search.data.nodes) this.checkNode(node, range.scope);
    const visible = new Map(
      [...context.records, ...search.data.nodes].map((n) => [n.id, n]),
    );
    const known = new Set(context.knowledge_ids);
    const edgeMap = new Map(search.data.edges.map((e) => [e.id, e]));
    const frontier = new Set();
    const focus = search.data.hits.map((h) => h.id).slice(0, 10);
    if (focus.length) {
      const map = await range.scoped('get_knowledge_map', {
        focus_ids: focus,
        max_hops: 2,
        max_chars: RECORD_BUDGET,
      });
      for (const node of map.data.nodes) {
        this.checkNode(node, range.scope);
        visible.set(node.id, node);
      }
      for (const edge of map.data.edges) edgeMap.set(edge.id, edge);
      for (const node of map.data.frontier) frontier.add(node.id);
      context.retrieval.push({
        tool: 'get_knowledge_map',
        focus_ids: focus,
        coverage: map.coverage,
        frontier: map.data.frontier,
        next_cursor: map.next_cursor,
      });
      context.coverage.issues.push(
        ...map.warnings,
        ...(map.next_cursor
          ? ['关系图仅使用已返回的邻域，部分关系尚未展开。']
          : []),
      );
    }
    const returnedEdges = [...edgeMap.values()];
    if (
      returnedEdges.some(
        (e) =>
          !validProvenance(e) ||
          [e.source_id, e.target_id].some(
            (id) => !visible.has(id) && !frontier.has(id),
          ),
      )
    )
      throw protocolError();
    // A valid map page can refer to an unread endpoint in its frontier. Such
    // edges are retained in retrieval coverage, not used as complete evidence.
    const edges = returnedEdges.filter(
      (e) => visible.has(e.source_id) && visible.has(e.target_id),
    );
    if (edges.length !== returnedEdges.length)
      context.coverage.issues.push(
        '部分关系的另一端尚未读取，未用作推荐证据。',
      );
    // Only supplementary records connected to a selected knowledge point can
    // support recommendations. Retrieval scores never become personal facts.
    const reachable = new Set(known);
    for (let hop = 0; hop < 2; hop++) {
      const previous = new Set(reachable);
      for (const edge of edges) {
        if (previous.has(edge.source_id)) reachable.add(edge.target_id);
        if (previous.has(edge.target_id)) reachable.add(edge.source_id);
      }
    }
    const ids = [...visible.values()]
      .filter(
        (n) =>
          !context.records.some((r) => r.id === n.id) && reachable.has(n.id),
      )
      .map((n) => n.id)
      .slice(0, 24);
    const details = ids.length
      ? await this.records(range, ids)
      : { records: [], issues: [] };
    context.records = [
      ...context.records,
      ...details.records.filter(
        (r) => !context.records.some((v) => v.id === r.id),
      ),
    ];
    const retained = new Set(context.records.map((r) => r.id));
    for (const edge of edges.filter(
      (e) => retained.has(e.source_id) && retained.has(e.target_id),
    )) {
      if (!context.relations.some((r) => r.id === edge.id)) {
        context.relations.push(edge);
        context.evidence.push({
          id: recordId(edge),
          record_id: edge.id,
          record_revision: edge.record_revision,
          kind: 'relation',
          title: `${edge.source_id} · ${edge.relation_type} · ${edge.target_id}`,
          provenance: edge.provenance,
          text: JSON.stringify(edge),
        });
      }
    }
    context.retrieval.push({
      tool: 'search_knowledge',
      query,
      hits: search.data.hits,
      coverage: search.coverage,
      retrieval: search.data.retrieval,
      next_cursor: search.next_cursor,
    });
    context.coverage.issues.push(
      ...search.warnings,
      ...(search.next_cursor
        ? ['相关材料检索仅采用本次返回的候选，未遍历全部结果。']
        : []),
      ...details.issues.map(
        (issue) => `补充记录 ${issue.id} 未读取：${issue.code}`,
      ),
    );
    context.coverage.selected_records = context.records.length;
    this.recordEvidence(context);
    context.matches = referenceMatches(paper, context.records);
    await this.readMaterials(range, context, query, onProgress);
    if (Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES)
      throw budgetError();
    context.coverage.issues = [...new Set(context.coverage.issues)];
    await range.scoped('search_knowledge', {
      query: '',
      entity_types: ['knowledge_node'],
      limit: 1,
      max_chars: RECORD_BUDGET,
    });
  }
  async readMaterials(range, context, query, onProgress) {
    const materials = context.records.filter(
      (r) => r.entity_type === 'material' && r.source_ref,
    );
    const sources = new Map();
    for (const material of materials) {
      const group = sources.get(material.source_ref) ?? [];
      group.push(material);
      sources.set(material.source_ref, group);
    }
    context.coverage.source_reading = sources.size
      ? 'partial'
      : 'not_available';
    if (!sources.size) {
      context.coverage.issues.push(
        '所选知识点没有可用的关联材料来源，本次依据为知识点记录。',
      );
      return;
    }
    const provenanceSeen = new Set(
      context.evidence
        .filter((e) => e.kind === 'excerpt')
        .map((e) => hash(e.provenance)),
    );
    let count = 0;
    for (const [source_id, owners] of sources) {
      if (count++ >= 8 || context.coverage.source_characters >= SOURCE_BUDGET) {
        context.coverage.issues.push(
          '相关材料原文达到本次读取预算，部分内容未读。',
        );
        break;
      }
      onProgress('通过 Persona 来源接口定位并核对材料原文');
      try {
        const listing = await range.scoped('list_source_files', {
          source_id,
          recursive: true,
          limit: 100,
          max_chars: RECORD_BUDGET,
        });
        const entries = listing.data.entries.filter(
          (e) =>
            e.kind === 'file' &&
            e.parse_status === 'ready' &&
            e.available_views?.includes('text'),
        );
        if (listing.data.source_id !== source_id) throw protocolError();
        const preferred = entries.filter((e) => e.role === 'extracted_text');
        const files = (preferred.length ? preferred : entries).slice(0, 4);
        context.retrieval.push({
          tool: 'list_source_files',
          source_id,
          coverage: listing.coverage,
          next_cursor: listing.next_cursor,
          entries: listing.data.entries,
        });
        if (listing.next_cursor || entries.length > files.length)
          context.coverage.issues.push('仅检索部分可读来源文件。');
        if (!files.length) {
          context.coverage.issues.push(
            `材料 ${owners[0].title} 没有可检索的文本。`,
          );
          continue;
        }
        const found = await range.scoped('search_source_content', {
          query,
          files: files.map((f) => ({ source_id, file_id: f.file_id })),
          limit: 3,
          context_chars: 600,
          max_chars: 16000,
        });
        context.retrieval.push({
          tool: 'search_source_content',
          source_id,
          query,
          coverage: found.coverage,
          index_coverage: found.data.index_coverage,
          semantic: found.data.semantic,
          next_cursor: found.next_cursor,
        });
        context.coverage.issues.push(...found.warnings);
        if (!found.data.matches.length)
          context.coverage.issues.push(
            `材料 ${owners[0].title} 未找到相关原文片段。`,
          );
        for (const match of found.data.matches) {
          const file = files.find((f) => f.file_id === match.file_ref?.file_id);
          if (
            match.file_ref?.source_id !== source_id ||
            !file ||
            !match.passage_ref
          )
            throw protocolError();
          let selector;
          let remaining = Math.min(
            9000,
            SOURCE_BUDGET - context.coverage.source_characters,
          );
          const offsets = new Set();
          while (remaining >= 1000) {
            const read = await range.scoped('read_source', {
              passage_ref: match.passage_ref,
              view: 'text',
              max_chars: Math.min(16000, remaining + 2000),
              ...(selector ? { selector } : {}),
            });
            const data = read.data,
              provenance = data.provenance;
            if (
              data.file_ref?.source_id !== source_id ||
              data.file_ref?.file_id !== file.file_id ||
              provenance?.source_id !== source_id ||
              provenance?.file_id !== file.file_id ||
              provenance?.file_hash !== file.file_hash ||
              typeof data.text !== 'string' ||
              !provenance.locator
            )
              throw new AnalysisError(
                'source_changed',
                '原文读取与所选文件或来源哈希不一致。',
              );
            const digest = hash(provenance);
            const characters = charCount(data.text);
            if (characters > remaining) throw protocolError();
            if (!provenanceSeen.has(digest)) {
              provenanceSeen.add(digest);
              context.coverage.source_characters += characters;
              for (const owner of owners)
                context.evidence.push({
                  id: `persona:${owner.id}:source:${digest.slice(0, 24)}`,
                  record_id: owner.id,
                  record_revision: owner.record_revision,
                  kind: 'excerpt',
                  title: owner.title,
                  text: data.text,
                  source_id,
                  file_id: file.file_id,
                  file_hash: file.file_hash,
                  source_hash: listing.data.source_hash,
                  file_name: file.relative_path,
                  provenance,
                  locator: provenance.locator,
                  ...(provenance.locator.lines
                    ? {
                        lines: [
                          provenance.locator.lines.start,
                          provenance.locator.lines.end,
                        ],
                      }
                    : {}),
                  ...(provenance.locator.pages
                    ? { pages: provenance.locator.pages }
                    : {}),
                });
            }
            remaining -= characters;
            if (!data.truncated) break;
            if (
              !data.next_selector ||
              !data.text.length ||
              offsets.has(JSON.stringify(data.next_selector))
            )
              throw protocolError();
            offsets.add(JSON.stringify(data.next_selector));
            selector = data.next_selector;
            if (remaining < 1000)
              context.coverage.issues.push(
                '相关原文片段未读完，不能视为完整原文。',
              );
          }
        }
      } catch (error) {
        if (
          ![
            'parse_failed',
            'unsupported_view',
            'source_unavailable',
            'not_found_or_not_visible',
          ].includes(error.code)
        )
          throw error;
        context.coverage.issues.push(
          `材料 ${owners[0].title} 原文未读取：${error.message}`,
        );
      }
    }
    context.coverage.issues.push(
      '材料原文按问题读取片段，未阅读全文；未检索标签范围外内容。',
    );
  }
  async supplement(
    paper,
    input,
    saved,
    question,
    signal,
    onProgress = () => {},
  ) {
    if (saved.schema_version !== PERSONA_CONTEXT_VERSION)
      return {
        context: saved,
        limitation:
          '此讨论保留原有依据；使用新版知识点推荐依据请重新分析论文后发起讨论。',
      };
    try {
      const range = await this.scopeReader(input, signal, saved.revision);
      const context = structuredClone(saved);
      await this.enrich(range, context, paper, question, onProgress);
      return { context, limitation: null };
    } catch (error) {
      if (retryableRead(error))
        return {
          context: saved,
          limitation:
            'Persona 已更新，本轮保留已保存的旧版依据；补读最新资料请重新分析论文后发起讨论。',
        };
      throw error;
    }
  }
}
