import { randomUUID } from 'node:crypto';
import { AnalysisError, hash } from '../analyses/contracts.mjs';

export function migrateEvaluations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS screening_inputs (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_cases (id TEXT PRIMARY KEY, subject_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_case_revisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_feedback_events (id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_suites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS evaluation_run_request_key ON evaluation_runs(json_extract(data,'$.request_key')) WHERE json_extract(data,'$.request_key') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS evaluation_run_items (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
}
export const stamp = () => new Date().toISOString();
export const identifier = (kind) => `${kind}-${randomUUID()}`;
export function storeScreeningInput(db, payload) {
  const copy = structuredClone(payload);
  delete copy.captured_at;
  const digest = hash(copy),
    id = `screen-input-${digest}`;
  const value = { id, hash: digest, ...copy };
  db.prepare('INSERT OR IGNORE INTO screening_inputs VALUES (?,?,?)').run(
    id,
    digest,
    JSON.stringify(value),
  );
  return value;
}
const tables = new Set([
  'evaluation_cases',
  'evaluation_drafts',
  'evaluation_case_revisions',
  'evaluation_suites',
  'evaluation_runs',
  'evaluation_run_items',
  'screening_inputs',
]);
export class EvaluationRepository {
  constructor(database) {
    this.database = database;
    this.db = database.db;
  }
  get(table, id, required = true) {
    if (!tables.has(table)) throw new Error('Invalid evaluation table');
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row && required)
      throw new AnalysisError('not_found', '评测记录不存在。', false, 404);
    return row ? JSON.parse(row.data) : null;
  }
  all(table) {
    if (!tables.has(table)) throw new Error('Invalid evaluation table');
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`)
      .all()
      .map((r) => JSON.parse(r.data));
  }
  put(table, value) {
    if (
      !tables.has(table) ||
      ['screening_inputs', 'evaluation_cases'].includes(table)
    )
      throw new Error('Invalid evaluation table');
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  subject(key) {
    const row = this.db
      .prepare('SELECT data FROM evaluation_cases WHERE subject_key=?')
      .get(key);
    return row ? JSON.parse(row.data) : null;
  }
  putCase(value) {
    this.db
      .prepare(
        'INSERT INTO evaluation_cases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(value.id, value.subject_key, JSON.stringify(value));
    return value;
  }
}
