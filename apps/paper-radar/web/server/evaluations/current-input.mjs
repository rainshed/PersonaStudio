import { SCREEN_AGENT_PROMPT } from '@paper-radar/host-contract/agent-contract';
import { ResearchTools, publicPaper } from '../agents/research-tools.mjs';
import { autonomousInput } from '../agents/task-input.mjs';
import { ScreeningEvidence } from '../daily/agent-screening.mjs';
import { AnalysisError, hash } from '../analyses/contracts.mjs';

export const CURRENT_EVALUATION = 'current-recommendation/v1';
export const tagScope = (source) => ({
  tag_ids: [...new Set(source.subscription?.scope?.tag_ids ?? [])].sort(
    (a, b) => a.localeCompare(b),
  ),
  tag_match: source.subscription?.scope?.tag_match ?? 'any',
});
export const tagScopeKey = (source) => hash(tagScope(source));

// Only task preferences and the paper reference are copied. Human labels,
// previous generated answers and historical evidence never enter a new task.
export function casePlan(service, c) {
  const source = c.source;
  const current = source.subscription_id
    ? service.daily.repo.get('subscriptions', source.subscription_id, false)
    : null;
  const preferences =
    current && tagScopeKey({ subscription: current }) === tagScopeKey(source)
      ? current
      : source.subscription;
  const id = source.paper.id.replace(/v\d+$/, '');
  const version = source.paper.version;
  const input = {
    arxiv_input: `https://arxiv.org/abs/${id}${version ? `v${version}` : ''}`,
    persona_connection_id:
      source.persona_identity ?? source.subscription.persona_connection_id,
    scope: tagScope(source),
    language: preferences.language ?? 'zh',
    summary_length: preferences.summary_length ?? { min: 800, max: 1500 },
    recommendation_strictness:
      preferences.recommendation_strictness ?? 'balanced',
  };
  return {
    prompt_id:
      source.kind === 'analysis'
        ? 'paper-radar.task-single'
        : SCREEN_AGENT_PROMPT,
    input,
    variables: {
      task: JSON.stringify({ input }),
      recommendation_strictness: input.recommendation_strictness,
    },
  };
}

export function requireMatchingScopes(plans) {
  if (new Set(Object.values(plans).map((p) => hash(p.input.scope))).size !== 1)
    throw new AnalysisError(
      'scope_mismatch',
      '请选择同一个 tag 范围的测试样例。',
    );
}

export async function prepareCurrentInput(service, plan, signal) {
  const analyses = service.daily.analyses;
  const input = structuredClone(plan.input);
  await analyses.persona.connect?.();
  input.persona_connection_id =
    analyses.persona.identity ?? input.persona_connection_id;
  const screening = plan.prompt_id === SCREEN_AGENT_PROMPT;
  const reader = await new ResearchTools({
    analyses,
    input: screening
      ? { ...input, scope: { tag_ids: [], tag_match: 'any' } }
      : input,
    signal,
  }).prepare();
  reader.input = { ...input, arxiv_input: reader.paper.url };
  const context =
    plan.prompt_id === SCREEN_AGENT_PROMPT
      ? await (
          analyses.persona.queryContext ?? analyses.persona.screeningSnapshot
        ).call(analyses.persona, input, signal)
      : { ...reader.persona, query_mode: !!analyses.persona.scopeReader };
  if (!context)
    throw new AnalysisError('empty_scope', '请选择推荐依据的 tag 范围。');
  if (
    hash(tagScope({ subscription: { scope: context.scope } })) !==
    hash(input.scope)
  )
    throw new AnalysisError(
      'scope_mismatch',
      '知识库返回的 tag 范围与测试样例不一致。',
    );
  return {
    prompt: { prompt_id: plan.prompt_id },
    subscription: { ...reader.input, id: 'evaluation', revision: 1 },
    context,
    item: {
      id: 'evaluation-paper:' + reader.paper.id,
      paper: { ...publicPaper(reader.paper), evidence_id: reader.abstractId },
    },
    full_paper: reader.full,
    prepared_at: new Date().toISOString(),
  };
}

export function currentReaders(service, input, snapshot, signal) {
  const live = service.daily.analyses;
  const analyses = {
    persona: live.persona,
    arxiv: {
      get: async (url, readSignal) => {
        if (!input.full_paper)
          input.full_paper = await live.arxiv.get(url, readSignal);
        return structuredClone(input.full_paper);
      },
    },
  };
  return {
    async single() {
      return new ResearchTools({
        analyses,
        input: structuredClone(input.subscription),
        paper: structuredClone(input.full_paper ?? input.item.paper),
        persona: structuredClone(input.context),
        signal,
      }).prepare();
    },
    screening() {
      return new ScreeningEvidence(
        { analyses, persona: live.persona },
        {
          context: structuredClone(input.context),
          subscription: input.subscription,
          prompt_snapshot: snapshot,
        },
        input.item,
        signal,
        { evaluation: true },
      );
    },
  };
}

export function currentVariables(input, reader, snapshot) {
  return {
    task: JSON.stringify(
      input.prompt.prompt_id === 'paper-radar.task-single'
        ? autonomousInput({ task: 'single', reader, snapshot })
        : reader.initial(),
    ),
    recommendation_strictness: input.subscription.recommendation_strictness,
  };
}
