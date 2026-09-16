import { HOST_EXECUTION_VERSION } from '@paper-radar/host-contract/execution';
import { BridgeError } from './transport.mjs';
export function backendFromSettings(settings, fallback = null) {
  if (settings?.codex) return 'codex';
  if (settings?.dsh || settings?.harness) return 'dsh';
  return settings ? null : fallback;
}
export function requireHostSettings(settings) {
  if (!backendFromSettings(settings))
    throw new BridgeError(
      'unsupported_host_snapshot',
      '该历史任务没有可用的 Agent 宿主，请保留历史并重新发起任务。',
    );
  if (settings.harness && !settings.dsh)
    return { ...settings, dsh: settings.harness };
  return settings;
}
export function hostCapabilities(
  backend,
  { concurrency = 1, supportsAgents = true, managesConcurrency = true } = {},
) {
  return Object.freeze({
    version: HOST_EXECUTION_VERSION,
    backend,
    executionPool: backend,
    concurrency,
    concurrencyUnit:
      { codex: 'agent-turn', dsh: 'model-attempt' }[backend] ?? 'unknown',
    attemptUnit:
      { codex: 'agent-turn', dsh: 'model-attempt' }[backend] ?? 'unknown',
    supportsAgents,
    managesConcurrency,
    cancellation: 'abort-signal',
    admission: 'priority-with-aging',
    frozenSettings: true,
    validatedSubmission: supportsAgents,
  });
}
