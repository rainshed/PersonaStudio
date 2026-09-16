'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  FileText,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import {
  analysisApi,
  type Evidence,
  type RealResult,
} from '@/lib/analysis-api';
import type { DailyItem } from '@/lib/daily-api';
import type { FeedbackDimension } from '@/lib/radar';
import { academicName } from '@/lib/academic-text';
import { analysisDecisionNotice, detailStatus } from '@/lib/daily-ui';
import { useUiLanguage } from './ui-language';
import { EvidenceSource } from './evidence-source';
import { EvidenceText } from './evidence-text';
import { KnowledgeBasis } from './knowledge-basis';
import { SavedFeedback } from './saved-feedback';

export type PaperSection = 'overview' | 'report';

/** The saved report is shared by daily screening and single-paper analysis. */
export function PaperWorkspace({
  item,
  result,
  onClose,
  onAnalyze,
  onRescreen,
  onSingle,
  analyzing = false,
  actionError = '',
  section: controlledSection,
  onSection,
  expanded,
  onExpand,
}: {
  item?: DailyItem | null;
  result?: RealResult | null;
  onClose?: () => void;
  onAnalyze?: (id: string, force?: boolean) => void;
  onRescreen?: (id: string) => void;
  onSingle?: (id: string) => void;
  analyzing?: boolean;
  actionError?: string;
  section?: PaperSection;
  onSection?: (section: PaperSection) => void;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  const { ui, locale } = useUiLanguage();
  const prefix = useId();
  const [localSection, setLocalSection] = useState<PaperSection>('overview');
  const section = controlledSection ?? localSection;
  const setSection = (next: PaperSection) => {
    setLocalSection(next);
    onSection?.(next);
  };
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const request = useRef<AbortController | null>(null);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const evidencePanel = useRef<HTMLDialogElement | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (evidenceOpen) evidencePanel.current?.focus();
  }, [evidenceOpen]);
  const paper = item?.paper ?? result?.paper;
  if (!paper) return null;
  const language =
    result?.settings_snapshot.language ?? item?.job?.input.language ?? 'zh';
  const closeEvidence = () => {
    request.current?.abort();
    setEvidenceOpen(false);
    evidenceTrigger.current?.focus();
  };
  async function showEvidence(id: string, analysis: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    evidenceTrigger.current = document.activeElement as HTMLElement;
    setEvidenceOpen(true);
    setEvidence(null);
    setEvidenceError('');
    const path = analysis
      ? 'analyses/' + result?.id
      : 'daily-item-versions/' + item?.screening?.id;
    try {
      const value = await analysisApi<Evidence>(
        path + '/evidence/' + encodeURIComponent(id),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setEvidence(value);
    } catch (error) {
      if (!controller.signal.aborted)
        setEvidenceError(
          error instanceof Error ? error.message : '无法读取证据。',
        );
    }
  }
  const links = (ids: string[] = [], analysis = true) => (
    <span className="paper-evidence-links">
      {[...new Set(ids)].map((id, i) => (
        <button
          type="button"
          key={id}
          onClick={() => void showEvidence(id, analysis)}
          title={
            (analysis
              ? result?.evidence_index
              : item?.screening?.evidence_index
            )?.find((entry) => entry.id === id)?.title
          }
        >
          <FileText size={13} />
          {ui('证据 ')}
          {i + 1}
        </button>
      ))}
    </span>
  );
  const feedback = (dimension: FeedbackDimension, analysis = true) => {
    const snapshot = analysis ? result : item?.screening;
    if (!snapshot?.feedback_dimensions.includes(dimension)) return null;
    const path =
      (analysis ? 'analyses/' : 'daily-item-versions/') + snapshot.id;
    return (
      <SavedFeedback
        key={path + dimension}
        path={path}
        dimension={dimension}
        value={snapshot.feedback[dimension]}
        language={language}
        decision={
          analysis
            ? result?.personalization.data?.decision
            : item?.screening?.data.outcome
        }
        notRecommended={
          analysis
            ? result?.personalization.data?.decision === 'not_recommended'
            : item?.screening?.data.outcome === 'not_recommended'
        }
      />
    );
  };
  const personal = result?.personalization.data;
  const showingAnalysis = !!result && (!item || section === 'report');
  const decision = showingAnalysis ? personal?.decision : item?.final_decision;
  const tabs = [
    ['overview', '概览'],
    ['report', '完整报告'],
  ] as const;
  return (
    <article className="paper-workspace">
      <div className="paper-reader-actions">
        {onClose && (
          <button onClick={onClose}>
            <ArrowLeft size={15} />
            {ui('返回列表')}
          </button>
        )}
        <span />
        {onExpand && (
          <button onClick={onExpand}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            {ui(expanded ? '恢复分栏' : '展开阅读')}
          </button>
        )}
        <a href={paper.url} target="_blank" rel="noreferrer">
          arXiv <ArrowUpRight size={14} />
        </a>
      </div>
      <header className="paper-reader-heading">
        <div className="daily-meta">
          <span>
            {paper.id}v{paper.version}
          </span>
          <span>{ui(item ? '每日论文' : '论文分析')}</span>
        </div>
        <h2>{paper.title}</h2>
        <p className="paper-reader-authors">
          {paper.authors.map(academicName).join(', ')}
        </p>
        <div className="paper-reader-status">
          <span className={'paper-decision ' + (decision ?? 'undetermined')}>
            {ui(
              decision === 'recommended'
                ? '推荐'
                : decision === 'not_recommended'
                  ? '未推荐'
                  : item && !item.screening
                    ? '初筛未完成'
                    : '关联待确认',
            )}
          </span>
          <span>
            {ui(
              item?.screening && !showingAnalysis
                ? item.screening.reading_coverage?.paper_sections.length
                  ? '初筛与定向补读'
                  : '摘要初筛'
                : '全文分析',
            )}
            {result ? ' · ' + ui('报告已保存') : ''}
          </span>
        </div>
      </header>
      <div className="paper-recommendation-feedback">
        {feedback('accuracy', showingAnalysis)}
      </div>
      <div
        className="research-section-tabs paper-tabs"
        role="tablist"
        tabIndex={-1}
        aria-label={ui('论文内容')}
        onKeyDown={(event) => {
          const index = tabs.findIndex(([key]) => key === section);
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          const target = tabs[next][0];
          setSection(target);
          document.getElementById(prefix + '-' + target)?.focus();
        }}
      >
        {tabs.map(([key, label]) => (
          <button
            key={key}
            id={prefix + '-' + key}
            type="button"
            role="tab"
            tabIndex={section === key ? 0 : -1}
            aria-selected={section === key}
            aria-controls={prefix + '-panel-' + key}
            onClick={() => setSection(key)}
          >
            {ui(label)}
          </button>
        ))}
      </div>
      {actionError && (
        <p className="daily-notice" role="alert">
          {ui(actionError)}
        </p>
      )}
      {evidenceOpen && (
        <dialog
          open
          ref={evidencePanel}
          tabIndex={-1}
          className="paper-evidence-panel"
          aria-label={ui('分析依据')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeEvidence();
          }}
        >
          <header>
            <strong>{evidence?.title ?? ui('分析依据')}</strong>
            <button aria-label={ui('关闭证据')} onClick={closeEvidence}>
              <X size={18} />
            </button>
          </header>
          {evidenceError ? (
            <p role="alert">{ui(evidenceError)}</p>
          ) : evidence ? (
            <>
              <EvidenceSource evidence={evidence} />
              <EvidenceText evidence={evidence} />
              {evidence.url && (
                <a
                  className="daily-link"
                  href={evidence.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {ui('打开来源 ')}
                  <ArrowUpRight size={14} />
                </a>
              )}
            </>
          ) : (
            <output>{ui('正在读取…')}</output>
          )}
        </dialog>
      )}
      <div
        id={prefix + '-panel-overview'}
        role="tabpanel"
        aria-labelledby={prefix + '-overview'}
        hidden={section !== 'overview'}
        className="paper-reading-body"
      >
        {item?.error && (
          <p className="daily-notice">{ui(item.error.message)}</p>
        )}
        {item?.screening_agent && (
          <section className="paper-report-section" aria-label={ui('初筛进度')}>
            {item.screening_reuse?.reused && (
              <p>
                {ui('复用已有筛选')} ·{' '}
                {new Date(item.screening_reuse.generated_at).toLocaleString(
                  locale,
                )}{' '}
                · {item.screening?.model?.model_id}
              </p>
            )}
            {item.processing_status === 'screening' && (
              <output>
                {ui(
                  (
                    {
                      reading_knowledge: '阅读筛选依据',
                      reading_paper: '补读论文',
                      validating: '校验结果',
                    } as Record<string, string>
                  )[item.agent_progress?.phase ?? ''] ?? '正在逐篇判断',
                )}
              </output>
            )}
            {item.agent_progress?.coverage && (
              <p className="daily-meta">
                {ui(
                  item.agent_progress.coverage.total_records == null
                    ? '已查阅知识与材料'
                    : '已读取知识条目',
                )}{' '}
                {item.agent_progress.coverage.delivered_records}
                {item.agent_progress.coverage.total_records != null &&
                  `/${item.agent_progress.coverage.total_records}`}
              </p>
            )}
            {onRescreen && (
              <button
                className="button-secondary"
                disabled={item.screening_active || analyzing}
                onClick={() => onRescreen(item.id)}
              >
                {ui(item.screening ? '按原设置重新判断' : '重试本篇初筛')}
              </button>
            )}
          </section>
        )}
        <section className="paper-report-section">
          <h3>{ui('文章介绍')}</h3>
          <p>
            {item?.screening?.data.introduction ??
              result?.summary.data?.sections[0]?.paragraphs.join('\n\n') ??
              paper.abstract}
          </p>
        </section>
        {item?.screening ? (
          <section className="paper-report-section">
            <h3>{ui('初筛理由')}</h3>
            <p>{item.screening.data.reason}</p>
            <KnowledgeBasis
              ids={item.screening.data.matched_knowledge_ids}
              evidence={item.screening.evidence_index}
            />
            {links(
              [
                ...(item.screening.data.paper_evidence_ids ?? []),
                ...(item.screening.data.persona_evidence_ids ?? []),
              ],
              false,
            )}
          </section>
        ) : (
          result && (
            <section className="paper-report-section">
              <h3>{ui('推荐理由')}</h3>
              {personal?.reasons.map((reason, i) => (
                <p key={i}>{reason.text}</p>
              ))}
              {result.personalization.status !== 'available' && (
                <p className="daily-notice">
                  {ui(
                    result.personalization.error?.message ??
                      '个性化分析尚未完成。',
                  )}
                </p>
              )}
              <KnowledgeBasis
                ids={personal?.matched_knowledge_ids}
                evidence={result.evidence_index}
              />
            </section>
          )
        )}
        {item?.screening?.data.questions_for_fulltext?.length ? (
          <section className="paper-report-section">
            <h3>{ui('阅读全文时关注')}</h3>
            <ul>
              {item.screening.data.questions_for_fulltext.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <details className="research-disclosure">
          <summary>{ui('查看原始摘要')}</summary>
          <p>{paper.abstract}</p>
        </details>
        <div className="daily-actions">
          <button
            className="button-primary"
            onClick={() => setSection('report')}
          >
            {ui(result ? '阅读完整报告' : '查看全文分析')}
          </button>
        </div>
      </div>
      <div
        id={prefix + '-panel-report'}
        role="tabpanel"
        aria-labelledby={prefix + '-report'}
        hidden={section !== 'report'}
        className="paper-reading-body"
      >
        {result ? (
          <>
            <section
              className="evidence-source"
              aria-label={ui('本次阅读依据')}
            >
              <strong>{ui('本次阅读依据')}</strong>
              <p>
                {ui('可读取文本块')} {result.paper.coverage.block_count} ·{' '}
                {ui('保存的引用')} {result.evidence_index.length}
              </p>
              <p>
                {ui(
                  '引用位置说明实际依据；提取出的文本数量不代表逐段阅读全文。',
                )}
              </p>
              {(!('figures_interpreted' in result.paper.coverage) ||
                result.paper.coverage.figures_interpreted !== true) && (
                <p>
                  {ui(
                    '本次未验证图像内容，图注、表格与公式仅以提取文字作为依据。',
                  )}
                </p>
              )}
            </section>
            <details className="research-disclosure">
              <summary>
                {ui('报告版本与生成信息')} ·{' '}
                {new Date(result.created_at).toLocaleDateString(locale)}
              </summary>
              <p>
                {ui('报告 ')}
                {result.id} · Persona {result.persona?.revision ?? '—'}
              </p>
              <p>
                {ui('内容语言')} · {ui(language === 'zh' ? '中文' : 'English')}{' '}
                · {result.settings_snapshot.summary_length.min}–
                {result.settings_snapshot.summary_length.max}{' '}
                {ui(language === 'zh' ? '字' : 'words')} ·{' '}
                {result.paper.coverage.format.toUpperCase()}
              </p>
              {result.paper.coverage.issues.map((issue, i) => (
                <p key={i}>{ui(issue)}</p>
              ))}
            </details>
            <section className="paper-report-section">
              <h3>{ui('研究总结')}</h3>
              {result.summary.status !== 'available' && (
                <p className="daily-notice">
                  {ui(
                    result.summary.error?.message ??
                      (result.summary.status === 'pending'
                        ? '正在生成详细研究总结…'
                        : '研究总结尚需核对。'),
                  )}
                  {result.summary.validation?.issues
                    ?.map((issue) => ui(issue))
                    .join(ui('；'))}
                </p>
              )}
              {result.summary.data?.sections.map((s, i) => (
                <section
                  className="paper-report-part"
                  key={i}
                  id={prefix + '-summary-' + i}
                >
                  <h4>{s.title}</h4>
                  {s.paragraphs.map((p, j) => (
                    <p key={j}>{p}</p>
                  ))}
                  <div className="paper-section-actions">
                    {links(s.evidence_ids)}
                  </div>
                </section>
              ))}
            </section>
            <section className="paper-report-section">
              <h3>{ui(item ? '全文补充意见' : '推荐理由')}</h3>
              {item && analysisDecisionNotice(item) && (
                <p className="daily-notice">
                  {ui(analysisDecisionNotice(item))}
                </p>
              )}
              {result.personalization.status !== 'available' && (
                <p className="daily-notice">
                  {ui(
                    result.personalization.error?.message ??
                      '个性化分析尚未完成。',
                  )}
                </p>
              )}
              <KnowledgeBasis
                ids={personal?.matched_knowledge_ids}
                evidence={result.evidence_index}
              />
              {personal?.reasons.map((reason, i) => (
                <div
                  className="paper-report-part"
                  key={i}
                  id={prefix + '-reason-' + i}
                >
                  <p>{reason.text}</p>
                  <div className="paper-section-actions">
                    {links([
                      ...reason.paper_evidence_ids,
                      ...reason.persona_evidence_ids,
                    ])}
                  </div>
                </div>
              ))}
            </section>
            <section className="paper-report-section">
              <h3>{ui('已有材料联系')}</h3>
              {personal?.connections.length ? (
                personal.connections.map((c, i) => (
                  <div
                    className="paper-report-part"
                    key={i}
                    id={prefix + '-connection-' + i}
                  >
                    <h4>
                      {result.persona?.records.find(
                        (r) => r.id === c.material_id,
                      )?.title ?? ui('相关材料')}
                    </h4>
                    <span className="daily-meta">
                      {ui(
                        {
                          direct_citation: '直接引用',
                          shared_question: '共同问题',
                          method_comparison: '方法比较',
                        }[c.relation_type] ?? c.relation_type,
                      )}
                    </span>
                    <p>{c.explanation}</p>
                    <div className="paper-section-actions">
                      {links([
                        ...c.paper_evidence_ids,
                        ...c.persona_evidence_ids,
                      ])}
                    </div>
                  </div>
                ))
              ) : (
                <p>{ui('本次尚无有充分依据的材料联系。')}</p>
              )}
            </section>
            <section className="paper-report-section">
              <h3>{ui('潜在交叉')}</h3>
              {personal?.crossovers.length ? (
                personal.crossovers.map((c, i) => (
                  <div
                    className="paper-report-part"
                    key={i}
                    id={prefix + '-crossover-' + i}
                  >
                    <h4>{c.question}</h4>
                    <p>{c.premises}</p>
                    <p>
                      <strong>{ui('待验证：')}</strong>
                      {c.unverified_points}
                    </p>
                    <p>
                      <strong>{ui('第一步检查：')}</strong>
                      {c.first_check}
                    </p>
                    <p className="daily-meta">{c.novelty_check_scope}</p>
                    <div className="paper-section-actions">
                      {links(c.supporting_evidence_ids)}
                    </div>
                  </div>
                ))
              ) : (
                <p>{ui('本次尚无有充分依据的交叉建议。')}</p>
              )}
            </section>
          </>
        ) : (
          <div className="research-empty">
            <FileText size={24} />
            <h3>{ui('完整报告')}</h3>
            <p>
              {ui(
                item && ['queued', 'running'].includes(item.details_status)
                  ? '全文分析已提交，完成的内容将自动显示；可以继续浏览其他论文。'
                  : '研究总结、材料联系和潜在交叉需要进一步读取全文。',
              )}
            </p>
          </div>
        )}
        {item && (
          <div className="paper-analysis-actions">
            <output className="daily-meta">
              {ui(
                analyzing
                  ? '正在提交详细分析…'
                  : detailStatus(item.details_status),
              )}
            </output>
            {item.details_error && (
              <p className="daily-notice" role="alert">
                {ui(item.details_error.message)}
              </p>
            )}
            <div className="daily-actions">
              {onAnalyze &&
                !item.excluded &&
                !['queued', 'running'].includes(item.details_status) && (
                  <button
                    className={result ? 'button-secondary' : 'button-primary'}
                    disabled={analyzing}
                    onClick={() =>
                      onAnalyze(item.id, item.details_status === 'available')
                    }
                  >
                    {ui(
                      analyzing
                        ? '正在提交…'
                        : item.details_status === 'available'
                          ? '重新生成详细报告'
                          : item.job_id
                            ? '重试详细分析'
                            : '生成详细分析',
                    )}
                  </button>
                )}
              {item.job_id && onSingle && (
                <button
                  className="button-secondary"
                  onClick={() => onSingle(item.job_id!)}
                >
                  {ui('打开单篇任务')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
