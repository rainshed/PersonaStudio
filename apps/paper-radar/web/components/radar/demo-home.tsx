'use client';
import {
  EvaluationsPage,
  type ResearchFeedback,
} from '@/components/radar/evaluations';
import { FeedbackControl } from '@/components/radar/feedback';
import {
  ResearchShell,
  ResearchTopbar,
} from '@/components/radar/research-shell';
import { SettingsWorkspace } from '@/components/radar/settings-workspace';
import { SingleAnalysisPage } from '@/components/radar/single-analysis-entry';
import { SubscriptionEditor } from '@/components/radar/subscription-editor';
import { DemoPaperReader } from './demo-paper-reader';
import { FollowAuthorButton } from './follow-author-button';
import { useUiLanguage } from '@/components/radar/ui-language';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AUTHORS,
  DEFAULT_SUBSCRIPTIONS,
  DEFAULT_SUMMARY_LENGTH,
  PAPERS,
  SUBJECTS,
  applyFeedback,
  candidates,
  connectionsFor,
  feedbackKey,
  hydrateDemo,
  isRecommended,
  reasonFor,
  scopeMaterials,
  type Feedback,
  type FeedbackDimension,
  type FeedbackStore,
  type Material,
  type Paper,
  type Subscription,
} from '@/lib/radar';
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  Info,
  Languages,
  Link2,
  Pencil,
  Plus,
  Radar,
  Radio,
  Search,
  Settings2,
  Sparkles,
  Tag,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
