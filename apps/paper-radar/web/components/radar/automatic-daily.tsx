'use client';
import { useEffect, useState } from 'react';
import { Clock3, LoaderCircle, RefreshCw } from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { browserRequestId } from '@/lib/backend-response';
import type { DailySubscription, DailyRun } from '@/lib/daily-api';
import { useUiLanguage } from './ui-language';
import './automatic-daily.css';

type Schedule = {
  enabled: boolean;
  revision: number;
  local_time: string;
  timezone: string;
  next_check_at: string | null;
  max_model_calls_24h: number;
};
type Check = {
  id: string;
  status: string;
  outcome: string | null;
  created_at: string;
  finished_at?: string;
  fetched_at?: string | null;
  run_id: string | null;
  date?: string;
  error?: { message: string };
  candidates?: number;
  changed_candidates?: number;
};
type Update = {
  id: string;
  date: string;
  status: string;
  run_id: string | null;
  run_status: string | null;
  needs_action: boolean;
};
type Status = {
  schedule: Schedule;
  effective_enabled: boolean;
  used_24h: number;
  remaining_24h: number;
  latest_check: Check | null;
  latest_report: { id: string; date: string } | null;
  service_error?: { message: string } | null;
};
const outcomes: Record<string, string> = {
  no_update: '已检查，暂无新公告',
  existing_result: '已有任务或日报',
  no_eligible_change: '来源有变化，无需新增分析',
  admitted: '已创建自动日报',
  blocked_budget: '发现更新，自动额度不足',
  blocked_configuration: '发现更新，请检查模型或标签设置',
  source_incomplete: '来源不完整，等待重查',
  source_failed: '来源检查失败',
  admission_failed: '任务保存失败，请重新检查',
  stale_source: '来源返回旧公告，等待重查',
  configuration_changed: '设置已改变，本次检查已停止',
  baseline_rebuilt: '来源比较基线已更新',
  interrupted: '检查已中断',
};
export function AutomaticDaily({
  subscription,
  onRun,
}: {
  subscription: DailySubscription;
  onRun?: (id: string, date?: string) => void;
}) {
  const { ui, locale } = useUiLanguage();
  const [status, setStatus] = useState<Status | null>(null),
    [checks, setChecks] = useState<Check[]>([]),
    [updates, setUpdates] = useState<Update[]>([]);
  const [draft, setDraft] = useState<Schedule | null>(null),
    [error, setError] = useState(''),
    [readError, setReadError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(''),
    [tick, setTick] = useState(0),
    [offset, setOffset] = useState(0),
    [pendingOffset, setPendingOffset] = useState(0);
  const root = `subscriptions/${subscription.id}/schedule`;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      try {
        const [s, c, u] = await Promise.all([
          analysisApi<Status>(root, { signal: controller.signal }),
          analysisApi<{ checks: Check[] }>(
            `${root}/checks?limit=10&offset=${offset}`,
            { signal: controller.signal },
          ),
          analysisApi<{ updates: Update[] }>(
            `${root}/updates?needs_action=1&limit=10&offset=${pendingOffset}`,
            {
              signal: controller.signal,
            },
          ),
        ]);
        if (!active) return;
        setStatus(s);
        setChecks(c.checks);
        setUpdates(u.updates);
        setReadError('');
        setDraft(
          (old) =>
            old ?? {
              ...s.schedule,
              local_time: s.schedule.local_time || '07:30',
              timezone:
                s.schedule.timezone ||
                Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
        );
      } catch (e) {
        if (active) setReadError(e instanceof Error ? e.message : String(e));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [root, tick, offset, pendingOffset, subscription.revision]);
  const date = (value?: string | null, timeZone?: string) =>
    value
      ? new Date(value).toLocaleString(locale, {
          timeZone: timeZone || undefined,
        })
      : ui('尚无记录');
  const label = (c: Check) =>
    c.status === 'queued' || c.status === 'checking'
      ? ui('正在检查公告…')
      : ui(outcomes[c.outcome ?? ''] ?? c.outcome ?? '尚无记录');
  async function action(kind: string, id?: string) {
    setBusy(kind);
    setError('');
    setNotice('');
    try {
      if (kind === 'save' && draft) {
        const value = await analysisApi<Status>(root, {
          method: 'PATCH',
          body: {
            expected_revision: draft.revision,
            enabled: draft.enabled,
            local_time: draft.local_time,
            timezone: draft.timezone,
            max_model_calls_24h: draft.max_model_calls_24h,
          },
        });
        setStatus(value);
        setDraft(value.schedule);
        setNotice('自动日报设置已保存');
      } else if (kind === 'check') {
        await analysisApi(root + '/check', {
          method: 'POST',
          key: browserRequestId(),
          body: {},
        });
        setNotice('检查已提交；仅在发现更新时启动分析');
      } else if (id) {
        const result = await analysisApi<{ run: DailyRun }>(
          `schedule-updates/${id}/process`,
          { method: 'POST', key: browserRequestId(), body: {} },
        );
        setNotice('任务已提交，已完成结果保留');
        onRun?.(result.run.id, result.run.date);
      }
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="automatic-daily" aria-label={ui('自动日报')}>
      <div className="auto-heading">
        <Clock3 size={18} />
        <strong>{ui('自动日报')}</strong>
        <span>{ui(status?.effective_enabled ? '已开启' : '未开启')}</span>
      </div>
      <p className="auto-status" aria-live="polite">
        {status?.latest_check
          ? label(status.latest_check)
          : ui('定时检查公告，有更新才分析')}
      </p>
      {status && (
        <div className="auto-dates">
          <span>
            {ui('上次检查')}：{date(status.latest_check?.created_at)}
          </span>
          <span>
            {ui('下次检查')}：
            {status.effective_enabled
              ? `${date(status.schedule.next_check_at, status.schedule.timezone)} (${status.schedule.timezone})`
              : ui('未开启')}
          </span>
          <span>
            {ui('过去 24 小时自动调用')}：{status.used_24h} /{' '}
            {status.schedule.max_model_calls_24h}
          </span>
          <span>
            {ui('最新完成日报')}：{status.latest_report?.date ?? ui('尚无记录')}
          </span>
        </div>
      )}
      {readError && <p role="alert">{ui(readError)}</p>}
      {status?.service_error && (
        <p role="alert">{ui(status.service_error.message)}</p>
      )}
      {error && <p role="alert">{ui(error)}</p>}
      {notice && <output>{ui(notice)}</output>}
      <div className="daily-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={!!busy || subscription.status !== 'enabled'}
          onClick={() => void action('check')}
        >
          {busy === 'check' ? (
            <LoaderCircle size={14} className="single-spin" />
          ) : (
            <RefreshCw size={14} />
          )}{' '}
          {ui('立即检查')}
        </button>
        {status?.latest_check?.run_id && onRun && (
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              onRun(status.latest_check!.run_id!, status.latest_check?.date)
            }
          >
            {ui('查看本次日报')}
          </button>
        )}
        {status?.latest_report &&
          onRun &&
          status.latest_report.id !== status.latest_check?.run_id && (
            <button
              type="button"
              className="button-secondary"
              onClick={() =>
                onRun(status.latest_report!.id, status.latest_report!.date)
              }
            >
              {ui('打开最新日报')}
            </button>
          )}
      </div>
      <details>
        <summary>{ui('自动设置与检查历史')}</summary>
        {draft && (
          <form
            className="auto-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action('save');
            }}
          >
            <label className="daily-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={!!busy || subscription.status !== 'enabled'}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              {ui('开启自动日报')}
            </label>
            <div className="auto-fields">
              <label>
                {ui('每天检查时间')}
                <input
                  type="time"
                  required
                  value={draft.local_time}
                  onChange={(e) =>
                    setDraft({ ...draft, local_time: e.target.value })
                  }
                />
              </label>
              <label>
                {ui('时区')}
                <input
                  required
                  value={draft.timezone}
                  placeholder="Europe/Vienna"
                  onChange={(e) =>
                    setDraft({ ...draft, timezone: e.target.value })
                  }
                />
              </label>
              <label>
                {ui('过去 24 小时调用上限')}
                <input
                  type="number"
                  min={1}
                  max={2000}
                  required
                  value={draft.max_model_calls_24h}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      max_model_calls_24h: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <p>
              {ui(
                '首次启用检查最新公告；没有更新不调用模型。新公告按单批与自动额度筛选，详细报告由你主动生成。',
              )}
            </p>
            <p>
              {ui(
                '电脑需保持开机、联网和唤醒。关闭自动开关不会取消已经提交的日报。',
              )}
            </p>
            <div className="daily-actions">
              <button className="button-primary" disabled={!!busy}>
                {ui(busy === 'save' ? '正在保存…' : '保存自动设置')}
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={!!busy}
                onClick={() => {
                  setDraft(null);
                  setTick((v) => v + 1);
                  setError('');
                }}
              >
                {ui('重新读取设置')}
              </button>
            </div>
          </form>
        )}
        {(updates.length > 0 || pendingOffset > 0) && (
          <div className="auto-pending">
            <h3>{ui('已发现更新待处理')}</h3>
            {updates
              .filter((u) => u.needs_action)
              .map((u) => (
                <div key={u.id} className="auto-history-row">
                  <span>
                    {u.date} ·{' '}
                    {ui(
                      (
                        {
                          paused: '预算暂停',
                          partial: '部分完成',
                          interrupted: '已中断',
                          cancelled: '已取消',
                          failed: '未完成',
                        } as Record<string, string>
                      )[u.run_status ?? ''] ??
                        outcomes[u.status] ??
                        u.status,
                    )}
                  </span>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!!busy}
                    onClick={() => void action('process', u.id)}
                  >
                    {ui('继续处理（调用模型）')}
                  </button>
                </div>
              ))}
            <p>{ui('额度恢复后也不会自动补跑；请明确选择继续处理。')}</p>
            <div className="daily-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={pendingOffset === 0}
                onClick={() => setPendingOffset((v) => Math.max(0, v - 10))}
              >
                {ui('上一页待处理')}
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={updates.length < 10}
                onClick={() => setPendingOffset((v) => v + 10)}
              >
                {ui('下一页待处理')}
              </button>
            </div>
          </div>
        )}
        <div className="auto-history">
          <h3>{ui('检查历史')}</h3>
          {checks.map((c) => (
            <div className="auto-history-row" key={c.id}>
              <span>
                {date(c.created_at)}
                <br />
                {label(c)}
                {c.fetched_at && (
                  <small>
                    {ui('来源抓取时间')}：{date(c.fetched_at)}
                  </small>
                )}
                {c.error && <small>{ui(c.error.message)}</small>}
              </span>
              {c.run_id && onRun && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => onRun(c.run_id!, c.date)}
                >
                  {ui('打开日报')}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="daily-actions">
          <button
            type="button"
            className="button-secondary"
            disabled={offset === 0}
            onClick={() => setOffset((v) => Math.max(0, v - 10))}
          >
            {ui('上一页历史')}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={checks.length < 10}
            onClick={() => setOffset((v) => v + 10)}
          >
            {ui('下一页历史')}
          </button>
        </div>
      </details>
    </section>
  );
}
