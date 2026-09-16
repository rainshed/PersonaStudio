import { dailyStatusSchema } from '../../lib/contracts/task.ts';
import { randomUUID } from 'node:crypto';
import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { now } from './contracts.mjs';
import { subscriptionSubjects } from '../../lib/subscription-subjects.ts';
import { matchedFollowedAuthors } from '../../lib/author-following.ts';
import {
  analysisConfig,
  contentFingerprint,
  screenModelFingerprint,
} from './scheduler/source-check.mjs';
import { screeningPromptFingerprint } from './agent-screening.mjs';
import { AGENT_SCREEN_VERSION } from '@paper-radar/host-contract/agent-contract';

export function migrateDaily(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= 2) return;
  db.exec(`BEGIN;
    CREATE TABLE subscriptions (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE arxiv_feed_snapshots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE arxiv_batches (id TEXT PRIMARY KEY, subject TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(subject,date));
    CREATE TABLE arxiv_batch_revisions (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES arxiv_batches(id), content_hash TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(batch_id,content_hash));
    CREATE TABLE arxiv_announcements (revision_id TEXT NOT NULL REFERENCES arxiv_batch_revisions(id), paper_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(revision_id,paper_id));
    CREATE TABLE daily_reports (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), batch_id TEXT NOT NULL REFERENCES arxiv_batches(id), created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(subscription_id,batch_id));
    CREATE INDEX idx_daily_reports_subscription_created ON daily_reports(subscription_id,created_at DESC);
    CREATE TABLE daily_runs (id TEXT PRIMARY KEY, report_id TEXT REFERENCES daily_reports(id) ON DELETE CASCADE, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX idx_daily_runs_status_created ON daily_runs(status,created_at);
    CREATE INDEX idx_daily_runs_report_created ON daily_runs(report_id,created_at DESC);
    CREATE TABLE daily_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES daily_runs(id) ON DELETE CASCADE);
    CREATE TABLE daily_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES daily_runs(id) ON DELETE CASCADE, paper_id TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, job_id TEXT REFERENCES jobs(id), data TEXT NOT NULL, UNIQUE(run_id,paper_id));
    CREATE INDEX idx_daily_items_run_decision ON daily_items(run_id,decision);
    CREATE TABLE daily_item_versions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES daily_items(id) ON DELETE CASCADE, analysis_id TEXT REFERENCES results(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX idx_daily_versions_item ON daily_item_versions(item_id,created_at);
    CREATE INDEX idx_daily_versions_analysis ON daily_item_versions(analysis_id);
    CREATE TABLE daily_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES daily_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE INDEX idx_daily_attempts_run ON daily_attempts(run_id);
    CREATE TABLE daily_feedback (version_id TEXT NOT NULL REFERENCES daily_item_versions(id) ON DELETE CASCADE, dimension TEXT NOT NULL CHECK(dimension IN ('accuracy','reason')), data TEXT NOT NULL, PRIMARY KEY(version_id,dimension));
    PRAGMA user_version = 2;
    COMMIT;`);
}
const decode = (row) => (row ? JSON.parse(row.data) : null);
const tables = new Set([
  'subscriptions',
  'arxiv_feed_snapshots',
  'arxiv_batches',
  'arxiv_batch_revisions',
  'daily_reports',
  'daily_runs',
  'daily_items',
  'daily_item_versions',
]);
export class DailyRepository {
  constructor(analysisDb) {
    this.analysisDb = analysisDb;
    this.db = analysisDb.db;
  }
  get(table, id, required = true) {
    if (!tables.has(table)) throw new Error('Invalid table');
    const value = decode(
      this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id),
    );
    if (!value && required)
      throw new AnalysisError('not_found', '记录不存在。', false, 404);
    return value;
  }
  saveSubscription(value) {
    this.db
      .prepare(
        'INSERT INTO subscriptions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(value.id, value.status, value.created_at, JSON.stringify(value));
    return value;
  }
  subscriptions() {
    return this.db
      .prepare('SELECT data FROM subscriptions ORDER BY created_at')
      .all()
      .map(decode);
  }
  archiveFeed(feed) {
    return this.analysisDb.transaction(() => {
      const sourceId = 'feed-' + feed.source_hash;
      this.db
        .prepare('INSERT OR IGNORE INTO arxiv_feed_snapshots VALUES (?,?,?)')
        .run(
          sourceId,
          now(),
          JSON.stringify({ ...feed, groups: undefined, fetched_at: now() }),
        );
      return feed.groups.map((group) => {
        return this.archiveGroup(group, {
          id: sourceId,
          url: feed.url,
          hash: feed.source_hash,
          parser: feed.parser_version,
        });
      });
    });
  }
  followedAuthorPapers(subscription) {
    const subjects = subscriptionSubjects(subscription);
    if (!subjects.length || !subscription.followed_authors?.length) return [];
    // Select one revision per category/day, using the same coverage preference
    // as dated discovery. Read announcements directly, before model screening.
    const rows = this.db.prepare(`
      SELECT a.data FROM arxiv_batches b
      JOIN arxiv_batch_revisions r ON r.id=(
        SELECT current.id FROM arxiv_batch_revisions current
        WHERE current.batch_id=b.id
        ORDER BY (json_extract(current.data,'$.completeness')='complete') DESC,
          current.created_at DESC, current.rowid DESC LIMIT 1
      )
      JOIN arxiv_announcements a ON a.revision_id=r.id
      WHERE b.subject IN (${subjects.map(() => '?').join(',')})
      ORDER BY b.date DESC, b.subject, a.paper_id
    `).iterate(...subjects);
    const papers = new Map();
    for (const row of rows) {
      const paper = decode(row);
      const matched = matchedFollowedAuthors(paper, subscription);
      if (!matched.length) continue;
      const old = papers.get(paper.id);
      if (old && old.version === paper.version) {
        old.matched_subjects = [...new Set([...old.matched_subjects,
          ...subjects.filter((s) => paper.categories.includes(s))])].sort((a, b) => a.localeCompare(b));
        old.matched_authors = [...new Set([...old.matched_authors, ...matched])];
        old.categories = [...new Set([...old.categories, ...paper.categories])].sort((a, b) => a.localeCompare(b));
      }
      if (old && (old.version > paper.version ||
        (old.version === paper.version && old.date >= paper.date))) continue;
      papers.set(paper.id, {
        ...paper,
        matched_authors: matched,
        matched_subjects: subjects.filter((s) => paper.categories.includes(s)),
      });
    }
    return [...papers.values()].sort((a, b) =>
      b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }
  authorSources(subjects) {
    return subjects.map((subject) => {
      const latest = this.db.prepare(
        'SELECT date FROM arxiv_batches WHERE subject=? ORDER BY date DESC LIMIT 1',
      ).get(subject);
      const revision = latest ? this.announcementForDate(subject, latest.date) : null;
      return {
        subject,
        date: revision?.date ?? null,
        completeness: revision?.completeness ?? 'unavailable',
        issues: revision?.issues ?? [],
      };
    });
  }
  announcementForDate(subject, date) {
    const row = this.db
      .prepare(`
      SELECT r.data FROM arxiv_batches b
      JOIN arxiv_batch_revisions r ON r.batch_id=b.id
      WHERE b.subject=? AND b.date=?
      ORDER BY (json_extract(r.data,'$.completeness')='complete') DESC,
        r.created_at DESC, r.rowid DESC LIMIT 1
    `)
      .get(subject, date);
    return row ? decode(row) : null;
  }
  availableAnnouncementDates(subjects) {
    const selected = [...new Set(subjects)];
    if (!selected.length) return [];
    return this.db
      .prepare(`
      SELECT b.date FROM arxiv_batches b
      JOIN arxiv_batch_revisions r ON r.batch_id=b.id
      WHERE b.subject IN (${selected.map(() => '?').join(',')})
        AND json_extract(r.data,'$.completeness')='complete'
      GROUP BY b.date HAVING COUNT(DISTINCT b.subject)=?
      ORDER BY b.date DESC
    `)
      .all(...selected, selected.length)
      .map((row) => row.date);
  }
  archiveGroup(group, source) {
    const batchId =
      'batch-' +
      hash({ subject: group.subject, date: group.date }).slice(0, 32);
    const revisionId =
      'batchrev-' + hash({ batchId, content: group.content_hash }).slice(0, 32);
    const batch = {
      id: batchId,
      subject: group.subject,
      date: group.date,
      revision_id: revisionId,
    };
    this.db
      .prepare(
        'INSERT INTO arxiv_batches VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(batchId, group.subject, group.date, JSON.stringify(batch));
    const revision = {
      ...group,
      id: revisionId,
      batch_id: batchId,
      source_id: source.id,
      source_url: source.url,
      source_hash: source.hash,
      parser_version: source.parser,
      created_at: now(),
    };
    this.db
      .prepare('INSERT OR IGNORE INTO arxiv_batch_revisions VALUES (?,?,?,?,?)')
      .run(
        revisionId,
        batchId,
        group.content_hash,
        revision.created_at,
        JSON.stringify(revision),
      );
    for (const paper of group.papers)
      this.db
        .prepare('INSERT OR IGNORE INTO arxiv_announcements VALUES (?,?,?)')
        .run(revisionId, paper.id, JSON.stringify(paper));
    return this.get('arxiv_batch_revisions', revisionId);
  }
  archiveSubjectBundle(group) {
    return this.analysisDb.transaction(() => {
      const id = 'bundle-source-' + group.content_hash;
      const source = {
        kind: 'subject_bundle',
        subjects: group.subjects,
        sources: group.sources,
        created_at: now(),
      };
      this.db
        .prepare('INSERT OR IGNORE INTO arxiv_feed_snapshots VALUES (?,?,?)')
        .run(id, now(), JSON.stringify(source));
      return this.archiveGroup(group, {
        id,
        url: group.sources.find((s) => s.status === 'included')?.source_url,
        hash: group.content_hash,
        parser: 'arxiv-subject-bundle-v1',
      });
    });
  }
  runForKey(key, requestHash) {
    const row = this.db
      .prepare('SELECT * FROM daily_requests WHERE key=?')
      .get(key);
    if (!row) return null;
    if (row.request_hash !== requestHash)
      throw new AnalysisError(
        'conflict',
        '该请求标识已用于其他参数。',
        false,
        409,
      );
    return this.get('daily_runs', row.run_id);
  }
  addRequest(key, requestHash, runId) {
    this.db
      .prepare('INSERT INTO daily_requests VALUES (?,?,?)')
      .run(key, requestHash, runId);
  }
  saveRun(run) {
    dailyStatusSchema.parse(run.status);
    const old = this.get('daily_runs', run.id, false);
    if (old?.status === 'cancelled' && run.status !== 'queued') return old;
    run.actual_attempts = Math.max(
      run.actual_attempts ?? 0,
      old?.actual_attempts ?? 0,
    );
    run.updated_at = now();
    this.db
      .prepare(
        'INSERT INTO daily_runs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET report_id=excluded.report_id,status=excluded.status,data=excluded.data',
      )
      .run(
        run.id,
        run.report_id ?? null,
        run.status,
        run.created_at,
        JSON.stringify(run),
      );
    return run;
  }
  reserve(runId) {
    return this.analysisDb.transaction(() => this.reserveInside(runId));
  }
  reserveInside(runId) {
    const run = this.get('daily_runs', runId);
    if (run.status !== 'running')
      throw new AnalysisError('cancelled', '日报已暂停或取消。');
    if (run.actual_attempts >= run.max_model_calls)
      throw new AnalysisError(
        'budget_exceeded',
        '已达到日报模型请求预算，可增加预算后继续。',
        true,
      );
    run.actual_attempts++;
    this.saveRun(run);
  }
  attempt(runId, value) {
    if (this.get('daily_runs', runId, false))
      this.db
        .prepare('INSERT OR REPLACE INTO daily_attempts VALUES (?,?,?)')
        .run(value.id, runId, JSON.stringify(value));
  }
  attempts(runId) {
    return this.db
      .prepare('SELECT data FROM daily_attempts WHERE run_id=?')
      .all(runId)
      .map(decode);
  }
  findCompatible(run, revision) {
    return this.runs({
      subscriptionId: run.subscription.id,
      limit: 10000,
    }).find((r) => {
      if (
        r.id === run.id ||
        !r.revision_id ||
        r.workflow_version !== run.workflow_version
      )
        return false;
      const old = this.get('arxiv_batch_revisions', r.revision_id, false);
      return (
        old &&
        old.date === revision.date &&
        contentFingerprint(old) === contentFingerprint(revision) &&
        hash(analysisConfig(r.subscription)) ===
          hash(analysisConfig(run.subscription)) &&
        screenModelFingerprint(r.model_settings) ===
          screenModelFingerprint(run.model_settings) &&
        (!r.prompt_snapshot ||
          !run.prompt_snapshot ||
          (run.workflow_version === AGENT_SCREEN_VERSION
            ? screeningPromptFingerprint(
                r.prompt_snapshot,
                undefined,
                r.subscription,
              ) ===
              screeningPromptFingerprint(
                run.prompt_snapshot,
                undefined,
                run.subscription,
              )
            : r.prompt_snapshot.fingerprint ===
              run.prompt_snapshot.fingerprint))
      );
    });
  }
  bindReport(run, revision, insideTransaction = false) {
    const bind = () => {
      const id =
        'report-' +
        hash({
          subscription: run.subscription.id,
          batch: revision.batch_id,
        }).slice(0, 32);
      const report = this.get('daily_reports', id, false) ?? {
        id,
        subscription_id: run.subscription.id,
        batch_id: revision.batch_id,
        subject: subscriptionSubjects(revision)[0],
        subjects: subscriptionSubjects(revision),
        date: revision.date,
        created_at: now(),
      };
      const runs = this.runs({ reportId: id, limit: 10000 });
      const fingerprint = hash({
        workflow: run.workflow_version,
        input: analysisConfig(run.subscription),
        models: screenModelFingerprint(run.model_settings),
        revision: contentFingerprint(revision),
        prompts:
          run.workflow_version === AGENT_SCREEN_VERSION
            ? screeningPromptFingerprint(
                run.prompt_snapshot,
                undefined,
                run.subscription,
              )
            : run.prompt_snapshot?.fingerprint,
      });
      const existing =
        !run.force_regenerate && this.findCompatible(run, revision);
      if (existing) {
        if (run.origin?.kind === 'scheduled') return { reused: existing };
        this.db
          .prepare('UPDATE daily_requests SET run_id=? WHERE run_id=?')
          .run(existing.id, run.id);
        this.saveRun({
          ...run,
          status: 'completed',
          report_id: existing.report_id,
          reused_run_id: existing.id,
          message: '已打开同一设置的既有日报。',
        });
        return { reused: existing };
      }
      report.current_run_id = run.id;
      this.db
        .prepare(
          'INSERT INTO daily_reports VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(
          id,
          report.subscription_id,
          report.batch_id,
          report.created_at,
          JSON.stringify(report),
        );
      Object.assign(run, {
        report_id: id,
        revision_id: revision.id,
        date: revision.date,
        fingerprint,
        generation: runs.length + 1,
      });
      this.saveRun(run);
      for (const paper of revision.papers) {
        const excluded =
          !run.subscription.include_updates &&
          ['replace', 'replace_cross'].includes(paper.announce_type);
        this.saveItem({
          id: 'dailyitem-' + randomUUID(),
          run_id: run.id,
          paper,
          excluded,
          processing_status: excluded ? 'excluded' : 'pending',
          final_decision: null,
          decision_basis: null,
          analysis_decision: null,
          details_status: 'not_requested',
          job_id: null,
          analysis_id: null,
          current_version_id: null,
          screening_version_id: null,
          error: null,
        });
      }
      return { run };
    };
    return insideTransaction ? bind() : this.analysisDb.transaction(bind);
  }
  runs({ limit = 25, offset = 0, reportId, subscriptionId } = {}) {
    const filter = reportId
      ? "WHERE json_extract(data,'$.reused_run_id') IS NULL AND report_id=?"
      : subscriptionId
        ? "WHERE json_extract(data,'$.reused_run_id') IS NULL AND json_extract(data,'$.subscription.id')=?"
        : "WHERE json_extract(data,'$.reused_run_id') IS NULL";
    return this.db
      .prepare(
        `SELECT data FROM daily_runs ${filter} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(
        ...(reportId ? [reportId] : subscriptionId ? [subscriptionId] : []),
        limit,
        offset,
      )
      .map(decode);
  }
  queued() {
    return this.queuedAll(1)[0] ?? null;
  }
  queuedAll(limit = 100) {
    return this.db
      .prepare(
        "SELECT data FROM daily_runs WHERE status='queued' ORDER BY created_at,rowid LIMIT ?",
      )
      .all(limit)
      .map(decode);
  }
  reportDates(subscriptionId) {
    return this.db
      .prepare(
        "SELECT DISTINCT json_extract(data,'$.date') AS date FROM daily_reports" +
          (subscriptionId ? ' WHERE subscription_id=?' : '') +
          ' ORDER BY date DESC',
      )
      .all(...(subscriptionId ? [subscriptionId] : []))
      .map((row) => row.date);
  }
  reports({ limit = 25, offset = 0, subscriptionId, date } = {}) {
    const conditions = [],
      args = [];
    if (subscriptionId) {
      conditions.push('subscription_id=?');
      args.push(subscriptionId);
    }
    if (date) {
      conditions.push("json_extract(data,'$.date')=?");
      args.push(date);
    }
    return this.db
      .prepare(
        `SELECT data FROM daily_reports ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY json_extract(data,'$.date') DESC,created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)
      .map(decode);
  }
  saveItem(item) {
    this.db
      .prepare(
        'INSERT INTO daily_items VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,decision=excluded.decision,job_id=excluded.job_id,data=excluded.data',
      )
      .run(
        item.id,
        item.run_id,
        item.paper.id,
        item.processing_status,
        item.final_decision,
        item.job_id,
        JSON.stringify(item),
      );
    return item;
  }
  items(runId) {
    return this.db
      .prepare('SELECT data FROM daily_items WHERE run_id=? ORDER BY paper_id')
      .all(runId)
      .map(decode);
  }
  addVersion(item, value) {
    const version = {
      ...value,
      id: 'dailyversion-' + randomUUID(),
      item_id: item.id,
      created_at: now(),
    };
    this.db
      .prepare('INSERT INTO daily_item_versions VALUES (?,?,?,?,?)')
      .run(
        version.id,
        item.id,
        version.analysis_id ?? null,
        version.created_at,
        JSON.stringify(version),
      );
    item.current_version_id = version.id;
    if (version.kind === 'screening') item.screening_version_id = version.id;
    this.saveItem(item);
    return version;
  }
  feedback(id) {
    return Object.fromEntries(
      this.db
        .prepare('SELECT dimension,data FROM daily_feedback WHERE version_id=?')
        .all(id)
        .map((r) => [r.dimension, JSON.parse(r.data)]),
    );
  }
  setFeedback(id, dimension, value) {
    if (value)
      this.db
        .prepare('INSERT OR REPLACE INTO daily_feedback VALUES (?,?,?)')
        .run(id, dimension, JSON.stringify(value));
    else
      this.db
        .prepare(
          'DELETE FROM daily_feedback WHERE version_id=? AND dimension=?',
        )
        .run(id, dimension);
    return this.feedback(id);
  }
  deleteReport(id, beforeDelete = () => {}) {
    const runIds = this.runs({ reportId: id, limit: 10000 }).map((r) => r.id);
    this.analysisDb.transaction(() => {
      beforeDelete();
      this.db
        .prepare(
          'UPDATE discussions SET daily_item_id=NULL WHERE daily_item_id IN (SELECT i.id FROM daily_items i JOIN daily_runs r ON r.id=i.run_id WHERE r.report_id=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM daily_reports WHERE id=?').run(id);
      for (const runId of runIds) {
        const jobs = this.db
          .prepare(
            "SELECT id FROM jobs WHERE json_extract(data,'$.origin.daily_run_id')=?",
          )
          .all(runId);
        for (const job of jobs) {
          if (
            this.db
              .prepare('SELECT 1 FROM daily_items WHERE job_id=?')
              .get(job.id)
          )
            continue;
          const result = this.db
            .prepare('SELECT id FROM results WHERE job_id=?')
            .get(job.id);
          if (
            result &&
            this.db
              .prepare('SELECT 1 FROM daily_item_versions WHERE analysis_id=?')
              .get(result.id)
          )
            continue;
          if (result)
            this.db
              .prepare(
                'UPDATE discussions SET analysis_id=NULL WHERE analysis_id=?',
              )
              .run(result.id);
          this.db.prepare('DELETE FROM results WHERE job_id=?').run(job.id);
          this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
        }
      }
    });
  }
}
