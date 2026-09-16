import { usesEditableGoals } from '../prompts/context-policy.mjs';
import { runAgentWithContext } from '../prompts/agent-context.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { fingerprintInput, compositionRoots } from '../prompts/render-policy.mjs';
import { AnalysisError, hash, safeError } from '../analyses/contracts.mjs';
import { parseScreen, now } from './contracts.mjs';
import { storeScreeningInput } from '../evaluations/repository.mjs';
import { screenModelFingerprint } from './scheduler/source-check.mjs';
import { PersonaAgentTools } from '../persona/agent-tools.mjs';
import { PERSONA_QUERY_NAMES } from '@paper-radar/host-contract/persona-tools';
import {
  AGENT_SCREEN_VERSION,
  SCREEN_AGENT_PROMPT,
  SCREEN_READING_VERSION,
  SCREEN_TOOLS,
  LEGACY_SCREEN_TOOLS,
} from '@paper-radar/host-contract/agent-contract';

const PAGE_CHARS = 7000;
const sourceId = (r) => `persona:${r.id}:r${r.record_revision}`;
const clean = (v) =>
  typeof v === 'string' ? v.normalize('NFC').replace(/\r\n?/g, '\n').trim() : v;
const sorted = (a) =>
  [...new Set(a ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
export function screeningPromptFingerprint(snapshot, id = SCREEN_AGENT_PROMPT, subscription = {}) {
  const found = {};
  const visit = (key) => {
    if (found[key]) return;
    const v = snapshot?.versions?.[key];
    if (!v)
      throw new AnalysisError(
        'prompt_changed',
        '当前任务缺少初筛 Agent 提示词快照，请重新发起。',
      );
    found[key] = v.id;
    for (const match of Object.values(v.templates)
      .join('\n')
      .matchAll(/\{\{\s*@([\w.-]+)\s*\}\}/g))
      visit(match[1]);
  };
  compositionRoots(snapshot, id, { task: { input: subscription } }).forEach(visit);
  return hash(fingerprintInput(snapshot, found));
}
export function screeningKey(run, paper) {
  const c = run.context;
  return (
    'agent-screen:' +
    hash({
      schema: AGENT_SCREEN_VERSION,
      reading: SCREEN_READING_VERSION,
      subscription: run.subscription.id,
      paper: {
        id: paper.id,
        version: paper.version,
        title: clean(paper.title),
        abstract: clean(paper.abstract),
        authors: paper.authors,
        categories: sorted(paper.categories),
      },
      persona: {
        identity: c.identity,
        revision: c.revision,
        scope: { ...c.scope, tag_ids: sorted(c.scope.tag_ids) },
        ids: sorted(c.knowledge_ids),
        records: [...c.records].sort((a, b) => a.id.localeCompare(b.id)),
        coverage: c.coverage.complete_knowledge_scan,
      },
      language: run.subscription.language,
      strictness: run.subscription.recommendation_strictness ?? 'balanced',
      model: screenModelFingerprint(run.model_settings),
      prompts: screeningPromptFingerprint(run.prompt_snapshot, SCREEN_AGENT_PROMPT, run.subscription),
    })
  );
}

export function migrateAgentScreening(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 6) return;
  db.exec(`BEGIN;
    CREATE TABLE daily_screening_links (
      item_id TEXT PRIMARY KEY REFERENCES daily_items(id) ON DELETE CASCADE,
      version_id TEXT NOT NULL REFERENCES daily_item_versions(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX daily_screening_links_version ON daily_screening_links(version_id);
    CREATE TABLE daily_screening_claims (
      key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES daily_runs(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES daily_items(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL, status TEXT NOT NULL
    );
    PRAGMA user_version=6; COMMIT;`);
}

const resultSchema = z
  .object({
    schema: z.literal(AGENT_SCREEN_VERSION),
    paper_version: z.string(),
    decision: z.enum(['recommended', 'not_recommended', 'needs_review']),
    introduction: z.string().min(1).max(3000),
    reason: z.string().min(1).max(5000),
    criterion_ids: z.array(z.string()).min(1).max(10),
    paper_evidence_ids: z.array(z.string()).min(1).max(10),
    persona_evidence_ids: z.array(z.string()).max(50),
    persona_coverage_ref: z.string(),
    claims: z
      .array(
        z
          .object({
            record_id: z.string(),
            field: z.enum([
              'interest_level',
              'knowledge_level',
              'preference_level',
              'user_relationships',
            ]),
            value: z.string(),
          })
          .strict(),
      )
      .max(30),
    open_questions: z.array(z.string().min(1).max(1000)).max(8),
  })
  .strict();
const metadata = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([k]) => !['body', 'provenance', 'supporting_evidence'].includes(k),
    ),
  );
