import { AnalysisError } from './contracts.mjs';

// A read-only view of existing human feedback, without adding evaluation state.
export function listResearchFeedback(
  db,
  { limit = 25, offset = 0, dimension = '', value = '', query = '' } = {},
) {
  if (
    (dimension &&
      !['accuracy', 'summary', 'reason', 'connections'].includes(dimension)) ||
    (value && !['positive', 'negative'].includes(value))
  )
    throw new AnalysisError('invalid_request', '反馈筛选条件无效。');
  const hasDaily = !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_feedback'",
    )
    .get();
  const source = `SELECT 'analysis' AS kind, r.id AS version_id, r.job_id, NULL AS item_id, NULL AS run_id, NULL AS subscription_id, NULL AS date,
    json_extract(r.data,'$.paper.title') AS title, json_extract(r.data,'$.paper.id') AS paper_id,
    f.dimension, f.data AS feedback, json_extract(f.data,'$.updatedAt') AS updated_at
    FROM feedback f JOIN results r ON r.id=f.result_id
    ${
      hasDaily
        ? `UNION ALL SELECT 'screening', v.id, NULL, i.id, i.run_id, json_extract(r.data,'$.subscription.id'), json_extract(r.data,'$.date'),
      json_extract(i.data,'$.paper.title'), i.paper_id, f.dimension, f.data, json_extract(f.data,'$.updatedAt')
      FROM daily_feedback f JOIN daily_item_versions v ON v.id=f.version_id JOIN daily_items i ON i.id=v.item_id JOIN daily_runs r ON r.id=i.run_id`
        : ''
    }`;
  const where = `WHERE (?='' OR dimension=?) AND (?='' OR json_extract(feedback,'$.value')=?) AND (?='' OR instr(lower(coalesce(title,'') || ' ' || coalesce(json_extract(feedback,'$.reason'),'')),lower(?))>0)`;
  const bindings = [dimension, dimension, value, value, query, query];
  const total = db
    .prepare(`SELECT count(*) AS n FROM (${source}) ${where}`)
    .get(...bindings).n;
  const items = db
    .prepare(
      `SELECT * FROM (${source}) ${where} ORDER BY updated_at DESC, version_id, dimension LIMIT ? OFFSET ?`,
    )
    .all(...bindings, limit, offset)
    .map((row) => ({ ...row, feedback: JSON.parse(row.feedback) }));
  return {
    items,
    total,
    next_offset: offset + items.length < total ? offset + limit : null,
  };
}
