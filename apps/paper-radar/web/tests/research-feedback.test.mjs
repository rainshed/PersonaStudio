import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listResearchFeedback } from '../server/analyses/research-feedback.mjs';
import { analysisRoute } from '../server/analyses/http.mjs';
import { radarHash, readRadarLocation } from '../lib/radar-location.ts';

function fixture(daily = true) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE results (id TEXT,job_id TEXT,data TEXT); CREATE TABLE feedback (result_id TEXT,dimension TEXT,data TEXT);`,
  );
  db.prepare('INSERT INTO results VALUES (?,?,?)').run(
    'report-1',
    'job-1',
    JSON.stringify({ paper: { title: 'A_ paper', id: '1234.56789' } }),
  );
  db.prepare('INSERT INTO feedback VALUES (?,?,?)').run(
    'report-1',
    'summary',
    JSON.stringify({
      value: 'negative',
      reason: 'Missing assumptions',
      updatedAt: '2026-09-09T12:00:00Z',
      component_version: 'summary-v1',
    }),
  );
  if (daily) {
    db.exec(
      `CREATE TABLE daily_runs (id TEXT,data TEXT); CREATE TABLE daily_items (id TEXT,run_id TEXT,paper_id TEXT,data TEXT); CREATE TABLE daily_item_versions (id TEXT,item_id TEXT); CREATE TABLE daily_feedback (version_id TEXT,dimension TEXT,data TEXT);`,
    );
    db.prepare('INSERT INTO daily_runs VALUES (?,?)').run(
      'run-1',
      JSON.stringify({ subscription: { id: 'sub-1' }, date: '2026-09-08' }),
    );
    db.prepare('INSERT INTO daily_items VALUES (?,?,?,?)').run(
      'item-1',
      'run-1',
      '2345.67890',
      JSON.stringify({ paper: { title: 'Second paper' } }),
    );
    db.prepare('INSERT INTO daily_item_versions VALUES (?,?)').run(
      'screen-v1',
      'item-1',
    );
    db.prepare('INSERT INTO daily_feedback VALUES (?,?,?)').run(
      'screen-v1',
      'accuracy',
      JSON.stringify({
        value: 'positive',
        reason: '',
        updatedAt: '2026-09-09T13:00:00Z',
        component_version: 'screen-v1',
      }),
    );
  }
  return db;
}

void test('feedback overview retains exact saved version, dimension and navigation context without writing', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    const first = listResearchFeedback(db, { limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.next_offset, 1);
    assert.equal(first.items[0].version_id, 'screen-v1');
    assert.equal(first.items[0].subscription_id, 'sub-1');
    assert.equal(first.items[0].item_id, 'item-1');
    assert.equal(first.items[0].feedback.component_version, 'screen-v1');
    const second = listResearchFeedback(db, { limit: 1, offset: 1 });
    assert.equal(second.items[0].job_id, 'job-1');
    assert.equal(second.items[0].dimension, 'summary');
    assert.equal(second.next_offset, null);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  } finally {
    db.close();
  }
});

void test('feedback filters distinguish no feedback from negative and search literal text', async () => {
  const db = fixture();
  try {
    assert.equal(listResearchFeedback(db, { value: 'negative' }).total, 1);
    assert.equal(
      listResearchFeedback(db, { dimension: 'connections' }).total,
      0,
    );
    assert.equal(listResearchFeedback(db, { query: 'assumptions' }).total, 1);
    assert.equal(listResearchFeedback(db, { query: '%' }).total, 0);
    assert.throws(
      () => listResearchFeedback(db, { value: 'unknown' }),
      /筛选条件/,
    );
    const response = await analysisRoute(
      { db: { db } },
      { method: 'GET', headers: {} },
      new URL(
        'http://localhost/api/analyses/feedback?dimension=summary&limit=1',
      ),
      () => {
        throw Error('must not read a body');
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.items[0].version_id, 'report-1');
    await assert.rejects(
      analysisRoute(
        { db: { db } },
        { method: 'GET', headers: {} },
        new URL('http://localhost/api/analyses/feedback?limit=0'),
        () => null,
      ),
      /分页/,
    );
  } finally {
    db.close();
  }
});

void test('feedback view supports databases without the optional daily tables', () => {
  const db = fixture(false);
  try {
    assert.equal(listResearchFeedback(db).total, 1);
  } finally {
    db.close();
  }
});

void test('paper selection, reader section and job survive URL round trips', () => {
  const location = {
    view: 'daily',
    subscription: 'sub&1',
    run: 'run-1',
    date: '2026-09-09',
    filter: 'not_recommended',
    paper: 'item/1',
    section: 'report',
    expanded: true,
    job: 'job-1',
  };
  assert.deepEqual(readRadarLocation(radarHash(location)), location);
  assert.equal(readRadarLocation('#daily?section=discussion').section, 'overview');
  assert.equal(
    readRadarLocation('#daily?section=bad&expanded=no').section,
    'overview',
  );
  assert.equal(
    readRadarLocation('#daily?section=bad&expanded=no').expanded,
    false,
  );
  assert.equal(readRadarLocation('#evaluations').view, 'evaluations');
  const settings = { ...location, view: 'models', settingsTab: 'persona' };
  assert.deepEqual(readRadarLocation(radarHash(settings)), settings);
  assert.equal(readRadarLocation('#models?tab=persona').settingsTab, 'persona');
  assert.equal(readRadarLocation('#models?tab=unknown').settingsTab, undefined);
});
