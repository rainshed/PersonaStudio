'use client';
import { ResearchReadiness } from './research-readiness';
import { usePersonaTags } from './use-persona-tags';
import { useUiLanguage } from '@/components/radar/ui-language';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { analysisApi } from '@/lib/analysis-api';
import { browserRequestId } from '@/lib/backend-response';
import type { DailyRun, DailySubscription } from '@/lib/daily-api';
import {
  announcementToday,
  dailySource,
  matchesDailyDate,
} from '@/lib/daily-source';
import {
  ArrowUpRight,
  ChevronRight,
  FileText,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AutomaticDaily } from './automatic-daily';
import { DailyDetails } from './daily-details';
import { FollowedAuthors } from './followed-authors';
import { FollowAuthorButton } from './follow-author-button';
import './daily-real.css';
import { EvaluationsPage } from './evaluations';
import { ResearchShell, ResearchTopbar } from './research-shell';
import { SettingsWorkspace } from './settings-workspace';
import { PersonaConnectionStatus } from './persona-connection-status';
import { RealSingleAnalysis } from './single-analysis-real';

import { academicName } from '@/lib/academic-text';
import {
  activeRun as active,
  detailStatus,
  emptyDailyMessage,
  generationNotice,
  screeningHeading,
} from '@/lib/daily-ui';
import { strictnessLabel } from '@/lib/recommendation-policy';
import type { RadarView as View } from '@/lib/radar-location';
import { sameSubjects, subjectLabel } from '@/lib/subscription-subjects';
import { ReportDatePicker } from './daily-pickers';
import { LiveSubscriptionEditor } from './live-subscription-editor';
import { useRadarLocation } from './use-radar-location';
import { useDailyFeed } from './use-daily-feed';
export const dailyStatus = (s: string) =>
  ({
    queued: '排队中',
    running: '生成中',
    completed: '已完成',
    partial: '部分完成',
    failed: '未完成',
    paused: '预算暂停',
    cancelled: '已取消',
    interrupted: '已中断',
    pending: '待筛选',
    screening: '初筛中',
    awaiting_analysis: '待深入分析',
    analyzing: '全文分析中',
    needs_review: '待核对',
    excluded: '版本动态',
  })[s] ?? s;
