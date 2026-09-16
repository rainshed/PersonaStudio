export type PollResult = void | false | number;

/** One request at a time, scheduled from completion. Stopping also invalidates
 * late responses; consumers check signal.aborted before publishing results. */
export function startRequestPolling({
  run,
  intervalMs,
  initialDelayMs = 0,
  onError = () => {},
  schedule = setTimeout,
  unschedule = clearTimeout,
}: {
  run: (signal: AbortSignal) => Promise<PollResult>;
  intervalMs: number;
  initialDelayMs?: number;
  onError?: (error: unknown) => void;
  schedule?: typeof setTimeout;
  unschedule?: typeof clearTimeout;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let failures = 0;
  const enqueue = (delay: number) => {
    timer = schedule(() => void execute(), delay);
  };
  const execute = async () => {
    if (controller.signal.aborted || pending) return;
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    pending = true;
    let next: PollResult;
    try {
      next = await run(controller.signal);
      failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) onError(error);
      failures += 1;
      next = Math.min(intervalMs * 2 ** Math.min(failures - 1, 4), 30000);
    } finally {
      pending = false;
    }
    if (!controller.signal.aborted && next !== false)
      enqueue(typeof next === 'number' ? next : intervalMs);
  };
  enqueue(initialDelayMs);
  return {
    wake: () => void execute(),
    stop: () => {
      controller.abort();
      if (timer !== undefined) unschedule(timer);
    },
  };
}
