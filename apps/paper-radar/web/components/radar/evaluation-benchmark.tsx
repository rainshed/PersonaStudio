'use client';
import { experimentName } from '@/lib/evaluation-display';
import { browserRequestId } from '@/lib/backend-response';
import { useEffect, useState } from 'react';
import { RefreshCw, BookOpen, FlaskConical, Trash2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import type { RadarLocation } from '@/lib/radar-location';
import {
  evaluationApi,
  evaluationWrite,
  type EvaluationCase,
  type EvaluationSuite,
  type EvaluationRun,
  type ExperimentDraft,
  type ApplicationPreview,
} from '@/lib/evaluation-api';
import { useUiLanguage } from './ui-language';
import { statusLabels } from '@/lib/evaluation-display';
import { EvaluationRunReport } from './evaluation-run-report';
import { EvaluationExperiment } from './evaluation-experiment';
import './evaluation-workspace.css';

export function EvaluationBenchmark({
  onOpen,
}: {
  onOpen: (route: Partial<RadarLocation>) => void;
}) {
  const { ui, locale, uiLanguage } = useUiLanguage();
  const [tab, setTab] = useState('dataset');
  const [cases, setCases] = useState<EvaluationCase[]>([]);
  const [dataset, setDataset] = useState<EvaluationCase[]>([]);
  const [suite, setSuite] = useState<EvaluationSuite | null>(null);
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [drafts, setDrafts] = useState<ExperimentDraft[]>([]);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState('');
  const [report, setReport] = useState<EvaluationRun | null>(null);
  const [experiment, setExperiment] = useState<{
    draft?: ExperimentDraft;
  } | null>(null);
  const [application, setApplication] = useState<ApplicationPreview | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const init = { signal: controller.signal };
    Promise.all([
      evaluationApi<{ items: EvaluationCase[]; suite: EvaluationSuite }>(
        'dataset',
        init,
      ),
      evaluationApi<{ items: EvaluationCase[] }>('cases', init),
      evaluationApi<{ items: EvaluationRun[] }>('runs', init),
      evaluationApi<{ items: ExperimentDraft[] }>('drafts', init),
    ])
      .then(([d, c, r, f]) => {
        if (controller.signal.aborted) return;
        setDataset(d.items);
        setSuite(d.suite);
        setCases(c.items);
        setRuns(r.items);
        setDrafts(f.items);
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [tick]);
  useEffect(() => {
    if (!report || !['queued', 'running'].includes(report.status)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      evaluationApi<EvaluationRun>('runs/' + report.id, {
        signal: controller.signal,
      })
        .then((r) => {
          if (!controller.signal.aborted) {
            setReport(r);
            if (!['queued', 'running'].includes(r.status))
              setTick((v) => v + 1);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [report, tick]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setTick((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求未完成。');
    } finally {
      setBusy(false);
    }
  };
  const openPaper = (c: EvaluationCase) =>
    c.source.kind === 'analysis'
      ? onOpen({ view: 'single', job: c.source.job_id })
      : onOpen({
          view: 'daily',
          subscription: c.source.subscription_id,
          run: c.source.run_id,
          date: c.source.date,
          paper: c.source.item_id,
          filter: c.original_outcome,
        });
  const showReport = (r: EvaluationRun) => {
    setReport(r);
    setApplication(null);
    setExperiment(null);
    setTab('runs');
    setTick((v) => v + 1);
  };
  const startExperiment = (draft?: ExperimentDraft) => {
    setExperiment({ draft });
    setReport(null);
    setApplication(null);
    setTab('runs');
  };
  const shown = dataset.filter(
    (c) =>
      (!label || c.expected_outcome === label) &&
      (!scope || c.source.scope_key === scope),
  );
  const scopes = [
    ...new Map(
      dataset.map((c) => [
        c.source.scope_key ?? '',
        c.source.scope_name ?? c.source.subscription.name,
      ]),
    ).entries(),
  ];
  const selectedScope = scope || (scopes.length === 1 ? scopes[0][0] : '');
  const experimentSuite = suite
    ? {
        ...suite,
        scope_key: selectedScope,
        scope_name: scopes.find(([key]) => key === selectedScope)?.[1],
        members: suite.members.filter((m) =>
          dataset.some(
            (c) => c.id === m.case_id && c.source.scope_key === selectedScope,
          ),
        ),
      }
    : null;
  const positive = dataset.filter(
    (c) => c.expected_outcome === 'recommended',
  ).length;
  return (
    <div className="evaluation-hub">
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList
          variant="line"
          className="evaluation-tabs"
          aria-label={ui('评测分类')}
        >
          <TabsTrigger value="dataset">
            {ui('测试集')}
            <span>{dataset.length}</span>
          </TabsTrigger>
          <TabsTrigger value="runs">
            {ui('实验记录')}
            <span>{runs.length}</span>
          </TabsTrigger>
        </TabsList>
        <div className="evaluation-status">
          {error && (
            <p className="daily-notice" role="alert">
              {ui(error)}{' '}
              <button
                onClick={() => {
                  setError('');
                  setTick((v) => v + 1);
                }}
              >
                {ui('重试')}
              </button>
            </p>
          )}
          {notice && <output className="daily-success">{ui(notice)}</output>}
          {loading && <output>{ui('正在读取…')}</output>}
        </div>
        <TabsContent value="dataset">
          <div className="evaluation-section-title">
            <div>
              <h2>{ui('我的推荐测试集')}</h2>
              <p>
                {dataset.length} {ui('篇论文')} · {ui('应该推荐')} {positive} ·{' '}
                {ui('不该推荐')} {dataset.length - positive}
              </p>
            </div>
            <div className="evaluation-actions">
              <button
                className="button-secondary"
                aria-label={ui('刷新测试集')}
                disabled={busy}
                onClick={() => setTick((v) => v + 1)}
              >
                <RefreshCw size={16} />
              </button>
              <button
                className="button-primary"
                disabled={busy || !dataset.length || !selectedScope}
                onClick={() => startExperiment()}
              >
                {ui('开始实验')}
              </button>
            </div>
          </div>
          <p>
            {ui(
              '阅读时的推荐反馈会自动加入这里，同一论文与兴趣范围以最近一次反馈为准。',
            )}
          </p>
          <div className="evaluation-filters">
            <select
              aria-label={ui('正确答案')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            >
              <option value="">{ui('全部答案')}</option>
              <option value="recommended">{ui('应该推荐')}</option>
              <option value="not_recommended">{ui('不该推荐')}</option>
            </select>
            {scopes.length > 1 && (
              <select
                aria-label={ui('兴趣范围')}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="">{ui('全部兴趣范围')}</option>
                {scopes.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p>{ui('评测使用当前配置与知识库，按相同 tag 范围重新分析论文。')}</p>
          {scopes.length > 1 && !selectedScope && (
            <p>{ui('开始实验前，请选择一个 tag 范围。')}</p>
          )}
          {!loading && !shown.length && (
            <div className="research-empty">
              <BookOpen size={25} />
              <h3>
                {ui(dataset.length ? '暂无符合条件的论文' : '还没有测试样例')}
              </h3>
              <p>{ui('在每日论文或单篇分析中，对推荐判断点满意或不满意。')}</p>
              <button
                className="button-secondary"
                onClick={() => onOpen({ view: 'daily' })}
              >
                {ui('查看论文')}
              </button>
            </div>
          )}
          {shown.length > 0 && (
            <div className="evaluation-table-wrap">
              <table className="evaluation-dataset-table">
                <thead>
                  <tr>
                    <th>{ui('论文 / arXiv 链接')}</th>
                    <th>{ui('正确答案')}</th>
                    <th>
                      <span className="sr-only">{ui('操作')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <button
                          className="evaluation-paper-link"
                          onClick={() => openPaper(c)}
                        >
                          {c.source.paper.title}
                        </button>
                        <a
                          href={
                            'https://arxiv.org/abs/' +
                            c.source.paper.id.replace(/v\d+$/, '') +
                            (c.source.paper.version
                              ? 'v' + c.source.paper.version
                              : '')
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          arXiv:{c.source.paper.id} ↗
                        </a>
                        <small>
                          {ui(
                            c.source.kind === 'analysis'
                              ? '来自单篇分析'
                              : '来自每日论文',
                          )}{' '}
                          · {c.source.scope_name ?? c.source.subscription.name}
                        </small>
                      </td>
                      <td>
                        <select
                          aria-label={
                            c.source.paper.title + ' ' + ui('正确答案')
                          }
                          disabled={busy}
                          value={c.expected_outcome}
                          onChange={(e) => {
                            const expected_outcome = e.target.value;
                            void act(async () => {
                              await evaluationWrite(
                                'cases/' + c.id + '/answer',
                                {
                                  expected_outcome,
                                  expected_feedback_revision:
                                    c.feedback_revision,
                                  idempotency_key: browserRequestId(),
                                },
                                'PUT',
                              );
                              setNotice('正确答案已更新。');
                            });
                          }}
                        >
                          <option value="recommended">{ui('应该推荐')}</option>
                          <option value="not_recommended">
                            {ui('不该推荐')}
                          </option>
                        </select>
                      </td>
                      <td>
                        <button
                          className="evaluation-text-button"
                          aria-label={
                            ui('从测试集移除') + ' ' + c.source.paper.title
                          }
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await evaluationWrite(
                                'subjects/' + c.source.version_id + '/feedback',
                                {
                                  expected_feedback_revision:
                                    c.feedback_revision,
                                  idempotency_key: browserRequestId(),
                                },
                                'DELETE',
                              );
                              setNotice('已移出测试集，可在阅读时重新反馈。');
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="runs">
          <div className="evaluation-section-title">
            <div>
              <h2>{ui('实验记录')}</h2>
              <p>
                {ui('比较当前配置与实验配置，查看误推荐、漏推荐和逐篇变化。')}
              </p>
            </div>
            <button
              className="button-secondary"
              disabled={busy || !dataset.length || !selectedScope}
              onClick={() => startExperiment()}
            >
              {ui('开始实验')}
            </button>
          </div>
          {drafts.length > 0 && (
            <details>
              <summary>
                {ui('已保存的实验草稿')} · {drafts.length}
              </summary>
              {drafts.map((d) => (
                <div className="evaluation-draft-row" key={d.id}>
                  <span>{experimentName(d, uiLanguage)}</span>
                  <button
                    className="button-secondary"
                    onClick={() => startExperiment(d)}
                  >
                    {ui('继续编辑')}
                  </button>
                </div>
              ))}
            </details>
          )}
          {scopes.length > 1 && (
            <label className="evaluation-field">
              {ui('兴趣范围')}
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setExperiment(null);
                }}
              >
                <option value="">{ui('选择 tag 范围')}</option>
                {scopes.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {experiment && experimentSuite && selectedScope && (
            <EvaluationExperiment
              key={(experiment.draft?.id ?? 'new') + selectedScope}
              suite={experimentSuite}
              draft={experiment.draft}
              onClose={() => setExperiment(null)}
              onSaved={() => setTick((v) => v + 1)}
              onRun={showReport}
            />
          )}
          {!experiment && !runs.length && !loading && (
            <div className="research-empty">
              <FlaskConical size={25} />
              <h3>{ui('还没有实验记录')}</h3>
              <p>{ui('尝试新的提示词、模型、思考强度或 Agent。')}</p>
            </div>
          )}
          {runs.length > 0 && (
            <label className="evaluation-field">
              {ui('历史实验')}
              <select
                value={report?.id ?? ''}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id)
                    void act(async () => {
                      setReport(
                        await evaluationApi<EvaluationRun>('runs/' + id),
                      );
                      setApplication(null);
                    });
                }}
              >
                <option value="">{ui('选择实验查看结果')}</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {experimentName(r, uiLanguage)} ·{' '}
                    {new Date(r.created_at).toLocaleString(locale)} ·{' '}
                    {ui(statusLabels[r.status] ?? r.status)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {report && (
            <EvaluationRunReport
              report={report}
              cases={cases}
              busy={busy}
              onOpen={openPaper}
              onCancel={() =>
                void act(async () => {
                  setReport(
                    await evaluationWrite<EvaluationRun>(
                      'runs/' + report.id + '/cancel',
                    ),
                  );
                })
              }
              onResume={(budget) =>
                void act(async () => {
                  setReport(
                    await evaluationWrite<EvaluationRun>(
                      'runs/' + report.id + '/resume',
                      budget,
                    ),
                  );
                })
              }
              onApply={(candidateId, restore) =>
                void act(async () => {
                  setApplication(
                    await evaluationWrite<ApplicationPreview>(
                      'runs/' + report.id + '/apply-preview',
                      { candidate_id: candidateId, restore },
                    ),
                  );
                })
              }
            />
          )}
          {application && report && (
            <section
              className="evaluation-application"
              aria-label={ui('确认应用配置')}
            >
              <h3>
                {ui(application.restore ? '恢复应用前配置' : '应用到推荐设置')}
              </h3>
              <p>
                {application.from_model?.modelId} (
                {application.from_model?.reasoningEffort ?? ui('默认')}) →{' '}
                {application.to_model?.modelId} (
                {application.to_model?.reasoningEffort ?? ui('默认')})
              </p>
              {application.from_backend !== application.to_backend && (
                <p className="daily-notice">
                  {ui('分析宿主将切换为')} {application.to_backend}。
                  {ui('当前应用共用分析宿主，这会影响之后的其他分析任务。')}
                </p>
              )}
              <p>
                {ui('将更新的提示词')}：
                {application.prompts.length
                  ? application.prompts
                      .map((p) => ui(p.name))
                      .join(uiLanguage === 'zh' ? '、' : ', ')
                  : ui('无')}
              </p>
              {application.prompts.some((p) => p.shared) && (
                <p>{ui('共用规则也会影响使用该语言的其他任务。')}</p>
              )}
              {application.prompts.map((p) => (
                <details key={p.id}>
                  <summary>{ui(p.name)}</summary>
                  <div className="evaluation-config-grid">
                    <div>
                      <h4>{ui('当前内容')}</h4>
                      <pre>{Object.values(p.before).join('\n\n')}</pre>
                    </div>
                    <div>
                      <h4>{ui('应用后内容')}</h4>
                      <pre>{Object.values(p.after).join('\n\n')}</pre>
                    </div>
                  </div>
                </details>
              ))}
              <div className="evaluation-actions">
                <button
                  className="button-primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setReport(
                        await evaluationWrite<EvaluationRun>(
                          'runs/' + report.id + '/apply',
                          { token: application.token },
                        ),
                      );
                      setApplication(null);
                      setNotice('配置已更新，之后的新任务会使用新设置。');
                    })
                  }
                >
                  {ui(application.restore ? '确认恢复' : '确认应用')}
                </button>
                <button
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => setApplication(null)}
                >
                  {ui('取消')}
                </button>
              </div>
            </section>
          )}
        </TabsContent>
      </Tabs>
      <details className="evaluation-backup">
        <summary>{ui('数据管理')}</summary>
        <div className="evaluation-actions">
          <button
            className="button-secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await evaluationWrite<{ imported: number }>(
                  'imports/legacy-feedback',
                );
                setNotice(`已收集 ${r.imported} 条历史反馈。`);
              })
            }
          >
            {ui('收集历史推荐反馈')}
          </button>
          <button
            className="button-secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const data = await evaluationWrite('exports');
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(data, null, 2)], {
                    type: 'application/json',
                  }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = 'paper-radar-evaluations.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            {ui('导出备份')}
          </button>
          <label>
            {ui('导入备份')}
            <input
              type="file"
              accept=".json"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void act(async () => {
                    if (file.size > 50000000)
                      throw new Error('备份文件不能超过 50 MB。');
                    await evaluationWrite(
                      'imports',
                      JSON.parse(await file.text()),
                    );
                    setNotice('备份已导入。');
                  });
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </details>
    </div>
  );
}
