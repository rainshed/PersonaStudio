const formatters = new Map();
const occurrences = new Map();
export function validTimezone(zone) {
  if (typeof zone !== 'string' || zone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
export function localParts(ms, zone) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
    );
  const parts = Object.fromEntries(
    formatters
      .get(zone)
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
function occurrence(date, time, zone) {
  const key = `${date}/${time}/${zone}`;
  if (occurrences.has(key)) return occurrences.get(key);
  const midnight = Date.parse(date + 'T00:00:00Z');
  // Enumerate UTC minutes in chronological order: first repeated wall time wins;
  // a skipped wall time moves to the first valid minute on that local date.
  let value = null;
  for (
    let ms = midnight - 16 * 3600000;
    ms <= midnight + 40 * 3600000;
    ms += 60000
  ) {
    const p = localParts(ms, zone);
    if (p.date === date && p.time >= time) {
      value = ms;
      break;
    }
  }
  if (occurrences.size > 512) occurrences.clear();
  occurrences.set(key, value);
  return value;
}
export function nextOccurrence(after, time, zone) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !validTimezone(zone))
    throw new Error('Invalid schedule time');
  const date = localParts(after, zone).date;
  for (let i = 0; i < 4; i++) {
    const day = new Date(Date.parse(date + 'T12:00:00Z') + i * 86400000)
      .toISOString()
      .slice(0, 10);
    const ms = occurrence(day, time, zone);
    if (ms !== null && ms > after) return new Date(ms).toISOString();
  }
  throw new Error('No future schedule occurrence');
}
