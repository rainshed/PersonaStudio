import { DEFAULT_CONCURRENCY } from './concurrency.ts';

export const HOST_TASKS = [
  'screen',
  'single',
  'summary',
  'connections',
  'review',
  'discussion',
] as const;
export type HostTask = (typeof HOST_TASKS)[number];
export type Preset = 'fast' | 'deep';
export type Assignment = Preset | 'custom';
export type ModelRef = { provider: string; model: string };
export type ModelChoice = {
  model: ModelRef | null;
  reasoningEffort: string | null;
};
export type LegacyRouting = {
  revision: number;
  concurrency?: number;
  tasks: Record<string, ModelChoice>;
  fallback: ModelChoice & { enabled: boolean };
};
export type HostRouting = LegacyRouting & {
  version: 2;
  concurrency: number;
  presets: Record<Preset, ModelChoice>;
  assignments: Record<HostTask, Assignment>;
};
export const defaultPreset = (task: string): Preset =>
  task === 'screen' ? 'fast' : 'deep';
export const modelKey = (model: ModelRef | null | undefined) =>
  model ? JSON.stringify([model.provider, model.model]) : 'inherit';
export const blankChoice = (): ModelChoice => ({
  model: null,
  reasoningEffort: null,
});
export function taskChoice(routes: HostRouting, task: HostTask): ModelChoice {
  const assignment = routes.assignments[task];
  return assignment === 'custom'
    ? routes.tasks[task]
    : routes.presets[assignment];
}
// Materialized choices keep the bridge and saved task snapshots self-contained.
export function materializeRoutes(routes: HostRouting): HostRouting {
  return {
    ...routes,
    tasks: Object.fromEntries(
      HOST_TASKS.map((task) => [task, { ...taskChoice(routes, task) }]),
    ),
  };
}
export function upgradeRoutes(saved: LegacyRouting | HostRouting): HostRouting {
  if ('version' in saved && saved.version === 2)
    return {
      ...structuredClone(saved),
      concurrency:
        saved.concurrency === undefined
          ? DEFAULT_CONCURRENCY
          : saved.concurrency,
    };
  const legacy = saved as LegacyRouting;
  const presets = {
    fast: legacy.tasks.screen ?? blankChoice(),
    deep: legacy.tasks.single ?? blankChoice(),
  };
  const assignments = {} as HostRouting['assignments'];
  const tasks: Record<string, ModelChoice> = {};
  for (const task of HOST_TASKS) {
    const original = legacy.tasks[task] ?? blankChoice();
    const parent = ['summary', 'connections', 'review'].includes(task)
      ? presets.deep
      : blankChoice();
    const choice = {
      model: original.model ?? parent.model,
      reasoningEffort: original.reasoningEffort ?? parent.reasoningEffort,
    };
    const preset = defaultPreset(task);
    assignments[task] =
      modelKey(choice.model) === modelKey(presets[preset].model) &&
      choice.reasoningEffort === presets[preset].reasoningEffort
        ? preset
        : 'custom';
    tasks[task] = choice;
  }
  return {
    ...legacy,
    version: 2,
    concurrency: legacy.concurrency ?? DEFAULT_CONCURRENCY,
    presets,
    assignments,
    tasks,
  };
}

// Catalog names are presentation data; connection identity remains untouched.
export function cleanModelName(name: string): string {
  return name.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}
