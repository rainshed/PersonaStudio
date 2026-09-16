export function elapsedTime(
  start: string | null | undefined,
  now: number,
): string {
  const value = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(value)) return '—';
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  const minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  return (
    (hours
      ? hours + ':' + String(minutes % 60).padStart(2, '0')
      : String(minutes).padStart(2, '0')) +
    ':' +
    String(seconds % 60).padStart(2, '0')
  );
}