function validOffset(value, max) {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw new AnalysisError('invalid_cursor', '读取位置无效。');
  return n;
}
function covered(ranges, length) {
  let end = 0;
  for (const [a, b] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (a > end) return false;
    end = Math.max(end, b);
  }
  return end >= length;
}

// Per-paper read ledger, independent from the shared immutable Persona snapshot.
export class ScreeningEvidence {
  constructor(daily, run, item, signal, options = {}) {
    this.options = options;
    this.daily = daily;
    this.run = run;
    this.item = item;
    this.signal = signal;
    this.context = run.context.query_mode ? structuredClone(run.context) : run.context;
    if (this.context.query_mode) this.queries = new PersonaAgentTools({
      context: this.context,
      getRange: async () => {
        this.range ??= await daily.persona.scopeReader(run.subscription, signal, this.context.revision);
        return this.range;
      },
      replay: options.replay, transcript: options.frozenQueries,
      onUnavailable: options.onUnavailable,
    });
    this.records = this.context.records
      .filter((r) => this.context.knowledge_ids.includes(r.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    this.seen = new Set();
    this.detailRequired = new Set();
    this.recordRanges = new Map();
    this.sectionRanges = new Map();
    this.sectionsRead = new Set();
    this.tools = [];
    this.paperEvidence = new Map([
      [
        item.paper.evidence_id,
        {
          id: item.paper.evidence_id,
          title: item.paper.title,
          kind: 'abstract',
          text: item.paper.abstract,
          url: item.paper.url,
          paper_version: `${item.paper.id}v${item.paper.version}`,
        },
      ],
    ]);
    this.coverageRef = `coverage:${hash({ item: item.id, context: this.context.revision, scope: this.context.scope }).slice(0, 32)}`;
    this.validationErrors = 0;
    this.result = null;
  }
  coverage() {
    return {
      source_ref: this.coverageRef,
      total_records: this.records.length,
      delivered_records: this.seen.size,
      complete:
        this.seen.size === this.records.length && !this.detailRequired.size,
      detail_required: [...this.detailRequired],
      paper_sections: [...this.sectionsRead],
      paper_evidence_ids: [...this.paperEvidence.keys()],
      source_issues: this.paperReadError
        ? [safeError(this.paperReadError)]
        : [],
      ...(this.queries ? {
        total_records: null, delivered_records: this.context.records.filter(r => r.entity_type !== 'relation').length, complete: false,
        queries: this.context.retrieval, source: 'agent_selected',
      } : {}),
    };
  }
  toolset() {
    const tools = this.queries ? SCREEN_TOOLS : LEGACY_SCREEN_TOOLS;
    if (!usesEditableGoals(this.run.prompt_snapshot)) return tools;
    const { $schema: _schema, ...parameters } = z.toJSONSchema(resultSchema);
    return tools.map((tool) => tool.name === 'screening_submit_result' ? { ...tool, parameters } : tool);
  }
  saveProgress(phase) {
    this.signal.throwIfAborted();
    if (this.options.replay || this.options.evaluation) return;
    const item = this.daily.repo.get('daily_items', this.item.id);
    if (this.daily.repo.get('daily_runs', item.run_id).status !== 'running')
      throw new AnalysisError('cancelled', '日报已停止。');
    item.agent_progress = {
      phase,
      at: now(),
      coverage: this.coverage(),
      tools: this.tools.slice(-30),
      session_id: item.agent_progress?.session_id,
      validation_error: this.lastValidationError ?? null,
    };
    this.daily.repo.saveItem(item);
  }
  page(offset = 0) {
    offset = validOffset(offset, this.records.length);
    const cards = [];
    let size = 0,
      index = offset;
    while (index < this.records.length && cards.length < 8) {
      const r = this.records[index],
        full = metadata(r),
        text = JSON.stringify(full);
      const card =
        text.length > 2400
          ? {
              id: r.id,
              title: String(r.title ?? '').slice(0, 800),
              entity_type: r.entity_type,
              record_revision: r.record_revision,
              detail_required: true,
            }
          : full;
      const sourced = { ...card, source_ref: sourceId(r) },
        len = JSON.stringify(sourced).length;
      if (cards.length && size + len > PAGE_CHARS) break;
      size += len;
      cards.push(sourced);
      this.seen.add(r.id);
      if (
        card.detail_required &&
        !covered(this.recordRanges.get(r.id) ?? [], text.length)
      )
        this.detailRequired.add(r.id);
      index++;
    }
    return {
      source_ref: this.coverageRef,
      records: cards,
      next_offset: index < this.records.length ? index : null,
      coverage: this.coverage(),
    };
  }
  initial() {
    const scopePage = this.page();
    return {
      task: {
        type: 'daily_screen',
        ...(!usesEditableGoals(this.run.prompt_snapshot) ? { goal: '判断本篇是否值得用户进一步阅读' } : {}),
        source_ref: `contract:${AGENT_SCREEN_VERSION}`,
      },
      criteria: {
        ids: ['selected-knowledge', 'strictness'],
        strictness:
          this.run.subscription.recommendation_strictness ?? 'balanced',
        scope: this.context.scope,
        source_ref: `subscription:${this.run.subscription.id}:r${this.run.subscription.revision}`,
      },
      persona: scopePage,
      paper: this.paperMetadata(),
      output: {
        schema: AGENT_SCREEN_VERSION,
        language: this.run.subscription.language,
        source_ref: `subscription:${this.run.subscription.id}:r${this.run.subscription.revision}`,
      },
    };
  }
  paperMetadata() {
    const p = this.item.paper;
    return {
      id: p.id,
      version: `${p.id}v${p.version}`,
      paper_version: `${p.id}v${p.version}`,
      title: p.title,
      abstract: p.abstract,
      authors: p.authors,
      categories: p.categories,
      url: p.url,
      source_ref: p.evidence_id,
    };
  }
  async fullPaper() {
    if (!this.paperLoading)
      this.paperLoading = Promise.resolve().then(() => {
          if (!this.options.replay) return this.daily.analyses.arxiv.get(this.item.paper.url, this.signal);
          if (this.options.frozenPaper) return structuredClone(this.options.frozenPaper);
          this.options.onUnavailable?.();
          throw new AnalysisError("input_unavailable", "原始运行未保存全文，固定回放不能在线补读。", false);
        })
        .then((paper) => {
          if (
            paper.id !== this.item.paper.id ||
            paper.version !== this.item.paper.version
          )
            throw new AnalysisError(
              'source_changed',
              '补读论文版本与初筛版本不一致。',
            );
          const groups = [];
          for (const block of paper.blocks) {
            const title = block.section ?? '正文';
            let group = groups.at(-1);
            if (!group || group.title !== title) {
              group = { id: `section-${groups.length}`, title, blocks: [] };
              groups.push(group);
            }
            group.blocks.push(block);
          }
          this.paper = paper;
          this.sections = groups;
          this.paperReadError = null;
          return paper;
        })
        .catch((e) => {
          this.paperLoading = null;
          this.paperReadError = e;
          throw e;
        });
    return this.paperLoading;
  }
  async call(name, args = {}) {
    this.signal.throwIfAborted();
    this.tools.push({ name, at: now() });
    let value;
    if (PERSONA_QUERY_NAMES.has(name) && this.queries) value = await this.queries.call(name, args);
    else if (name === 'persona_list_scope') value = this.page(args.offset);
    else if (name === 'persona_read_record') {
      const r = this.records.find((r) => r.id === args.record_id);
      if (!r || !['screening', 'body'].includes(args.view))
        throw new AnalysisError(
          'invalid_reference',
          '知识条目不在本次范围内。',
        );
      const text =
        args.view === 'body'
          ? String(r.body ?? '')
          : JSON.stringify(metadata(r));
      const offset = validOffset(args.offset, text.length),
        end = Math.min(text.length, offset + PAGE_CHARS);
      if (args.view === 'screening') {
        const ranges = this.recordRanges.get(r.id) ?? [];
        ranges.push([offset, end]);
        this.recordRanges.set(r.id, ranges);
        this.seen.add(r.id);
        if (covered(ranges, text.length)) this.detailRequired.delete(r.id);
        else this.detailRequired.add(r.id);
      }
      value = {
        source_ref: sourceId(r),
        record_id: r.id,
        view: args.view,
        text: text.slice(offset, end),
        offset,
        next_offset: end < text.length ? end : null,
        coverage: this.coverage(),
      };
    } else if (name === 'paper_get_metadata') value = this.paperMetadata();
    else if (name === 'paper_get_outline') {
      await this.fullPaper();
      const offset = validOffset(args.offset, this.sections.length),
        end = Math.min(offset + 25, this.sections.length);
      value = {
        source_ref: `paper:${this.paper.id}v${this.paper.version}:${this.paper.source_hash}`,
        sections: this.sections
          .slice(offset, end)
          .map(({ id, title, blocks }) => ({
            id,
            title,
            blocks: blocks.length,
          })),
        next_offset: end < this.sections.length ? end : null,
        coverage: this.paper.coverage,
      };
    } else if (name === 'paper_read_section') {
      await this.fullPaper();
      const section = this.sections.find((s) => s.id === args.section_id);
      if (!section)
        throw new AnalysisError('invalid_reference', '论文章节不存在。');
      this.sectionsRead.add(section.id);
      const text = section.blocks.map((b) => `[${b.id}] ${b.text}`).join('\n');
      const offset = validOffset(args.offset, text.length),
        end = Math.min(offset + PAGE_CHARS, text.length);
      const id = `paper:${this.paper.id}v${this.paper.version}:${this.paper.source_hash}:${section.id}:${offset}`;
      const evidence = {
        id,
        title: section.title,
        kind: 'excerpt',
        text: text.slice(offset, end),
        url: this.item.paper.url,
        source_hash: this.paper.source_hash,
        paper_version: `${this.paper.id}v${this.paper.version}`,
        locator: { section: section.title, offset, end },
      };
      this.paperEvidence.set(id, evidence);
      const ranges = this.sectionRanges.get(section.id) ?? [];
      ranges.push([offset, end]);
      this.sectionRanges.set(section.id, ranges);
      value = {
        ...evidence,
        source_ref: id,
        next_offset: end < text.length ? end : null,
        section_complete: covered(ranges, text.length),
      };
    } else if (name === 'screening_submit_result') {
      try {
        this.result = this.validate(args);
        value = { recorded: true };
      } catch (e) {
        this.validationErrors++;
        this.lastValidationError = safeError(e);
        this.saveProgress('validating');
        throw e;
      }
    } else throw new AnalysisError('invalid_tool', '本任务未开放此工具。');
    this.saveProgress(
      name === 'screening_submit_result'
        ? 'validating'
        : name.startsWith('persona') || PERSONA_QUERY_NAMES.has(name)
          ? 'reading_knowledge'
          : 'reading_paper',
    );
    return value;
  }
  validate(raw) {
    const parsed = resultSchema.safeParse(raw);
    if (!parsed.success)
      throw new AnalysisError(
        'invalid_output',
        '初筛字段格式无效：' +
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')
            .slice(0, 1800),
        true,
      );
    const v = parsed.data;
    const expectedVersion = `${this.item.paper.id}v${this.item.paper.version}`;
    if (v.paper_version !== expectedVersion)
      throw new AnalysisError(
        'invalid_reference',
        `paper_version 必须是 ${expectedVersion}。`,
        true,
      );
    if (v.paper_evidence_ids.some((id) => !this.paperEvidence.has(id)))
      throw new AnalysisError(
        'invalid_reference',
        'paper_evidence_ids 必须使用已提供的 source_ref：' +
          [...this.paperEvidence.keys()].join(', '),
        true,
      );
    const personaRefs = new Set(
      this.records.filter((r) => this.seen.has(r.id)).map(sourceId),
    );
    for (const id of this.queries?.delivered.keys() ?? []) personaRefs.add(id);
    if (v.persona_evidence_ids.some((id) => !personaRefs.has(id)))
      throw new AnalysisError(
        'invalid_reference',
        'persona_evidence_ids 只能使用已返回的 source_ref 或 citation_ref。',
        true,
      );
    if (
      v.criterion_ids.some(
        (id) => !['selected-knowledge', 'strictness'].includes(id),
      ) ||
      v.persona_coverage_ref !== this.coverageRef
    )
      throw new AnalysisError(
        'invalid_reference',
        '筛选标准或覆盖引用无效。',
        true,
      );
    if (v.decision === 'needs_review' && !v.open_questions.length)
      throw new AnalysisError(
        'invalid_output',
        '待确认判断需要列出具体未解决问题。',
        true,
      );
    const legacy = {
      paper_version: v.paper_version,
      outcome: v.decision === 'needs_review' ? 'needs_fulltext' : v.decision,
      introduction: v.introduction,
      reason: v.reason,
      paper_evidence_ids: v.paper_evidence_ids,
      persona_evidence_ids: v.persona_evidence_ids,
      claims: v.claims,
      questions_for_fulltext: v.open_questions,
    };
    return {
      ...parseScreen(JSON.stringify(legacy), this.item.paper, this.context, {
        paperEvidenceIds: [...this.paperEvidence.keys()],
        requireCompleteKnowledge: !this.queries,
      }),
      agent_result: v,
    };
  }
}

export async function screenWithAgent(daily, run, item, signal) {
  const repo = daily.repo,
    context = run.context;
  if (
    !context || (!context.query_mode && (!context.coverage.complete_knowledge_scan || !context.knowledge_ids?.length))
  )
    throw new AnalysisError(
      'insufficient_context',
      '尚未取得完整所选知识点。',
      true,
    );
  const key = screeningKey(run, item.paper),
    attemptId = randomUUID();
  const force = run.force_regenerate || item.rescreen_requested;
  let reused, waiting, activeClaim;
  do {
    signal.throwIfAborted();
    activeClaim = false;
    repo.analysisDb.transaction(() => {
      const ref = !force && daily.analyses.db.cache(key);
      const version =
        ref && repo.get('daily_item_versions', ref.version_id, false);
      if (
        version?.schema_version === AGENT_SCREEN_VERSION &&
        ['recommended', 'not_recommended'].includes(version.data.outcome) &&
        version.evidence?.length &&
        version.cache_key === key
      ) {
        reused = version;
        return;
      }
      const claim = repo.db
        .prepare('SELECT * FROM daily_screening_claims WHERE key=?')
        .get(key);
      if (claim?.status === 'running') {
        activeClaim = true;
        return;
      }
      if (
        !force &&
        claim &&
        claim.item_id !== item.id &&
        ['failed', 'interrupted', 'cancelled', 'needs_review'].includes(
          claim.status,
        )
      ) {
        waiting = claim;
        return;
      }
      if (force) repo.db.prepare('DELETE FROM cache WHERE key=?').run(key);
      repo.db
        .prepare(
          'INSERT INTO daily_screening_claims VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET run_id=excluded.run_id,item_id=excluded.item_id,attempt_id=excluded.attempt_id,status=excluded.status',
        )
        .run(key, run.id, item.id, attemptId, 'running');
    });
    if (activeClaim) await delay(300, undefined, { signal });
  } while (activeClaim);
  const attach = (version, cacheHit) => {
    signal.throwIfAborted();
    if (repo.get('daily_runs', run.id).status !== 'running')
      throw new AnalysisError('cancelled', '日报已停止。');
    const latest = repo.get('daily_items', item.id);
    repo.db
      .prepare(
        'INSERT INTO daily_screening_links VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET version_id=excluded.version_id',
      )
      .run(item.id, version.id);
    latest.screening_version_id = version.id;
    if (!latest.published_analysis_id) latest.current_version_id = version.id;
    latest.final_decision =
      version.data.outcome === 'needs_fulltext' ? null : version.data.outcome;
    latest.decision_basis = version.reading_coverage?.paper_sections.length
      ? 'selected_sections'
      : 'abstract';
    latest.processing_status = 'completed';
    latest.error = null;
    latest.rescreen_requested = false;
    latest.screening_reuse = {
      reused: cacheHit,
      version_id: version.id,
      generated_at: version.created_at,
      linked_at: now(),
      reason: cacheHit
        ? 'same_screening_inputs'
        : force
          ? 'explicit_rescreen'
          : 'new_screening_inputs',
    };
    repo.saveItem(latest);
  };
  if (reused) {
    repo.analysisDb.transaction(() => attach(reused, true));
    return;
  }
  if (waiting) {
    const latest = repo.get('daily_items', item.id);
    Object.assign(latest, {
      processing_status: 'failed',
      execution_policy: 'manual_resume_required',
      previous_item_id: waiting.item_id,
      error: {
        code: 'manual_resume_required',
        message: '相同依据下已有未完成判断，请明确重试或进一步阅读。',
        retryable: true,
      },
    });
    repo.saveItem(latest);
    return;
  }
  const reservations = new Map();
  try {
    let reader = new ScreeningEvidence(daily, run, item, signal);
    const task = reader.initial(),
      variables = {
        task: JSON.stringify(task),
        recommendation_strictness:
          run.subscription.recommendation_strictness ?? 'balanced',
      };
    const prepared = daily.analyses.prompts.preview(
      SCREEN_AGENT_PROMPT,
      variables,
      { snapshot: run.prompt_snapshot },
    );
    const capture = daily.analyses.prompts.capture(
      SCREEN_AGENT_PROMPT,
      variables,
      run.prompt_snapshot,
      {
        paper: item.paper,
        persona_scope: context.scope,
        persona: context,
        subscription: run.subscription,
      },
      run.id,
    );
    reader.saveProgress('reading_knowledge');
    const executed = await executeScreeningAgent({
      models: daily.models, prepared, signal, settings: run.model_settings,
      taskId: run.id, reader, store: daily.analyses.prompts, captureId: capture.id,
      createReader: () => new ScreeningEvidence(daily, run, item, signal),
      hooks: {
        beforeAttempt: (c, attempt) => {
          signal.throwIfAborted();
          if (run.origin?.kind === 'scheduled') {
            if (!daily.scheduler)
              throw new AnalysisError('unavailable', '自动日报服务不可用。');
            reservations.set(
              attempt.id,
              daily.scheduler.repo.reserve(run, item, attempt),
            );
          } else repo.reserve(run.id);
        },
        onAttempt: (attempt) => {
          if (reservations.has(attempt.id))
            daily.scheduler.repo.record(reservations.get(attempt.id));
          repo.attempt(run.id, {
            ...attempt,
            item_id: item.id,
            phase: 'screen_agent',
            prompt_versions: prepared.versions,
            prompt_capture_id: capture.id,
          });
        },
        onProgress: (progress) => {
          const latest = repo.get('daily_items', item.id);
          latest.agent_progress = {
            ...latest.agent_progress,
            session_id: progress.session_id,
            step: progress.step ?? latest.agent_progress?.step,
          };
          repo.saveItem(latest);
        },
      },
    });
    const result = executed.result;
    reader = executed.reader;
    signal.throwIfAborted();
    const data = reader.validate(result.data);
    repo.analysisDb.transaction(() => {
      const claim = repo.db
        .prepare('SELECT * FROM daily_screening_claims WHERE key=?')
        .get(key);
      if (
        claim?.attempt_id !== attemptId ||
        claim.status !== 'running' ||
        repo.get('daily_runs', run.id).status !== 'running'
      )
        throw new AnalysisError('cancelled', '该初筛尝试已失效。');
      const latest = repo.get('daily_items', item.id),
        oldCurrent = latest.published_analysis_id
          ? latest.current_version_id
          : null;
      const input = storeScreeningInput(repo.db, {
        schema: "paper-radar.screening-input/v1",
        workflow: AGENT_SCREEN_VERSION, reading: SCREEN_READING_VERSION,
        item: { id: item.id, paper: item.paper },
        subscription: run.subscription, context, variables,
        prompt: prepared, full_paper: reader.paper ?? null,
        persona_queries: reader.queries?.transcript ?? [],
        captured_at: now(),
      });
      const version = repo.addVersion(latest, {
        input_snapshot_id: input.id,
        kind: 'screening',
        schema_version: AGENT_SCREEN_VERSION,
        data,
        cache_key: key,
        cache_hit: false,
        scope: context.scope,
        persona_identity: context.identity,
        persona_revision: context.revision,
        model: {
          provider_id: result.providerId,
          model_id: result.modelId,
          reasoning_effort: result.reasoningEffort,
          request_id: result.requestId,
          session_id: result.sessionId,
          runtime_id: result.runtimeId,
          fallback_from: result.fallbackFrom ?? null,
        },
        reading_coverage: reader.coverage(),
        evidence: [...reader.paperEvidence.values()]
          .filter((e) => data.paper_evidence_ids.includes(e.id))
          .concat(
            reader.context.evidence.filter((e) =>
              data.persona_evidence_ids.includes(e.id),
            ),
          ),
      });
      if (oldCurrent) {
        latest.current_version_id = oldCurrent;
        repo.saveItem(latest);
      }
      attach(version, false);
      const reusable = ['recommended', 'not_recommended'].includes(
        data.outcome,
      );
      if (reusable)
        daily.analyses.db.putCache(key, 'agent-screen-reference', {
          version_id: version.id,
        });
      else repo.db.prepare('DELETE FROM cache WHERE key=?').run(key);
      repo.db
        .prepare(
          'UPDATE daily_screening_claims SET status=? WHERE key=? AND attempt_id=?',
        )
        .run(reusable ? 'completed' : 'needs_review', key, attemptId);
    });
  } catch (e) {
    repo.db
      .prepare(
        'UPDATE daily_screening_claims SET status=? WHERE key=? AND attempt_id=?',
      )
      .run(signal.aborted ? 'interrupted' : 'failed', key, attemptId);
    throw e;
  }
}

// Shared isolated execution protocol. Production and benchmark use the same tool
// reader, host, validation and host-limited repair loop; only persistence differs.
export async function executeScreeningAgent({ models, prepared, signal, settings,
  taskId, reader, createReader, hooks = {}, maxTokens = 8192, store, captureId, experiment = false }) {
  let current = reader;
  const request = {
    task: 'screen', tools: reader.toolset(), submitTool: 'screening_submit_result',
    systemPrompt: prepared.rendered.system, prompt: prepared.rendered.user,
    maxTokens, businessTask: taskId, experiment,
  };
  const options = {
    ...hooks, signal, settings,
    onRestart: () => { current = createReader(); current.initial(); hooks.onRestart?.(); },
    onTool: (name, args) => current.call(name, args),
  };
  const result = store ? await runAgentWithContext({ store, models, request, options, prepared, captureId, origin: taskId, experiment }) : await models.runAgent(request, options);
  signal.throwIfAborted();
  return { result, reader: current, data: current.validate(result.data) };
}
