export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;

export function validConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENCY;
}
