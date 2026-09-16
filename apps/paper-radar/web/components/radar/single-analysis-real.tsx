'use client';
import { usePersonaTags } from './use-persona-tags';
import { useAnalysisHistory } from './use-analysis-history';
import { TaskRuntime } from './task-runtime';
import { useUiLanguage } from '@/components/radar/ui-language';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { academicName } from '@/lib/academic-text';
import { analysisApi, type RealInput, type RealJob } from '@/lib/analysis-api';
import { parseArxiv } from '@/lib/arxiv';
import { browserRequestId } from '@/lib/backend-response';
import type { Subscription } from '@/lib/radar';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
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
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PaperWorkspace } from './paper-workspace';
import './single-analysis-real.css';
import './single-analysis.css';

const DRAFT_KEY = 'paper-radar.single.real.draft.v1';
const SELECTED_KEY = 'paper-radar.single.real.selected.v1';
const active = (j: RealJob) => ['queued', 'running'].includes(j.status);
const statusLabel = (status: string) =>
  ({
    queued: '排队中',
    running: '分析中',
    succeeded: '已完成',
    partial: '部分完成',
    failed: '未完成',
    cancelled: '已取消',
    interrupted: '已中断',
  })[status] ?? status;
const emptyInput: RealInput = {
  arxiv_input: '',
  persona_connection_id: null,
  scope: { tag_ids: [], tag_match: 'any' },
  language: 'zh',
  summary_length: { min: 800, max: 1200 },
  force_regenerate: false,
};
export function RealSingleAnalysis({
  subscriptions,
  onModels,
  initialJobId,
  onDaily,
}: {
  subscriptions: Subscription[];
  onModels: () => void;
  initialJobId?: string;
  onDaily?: (runId: string) => void;
}) {
  const { ui, locale, uiLanguage } = useUiLanguage();
  const [draft, setDraft] = useState<RealInput>(emptyInput);
  const [minText, setMinText] = useState('800'),
    [maxText, setMaxText] = useState('1200');
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [creating, setCreating] = useState(false),
    [tick, setTick] = useState(0),
    [offset, setOffset] = useState(0);
  const {
    jobs,
    selectedJob,
    setSelectedJob,
    result,
    setResult,
    hasMore,
    networkError,
    loading: historyLoading,
  } = useAnalysisHistory({
    ready,
    selectedId,
    offset,
    refresh: tick,
    onSelect: setSelectedId,
  });
  const { tags, personaId, personaError } = usePersonaTags(tick);
  const [preset, setPreset] = useState('custom');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const requestRef = useRef<{ fingerprint: string; key: string } | null>(null),
    formRef = useRef<HTMLInputElement>(null),
    resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
        if (
          saved &&
          typeof saved.arxiv_input === 'string' &&
          Array.isArray(saved.scope?.tag_ids) &&
          saved.scope.tag_ids.every((s: unknown) => typeof s === 'string') &&
          ['zh', 'en'].includes(saved.language) &&
          Number.isInteger(saved.summary_length?.min) &&
          Number.isInteger(saved.summary_length?.max)
        ) {
          setDraft({
            ...emptyInput,
            arxiv_input: saved.arxiv_input,
            scope: { tag_ids: saved.scope.tag_ids, tag_match: 'any' },
            persona_connection_id:
              typeof saved.persona_connection_id === 'string'
                ? saved.persona_connection_id
                : null,
            language: saved.language,
            summary_length: saved.summary_length,
          });
          setMinText(String(saved.summary_length.min));
          setMaxText(String(saved.summary_length.max));
        }
        setSelectedId(initialJobId ?? localStorage.getItem(SELECTED_KEY));
      } catch {
        /* A malformed local draft never replaces backend results. */
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initialJobId]);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
      else localStorage.removeItem(SELECTED_KEY);
    } catch {
      /* Backend history is unaffected. */
    }
  }, [draft, selectedId, ready]);

  const update = (patch: Partial<RealInput>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setPreset('custom');
    setError('');
  };
  const loadInput = (input: RealInput) => {
    setDraft({ ...input, force_regenerate: false });
    setMinText(String(input.summary_length.min));
    setMaxText(String(input.summary_length.max));
    setPreset('custom');
    setError('');
    formRef.current?.focus();
  };
  const length = (min: string, max: string) => {
    setMinText(min);
    setMaxText(max);
    if (
      min &&
      max &&
      Number.isInteger(Number(min)) &&
      Number.isInteger(Number(max))
    )
      update({ summary_length: { min: Number(min), max: Number(max) } });
  };
  async function begin(force = false, source?: RealInput) {
    const input = {
      ...(source ?? draft),
      summary_length: source?.summary_length ?? {
        min: minText.trim() ? Number(minText) : NaN,
        max: maxText.trim() ? Number(maxText) : NaN,
      },
      persona_connection_id: source
        ? source.persona_connection_id
        : draft.scope.tag_ids.length
          ? personaId
          : null,
      force_regenerate: force,
    };
    if (!parseArxiv(input.arxiv_input)) {
      setError('请填写有效的 arXiv 链接或编号。');
      return;
    }
    if (
      !Number.isInteger(input.summary_length.min) ||
      !Number.isInteger(input.summary_length.max) ||
      input.summary_length.min < 200 ||
      input.summary_length.max > 3000 ||
      input.summary_length.min >= input.summary_length.max
    ) {
      setError('字数范围应为 200–3000 内的整数，最少字数小于最多字数。');
      return;
    }
    if (
      input.scope.tag_ids.some((id) => !tags.some((t) => t.id === id)) ||
      (input.scope.tag_ids.length &&
        (!personaId || input.persona_connection_id !== personaId))
    ) {
      setError('所选 Persona 标签暂不可用，请刷新标签或重新选择。');
      return;
    }
    const fingerprint = JSON.stringify(input);
    if (requestRef.current?.fingerprint !== fingerprint)
      requestRef.current = { fingerprint, key: browserRequestId() };
    setCreating(true);
    setError('');
    try {
      const response = await analysisApi<{ job: RealJob; reused: boolean }>(
        'analyses',
        { method: 'POST', body: input, key: requestRef.current!.key },
      );
      requestRef.current = null;
      setSelectedId(response.job.id);
      setOffset(0);
      setSelectedJob(response.job);
      setResult(null);
      setDraft(input);
      setMinText(String(input.summary_length.min));
      setMaxText(String(input.summary_length.max));
      setNotice(
        response.reused
          ? '已打开这次请求的任务。'
          : '分析任务已保存，可以离开页面后再回来查看。',
      );
      setTick((t) => t + 1);
      resultRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法创建任务。');
    } finally {
      setCreating(false);
    }
  }
  async function jobAction(action: 'cancel' | 'retry') {
    if (!selectedJob) return;
    setError('');
    try {
      const response = await analysisApi<RealJob | { job: RealJob }>(
        action === 'retry' && selectedJob.origin?.daily_item_id
          ? 'daily-items/' + selectedJob.origin.daily_item_id + '/analyze'
          : 'jobs/' + selectedJob.id + '/' + action,
        { method: 'POST', body: {}, key: browserRequestId() },
      );
      if ('job' in response) {
        setSelectedId(response.job.id);
        setOffset(0);
        setResult(null);
      }
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成。');
    }
  }
  const parsed = parseArxiv(draft.arxiv_input);
  const tagsLabel = (ids: string[]) =>
    ids
      .map(
        (id) =>
          tags.find((t) => t.id === id)?.label ??
          result?.persona?.tags.find((t) => t.id === id)?.label ??
          ui('已选标签'),
      )
      .join(uiLanguage === 'zh' ? '、' : ', ');
  const running = selectedJob && active(selectedJob);

  return (
    <div className="single-workspace real-analysis">
      <div className="page-heading single-heading">
        <div>
          <p className="eyebrow">PAPER RADAR / ANALYSIS</p>
          <h1>{ui('单篇论文分析')}</h1>
          <p>{ui('读清论文做了什么，找到与你研究的联系。')}</p>
        </div>
        <span className="single-demo-badge real-connected">
          <span />
          {ui('本机服务 · 真实分析')}
        </span>
      </div>
      <div className="single-demo-line">
        <ShieldCheck size={16} />
        <p>
          {ui(
            '以所选标签下的知识点作为推荐依据，结合相关材料分析。结果和反馈保存在本机。',
          )}
        </p>
      </div>
      {(error || networkError) && (
        <div className="single-alert" role="alert">
          <CircleAlert size={16} />
          <p>{ui(error || networkError)}</p>
          <button
            className="single-text-button"
            onClick={() => {
              setError('');
              setTick((t) => t + 1);
            }}
          >
            {ui('刷新连接')}
          </button>
        </div>
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
            aria-labelledby="real-form-heading"
          >
            <div className="single-card-label">
              <span className="single-number">01</span>
              <h2 id="real-form-heading">{ui('添加论文')}</h2>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void begin();
              }}
            >
              <label className="single-label" htmlFor="real-arxiv">
                {ui('arXiv 链接或编号')}
              </label>
              <div className="single-link-input">
                <Link2 size={17} />
                <input
                  id="real-arxiv"
                  ref={formRef}
                  value={draft.arxiv_input}
                  required
                  maxLength={500}
                  autoComplete="off"
                  placeholder="https://arxiv.org/abs/2501.12903"
                  onChange={(e) => update({ arxiv_input: e.target.value })}
                />
              </div>
              <div className="single-link-help">
                <span>{ui('支持摘要、PDF、HTML 链接')}</span>
                <button
                  type="button"
                  onClick={() =>
                    update({
                      arxiv_input: 'https://arxiv.org/abs/2501.12903v3',
                    })
                  }
                >
                  {ui('填入示例 ')}
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
                    <span>{ui('格式有效 · 开始后读取真实论文')}</span>
                  </div>
                  <Check size={15} />
                </div>
              )}
              <div className="single-form-rule" />
              <div className="single-card-label">
                <span className="single-number">02</span>
                <h2>{ui('设置分析范围')}</h2>
              </div>
              <label className="single-label" htmlFor="real-subscription">
                {ui('沿用订阅设置')}
              </label>
              <Select
                value={preset}
                onValueChange={(value) => {
                  if (!value || value === 'custom') {
                    setPreset('custom');
                    return;
                  }
                  const s = subscriptions.find((s) => s.id === value);
                  if (!s) return;
                  const chosen = s.tags.map((name) =>
                    tags.filter((t) =>
                      [t.label, t.slug, ...t.aliases].some(
                        (label) => label?.toLowerCase() === name.toLowerCase(),
                      ),
                    ),
                  );
                  if (chosen.some((c) => c.length !== 1)) {
                    setError(
                      '订阅中的示例标签无法唯一对应真实标签，请手动选择。',
                    );
                    return;
                  }
                  loadInput({
                    ...draft,
                    scope: {
                      tag_ids: chosen.map((c) => c[0].id),
                      tag_match: 'any',
                    },
                    persona_connection_id: personaId,
                    language: s.language,
                    summary_length: s.summaryLength,
                  });
                  setPreset(value);
                }}
              >
                <SelectTrigger id="real-subscription" className="single-select">
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
                {ui('复制标签、语言和字数；单篇不受订阅 subject 限制。')}
              </p>
              <fieldset className="single-tags">
                <legend className="single-label">
                  {ui('Persona 标签 ')}
                  <span>{ui('真实知识范围')}</span>
                </legend>
                {personaError ? (
                  <div className="single-validation-note">
                    <p>{ui(personaError)}</p>
                  </div>
                ) : (
                  <div className="real-tag-scroll">
                    {tags.length ? (
                      tags.map((tag) => (
                        <label
                          key={tag.id}
                          className={
                            'single-tag-choice ' +
                            (draft.scope.tag_ids.includes(tag.id)
                              ? 'selected'
                              : '')
                          }
                        >
                          <Checkbox
                            checked={draft.scope.tag_ids.includes(tag.id)}
                            onCheckedChange={(checked) =>
                              update({
                                scope: {
                                  tag_ids: checked
                                    ? [...draft.scope.tag_ids, tag.id]
                                    : draft.scope.tag_ids.filter(
                                        (id) => id !== tag.id,
                                      ),
                                  tag_match: 'any',
                                },
                                persona_connection_id: personaId,
                              })
                            }
                          />
                          <Tag size={13} />
                          <span>{tag.label}</span>
                        </label>
                      ))
                    ) : (
                      <p className="single-help">{ui('正在获取标签…')}</p>
                    )}
                  </div>
                )}
                <p className="single-help">
                  {draft.scope.tag_ids.length
                    ? ui('依据 {0} 下的全部知识点推荐，多标签取并集。', [
                        tagsLabel(draft.scope.tag_ids),
                      ])
                    : ui('未选标签：仅研究总结，不进行个性化判断。')}
                </p>
                {draft.scope.tag_ids.length > 0 && (
                  <button
                    className="single-text-button"
                    type="button"
                    onClick={() =>
                      update({ scope: { tag_ids: [], tag_match: 'any' } })
                    }
                  >
                    {ui('清空标签，仅生成总结')}
                  </button>
                )}
              </fieldset>
              <label className="single-label" htmlFor="real-language">
                {ui('内容语言')}
              </label>
              <Select
                value={draft.language}
                onValueChange={(v) => {
                  if (v === 'zh' || v === 'en') update({ language: v });
                }}
              >
                <SelectTrigger id="real-language" className="single-select">
                  <SelectValue>
                    {ui(draft.language === 'zh' ? '中文' : 'English')}
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
                  <span>{ui(draft.language === 'zh' ? '字' : 'words')}</span>
                </legend>
                <div className="single-length-inputs">
                  <input
                    aria-label={ui('总结最少字数')}
                    type="number"
                    min={200}
                    max={2999}
                    step={1}
                    value={minText}
                    onChange={(e) => length(e.target.value, maxText)}
                  />
                  <span>—</span>
                  <input
                    aria-label={ui('总结最多字数')}
                    type="number"
                    min={201}
                    max={3000}
                    step={1}
                    value={maxText}
                    onChange={(e) => length(minText, e.target.value)}
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
                      key={label}
                      className={
                        minText === String(min) && maxText === String(max)
                          ? 'selected'
                          : ''
                      }
                      onClick={() => length(String(min), String(max))}
                    >
                      {ui(label)}
                    </button>
                  ))}
                </div>
                <p className="single-help">
                  {ui(
                    '中文按非空白字符计数，英文按单词计数。生成后检查并按需修订。',
                  )}
                </p>
              </fieldset>
              <div className="single-model-note">
                <Settings2 size={16} />
                <div>
                  <strong>{ui('沿用模型设置')}</strong>
                  <p>{ui('总结、材料联系使用各自的任务模型')}</p>
                </div>
                <button
                  type="button"
                  onClick={onModels}
                  aria-label={ui('打开模型设置')}
                >
                  <ArrowRight size={16} />
                </button>
              </div>
              <button
                className="button-primary single-submit"
                type="submit"
                disabled={!ready || creating}
              >
                {creating ? (
                  <LoaderCircle className="single-spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}{' '}
                {ui(creating ? '正在提交' : '开始分析')}
                <ArrowRight size={17} />
              </button>
              <p className="single-submit-note">
                {ui('实际调用所配置模型，使用对应平台的额度。')}
              </p>
            </form>
          </section>
          <section className="single-history">
            <div className="single-history-heading">
              <h2>
                <History size={17} />
                {ui('分析记录')}
              </h2>
              <span>{jobs.length}</span>
            </div>
            {jobs.length ? (
              <div className="single-history-list">
                {jobs.map((job) => (
                  <button
                    className={
                      'single-history-item ' +
                      (selectedId === job.id ? 'selected' : '')
                    }
                    key={job.id}
                    onClick={() => {
                      setSelectedId(job.id);
                      setSelectedJob(job);
                      setResult(null);
                    }}
                  >
                    <div>
                      <span className={'single-history-status ' + job.status}>
                        {active(job) ? (
                          <LoaderCircle className="single-spin" size={12} />
                        ) : (
                          <Clock3 size={12} />
                        )}{' '}
                        {ui(statusLabel(job.status))}
                      </span>
                      <time>
                        {new Date(job.created_at).toLocaleString(locale, {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                    <strong>
                      {ui(
                        job.paper_title ??
                          parseArxiv(job.input.arxiv_input)?.id ??
                          '论文分析',
                      )}
                    </strong>
                    <p>
                      {ui(job.input.language === 'zh' ? '中文' : 'English')} ·{' '}
                      {job.input.summary_length.min}–
                      {job.input.summary_length.max} ·{' '}
                      {job.input.scope.tag_ids.length
                        ? tagsLabel(job.input.scope.tag_ids)
                        : ui('仅总结')}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="single-history-empty">
                <FileText size={22} />
                <p>{ui('开始一次分析，结果会保存在这里。')}</p>
              </div>
            )}
            {offset > 0 && (
              <button
                className="single-text-button"
                onClick={() => setOffset((n) => Math.max(0, n - 25))}
              >
                {ui('较新的记录')}
              </button>
            )}
            {hasMore && (
              <button
                className="single-text-button"
                onClick={() => setOffset((n) => n + 25)}
              >
                {ui('较早的记录')}
              </button>
            )}
          </section>
        </div>
        <section
          ref={resultRef}
          className={'single-result' + (result ? ' has-report' : '')}
          aria-label={ui('分析结果')}
        >
          <div className="single-result-top">
            <div className="single-card-label">
              <span className="single-number">03</span>
              <h2>{ui('研究分析')}</h2>
            </div>
            <span className="single-result-status">
              {ui(
                selectedJob
                  ? statusLabel(selectedJob.status)
                  : historyLoading
                    ? '正在读取…'
                    : '等待添加论文',
              )}
            </span>
          </div>
          {historyLoading ? (
            <output className="single-empty-section">{ui('正在读取…')}</output>
          ) : !selectedJob ? (
            <div className="single-empty-section real-empty-start">
              <FileText size={34} />
              <h3>{ui('从一篇论文开始')}</h3>
              <p>
                {ui(
                  '粘贴 arXiv 链接，选择允许使用的个人知识范围。完成后可查看详细总结、推荐依据，以及与已有材料的联系。',
                )}
              </p>
            </div>
          ) : (
            <>
              <div className="single-paper-header">
                <div className="single-paper-source">
                  <span>
                    arXiv ·{' '}
                    {result
                      ? `${result.paper.id}v${result.paper.version}`
                      : parseArxiv(selectedJob.input.arxiv_input)?.id}
                  </span>
                  <span>
                    {ui(
                      result?.paper.coverage.format.toUpperCase() ?? '等待读取',
                    )}
                  </span>
                </div>
                <h2>
                  {result?.paper.title ??
                    selectedJob.paper_title ??
                    ui('正在准备论文信息')}
                </h2>
                {result && (
                  <p className="single-paper-authors">
                    {result.paper.authors.map(academicName).join(' · ')}
                  </p>
                )}
                <a
                  className="single-evidence-link"
                  href={result?.paper.url ?? selectedJob.input.arxiv_input}
                  target="_blank"
                  rel="noreferrer"
                >
                  {ui('打开 arXiv ')}
                  <ArrowUpRight size={14} />
                </a>
              </div>
              <div className="single-context-bar">
                <span>
                  <Tag size={13} />
                  {result?.persona?.tags
                    .map((t) => t.label)
                    .join(uiLanguage === 'zh' ? '、' : ', ') ||
                    tagsLabel(selectedJob.input.scope.tag_ids) ||
                    ui('仅研究总结')}
                </span>
                <span>
                  {ui(selectedJob.input.language === 'zh' ? '中文' : 'English')}
                </span>
                <span>
                  {selectedJob.input.summary_length.min}–
                  {selectedJob.input.summary_length.max}{' '}
                  {ui(selectedJob.input.language === 'zh' ? '字' : 'words')}
                </span>
                {result?.persona && (
                  <span>Persona r{result.persona.revision}</span>
                )}
              </div>
              {running && (
                <div className="real-task-progress" aria-live="polite">
                  <div>
                    <LoaderCircle className="single-spin" size={20} />
                    <strong>{ui(selectedJob.message)}</strong>
                    <button
                      className="single-text-button"
                      onClick={() => void jobAction('cancel')}
                    >
                      {ui('取消任务')}
                    </button>
                  </div>
                  <TaskRuntime {...selectedJob} />
                  <ol>
                    {selectedJob.stages.map((s) => (
                      <li key={s.id} className={s.status}>
                        <span>
                          {s.status === 'succeeded' ? (
                            <Check size={12} />
                          ) : s.status === 'running' ? (
                            <LoaderCircle className="single-spin" size={12} />
                          ) : (
                            <span />
                          )}
                        </span>
                        {ui(s.label)}
                        {ui(s.status === 'skipped' ? ' · 跳过' : '')}
                      </li>
                    ))}
                  </ol>
                  <p>
                    {ui(
                      '任务在本机后台执行。已完成内容会先显示，可以稍后回来查看。',
                    )}
                  </p>
                </div>
              )}
              {selectedJob.error && (
                <div className="single-validation-note real-job-error">
                  <CircleAlert size={18} />
                  <div>
                    <p>{ui(selectedJob.error.message)}</p>
                    <button className="single-text-button" onClick={onModels}>
                      {ui('检查模型设置')}
                    </button>
                  </div>
                </div>
              )}
              {result ? (
                <>
                  <PaperWorkspace key={result.id} result={result} />
                  <footer className="single-result-footer">
                    <span>
                      <Check size={14} />
                      {ui('已保存到本机 · ')}
                      {result.attempts.length} {ui(' 次模型请求')}
                    </span>
                    <div className="real-footer-actions">
                      <button
                        onClick={() => {
                          loadInput(result.settings_snapshot);
                          setNotice('已载入本次设置，调整后点击开始分析。');
                        }}
                      >
                        <RotateCcw size={14} />
                        {ui('调整设置')}
                      </button>
                      {!running && (
                        <button
                          disabled={creating}
                          onClick={() =>
                            void begin(true, result.settings_snapshot)
                          }
                        >
                          <RotateCcw size={14} />
                          {ui('重新生成（调用模型）')}
                        </button>
                      )}
                      {!running && (
                        <button
                          onClick={() => setDeleteOpen(true)}
                          aria-label={ui('删除这条分析')}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </footer>
                </>
              ) : (
                !running && (
                  <div className="single-empty-section">
                    <CircleAlert size={28} />
                    <h3>{ui(statusLabel(selectedJob.status))}</h3>
                    <p>
                      {ui('本次还没有可展示的分析结果。设置和任务记录已保留。')}
                    </p>
                  </div>
                )
              )}
              {!running && (
                <div className="real-retry-bar">
                  <p>
                    {ui(
                      result?.quality_notice ??
                        '可以重新尝试该任务，已校验且设置一致的内容会复用。',
                    )}
                  </p>
                  <button
                    className="button-secondary"
                    onClick={() => void jobAction('retry')}
                  >
                    <RotateCcw size={15} />
                    {ui(
                      selectedJob.origin?.daily_run_id && onDaily
                        ? '重试详细分析'
                        : selectedJob.status === 'succeeded'
                          ? '按当前设置再分析'
                          : '重试未完成部分',
                    )}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ui('删除这次分析？')}</AlertDialogTitle>
            <AlertDialogDescription>
              {ui(
                '将删除本机保存的这次结果及其反馈。AI Persona 中的原始材料不受影响。',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ui('保留')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!result) return;
                void analysisApi('analyses/' + result.id, {
                  method: 'DELETE',
                  body: {},
                })
                  .then(() => {
                    setSelectedId(null);
                    setSelectedJob(null);
                    setResult(null);
                    setTick((t) => t + 1);
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              {ui('删除分析')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
