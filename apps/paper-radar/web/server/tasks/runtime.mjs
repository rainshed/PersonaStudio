import { withTaskContext } from './context.mjs';

/** Coordinates persistent domain queues. Hosts own their execution-capacity limits;
 * this runtime owns admission, task lifecycle and observable queue failures. */
export class TaskRuntime {
  constructor({ subscribe, now = Date.now, agingMs = 10000 } = {}) {
    this.queues = new Map();
    this.active = new Map();
    this.failedAdmissions = new Set();
    this.now = now;
    this.agingMs = agingMs;
    this.scheduled = false;
    this.closed = false;
    this.closing = false;
    this.unsubscribe = subscribe?.(() => this.wake());
  }

  register(kind, options) {
    if (this.closed || this.closing || this.queues.has(kind))
      throw new Error(`Task queue cannot be registered: ${kind}`);
    const queue = {
      kind, options, enabled: false, closed: false, stopped: false,
      waiters: [], settling: new Set(), lastError: null,
    };
    this.queues.set(kind, queue);
    queue.abort = () => this.wake();
    options.signal?.addEventListener('abort', queue.abort, { once: true });
    return {
      wake: () => {
        if (!queue.closed && !this.closing && !options.signal?.aborted)
          queue.enabled = true;
        this.wake();
        return this.idle(queue);
      },
      idle: () => this.idle(queue),
      close: () => this.closeQueue(queue),
    };
  }

  wake() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  pending(queue) {
    if (!queue.enabled || queue.closed || queue.options.signal?.aborted)
      return [];
    try {
      return queue.options.pending().filter((task) =>
        !this.active.has(`${queue.kind}:${task.id}`) &&
        !this.failedAdmissions.has(`${queue.kind}:${task.id}`),
      );
    } catch (error) {
      // A repository outage is a queue fault, not an event-loop exception.
      // Only an explicit queue wake retries it; unrelated task completions do
      // not repeatedly query a broken repository or starve healthy lanes.
      queue.lastError = { message: error.message, phase: 'pending' };
      queue.enabled = false;
      return [];
    }
  }

  current(queue, task) {
    try {
      return queue.options.get ? queue.options.get(task.id) : task;
    } catch (error) {
      if (error.code === 'not_found') return null;
      throw error;
    }
  }

  fail(queue, task, error) {
    const key = `${queue.kind}:${task.id}`;
    if (this.failedAdmissions.has(key)) return;
    this.failedAdmissions.add(key);
    queue.lastError = { id: task.id, message: error.message, phase: 'task' };
    // Persistence can itself be asynchronous or fail. Keep it visible to idle
    // and shutdown without leaving an unhandled rejected callback promise.
    const work = Promise.resolve().then(() => queue.options.onError?.(task, error))
      .catch((failure) => {
        queue.lastError = { id: task.id, message: failure.message, phase: 'onError' };
      }).finally(() => {
        queue.settling.delete(work);
        this.wake();
      });
    queue.settling.add(work);
  }

  idle(queue) {
    if (!this.isBusy(queue)) return Promise.resolve();
    return new Promise((resolve) => queue.waiters.push(resolve));
  }

  isBusy(queue) {
    return queue.settling.size > 0 ||
      [...this.active.values()].some((entry) => entry.queue === queue) ||
      this.pending(queue).length > 0;
  }

  candidates({ handleErrors = true } = {}) {
    const entries = [];
    for (const queue of this.queues.values()) {
      for (const task of this.pending(queue)) {
        try {
          const requested = queue.options.priority?.(task) ?? 10;
          const priority = Number.isFinite(requested) ? requested : 10;
          const created = Date.parse(task.created_at);
          const age = Number.isFinite(created) ? Math.max(0, this.now() - created) : 0;
          entries.push({
            queue, task, priority,
            score: priority + Math.floor(age / this.agingMs),
            key: `${queue.kind}:${task.id}`,
            group: queue.options.group?.(task) ?? queue.kind,
            exclusive: queue.options.exclusive?.(task) ?? null,
          });
        } catch (error) {
          if (handleErrors) this.fail(queue, task, error);
        }
      }
    }
    // Stable sort preserves repository FIFO (including rowid ordering when
    // timestamps match). Random task identifiers must never reorder turns.
    return entries.sort((a, b) => b.score - a.score ||
      String(a.task.created_at).localeCompare(String(b.task.created_at)));
  }

