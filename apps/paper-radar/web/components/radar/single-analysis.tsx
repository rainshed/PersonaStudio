'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import './single-analysis.css';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  History,
  Link2,
  LoaderCircle,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FeedbackControl } from './feedback';
import {
  TAGS,
  validateSummaryLength,
  type Subscription,
  type Feedback,
  type FeedbackDimension,
} from '@/lib/radar';
import {
  SAMPLE_TITLE,
  SAMPLE_URL,
  SAMPLE_VERSION,
  SINGLE_STORAGE_KEY,
  STAGES,
  advanceJob,
  analysisKey,
  defaultAnalysisSettings,
  hydrateSingleAnalysis,
  isPersonalized,
  parseArxiv,
  recommendsSample,
  settingsFromSubscription,
  singleSummary,
  stageOf,
  supportsSample,
  validateAnalysisSettings,
  type AnalysisJob,
  type AnalysisSettings,
  type SingleAnalysisState,
} from '@/lib/single-analysis';

const citedMaterials = [
  {
    number: 48,
    title: 'Superdiffusive transport on lattices with nodal impurities',
    zh: '共同线索是特殊动量附近的长寿命模。已有材料研究节点杂质下的粒子输运，本文研究测量轨迹中的量子信息传播，二者的观测量不同。',
    en: 'Both studies involve long-lived modes near special momenta. The cited work examines particle transport with nodal impurities; this paper concerns quantum-information propagation in monitored trajectories.',
  },
  {
    number: 49,
    title: 'Superdiffusive transport in quasi-particle dephasing models',
    zh: '可对照节点附近的衰减率与重尾传播机制。退相干模型中的 Lévy walk 与本文的量子信息 Lévy flights 有明确联系，但不能直接等同。',
    en: 'Compare the small decay rates near nodes and the resulting heavy-tailed propagation. The Lévy-walk picture in the dephasing model should not be equated directly with this paper’s information-theoretic Lévy flights.',
  },
  {
    number: 50,
    title:
      'Superdiffusive transport in chaotic quantum systems with nodal interactions',
    zh: '两篇工作都利用节点保护的长寿命准粒子。需要区分相互作用体系的电荷输运，与受监测自由费米子的纠缠和信息动力学。',
    en: 'Both use long-lived quasiparticles associated with nodes. The distinction is interacting charge transport versus entanglement and information dynamics in monitored free fermions.',
  },
];
const initialState = (): SingleAnalysisState => ({
  draft: defaultAnalysisSettings(),
  jobs: [],
  selectedId: null,
  feedback: {},
});
const statusLabel = (job: AnalysisJob) =>
  ({
    running: '分析中',
    complete: '已完成',
    needs_review: '字数待调整',
    unavailable: '暂无示例',
    cancelled: '已取消',
  })[job.status];
const preview: AnalysisJob = {
  id: 'preview',
  paper: { id: '2501.12903', version: 3, url: SAMPLE_URL },
  settings: { ...defaultAnalysisSettings(), url: SAMPLE_URL },
  createdAt: '2026-09-06T12:00:00.000Z',
  status: 'complete',
  origin: 'demo',
};

