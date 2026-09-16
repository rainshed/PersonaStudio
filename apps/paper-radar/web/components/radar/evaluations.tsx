'use client';
import type { Feedback, FeedbackDimension } from '@/lib/radar';
import type { RadarLocation } from '@/lib/radar-location';
import { useUiLanguage } from './ui-language';
import { EvaluationBenchmark } from './evaluation-benchmark';

export type ResearchFeedback = {
  kind: 'analysis' | 'screening';
  version_id: string;
  job_id: string | null;
  item_id: string | null;
  run_id: string | null;
  subscription_id: string | null;
  date: string | null;
  title: string;
  paper_id: string;
  dimension: FeedbackDimension;
  feedback: Feedback;
  updated_at: string;
  expected_outcome?: 'recommended' | 'not_recommended';
};
export function EvaluationsPage({
  onOpen,
  demoItems,
}: {
  onOpen: (route: Partial<RadarLocation>) => void;
  demoItems?: ResearchFeedback[];
}) {
  const { ui } = useUiLanguage();
  return (
    <div className="evaluation-workspace">
      <div className="page-heading">
        <div>
          <h1>{ui('评测与反馈')}</h1>
          <p>
            {ui(
              '阅读反馈自动成为测试答案，用同一测试集比较新的提示词和模型配置。',
            )}
          </p>
        </div>
      </div>
      {demoItems ? (
        <section className="evaluation-feedback">
          <h2>{ui('我的推荐测试集')}</h2>
          <p>{ui('演示反馈保存在当前浏览器。连接本机服务后可以运行实验。')}</p>
          {!demoItems.some((row) => row.dimension === 'accuracy') && (
            <p>{ui('暂无符合条件的反馈')}</p>
          )}
          {demoItems
            .filter((row) => row.dimension === 'accuracy')
            .map((row) => (
              <article key={row.version_id}>
                <h3>{row.title}</h3>
                <p>
                  {ui(
                    row.expected_outcome === 'recommended'
                      ? '应该推荐'
                      : row.expected_outcome === 'not_recommended'
                        ? '不该推荐'
                        : '暂无正确答案',
                  )}
                </p>
                <a
                  href={'https://arxiv.org/abs/' + row.paper_id}
                  target="_blank"
                  rel="noreferrer"
                >
                  arXiv:{row.paper_id} ↗
                </a>
                {row.feedback.reason && <p>{row.feedback.reason}</p>}
              </article>
            ))}
        </section>
      ) : (
        <EvaluationBenchmark onOpen={onOpen} />
      )}
    </div>
  );
}
