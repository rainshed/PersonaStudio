import {
  PERSONA_QUERY_NAMES,
  personaArguments,
} from '@paper-radar/host-contract/persona-tools';
import { toolTextValue } from '@paper-radar/host-contract/tool-content';
import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { sameScope, protocolError } from './query-client.mjs';

const facts = [
  'interest_level',
  'knowledge_level',
  'preference_level',
  'user_relationships',
];
const citation = (r) => `persona:${r.id}:r${r.record_revision}`;
const clean = (value) => JSON.parse(JSON.stringify(value));
export function emptyQueryContext(range, identity) {
  return {
    schema_version: 'paper-radar.persona-context/v2',
    query_mode: 'on-demand/v1',
    identity,
    revision: range.revision,
    scope: range.scope,
    tags: range.tags,
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
}

// One scoped query adapter and evidence ledger for screening, analysis and
// discussion. Frozen replay only serves captured responses, never live data.
export class PersonaAgentTools {
  constructor({
    context,
    getRange,
    onEvidence = () => {},
    replay = false,
    transcript = [],
    onUnavailable = () => {},
  }) {
    Object.assign(this, {
      context,
      getRange,
      onEvidence,
      replay,
      onUnavailable,
    });
    this.transcript = [];
    this.frozen = transcript;
    this.delivered = new Map();
    this.fileHashes = new Map();
  }
  has(name) {
    return PERSONA_QUERY_NAMES.has(name);
  }
  async call(name, input = {}) {
    const args = personaArguments(name, input);
    let result;
    if (this.replay) {
      const entry = this.frozen.find(
        (e) => e.name === name && hash(e.arguments) === hash(args),
      );
      if (!entry) {
        this.onUnavailable();
        throw new AnalysisError(
          'input_unavailable',
          '原始运行没有保存这项查询的结果；固定回放不能读取当前 Persona。',
          false,
        );
      }
      if (entry.error)
        throw new AnalysisError(
          entry.error.code,
          entry.error.message,
          entry.error.retryable,
        );
      result = structuredClone(entry.result);
    } else {
      try {
        const range = await this.getRange();
        if (!range)
          throw new AnalysisError(
            'persona_unavailable',
            '当前 Persona 连接没有提供查询接口。',
          );
        result = await range.scoped(name, args);
      } catch (error) {
        this.transcript.push({
          name,
          arguments: args,
          error: {
            code: error.code ?? 'query_unavailable',
            message: error.message,
            retryable: !!error.retryable,
          },
        });
        throw error;
      }
    }
    if (!result?.ok || result.tool !== name || !result.data)
      throw protocolError();
    if (!sameScope(result.scope, this.context.scope))
      throw new AnalysisError('out_of_scope', '查询结果不属于所选范围。');
    if (result.persona_revision !== this.context.revision)
      throw new AnalysisError(
        'version_changed',
        '查询结果的 Persona 版本已变化。',
      );
    this.transcript.push(clean({ name, arguments: args, result }));
    // A rejected response never becomes evidence the model is deemed to have read.
    const staged = new PersonaAgentTools({
      context: structuredClone(this.context),
    });
    staged.delivered = new Map(this.delivered);
    staged.fileHashes = new Map(this.fileHashes);
    const value = staged.decorate(name, args, result);
    Object.assign(this.context, staged.context);
    this.delivered = staged.delivered;
    this.fileHashes = staged.fileHashes;
    for (const evidence of this.delivered.values()) this.onEvidence(evidence);
    return value;
  }
  decorate(name, args, result) {
    const value = structuredClone(result);
    const queryRef = `persona:query:${hash({ name, args, revision: result.persona_revision, scope: result.scope, data: toolTextValue(result).data }).slice(0, 32)}`;
    value.source_ref = queryRef;
    for (const domain of value.data.domains ?? []) domain.source_ref = queryRef;
    for (const node of value.data.nodes ?? []) this.record(node, node);
    for (const edge of value.data.edges ?? [])
      this.record({ ...edge, entity_type: 'relation' }, edge);
    for (const hit of value.data.hits ?? []) {
      const record = this.context.records.find((r) => r.id === hit.id);
      if (record && this.delivered.has(citation(record)))
        hit.citation_ref = citation(record);
    }
    for (const item of value.data.items ?? []) {
      if (!args.record_ids?.includes(item.id)) throw protocolError();
      if (item.error) continue;
      const record = {
        ...item.record,
        id: item.id,
        entity_type: item.entity_type,
        record_revision: item.record_revision,
        provenance: item.provenance,
      };
      if (item.body != null) record.body = item.body;
      // Field continuation is kept as a fragment, not mistaken for a full field.
      this.record(
        record,
        item,
        item.field
          ? {
              field: item.field,
              value: item.value,
              offset: item.offset,
              total_chars: item.total_chars,
            }
          : null,
      );
      for (const evidence of item.evidence ?? []) {
        if (evidence.id && evidence.provenance?.record_revision)
          evidence.citation_ref = citation({
            id: evidence.id,
            record_revision: evidence.provenance.record_revision,
          });
      }
    }
    if (name === 'list_source_files') {
      for (const entry of value.data.entries ?? []) {
        if (entry.kind === 'file')
          this.fileVersion(
            value.data.source_id,
            entry.file_id,
            entry.file_hash,
          );
        entry.source_ref = queryRef;
      }
    }
    for (const part of [
      ...(value.data.matches ?? []),
      ...(value.data.excerpts ?? []),
    ]) {
      if (
        name === 'search_source_content' &&
        ((args.files &&
          !args.files.some(
            (f) =>
              f.source_id === part.file_ref?.source_id &&
              f.file_id === part.file_ref?.file_id,
          )) ||
          (args.source_ids &&
            !args.source_ids.includes(part.file_ref?.source_id)))
      )
        throw new AnalysisError('source_changed', '检索结果不属于指定来源。');
      this.source(part);
    }
    if (name === 'read_source') {
      if (
        args.file_id &&
        (args.file_id !== value.data.file_ref?.file_id ||
          args.source_id !== value.data.file_ref?.source_id)
      )
        throw new AnalysisError('source_changed', '返回内容不属于指定文件。');
      this.source(value.data);
      for (const part of value.data.images ?? []) this.source(part);
    }
    this.evidence({
      id: queryRef,
      title: name,
      kind: 'query',
      text: JSON.stringify({
        query: args,
        scope: result.scope,
        persona_revision: result.persona_revision,
        coverage: result.coverage,
        warnings: result.warnings,
        next_cursor: result.next_cursor,
      }),
      provenance: {
        kind: 'query',
        tool: name,
        persona_revision: result.persona_revision,
      },
    });
    this.context.retrieval.push({
      tool: name,
      arguments: args,
      source_ref: queryRef,
      coverage: result.coverage,
      next_cursor: result.next_cursor,
    });
    return value;
  }
  evidence(e) {
    const prior = this.delivered.get(e.id);
    const merged =
      prior && e.kind === 'record'
        ? {
            ...e,
            text: prior.text === e.text ? e.text : prior.text + '\n' + e.text,
            fact_fields: { ...prior.fact_fields, ...e.fact_fields },
          }
        : e;
    this.delivered.set(e.id, merged);
    const at = this.context.evidence.findIndex((v) => v.id === e.id);
    if (at < 0) this.context.evidence.push(merged);
    else this.context.evidence[at] = merged;
    this.onEvidence(merged);
  }
  record(record, returned, fragment = null) {
    const p = record.provenance;
    if (
      record.entity_type &&
      !['knowledge_node', 'course', 'material', 'relation'].includes(
        record.entity_type,
      )
    )
      throw protocolError();
    if (
      !record.id ||
      !Number.isInteger(record.record_revision) ||
      p?.kind !== 'record' ||
      p.record_id !== record.id ||
      p.record_revision !== record.record_revision
    )
      throw protocolError();
    if (Array.isArray(record.tags)) {
      const scope = this.context.scope;
      if (
        !(scope.tag_match === 'all'
          ? scope.tag_ids.every((id) => record.tags.includes(id))
          : scope.tag_ids.some((id) => record.tags.includes(id)))
      )
        throw new AnalysisError('out_of_scope', '记录不属于所选标签范围。');
    }
    const current = this.context.records.find((r) => r.id === record.id);
    if (current && current.record_revision !== record.record_revision)
      throw new AnalysisError('source_changed', '记录版本已变化。');
    const actual = clean(record);
    if (fragment) delete actual[fragment.field];
    if (current) Object.assign(current, actual);
    else this.context.records.push(actual);
    if (
      record.entity_type === 'knowledge_node' &&
      !this.context.knowledge_ids.includes(record.id)
    )
      this.context.knowledge_ids.push(record.id);
    if (
      record.entity_type === 'relation' &&
      !this.context.relations.some((r) => r.id === record.id)
    )
      this.context.relations.push(actual);
    returned.citation_ref = citation(record);
    const personal = Object.fromEntries(
      facts.filter((k) => Object.hasOwn(actual, k)).map((k) => [k, actual[k]]),
    );
    this.evidence({
      id: citation(record),
      record_id: record.id,
      record_revision: record.record_revision,
      kind: 'record',
      title: record.title ?? current?.title ?? record.id,
      text: JSON.stringify(fragment ? { ...actual, fragment } : actual),
      fact_fields: personal,
      provenance: p,
    });
  }
  fileVersion(source, file, version) {
    if (!source || !file || !version) return;
    const key = `${source}:${file}`,
      prior = this.fileHashes.get(key);
    if (prior && prior !== version)
      throw new AnalysisError('source_changed', '来源文件版本已变化。');
    this.fileHashes.set(key, version);
  }
  source(part) {
    const p = part.provenance;
    if (!p || !p.source_id || !p.file_id || !p.file_hash || !p.locator) return;
    if (
      part.file_ref &&
      (part.file_ref.source_id !== p.source_id ||
        part.file_ref.file_id !== p.file_id)
    )
      throw protocolError();
    this.fileVersion(p.source_id, p.file_id, p.file_hash);
    const owner = this.context.records.find(
      (r) => r.entity_type === 'material' && r.source_ref === p.source_id,
    );
    const view = part.view ?? (part.rendered_size ? 'image' : 'text');
    const id = `persona:source:${hash({ provenance: p, view }).slice(0, 32)}`;
    part.citation_ref = id;
    this.evidence({
      id,
      ...(owner
        ? { record_id: owner.id, record_revision: owner.record_revision }
        : {}),
      kind: view === 'image' ? 'image' : 'excerpt',
      title: owner?.title ?? part.file_ref?.relative_path ?? p.file_id,
      text: typeof part.text === 'string' ? part.text : JSON.stringify(part),
      provenance: p,
      source_id: p.source_id,
      file_id: p.file_id,
      file_hash: p.file_hash,
      locator: p.locator,
      ...(p.locator.pages ? { pages: p.locator.pages } : {}),
      ...(p.locator.lines?.start
        ? { lines: [p.locator.lines.start, p.locator.lines.end] }
        : {}),
    });
  }
}
