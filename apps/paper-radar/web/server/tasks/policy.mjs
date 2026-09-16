import { modelConcurrency } from '../concurrency.mjs';

export const taskPool = (models, settings) =>
  models.executionPoolForSettings?.(settings) ??
  (settings?.codex ? 'codex' : (settings?.dsh || settings?.harness) ? 'dsh' : 'unsupported');

// Interactive and analysis lanes admit agents separately, so a long analysis
// cannot prevent a question reaching the shared priority model queue. A host's
// model request cap remains global across every lane and background worker.
export const taskLane = (models, kind) => ({
  group: (task) => `${kind}:${taskPool(models, task.model_settings)}`,
  concurrency: (task) => modelConcurrency(models, task.model_settings),
});
