export type HostTask =
  | 'screen'
  | 'single'
  | 'summary'
  | 'connections'
  | 'review'
  | 'discussion';
export type HostModel = {
  id: string;
  name?: string;
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  revision?: string;
  reasoningEffort?: string | null;
};
export type HostModelSettings = {
  connections: HostModel[];
  defaultConnectionId: string | null;
  overrides: Partial<Record<HostTask, string | null>>;
  fallback: { enabled: boolean; connectionId?: string | null };
  dsh?: { protocol: string };
  codex?: { protocol: string };
};
export function resolveConnection(
  settings: HostModelSettings,
  task: HostTask,
): HostModel | undefined {
  const id = settings.overrides[task] ?? settings.defaultConnectionId;
  return settings.connections.find((model) => model.id === id);
}