export function LiveRadarApp() {
  const { ui, locale } = useUiLanguage();
  const {
    value: route,
    current: routeRef,
    update: updateLocation,
    ready,
  } = useRadarLocation();
  const {
    view,
    subscription: selectedSub,
    run: selectedRun,
    date,
    filter,
  } = route;
  const [visited, setVisited] = useState<string[]>([]);
  if (!visited.includes(view)) setVisited([...visited, view]);
  const setSelectedRun = (id: string | null) => updateLocation({ run: id });
  const setFilter = (value: string) =>
    updateLocation({
      filter: value,
      paper: null,
      section: 'overview',
      expanded: false,
    });
  const singleJob = route.job ?? null;
  const setSingleJob = (job: string | null) => updateLocation({ job });
  const selectedItem = route.paper ?? null;
  const setSelectedItem = (paper: string | null) =>
    updateLocation({ paper, section: 'overview', expanded: false });
  const listScroll = useRef(0);
  const [subscriptions, setSubscriptions] = useState<DailySubscription[]>([]);
  const [offset, setOffset] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [query, setQuery] = useState(''),
    [historyOpen, setHistoryOpen] = useState(false),
    [showArchived, setShowArchived] = useState(false);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]),
    [tagsTick, setTagsTick] = useState(0);
  const { tags, personaId, personaError } = usePersonaTags(tagsTick);
  const [editor, setEditor] = useState<DailySubscription | null | undefined>(
      undefined,
    ),
    [deleteOpen, setDeleteOpen] = useState(false),
    [budgetOpen, setBudgetOpen] = useState(false),
    [budget, setBudget] = useState(200);
  const [subscriptionError, setSubscriptionError] = useState(''),
    [operationError, setOperationError] = useState<{
      key: string;
      message: string;
    } | null>(null),
    [notice, setNotice] = useState(''),
    [pendingActions, setPendingActions] = useState<string[]>([]),
    [generation, setGeneration] = useState<{
      subscription: string;
      id: string;
      reused: boolean;
    } | null>(null),
    [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((value) => value + 1);
    window.addEventListener('paper-radar-persona-changed', changed);
    return () =>
      window.removeEventListener('paper-radar-persona-changed', changed);
  }, []);
  const actionLocks = useRef(new Set<string>());
  const isBusy = (key: string) => pendingActions.includes(key);
  const requestKey = JSON.stringify([
    selectedSub,
    selectedRun,
    date,
    filter,
    query,
    offset,
  ]);
  const {
    run,
    setRun,
    runs,
    items,
    setItems,
    reports,
    reportDates,
    availableDates,
    total,
    nextOffset,
    historyMore,
    error,
    loading,
  } = useDailyFeed({
    ready,
    selectedSub,
    selectedRun,
    view,
    tick,
    filter,
    query,
    offset,
    historyOffset,
    date,
    requestKey,
    updateLocation,
    onResolvedRun: (target, resolved) =>
      setGeneration((g) =>
        g?.id === target && resolved !== target
          ? { ...g, id: resolved, reused: true }
          : g,
      ),
  });
  useEffect(() => {
    const onHistory = () => {
      setOffset(0);
      setQuery('');
      setNotice('');
      setGeneration(null);
    };
    window.addEventListener('popstate', onHistory);
    window.addEventListener('hashchange', onHistory);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
    };
  }, []);
  const createRequest = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const subscription = subscriptions.find((s) => s.id === selectedSub),
    visibleSubscriptions = subscriptions.filter(
      (s) => showArchived || s.status !== 'archived',
    );
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void Promise.all([
      analysisApi<{ subscriptions: DailySubscription[] }>('subscriptions', {
        signal: controller.signal,
      }),
      analysisApi<{ subjects: { id: string; name: string }[] }>(
        'arxiv/subjects',
        { signal: controller.signal },
      ),
    ])
      .then(([s, c]) => {
        if (controller.signal.aborted) return;
        setSubscriptionError('');
        setSubscriptions(s.subscriptions);
        setSubjects(c.subjects);
        if (
          !s.subscriptions.some((s) => s.id === routeRef.current.subscription)
        )
          updateLocation({
            subscription:
              s.subscriptions.find((s) => s.status !== 'archived')?.id ?? '',
            run: null,
            date: '',
            paper: null,
            section: 'overview',
            expanded: false,
          });
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setSubscriptionError(
            e instanceof Error ? e.message : '无法读取订阅。',
          );
      });
    return () => controller.abort();
  }, [tick, ready, updateLocation, routeRef]);

  function nav(v: View) {
    updateLocation({ view: v }, 'push');
  }
  function openFollowedAuthors(id: string) {
    updateLocation(
      {
        view: 'authors',
        subscription: id,
        ...(id !== selectedSub ? { run: null, date: '' } : {}),
        paper: null,
        section: 'overview',
        expanded: false,
      },
      'push',
    );
    setOffset(0);
    setQuery('');
    setNotice('');
  }
  function chooseSub(id: string) {
    updateLocation(
      {
        subscription: id,
        paper: null,
        section: 'overview',
        expanded: false,
        run: null,
        date: '',
        filter: 'recommended',
        view: 'daily',
      },
      'push',
    );
    setRun(null);
    setItems([]);
    setOffset(0);
    setHistoryOffset(0);
    setQuery('');
    setNotice('');
    setGeneration(null);
  }
  function chooseRun(id: string, runDate?: string) {
    const chosen = runs.find((r) => r.id === id);
    updateLocation(
      {
        run: id,
        date: runDate ?? chosen?.date ?? '',
        view: 'daily',
        paper: null,
        expanded: false,
        section: 'overview',
      },
      'push',
    );
    setOffset(0);
    setItems([]);
    setNotice('');
    setGeneration(null);
  }
  function chooseDate(value: string) {
    setHistoryOffset(0);
    updateLocation(
      {
        date: value,
        run: null,
        paper: null,
        expanded: false,
        section: 'overview',
      },
      'push',
    );
    setOffset(0);
    setRun(null);
    setItems([]);
    setNotice('');
    setGeneration(null);
  }
  async function action(key: string, fn: () => Promise<void>) {
    if (actionLocks.current.has(key)) return;
    actionLocks.current.add(key);
    setPendingActions([...actionLocks.current]);
    try {
      await fn();
      setOperationError((e) => (e?.key === key ? null : e));
      setTick((v) => v + 1);
    } catch (e) {
      setOperationError({
        key,
        message: e instanceof Error ? e.message : '操作未完成。',
      });
    } finally {
      actionLocks.current.delete(key);
      setPendingActions([...actionLocks.current]);
    }
  }
  function generate(force = false, stored = false) {
    if (!subscription) return;
    const source = dailySource(date, stored ? run?.discovery : null);
    const requestedDate = date;
    setNotice('');
    void action('generate:' + subscription.id, async () => {
      const body = {
        subscription_id: subscription.id,
        expected_subscription_revision: subscription.revision,
        source,
        force_regenerate: force,
      };
      const fingerprint = JSON.stringify(body);
      if (createRequest.current?.fingerprint !== fingerprint)
        createRequest.current = { fingerprint, key: browserRequestId() };
      const response = await analysisApi<{ run: DailyRun; reused: boolean }>(
        'daily-runs',
        { method: 'POST', body, key: createRequest.current.key },
      );
      createRequest.current = null;
      if (
        routeRef.current.subscription !== subscription.id ||
        routeRef.current.date !== requestedDate
      )
        return;
      updateLocation(
        {
          run: response.run.id,
          date:
            source.kind === 'latest_announcement'
              ? ''
              : (response.run.date ?? requestedDate),
          filter: 'recommended',
          view: 'daily',
          ...(routeRef.current.run !== response.run.id
            ? { paper: null, section: 'overview' as const, expanded: false }
            : {}),
        },
        'push',
      );
      setRun(response.run);
      setOffset(0);
      setQuery('');
      setGeneration({
        subscription: subscription.id,
        id: response.run.id,
        reused: response.reused,
      });
    });
  }
  function runAction(kind: 'cancel' | 'retry', max?: number) {
    if (!run) return;
    void action(kind + ':' + run.id, async () => {
      const response = await analysisApi<DailyRun | { run: DailyRun }>(
        'daily-runs/' + run.id + '/' + kind,
        {
          method: 'POST',
          body: max ? { max_model_calls: max } : {},
          key: browserRequestId(),
        },
      );
      const value = 'run' in response ? response.run : response;
      if (routeRef.current.run !== run.id) return;
      setRun(value);
      setSelectedRun(value.id);
      setGeneration(null);
      setBudgetOpen(false);
      setNotice(
        kind === 'retry'
          ? '继续处理未完成的候选。'
          : '日报已取消，已完成内容保留。',
      );
    });
  }
  function rescreenItem(id: string) {
    void action('analyze:' + id, async () => {
      const response = await analysisApi<{ run: DailyRun }>(
        'daily-items/' + id + '/rescreen',
        { method: 'POST', body: {}, key: browserRequestId() },
      );
      if (routeRef.current.run === response.run.id) setRun(response.run);
    });
  }
  function analyzeItem(id: string, force = false) {
    void action('analyze:' + id, async () => {
      const r = await analysisApi<{ run: DailyRun }>(
        'daily-items/' + id + '/analyze',
        {
          method: 'POST',
          body: { force_regenerate: force },
          key: browserRequestId(),
        },
      );
      if (routeRef.current.run !== r.run.id) return;
      setRun(r.run);
      setNotice('已加入详细分析队列。');
    });
  }
  function openSingle(jobId: string) {
    try {
      localStorage.setItem('paper-radar.single.real.selected.v1', jobId);
    } catch {
      /* The direct prop below still opens the selected job. */
    }
    setSingleJob(jobId);
    nav('single');
  }
  const presets = subscriptions
    .filter((s) => s.status !== 'archived')
    .map((s) => ({
      id: s.id,
      name: s.name,
      subject: subjectLabel(s),
      tags: s.tags.map((t) => t.label),
      authorIds: [],
      language: s.language,
      summaryLength: s.summary_length,
    }));
  const emptyMessage = run ? emptyDailyMessage(run, filter, query) : null;
  const generationBusy = isBusy('generate:' + selectedSub);
  const workingRun = [run, ...runs].find(
    (r) =>
      r?.subscription.id === selectedSub &&
      active(r.status) &&
      r.subscription.revision === subscription?.revision &&
      matchesDailyDate(r, date),
  );
  const runBusy =
    !!run &&
    ['cancel:', 'retry:', 'delete:'].some((prefix) => isBusy(prefix + run.id));
  const reportLoading =
    loading ||
    (run !== null &&
      (run.subscription.id !== selectedSub || run.id !== selectedRun));
  return (
    <ResearchShell view={view} onView={nav}>
      <main className="workspace">
        <ResearchTopbar view={view} />
        <div className="page-body">
          <ResearchReadiness
            visible={view === 'daily' && subscriptions.length > 0}
            onSettings={() =>
              updateLocation({ view: 'models', settingsTab: 'models' }, 'push')
            }
          />
          {subscriptionError && (
            <p className="daily-notice" role="alert">
              {ui(subscriptionError)}
              <button onClick={() => setTick((v) => v + 1)}>
                {ui('重试读取订阅')}
              </button>
            </p>
          )}
          {operationError && (
            <p className="daily-notice" role="alert">
              {ui(operationError.message)}
              <button onClick={() => setOperationError(null)}>
                {ui('关闭错误提示')}
              </button>
            </p>
          )}
          {generationBusy && (
            <p className="daily-success" aria-live="polite">
              <LoaderCircle className="single-spin" size={16} />{' '}
              {ui(
                date ? ui('正在检查 {0} 的公告…', [date]) : '正在检查最新公告…',
              )}
            </p>
          )}
          {!reportLoading &&
            generation?.subscription === selectedSub &&
            generation.id === run?.id && (
              <p
                className={
                  active(run.status) || run.status === 'completed'
                    ? 'daily-success'
                    : 'daily-notice'
                }
                aria-live="polite"
              >
                {ui(generationNotice(run, generation.reused))}
              </p>
            )}
          {error && (
            <div className="daily-notice" role="alert">
              {ui(error)}
              <button onClick={() => setTick((v) => v + 1)}>
                {ui('刷新连接')}
              </button>
            </div>
          )}
          {notice && (
            <output className="daily-success">
              {ui(notice)}
              <button
                aria-label={ui('关闭提示')}
                onClick={() => setNotice('')}
                style={{ float: 'right' }}
              >
                <X size={16} />
              </button>
            </output>
          )}
          <div hidden={view !== 'models'}>
            {visited.includes('models') && (
              <SettingsWorkspace
                tab={route.settingsTab ?? 'models'}
                onTab={(settingsTab) => updateLocation({ settingsTab })}
              />
            )}
          </div>
          {view === 'evaluations' && (
            <EvaluationsPage
              onOpen={(patch) => updateLocation(patch, 'push')}
            />
          )}
          <div hidden={view !== 'single'}>
            {visited.includes('single') && (
              <RealSingleAnalysis
                key={singleJob ?? 'single'}
                subscriptions={presets}
                onModels={() => nav('models')}
                initialJobId={singleJob ?? undefined}
                onDaily={(id) =>
                  void action('open-daily:' + id, async () => {
                    const selected = await analysisApi<DailyRun>(
                      'daily-runs/' + id,
                    );
                    updateLocation(
                      {
                        subscription: selected.subscription.id,
                        run: selected.id,
                        date: selected.date ?? '',
                        view: 'daily',
                        filter: 'recommended',
                        ...(routeRef.current.run !== selected.id
                          ? {
                              paper: null,
                              section: 'overview' as const,
                              expanded: false,
                            }
                          : {}),
                      },
                      'push',
                    );
                    setOffset(0);
                    setQuery('');
                    setNotice('');
                  })
                }
              />
            )}
          </div>
          {view === 'authors' && (
            <FollowedAuthors
              key={selectedSub}
              subscription={subscription}
              subscriptions={subscriptions}
              onSelect={(id) =>
                updateLocation(
                  { subscription: id, run: null, paper: null, date: '' },
                  'push',
                )
              }
              onSaved={(saved) => {
                setSubscriptions((current) =>
                  current.map((s) => (s.id === saved.id ? saved : s)),
                );
                setTick((v) => v + 1);
              }}
              onSubscriptions={() => nav('subscriptions')}
              onReload={() => setTick((v) => v + 1)}
            />
          )}
          {view === 'subscriptions' && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR RESEARCH SCOPES</p>
                  <h1>{ui('我的订阅')}</h1>
                  <p>
                    {ui('按研究方向保存论文范围、Persona 标签和输出设置。')}
                  </p>
                </div>
                <button
                  className="button-primary"
                  onClick={() => setEditor(null)}
                >
                  <Plus size={17} />
                  {ui('新建订阅')}
                </button>
              </div>
              <label className="daily-check" style={{ margin: '1rem 0' }}>
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                {ui('显示已归档订阅')}
              </label>
              <div className="daily-subscriptions">
                {visibleSubscriptions.map((s) => (
                  <article className="daily-sub-card" key={s.id}>
                    <div className="daily-meta">
                      <span>{ui(subjectLabel(s))}</span>
                      <span>
                        {ui(
                          {
                            enabled: '可运行',
                            draft: '草稿',
                            paused: '停用',
                            archived: '已归档',
                          }[s.status],
                        )}
                      </span>
                    </div>
                    <h2>{s.name}</h2>
                    <FollowAuthorButton
                      onClick={() => openFollowedAuthors(s.id)}
                    />
                    {s.persona_reselection_required && (
                      <p className="daily-notice">
                        {ui('知识库连接已更换，请重新选择标签并启用订阅。')}
                      </p>
                    )}
                    <p>
                      {s.tags.map((t) => t.label).join(' + ') ||
                        ui('尚未选择 Persona 标签')}
                    </p>
                    <p>
                      {ui(s.language === 'zh' ? '中文' : 'English')}{' '}
                      {ui(' · 总结')} {s.summary_length.min}–
                      {s.summary_length.max}{' '}
                      {ui(s.language === 'zh' ? '字' : 'words')}
                      <br />
                      {ui(
                        s.include_updates ? '包含更新版本' : '新作及新跨分类',
                      )}{' '}
                      ·{ui(strictnessLabel(s.recommendation_strictness))}{' '}
                      {ui(' · 每批初筛上限 ')}
                      {s.max_model_calls} {ui(' 次请求')}
                    </p>
                    <AutomaticDaily
                      subscription={s}
                      onRun={(id, date) => {
                        chooseSub(s.id);
                        chooseRun(id, date);
                      }}
                    />
                    <div className="daily-actions">
                      <button
                        className="button-primary"
                        onClick={() => chooseSub(s.id)}
                      >
                        {ui('查看日报')}
                      </button>
                      <button
                        className="button-secondary"
                        onClick={() => setEditor(s)}
                      >
                        <Pencil size={14} />
                        {ui('编辑')}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              {!visibleSubscriptions.length && (
                <div className="daily-empty">
                  <h2>{ui('创建你的第一个订阅')}</h2>
                  <p>
                    {ui(
                      '选择一个 subject 和允许使用的 Persona 标签，开始筛选真实论文。',
                    )}
                  </p>
                  <button
                    className="button-primary"
                    onClick={() => setEditor(null)}
                  >
                    {ui('新建订阅')}
                  </button>
                </div>
              )}
            </>
          )}
          <div hidden={view !== 'daily'}>
            {visited.includes('daily') && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">
                      TODAY · {date || announcementToday()}
                    </p>
                    <h1>{ui('每日论文')}</h1>
                    <p>
                      {subscription
                        ? ui('为「{0}」整理的研究线索', [subscription.name])
                        : ui('保存关注范围，生成你的论文日报。')}
                    </p>
                  </div>
                  <div className="daily-actions">
                    {subscription && (
                      <FollowAuthorButton
                        onClick={() => openFollowedAuthors(subscription.id)}
                      />
                    )}
                    <button
                      className="button-secondary"
                      onClick={() => nav('subscriptions')}
                    >
                      {ui('管理订阅')}
                    </button>
                    {subscription && (
                      <button
                        className="button-primary"
                        disabled={
                          generationBusy ||
                          subscription.status !== 'enabled' ||
                          date > announcementToday()
                        }
                        onClick={() => generate()}
                      >
                        {generationBusy ? (
                          <LoaderCircle size={16} className="single-spin" />
                        ) : (
                          <RefreshCw size={16} />
                        )}
                        {ui(
                          generationBusy
                            ? '正在检查…'
                            : workingRun
                              ? '查看正在生成的日报'
                              : date
                                ? '生成所选日期日报'
                                : '生成最新一批',
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <PersonaConnectionStatus
                  visible={view === 'daily'}
                  onSettings={() =>
                    updateLocation(
                      { view: 'models', settingsTab: 'persona' },
                      'push',
                    )
                  }
                />
                {subscription ? (
                  <>
                    <div className="daily-toolbar daily-context-toolbar">
                      <div className="daily-controls">
                        <label className="daily-subscription-field">
                          <span>{ui('当前订阅')}</span>
                          <select
                            aria-label={ui('当前订阅')}
                            value={selectedSub}
                            onChange={(e) =>
                              e.target.value === '__new__'
                                ? setEditor(null)
                                : chooseSub(e.target.value)
                            }
                          >
                            {subscriptions
                              .filter(
                                (s) =>
                                  s.status !== 'archived' ||
                                  s.id === selectedSub,
                              )
                              .map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} · {ui(subjectLabel(s))}
                                </option>
                              ))}
                            <option value="__new__">{ui('＋ 新建订阅')}</option>
                          </select>
                        </label>
                        <ReportDatePicker
                          value={date}
                          currentDate={!reportLoading ? run?.date : undefined}
                          dates={reportDates}
                          availableDates={availableDates}
                          onChange={chooseDate}
                        />
                      </div>
                      <button
                        className="button-secondary"
                        onClick={() => setHistoryOpen((v) => !v)}
                      >
                        <History size={16} />
                        {ui(historyOpen ? '收起历史' : '生成历史')}
                      </button>
                    </div>
                    {subscription.status !== 'enabled' && (
                      <p className="daily-notice">
                        {ui('此订阅为')}
                        {ui(
                          {
                            draft: '草稿',
                            paused: '停用',
                            archived: '归档',
                            enabled: '可运行',
                          }[subscription.status],
                        )}
                        {ui(
                          '状态。编辑并启用后可以生成新的日报，历史仍可查看。',
                        )}
                      </p>
                    )}
                    {historyOpen && (
                      <>
                        <div className="daily-history">
                          {runs.map((r) => (
                            <button
                              key={r.id}
                              aria-current={selectedRun === r.id}
                              onClick={() => chooseRun(r.id, r.date)}
                            >
                              <span>
                                {ui(r.date ?? '公告获取中')} ·{' '}
                                {r.subscription.name}{' '}
                                {ui(
                                  r.generation
                                    ? ui('· 第 {0} 版', [r.generation])
                                    : '',
                                )}
                              </span>
                              <span className="daily-meta">
                                {ui(dailyStatus(r.status))} ·{' '}
                                {new Date(r.created_at).toLocaleString(locale)}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="daily-pagination">
                          <button
                            className="button-secondary"
                            disabled={historyOffset === 0}
                            onClick={() =>
                              setHistoryOffset((v) => Math.max(0, v - 25))
                            }
                          >
                            {ui('上一页历史')}
                          </button>
                          <button
                            className="button-secondary"
                            disabled={!historyMore}
                            onClick={() => setHistoryOffset((v) => v + 25)}
                          >
                            {ui('下一页历史')}
                          </button>
                        </div>
                      </>
                    )}
                    {date &&
                      reports.filter((r) => r.date === date).length > 1 && (
                        <div className="daily-actions">
                          {reports
                            .filter((r) => r.date === date)
                            .map((r) => (
                              <button
                                className="button-secondary"
                                key={r.id}
                                onClick={() =>
                                  chooseRun(r.current_run_id, r.date)
                                }
                              >
                                {r.date} · {ui(subjectLabel(r))}
                              </button>
                            ))}
                        </div>
                      )}
                    {reportLoading ? (
                      <div className="daily-empty" aria-live="polite">
                        <LoaderCircle
                          className="single-spin"
                          size={26}
                          style={{ margin: 'auto' }}
                        />
                        <h2>{ui('正在读取日报…')}</h2>
                        <p>{ui('正在更新所选日期和论文列表。')}</p>
                      </div>
                    ) : error ? (
                      <div className="daily-empty">
                        <p>{ui('日报暂时无法读取，请重试。')}</p>
                        <button
                          className="button-secondary"
                          onClick={() => setTick((v) => v + 1)}
                        >
                          {ui('重新读取日报')}
                        </button>
                      </div>
                    ) : run ? (
                      <>
                        <details className="research-disclosure daily-run-details">
                          <summary>
                            <span className="daily-status">
                              {ui(dailyStatus(run.status))}
                            </span>{' '}
                            · {run.stats.total} {ui(' 篇')} ·{' '}
                            {run.stats.screening_pending} {ui('初筛未完成')}{' '}
                            <span>{ui('查看运行详情')}</span>
                          </summary>
                          <div className="daily-scope">
                            <p>
                              <strong>
                                {ui(run.date ?? '正在确认公告日期')}
                              </strong>{' '}
                              · {ui(subjectLabel(run.subscription))} ·{' '}
                              {ui(
                                run.subscription.language === 'zh'
                                  ? '中文'
                                  : 'English',
                              )}{' '}
                              ·{' '}
                              {ui(
                                strictnessLabel(
                                  run.subscription.recommendation_strictness,
                                ),
                              )}{' '}
                              {ui('· 按需总结 ')}
                              {run.subscription.summary_length.min}–
                              {run.subscription.summary_length.max}{' '}
                              {ui(
                                run.subscription.language === 'zh'
                                  ? '字'
                                  : 'words',
                              )}
                            </p>
                            <p>
                              {ui('Persona：')}
                              {(run.persona?.tags ?? run.subscription.tags)
                                .map((t) => t.label)
                                .join(' + ')}
                              {ui(
                                run.persona
                                  ? ui(' · 初筛 revision {0}', [
                                      run.persona.revision,
                                    ])
                                  : '',
                              )}{' '}
                              ·{' '}
                              {run.models
                                .map((m) => m.model)
                                .filter((m, i, a) => a.indexOf(m) === i)
                                .join(' / ')}
                            </p>
                            {run.subscription.revision !==
                              subscription.revision && (
                              <p>
                                {ui('这份日报使用订阅第 ')}
                                {run.subscription.revision}{' '}
                                {ui('版，当前订阅已更新。历史内容保持原设置。')}
                              </p>
                            )}
                          </div>
                          {!sameSubjects(run.subscription, subscription) && (
                            <p className="daily-notice">
                              {ui(
                                '分类范围已改变，请点击“生成最新一批”收集新范围的论文；这份历史日报保留原范围。',
                              )}
                            </p>
                          )}
                          <div className="stat-strip daily-stat-strip">
                            {[
                              { num: run.stats.total, label: ui('筛选候选') },
                              { num: run.stats.recommended, label: ui('推荐') },
                              {
                                num: run.stats.not_recommended,
                                label: ui('未推荐'),
                              },
                              {
                                num: run.stats.screening_pending,
                                label: ui('初筛未完成'),
                              },
                              {
                                num: run.stats.needs_confirmation,
                                label: ui('关联待确认'),
                              },
                            ].map((s) => (
                              <div className="stat-item" key={s.label}>
                                <div>
                                  <strong style={{ fontSize: '1.6rem' }}>
                                    {s.num}
                                  </strong>
                                  <span
                                    style={{
                                      display: 'block',
                                      fontSize: '.9rem',
                                      color: '#707c92',
                                    }}
                                  >
                                    {ui(s.label)}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <section
                            className="daily-progress"
                            aria-live="polite"
                          >
                            <div className="daily-meta">
                              <span
                                className={
                                  'daily-status ' +
                                  ([
                                    'partial',
                                    'failed',
                                    'paused',
                                    'interrupted',
                                  ].includes(run.status)
                                    ? 'bad'
                                    : '')
                                }
                              >
                                {active(run.status) && (
                                  <LoaderCircle
                                    size={14}
                                    className="single-spin"
                                  />
                                )}
                                {ui(dailyStatus(run.status))}
                              </span>
                              <span>
                                {ui('初筛完成 ')}
                                {run.stats.screened}/{run.stats.total}{' '}
                                {ui(' · 按需报告 ')}
                                {run.stats.details_complete} {ui(' 份')}
                              </span>
                            </div>
                            <p
                              style={{
                                marginTop: '.7rem',
                                fontSize: '1rem',
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {ui(run.message)}
                              {run.error && (
                                <span className="daily-notice" role="alert">
                                  {ui(run.error.message)}
                                </span>
                              )}
                            </p>
                            <progress
                              aria-label={ui('已完成初筛比例')}
                              max={run.stats.total || 1}
                              value={run.stats.screened}
                            />
                            <div className="daily-meta">
                              <span>
                                {ui('模型请求 ')}
                                {run.actual_attempts}/{run.max_model_calls}
                              </span>
                              <span>
                                {ui('输入 ')}
                                {run.usage.input.toLocaleString(locale)}{' '}
                                {ui(' / 输出')}{' '}
                                {run.usage.output.toLocaleString(locale)} tokens
                              </span>
                              <span>
                                {ui(
                                  run.usage.cost === null
                                    ? '费用未提供'
                                    : ui('费用 ${0}', [
                                        run.usage.cost.toFixed(3),
                                      ]),
                                )}
                              </span>
                            </div>
                            <div className="daily-actions">
                              {active(run.status) ? (
                                <button
                                  className="button-secondary"
                                  disabled={runBusy}
                                  onClick={() => runAction('cancel')}
                                >
                                  {ui('取消本批任务')}
                                </button>
                              ) : (
                                <>
                                  <button
                                    className="button-secondary"
                                    disabled={
                                      runBusy || run.status === 'completed'
                                    }
                                    onClick={() => {
                                      setBudget(
                                        Math.max(
                                          run.max_model_calls,
                                          run.actual_attempts + 50,
                                        ),
                                      );
                                      setBudgetOpen(true);
                                    }}
                                  >
                                    {ui('继续未完成部分')}
                                  </button>
                                  <button
                                    className="button-secondary"
                                    disabled={
                                      generationBusy ||
                                      runBusy ||
                                      !run.discovery ||
                                      !sameSubjects(
                                        run.subscription,
                                        subscription,
                                      ) ||
                                      subscription.status !== 'enabled'
                                    }
                                    onClick={() => generate(true, true)}
                                  >
                                    {ui('按当前订阅重新筛选本批')}
                                  </button>
                                  <button
                                    className="button-secondary"
                                    disabled={runBusy || !run.report_id}
                                    onClick={() => setDeleteOpen(true)}
                                  >
                                    <Trash2 size={14} />
                                    {ui('删除日报')}
                                  </button>
                                </>
                              )}
                            </div>
                          </section>
                          {run.stats.recommended > 0 &&
                            (filter !== 'recommended' || query) && (
                              <div className="daily-success" aria-live="polite">
                                {ui('已有 ')}
                                {run.stats.recommended} {ui(' 篇推荐可查看。')}
                                <button
                                  className="daily-link"
                                  onClick={() => {
                                    setFilter('recommended');
                                    setOffset(0);
                                    setQuery('');
                                  }}
                                >
                                  {ui('查看推荐论文')}
                                </button>
                              </div>
                            )}
                          {run.discovery && (
                            <details className="daily-scope">
                              <summary>
                                {ui('公告来源与覆盖 ·')}{' '}
                                {ui(
                                  run.discovery.completeness === 'complete'
                                    ? '已完整读取本次来源'
                                    : '存在覆盖缺口',
                                )}{' '}
                                · {run.discovery.raw_count} {ui(' 条公告')}
                              </summary>
                              <p>{ui(run.discovery.coverage_basis)}</p>
                              <p>
                                {ui('合并重复 ')}
                                {run.discovery.duplicates}{' '}
                                {ui(' 条 · 版本动态')} {run.stats.excluded}{' '}
                                {ui(' 条')}
                              </p>
                              {run.discovery.issues.map((s, i) => (
                                <p key={i}>{ui(s)}</p>
                              ))}
                              {run.discovery.sources?.length ? (
                                <div className="daily-source-list">
                                  <p>
                                    {ui('跨分类合并重复')}{' '}
                                    {run.discovery.cross_subject_duplicates ??
                                      0}{' '}
                                    {ui('条；同一篇论文只筛选一次。')}
                                  </p>
                                  {run.discovery.sources.map((source) => (
                                    <div key={source.subject}>
                                      <a
                                        className="daily-link"
                                        href={source.source_url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {ui(source.subject)}{' '}
                                        <ArrowUpRight size={13} />
                                      </a>
                                      <span>
                                        {' '}
                                        · {ui(source.date ?? '日期未确认')} ·{' '}
                                        {ui(
                                          source.status === 'failed'
                                            ? '读取失败'
                                            : source.status === 'different_date'
                                              ? '日期不同，未纳入'
                                              : source.completeness ===
                                                  'complete'
                                                ? '已纳入'
                                                : '已纳入，覆盖有缺口',
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <a
                                  className="daily-link"
                                  href={run.discovery.source_url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {ui('查看官方来源 ')}
                                  <ArrowUpRight size={13} />
                                </a>
                              )}
                            </details>
                          )}
                        </details>
                        <div className="daily-filters paper-filter-tabs">
                          {[
                            {
                              id: 'followed_authors',
                              label: ui('关注作者'),
                              count: run.stats.followed_authors ?? 0,
                            },
                            {
                              id: 'recommended',
                              label: ui('推荐'),
                              count: run.stats.recommended,
                            },
                            {
                              id: 'not_recommended',
                              label: ui('未推荐'),
                              count: run.stats.not_recommended,
                            },
                            {
                              id: 'unscreened',
                              label: ui('初筛未完成'),
                              count: run.stats.screening_pending,
                            },
                            {
                              id: 'needs_confirmation',
                              label: ui('关联待确认'),
                              count: run.stats.needs_confirmation,
                            },
                            {
                              id: 'excluded',
                              label: ui('版本动态'),
                              count: run.stats.excluded,
                            },
                          ].map((f) => (
                            <button
                              key={f.id}
                              aria-pressed={filter === f.id}
                              onClick={() => {
                                setFilter(f.id);
                                setOffset(0);
                              }}
                            >
                              {ui(f.label)} <span>{f.count}</span>
                            </button>
                          ))}
                        </div>
                        <div className="daily-toolbar daily-search-toolbar">
                          <label className="paper-search">
                            <Search size={17} aria-hidden="true" />
                            <input
                              type="search"
                              aria-label={ui('搜索本批论文标题或作者')}
                              placeholder={ui('搜索标题或作者')}
                              value={query}
                              onChange={(e) => {
                                setQuery(e.target.value);
                                setOffset(0);
                              }}
                            />
                          </label>
                          <span className="daily-meta">
                            {total} {ui(' 篇')}
                          </span>
                        </div>
                        <div
                          className={
                            'paper-split' +
                            (selectedItem ? ' has-selection' : '') +
                            (route.expanded ? ' is-expanded' : '')
                          }
                        >
                          <div
                            className="paper-list-pane"
                            ref={(element) => {
                              if (element)
                                element.scrollTop = listScroll.current;
                            }}
                            onScroll={(event) => {
                              listScroll.current =
                                event.currentTarget.scrollTop;
                            }}
                          >
                            <div className="paper-list-heading">
                              <div>
                                <strong>{ui('论文列表')}</strong>
                                <span>
                                  {total} {ui('篇')}
                                </span>
                              </div>
                              <small>{ui('按匹配结果排序')}</small>
                            </div>
                            <div className="daily-paper-list">
                              {items.map((item) => (
                                <article
                                  className={
                                    'paper-list-row' +
                                    (selectedItem === item.id
                                      ? ' selected'
                                      : '')
                                  }
                                  key={item.id}
                                >
                                  <button
                                    className="paper-row-button"
                                    aria-current={
                                      selectedItem === item.id
                                        ? 'true'
                                        : undefined
                                    }
                                    onClick={() => setSelectedItem(item.id)}
                                  >
                                    <span className="daily-meta">
                                      {item.paper.id}v{item.paper.version}
                                      <span>
                                        {ui(
                                          item.excluded
                                            ? '更新'
                                            : item.screening
                                              ? screeningHeading(item)
                                              : dailyStatus(
                                                  item.processing_status,
                                                ),
                                        )}
                                      </span>
                                    </span>
                                    <h2>{item.paper.title}</h2>
                                    <p className="paper-row-authors">
                                      {item.paper.authors
                                        .map(academicName)
                                        .join(', ')}
                                    </p>
                                    <p className="paper-row-description">
                                      {item.screening?.data.introduction ??
                                        item.screening?.data.reason ??
                                        item.paper.abstract}
                                    </p>
                                    <span className="paper-row-footer">
                                      {item.screening_reuse?.reused && (
                                        <>{ui('复用已有筛选')} · </>
                                      )}
                                      {ui(detailStatus(item.details_status))}
                                      <ChevronRight size={15} />
                                    </span>
                                    {(item.error || item.details_error) && (
                                      <span className="paper-row-error">
                                        {ui(
                                          item.details_error
                                            ? '详细分析需要重试'
                                            : '初筛未完成',
                                        )}
                                      </span>
                                    )}
                                  </button>
                                </article>
                              ))}
                            </div>
                            {!items.length && (
                              <div className="daily-empty">
                                <FileText
                                  size={26}
                                  style={{ margin: 'auto' }}
                                />
                                <h2>{ui(emptyMessage?.title)}</h2>
                                <p>{ui(emptyMessage?.description)}</p>
                                {query && (
                                  <button
                                    className="button-secondary"
                                    onClick={() => {
                                      setQuery('');
                                      setOffset(0);
                                    }}
                                  >
                                    {ui('清空搜索')}
                                  </button>
                                )}
                              </div>
                            )}
                            <div className="daily-pagination">
                              <button
                                className="button-secondary"
                                disabled={offset === 0}
                                onClick={() =>
                                  setOffset((v) => Math.max(0, v - 25))
                                }
                              >
                                {ui('上一页')}
                              </button>
                              <span className="daily-meta">
                                {ui('第 ')}
                                {Math.floor(offset / 25) + 1} {ui(' 页')}
                              </span>
                              <button
                                className="button-secondary"
                                disabled={nextOffset === null}
                                onClick={() => setOffset(nextOffset!)}
                              >
                                {ui('下一页')}
                              </button>
                            </div>
                          </div>
                          {selectedItem ? (
                            <DailyDetails
                              key={selectedItem ?? 'closed'}
                              itemId={selectedItem}
                              onClose={() => setSelectedItem(null)}
                              onAnalyze={analyzeItem}
                              onRescreen={rescreenItem}
                              analyzing={
                                !!selectedItem &&
                                isBusy('analyze:' + selectedItem)
                              }
                              refreshToken={tick}
                              actionError={
                                operationError?.key ===
                                'analyze:' + selectedItem
                                  ? operationError.message
                                  : ''
                              }
                              section={route.section}
                              onSection={(section) =>
                                updateLocation({ section })
                              }
                              expanded={route.expanded}
                              onExpand={() =>
                                updateLocation({ expanded: !route.expanded })
                              }
                              onSingle={openSingle}
                            />
                          ) : (
                            <div className="paper-reader-placeholder">
                              <FileText size={26} />
                              <h2>{ui('选择一篇论文开始阅读')}</h2>
                              <p>{ui('在这里阅读概览和完整报告。')}</p>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="daily-empty">
                        <Radar size={30} style={{ margin: 'auto' }} />
                        <h2>
                          {ui(
                            date
                              ? '该公告日期没有已保存的日报'
                              : '还没有生成日报',
                          )}
                        </h2>
                        <p>
                          {ui(
                            date
                              ? ui(
                                  '点击“生成所选日期日报”，读取 {0} 的公告存档或日期匹配的官方当前公告。缺少来源时会明确提示。',
                                  [date],
                                )
                              : '点击“生成最新一批”，先查看文章介绍和推荐理由，再按需生成详细报告。',
                          )}
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="daily-empty">
                    <Radar size={30} style={{ margin: 'auto' }} />
                    <h2>{ui('从一个研究方向开始')}</h2>
                    <p>
                      {ui(
                        '选择 arXiv subject 和 Persona 标签，设置你希望看到的总结长度。',
                      )}
                    </p>
                    <button
                      className="button-primary"
                      onClick={() => setEditor(null)}
                    >
                      <Plus size={16} />
                      {ui('新建订阅')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
      <LiveSubscriptionEditor
        key={editor === undefined ? 'closed' : (editor?.id ?? 'new')}
        subscription={editor}
        onClose={() => setEditor(undefined)}
        onSaved={(s) => {
          setSubscriptions((prev) =>
            prev.some((x) => x.id === s.id)
              ? prev.map((x) => (x.id === s.id ? s : x))
              : [...prev, s],
          );
          setEditor(undefined);
          if (!editor || !selectedSub) chooseSub(s.id);
          setNotice('订阅已保存到本机服务。');
          setTick((v) => v + 1);
        }}
        tags={tags}
        personaId={personaId}
        personaError={personaError}
        subjects={subjects}
        onRefreshTags={() => setTagsTick((v) => v + 1)}
      />
      <Dialog open={budgetOpen} onOpenChange={setBudgetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ui('继续这份日报')}</DialogTitle>
            <DialogDescription>
              {ui(
                '保留原订阅和模型设置，只重试未完成项。已完成的判断和反馈保留。',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="daily-editor">
            <label>
              <span>{ui('这份日报的总模型请求上限')}</span>
              <input
                type="number"
                min={run?.actual_attempts ?? 1}
                max={2000}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
              <small>
                {ui('已使用 ')}
                {run?.actual_attempts ?? 0}{' '}
                {ui('次；额度是整个日报的累计上限。')}
              </small>
            </label>
            <button
              className="button-primary"
              disabled={runBusy}
              onClick={() => runAction('retry', budget)}
            >
              {ui('继续处理')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ui('删除这份日报及其所有版本？')}</DialogTitle>
            <DialogDescription>
              {ui(
                '会删除该日报的运行历史、显式反馈和独占个人分析。订阅和公共论文来源保留。',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="daily-actions">
            <button
              className="button-secondary"
              onClick={() => setDeleteOpen(false)}
            >
              {ui('保留')}
            </button>
            <button
              className="button-primary"
              disabled={runBusy}
              onClick={() => {
                if (run?.report_id)
                  void action('delete:' + run.id, async () => {
                    await analysisApi('daily-reports/' + run.report_id, {
                      method: 'DELETE',
                    });
                    setDeleteOpen(false);
                    setSelectedRun(null);
                    setRun(null);
                    setItems([]);
                    setNotice('日报已删除。');
                  });
              }}
            >
              {ui('删除日报')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </ResearchShell>
  );
}
