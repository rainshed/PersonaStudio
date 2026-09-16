// Only transitions create notifications: importing historical rows stays quiet.
export function migrateEvaluationNotifications(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS notify_evaluation_runs_terminal AFTER UPDATE OF data ON evaluation_runs
    WHEN json_extract(OLD.data,'$.status') IN ('queued','running')
      AND json_extract(NEW.data,'$.status') IN ('completed','partial','failed','interrupted','paused','cancelled')
    BEGIN
      INSERT INTO notifications(kind,task_id,target_id,title,status,created_at)
      VALUES ('evaluation',NEW.id,NEW.id,
        COALESCE((SELECT json_extract(data,'$.name') FROM evaluation_suites WHERE id=json_extract(NEW.data,'$.suite_id')),'推荐评测'),
        json_extract(NEW.data,'$.status'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    END;
    CREATE TRIGGER IF NOT EXISTS notify_evaluation_runs_deleted AFTER DELETE ON evaluation_runs
    BEGIN DELETE FROM notifications WHERE kind='evaluation' AND task_id=OLD.id; END;
  `);
}
