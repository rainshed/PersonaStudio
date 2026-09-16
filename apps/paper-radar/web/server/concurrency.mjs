import { DEFAULT_CONCURRENCY } from '../lib/concurrency.ts';
export const modelConcurrency = (models, settings = null) =>
  models.concurrencyForSettings?.(settings) ??
  models.concurrency ??
  DEFAULT_CONCURRENCY;

// Resize the live paper queue without cancelling work already in progress.
// A single saved model-service limit controls both this pool and model admission.
export async function runConcurrent(
  items,
  worker,
  { limit, signal, subscribe, canStart = () => true },
) {
  signal.throwIfAborted();
  let next = 0,
    active = 0,
    failure,
    finished = false,
    unsubscribe;
  try {
    await new Promise((resolve) => {
      const pump = () => {
        if (finished) return;
        if (signal.aborted) failure ??= signal.reason;
        while (
          !failure &&
          canStart() &&
          next < items.length &&
          active < limit()
        ) {
          const item = items[next++];
          active++;
          void Promise.resolve()
            .then(() => worker(item))
            .catch((e) => {
              failure ??= e;
            })
            .finally(() => {
              active--;
              pump();
            });
        }
        if (!active && (failure || !canStart() || next === items.length)) {
          finished = true;
          resolve();
        }
      };
      const off = subscribe?.(pump);
      signal.addEventListener('abort', pump, { once: true });
      unsubscribe = () => {
        off?.();
        signal.removeEventListener('abort', pump);
      };
      pump();
    });
  } finally {
    unsubscribe?.();
  }
  if (failure) throw failure;
}
