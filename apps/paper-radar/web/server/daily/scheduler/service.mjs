import { requireHostSettings } from '../../hosts/execution.mjs';
import { randomUUID } from 'node:crypto';
import { AnalysisError, hash, safeError } from '../../analyses/contracts.mjs';
import { requestKey } from '../contracts.mjs';
import { discoverSubjects } from '../subject-bundle.mjs';
import { subscriptionSubjects } from '../../../lib/subscription-subjects.ts';
import { resolveConnection } from '../../../lib/host-models.ts';
import { nextOccurrence, validTimezone } from './clock.mjs';
import { ScheduleRepository } from './repository.mjs';
import {
  CONTENT_VERSION,
  sourceScope,
  contentFingerprint,
  eligiblePapers,
  paperFingerprint,
} from './source-check.mjs';

export class DailyScheduler {
  constructor(
    daily,
    {
      clock = Date.now,
      pollMs = 30000,
      recheckMs = 1800000,
      maxRechecks = 4,
      cooldownMs = 60000,
    } = {},
  ) {
    this.daily = daily;
    this.clock = clock;
    this.repo = new ScheduleRepository(daily, clock);
    this.pollMs = pollMs;
    this.recheckMs = recheckMs;
    this.maxRechecks = maxRechecks;
    this.cooldownMs = cooldownMs;
    this.shutdown = new AbortController();
    this.work = new Map();
    this.scanning = false;
    daily.scheduler = this;
    for (const row of this.repo.db
      .prepare("SELECT data FROM schedule_checks WHERE status='checking'")
      .all()) {
      const c = JSON.parse(row.data);
      this.repo.saveCheck({
        ...c,
        status: 'interrupted',
        finished_at: this.repo.now(),
        outcome: 'interrupted',
      });
      const s = this.repo.schedule(c.subscription_id);
      if (s?.enabled)
        this.repo.saveSchedule({ ...s, next_check_at: this.repo.now() });
    }
    this.repo.db
      .prepare(
        "UPDATE automatic_attempt_reservations SET status='unknown' WHERE status='reserved'",
      )
      .run();
  }
  settings(id) {
    const sub = this.daily.repo.get('subscriptions', id);
    return (
      this.repo.schedule(id) ?? {
        subscription_id: id,
        enabled: false,
        revision: 0,
        local_time: '',
        timezone: '',
        next_check_at: null,
        max_model_calls_24h: sub.max_model_calls,
      }
    );
  }
  status(id) {
    const s = this.settings(id),
      sub = this.daily.repo.get('subscriptions', id);
    const latest = this.daily.repo
      .runs({ subscriptionId: id, limit: 10000 })
      .find((r) => r.status === 'completed');
    return {
      schedule: s,
      effective_enabled: s.enabled && sub.status === 'enabled',
      used_24h: this.repo.used(id),
      remaining_24h: this.repo.remaining(id),
      service_error: this.lastError ?? null,
      latest_check: this.publicCheck(this.repo.checks(id, 1)[0]),
      latest_report: latest
        ? { id: latest.id, date: latest.date, status: latest.status }
        : null,
    };
  }
  async save(id, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AnalysisError('invalid_settings', '自动日报设置无效。');
    const keys = [
      'expected_revision',
      'enabled',
      'local_time',
      'timezone',
      'max_model_calls_24h',
    ];
    if (Object.keys(raw).some((k) => !keys.includes(k)))
      throw new AnalysisError('invalid_settings', '自动日报设置无效。');
    const old = this.settings(id),
      sub = this.daily.repo.get('subscriptions', id);
    if (raw.expected_revision !== old.revision)
      throw new AnalysisError(
        'conflict',
        '自动日报设置已改变，请刷新后保存。',
        false,
        409,
      );
    const next = { ...old, ...raw };
    delete next.expected_revision;
    if (
      typeof next.enabled !== 'boolean' ||
      typeof next.local_time !== 'string' ||
      typeof next.timezone !== 'string' ||
      !Number.isInteger(next.max_model_calls_24h) ||
      next.max_model_calls_24h < 1 ||
      next.max_model_calls_24h > 2000 ||
      (next.local_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.local_time)) ||
      (next.timezone && !validTimezone(next.timezone)) ||
      (next.enabled && (!next.local_time || !next.timezone))
    )
      throw new AnalysisError(
        'invalid_settings',
        '请检查时间、时区和自动调用额度（1–2000）。',
      );
    if (next.enabled) {
      await this.daily.models.refresh?.();
      if (sub.status !== 'enabled' || !sub.scope.tag_ids.length)
        throw new AnalysisError(
          'empty_scope',
          '启用自动日报前，请先启用订阅并选择 Persona 标签。',
        );
      requireHostSettings(this.daily.models.store.state.settings);
      const primary = resolveConnection(
        this.daily.models.store.state.settings,
        'screen',
      );
      if (!primary)
        throw new AnalysisError(
          'not_configured',
          '请先配置每日筛选使用的模型。',
        );
      await this.daily.persona.scopeReader(sub, AbortSignal.timeout(90000));
    }
    return this.repo.tx(() => {
      if (
        this.settings(id).revision !== old.revision ||
        this.daily.repo.get('subscriptions', id).revision !== sub.revision
      )
        throw new AnalysisError(
          'conflict',
          '设置已改变，请刷新后保存。',
          false,
          409,
        );
      next.revision = old.revision + 1;
      next.next_check_at = next.enabled
        ? nextOccurrence(this.clock(), next.local_time, next.timezone)
        : null;
      delete next.recheck;
      this.repo.saveSchedule(next);
      return this.status(id);
    });
  }
  publicCheck(c) {
    if (!c) return null;
    const { subscription_snapshot: _sub, ...safe } = c;
    return safe;
  }
  check(id, key, options = {}, insideTransaction = false) {
    requestKey(key);
    if (this.shutdown.signal.aborted)
      throw new AnalysisError(
        'unavailable',
        '自动日报服务正在关闭。',
        true,
        503,
      );
    const digest = hash({ action: 'check', id, options });
    const known = this.repo.request(key, digest);
    if (known)
      return {
        check: this.publicCheck(this.repo.getCheck(known)),
        reused: true,
      };
    const sub = this.daily.repo.get('subscriptions', id),
      s = this.settings(id);
    if (sub.status !== 'enabled')
      throw new AnalysisError('invalid_settings', '请先启用订阅。');
    const create = () => {
      let existing = this.repo.active(id);
      const recent = this.repo.checks(id, 1)[0];
      if (
        !existing &&
        !options.scheduled &&
        recent &&
        this.clock() - Date.parse(recent.created_at) < this.cooldownMs
      )
        existing = recent;
      if (existing) {
        this.repo.addRequest(key, digest, existing.id);
        return { value: existing, reused: true };
      }
      const c = {
        id: 'check-' + randomUUID(),
        subscription_id: id,
        subscription_snapshot: structuredClone(sub),
        schedule_revision: s.revision,
        trigger: options.scheduled ? 'scheduled' : 'manual',
        cycle_key: key,
        check_index: options.index ?? 0,
        cycle_started_at: options.cycleStartedAt ?? this.repo.now(),
        created_at: this.repo.now(),
        status: 'queued',
        outcome: null,
        run_id: null,
        sources: [],
      };
      this.repo.saveCheck(c);
      this.repo.addRequest(key, digest, c.id);
      return { value: c, reused: false };
    };
    const check = insideTransaction ? create() : this.repo.tx(create);
    this.launch(check.value);
    return { check: this.publicCheck(check.value), reused: check.reused };
  }
  launch(c) {
    if (
      c.status !== 'queued' ||
      this.work.has(c.id) ||
      this.shutdown.signal.aborted
    )
      return;
    const promise = Promise.resolve()
      .then(() => this.execute(c.id))
      .finally(() => this.work.delete(c.id));
    this.work.set(c.id, promise);
    promise.catch(() => {});
  }
  valid(c) {
    const s = this.settings(c.subscription_id),
      sub = this.daily.repo.get('subscriptions', c.subscription_id);
    return (
      sub.status === 'enabled' &&
      sub.revision === c.subscription_snapshot.revision &&
      s.revision === c.schedule_revision &&
      (c.trigger === 'manual' || s.enabled)
    );
  }
  async execute(id) {
    let c = this.repo.getCheck(id);
    let phase = 'source';
    if (c.status !== 'queued') return;
    this.repo.tx(() => {
      c.status = 'checking';
      this.repo.saveCheck(c);
    });
    try {
      if (!this.valid(c)) {
        this.finish(c, 'configuration_changed');
        return;
      }
      const sub = c.subscription_snapshot;
      const revision = await discoverSubjects(
        this.daily.discovery,
        this.daily.repo,
        subscriptionSubjects(sub),
        this.shutdown.signal,
        () => {},
      );
      this.shutdown.signal.throwIfAborted();
      c.sources = revision.sources ?? [
        {
          subject: revision.subject,
          date: revision.date,
          revision_id: revision.id,
          completeness: revision.completeness,
          status: 'included',
        },
      ];
      c.fetched_at =
        revision.fetched_at ??
        revision.sources?.find((s) => s.fetched_at)?.fetched_at ??
        null;
      c.revision_id = revision.id;
      c.date = revision.date;
      if (!this.valid(c)) {
        this.finish(c, 'configuration_changed');
        return;
      }
      if (revision.completeness !== 'complete') {
        c.error = { message: revision.issues.join('；') };
        this.finish(c, 'source_incomplete');
        return;
      }
      phase = 'admission';
      if (this.daily.models.refresh) {
        try { await this.daily.models.refresh(); }
        catch { this.daily.models.base = null; }
      }
      this.repo.tx(() => this.decide(c, revision));
      this.daily.pump();
    } catch (e) {
      c = this.repo.getCheck(id);
      if (this.shutdown.signal.aborted) {
        this.repo.saveCheck({
          ...c,
          status: 'interrupted',
          outcome: 'interrupted',
          finished_at: this.repo.now(),
        });
        const s = this.repo.schedule(c.subscription_id);
        if (s?.enabled)
          this.repo.saveSchedule({ ...s, next_check_at: this.repo.now() });
      } else {
        c.error = safeError(e);
        this.finish(
          c,
          phase === 'source' ? 'source_failed' : 'admission_failed',
        );
      }
    }
  }
  decide(c, revision) {
    if (!this.valid(c)) {
      this.finish(c, 'configuration_changed');
      return;
    }
    const sub = c.subscription_snapshot,
      scope = sourceScope(sub),
      fp = contentFingerprint(revision);
    const previous = this.repo.cursor(sub.id, scope);
    c.content_hash = fp;
    if (
      previous?.version !== undefined &&
      previous.version !== CONTENT_VERSION
    ) {
      const stored = this.daily.repo.get(
        'arxiv_batch_revisions',
        previous.revision_id,
        false,
      );
      if (!stored) {
        c.error = { message: '比较基线不可重建，请检查存档。' };
        this.finish(c, 'source_incomplete');
        return;
      }
      previous.content_hash = contentFingerprint(stored);
      previous.version = CONTENT_VERSION;
      this.repo.saveCursor(sub.id, scope, previous);
      if (previous.content_hash === fp) {
        this.finish(c, 'baseline_rebuilt');
        return;
      }
    }
    if (previous && revision.date < previous.date) {
      this.finish(c, 'stale_source');
      return;
    }
    if (previous?.content_hash === fp) {
      this.finish(c, 'no_update');
      return;
    }
    const seen = this.repo.updateFor(sub.id, scope, revision.date, fp);
    if (seen) {
      c.update_id = seen.id;
      c.run_id = seen.run_id;
      this.finish(c, 'existing_result');
      return;
    }
    const update = {
      id: 'update-' + randomUUID(),
      subscription_id: sub.id,
      scope_key: scope,
      date: revision.date,
      content_hash: fp,
      revision_id: revision.id,
      created_at: this.repo.now(),
      check_id: c.id,
      status: 'discovered',
      run_id: null,
      subscription_snapshot: sub,
    };
    this.repo.saveCursor(sub.id, scope, {
      date: revision.date,
      content_hash: fp,
      revision_id: revision.id,
      version: CONTENT_VERSION,
      observed_at: this.repo.now(),
    });
    c.update_id = update.id;
    const eligible = eligiblePapers(revision, sub);
    const oldRevision = previous
      ? this.daily.repo.get(
          'arxiv_batch_revisions',
          previous.revision_id,
          false,
        )
      : null;
    const oldHashes = new Set(
      oldRevision ? eligiblePapers(oldRevision, sub).map(paperFingerprint) : [],
    );
    c.candidates = eligible.length;
    c.changed_candidates = eligible.filter(
      (p) => !oldHashes.has(paperFingerprint(p)),
    ).length;
    if (!eligible.length || (oldRevision && !c.changed_candidates)) {
      update.status = 'no_eligible_change';
      this.repo.saveUpdate(update);
      this.finish(c, 'no_eligible_change');
      return;
    }
    let run;
    try {
      run = this.daily.prepareStoredRun(sub, revision, {
        kind: 'scheduled',
        check_id: c.id,
        update_id: update.id,
        schedule_revision: c.schedule_revision,
      });
    } catch (e) {
      update.status = 'blocked_configuration';
      update.error = safeError(e);
      this.repo.saveUpdate(update);
      c.error = update.error;
      this.finish(c, 'blocked_configuration');
      return;
    }
    const existing = this.daily.repo.findCompatible(run, revision);
    if (existing) {
      update.status = 'existing_result';
      update.run_id = existing.id;
      this.repo.saveUpdate(update);
      c.run_id = existing.id;
      this.finish(c, 'existing_result');
      return;
    }
    if (this.repo.remaining(sub.id) <= 0) {
      update.status = 'blocked_budget';
      this.repo.saveUpdate(update);
      this.finish(c, 'blocked_budget');
      return;
    }
    const admitted = this.daily.admitStoredRevision(run, revision);
    update.run_id = admitted.run.id;
    update.status = admitted.reused ? 'existing_result' : 'admitted';
    this.repo.saveUpdate(update);
    c.run_id = update.run_id;
    this.finish(c, update.status);
  }
  finish(c, outcome) {
    c.status = 'finished';
    c.outcome = outcome;
    c.finished_at = this.repo.now();
    this.repo.saveCheck(c);
    const s = this.repo.schedule(c.subscription_id);
    if (
      s?.enabled &&
      s.revision === c.schedule_revision &&
      [
        'no_update',
        'source_failed',
        'source_incomplete',
        'stale_source',
      ].includes(outcome) &&
      c.check_index < this.maxRechecks &&
      this.clock() + this.recheckMs <=
        Date.parse(c.cycle_started_at) + this.maxRechecks * this.recheckMs
    ) {
      const when = new Date(this.clock() + this.recheckMs).toISOString();
      if (!s.next_check_at || when < s.next_check_at)
        this.repo.saveSchedule({
          ...s,
          next_check_at: when,
          recheck: {
            index: c.check_index + 1,
            cycleStartedAt: c.cycle_started_at,
          },
        });
    }
  }
  listUpdates(id, limit = 25, offset = 0, needsAction = false) {
    this.daily.repo.get('subscriptions', id);
    return this.repo.updates(id, limit, offset, needsAction).map((u) => {
      const { subscription_snapshot: _s, ...v } = u;
      const run = u.run_id
        ? this.daily.repo.get('daily_runs', u.run_id, false)
        : null;
      return {
        ...v,
        run_status: run?.status ?? null,
        needs_action:
          u.status !== 'dismissed' &&
          (['blocked_budget', 'blocked_configuration'].includes(u.status) ||
            (!!run &&
              [
                'paused',
                'failed',
                'partial',
                'interrupted',
                'cancelled',
              ].includes(run.status))),
      };
    });
  }
  process(id, key) {
    requestKey(key);
    const digest = hash({ action: 'process', id });
    const old = this.repo.request(key, digest);
    if (old) return { run: this.daily.getRun(old), reused: true };
    const u = this.repo.getUpdate(id);
    if (u.status === 'dismissed')
      throw new AnalysisError(
        'invalid_request',
        '该日报已删除；如需重新生成，请使用手动生成入口。',
      );
    const sub = this.daily.repo.get('subscriptions', u.subscription_id);
    if (sub.status !== 'enabled')
      throw new AnalysisError('invalid_settings', '请先启用订阅。');
    if (
      sourceScope(sub) !== u.scope_key ||
      hash(sub.scope) !== hash(u.subscription_snapshot.scope) ||
      sub.persona_connection_id !==
        u.subscription_snapshot.persona_connection_id
    )
      throw new AnalysisError(
        'configuration_changed',
        '订阅范围已改变，请按当前设置手动重新筛选。',
        false,
        409,
      );
    if (this.repo.remaining(sub.id) <= 0)
      throw new AnalysisError(
        'budget_exceeded',
        '过去 24 小时自动调用额度不足，请调整后继续。',
      );
    if (u.run_id) {
      const run = this.daily.getRun(u.run_id);
      const result = ['queued', 'running', 'completed'].includes(run.status)
        ? { run, reused: true }
        : this.daily.retry(
            u.run_id,
            {
              max_model_calls: Math.max(
                run.max_model_calls,
                sub.max_model_calls,
              ),
            },
            key,
          );
      this.repo.addRequest(key, digest, u.run_id);
      return result;
    }
    const revision = this.daily.repo.get(
      'arxiv_batch_revisions',
      u.revision_id,
    );
    const run = this.daily.prepareStoredRun(
      { ...u.subscription_snapshot, max_model_calls: sub.max_model_calls },
      revision,
      {
        kind: 'scheduled',
        check_id: u.check_id,
        update_id: u.id,
        schedule_revision: this.settings(sub.id).revision,
      },
    );
    const result = this.repo.tx(() => {
      const admitted = this.daily.admitStoredRevision(run, revision);
      this.repo.saveUpdate({
        ...u,
        status: admitted.reused ? 'existing_result' : 'admitted',
        run_id: admitted.run.id,
      });
      this.repo.addRequest(key, digest, admitted.run.id);
      return admitted;
    });
    this.daily.pump();
    return { run: this.daily.getRun(result.run.id), reused: result.reused };
  }
  async tick() {
    if (this.scanning || this.shutdown.signal.aborted) return;
    this.scanning = true;
    try {
      for (const row of this.repo.db
        .prepare("SELECT data FROM schedule_checks WHERE status='queued'")
        .all())
        this.launch(JSON.parse(row.data));
      for (const row of this.repo.db
        .prepare(
          'SELECT data FROM daily_schedules WHERE enabled=1 AND next_check_at<=?',
        )
        .all(this.repo.now())) {
        const s = JSON.parse(row.data),
          sub = this.daily.repo.get('subscriptions', s.subscription_id);
        if (sub.status !== 'enabled') continue;
        const options = {
          scheduled: true,
          index: s.recheck?.index ?? 0,
          cycleStartedAt: s.recheck?.cycleStartedAt ?? this.repo.now(),
        };
        const key =
          'scheduled-' +
          hash({
            id: s.subscription_id,
            revision: s.revision,
            due: s.next_check_at,
          });
        this.repo.tx(() => {
          this.repo.saveSchedule({
            ...s,
            next_check_at: nextOccurrence(
              this.clock(),
              s.local_time,
              s.timezone,
            ),
            recheck: null,
          });
          this.check(s.subscription_id, key, options, true);
        });
      }
    } finally {
      this.scanning = false;
    }
  }
  start() {
    if (this.timer) return;
    void this.tick().catch((e) => {
      this.lastError = safeError(e);
    });
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        this.lastError = safeError(e);
      });
    }, this.pollMs);
    this.timer.unref?.();
  }
  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.shutdown.abort();
    await Promise.allSettled(this.work.values());
  }
}
