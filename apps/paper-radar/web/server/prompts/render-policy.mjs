import {
  TASK_PROMPTS,
  SCREEN_PROMPT,
  sharedId,
  ruleId,
} from './language-prompts.mjs';

export const LEGACY_RENDER_POLICY = 'terminology-by-output-language/v1';
export const PROMPT_RENDER_POLICY = 'language-shared-and-selected-screening/v2';

export function taskValue(variables) {
  if (typeof variables.task !== 'string') return variables.task;
  try {
    return JSON.parse(variables.task);
  } catch {
    return null;
  }
}

// Only inspect task configuration, never UI language, source text or the user's
// prose question. Captured tasks may store the same structured input as JSON.
export function isChineseTask(variables) {
  const task = taskValue(variables);
  const language =
    task?.input?.language ??
    task?.output?.language ??
    task?.goal?.language ??
    variables.language;
  if (typeof language !== 'string') return false;
  const value = language.trim().toLowerCase().replaceAll('_', '-');
  return (
    /^zh(?:-|$)/.test(value) ||
    value === '中文' ||
    value === 'chinese' ||
    value === 'chinese prose with english academic terms'
  );
}

export function skipPromptDependency(snapshot, id, variables) {
  // Old task snapshots retain their original composition on retry/replay.
  return (
    [LEGACY_RENDER_POLICY, PROMPT_RENDER_POLICY].includes(
      snapshot.rendering_policy,
    ) &&
    id === 'paper-radar.terminology' &&
    !isChineseTask(variables)
  );
}

export function compositionFor(id, variables = {}) {
  const base = TASK_PROMPTS.find(
    (key) => id === key || id === `${key}.zh` || id === `${key}.en`,
  );
  if (!base) return null;
  const language =
    /\.(zh|en)$/.exec(id)?.[1] ?? (isChineseTask(variables) ? 'zh' : 'en');
  const task = taskValue(variables);
  const rule =
    task?.criteria?.strictness ??
    task?.input?.recommendation_strictness ??
    variables.recommendation_strictness ??
    'balanced';
  return {
    task: `${base}.${language}`,
    shared: sharedId(language),
    rule: base === SCREEN_PROMPT ? ruleId(language, rule) : null,
    language,
    screening_rule: base === SCREEN_PROMPT ? rule : null,
  };
}

export function compositionRoots(snapshot, id, variables) {
  if (snapshot.rendering_policy !== PROMPT_RENDER_POLICY) return [id];
  const plan = compositionFor(id, variables);
  if (!plan) return [id];
  return [
    plan.task,
    ...(snapshot.versions[plan.shared]?.templates.text.trim()
      ? [plan.shared]
      : []),
    ...(plan.rule ? [plan.rule] : []),
  ];
}

export function fingerprintInput(snapshot, versions) {
  return snapshot.rendering_policy
    ? { rendering_policy: snapshot.rendering_policy, ...(snapshot.context_policy ? { context_policy: snapshot.context_policy } : {}), versions }
    : versions;
}
