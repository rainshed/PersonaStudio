import { tagScopeKey } from './current-input.mjs';
import { hash } from '../analyses/contracts.mjs';
import {
  EvaluationRepository,
  identifier,
  stamp,
  storeScreeningInput,
} from './repository.mjs';
import { binary, expectedOutcome } from './scoring.mjs';
import { fail } from './errors.mjs';
const subjectKey = (id) => `daily_screening:${id}:accuracy`;
const interestScope = (source) => {
  const settings = source.subscription ?? {};
  return {
    persona: source.persona_identity ?? settings.persona_connection_id ?? null,
    scope: {
      tag_ids: [...new Set(settings.scope?.tag_ids ?? [])].sort((a, b) =>
        a.localeCompare(b),
      ),
      tag_match: settings.scope?.tag_match ?? 'any',
    },
  };
};
export const datasetKey = (source) =>
  'recommendation:' +
  hash({
    paper: source.paper.id.replace(/v\d+$/, ''),
    ...interestScope(source),
  });
const scopeName = (tags, settings) =>
  tags?.map((t) => t.label ?? t.name ?? t.id).join('、') ||
  settings.scope?.tag_ids?.join('、') ||
  '未选择兴趣范围';

/** Explicit feedback, immutable case revisions, frozen suites and local backup.
 * This layer never reads live evidence or invokes a model. */