type View = import('@/lib/radar-location').RadarView;
type Feed = 'recommended' | 'other' | 'authors';
const STORAGE_KEY = 'paper-radar.demo.v1';
export function DemoHome() {
  const { ui, uiLanguage } = useUiLanguage();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(
    DEFAULT_SUBSCRIPTIONS,
  );
  const [activeId, setActiveId] = useState('transport');
  const [view, setView] = useState<View>('daily');
  const [visited, setVisited] = useState<string[]>([]);
  if (!visited.includes(view)) setVisited([...visited, view]);
  const [feed, setFeed] = useState<Feed>('recommended');
  const [date, setDate] = useState('2026-09-06');
  const [query, setQuery] = useState('');
  const [authorQuery, setAuthorQuery] = useState('');
  const authorSearch = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (view === 'authors') authorSearch.current?.focus();
  }, [view]);
  const [selected, setSelected] = useState<string | null>(null);
  const [demoSection, setDemoSection] = useState('overview');
  const [readerExpanded, setReaderExpanded] = useState(false);
  const demoListScroll = useRef(0);
  const [sectionPaper, setSectionPaper] = useState(selected);
  if (sectionPaper !== selected) {
    setSectionPaper(selected);
    setDemoSection('overview');
  }
  const [editor, setEditor] = useState<Subscription | null>(null);
  const [material, setMaterial] = useState<Material | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackStore>({});
  const [ready, setReady] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const subscription =
    subscriptions.find((s) => s.id === activeId) ?? subscriptions[0];
  const language = subscription.language;
  const tr = (zh: string, english: string) =>
    uiLanguage === 'en' ? english : zh;
  const all = candidates(subscription, date),
    recommended = all.filter((p) => isRecommended(p, subscription)),
    other = all.filter((p) => !isRecommended(p, subscription));
  const authorPapers = PAPERS.filter(
    (p) =>
      p.date === date &&
      p.subjects.includes(subscription.subject) &&
      p.authors.some((a) => subscription.authorIds.includes(a)),
  );
  const materials = scopeMaterials(subscription.tags);
  const paper = PAPERS.find((p) => p.id === selected);
  const subject = SUBJECTS.find((s) => s.id === subscription.subject)!;
  const listed = (
    feed === 'recommended'
      ? recommended
      : feed === 'other'
        ? other
        : authorPapers
  ).filter((p) =>
    [
      p.title,
      p.topic.zh,
      p.topic.en,
      ...p.authors.map((id) => AUTHORS.find((a) => a.id === id)?.name ?? ''),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (location.hash === '#single-analysis') setView('single');
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = hydrateDemo(JSON.parse(raw));
          if (saved) {
            setSubscriptions(saved.subscriptions);
            setActiveId(saved.activeId);
            setFeedback(saved.feedback);
          } else setStorageWarning(true);
        }
      } catch {
        setStorageWarning(true);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ subscriptions, activeId, feedback }),
      );
    } catch {
      void Promise.resolve().then(() => setStorageWarning(true));
    }
  }, [subscriptions, activeId, feedback, ready]);
  function switchSubscription(id: string) {
    history.replaceState(null, '', location.pathname + location.search);
    setActiveId(id);
    setView('daily');
    setFeed('recommended');
    setQuery('');
    setSelected(null);
    setSavedMessage('');
  }
  function newSubscription() {
    setEditor({
      id: 'sub-' + Date.now(),
      name: '',
      subject: 'cond-mat.stat-mech',
      tags: [],
      authorIds: [],
      language: 'zh',
      summaryLength: { ...DEFAULT_SUMMARY_LENGTH },
    });
  }
  function openFollowedAuthors(id: string) {
    setActiveId(id);
    setView('authors');
    setAuthorQuery('');
    setSelected(null);
  }
  function saveSubscription(s: Subscription) {
    setSubscriptions((prev) =>
      prev.some((x) => x.id === s.id)
        ? prev.map((x) => (x.id === s.id ? s : x))
        : [...prev, s],
    );
    setEditor(null);
    if (s.id !== subscription.id) switchSubscription(s.id);
    setSavedMessage('订阅已保存到当前浏览器');
  }
  function followAuthor(id: string) {
    setSubscriptions((prev) =>
      prev.map((s) =>
        s.id === subscription.id
          ? {
              ...s,
              authorIds: s.authorIds.includes(id)
                ? s.authorIds.filter((x) => x !== id)
                : [...s.authorIds, id],
            }
          : s,
      ),
    );
  }
  function writeFeedback(
    p: Paper,
    dimension: FeedbackDimension,
    value: Feedback | null,
  ) {
    setFeedback((prev) =>
      applyFeedback(
        prev,
        feedbackKey(p, subscription, dimension),
        dimension,
        value,
      ),
    );
  }
  const stateRef = useRef({
    subscriptions,
    subscription,
    feedback,
    ready,
    date,
  });
  useEffect(() => {
    stateRef.current = { subscriptions, subscription, feedback, ready, date };
  }, [subscriptions, subscription, feedback, ready, date]);
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options?: { signal: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tools = [
      {
        name: 'get_paper_radar_demo',
        title: 'Read Paper Radar demo',
        description:
          'Read current demo subscription and its visible paper IDs. Mock data only.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => {
          const s = stateRef.current;
          return {
            subscription: s.subscription,
            papers: candidates(s.subscription, s.date).map((p) => ({
              id: p.id,
              title: p.title,
              recommended: isRecommended(p, s.subscription),
            })),
            ready: s.ready,
          };
        },
      },
      {
        name: 'open_paper_analysis',
        title: 'Open paper analysis',
        description:
          'Open a paper detail in the current demo subscription. Does not record feedback or reading status.',
        inputSchema: {
          type: 'object',
          properties: { paperId: { type: 'string' } },
          required: ['paperId'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: (input: unknown) => {
          if (
            !input ||
            typeof input !== 'object' ||
            typeof (input as { paperId?: unknown }).paperId !== 'string'
          )
            throw new Error('paperId must be a string');
          const id = (input as { paperId: string }).paperId;
          const s = stateRef.current;
          const p = PAPERS.find(
            (x) =>
              x.id === id &&
              x.date === s.date &&
              x.subjects.includes(s.subscription.subject),
          );
          if (!p)
            throw new Error(
              'Paper is not in the current subscription or author feed',
            );
          flushSync(() => setSelected(id));
          return { openedPaperId: id, feedbackChanged: false };
        },
      },
    ];
    for (const tool of tools) {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => {});
      } catch {
        /* optional browser capability */
      }
    }
    return () => lifecycle.abort();
  }, []);
  function renderFeedback(
    p: Paper,
    dimension: FeedbackDimension,
    compact = false,
  ) {
    return (
      <FeedbackControl
        dimension={dimension}
        value={feedback[feedbackKey(p, subscription, dimension)]?.[dimension]}
        onChange={(v) => writeFeedback(p, dimension, v)}
        language={language}
        compact={compact}
        disabled={!ready}
        notRecommended={!isRecommended(p, subscription)}
      />
    );
  }
  const demoReader = (
    <DemoPaperReader
      paper={paper}
      subscription={subscription}
      demoSection={demoSection}
      setDemoSection={setDemoSection}
      readerExpanded={readerExpanded}
      setReaderExpanded={setReaderExpanded}
      onClose={() => setSelected(null)}
      setEditor={setEditor}
      setMaterial={setMaterial}
      renderFeedback={renderFeedback}
    />
  );
  const demoFeedback: ResearchFeedback[] = subscriptions
    .flatMap((sub) =>
      PAPERS.flatMap((paper) =>
        (['accuracy'] as const).flatMap((dimension) => {
          const saved =
            feedback[feedbackKey(paper, sub, dimension)]?.[dimension];
          return saved
            ? [
                {
                  kind: 'screening' as const,
                  version_id: feedbackKey(paper, sub, dimension),
                  job_id: null,
                  item_id: paper.id,
                  run_id: null,
                  subscription_id: sub.id,
                  date: paper.date,
                  title: paper.title,
                  paper_id: paper.id,
                  dimension,
                  feedback: saved,
                  expected_outcome: ((saved.value === 'positive') ===
                  isRecommended(paper, sub)
                    ? 'recommended'
                    : 'not_recommended') as 'recommended' | 'not_recommended',
                  updated_at: saved.updatedAt,
                },
              ]
            : [];
        }),
      ),
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return (
    <ResearchShell view={view} onView={setView} demo>
      <main className="workspace">
        <ResearchTopbar view={view} onAbout={() => setAboutOpen(true)} />
        <div className="page-body">
          {storageWarning && (
            <div className="notice">
              {ui(
                '本地数据无法完整读取或保存。当前操作仍然可用，但刷新后可能无法保留。',
              )}
            </div>
          )}
          {savedMessage && (
            <output className="success-line">
              <Check size={14} />
              {ui(savedMessage)}
              <button
                aria-label={ui('关闭提示')}
                onClick={() => setSavedMessage('')}
              >
                <X size={14} />
              </button>
            </output>
          )}
          {view !== 'models' && view !== 'single' && view !== 'evaluations' && (
            <div className="page-heading">
              <div>
                <p className="eyebrow">
                  {ui(
                    view === 'daily'
                      ? `TODAY · ${date}`
                      : view === 'subscriptions'
                        ? 'FOLLOW YOUR CURIOSITY'
                        : 'PEOPLE BEHIND THE PAPERS',
                  )}
                </p>
                <h1>
                  {ui(
                    view === 'daily'
                      ? tr('今日论文', 'Daily papers')
                      : view === 'subscriptions'
                        ? '我的订阅'
                        : '关注作者',
                  )}
                </h1>
                <p>
                  {view === 'daily'
                    ? tr(
                        ui('为「{0}」整理的每日研究线索', [subscription.name]),
                        `Your daily research selection · ${subscription.name}`,
                      )
                    : view === 'subscriptions'
                      ? ui('用不同的范围，关注不同的研究方向。')
                      : ui('为「{0}」选择关注的研究者。', [subscription.name])}
                </p>
              </div>
              <div className="heading-actions">
                {view === 'daily' && (
                  <FollowAuthorButton onClick={() => openFollowedAuthors(subscription.id)} />
                )}
                {view === 'daily' && (
                  <label className="date-picker">
                    <CalendarDays size={15} />
                    <input
                      type="date"
                      aria-label={ui('论文批次日期')}
                      value={date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setSelected(null);
                      }}
                    />
                  </label>
                )}
                <button className="button-primary" onClick={newSubscription}>
                  <Plus size={17} />
                  <span>{ui('新建订阅')}</span>
                </button>
              </div>
            </div>
          )}
          <div hidden={view !== 'models'}>
            {visited.includes('models') && <SettingsWorkspace demo />}
          </div>
          {view === 'evaluations' && (
            <EvaluationsPage
              demoItems={demoFeedback}
              onOpen={(route) => {
                if (route.subscription) setActiveId(route.subscription);
                if (route.date) setDate(route.date);
                setSelected(route.paper ?? null);
                setDemoSection('overview');
                setView('daily');
              }}
            />
          )}
          <div hidden={view !== 'single'}>
            {visited.includes('single') && (
              <SingleAnalysisPage
                subscriptions={subscriptions}
                onModels={() => {
                  setView('models');
                  history.replaceState(
                    null,
                    '',
                    location.pathname + location.search,
                  );
                }}
              />
            )}
          </div>
          {view === 'daily' && (
            <>
              <div className="daily-toolbar daily-context-toolbar">
                <label className="daily-subscription-field">
                  <span>{ui('当前订阅')}</span>
                  <select
                    aria-label={ui('当前订阅')}
                    value={activeId}
                    onChange={(e) => switchSubscription(e.target.value)}
                  >
                    {subscriptions.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button-secondary"
                  onClick={() => setEditor(subscription)}
                >
                  {ui('编辑订阅')}
                </button>
                <button
                  className="button-secondary"
                  onClick={() => setScopeOpen(true)}
                >
                  {ui('查看使用范围')}
                </button>
              </div>
              <details className="research-disclosure demo-run-summary">
                <summary>
                  {ui('演示批次')} · {all.length} {ui(' 篇')} ·{' '}
                  {subscription.tags.join(' + ')}
                </summary>
                <div className="stat-strip">
                  {[
                    {
                      icon: FileText,
                      num: all.length,
                      label: tr(ui('范围内新论文'), 'New papers in scope'),
                      color: '',
                    },
                    {
                      icon: Sparkles,
                      num: recommended.length,
                      label: tr(ui('推荐关注'), 'Recommended'),
                      color: 'blue',
                    },
                    {
                      icon: Radio,
                      num: authorPapers.length,
                      label: tr(ui('关注作者的新作'), 'From followed authors'),
                      color: 'green',
                    },
                  ].map(({ icon: Icon, num, label, color }) => (
                    <div className="stat" key={label}>
                      <div className={'stat-icon ' + color}>
                        <Icon size={20} />
                      </div>
                      <div>
                        <div className="stat-number">
                          {ui(num.toString().padStart(2, '0'))}
                        </div>
                        <div className="stat-text">{ui(label)}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mobile-scope">
                  <button onClick={() => setEditor(subscription)}>
                    <Tag size={14} />
                    {subscription.tags.join(' + ') || ui('通用推荐')}
                    <span> · {subject.id}</span>
                    <Settings2 size={14} />
                  </button>
                </div>
              </details>
              <div
                className={
                  'paper-split demo-paper-split' +
                  (paper ? ' has-selection' : '') +
                  (readerExpanded && paper ? ' is-expanded' : '')
                }
              >
                <section
                  className="paper-list-pane"
                  aria-label={ui('论文列表')}
                  ref={(element) => {
                    if (element) element.scrollTop = demoListScroll.current;
                  }}
                  onScroll={(event) => {
                    demoListScroll.current = event.currentTarget.scrollTop;
                  }}
                >
                  <Tabs
                    value={feed}
                    onValueChange={(v) => {
                      setFeed(v as Feed);
                      setQuery('');
                    }}
                    className="feed-tabs"
                  >
                    <div className="feed-toolbar">
                      <TabsList variant="line">
                        <TabsTrigger value="authors">
                          {ui(tr('作者动态', 'Authors'))}
                          <span className="tab-number">
                            {authorPapers.length}
                          </span>
                        </TabsTrigger>
                        <TabsTrigger value="recommended">
                          {ui(tr('推荐阅读', 'Recommended'))}
                          <span className="tab-number">
                            {recommended.length}
                          </span>
                        </TabsTrigger>
                        <TabsTrigger value="other">
                          {ui(tr('未推荐', 'Not recommended'))}
                          <span className="tab-number">{other.length}</span>
                        </TabsTrigger>
                      </TabsList>
                    </div>
                  </Tabs>
                  <div className="feed-subtoolbar">
                    <span>
                      {ui(
                        feed === 'recommended'
                          ? tr(
                              '与你的关注内容建立联系',
                              'Connected to your research interests',
                            )
                          : feed === 'other'
                            ? tr(
                                '保留全部结果，方便发现遗漏',
                                'All remaining results, so nothing is hidden',
                              )
                            : tr(
                                '作者新作独立提醒，可能超出 subject 范围',
                                'Author alerts may extend beyond the selected subject',
                              ),
                      )}
                    </span>
                    <div className="search-box">
                      <Search size={15} />
                      <input
                        aria-label={ui('搜索论文')}
                        placeholder={ui(
                          tr('搜索论文或作者', 'Search papers or authors'),
                        )}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          aria-label={ui('清空论文搜索')}
                          onClick={() => setQuery('')}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                  {listed.length === 0 ? (
                    <Empty className="feed-empty">
                      <EmptyHeader>
                        <EmptyMedia>
                          <Radar size={36} strokeWidth={1.2} />
                        </EmptyMedia>
                        <EmptyTitle>
                          {ui(
                            query
                              ? tr('没有匹配的论文', 'No matching papers')
                              : tr(
                                  '这个范围暂时没有论文',
                                  'No papers in this selection',
                                ),
                          )}
                        </EmptyTitle>
                        <EmptyDescription>
                          {ui(
                            query
                              ? tr(
                                  '试试其他标题、话题或作者名。',
                                  'Try another title, topic, or author.',
                                )
                              : tr(
                                  '演示数据覆盖 9 月 5 日和 6 日。你也可以修改 subject 或 Persona 标签。',
                                  'Demo batches are available for September 5 and 6. You can also change the subject or Persona tags.',
                                ),
                          )}
                        </EmptyDescription>
                      </EmptyHeader>
                      {query ? (
                        <button
                          className="button-secondary"
                          onClick={() => setQuery('')}
                        >
                          {ui(tr('清空搜索', 'Clear search'))}
                        </button>
                      ) : (
                        <button
                          className="button-secondary"
                          onClick={() => {
                            setDate('2026-09-06');
                            setEditor(subscription);
                          }}
                        >
                          {ui(tr('调整订阅', 'Edit subscription'))}
                        </button>
                      )}
                    </Empty>
                  ) : (
                    listed.map((p, index) => {
                      const rec = isRecommended(p, subscription);
                      const linked = connectionsFor(p, subscription);
                      return (
                        <article
                          className={
                            'paper-card ' +
                            (!rec ? 'muted-paper ' : '') +
                            (selected === p.id ? 'selected' : '')
                          }
                          key={p.id}
                        >
                          <div className="paper-meta">
                            <span className={'tag ' + (!rec ? 'gray' : '')}>
                              {p.topic[language]}
                            </span>
                            <span>{ui(p.subjects[0])}</span>
                            {feed === 'authors' && (
                              <span className="tag green">
                                <Bell size={11} />
                                {ui(tr('作者新作', 'Author update'))}
                              </span>
                            )}
                            <span className="paper-index">
                              {ui(String(index + 1).padStart(2, '0'))}
                            </span>
                          </div>
                          <button
                            className="paper-title-button"
                            onClick={() => setSelected(p.id)}
                          >
                            <h2>{p.title}</h2>
                          </button>
                          <p className="paper-authors">
                            {p.authors
                              .map(
                                (id) => AUTHORS.find((a) => a.id === id)?.name,
                              )
                              .join(', ')}
                          </p>
                          <p className="paper-summary">
                            {p.overview[language]}
                          </p>
                          <div
                            className={
                              'reason-snippet ' +
                              (!rec ? 'not-recommended' : '')
                            }
                          >
                            {rec ? <Sparkles size={16} /> : <Info size={16} />}
                            <p>
                              <strong>
                                {ui(
                                  rec
                                    ? tr('为什么推荐', 'Why this paper')
                                    : tr('筛选说明', 'Screening note'),
                                )}
                              </strong>{' '}
                              · {reasonFor(p, subscription)[language]}
                            </p>
                          </div>
                          {rec && linked.length > 0 && (
                            <button
                              className="connection-hint"
                              onClick={() => setSelected(p.id)}
                            >
                              <Link2 size={13} />
                              {ui(
                                tr(
                                  ui('关联 {0} 份 Persona 材料', [
                                    linked.length,
                                  ]),
                                  `Connected to ${linked.length} Persona materials`,
                                ),
                              )}
                              <span>·</span>
                              {linked[0].title[language]}
                              <ChevronRight size={13} />
                            </button>
                          )}
                          <div className="paper-footer">
                            <div>{renderFeedback(p, 'accuracy', true)}</div>
                            <button
                              className="button-link"
                              onClick={() => setSelected(p.id)}
                            >
                              {ui(tr('查看分析', 'View analysis'))}
                              <ArrowUpRight size={15} />
                            </button>
                          </div>
                        </article>
                      );
                    })
                  )}
                  <p className="feed-end">
                    {ui(
                      tr(
                        '仅展示虚构示例 · 没有反馈的项目保持未评价',
                        'Fictional examples only · Unrated items remain unknown',
                      ),
                    )}
                  </p>
                </section>
                <div className="daily-inline-reader">{demoReader}</div>
              </div>
            </>
          )}
          {view === 'subscriptions' && (
            <>
              <div className="daily-actions" style={{ marginBottom: '1rem' }}>
                <button
                  className="button-secondary"
                  onClick={() => setView('authors')}
                >
                  {ui('管理关注作者')}
                </button>
              </div>
              <div className="subscriptions-grid">
                {subscriptions.map((s, index) => (
                  <article className="subscription-card" key={s.id}>
                    <div className="subscription-card-head">
                      <span
                        className={
                          'subscription-icon ' + (index % 2 ? 'teal' : '')
                        }
                      >
                        <Radio size={23} />
                      </span>
                      <button
                        className="button-secondary"
                        onClick={() => setEditor(s)}
                      >
                        <Pencil size={14} />
                        {ui('编辑')}
                      </button>
                    </div>
                    <h2>{s.name}</h2>
                    <FollowAuthorButton onClick={() => openFollowedAuthors(s.id)} />
                    <p className="subscription-subject">
                      {SUBJECTS.find((x) => x.id === s.subject)?.name}
                      <br />
                      <code>{ui(s.subject)}</code>
                    </p>
                    <div className="scope-chips">
                      {s.tags.length ? (
                        s.tags.map((t) => (
                          <span className="tag" key={t}>
                            <Tag size={12} />
                            {ui(t)}
                          </span>
                        ))
                      ) : (
                        <span className="tag gray">{ui('通用推荐')}</span>
                      )}
                    </div>
                    <div className="subscription-metrics">
                      <span>
                        <FileText size={15} />
                        {scopeMaterials(s.tags).length} {ui(' 份示例材料')}
                      </span>
                      <span>
                        <Users size={15} />
                        {s.authorIds.length} {ui(' 位作者')}
                      </span>
                      <span>
                        <Languages size={15} />
                        {ui(s.language === 'zh' ? '中文' : 'English')}
                      </span>
                    </div>
                    <p className="subscription-summary-length">
                      <FileText size={14} />
                      {ui('研究总结 · ')}
                      {s.summaryLength.min}–{s.summaryLength.max}{' '}
                      {ui(s.language === 'zh' ? '字' : '词')}
                    </p>
                    <button
                      className="subscription-open"
                      onClick={() => switchSubscription(s.id)}
                    >
                      {ui('查看每日论文')}
                      <ArrowRight size={16} />
                    </button>
                  </article>
                ))}
                <button
                  className="new-subscription-card"
                  onClick={newSubscription}
                >
                  <span>
                    <Plus size={23} />
                  </span>
                  <strong>{ui('关注一个新方向')}</strong>
                  <p>{ui('选择 subject 和 Persona 标签')}</p>
                </button>
              </div>
            </>
          )}
          {view === 'authors' && (
            <>
              <div className="authors-banner">
                <div>
                  <Users size={20} />
                  <p>
                    {ui('作者关注属于当前订阅：')}
                    <strong>{subscription.name}</strong>
                    <br />
                    <span>
                      {ui(
                        '仅显示所选 subject 内的作者论文；论文、作者姓名与单位均为虚构示例。',
                      )}
                    </span>
                  </p>
                </div>
                <button
                  className="button-link"
                  onClick={() => {
                    setView('daily');
                    setFeed('authors');
                    setQuery('');
                  }}
                >
                  {ui('查看作者动态')}
                  <ArrowRight size={15} />
                </button>
              </div>
              <div className="authors-toolbar">
                <span>
                  {ui('示例作者目录 · 已关注 ')}
                  {subscription.authorIds.length} {ui(' 位')}
                </span>
                <div className="search-box">
                  <Search size={15} />
                  <input
                    ref={authorSearch}
                    value={authorQuery}
                    onChange={(e) => setAuthorQuery(e.target.value)}
                    placeholder={ui('搜索作者或研究方向')}
                    aria-label={ui('搜索作者')}
                  />
                  {authorQuery && (
                    <button
                      aria-label={ui('清空作者搜索')}
                      onClick={() => setAuthorQuery('')}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
              <div className="authors-list">
                {AUTHORS.filter((a) =>
                  [a.name, a.bio.zh, a.bio.en]
                    .join(' ')
                    .toLowerCase()
                    .includes(authorQuery.toLowerCase()),
                ).map((a) => (
                  <article className="author-card" key={a.id}>
                    <span className="author-initial large">
                      {ui(a.initials)}
                    </span>
                    <div className="author-info">
                      <h2>{a.name}</h2>
                      <p>{a.field.zh}</p>
                      <span>{a.bio.zh}</span>
                      <button
                        className="button-link"
                        onClick={() => {
                          setView('daily');
                          setFeed('authors');
                          setQuery(a.name);
                        }}
                        disabled={!subscription.authorIds.includes(a.id)}
                      >
                        {ui('查看本订阅中的新作')}
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <button
                      className={
                        subscription.authorIds.includes(a.id)
                          ? 'button-secondary followed'
                          : 'button-primary'
                      }
                      onClick={() => followAuthor(a.id)}
                    >
                      {subscription.authorIds.includes(a.id) ? (
                        <Check size={15} />
                      ) : (
                        <Plus size={15} />
                      )}
                      <span>
                        {ui(
                          subscription.authorIds.includes(a.id)
                            ? '已关注 · 取消'
                            : '关注作者',
                        )}
                      </span>
                    </button>
                  </article>
                ))}
              </div>
              {AUTHORS.filter((a) =>
                [a.name, a.bio.zh, a.bio.en]
                  .join(' ')
                  .toLowerCase()
                  .includes(authorQuery.toLowerCase()),
              ).length === 0 && (
                <Empty className="feed-empty">
                  <EmptyHeader>
                    <EmptyTitle>{ui('没有找到这位示例作者')}</EmptyTitle>
                    <EmptyDescription>
                      {ui('可以搜索 Maya、Alex、Lin，或“量子输运”。')}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </>
          )}
        </div>
      </main>
      {editor && (
        <SubscriptionEditor
          key={editor.id}
          initial={editor}
          onClose={() => setEditor(null)}
          onSave={saveSubscription}
        />
      )}
      <Dialog
        open={!!material}
        onOpenChange={(open) => {
          if (!open) setMaterial(null);
        }}
      >
        <DialogContent className="material-dialog">
          <DialogHeader>
            <p className="dialog-kicker">AI PERSONA · DEMO MATERIAL</p>
            <DialogTitle className="dialog-title">
              {material?.title[language]}
            </DialogTitle>
            <DialogDescription>
              {material?.kind[language]} · {ui(material?.tag)}
            </DialogDescription>
          </DialogHeader>
          <p className="material-description">
            {material?.description[language]}
          </p>
          <div className="scope-notice">
            {ui(
              tr(
                '这是虚构示例材料，用于演示关联查看；没有读取你的真实知识库。',
                'This is fictional sample material for demonstrating connections. Your real knowledge base has not been read.',
              ),
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogContent className="material-dialog">
          <DialogHeader>
            <p className="dialog-kicker">PERSONA SCOPE</p>
            <DialogTitle className="dialog-title">
              {ui(tr('本次使用的材料', 'Materials in this scope'))}
            </DialogTitle>
            <DialogDescription>
              {subscription.tags.join(' + ') ||
                tr(ui('通用模式'), 'General mode')}{' '}
              · {materials.length} {ui(tr('份示例材料', 'sample materials'))}
            </DialogDescription>
          </DialogHeader>
          <div className="scope-material-list expanded">
            {materials.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  setScopeOpen(false);
                  setMaterial(m);
                }}
              >
                <FileText size={17} />
                <span>{m.title[language]}</span>
                <ArrowUpRight size={15} />
              </button>
            ))}
            {!materials.length && (
              <p>
                {ui(
                  tr(
                    '当前范围没有 Persona 材料。',
                    'There are no Persona materials in this scope.',
                  ),
                )}
              </p>
            )}
          </div>
          <p className="scope-notice">
            {ui(
              tr(
                '多标签按并集使用，标签外材料不参与筛选和关联分析。',
                'Multiple tags are combined. Materials outside these tags are excluded from screening and connections.',
              ),
            )}
          </p>
        </DialogContent>
      </Dialog>
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="material-dialog">
          <DialogHeader>
            <p className="dialog-kicker">PAPER RADAR · FRONTEND DEMO</p>
            <DialogTitle className="dialog-title">
              {ui('体验你的论文工作台')}
            </DialogTitle>
            <DialogDescription>
              {ui('当前是可交互的前端演示。')}
            </DialogDescription>
          </DialogHeader>
          <div className="about-content">
            <p>
              {ui(
                '每日论文使用虚构数据。单篇分析在本机服务中支持真实 arXiv 读取、模型分析与限定标签的 Persona 材料；在线静态版本保留演示。',
              )}
            </p>
            <p>
              {ui(
                '你可以编辑订阅、查看作者动态，或输入 arXiv 链接体验单篇分析的设置、进度、历史记录与四项可选反馈。',
              )}
            </p>
            <p>
              {ui(
                '真实单篇分析的结果和反馈保存在本机服务中，并使用配置的模型额度。演示数据仍保存在浏览器，示例和真实结果分别管理。反馈不会自动修改 Persona。',
              )}
            </p>
            <p>
              {ui(
                '演示采用：多标签取并集、作者论文限于所选 subject、语言按订阅保存。',
              )}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </ResearchShell>
  );
}
