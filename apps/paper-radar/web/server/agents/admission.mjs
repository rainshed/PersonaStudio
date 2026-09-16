/** Fair admission shared by host adapters. Older background work eventually
 * outranks incoming interactive work; equal priorities remain FIFO. */
export class PriorityAdmission {
  constructor({ limit, now = Date.now, agingMs = 30000 } = {}) {
    this.limit = limit ?? (() => 1);
    this.now = now;
    this.agingMs = agingMs;
    this.running = 0;
    this.waiters = [];
    this.sequence = 0;
  }

  acquire(signal, priority = 10) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        priority: Number.isFinite(priority) ? Math.min(30, Math.max(0, priority)) : 10,
        queuedAt: this.now(),
        sequence: this.sequence++,
        grant: () => {
          signal.removeEventListener('abort', abort);
          this.running++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.running--;
            this.drain();
          });
        },
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      this.drain();
    });
  }

  drain() {
    const now = this.now();
    const effective = (item) => item.priority + Math.floor((now - item.queuedAt) / this.agingMs);
    this.waiters.sort((a, b) => effective(b) - effective(a) || a.sequence - b.sequence);
    while (this.running < this.limit() && this.waiters.length) this.waiters.shift().grant();
  }
}

/** Close the already-aborted-before-listener race and release the listener on
 * either outcome. A completed unbounded task must not retain abort listeners. */
export async function waitForCompletion(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? new Error('Task aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
