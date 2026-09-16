'use client';
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import {
  ArrowUpRight,
  FileText,
  Lightbulb,
  Link2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  AUTHORS,
  connectionsFor,
  isRecommended,
  reasonFor,
  type Paper,
  type Subscription,
  type Material,
  type FeedbackDimension,
} from '@/lib/radar';
import { SummaryPreview } from './summary-preview';
import { useUiLanguage } from './ui-language';

export function DemoPaperReader({
  paper,
  subscription,
  demoSection,
  setDemoSection,
  readerExpanded,
  setReaderExpanded,
  onClose,
  setEditor,
  setMaterial,
  renderFeedback,
}: {
  paper?: Paper;
  subscription: Subscription;
  demoSection: string;
  setDemoSection: (section: string) => void;
  readerExpanded: boolean;
  setReaderExpanded: Dispatch<SetStateAction<boolean>>;
  onClose: () => void;
  setEditor: (subscription: Subscription) => void;
  setMaterial: (material: Material) => void;
  renderFeedback: (
    paper: Paper,
    dimension: FeedbackDimension,
    compact?: boolean,
  ) => ReactNode;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const language = subscription.language;
  const tr = (zh: string, en: string) => (uiLanguage === 'en' ? en : zh);
  return paper ? (
    <article className="paper-workspace demo-reader">
      <div className="paper-reader-actions">
        <button onClick={onClose}>{ui('返回列表')}</button>
        <span />
        <button onClick={() => setReaderExpanded((x) => !x)}>
          {ui(readerExpanded ? '恢复分栏' : '展开阅读')}
        </button>
      </div>
      <div className="demo-reading-body">
        <header className="detail-header">
          <div className="paper-meta">
            <span className="tag">{paper.topic[language]}</span>
            <span>{paper.subjects.join(' · ')}</span>
          </div>
          <h2 className="detail-title">{paper.title}</h2>
          <p className="detail-authors">
            {paper.authors
              .map((id) => AUTHORS.find((a) => a.id === id)?.name)
              .join(', ')}
          </p>
          <p className="detail-disclaimer">
            {ui(tr('示例批次', 'Demo batch'))} {paper.date} ·{' '}
            {ui(
              tr(
                '以下论文与分析均为虚构示例',
                'Fictional paper and analysis for demonstration',
              ),
            )}
          </p>
        </header>
        <fieldset className="research-section-tabs" aria-label={ui('论文内容')}>
          {[
            ['overview', '概览'],
            ['report', '完整报告'],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={demoSection === id}
              onClick={() => setDemoSection(id)}
            >
              {ui(label)}
            </button>
          ))}
        </fieldset>
        <div hidden={demoSection !== 'overview'} className="paper-reading-body">
          <section className="paper-report-section">
            <h3>{ui('文章介绍')}</h3>
            <p>{paper.overview[language]}</p>
          </section>
          <section className="paper-report-section">
            <h3>{ui('推荐理由')}</h3>
            <p>{reasonFor(paper, subscription)[language]}</p>
            {renderFeedback(paper, 'accuracy')}
          </section>
          <button
            className="button-primary"
            onClick={() => setDemoSection('report')}
          >
            {ui('阅读完整报告')}
          </button>
        </div>
        <div hidden={demoSection !== 'report'}>
          <div className="detail-decision">
            <span
              className={
                isRecommended(paper, subscription)
                  ? 'decision-icon'
                  : 'decision-icon neutral'
              }
            >
              <Sparkles size={19} />
            </span>
            <div>
              <strong>
                {ui(
                  isRecommended(paper, subscription)
                    ? tr('推荐关注', 'Recommended')
                    : tr('暂未推荐', 'Not recommended'),
                )}
              </strong>
              <p>
                {subscription.name} ·{' '}
                {subscription.tags.join(' + ') ||
                  tr(ui('通用推荐'), 'General selection')}
              </p>
            </div>
          </div>
          {renderFeedback(paper, 'accuracy')}
          <section className="analysis-section">
            <div className="section-label">
              <span>01</span>
              <h3>{ui(tr('研究总结', 'Research summary'))}</h3>
              <span className="source-badge">
                {ui(tr('模拟分析', 'Sample analysis'))}
              </span>
            </div>
            <SummaryPreview
              paper={paper}
              subscription={subscription}
              onEdit={() => setEditor(subscription)}
            />
            {renderFeedback(paper, 'summary')}
          </section>
          <section className="analysis-section">
            <div className="section-label">
              <span>02</span>
              <h3>{ui(tr('推荐理由', 'Recommendation reason'))}</h3>
            </div>
            <p className="analysis-lead">
              {reasonFor(paper, subscription)[language]}
            </p>
            <div className="detail-scope">
              <ShieldCheck size={15} />
              {ui(tr('本次依据', 'Scope'))}:{' '}
              {subscription.tags.join(' + ') ||
                tr(
                  ui('仅 subject，不使用 Persona'),
                  'Subject only, no Persona',
                )}
            </div>
            {renderFeedback(paper, 'reason')}
          </section>
          <section className="analysis-section">
            <div className="section-label">
              <span>03</span>
              <h3>
                {ui(
                  tr(
                    '已有材料联系与潜在交叉',
                    'Connections & potential crossover',
                  ),
                )}
              </h3>
            </div>
            {connectionsFor(paper, subscription).length > 0 ? (
              <>
                <p className="section-intro">
                  {ui(
                    tr(
                      '从所选 Persona 范围出发，连接新论文与已有材料。',
                      'Connect this paper with materials in your selected Persona scope.',
                    ),
                  )}
                </p>
                {connectionsFor(paper, subscription).map((m) => (
                  <div className="material-connection" key={m.id}>
                    <button onClick={() => setMaterial(m)}>
                      <FileText size={16} />
                      <span>{m.title[language]}</span>
                      <ArrowUpRight size={15} />
                    </button>
                    <div className="material-meta">
                      <span>{m.kind[language]}</span>
                      <span>· {ui(m.tag)}</span>
                      <span className="relation-label">
                        {ui(
                          tr('问题 / 方法联系', 'Problem / method connection'),
                        )}
                      </span>
                    </div>
                    <p>{paper.connection[language]}</p>
                  </div>
                ))}
                <div className="crossover">
                  <div className="crossover-title">
                    <Lightbulb size={19} />
                    <h4>
                      {ui(
                        tr('一个可以继续探索的方向', 'A direction to explore'),
                      )}
                    </h4>
                    <span>{ui(tr('待验证的联想', 'Hypothesis'))}</span>
                  </div>
                  <p>{paper.hypothesis[language]}</p>
                  <div className="validation-step">
                    <span>{ui(tr('第一步', 'FIRST STEP'))}</span>
                    <p>{paper.validation[language]}</p>
                  </div>
                  <p className="crossover-caveat">
                    {ui(
                      tr(
                        '这是一条示例联想，并非论文已证明的结论；适用条件与已有工作仍需检查。',
                        'This is an illustrative hypothesis, not a conclusion established by the paper. Applicability and prior work still need checking.',
                      ),
                    )}
                  </p>
                </div>
                {renderFeedback(paper, 'connections')}
              </>
            ) : (
              <div className="no-connections">
                <Link2 size={22} />
                <p>
                  {ui(
                    tr(
                      '所选 Persona 范围内没有可用的材料联系。',
                      'No material connections are available within the selected Persona scope.',
                    ),
                  )}
                </p>
                <span>
                  {ui(
                    tr(
                      '不会使用其他标签补充，也不会生成默认评价。',
                      'Other tags will not be used to fill this gap, and no feedback is inferred.',
                    ),
                  )}
                </span>
              </div>
            )}
          </section>
        </div>
      </div>
    </article>
  ) : (
    <div className="paper-reader-placeholder">
      <FileText size={26} />
      <h2>{ui('选择一篇论文开始阅读')}</h2>
      <p>{ui('在这里阅读概览和完整报告。')}</p>
    </div>
  );
}
