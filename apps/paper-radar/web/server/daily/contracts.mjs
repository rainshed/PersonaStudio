import { subscriptionSchema } from '../../lib/contracts/analysis.ts';
import { uniqueAuthorNames } from '../../lib/author-following.ts';
import {
  isTaskActive,
  screeningDecisionSchema,
} from '../../lib/contracts/task.ts';
import { z } from 'zod';
import {
  isAnnouncementDate,
  announcementToday,
} from '../../lib/daily-source.ts';
import {
  AnalysisError,
  validateInput,
  parseOutput,
} from '../analyses/contracts.mjs';

export const SCREEN_VERSION = 'screening.v3-knowledge';
export const activeRun = isTaskActive;
export const now = () => new Date().toISOString();
export function requestKey(key) {
  if (typeof key !== 'string' || !/^[\w-]{8,120}$/.test(key))
    throw new AnalysisError('invalid_request', '缺少有效的请求幂等标识。');
  return key;
}
export function validateSubscription(raw, subjects) {
  const result = subscriptionSchema.safeParse(raw);
  if (!result.success)
    throw new AnalysisError(
      'invalid_settings',
      '请检查订阅名称、范围、字数和请求预算。',
    );
  const v = result.data;
  const selected = [
    ...new Set(v.subjects ?? (v.subject ? [v.subject] : [])),
  ].sort();
  if (
    !selected.length ||
    selected.some((id) => !subjects.some((s) => s.id === id))
  )
    throw new AnalysisError(
      'invalid_subject',
      '请至少选择一个有效的 arXiv subject。',
    );
  const input = validateInput({
    arxiv_input: '2501.12903',
    persona_connection_id: v.persona_connection_id,
    scope: v.scope,
    language: v.language,
    summary_length: v.summary_length,
  });
  if (v.status === 'enabled' && !input.scope.tag_ids.length)
    throw new AnalysisError(
      'empty_scope',
      '启用个性化订阅前，请选择至少一个 Persona 标签。',
    );
  return {
    ...v,
    subjects: selected,
    followed_authors: uniqueAuthorNames(v.followed_authors),
    subject: selected[0],
    scope: input.scope,
    persona_connection_id: input.persona_connection_id,
  };
}
export const runSchema = z
  .object({
    subscription_id: z.string(),
    expected_subscription_revision: z.number().int().positive(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('latest_announcement') }).strict(),
      z
        .object({
          kind: z.literal('announcement_date'),
          date: z
            .string()
            .refine(
              (value) =>
                isAnnouncementDate(value) && value <= announcementToday(),
            ),
        })
        .strict(),
      z
        .object({
          kind: z.literal('stored_batch'),
          batch_id: z.string(),
          revision_id: z.string().optional(),
        })
        .strict(),
    ]),
    force_regenerate: z.boolean().default(false),
  })
  .strict();
export const screenSchema = z
  .object({
    paper_version: z.string(),
    outcome: screeningDecisionSchema,
    introduction: z.string().trim().min(1).max(3000),
    reason: z.string().trim().min(1).max(5000),
    paper_evidence_ids: z.array(z.string()).min(1).max(10),
    persona_evidence_ids: z.array(z.string()).max(50),
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
    questions_for_fulltext: z.array(z.string().min(1).max(1000)).max(8),
  })
  .strict();
export function parseScreen(
  text,
  paper,
  context,
  { paperEvidenceIds = [paper.evidence_id], requireCompleteKnowledge = true } = {},
) {
  const v = parseOutput(text, screenSchema);
  const knowledge = context.records.filter(
    (r) =>
      r.entity_type === 'knowledge_node' &&
      context.knowledge_ids?.includes(r.id),
  );
  if (requireCompleteKnowledge && (!knowledge.length || !context.coverage.complete_knowledge_scan))
    throw new AnalysisError(
      'insufficient_context',
      '未取得所选标签下的完整知识点依据。',
      true,
    );
  const evidence = new Set(context.evidence.map((e) => e.id));
  if (
    v.paper_version !== `${paper.id}v${paper.version}` ||
    v.paper_evidence_ids.some((id) => !paperEvidenceIds.includes(id)) ||
    v.persona_evidence_ids.some((id) => !evidence.has(id))
  )
    throw new AnalysisError(
      'invalid_reference',
      '初筛结果的论文版本或证据引用无效。',
      true,
    );
  for (const claim of v.claims) {
    const record = context.records.find((r) => r.id === claim.record_id);
    const actual = record?.[claim.field];
    if (
      !(Array.isArray(actual)
        ? actual.includes(claim.value)
        : actual === claim.value) ||
      !v.persona_evidence_ids.includes(
        `persona:${record?.id}:r${record?.record_revision}`,
      )
    )
      throw new AnalysisError(
        'invalid_claim',
        '初筛使用了没有证据支持的个人事实。',
        true,
      );
  }
  if (!v.persona_evidence_ids.length && (requireCompleteKnowledge || v.outcome !== 'needs_fulltext'))
    throw new AnalysisError(
      'insufficient_context',
      '初筛没有提供范围内个人依据，尚不能完成个性化判断。',
      true,
    );
  v.matched_knowledge_ids = knowledge
    .filter((r) =>
      v.persona_evidence_ids.includes(`persona:${r.id}:r${r.record_revision}`),
    )
    .map((r) => r.id);
  if (requireCompleteKnowledge && !v.matched_knowledge_ids.length)
    throw new AnalysisError(
      'invalid_reference',
      '推荐判断必须引用所选标签下的知识点，材料不能代替知识点。',
      true,
    );
  return v;
}
export function pageParams(url) {
  const limit = Number(url.searchParams.get('limit') ?? 25),
    offset = Number(url.searchParams.get('offset') ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new AnalysisError('invalid_request', '分页参数无效。');
  return { limit, offset };
}
