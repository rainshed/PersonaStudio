import { z } from 'zod';
import { AnalysisError, parseOutput } from '../analyses/contracts.mjs';
export const DISCUSSION_VERSION = 'discussion.v2-persona';
export const sourceSchema = z
  .object({
    daily_item_id: z.string().min(1).max(120).optional(),
    analysis_id: z.string().min(1).max(120).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    anchor: z
      .object({
        kind: z.enum([
          'summary',
          'reason',
          'connection',
          'crossover',
          'selection',
        ]),
        index: z.number().int().min(0).max(100).optional(),
        quote: z.string().trim().min(1).max(2000).optional(),
      })
      .strict()
      .optional(),
    new_conversation: z.boolean().default(false),
  })
  .strict();
const claim = z
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
  .strict();
export const answerSchema = z
  .object({
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(16000),
            evidence_ids: z.array(z.string()).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    limitations: z.array(z.string().min(1).max(2000)).max(8),
    claims: z.array(claim).max(30),
  })
  .strict();
export function parseAnswer(text, evidence, records) {
  const value = parseOutput(text, answerSchema),
    ids = new Set(evidence.map((e) => e.id)),
    cited = new Set(value.paragraphs.flatMap((p) => p.evidence_ids));
  if ([...cited].some((id) => !ids.has(id)))
    throw new AnalysisError(
      'invalid_reference',
      '讨论引用了本轮未提供的证据。',
      true,
    );
  for (const c of value.claims) {
    const r = records.find((r) => r.id === c.record_id),
      actual = r?.[c.field];
    if (
      !(Array.isArray(actual)
        ? actual.includes(c.value)
        : actual === c.value) ||
      !cited.has(`persona:${r?.id}:r${r?.record_revision}`)
    )
      throw new AnalysisError(
        'invalid_claim',
        '讨论中的个人事实缺少原始字段依据。',
        true,
      );
  }
  return value;
}
export function resolveAnchor(anchor, result) {
  if (!anchor) return null;
  if (!result)
    throw new AnalysisError(
      'invalid_anchor',
      '请先选择一份报告，再讨论其中的问题。',
    );
  const personal = result.personalization?.data,
    sections = result.summary?.data?.sections ?? [];
  let text,
    label,
    evidence = [];
  if (anchor.kind === 'summary') {
    const v = sections[anchor.index];
    text = v?.paragraphs.join('\n\n');
    label = v?.title;
    evidence = v?.evidence_ids;
  }
  if (anchor.kind === 'reason') {
    const v = personal?.reasons[anchor.index];
    text = v?.text;
    label = '推荐理由';
    evidence = v && [...v.paper_evidence_ids, ...v.persona_evidence_ids];
  }
  if (anchor.kind === 'connection') {
    const v = personal?.connections[anchor.index];
    text = v?.explanation;
    label = '材料联系';
    evidence = v && [...v.paper_evidence_ids, ...v.persona_evidence_ids];
  }
  if (anchor.kind === 'crossover') {
    const v = personal?.crossovers[anchor.index];
    text =
      v &&
      [
        v.question,
        '前提：' + v.premises,
        '尚未验证：' + v.unverified_points,
        '首先验证：' + v.first_check,
        '检索范围：' + v.novelty_check_scope,
      ].join('\n');
    label = v?.question;
    evidence = v?.supporting_evidence_ids;
  }
  if (anchor.kind === 'selection') {
    const parts = [
      ...sections.flatMap((s) => s.paragraphs),
      ...(personal?.reasons.map((r) => r.text) ?? []),
      ...(personal?.connections.map((r) => r.explanation) ?? []),
      ...(personal?.crossovers.flatMap((r) => [
        r.question,
        r.premises,
        r.unverified_points,
        r.first_check,
      ]) ?? []),
    ];
    if (!anchor.quote || !parts.some((p) => p.includes(anchor.quote)))
      throw new AnalysisError(
        'invalid_anchor',
        '所选文字不属于这份报告，请重新选择。',
      );
    text = anchor.quote;
    label = '选中段落';
    evidence = result.evidence.map((e) => e.id);
  }
  if (!text)
    throw new AnalysisError('invalid_anchor', '报告中不存在这个章节或问题。');
  return {
    kind: anchor.kind,
    index: anchor.index,
    label,
    text,
    evidence_ids: evidence ?? [],
    analysis_id: result.id,
    report_created_at: result.created_at,
    paper_version: `${result.paper.id}v${result.paper.version}`,
  };
}