  pump() {
    if (this.closed) return;
    for (const entry of this.candidates()) {
      const { queue, task, group, exclusive, key, priority } = entry;
      if (queue.closed || this.active.has(key) || this.failedAdmissions.has(key)) continue;
      try {
        const running = [...this.active.values()];
        const configured = queue.options.concurrency?.(task) ?? 1;
        if (!Number.isFinite(configured) || configured < 1)
          throw new Error(`Task queue concurrency is invalid: ${queue.kind}`);
        const limit = Math.floor(configured);
        const queueLimit = queue.options.maxActive ?? Infinity;
        if (running.filter((value) => value.group === group).length >= limit ||
            running.filter((value) => value.queue === queue).length >= queueLimit ||
            (exclusive && running.some((value) => value.exclusive === exclusive)))
          continue;
        const current = this.current(queue, task);
        if (!current || current.status !== 'queued') continue;
        this.active.set(key, { ...entry, startedAt: this.now() });
        void Promise.resolve().then(() => {
          if (queue.closed || this.closing || queue.options.signal?.aborted) return;
          const latest = this.current(queue, current);
          if (!latest || latest.status !== 'queued') return;
          return withTaskContext({ kind: queue.kind, id: task.id, priority },
            () => queue.options.run(latest));
        }).catch((error) => {
          this.fail(queue, task, error);
        }).finally(() => {
          this.active.delete(key);
          this.wake();
        });
      } catch (error) {
        this.fail(queue, task, error);
      }
    }
    for (const queue of this.queues.values()) {
      if (!this.isBusy(queue)) queue.waiters.splice(0).forEach((resolve) => resolve());
    }
  }

  retry(kind, id) {
    this.failedAdmissions.delete(`${kind}:${id}`);
    const queue = this.queues.get(kind);
    if (queue && !queue.closed && !this.closing) queue.enabled = true;
    this.wake();
  }

  snapshot() {
    const active = [...this.active.values()].map((entry) => ({
      kind: entry.queue.kind, id: entry.task.id, priority: entry.priority,
      state: 'running', started_at: new Date(entry.startedAt).toISOString(),
      pool: entry.group,
    }));
    const queued = this.candidates({ handleErrors: false }).map((entry) => ({
      kind: entry.queue.kind, id: entry.task.id, priority: entry.priority,
      state: 'queued', created_at: entry.task.created_at, pool: entry.group,
    }));
    const errors = [...this.queues.values()].filter((queue) => queue.lastError)
      .map((queue) => ({ kind: queue.kind, ...queue.lastError }));
    return { active, queued, errors };
  }

  stopQueue(queue) {
    queue.closed = true;
    queue.options.signal?.removeEventListener('abort', queue.abort);
    if (queue.stopped) return;
    queue.stopped = true;
    try { queue.options.stop?.(); }
    catch (error) { queue.lastError = { message: error.message, phase: 'stop' }; }
  }

  closeQueue(queue) {
    if (queue.closing) return queue.closing;
    this.stopQueue(queue);
    this.wake();
    queue.closing = this.idle(queue).then(() => {
      queue.waiters.splice(0).forEach((resolve) => resolve());
      this.queues.delete(queue.kind);
      for (const key of this.failedAdmissions)
        if (key.startsWith(`${queue.kind}:`)) this.failedAdmissions.delete(key);
    });
    return queue.closing;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.unsubscribe?.();
    for (const queue of this.queues.values()) this.stopQueue(queue);
    this.wake();
    this.closePromise = Promise.all([...this.queues.values()].map((queue) => this.idle(queue)))
      .then(() => {
        for (const queue of this.queues.values())
          queue.waiters.splice(0).forEach((resolve) => resolve());
        this.closed = true;
      });
    return this.closePromise;
  }
}