export class EvaluationCases {
  constructor(daily) {
    this.daily = daily;
    this.repo = new EvaluationRepository(daily.analyses.db);
  }
  source(id) {
    const version = this.daily.repo.get('daily_item_versions', id, false);
    if (version?.analysis_id) return this.source(version.analysis_id);
    const result = this.daily.analyses.db.result(id);
    let source;
    if (result) {
      if (
        result.personalization?.status !== 'available' ||
        !binary(result.personalization.data?.decision)
      )
        fail('ineligible', '只有已完成的推荐或不推荐判断可以加入测试集。');
      const settings = result.settings_snapshot;
      source = {
        scope_name: scopeName(result.persona?.tags, settings),
        kind: 'analysis',
        version_id: id,
        job_id: result.job_id,
        original_outcome: result.personalization.data.decision,
        original_result: result.personalization.data,
        input_snapshot_id: result.input_snapshot_id ?? null,
        paper: result.paper,
        persona_identity:
          result.persona?.identity ?? settings.persona_connection_id,
        subscription_id: '',
        subscription: {
          ...settings,
          name:
            result.persona?.tags
              ?.map((t) => t.label ?? t.name ?? t.id)
              .join('、') || '单篇分析',
        },
        date: result.created_at.slice(0, 10),
        original_model: result.personalization.model,
      };
    } else if (version) {
      if (version.kind !== 'screening' || !binary(version.data?.outcome))
        fail('ineligible', '只有已完成的推荐或不推荐判断可以加入测试集。');
      const item = this.daily.repo.get('daily_items', version.item_id);
      const run = this.daily.repo.get('daily_runs', item.run_id);
      source = {
        scope_name: scopeName(run.context?.tags, run.subscription),
        kind: 'screening',
        version_id: id,
        original_outcome: version.data.outcome,
        original_result: version.data,
        input_snapshot_id: version.input_snapshot_id ?? null,
        paper: item.paper,
        persona_identity: version.persona_identity ?? run.context?.identity,
        subscription_id: run.subscription.id,
        subscription: run.subscription,
        run_id: run.id,
        item_id: item.id,
        date: run.date,
        original_model: version.model,
      };
    } else {
      const existing = this.cases().find(
        (c) => c.source.version_id === id || c.subject_versions?.includes(id),
      );
      if (existing) return { ...existing.source, existing };
      fail('not_found', '推荐判断不存在。', 404);
    }
    const existing = this.cases()
      .filter((c) => datasetKey(c.source) === datasetKey(source))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return { ...source, existing };
  }
  feedbackFor(id) {
    try {
      const source = this.source(id),
        c = source.existing;
      if (c?.state !== 'active') return {};
      return {
        accuracy: {
          value:
            c.expected_outcome === source.original_outcome
              ? 'positive'
              : 'negative',
          reason: c.feedback?.reason ?? '',
          updatedAt: c.updated_at,
          case_id: c.id,
          feedback_revision: c.feedback_revision,
          expected_outcome: c.expected_outcome,
          replay_status: c.replay_status,
        },
      };
    } catch (e) {
      if (['ineligible', 'not_found'].includes(e.code)) return {};
      throw e;
    }
  }
  dataset() {
    const latest = new Map();
    for (const c of this.cases().sort((a, b) =>
      b.updated_at.localeCompare(a.updated_at),
    ))
      if (!latest.has(datasetKey(c.source)))
        latest.set(datasetKey(c.source), c);
    return [...latest.values()]
      .filter((c) => c.state === 'active')
      .map((c) => ({
        ...c,
        source: {
          ...c.source,
          scope_key: tagScopeKey(c.source),
          scope_name:
            c.source.scope_name ?? scopeName(null, c.source.subscription),
        },
      }));
  }
  datasetSuite(scopeKey) {
    const cases = this.dataset().filter(
      (c) => !scopeKey || c.source.scope_key === scopeKey,
    );
    return {
      id: 'dataset',
      scope_key: scopeKey ?? null,
      name: '我的推荐测试集',
      automatic: true,
      members: cases.map((c) => ({
        case_id: c.id,
        benchmark_revision: c.benchmark_revision,
        input_hash: c.input_hash,
        group_id: c.group_id,
        expected_outcome: c.expected_outcome,
        replay_status: c.replay_status,
      })),
    };
  }
  freezeDataset({ scope_key: scopeKey } = {}) {
    return this.freeze({
      name: '我的推荐测试集',
      case_ids: this.datasetSuite(scopeKey).members.map((c) => c.case_id),
      automatic: true,
    });
  }
  caseRevision(member) {
    const revision = this.repo.get(
      'evaluation_case_revisions',
      `${member.case_id}:r${member.benchmark_revision}`,
      false,
    );
    return revision
      ? { ...revision, id: member.case_id }
      : this.repo.get('evaluation_cases', member.case_id);
  }
  subject(id) {
    const source = this.source(id),
      c = source.existing;
    return {
      version_id: id,
      original_outcome: source.original_outcome,
      feedback_revision: c?.feedback_revision ?? 0,
      case: c ?? null,
      eligible: true,
    };
  }
  feedback(
    id,
    raw,
    { expected_revision, idempotency_key, remove = false } = {},
  ) {
    if (
      raw !== null &&
      (!['positive', 'negative'].includes(raw?.value) ||
        (raw.reason !== undefined &&
          (typeof raw.reason !== 'string' || raw.reason.length > 1000)))
    )
      fail('invalid_request', '反馈格式无效。');
    const key =
      idempotency_key ?? raw?.idempotency_key ?? identifier('feedback-request');
    const revision = expected_revision ?? raw?.expected_feedback_revision;
    const request = {
      id,
      value: raw?.value ?? null,
      reason: raw?.reason ?? '',
      remove,
    };
    const digest = hash(request),
      db = this.repo.db;
    return this.repo.database.transaction(() => {
      const oldEvent = db
        .prepare('SELECT * FROM evaluation_feedback_events WHERE request_key=?')
        .get(key);
      if (oldEvent) {
        if (oldEvent.request_hash !== digest)
          fail('conflict', '重复请求标识对应的反馈内容不同。', 409);
        return JSON.parse(oldEvent.data).response;
      }
      const source = this.source(id),
        old = source.existing;
      if (!raw && !old) return { feedback: {}, case: null };
      if (revision !== undefined && revision !== (old?.feedback_revision ?? 0))
        fail(
          'conflict',
          '反馈已在其他页面修改，请刷新后保留并重新提交编辑。',
          409,
        );
      if (old?.state === 'deleted')
        fail('conflict', '该测试样例已删除，不能通过旧反馈请求恢复。', 409);
      const input = source.input_snapshot_id
        ? this.repo.get('screening_inputs', source.input_snapshot_id, false)
        : null;
      const expected = raw
        ? expectedOutcome(source.original_outcome, raw.value)
        : (old?.expected_outcome ?? null);
      const changed =
        !old ||
        old.expected_outcome !== expected ||
        old.state !== (remove ? 'deleted' : raw ? 'active' : 'withdrawn') ||
        old.source.version_id !== source.version_id ||
        old.input_snapshot_id !== (input?.id ?? null);
      const c = {
        ...old,
        id: old?.id ?? identifier('case'),
        subject_key: old?.subject_key ?? datasetKey(source),
        subject_versions: [
          ...new Set([
            ...(old?.subject_versions ?? []),
            ...(old ? [old.source.version_id] : []),
            source.version_id,
          ]),
        ],
        group_id: `arxiv:${source.paper.id.replace(/v\d+$/, '')}`,
        source: Object.fromEntries(
          Object.entries(source).filter(([k]) => k !== 'existing'),
        ),
        original_outcome: source.original_outcome,
        expected_outcome: expected,
        input_snapshot_id: input?.id ?? null,
        input_hash: input?.hash ?? null,
        replay_status: input ? 'ready' : 'input_missing',
        feedback_revision: (old?.feedback_revision ?? 0) + 1,
        benchmark_revision: (old?.benchmark_revision ?? 0) + Number(changed),
        state: remove ? 'deleted' : raw ? 'active' : 'withdrawn',
        feedback: raw ? { value: raw.value, reason: request.reason } : null,
        created_at: old?.created_at ?? stamp(),
        updated_at: stamp(),
      };
      const removedInputs = remove
        ? new Set(
            [
              old?.input_snapshot_id,
              ...this.repo
                .all('evaluation_case_revisions')
                .filter((r) => r.case_id === c.id)
                .map((r) => r.input_snapshot_id),
            ].filter(Boolean),
          )
        : new Set();
      if (remove) {
        c.source = {
          version_id: id,
          paper: { id: c.source.paper.id, title: '已删除' },
          original_outcome: c.original_outcome,
          subscription_id: c.source.subscription_id,
          subscription: {
            name: '已删除',
            scope: c.source.subscription.scope,
            persona_connection_id: c.source.subscription.persona_connection_id,
          },
          persona_identity: c.source.persona_identity,
        };
        c.input_snapshot_id = null;
        c.input_hash = null;
        c.replay_status = 'deleted';
        for (const run of this.repo.all('evaluation_runs')) {
          if (run.current_inputs?.[c.id] || run.case_plans?.[c.id]) {
            delete run.current_inputs?.[c.id];
            delete run.case_plans?.[c.id];
            this.repo.put('evaluation_runs', run);
          }
        }
        db.prepare(
          "DELETE FROM evaluation_case_revisions WHERE json_extract(data,'$.case_id')=?",
        ).run(c.id);
        db.prepare(
          'DELETE FROM evaluation_feedback_events WHERE subject_key=?',
        ).run(c.subject_key);
        for (const entry of this.repo
          .all('evaluation_run_items')
          .filter((v) => v.case_id === c.id)) {
          delete entry.output;
          delete entry.error;
          entry.deleted = true;
          this.repo.put('evaluation_run_items', entry);
        }
      }
      this.repo.putCase(c);
      if (changed)
        this.repo.put('evaluation_case_revisions', {
          ...c,
          id: `${c.id}:r${c.benchmark_revision}`,
          case_id: c.id,
        });
      const saved =
        raw && !remove
          ? {
              ...c.feedback,
              updatedAt: c.updated_at,
              component_version: id,
              feedback_revision: c.feedback_revision,
              case_id: c.id,
              replay_status: c.replay_status,
              expected_outcome: c.expected_outcome,
            }
          : null;
      if (this.daily.repo.get('daily_item_versions', id, false))
        this.daily.repo.setFeedback(id, 'accuracy', saved);
      if (this.daily.analyses.db.result(id))
        this.daily.analyses.db.setFeedback(id, 'accuracy', saved);
      const response = { feedback: this.feedbackFor(id), case: c };
      for (const inputId of removedInputs) {
        const referenced =
          this.cases().some((v) => v.input_snapshot_id === inputId) ||
          this.repo
            .all('evaluation_case_revisions')
            .some((v) => v.input_snapshot_id === inputId) ||
          db
            .prepare(
              "SELECT 1 FROM daily_item_versions WHERE json_extract(data,'$.input_snapshot_id')=?",
            )
            .get(inputId) ||
          db
            .prepare(
              "SELECT 1 FROM results WHERE json_extract(data,'$.input_snapshot_id')=?",
            )
            .get(inputId);
        if (!referenced)
          db.prepare('DELETE FROM screening_inputs WHERE id=?').run(inputId);
      }
      db.prepare(
        'INSERT INTO evaluation_feedback_events VALUES (?,?,?,?,?)',
      ).run(
        identifier('event'),
        c.subject_key,
        key,
        digest,
        JSON.stringify({
          request,
          at: stamp(),
          feedback_revision: c.feedback_revision,
          response,
        }),
      );
      if (c.state !== 'active') this.onWithdraw?.(c.id);
      return response;
    });
  }
  cases() {
    return this.repo.all('evaluation_cases');
  }
  withdraw(id, raw = {}) {
    const c = this.repo.get('evaluation_cases', id);
    return this.feedback(c.source.version_id, null, {
      expected_revision: raw.expected_feedback_revision,
      idempotency_key: raw.idempotency_key,
      remove: raw.remove === true,
    });
  }
  importLegacy() {
    let imported = 0,
      skipped = 0;
    const rows = this.repo.db
      .prepare(`SELECT version_id AS id, data FROM daily_feedback WHERE dimension='accuracy'
      UNION ALL SELECT result_id AS id, data FROM feedback WHERE dimension='accuracy'`)
      .all()
      .sort((a, b) =>
        (JSON.parse(b.data).updatedAt ?? '').localeCompare(
          JSON.parse(a.data).updatedAt ?? '',
        ),
      );
    for (const row of rows) {
      if (
        this.cases().some(
          (c) =>
            c.source.version_id === row.id ||
            c.subject_versions?.includes(row.id),
        )
      ) {
        skipped++;
        continue;
      }
      try {
        const source = this.source(row.id);
        if (
          source.existing &&
          source.existing.updated_at >= (JSON.parse(row.data).updatedAt ?? '')
        ) {
          skipped++;
          continue;
        }
        this.feedback(row.id, JSON.parse(row.data), {
          idempotency_key: `legacy:${row.id}`,
        });
        imported++;
      } catch (e) {
        if (['ineligible', 'not_found'].includes(e.code)) skipped++;
        else throw e;
      }
    }
    return { imported, skipped };
  }
  freeze(raw) {
    if (
      typeof raw.name !== 'string' ||
      !raw.name.trim() ||
      raw.name.length > 150
    )
      fail('invalid_request', '请输入测试集名称。');
    if (
      !Array.isArray(raw.case_ids) ||
      !raw.case_ids.length ||
      raw.case_ids.length > 1000
    )
      fail('invalid_request', '请选择 1–1000 个样例。');
    const purpose = raw.purpose ?? 'unspecified';
    if (!['development', 'holdout', 'unspecified'].includes(purpose))
      fail('invalid_request', '测试集用途无效。');
    const cases = [...new Set(raw.case_ids)].map((id) =>
      this.repo.get('evaluation_cases', id),
    );
    if (cases.some((c) => c.state !== 'active' || !binary(c.expected_outcome)))
      fail('conflict', '测试集包含已撤销或无有效标签的样例。', 409);
    if (purpose !== 'unspecified') {
      const other = this.repo
        .all('evaluation_suites')
        .filter((s) => s.purpose !== 'unspecified' && s.purpose !== purpose);
      if (
        other.some((s) =>
          s.members.some((m) => cases.some((c) => c.group_id === m.group_id)),
        )
      )
        fail('conflict', '同一论文不能同时进入开发集和留出集。', 409);
    }
    const parent = raw.parent_id
      ? this.repo.get('evaluation_suites', raw.parent_id)
      : null;
    const suite = {
      id: identifier('suite'),
      name: raw.name.trim(),
      version: parent ? (parent.version ?? 1) + 1 : 1,
      ...(parent ? { parent_id: parent.id } : {}),
      purpose,
      ...(raw.automatic ? { automatic: true } : {}),
      created_at: stamp(),
      members: cases.map((c) => ({
        case_id: c.id,
        benchmark_revision: c.benchmark_revision,
        input_hash: c.input_hash,
        group_id: c.group_id,
        expected_outcome: c.expected_outcome,
        replay_status: c.replay_status,
      })),
    };
    suite.hash = hash(suite.members);
    return this.repo.put('evaluation_suites', suite);
  }
  checkSuite(id) {
    const suite = this.repo.get('evaluation_suites', id);
    if (suite.automatic) return suite;
    for (const m of suite.members) {
      const c = this.repo.get('evaluation_cases', m.case_id);
      if (
        c.state !== 'active' ||
        c.benchmark_revision !== m.benchmark_revision ||
        c.input_hash !== m.input_hash ||
        c.expected_outcome !== m.expected_outcome ||
        c.group_id !== m.group_id ||
        c.replay_status !== m.replay_status
      )
        fail('suite_changed', '反馈已修改或撤销，请重新冻结测试集。', 409);
    }
    return suite;
  }
  export() {
    const referenced = new Set(
      this.cases()
        .filter((c) => c.state !== 'deleted')
        .map((c) => c.input_snapshot_id),
    );
    for (const r of this.repo.all('evaluation_case_revisions'))
      if (this.repo.get('evaluation_cases', r.case_id).state !== 'deleted')
        referenced.add(r.input_snapshot_id);
    return {
      schema: 'paper-radar.evaluations/v1',
      created_at: stamp(),
      inputs: this.repo
        .all('screening_inputs')
        .filter((i) => referenced.has(i.id)),
      cases: this.cases(),
      revisions: this.repo.all('evaluation_case_revisions'),
      suites: this.repo.all('evaluation_suites'),
      drafts: this.repo.all('evaluation_drafts'),
      runs: this.repo.all('evaluation_runs').map(({ candidates, ...run }) => ({
        ...run,
        candidates: candidates.map(({ settings: _settings, ...c }) => c),
      })),
      items: this.repo.all('evaluation_run_items'),
      events: this.repo.db
        .prepare('SELECT * FROM evaluation_feedback_events')
        .all(),
    };
  }
  import(raw) {
    const limits = {
      drafts: 1000,
      cases: 10000,
      inputs: 10000,
      revisions: 50000,
      suites: 1000,
      runs: 2000,
      items: 200000,
      events: 100000,
    };
    if (
      raw.schema !== 'paper-radar.evaluations/v1' ||
      !Array.isArray(raw.cases) ||
      !Array.isArray(raw.inputs)
    )
      fail('invalid_request', '备份格式无效。');
    for (const [key, limit] of Object.entries(limits))
      if (
        raw[key] !== undefined &&
        (!Array.isArray(raw[key]) || raw[key].length > limit)
      )
        fail('invalid_request', `备份 ${key} 数量超过上限。`);
    return this.repo.database.transaction(() => {
      const allowedInputs = new Set(
        raw.cases
          .filter(
            (c) =>
              c.state !== 'deleted' &&
              this.repo.subject(c.subject_key)?.state !== 'deleted',
          )
          .map((c) => c.input_snapshot_id),
      );
      for (const r of raw.revisions ?? [])
        if (
          raw.cases.some(
            (c) =>
              c.id === r.case_id &&
              c.state !== 'deleted' &&
              this.repo.subject(c.subject_key)?.state !== 'deleted',
          )
        )
          allowedInputs.add(r.input_snapshot_id);
      for (const input of raw.inputs) {
        const { id, hash: digest, ...payload } = input;
        if (
          hash(payload) !== digest ||
          id !== `screen-input-${digest}` ||
          payload.schema !== 'paper-radar.screening-input/v1' ||
          !payload.item?.paper ||
          !payload.context?.records ||
          !payload.variables ||
          !payload.prompt?.prompt_id
        )
          fail('invalid_request', '输入快照校验失败。');
        if (allowedInputs.has(id)) storeScreeningInput(this.repo.db, payload);
      }
      let imported = 0,
        skipped = 0;
      const importedSubjects = new Set(),
        importedCases = new Set(),
        importedRuns = new Set();
      for (const c of raw.cases) {
        if (
          !c.id ||
          !(
            c.subject_key === datasetKey(c.source) ||
            c.subject_key === subjectKey(c.source?.version_id) ||
            c.subject_versions?.some((id) => c.subject_key === subjectKey(id))
          ) ||
          !binary(c.original_outcome) ||
          !binary(c.expected_outcome) ||
          !Number.isInteger(c.benchmark_revision) ||
          c.benchmark_revision < 1 ||
          !Number.isInteger(c.feedback_revision) ||
          c.feedback_revision < 1 ||
          !['active', 'withdrawn', 'deleted'].includes(c.state)
        )
          fail('invalid_request', '样例格式无效。');
        if (
          this.repo.subject(c.subject_key) ||
          this.repo.get('evaluation_cases', c.id, false)
        ) {
          skipped++;
          continue;
        }
        if (c.group_id !== `arxiv:${c.source.paper?.id?.replace(/v\d+$/, '')}`)
          fail('invalid_request', '论文分组与原始论文不一致。');
        if (c.input_snapshot_id) {
          const frozen = this.repo.get('screening_inputs', c.input_snapshot_id);
          if (
            frozen.item.paper.id !== c.source.paper.id ||
            frozen.item.paper.version !== c.source.paper.version
          )
            fail('invalid_request', '样例论文与冻结输入不一致。');
        }
        if (
          c.state === 'active' &&
          (!c.feedback ||
            expectedOutcome(c.original_outcome, c.feedback.value) !==
              c.expected_outcome)
        )
          fail('invalid_request', '期望标签与明确反馈不一致。');
        const original = this.daily.repo.get(
          'daily_item_versions',
          c.source.version_id,
          false,
        );
        if (
          original &&
          (original.kind !== 'screening' ||
            original.analysis_id ||
            original.data?.outcome !== c.original_outcome)
        )
          fail('invalid_request', '样例与本机原始判断不一致。');
        if (
          c.input_snapshot_id &&
          this.repo.get('screening_inputs', c.input_snapshot_id).hash !==
            c.input_hash
        )
          fail('invalid_request', '样例输入引用校验失败。');
        if (c.state === 'deleted') {
          c.source = {
            version_id: c.source.version_id,
            paper: { id: c.source.paper.id, title: '已删除' },
            subscription: {
              name: '已删除',
              scope: c.source.subscription.scope,
              persona_connection_id:
                c.source.subscription.persona_connection_id,
            },
            persona_identity: c.source.persona_identity,
            original_outcome: c.original_outcome,
          };
          c.input_snapshot_id = null;
          c.input_hash = null;
          c.feedback = null;
        }
        this.repo.putCase(c);
        importedCases.add(c.id);
        if (c.state !== 'deleted') importedSubjects.add(c.subject_key);
        this.repo.put('evaluation_case_revisions', {
          ...c,
          id: `${c.id}:r${c.benchmark_revision}`,
          case_id: c.id,
        });
        imported++;
      }
      for (const revision of raw.revisions ?? []) {
        const current = this.repo.get(
          'evaluation_cases',
          revision.case_id,
          false,
        );
        if (!importedCases.has(revision.case_id) || current.state === 'deleted')
          continue;
        if (
          revision.id !==
            `${revision.case_id}:r${revision.benchmark_revision}` ||
          revision.subject_key !== current.subject_key ||
          !binary(revision.original_outcome) ||
          datasetKey(revision.source) !== datasetKey(current.source) ||
          revision.group_id !== current.group_id ||
          revision.source?.paper?.id !== current.source.paper.id ||
          !binary(revision.expected_outcome) ||
          revision.benchmark_revision > current.benchmark_revision ||
          (revision.feedback &&
            expectedOutcome(
              revision.original_outcome,
              revision.feedback.value,
            ) !== revision.expected_outcome)
        )
          fail('invalid_request', '样例修订校验失败。');
        if (
          revision.benchmark_revision === current.benchmark_revision &&
          (revision.expected_outcome !== current.expected_outcome ||
            revision.input_hash !== current.input_hash)
        )
          fail('invalid_request', '当前样例修订不一致。');
        if (revision.input_snapshot_id) {
          const input = this.repo.get(
            'screening_inputs',
            revision.input_snapshot_id,
          );
          if (
            input.hash !== revision.input_hash ||
            input.item.paper.id !== revision.source.paper.id ||
            input.item.paper.version !== revision.source.paper.version
          )
            fail('invalid_request', '修订输入不一致。');
        }
        this.repo.put('evaluation_case_revisions', revision);
      }
      for (const event of raw.events ?? [])
        if (importedSubjects.has(event.subject_key)) {
          const data = JSON.parse(event.data);
          if (
            hash(data.request) !== event.request_hash ||
            !this.cases().some(
              (c) =>
                c.subject_key === event.subject_key &&
                (c.source.version_id === data.request.id ||
                  c.subject_versions?.includes(data.request.id)),
            )
          )
            fail('invalid_request', '反馈历史校验失败。');
          this.repo.db
            .prepare(
              'INSERT OR IGNORE INTO evaluation_feedback_events VALUES (?,?,?,?,?)',
            )
            .run(
              event.id,
              event.subject_key,
              event.request_key,
              event.request_hash,
              event.data,
            );
        }
      for (const suite of raw.suites ?? []) {
        if (
          !suite.id ||
          !Array.isArray(suite.members) ||
          !suite.members.length ||
          suite.members.length > 1000 ||
          hash(suite.members) !== suite.hash ||
          !['development', 'holdout', 'unspecified'].includes(suite.purpose)
        )
          fail('invalid_request', '测试集校验失败。');
        const existing = this.repo.get('evaluation_suites', suite.id, false);
        if (existing) {
          if (
            existing.hash !== suite.hash ||
            existing.purpose !== suite.purpose
          )
            fail('conflict', '测试集编号与已有内容冲突。', 409);
          continue;
        }
        if (
          suite.members.some(
            (m) =>
              this.repo.get('evaluation_cases', m.case_id, false)?.state ===
              'deleted',
          )
        )
          continue;
        if (
          new Set(suite.members.map((m) => m.case_id)).size !==
          suite.members.length
        )
          fail('invalid_request', '测试集包含重复样例。');
        for (const member of suite.members) {
          const revision = this.repo.get(
            'evaluation_case_revisions',
            `${member.case_id}:r${member.benchmark_revision}`,
          );
          for (const key of [
            'input_hash',
            'group_id',
            'expected_outcome',
            'replay_status',
          ])
            if (member[key] !== revision[key])
              fail('invalid_request', '测试集成员与原始样例修订不一致。');
        }
        if (
          suite.purpose !== 'unspecified' &&
          this.repo
            .all('evaluation_suites')
            .some(
              (s) =>
                s.purpose !== 'unspecified' &&
                s.purpose !== suite.purpose &&
                s.members.some((m) =>
                  suite.members.some((n) => n.group_id === m.group_id),
                ),
            )
        )
          fail('conflict', '同一论文不能同时进入开发集和留出集。', 409);
        this.repo.put('evaluation_suites', suite);
      }
      for (const draft of raw.drafts ?? []) {
        if (
          !draft ||
          typeof draft.id !== 'string' ||
          draft.id.length > 150 ||
          typeof draft.name !== 'string' ||
          draft.name.length > 150 ||
          !Number.isInteger(draft.revision) ||
          draft.revision < 1 ||
          !draft.configuration ||
          JSON.stringify(draft.configuration).length > 350000 ||
          !Array.isArray(draft.configuration.candidates) ||
          draft.configuration.candidates.length !== 2 ||
          draft.configuration.candidates.some(
            (c) =>
              !c?.selection || !['dsh', 'codex'].includes(c.selection.backend),
          )
        )
          fail('invalid_request', '实验草稿格式无效。');
        if (
          !this.repo.get('evaluation_drafts', draft.id, false) &&
          this.repo.get(
            'evaluation_suites',
            draft.configuration.suite_id,
            false,
          )
        )
          this.repo.put('evaluation_drafts', {
            id: draft.id,
            name: draft.name,
            revision: draft.revision,
            configuration: draft.configuration,
            updated_at: draft.updated_at,
          });
      }
      for (const run of raw.runs ?? []) {
        if (this.repo.get('evaluation_runs', run.id, false)) continue;
        const suite = this.repo.get('evaluation_suites', run.suite_id, false);
        if (!suite) continue;
        if (
          run.suite_hash !== suite.hash ||
          !Array.isArray(run.candidates) ||
          run.candidates.length < 1 ||
          run.candidates.length > 2 ||
          run.candidates.some(
            (c, index) =>
              c.id !== (index ? 'B' : 'A') ||
              !c.prompt_snapshot?.versions?.[c.prompt_id]?.id,
          )
        )
          fail('invalid_request', '评测运行配置校验失败。');
        const {
          request_key: _requestKey,
          request_hash: _requestHash,
          ...history
        } = run;
        for (const key of ['current_inputs', 'case_plans'])
          if (history[key])
            history[key] = Object.fromEntries(
              Object.entries(history[key]).filter(
                ([id]) =>
                  this.repo.get('evaluation_cases', id, false)?.state !==
                  'deleted',
              ),
            );
        this.repo.put('evaluation_runs', {
          ...history,
          status: 'imported',
          candidates: run.candidates.map((c) => ({ ...c, settings: null })),
        });
        importedRuns.add(run.id);
      }
      const states = new Set([
        'queued',
        'running',
        'completed',
        'cancelled',
        'interrupted',
        'needs_fulltext',
        'input_missing',
        'input_failed',
        'input_unavailable',
        'request_failed',
        'validation_failed',
        'result_unknown',
        'connection_changed',
        'withdrawn',
        'timeout',
      ]);
      for (const item of raw.items ?? []) {
        if (!importedRuns.has(item.run_id)) continue;
        const run = this.repo.get('evaluation_runs', item.run_id),
          suite = this.repo.get('evaluation_suites', run.suite_id),
          member = suite.members.find((m) => m.case_id === item.case_id);
        if (
          !member ||
          item.id !== `${run.id}:${item.candidate_id}:${item.case_id}` ||
          !run.candidates.some((c) => c.id === item.candidate_id) ||
          item.expected_outcome !== member.expected_outcome ||
          item.input_hash !== member.input_hash ||
          item.benchmark_revision !== member.benchmark_revision ||
          !states.has(item.status) ||
          !Array.isArray(item.attempts) ||
          (item.status === 'completed' && !binary(item.outcome))
        )
          fail('invalid_request', '评测明细校验失败。');
        if (
          this.repo.get('evaluation_cases', item.case_id).state === 'deleted'
        ) {
          delete item.output;
          delete item.error;
          item.deleted = true;
        }
        this.repo.put('evaluation_run_items', item);
      }
      // A partial backup must never shrink the frozen scoring denominator.
      for (const runId of importedRuns) {
        const run = this.repo.get('evaluation_runs', runId),
          suite = this.repo.get('evaluation_suites', run.suite_id);
        for (const candidate of run.candidates)
          for (const member of suite.members) {
            const id = `${runId}:${candidate.id}:${member.case_id}`;
            if (!this.repo.get('evaluation_run_items', id, false))
              this.repo.put('evaluation_run_items', {
                id,
                run_id: runId,
                candidate_id: candidate.id,
                ...member,
                status: 'result_unknown',
                outcome: null,
                attempts: [],
                error: {
                  code: 'imported_item_missing',
                  message: '备份缺少此条结果，保留原测试集分母。',
                },
              });
          }
      }
      return { imported, skipped };
    });
  }
}