export function SingleAnalysisPage({
  subscriptions,
  onModels,
}: {
  subscriptions: Subscription[];
  onModels: () => void;
}) {
  const { ui, uiLanguage, locale } = useUiLanguage();
  const [state, setState] = useState<SingleAnalysisState>(initialState);
  const [ready, setReady] = useState(false);
  const [minText, setMinText] = useState('800');
  const [maxText, setMaxText] = useState('1200');
  const [preset, setPreset] = useState('custom');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<AnalysisJob | null>(null);
  const [tab, setTab] = useState('summary');
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const selected = state.jobs.find((j) => j.id === state.selectedId) ?? preview;
  const isPreview = selected.id === 'preview';
  const active = state.jobs.find((j) => j.status === 'running');
  const en = selected.settings.language === 'en';
  const contentTr = (zh: string, english: string) => (en ? english : zh);
  const tr = (zh: string, english: string) =>
    uiLanguage === 'en' ? english : zh;
  const personalized = isPersonalized(selected.settings);
  const recommended = recommendsSample(selected.settings);
  const summary = singleSummary(
    selected.settings.language,
    selected.settings.summaryLength,
  );
  const terminal = ['complete', 'needs_review'].includes(selected.status);
  const parsed = parseArxiv(state.draft.url);
  const step = stageOf(selected, now || Date.parse(selected.createdAt));
  const modelNote = '沿用「模型设置」中的默认模型与任务分配';

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(SINGLE_STORAGE_KEY);
        const saved = raw ? hydrateSingleAnalysis(JSON.parse(raw)) : null;
        if (raw && !saved)
          setStorageError(
            '演示记录无法完整读取。当前仍可体验，新记录将保存在此浏览器。',
          );
        if (saved) {
          setState({
            ...saved,
            jobs: saved.jobs.map((j) => advanceJob(j, Date.now())),
          });
          setMinText(String(saved.draft.summaryLength.min));
          setMaxText(String(saved.draft.summaryLength.max));
        }
      } catch {
        setStorageError('浏览器暂时无法读取演示记录。');
      }
      setNow(Date.now());
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(SINGLE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      queueMicrotask(() =>
        setStorageError('浏览器暂时无法保存记录，刷新后可能丢失。'),
      );
    }
  }, [state, ready]);
  const runningId = active?.id;
  useEffect(() => {
    if (!runningId) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      setState((s) => {
        const jobs = s.jobs.map((j) => advanceJob(j, time));
        return jobs.some((j, i) => j !== s.jobs[i]) ? { ...s, jobs } : s;
      });
    }, 300);
    return () => clearInterval(timer);
  }, [runningId]);
  function update(changes: Partial<AnalysisSettings>) {
    setPreset('custom');
    setError('');
    setState((s) => ({ ...s, draft: { ...s.draft, ...changes } }));
  }
  function loadSettings(settings: AnalysisSettings) {
    setState((s) => ({ ...s, draft: structuredClone(settings) }));
    setMinText(String(settings.summaryLength.min));
    setMaxText(String(settings.summaryLength.max));
    setError('');
    setPreset('custom');
  }
  function setLength(min: string, max: string) {
    setMinText(min);
    setMaxText(max);
    setPreset('custom');
    const bounds = {
      min: min.trim() ? Number(min) : NaN,
      max: max.trim() ? Number(max) : NaN,
    };
    if (!validateSummaryLength(bounds)) update({ summaryLength: bounds });
  }
  function fillSample() {
    update({ url: SAMPLE_URL });
    inputRef.current?.focus();
    setNotice('已填入示例论文，可调整标签、语言和字数后体验分析。');
  }
  function begin(force = false, settings?: AnalysisSettings) {
    const draft = settings ?? {
      ...state.draft,
      summaryLength: {
        min: minText.trim() ? Number(minText) : NaN,
        max: maxText.trim() ? Number(maxText) : NaN,
      },
    };
    const problem = validateAnalysisSettings(draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (active) {
      setError('请先完成或取消正在进行的演示分析。');
      return;
    }
    if (!force) {
      const existing = state.jobs.find(
        (j) =>
          ['complete', 'needs_review'].includes(j.status) &&
          analysisKey(j.settings) === analysisKey(draft),
      );
      if (existing) {
        setDuplicate(existing);
        return;
      }
    }
    if (state.jobs.length >= 50) {
      setError('此浏览器已保存50条演示记录，暂时无法新增。');
      return;
    }
    const paper = parseArxiv(draft.url)!;
    if (supportsSample(paper)) {
      paper.version = SAMPLE_VERSION;
      paper.url = SAMPLE_URL;
    }
    const job: AnalysisJob = {
      id: 'single-' + crypto.randomUUID(),
      paper,
      settings: structuredClone(draft),
      createdAt: new Date().toISOString(),
      status: 'running',
      origin: 'demo',
    };
    setState((s) => ({
      ...s,
      draft,
      jobs: [job, ...s.jobs],
      selectedId: job.id,
    }));
    setNow(Date.now());
    setError('');
    setNotice('');
    setDuplicate(null);
    setTab('summary');
    requestAnimationFrame(() =>
      resultRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      }),
    );
  }
  function cancel(job: AnalysisJob) {
    setState((s) => ({
      ...s,
      jobs: s.jobs.map((j) =>
        j.id === job.id ? { ...j, status: 'cancelled' } : j,
      ),
    }));
  }
  function feedback(dimension: FeedbackDimension) {
    return (
      <FeedbackControl
        dimension={dimension}
        language={selected.settings.language}
        disabled={isPreview || !ready}
        notRecommended={!recommended}
        value={state.feedback[selected.id]?.[dimension]}
        onChange={(value: Feedback | null) => {
          setState((s) => {
            const next = { ...s.feedback },
              current = { ...next[selected.id] };
            if (value) current[dimension] = value;
            else delete current[dimension];
            if (Object.keys(current).length) next[selected.id] = current;
            else delete next[selected.id];
            return { ...s, feedback: next };
          });
        }}
      />
    );
  }
  return (
    <div className="single-workspace">
      <div className="page-heading single-heading">
        <div>
          <p className="eyebrow">ONE PAPER, A CLOSER LOOK</p>
          <h1>{ui('单篇论文分析')}</h1>
          <p>{ui('从一篇论文出发，看清研究内容与它对你的意义。')}</p>
        </div>
        <span className="single-demo-badge">
          <span />
          {ui('UI 演示 · 不调用模型')}
        </span>
      </div>
      <div className="single-demo-line">
        <ShieldCheck size={16} />
        <p>
          {ui(
            '论文与引用来自公开资料；Persona 范围和分析过程为演示。记录仅保存在当前浏览器。',
          )}
        </p>
      </div>
      {storageError && (
        <p className="single-alert" role="alert">
          {ui(storageError)}
        </p>
      )}
      {notice && (
        <output className="single-notice">
          <Check size={16} />
          {ui(notice)}
          <button aria-label={ui('关闭提示')} onClick={() => setNotice('')}>
            <X size={15} />
          </button>
        </output>
      )}
      <div className="single-layout">
        <div className="single-controls">
          <section
            className="single-form-card"
            aria-labelledby="single-form-heading"
          >
            <div className="single-card-label">
              <span className="single-number">01</span>
              <h2 id="single-form-heading">{ui('添加论文')}</h2>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                begin();
              }}
            >
              <label className="single-label" htmlFor="single-arxiv">
                {ui('arXiv 链接或编号')}
              </label>
              <div
                className={
                  'single-link-input ' + (error && !parsed ? 'invalid' : '')
                }
              >
                <Link2 size={17} />
                <input
                  id="single-arxiv"
                  ref={inputRef}
                  value={state.draft.url}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder="https://arxiv.org/abs/2501.12903"
                  maxLength={500}
                  required
                  autoComplete="off"
                  aria-describedby="single-link-help"
                />
              </div>
              <div className="single-link-help" id="single-link-help">
                <span>{ui('支持摘要、PDF、HTML 链接')}</span>
                <button type="button" onClick={fillSample}>
                  {ui('使用示例 ')}
                  <ArrowRight size={13} />
                </button>
              </div>
              {parsed && (
                <div className="single-resolved">
                  <FileText size={15} />
                  <div>
                    <strong>
                      {parsed.id}
                      {parsed.version ? 'v' + parsed.version : ''}
                    </strong>
                    <span>
                      {ui(
                        supportsSample(parsed)
                          ? '已识别示例 · 分析 v3'
                          : '链接格式已识别 · 暂无演示内容',
                      )}
                    </span>
                  </div>
                  <Check size={15} />
                </div>
              )}
              <div className="single-form-rule" />
              <div className="single-card-label">
                <span className="single-number">02</span>
                <h2>{ui('设置分析范围')}</h2>
              </div>
              <label className="single-label" htmlFor="single-preset">
                {ui('沿用订阅设置')}
              </label>
              <Select
                value={preset}
                onValueChange={(value) => {
                  if (!value || value === 'custom') {
                    setPreset('custom');
                    return;
                  }
                  const subscription = subscriptions.find(
                    (s) => s.id === value,
                  );
                  if (subscription) {
                    loadSettings(
                      settingsFromSubscription(subscription, state.draft.url),
                    );
                    setPreset(subscription.id);
                  }
                }}
              >
                <SelectTrigger id="single-preset" className="single-select">
                  <SelectValue>
                    {subscriptions.find((s) => s.id === preset)?.name ??
                      ui('独立设置')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">{ui('独立设置')}</SelectItem>
                  {subscriptions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="single-help">
                {ui('沿用标签、语言和字数；不受订阅 subject 限制。')}
              </p>
              <fieldset className="single-tags">
                <legend className="single-label">
                  {ui('Persona 标签 ')}
                  <span>{ui('示例')}</span>
                </legend>
                <div>
                  {TAGS.map((tag) => (
                    <label
                      key={tag}
                      className={
                        'single-tag-choice ' +
                        (state.draft.tags.includes(tag) ? 'selected' : '')
                      }
                    >
                      <Checkbox
                        checked={state.draft.tags.includes(tag)}
                        onCheckedChange={(checked) =>
                          update({
                            tags: checked
                              ? [...state.draft.tags, tag]
                              : state.draft.tags.filter((t) => t !== tag),
                          })
                        }
                      />
                      <Tag size={13} />
                      <span>{ui(tag)}</span>
                    </label>
                  ))}
                </div>
                <p className="single-help">
                  {state.draft.tags.length
                    ? ui('仅使用 {0} 范围内的示例材料，多标签取并集。', [
                        state.draft.tags.join('、'),
                      ])
                    : ui('未选标签：只生成研究总结，不做个性化判断。')}
                </p>
              </fieldset>
              <label className="single-label" htmlFor="single-language">
                {ui('内容语言')}
              </label>
              <Select
                value={state.draft.language}
                onValueChange={(v) => {
                  if (v === 'zh' || v === 'en') update({ language: v });
                }}
              >
                <SelectTrigger id="single-language" className="single-select">
                  <SelectValue>
                    {ui(state.draft.language === 'zh' ? '中文' : 'English')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh">{ui('中文')}</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
              <fieldset className="single-length">
                <legend className="single-label">
                  {ui('研究总结长度')}{' '}
                  <span>
                    {ui(state.draft.language === 'zh' ? '字' : 'words')}
                  </span>
                </legend>
                <div className="single-length-inputs">
                  <input
                    aria-label={ui('总结最少字数')}
                    type="number"
                    min={200}
                    max={3000}
                    step={1}
                    value={minText}
                    onChange={(e) => setLength(e.target.value, maxText)}
                  />
                  <span>—</span>
                  <input
                    aria-label={ui('总结最多字数')}
                    type="number"
                    min={200}
                    max={3000}
                    step={1}
                    value={maxText}
                    onChange={(e) => setLength(minText, e.target.value)}
                  />
                </div>
                <div className="single-length-presets">
                  {[
                    [400, 600, ui('简要')],
                    [800, 1200, ui('标准')],
                    [1500, 2000, ui('详细')],
                  ].map(([min, max, label]) => (
                    <button
                      type="button"
                      key={String(label)}
                      className={
                        minText === String(min) && maxText === String(max)
                          ? 'selected'
                          : ''
                      }
                      onClick={() => setLength(String(min), String(max))}
                    >
                      {ui(label)}
                    </button>
                  ))}
                </div>
                <p className="single-help">
                  {ui(
                    '200–3000；中文按非空白字符计数，英文按单词计数。预写内容不足时会提示。',
                  )}
                </p>
              </fieldset>
              <div className="single-model-note">
                <Settings2 size={16} />
                <div>
                  <strong>{ui('模型使用方式')}</strong>
                  <p>{ui(modelNote)}</p>
                </div>
                <button
                  type="button"
                  onClick={onModels}
                  aria-label={ui('打开模型设置')}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              {error && (
                <p className="single-error" role="alert">
                  <CircleAlert size={16} />
                  {ui(error)}
                </p>
              )}
              <button
                className="button-primary single-submit"
                type="submit"
                disabled={!ready || !!active}
              >
                {active ? (
                  <LoaderCircle className="single-spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}{' '}
                {ui(active ? '演示分析进行中' : '开始分析 · 演示')}
                {!active && <ArrowRight size={17} />}
              </button>
              <p className="single-submit-note">
                {ui('体验读取、生成与检查过程，不消耗模型额度。')}
              </p>
            </form>
          </section>
          <section
            className="single-history"
            aria-labelledby="single-history-heading"
          >
            <div className="single-history-heading">
              <h2 id="single-history-heading">
                <History size={17} />
                {ui('分析记录 ')}
                <span>{state.jobs.length}</span>
              </h2>
              <span>{ui('仅此浏览器')}</span>
            </div>
            {!state.jobs.length ? (
              <div className="single-history-empty">
                <Clock3 size={22} />
                <strong>{ui('从第一篇开始')}</strong>
                <p>{ui('完成演示后，记录与反馈会保存在这里。')}</p>
              </div>
            ) : (
              <div className="single-history-list">
                {state.jobs.map((job) => (
                  <button
                    key={job.id}
                    className={
                      'single-history-item ' +
                      (state.selectedId === job.id ? 'selected' : '')
                    }
                    onClick={() => {
                      setState((s) => ({ ...s, selectedId: job.id }));
                      setTab('summary');
                    }}
                  >
                    <div>
                      <FileText size={16} />
                      <span>
                        {job.paper.id}
                        {job.paper.version ? 'v' + job.paper.version : ''}
                      </span>
                      <span className={'single-status ' + job.status}>
                        {ui(statusLabel(job))}
                      </span>
                    </div>
                    <strong>
                      {ui(
                        supportsSample(job.paper)
                          ? SAMPLE_TITLE
                          : 'arXiv 链接 · 暂无标题',
                      )}
                    </strong>
                    <p>
                      {job.settings.tags.join(' + ') || ui('未选标签')} ·{' '}
                      {ui(job.settings.language === 'zh' ? '中文' : 'English')}{' '}
                      · {job.settings.summaryLength.min}–
                      {job.settings.summaryLength.max}
                    </p>
                    <small>
                      {new Date(job.createdAt).toLocaleString(locale, {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}{' '}
                      {ui('· 演示记录')}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
        <section
          ref={resultRef}
          className="single-result"
          aria-label={ui('论文分析结果')}
        >
          <div className="single-result-top">
            <div>
              <span className="single-number">03</span>
              <h2>{ui(isPreview ? '示例结果预览' : '论文分析')}</h2>
            </div>
            <span className={'single-status ' + selected.status}>
              {ui(isPreview ? '预写内容' : statusLabel(selected))}
            </span>
          </div>
          <header className="single-paper-header">
            <div className="single-paper-meta">
              <span>
                {ui(supportsSample(selected.paper) ? 'quant-ph' : 'arXiv')}
              </span>
              <span>
                {selected.paper.id}
                {selected.paper.version ? 'v' + selected.paper.version : ''}
              </span>
            </div>
            <h2>
              {ui(
                supportsSample(selected.paper)
                  ? SAMPLE_TITLE
                  : '等待读取论文信息',
              )}
            </h2>
            {supportsSample(selected.paper) && (
              <p className="single-paper-authors">
                Igor Poboiko, Marcin Szyniszewski, Christopher J. Turner, Igor
                V. Gornyi, Alexander D. Mirlin & Arijeet Pal
              </p>
            )}
            <div className="single-paper-source">
              <span>
                {ui(
                  supportsSample(selected.paper)
                    ? '2025-10-26 · v3 · 正文与补充材料'
                    : '链接已保存 · 真实读取待接入',
                )}
              </span>
              <a href={selected.paper.url} target="_blank" rel="noreferrer">
                {ui('查看 arXiv ')}
                <ArrowUpRight size={14} />
              </a>
            </div>
          </header>
          <div className="single-context-bar">
            <span>
              <Tag size={13} />
              {selected.settings.tags.join(' + ') || ui('未选 Persona 标签')}
            </span>
            <span>{ui(en ? 'English' : '中文')}</span>
            <span>
              {selected.settings.summaryLength.min}–
              {selected.settings.summaryLength.max}
              {ui(en ? ' words' : ' 字')}
            </span>
            <span>{ui('分析流程示例')}</span>
          </div>
          {selected.status === 'running' ? (
            <div className="single-progress" aria-live="polite">
              <div className="single-progress-title">
                <LoaderCircle size={23} className="single-spin" />
                <div>
                  <h3>
                    {ui(STAGES[step])}
                    <span> {ui(' · 演示')}</span>
                  </h3>
                  <p>{ui('此过程模拟实际任务，刷新后会恢复演示进度。')}</p>
                </div>
                <button onClick={() => cancel(selected)}>{ui('取消')}</button>
              </div>
              <ol>
                {STAGES.map((stage, i) => (
                  <li
                    key={stage}
                    className={i < step ? 'done' : i === step ? 'current' : ''}
                  >
                    <span>{i < step ? <Check size={15} /> : i + 1}</span>
                    <div>
                      <strong>{ui(stage)}</strong>
                      <p>
                        {ui(
                          [
                            '识别论文版本，准备正文与参考文献',
                            '检查选定标签，挑选相关材料',
                            '组织研究总结、推荐理由与材料联系',
                            '检查字数、结构和证据引用',
                          ][i],
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="single-progress-note">
                {ui('完成后查看详细分析，也可以稍后从左侧记录返回。')}
              </p>
            </div>
          ) : terminal ? (
            <>
              {isPreview && (
                <div className="single-preview-note">
                  <Sparkles size={16} />
                  <p>
                    {ui(
                      '先看看结果会如何呈现。使用左侧示例链接开始演示后，可以保存记录和填写反馈。',
                    )}
                  </p>
                </div>
              )}
              <div
                className={
                  'single-verdict ' +
                  (!personalized
                    ? 'neutral'
                    : recommended
                      ? 'positive'
                      : 'neutral')
                }
              >
                <span className="single-verdict-icon">
                  {personalized ? (
                    <Sparkles size={19} />
                  ) : (
                    <FileText size={19} />
                  )}
                </span>
                <div>
                  <strong>
                    {ui(
                      !personalized
                        ? tr('仅研究总结', 'Research summary only')
                        : recommended
                          ? tr('推荐阅读', 'Recommended')
                          : tr(
                              '本次不优先推荐',
                              'Not prioritized for this scope',
                            ),
                    )}
                  </strong>
                  <p>
                    {ui(
                      !personalized
                        ? tr(
                            '未选择标签，未进行个性化判断。',
                            'No Persona tags selected; no personalized judgment was made.',
                          )
                        : recommended
                          ? tr(
                              '与 Physics 示例范围相关；参考文献直接引用了 3 篇示例库材料。',
                              'Relevant to the Physics demo scope; three sample-library papers are directly cited.',
                            )
                          : tr(
                              '所选示例范围缺少明确联系，仍为你保留完整研究总结。',
                              'The selected demo scope does not establish a clear connection. The full research summary remains available.',
                            ),
                    )}
                  </p>
                </div>
              </div>
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(String(v))}
                className="single-result-tabs"
              >
                <TabsList className="single-tab-list">
                  <TabsTrigger value="summary">{ui('研究总结')}</TabsTrigger>
                  <TabsTrigger value="reason">{ui('推荐理由')}</TabsTrigger>
                  <TabsTrigger value="connections">
                    {ui('联系与交叉 ')}
                    {personalized && recommended && <span>3</span>}
                  </TabsTrigger>
                  <TabsTrigger value="feedback">{ui('反馈')}</TabsTrigger>
                </TabsList>
                <TabsContent value={tab} className="single-result-body">
                  {tab === 'summary' && (
                    <>
                      <div className="single-summary-heading">
                        <h3>
                          {ui(tr('这篇论文做了什么', 'What this paper does'))}
                        </h3>
                        <span
                          className={
                            summary.withinRange
                              ? 'single-count good'
                              : 'single-count warning'
                          }
                        >
                          {summary.withinRange ? (
                            <Check size={13} />
                          ) : (
                            <CircleAlert size={13} />
                          )}{' '}
                          {summary.count}
                          {ui(en ? ' words' : ' 字')}
                        </span>
                      </div>
                      {!summary.withinRange && (
                        <div className="single-validation-note">
                          <CircleAlert size={17} />
                          <p>
                            {ui('预写总结为 ')}
                            {summary.count}
                            {ui(en ? ' words' : ' 字')}
                            {ui('，未满足')}{' '}
                            {selected.settings.summaryLength.min}–
                            {selected.settings.summaryLength.max}{' '}
                            {ui(
                              '的范围。本版不会自动续写；可调整范围后再次预览。',
                            )}
                          </p>
                        </div>
                      )}
                      {summary.sections.map((section, i) => (
                        <section
                          className="single-summary-section"
                          key={section.title.zh}
                        >
                          <h4>
                            <span>{ui(String(i + 1).padStart(2, '0'))}</span>
                            {section.title[selected.settings.language]}
                          </h4>
                          {section.paragraphs.map((p, index) => (
                            <p key={index}>{p[selected.settings.language]}</p>
                          ))}
                          <a
                            className="single-evidence-link"
                            href={section.source}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {ui(tr('查看原文依据', 'View source evidence'))}
                            <ArrowUpRight size={12} />
                          </a>
                        </section>
                      ))}
                      <p className="single-source-footnote">
                        {ui(
                          tr(
                            '预写样例依据论文文字、公式和图注，未独立检查图像或复现实验。原论文：Poboiko 等，CC BY 4.0。',
                            'Prewritten preview based on paper text, equations and captions. Figure images and calculations were not independently verified. Original paper: Poboiko et al., CC BY 4.0.',
                          ),
                        )}
                      </p>
                      {feedback('summary')}
                    </>
                  )}
                  {tab === 'reason' &&
                    (personalized ? (
                      <>
                        <h3 className="single-section-title">
                          {ui(
                            tr(
                              '为什么得到这个判断',
                              'Why this judgment was made',
                            ),
                          )}
                        </h3>
                        {recommended ? (
                          <>
                            <div className="single-reason-row">
                              <span>01</span>
                              <div>
                                <h4>
                                  {contentTr(
                                    '研究问题直接相关',
                                    'Directly relevant research question',
                                  )}
                                </h4>
                                <p>
                                  {contentTr(
                                    '本文讨论测量诱导的信息超扩散、衰减率节点和纠缠标度，与 Physics 示例范围中的超扩散研究相符。这里没有读取或推断你真实的兴趣等级。',
                                    'Measurement-induced information superdiffusion, decay-rate nodes and entanglement scaling connect to the Physics demo scope. No real personal interest levels were read or inferred.',
                                  )}
                                </p>
                              </div>
                            </div>
                            <div className="single-reason-row">
                              <span>02</span>
                              <div>
                                <h4>
                                  {contentTr(
                                    '有可核对的直接引用',
                                    'Verifiable direct citations',
                                  )}
                                </h4>
                                <p>
                                  {contentTr(
                                    '参考文献 [48]–[50] 对应下方的三篇示例材料。直接引用是已知关系；方法是否可以迁移，仍需要进一步判断。',
                                    'References [48]–[50] correspond to the three example materials below. Citation is established; whether their methods transfer requires further analysis.',
                                  )}
                                </p>
                                <button
                                  className="single-text-button"
                                  onClick={() => setTab('connections')}
                                >
                                  {ui(
                                    tr(
                                      '查看三篇材料',
                                      'View the three materials',
                                    ),
                                  )}
                                  <ArrowRight size={14} />
                                </button>
                              </div>
                            </div>
                            <div className="single-reading-caution">
                              <ShieldCheck size={18} />
                              <p>
                                {contentTr(
                                  '阅读时重点区分量子信息和纠缠的超扩散，与粒子密度的扩散。不能仅因都存在节点就认为两种动力学相同。',
                                  'Distinguish superdiffusive information and entanglement from diffusive particle-density dynamics. A shared momentum-space node does not make the dynamics equivalent.',
                                )}
                              </p>
                            </div>
                          </>
                        ) : (
                          <p className="single-body-text">
                            {contentTr(
                              `当前选择 ${selected.settings.tags.join('、')}。演示材料未建立这篇量子物理论文与该范围的明确联系，因此暂不优先推荐。这不影响你查看论文做了什么。`,
                              `The selected scope is ${selected.settings.tags.join(', ')}. The example materials do not establish a clear link to this quantum-physics paper, so it is not prioritized. Its full summary remains available.`,
                            )}
                          </p>
                        )}
                        {feedback('accuracy')}
                        {feedback('reason')}
                      </>
                    ) : (
                      <div className="single-empty-section">
                        <Tag size={26} />
                        <h3>{ui('未进行个性化分析')}</h3>
                        <p>
                          {ui(
                            '选择 Persona 标签后重新分析，才会判断论文是否与你的研究相关。',
                          )}
                        </p>
                        <button
                          onClick={() => {
                            loadSettings(selected.settings);
                            inputRef.current?.focus();
                          }}
                        >
                          {ui('调整分析设置 ')}
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    ))}
                  {tab === 'connections' &&
                    (personalized && recommended ? (
                      <>
                        <div className="single-section-caption">
                          <h3>
                            {ui(
                              tr(
                                '与已有材料的联系',
                                'Connections to existing materials',
                              ),
                            )}
                          </h3>
                          <span>{ui(tr('示例知识库', 'Example library'))}</span>
                        </div>
                        <p className="single-section-intro">
                          {ui(
                            tr(
                              '以下论文真实存在，并被目标论文引用。这里将它们作为示例库材料，不读取你的实际 Persona。',
                              'These are real papers cited by the target paper, presented here as sample-library materials. Your actual Persona is not accessed.',
                            ),
                          )}
                        </p>
                        {citedMaterials.map((m) => (
                          <article
                            className="single-material-card"
                            key={m.number}
                          >
                            <div>
                              <span className="single-citation-badge">
                                <Link2 size={12} />{' '}
                                {ui(tr('直接引用', 'Direct citation'))}
                              </span>
                              <span>[{m.number}]</span>
                            </div>
                            <h4>{m.title}</h4>
                            <p>{en ? m.en : m.zh}</p>
                            <a
                              href={`https://arxiv.org/html/2501.12903v3#bib.bib${m.number}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {ui(tr('核对参考文献', 'Verify reference'))}
                              <ArrowUpRight size={13} />
                            </a>
                          </article>
                        ))}
                        <div className="single-crossover">
                          <span className="single-hypothesis-label">
                            {ui(tr('待验证设想', 'Hypothesis to test'))}
                          </span>
                          <h3>
                            {contentTr(
                              '哪些测量扰动会破坏节点保护？',
                              'Which measurement perturbations break nodal protection?',
                            )}
                          </h3>
                          <p>
                            {contentTr(
                              '可比较不同微小测量扰动如何改变衰减率零点及纠缠的交叉尺度，再与节点退相干模型作对照。这是用于展示的研究设想，并非本文已经证明的结论。',
                              'Compare how small changes to the measured orbitals modify decay-rate nodes and entanglement crossover scales, then contrast them with nodal dephasing models. This is an illustrative research hypothesis, not an established result of the paper.',
                            )}
                          </p>
                          <div>
                            <strong>{ui(tr('第一步', 'First check'))}</strong>
                            <p>
                              {contentTr(
                                '先检查正文、补充材料与已有文献是否覆盖该扰动；再在同一模型中分别计算衰减率、密度响应和纠缠，避免混淆传播对象。',
                                'Check whether the paper, supplement or prior work already covers the perturbation. Then calculate decay rates, density response and entanglement separately in the same model.',
                              )}
                            </p>
                          </div>
                        </div>
                        {feedback('connections')}
                      </>
                    ) : (
                      <div className="single-empty-section">
                        <Link2 size={26} />
                        <h3>
                          {ui(
                            personalized
                              ? '所选范围暂无示例联系'
                              : '尚未使用个人材料',
                          )}
                        </h3>
                        <p>
                          {ui(
                            personalized
                              ? '完整研究总结仍可查看。选择 Physics 可体验引用联系与交叉分析。'
                              : '没有选择标签，本次仅提供研究总结。',
                          )}
                        </p>
                      </div>
                    ))}
                  {tab === 'feedback' && (
                    <>
                      <h3 className="single-section-title">
                        {ui(
                          tr(
                            '这次分析对你有帮助吗？',
                            'Was this analysis useful?',
                          ),
                        )}
                      </h3>
                      <p className="single-section-intro">
                        {ui(
                          tr(
                            '每项都可选。不满意时可补充理由，也可以撤销；未填写的项目不会记录。',
                            'Every item is optional. You may explain a negative rating or clear any response. Unanswered items are not recorded.',
                          ),
                        )}
                      </p>
                      {isPreview && (
                        <p className="single-validation-note">
                          {ui(
                            '请先从左侧开始一次演示分析，再对该记录提供反馈。',
                          )}
                        </p>
                      )}
                      {personalized && feedback('accuracy')}
                      {feedback('summary')}
                      {personalized && feedback('reason')}
                      {personalized && recommended && feedback('connections')}
                      {(!personalized || !recommended) && (
                        <p className="single-help">
                          {ui('未生成的个性化内容不收集对应评价。')}
                        </p>
                      )}
                      <p className="single-feedback-note">
                        <ShieldCheck size={14} />
                        {ui(
                          tr(
                            '反馈仅对应这条演示记录，不记录阅读状态。',
                            'Feedback applies only to this demo record. Reading status is not tracked.',
                          ),
                        )}
                      </p>
                    </>
                  )}
                </TabsContent>
              </Tabs>
              <footer className="single-result-footer">
                <span>
                  <Check size={14} />
                  {ui(isPreview ? '预览 · 尚未保存' : '已保存到此浏览器')} ·{' '}
                  {ui(summary.withinRange ? '字数范围满足' : '字数待调整')}
                </span>
                <button
                  onClick={() => {
                    loadSettings(selected.settings);
                    inputRef.current?.focus();
                    setNotice('已载入这次分析的设置，调整后点击“开始分析”。');
                  }}
                >
                  <RotateCcw size={14} />
                  {ui('调整并重新分析')}
                </button>
              </footer>
            </>
          ) : (
            <div className="single-unavailable">
              <CircleAlert size={32} />
              <h3>
                {ui(
                  selected.status === 'cancelled'
                    ? '演示已取消'
                    : '这个链接暂无演示内容',
                )}
              </h3>
              <p>
                {ui(
                  selected.status === 'cancelled'
                    ? '设置和记录仍然保留，可以重新体验分析流程。'
                    : '链接格式有效，但本版尚未接入真实论文读取。目前提供 2501.12903v3 的完整预写样例，不会为其他论文编造分析。',
                )}
              </p>
              <button
                className="button-primary"
                disabled={!!active}
                onClick={() =>
                  selected.status === 'cancelled'
                    ? begin(true, selected.settings)
                    : fillSample()
                }
              >
                {selected.status === 'cancelled' ? (
                  <RotateCcw size={16} />
                ) : (
                  <FileText size={16} />
                )}{' '}
                {ui(
                  selected.status === 'cancelled'
                    ? '重新开始演示'
                    : '填写示例论文',
                )}
              </button>
            </div>
          )}
        </section>
      </div>
      <Dialog
        open={!!duplicate}
        onOpenChange={(open) => {
          if (!open) setDuplicate(null);
        }}
      >
        <DialogContent className="single-duplicate-dialog">
          <DialogHeader>
            <DialogTitle>{ui('已有相同设置的分析记录')}</DialogTitle>
            <DialogDescription>
              {ui(
                '这篇论文已按相同标签、语言和字数范围完成过演示。可以直接查看，也可以保存一次新的分析。',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="single-duplicate-actions">
            <button className="button-secondary" onClick={() => begin(true)}>
              {ui('重新分析')}
            </button>
            <button
              className="button-primary"
              onClick={() => {
                setState((s) => ({ ...s, selectedId: duplicate!.id }));
                setDuplicate(null);
                setTab('summary');
              }}
            >
              {ui('查看已有结果 ')}
              <ArrowRight size={15} />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
