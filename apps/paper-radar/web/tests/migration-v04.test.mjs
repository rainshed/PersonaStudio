import { DATABASE_VERSION } from '../server/storage/migrations.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AnalysisDatabase } from '../server/analyses/database.mjs';
import { fixture } from './helpers/daily-fixture.mjs';
void test('v2 migration cancels only unrequested legacy daily work and preserves saved report bodies and feedback', async (t) => {
  const f = await fixture(t, { count: 2, outcome: 'recommended' });
  const run = await f.finish(f.create().run.id);
  const completed = await f.detail(f.daily.items(run.id).items[0].id);
  f.db.setFeedback(completed.analysis_id, 'summary', {
    value: 'positive',
  });
  const untouched = JSON.stringify(f.db.result(completed.analysis_id));
  const item = f.daily.items(run.id).items[1];
  // Stop the worker, then seed a v2 queued automatic job as it would be persisted before shutdown.
  await f.analyses.close();
  const legacy = {
    ...f.db.job(completed.job_id),
    id: 'legacy-auto-job',
    result_id: null,
    status: 'queued',
    origin: { daily_run_id: run.id, daily_item_id: item.id },
    stages: [{ id: 'summary', status: 'pending' }],
  };
  f.db.insertJob(legacy, 'legacy-auto-key', 'legacy-hash');
  item.job_id = legacy.id;
  item.processing_status = 'awaiting_analysis';
  item.details_status = 'queued';
  f.repo.saveItem(item);
  const oldRun = f.repo.get('daily_runs', run.id);
  oldRun.status = 'partial';
  delete oldRun.workflow_version;
  f.repo.saveRun(oldRun);
  const dir = await mkdtemp(join(tmpdir(), 'radar-v2-migrate-'));
  const filename = join(dir, 'radar.sqlite');
  f.db.db.exec("VACUUM INTO '" + filename.replaceAll("'", "''") + "'");
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(filename);
  raw.exec('DROP TABLE daily_screening_links; DROP TABLE daily_screening_claims;');
  raw.exec('DROP TABLE automatic_attempt_reservations; DROP TABLE schedule_updates; DROP TABLE schedule_source_cursors; DROP TABLE schedule_requests; DROP TABLE schedule_checks; DROP TABLE daily_schedules;');
  raw.exec(
    'DROP TABLE discussion_requests; DROP TABLE discussion_turns; DROP TABLE discussions; DROP TABLE daily_detail_requests; PRAGMA user_version=2',
  );
  raw.close();
  const upgraded = await new AnalysisDatabase(dir).open();
  try {
    assert.equal(upgraded.job(legacy.id).status, 'cancelled');
    assert.equal(
      JSON.stringify(upgraded.result(completed.analysis_id)),
      untouched,
    );
    assert.equal(
      upgraded.feedback(completed.analysis_id).summary.value,
      'positive',
    );
    assert.equal(
      JSON.parse(
        upgraded.db
          .prepare('SELECT data FROM daily_runs WHERE id=?')
          .get(run.id).data,
      ).status,
      'completed',
    );
    assert.equal(
      upgraded.db.prepare('PRAGMA user_version').get().user_version,
      DATABASE_VERSION,
    );
  } finally {
    await upgraded.close();
    await rm(dir, { recursive: true, force: true });
  }
});
