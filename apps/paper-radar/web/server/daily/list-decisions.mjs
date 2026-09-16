// Detail reports add evidence and opinions; they never change daily list membership.
// Keep final_decision as the compatibility field for the initial screening result.
export function migrateDailyListDecisions(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 4) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(`
      SELECT i.id, i.data, v.data AS screening
      FROM daily_items i
      LEFT JOIN daily_item_versions v
        ON v.id = json_extract(i.data, '$.screening_version_id')
    `)
      .all();
    const update = db.prepare(
      'UPDATE daily_items SET decision=?,data=? WHERE id=?',
    );
    for (const row of rows) {
      const item = JSON.parse(row.data);
      const outcome = row.screening
        ? JSON.parse(row.screening).data.outcome
        : null;
      item.analysis_decision =
        item.decision_basis === 'full_text'
          ? (item.final_decision ?? 'undetermined')
          : null;
      item.final_decision = ['recommended', 'not_recommended'].includes(outcome)
        ? outcome
        : null;
      item.decision_basis = row.screening ? 'abstract' : null;
      update.run(item.final_decision, JSON.stringify(item), row.id);
    }
    db.exec('PRAGMA user_version = 4; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
