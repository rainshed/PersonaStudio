import { analysisInputSchema as inputSchema } from '../../lib/contracts/analysis.ts';
import { analysisDecisionSchema } from '../../lib/contracts/task.ts';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { parseArxiv } from '../../lib/arxiv.ts';
import { countSummaryText } from '../../lib/text-length.ts';

export const PIPELINE_VERSION = 'single-v3-knowledge';
export const SCHEMA_VERSION = 'analysis.v1';
export const hash = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
export class AnalysisError extends Error {
  constructor(code, message, retryable = false, httpStatus = 400) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}
export function safeError(e) {
  if (
    e instanceof AnalysisError ||
    (e?.name === 'Error' && e?.code && typeof e.retryable === 'boolean')
  )
    return { code: e.code, message: e.message, retryable: !!e.retryable };
  if (e?.name === 'AbortError')
    return { code: 'cancelled', message: '任务已取消', retryable: false };
  return {
    code: 'analysis_error',
    message: '分析未能完成，可重试；详情见任务阶段。',
    retryable: true,
  };
}
export function validateInput(raw) {
  const r = inputSchema.safeParse(raw);
  if (!r.success)
    throw new AnalysisError(
      'invalid_settings',
      '请检查标签、语言及总结字数设置。',
    );
  const v = r.data,
    paper = parseArxiv(v.arxiv_input);
  if (!paper)
    throw new AnalysisError(
      'invalid_arxiv_input',
      '请填写有效的 arXiv 链接或编号。',
    );
  if (v.summary_length.min >= v.summary_length.max)
    throw new AnalysisError('invalid_settings', '总结最少字数应小于最多字数。');
  if (v.scope.tag_ids.length && !v.persona_connection_id)
    throw new AnalysisError(
      'invalid_settings',
      '选定标签时必须连接 AI Persona。',
    );
  return {
    ...v,
    arxiv_input: paper.url,
    scope: { tag_ids: [...new Set(v.scope.tag_ids)].sort(), tag_match: 'any' },
    persona_connection_id: v.scope.tag_ids.length
      ? v.persona_connection_id
      : null,
  };
}
const text = z.string().trim().min(1).max(18000);
const ids = z.array(z.string().min(1).max(250)).max(50);
export const summarySchema = z
  .object({
    sections: z
      .array(
        z
          .object({
            title: text,
            paragraphs: z.array(text).min(1).max(12),
            evidence_ids: ids.min(1),
          })
          .strict(),
      )
      .length(6),
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
export const personalSchema = z
  .object({
    decision: analysisDecisionSchema,
    reasons: z
      .array(
        z
          .object({
            text,
            paper_evidence_ids: ids.min(1),
            persona_evidence_ids: ids,
            claims: z.array(claim).max(15),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    connections: z
      .array(
        z
          .object({
            material_id: z.string(),
            relation_type: z.enum([
              'direct_citation',
              'shared_question',
              'method_comparison',
            ]),
            explanation: text,
            paper_evidence_ids: ids.min(1),
            persona_evidence_ids: ids.min(1),
          })
          .strict(),
      )
      .max(12),
    crossovers: z
      .array(
        z
          .object({
            question: text,
            premises: text,
            supporting_evidence_ids: ids.min(2),
            unverified_points: text,
            first_check: text,
            novelty_check_scope: text,
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
export const reviewSchema = z
  .object({
    issues: z
      .array(
        z
          .object({ description: text, severity: z.enum(['error', 'note']) })
          .strict(),
      )
      .max(10),
  })
  .strict();
export function parseOutput(raw, schema) {
  const clean = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(clean);
  } catch {
    throw new AnalysisError(
      'schema_invalid',
      '模型返回的 JSON 格式不完整。',
      true,
    );
  }
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AnalysisError(
      'schema_invalid',
      '结构不符合输出协议：' +
        result.error.issues
          .slice(0, 5)
          .map((i) => i.path.join('.') + ': ' + i.message)
          .join('；'),
      true,
    );
  return result.data;
}
export function validateSummary(value, input, evidence) {
  const issues = [];
  const paragraphs = value.sections.flatMap((s) => s.paragraphs);
  const actual = countSummaryText(paragraphs.join('\n'), input.language);
  if (actual < input.summary_length.min || actual > input.summary_length.max)
    issues.push(
      `正文实际 ${actual} ${input.language === 'zh' ? '字' : 'words'}，目标 ${input.summary_length.min}–${input.summary_length.max}。`,
    );
  if (new Set(paragraphs).size !== paragraphs.length)
    issues.push('总结有重复段落。');
  for (const id of value.sections.flatMap((s) => s.evidence_ids))
    if (!evidence.has(id)) issues.push('不存在的论文引用：' + id);
  return { actual_length: actual, issues: [...new Set(issues)] };
}
export function validatePersonal(
  value,
  paper,
  persona,
  { requireCompleteKnowledge = true } = {},
) {
  const issues = [],
    pids = new Set(paper.blocks.map((b) => b.id)),
    kids = new Set(persona.evidence.map((e) => e.id));
  const all = new Set([...pids, ...kids]);
  const knowledge = persona.records.filter(
    (r) =>
      r.entity_type === 'knowledge_node' &&
      persona.knowledge_ids?.includes(r.id),
  );
  if (
    requireCompleteKnowledge &&
    (!knowledge.length || !persona.coverage.complete_knowledge_scan)
  )
    issues.push('未取得所选标签下的完整知识点依据。');
  if (
    !knowledge.some((r) =>
      value.reasons.some((reason) =>
        reason.persona_evidence_ids.includes(
          `persona:${r.id}:r${r.record_revision}`,
        ),
      ),
    )
  )
    issues.push('推荐判断必须引用所选标签下的知识点，材料不能代替知识点。');
  for (const r of [...value.reasons, ...value.connections]) {
    for (const id of r.paper_evidence_ids)
      if (!pids.has(id)) issues.push('无效论文证据：' + id);
    for (const id of r.persona_evidence_ids)
      if (!kids.has(id)) issues.push('无效或越界的个人证据：' + id);
  }
  for (const r of value.reasons)
    for (const c of r.claims) {
      const record = persona.records.find((x) => x.id === c.record_id);
      const actual = record?.[c.field];
      if (
        !record ||
        !(Array.isArray(actual) ? actual.includes(c.value) : actual === c.value)
      )
        issues.push('个人事实与记录不符：' + c.record_id + '.' + c.field);
      if (
        !r.persona_evidence_ids.some((id) =>
          persona.evidence.some(
            (e) => e.id === id && e.record_id === c.record_id,
          ),
        )
      )
        issues.push('个人事实缺少该记录的引用：' + c.record_id);
    }
  for (const c of value.connections) {
    if (
      !persona.records.some(
        (r) => r.id === c.material_id && r.entity_type === 'material',
      )
    )
      issues.push('材料不在范围内：' + c.material_id);
    if (
      !c.persona_evidence_ids.some((id) =>
        persona.evidence.some(
          (e) => e.id === id && e.record_id === c.material_id,
        ),
      )
    )
      issues.push('材料联系缺少该材料的证据：' + c.material_id);
    if (
      c.relation_type === 'direct_citation' &&
      !persona.matches.some(
        (m) =>
          m.material_id === c.material_id &&
          c.paper_evidence_ids.includes(m.evidence_id),
      )
    )
      issues.push('直接引用缺少已确认参考文献匹配：' + c.material_id);
  }
  for (const c of value.crossovers) {
    for (const id of c.supporting_evidence_ids)
      if (!all.has(id)) issues.push('交叉证据不存在：' + id);
    if (
      !c.supporting_evidence_ids.some((id) => pids.has(id)) ||
      !c.supporting_evidence_ids.some((id) => kids.has(id))
    )
      issues.push('交叉需要同时引用论文与个人材料。');
  }
  return [...new Set(issues)];
}
export function feedbackDimensions(result) {
  return result.personalization?.status === 'available' &&
    ['recommended', 'not_recommended'].includes(result.personalization.data?.decision)
    ? ['accuracy'] : [];
}
