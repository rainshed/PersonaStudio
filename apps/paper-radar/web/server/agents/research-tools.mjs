import { z } from 'zod';
import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { referenceMatches } from '../persona/service.mjs';
import { PersonaAgentTools } from '../persona/agent-tools.mjs';
import { PERSONA_QUERY_TOOLS, PERSONA_QUERY_NAMES, PERSONA_READING_VERSION } from '@paper-radar/host-contract/persona-tools';

export const AUTONOMOUS_VERSION = 'paper-radar.autonomous.v1';
export function toolProgress(name) {
  if (name.startsWith('persona') || PERSONA_QUERY_NAMES.has(name)) return 'Agent 正在查阅所选知识与材料';
  if (name.startsWith('paper')) return 'Agent 正在查阅论文';
  if (name.startsWith('history')) return 'Agent 正在查阅讨论记录';
  if (name.startsWith('report')) return 'Agent 正在查阅已有分析';
  if (name.startsWith('notes')) return 'Agent 正在整理笔记';
  return 'Agent 正在核对依据';
}
const text = { type: 'string' },
  offset = { type: 'integer', minimum: 0 };
const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const jsonSchema = (schema) => {
  const { $schema: _schema, ...value } = z.toJSONSchema(schema);
  return value;
};
const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  parameters: obj(properties, required),
});
const size = 6500;
function position(value, max) {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw new AnalysisError('invalid_cursor', '读取位置无效。');
  return n;
}
const words = (q) =>
  String(q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
const match = (value, q) =>
  words(q).every((w) => String(value).toLowerCase().includes(w));
const recordId = (r) => `persona:${r.id}:r${r.record_revision}`;
export const publicPaper = ({
  blocks: _blocks,
  references: _references,
  ...paper
}) => paper;

// Evidence delivery is recorded for provenance, never used as a prescribed reading plan.
export class ResearchTools {
  constructor({
    analyses,
    input,
    signal,
    paper = null,
    persona = null,
    report = null,
    history = [],
    notes = [],
    evidence = [],
    onChange = () => {},
  }) {
    Object.assign(this, {
      analyses,
      input,
      signal,
      paper,
      persona,
      report,
      history,
      notes,
      onChange,
    });
    this.feedbackReplayResponses = [];
    this.delivered = new Map();
    this.reads = [];
    this.passages = new Map();
    this.files = new Map();
    this.range = null;
    this.full = paper?.blocks ? paper : null;
    this.known = new Map(evidence.map((e) => [e.id, e]));
  }
  async prepare() {
    if (!this.paper) {
      this.paper = this.analyses.arxiv.metadata
        ? await this.analyses.arxiv.metadata(
            this.input.arxiv_input,
            this.signal,
          )
        : await this.analyses.arxiv.get(this.input.arxiv_input, this.signal);
      if (this.paper.blocks) this.full = this.paper;
    }
    this.paper.coverage ??= {
      format: 'abstract',
      block_count: 1,
      reference_count: null,
      issues: ['正文尚未读取；当前依据为论文元数据与摘要。'],
    };
    this.paper.url ??= `https://arxiv.org/abs/${this.paper.id}v${this.paper.version}`;
    this.input = { ...this.input, arxiv_input: this.paper.url };
    if (this.input.scope.tag_ids.length && !this.persona) {
      if (this.analyses.persona.scopeReader) {
        this.range = await this.analyses.persona.scopeReader(
          this.input,
          this.signal,
        );
        this.persona = {
          schema_version: 'paper-radar.persona-context/v2',
          identity: this.input.persona_connection_id,
          revision: this.range.revision,
          scope: this.range.scope,
          tags: this.range.tags,
          records: [],
          evidence: [],
          knowledge_ids: [],
          matches: [],
          relations: [],
          retrieval: [],
          coverage: {
            complete_knowledge_scan: false,
            issues: [],
            source_characters: 0,
          },
        };
      } else {
        this.persona = await (this.analyses.persona.screeningSnapshot?.(
          this.input,
          this.signal,
        ) ??
          this.analyses.persona.snapshot(this.paper, this.input, this.signal));
      }
    }
    if (
      this.persona &&
      (hash(
        [...(this.persona.scope?.tag_ids ?? [])].sort((a, b) =>
          a.localeCompare(b),
        ),
      ) !==
        hash(
          [...this.input.scope.tag_ids].sort((a, b) => a.localeCompare(b)),
        ) ||
        (this.persona.scope?.tag_match ?? 'any') !==
          (this.input.scope.tag_match ?? 'any'))
    )
      throw new AnalysisError(
        'out_of_scope',
        'Persona 返回的知识范围与当前任务不一致。',
      );
    this.abstractId = `paper:${this.paper.id}v${this.paper.version}:abstract:${hash(this.paper.abstract ?? '').slice(0, 16)}`;
    this.delivered.set(this.abstractId, {
      id: this.abstractId,
      title: this.paper.title,
      kind: 'abstract',
      text: String(this.paper.abstract ?? '').slice(0, 10000),
      url: this.paper.url,
    });
    return this;
  }
  initial() {
    return {
      paper: {
        id: this.paper.id,
        version: this.paper.version,
        title: this.paper.title,
        url: this.paper.url,
        blocks: undefined,
        references: undefined,
        abstract: String(this.paper.abstract ?? '').slice(0, 10000),
        source_ref: this.abstractId,
      },
      persona_scope: this.persona
        ? {
            scope: this.persona.scope,
            revision: this.persona.revision,
            source_ref: `persona-scope:${this.persona.identity}:${this.persona.revision}`,
          }
        : null,
      available_results: {
        report: !!this.report,
        history_messages: this.history.length,
        notes_total: this.notes.length,
        notes: this.notes
          .slice(0, 20)
          .map((n, i) => ({ id: i, title: n.title })),
        source_ref: 'paper-radar:task-context',
      },
    };
  }
  async fullPaper() {
    if (!this.full) {
      this.loading ??= this.analyses.arxiv
        .get(this.paper.url, this.signal)
        .then((p) => {
          if (p.id !== this.paper.id || p.version !== this.paper.version)
            throw new AnalysisError('source_changed', '论文版本已变化。');
          this.full = p;
          return p;
        })
        .catch((e) => {
          this.loading = null;
          throw e;
        });
      await this.loading;
    }
    return this.full;
  }
  async personaRange() {
    if (!this.persona)
      throw new AnalysisError('out_of_scope', '本任务没有选择个人知识范围。');
    if (!this.range && this.analyses.persona.scopeReader)
      this.range = await this.analyses.persona.scopeReader(
        this.input,
        this.signal,
        this.persona.revision,
      );
    return this.range;
  }
  personaQueries() {
    if (!this.persona) throw new AnalysisError('out_of_scope', '本任务没有选择个人知识范围。');
    this.queries ??= new PersonaAgentTools({
      context: this.persona, getRange: () => this.personaRange(),
      onEvidence: e => { this.delivered.set(e.id, e); this.known.set(e.id, e); },
    });
    return this.queries;
  }
  mergeRecords(records) {
    for (const r of records) {
      if (
        this.persona.records.some(
          (v) => v.id === r.id && v.record_revision !== r.record_revision,
        )
      )
        throw new AnalysisError('source_changed', '知识版本已变化。');
      if (!this.persona.records.some((v) => v.id === r.id))
        this.persona.records.push(r);
      if (
        r.entity_type === 'knowledge_node' &&
        !this.persona.knowledge_ids.includes(r.id)
      )
        this.persona.knowledge_ids.push(r.id);
      if (!this.persona.evidence.some((e) => e.id === recordId(r)))
        this.persona.evidence.push({
          id: recordId(r),
          record_id: r.id,
          record_revision: r.record_revision,
          title: r.title,
          kind: 'record',
          text: JSON.stringify(r),
          provenance: r.provenance,
        });
    }
    this.persona.matches = referenceMatches(
      this.full ?? this.paper,
      this.persona.records,
    );
  }
  excerpt(e, start = 0, limit = size) {
    this.known.set(e.id, e);
    const body = String(e.text ?? ''),
      at = position(start, body.length),
      end = Math.min(body.length, at + limit);
    // Record fields use their stable record citation; text excerpts identify exact slices.
    const id =
      e.kind === 'record' || (at === 0 && end === body.length)
        ? e.id
        : `${e.id}:slice:${at}:${end}`;
    const record =
      e.kind === 'record'
        ? this.persona?.records.find((r) => r.id === e.record_id)
        : null;
    const facts = record
      ? Object.fromEntries(
          [
            'interest_level',
            'knowledge_level',
            'preference_level',
            'user_relationships',
          ]
            .filter((k) => Object.hasOwn(record, k))
            .map((k) => [k, record[k]]),
        )
      : null;
    const value = {
      ...e,
      id,
      ...(facts ? { fact_fields: facts } : {}),
      text: body.slice(at, end),
      locator: { ...e.locator, offset: at, end },
    };
    const prior = this.delivered.get(id);
    if (e.kind === 'record' && prior && !prior.text.includes(value.text))
      value.text = prior.text + '\n' + value.text;
    if (facts) value.text += '\nPersonal fact fields: ' + JSON.stringify(facts);
    this.delivered.set(id, value);
    return {
      ...e,
      id,
      ...(facts ? { fact_fields: facts } : {}),
      text: body.slice(at, end),
      source_ref: id,
      content_id: e.id,
      offset: at,
      next_offset: end < body.length ? end : null,
    };
  }
  toolset() { return researchToolset({ personal: !!this.persona, query: !!this.analyses.persona.scopeReader }); }
  async record(id) {
    await this.personaRange();
    let r = this.persona.records.find((r) => r.id === id);
    if (!r && this.range) {
      const response = await this.analyses.persona.records(this.range, [id]);
      this.mergeRecords(response.records);
      r = this.persona.records.find((r) => r.id === id);
    }
    if (!r) throw new AnalysisError('out_of_scope', '知识记录不在本次范围内。');
    this.mergeRecords([r]);
    return r;
  }
  async call(name, args = {}) {
    this.signal.throwIfAborted();
    this.reads.push({ name, at: new Date().toISOString() });
    let value;
    if (PERSONA_QUERY_NAMES.has(name)) {
      value = await this.personaQueries().call(name, args);
      this.persona.matches = referenceMatches(this.full ?? this.paper, this.persona.records);
    } else if (name === 'paper_get_metadata') value = this.initial().paper;
    else if (
      [
        'paper_get_outline',
        'paper_read',
        'paper_search',
        'paper_references',
        'paper_figures',
      ].includes(name)
    ) {
      const p = await this.fullPaper();
      const groups = [];
      for (const b of p.blocks) {
        let g = groups.at(-1);
        if (!g || g.title !== (b.section ?? '正文'))
          groups.push(
            (g = {
              id: `section-${groups.length}`,
              title: b.section ?? '正文',
              blocks: [],
            }),
          );
        g.blocks.push(b);
      }
      if (name === 'paper_get_outline') {
        const at = position(args.offset, groups.length),
          end = Math.min(at + 25, groups.length);
        value = {
          sections: groups.slice(at, end).map((g) => ({
            id: g.id,
            title: g.title,
            blocks: g.blocks.map((b) => ({ id: b.id, kind: b.kind })),
          })),
          next_offset: end < groups.length ? end : null,
          coverage: p.coverage,
          source_ref: `paper:${p.id}v${p.version}`,
        };
      } else if (name === 'paper_read') {
        const group =
          args.section_id === 'all'
            ? { id: 'all', title: p.title, blocks: p.blocks }
            : groups.find((g) => g.id === args.section_id);
        const b = p.blocks.find((b) => b.id === args.section_id);
        if (!group && !b)
          throw new AnalysisError(
            'invalid_reference',
            '章节或内容标识不存在。',
          );
        const e = b ?? {
          id: `paper:${p.id}v${p.version}:${p.source_hash}:${group.id}`,
          title: group.title,
          kind: 'excerpt',
          text: group.blocks.map((b) => `[${b.id}] ${b.text}`).join('\n'),
          url: p.url,
        };
        value = this.excerpt(e, args.offset);
      } else {
        const source =
          name === 'paper_references'
            ? (p.references ?? [])
                .map((r) => p.blocks.find((b) => b.id === r.evidence_id))
                .filter(Boolean)
            : name === 'paper_figures'
              ? p.blocks.filter((b) =>
                  /figure|table|caption/i.test(b.kind + ' ' + b.section),
                )
              : p.blocks.filter((b) => match(b.text, args.query));
        const at = position(args.offset, source.length),
          end = Math.min(at + 5, source.length);
        value = {
          items: source.slice(at, end).map((b) => ({
            ...this.excerpt(b, 0, 1000),
            block_id: b.id,
            truncated: b.text.length > 1000,
          })),
          next_offset: end < source.length ? end : null,
          total: source.length,
        };
        if (name === 'paper_references' && this.persona) {
          this.mergeRecords([]);
          value.material_matches = this.persona.matches;
        }
        if (name === 'paper_figures') value.image_interpretation = false;
      }
    } else if (name === 'persona_search') {
      const range = await this.personaRange();
      if (range) {
        const response = await range.scoped('search_knowledge', {
          query: args.query ?? '',
          limit: 8,
          max_chars: 14000,
          ...(args.cursor ? { cursor: args.cursor } : {}),
        });
        const ids = response.data.hits.map((h) => h.id);
        const details = ids.length
          ? await this.analyses.persona.records(range, ids)
          : { records: [] };
        this.mergeRecords(details.records);
        value = {
          items: details.records.map((r) => ({
            record_id: r.id,
            ...this.excerpt(
              this.persona.evidence.find((e) => e.id === recordId(r)),
              0,
              1200,
            ),
          })),
          next_cursor: response.next_cursor,
          coverage: response.coverage,
        };
      } else {
        const records = this.persona.records.filter((r) =>
          match(JSON.stringify(r), args.query),
        );
        const at = position(args.offset, records.length),
          end = Math.min(at + 5, records.length);
        value = {
          items: records.slice(at, end).map((r) => {
            this.mergeRecords([r]);
            return {
              record_id: r.id,
              ...this.excerpt(
                this.persona.evidence.find((e) => e.id === recordId(r)),
                0,
                1200,
              ),
            };
          }),
          next_offset: end < records.length ? end : null,
        };
      }
    } else if (name === 'persona_read_record') {
      const r = await this.record(args.record_id);
      value = this.excerpt(
        this.persona.evidence.find((e) => e.id === recordId(r)),
        args.offset,
      );
    } else if (name === 'persona_sources') {
      const r = await this.record(args.record_id),
        range = await this.personaRange();
      if (!range || !r.source_ref)
        throw new AnalysisError(
          'source_unavailable',
          '该记录没有可读取的来源。',
          true,
        );
      const response = await range.scoped('list_source_files', {
        source_id: r.source_ref,
        recursive: true,
        limit: 15,
        max_chars: 12000,
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      if (response.data.source_id !== r.source_ref)
        throw new AnalysisError('source_changed', '材料来源标识不一致。');
      for (const f of response.data.entries)
        if (f.kind === 'file')
          this.files.set(f.file_id, {
            ...f,
            source_id: r.source_ref,
            record: r,
          });
      value = response;
    } else if (name === 'persona_search_source') {
      const file = this.files.get(args.file_id);
      if (!file)
        throw new AnalysisError('invalid_reference', '来源文件标识不存在。');
      const range = await this.personaRange();
      const response = await range.scoped('search_source_content', {
        query: args.query,
        files: [{ source_id: file.source_id, file_id: file.file_id }],
        limit: 5,
        context_chars: 300,
        max_chars: 12000,
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      value = {
        matches: response.data.matches.map((m) => {
          if (
            m.file_ref?.source_id !== file.source_id ||
            m.file_ref?.file_id !== file.file_id ||
            !m.passage_ref
          )
            throw new AnalysisError(
              'source_changed',
              '检索结果不属于所选来源。',
            );
          const id = hash(m.passage_ref);
          this.passages.set(id, { ref: m.passage_ref, file });
          return { passage_id: id, ...m };
        }),
        next_cursor: response.next_cursor,
      };
    } else if (name === 'persona_read_source') {
      const passage = this.passages.get(args.passage_id);
      if (!passage)
        throw new AnalysisError('invalid_reference', '来源片段标识不存在。');
      const range = await this.personaRange();
      const response = await range.scoped('read_source', {
        passage_ref: passage.ref,
        view: 'text',
        max_chars: 10000,
        ...(args.selector ? { selector: args.selector } : {}),
      });
      const d = response.data,
        p = d.provenance,
        f = passage.file;
      if (
        p?.file_hash !== f.file_hash ||
        p?.file_id !== f.file_id ||
        p?.source_id !== f.source_id ||
        d.file_ref?.source_id !== f.source_id ||
        d.file_ref?.file_id !== f.file_id ||
        typeof d.text !== 'string' ||
        !p.locator
      )
        throw new AnalysisError('source_changed', '材料来源版本不一致。');
      const e = {
        id: `persona:${f.record.id}:source:${hash(p).slice(0, 24)}`,
        record_id: f.record.id,
        record_revision: f.record.record_revision,
        kind: 'excerpt',
        title: f.record.title,
        text: d.text,
        provenance: p,
      };
      if (!this.persona.evidence.some((v) => v.id === e.id))
        this.persona.evidence.push(e);
      value = {
        ...this.excerpt(e),
        continuation: d.next_selector ?? null,
        truncated: !!d.truncated,
      };
    } else if (name === 'evidence_read') {
      const e =
        this.known.get(args.evidence_id) ??
        this.delivered.get(args.evidence_id) ??
        this.persona?.evidence.find((e) => e.id === args.evidence_id) ??
        this.full?.blocks.find((e) => e.id === args.evidence_id);
      if (!e)
        throw new AnalysisError('invalid_reference', '证据不在本次任务中。');
      value = this.excerpt(e, args.offset);
    } else if (name === 'report_read') {
      const content = args.component
        ? this.report?.[args.component]
        : this.report;
      if (!content)
        throw new AnalysisError('not_found', '没有对应的已有报告。');
      value = this.excerpt(
        {
          id: `report:${hash(content).slice(0, 20)}`,
          kind: 'analysis',
          text: JSON.stringify(content),
        },
        args.offset,
      );
    } else if (name === 'history_read') {
      const items = this.history.filter((h) =>
        match(JSON.stringify(h), args.query),
      );
      const content = JSON.stringify(items);
      value = this.excerpt(
        {
          id: `topic-history:${hash(content).slice(0, 20)}`,
          kind: 'history',
          text: content,
        },
        args.offset,
      );
    } else if (name === 'notes_read')
      value = this.excerpt(
        { id: 'task-notes', kind: 'notes', text: JSON.stringify(this.notes) },
        args.offset,
      );
    else if (name === 'notes_save') {
      if (
        typeof args.text !== 'string' ||
        args.text.length > 18000 ||
        typeof args.title !== 'string' ||
        args.title.length > 300
      )
        throw new AnalysisError('invalid_output', '笔记大小或格式无效。');
      this.notes.push({ title: args.title, text: args.text });
      value = { saved: true, id: this.notes.length - 1 };
    } else throw new AnalysisError('invalid_tool', '本任务没有此工具。');
    this.signal.throwIfAborted();
    if (name.startsWith('persona') || PERSONA_QUERY_NAMES.has(name))
      this.feedbackReplayResponses.push(structuredClone({
        name, args, value, persona: this.persona,
        evidence: this.evidence().filter(e => e.id.startsWith('persona:') && JSON.stringify(value).includes(e.id)),
      }));
    await this.onChange(this, name);
    return value;
  }
  evidence() {
    return [...this.delivered.values()];
  }
  paperForValidation() {
    return {
      ...this.paper,
      blocks: this.evidence().filter(
        (e) =>
          !e.id.startsWith('persona:') &&
          !['analysis', 'history', 'notes'].includes(e.kind),
      ),
      references: this.full?.references ?? [],
    };
  }
  coverage() {
    return {
      source: 'agent_selected',
      complete: false,
      selected_blocks: this.delivered.size,
      total_blocks: this.full?.blocks.length ?? null,
      issues: (this.full ?? this.paper).coverage?.issues ?? [],
      tools: this.reads,
      persona_revision: this.persona?.revision ?? null,
      persona_queries: this.queries?.context.retrieval ?? [],
      reading_version: PERSONA_READING_VERSION,
    };
  }
}

export function researchToolset({ personal = false, query = true } = {}) {
    return [
      tool('paper_get_metadata', 'Metadata and abstract of the fixed paper.'),
      tool('paper_get_outline', 'A page of section and content identifiers.', {
        offset,
      }),
      tool(
        'paper_read',
        'A slice of a section or content block. section_id may be all; offsets paginate text.',
        { section_id: text, offset },
        ['section_id'],
      ),
      tool(
        'paper_search',
        'Search the fixed paper; returns source excerpts and content identifiers.',
        { query: text, offset },
        ['query'],
      ),
      tool(
        'paper_references',
        'A page of references with source excerpts and known material matches.',
        { offset },
      ),
      tool(
        'paper_figures',
        'Available figure captions, table text, and source locations. Images are not interpreted by this text interface.',
        { offset },
      ),
      ...(personal
        ? query ? PERSONA_QUERY_TOOLS : [
            tool(
              'persona_search',
              'Search or list records in the selected scope. Empty query lists the scope.',
              { query: text, cursor: text, offset },
              [],
            ),
            tool(
              'persona_read_record',
              'A slice of an authorized record.',
              { record_id: text, offset },
              ['record_id'],
            ),
            tool(
              'persona_sources',
              'Source files for an authorized material record.',
              { record_id: text, cursor: text },
              ['record_id'],
            ),
            tool(
              'persona_search_source',
              'Search an issued source file; returns passage identifiers.',
              { file_id: text, query: text, cursor: text },
              ['file_id', 'query'],
            ),
            tool(
              'persona_read_source',
              'Read an issued passage, with optional continuation selector.',
              {
                passage_id: text,
                selector: { type: 'object', additionalProperties: true },
              },
              ['passage_id'],
            ),
          ]
        : []),
      tool(
        'evidence_read',
        'Read an evidence identifier belonging to this task.',
        { evidence_id: text, offset },
        ['evidence_id'],
      ),
      tool(
        'report_read',
        'A slice of the existing report or component; report text is prior analysis.',
        { component: text, offset },
      ),
      tool(
        'history_read',
        'Read or search this topic history, including earlier user constraints.',
        { query: text, offset },
      ),
      tool('notes_read', 'Read saved task notes.', { offset }),
      tool(
        'notes_save',
        'Save a task note; returns its identifier.',
        { title: text, text },
        ['title', 'text'],
      ),
    ];
  }
