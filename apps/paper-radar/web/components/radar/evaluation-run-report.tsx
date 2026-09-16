'use client';
import { useState } from 'react';
import type { EvaluationCase, EvaluationRun } from '@/lib/evaluation-api';
import {
  experimentName,
  outcome,
  ratio,
  statusLabels,
} from '@/lib/evaluation-display';
import { useUiLanguage } from './ui-language';
const pending = new Set(['queued', 'running']);
export function EvaluationRunReport({
  report,
  cases,
  onCancel,
  onResume,
  onApply,
  onOpen,
  busy = false,
}: {
  report: EvaluationRun;
  cases: EvaluationCase[];
  onCancel: () => void;
  onResume: (budget: { max_calls?: number; token_budget?: number }) => void;
  onApply: (candidateId: string, restore?: boolean) => void;
  onOpen: (c: EvaluationCase) => void;
  busy?: boolean;
}) {
  const { ui, locale, uiLanguage } = useUiLanguage();
  const [filter, setFilter] = useState('all');
  const [calls, setCalls] = useState('');
  const [tokens, setTokens] = useState('');
  const groups = [...new Set(report.items.map((i) => i.case_id))].map((id) => ({
    id,
    source: cases.find((c) => c.id === id),
    items: report.items.filter((i) => i.case_id === id),
    comparison: report.comparisons.find((c) => c.case_id === id),
  }));
  const shown = groups.filter(
    (g) =>
      filter === 'all' ||
      (filter === 'improvement' || filter === 'regression'
        ? g.comparison?.both_valid && g.comparison.change === filter
        : filter === 'failed'
          ? g.items.some(
              (i) => i.status !== 'completed' && !pending.has(i.status),
            )
          : g.items.some(
              (i) =>
                i.status === 'completed' &&
                i.outcome !== i.expected_outcome &&
                i.outcome ===
                  (filter === 'false_positive'
                    ? 'recommended'
                    : 'not_recommended'),
            )),
  );
  const improved = report.comparisons.filter(
    (c) => c.both_valid && c.change === 'improvement',
  ).length;
  const regressed = report.comparisons.filter(
    (c) => c.both_valid && c.change === 'regression',
  ).length;
  const completed = report.items.filter((i) => !pending.has(i.status)).length;
  return (
    <section className="evaluation-report">
      <div className="evaluation-section-title">
        <h3>{experimentName(report, uiLanguage)}</h3>
        <output className="evaluation-run-status">
          {ui(statusLabels[report.status] ?? report.status)}
        </output>
      </div>
      <p>
        {ui('进度')} {completed}/{report.items.length} ·{' '}
        {report.usage.input.toLocaleString(locale)} /{' '}
        {report.usage.output.toLocaleString(locale)} tokens · {ui('费用')}：
        {report.usage.cost === null ? ui('暂无费用记录') : report.usage.cost}
      </p>
      {pending.has(report.status) && (
        <>
          <progress
            value={completed}
            max={report.items.length || 1}
            aria-label={ui('实验进度')}
          />
          <button
            className="button-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {ui('取消实验')}
          </button>
        </>
      )}
      {report.status === 'failed' && report.actual_calls === 0 && (
        <p className="daily-notice">
          {ui(
            '本次未生成有效判断。可检查读取失败原因后，使用当前配置新建实验；已有样例无需重新标注。',
          )}
        </p>
      )}
      {report.error && (
        <p role="alert" className="daily-notice">
          {ui(report.error)}
        </p>
      )}
      {['paused', 'interrupted', 'cancelled'].includes(report.status) && (
        <div className="evaluation-resume">
          <div className="evaluation-filters">
            <label>
              {ui('新的执行次数上限')}
              <input
                type="number"
                min={report.actual_calls + 1}
                max={20000}
                value={calls}
                onChange={(e) => setCalls(e.target.value)}
                placeholder={String(report.max_calls)}
              />
            </label>
            <label>
              {ui('新的 Token 预算')}
              <input
                type="number"
                min={1}
                max={2000000000}
                value={tokens}
                onChange={(e) => setTokens(e.target.value)}
              />
            </label>
          </div>
          <button
            className="button-secondary"
            disabled={busy}
            onClick={() =>
              onResume({
                ...(calls ? { max_calls: Number(calls) } : {}),
                ...(tokens ? { token_budget: Number(tokens) } : {}),
              })
            }
          >
            {ui('继续未执行的样本')}
          </button>
        </div>
      )}
      <div className="evaluation-score-grid">
        {report.candidates.map((c) => {
          const score = report.scores[c.id];
          const items = report.items.filter((i) => i.candidate_id === c.id);
          const failures = items.filter(
            (i) => i.status !== 'completed' && !pending.has(i.status),
          ).length;
          const usage = report.candidate_usage?.[c.id];
          return (
            <article key={c.id} className="evaluation-score-card">
              <h4>{ui(c.id === 'A' ? '当前配置' : '实验配置')}</h4>
              <p>
                {c.backend ?? ''} · {c.model.modelId} ·{' '}
                {c.model.reasoningEffort ?? ui('模型默认')}
              </p>
              {c.task_models &&
                Object.entries(c.task_models).map(([task, model]) => (
                  <p key={task}>
                    {ui(task === 'single' ? '单篇分析' : '每日初筛')}：
                    {model.modelId} · {model.reasoningEffort ?? ui('模型默认')}
                  </p>
                ))}
              <strong>
                {score.accuracy.value === null
                  ? ui('暂无结果')
                  : `${(score.accuracy.value * 100).toFixed(1)}%`}
              </strong>
              <span>
                {ui('与用户答案一致')} · {score.correct}/{score.valid}
              </span>
              <dl>
                <div>
                  <dt>{ui('成功评测')}</dt>
                  <dd>
                    {score.valid}/{score.total}
                  </dd>
                </div>
                <div>
                  <dt>{ui('误推荐')}</dt>
                  <dd>{score.FP}</dd>
                </div>
                <div>
                  <dt>{ui('漏推荐')}</dt>
                  <dd>{score.FN}</dd>
                </div>
                <div>
                  <dt>{ui('未完成判断')}</dt>
                  <dd>{failures}</dd>
                </div>
                <div>
                  <dt>{ui('执行耗时')}</dt>
                  <dd>
                    {(
                      items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0) /
                      1000
                    ).toFixed(1)}
                    s
                  </dd>
                </div>
              </dl>
              <details>
                <summary>{ui('统计与配置详情')}</summary>
                <p>
                  {ui('有效判断一致率')}：{ratio(score.accuracy)}
                </p>
                <p>
                  {ui('有效判断数量')}：{score.valid}/{score.total}
                </p>
                <p>
                  {ui('费用')}：
                  {usage?.cost == null ? ui('暂无费用记录') : usage.cost}
                </p>
                <p>
                  {ui('提示词快照')}：{c.prompt_version}
                </p>
                {c.prompt_fields?.map((p) => (
                  <details key={p.id}>
                    <summary>{ui(p.name)}</summary>
                    <pre>{Object.values(p.templates).join('\n\n')}</pre>
                  </details>
                ))}
              </details>
              {report.status === 'completed' && c.experimental && (
                <button
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => onApply(c.id)}
                >
                  {ui('查看并应用此配置')}
                </button>
              )}
            </article>
          );
        })}
      </div>
      <p className="evaluation-metric-note">
        {ui(
          '一致率只计算成功得到推荐判断的样例；未完成判断单独列出，不计为误推荐或漏推荐。',
        )}
      </p>
      {report.application && (
        <div className="daily-success">
          <span>
            {ui(
              report.application.restored_at
                ? '已恢复应用前配置'
                : '已应用配置',
            )}{' '}
            {report.application.candidate_id}
          </span>
          {!report.application.restored_at && (
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => onApply(report.application!.candidate_id, true)}
            >
              {ui('恢复应用前配置')}
            </button>
          )}
        </div>
      )}
      <div className="evaluation-section-title">
        <h3>{ui('逐篇比较')}</h3>
        <span>
          {ui('改善')} {improved} · {ui('退步')} {regressed}
        </span>
      </div>
      <div className="evaluation-filters">
        <select
          aria-label={ui('筛选实验结果')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {[
            ['all', '全部结果'],
            ['improvement', '改善的论文'],
            ['regression', '退步的论文'],
            ['false_positive', '误推荐'],
            ['false_negative', '漏推荐'],
            ['failed', '未完成判断'],
          ].map(([id, title]) => (
            <option value={id} key={id}>
              {ui(title)}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && (
        <p className="research-empty">{ui('暂无符合条件的结果')}</p>
      )}
      <div className="evaluation-comparisons">
        {shown.map((group) => (
          <article key={group.id}>
            <div className="evaluation-case-heading">
              <button
                className="evaluation-paper-link"
                disabled={!group.source || group.source.state === 'deleted'}
                onClick={() => group.source && onOpen(group.source)}
              >
                {group.source?.source.paper.title || ui('已删除的论文')}
              </button>
              <span
                className={
                  'evaluation-answer ' + group.items[0].expected_outcome
                }
              >
                {ui('用户答案')}：{ui(outcome(group.items[0].expected_outcome))}
              </span>
            </div>
            <div className="evaluation-config-grid">
              {group.items.map((item) => (
                <div key={item.id}>
                  <h4>
                    {ui(item.candidate_id === 'A' ? '当前配置' : '实验配置')}
                  </h4>
                  <p>
                    {ui(
                      item.status === 'completed'
                        ? outcome(item.outcome)
                        : (statusLabels[item.status] ?? item.status),
                    )}
                    {item.status === 'completed' && (
                      <span
                        className={
                          item.outcome === item.expected_outcome
                            ? 'evaluation-correct'
                            : 'evaluation-wrong'
                        }
                      >
                        {' '}
                        ·{' '}
                        {ui(
                          item.outcome === item.expected_outcome
                            ? '符合预期'
                            : item.outcome === 'recommended'
                              ? '误推荐'
                              : '漏推荐',
                        )}
                      </span>
                    )}
                  </p>
                  {item.error && (
                    <p className="daily-notice">{ui(item.error.message)}</p>
                  )}
                  {item.output?.reason && (
                    <details>
                      <summary>{ui('查看判断理由')}</summary>
                      <p>{item.output.reason}</p>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
