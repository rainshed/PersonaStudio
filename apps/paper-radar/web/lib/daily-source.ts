export type DailySource =
  | { kind: 'latest_announcement' }
  | { kind: 'announcement_date'; date: string }
  | { kind: 'stored_batch'; batch_id: string; revision_id?: string };

export function isAnnouncementDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

// Announcement labels are calendar dates, never submission timestamps or a
// rolling 24-hour window. UTC bounds also work across phone time zones.
export const announcementToday = () => new Date().toISOString().slice(0, 10);

export function dailySource(
  date: string,
  stored?: { batch_id: string; revision_id: string } | null,
): DailySource {
  if (stored)
    return {
      kind: 'stored_batch',
      batch_id: stored.batch_id,
      revision_id: stored.revision_id,
    };
  return date
    ? { kind: 'announcement_date', date }
    : { kind: 'latest_announcement' };
}

export function matchesDailyDate(
  run: { source?: DailySource; date?: string },
  date: string,
) {
  return date
    ? (run.source?.kind === 'announcement_date'
        ? run.source.date
        : run.date) === date
    : !run.source || run.source.kind === 'latest_announcement';
}
