import { translateUi } from './ui-messages.ts';
import type { UiLanguage } from './ui-language.ts';
import type { Ratio } from './evaluation-api';
export const outcome = (v: string | null) =>
  v === 'recommended'
    ? '应该推荐'
    : v === 'not_recommended'
      ? '不该推荐'
      : '尚无明确判断';
export const statusLabels: Record<string, string> = {
  queued: '等待执行',
  running: '运行中',
  completed: '完成',
  partial: '部分完成',
  failed: '未能完成评测',
  input_failed: '论文或知识库读取失败',
  cancelled: '已取消',
  interrupted: '已中断',
  paused: '已暂停',
  imported: '导入的历史报告',
  needs_fulltext: '需要全文确认',
  input_missing: '缺少回放输入',
  input_unavailable: '缺少候选需要的冻结材料',
  request_failed: '模型请求失败',
  validation_failed: '输出校验失败',
  result_unknown: '调用结果未知',
  connection_changed: '模型连接已改变',
  withdrawn: '已撤销',
  timeout: '超时',
  active: '有效',
  deleted: '已删除',
  ready: '可以回放',
};
export const ratio = (r: Ratio) =>
  `${r.numerator}/${r.denominator} · ${r.value === null ? 'N/A' : (r.value * 100).toFixed(1) + '%'}`;

export const DEFAULT_EXPERIMENT_NAME = '我的推荐测试集 · 新实验';

export function experimentName(
  value: { name?: string; name_is_default?: boolean; title?: string },
  language: UiLanguage,
) {
  if (value.name_is_default)
    return translateUi(DEFAULT_EXPERIMENT_NAME, language);
  return (
    value.name ||
    (value.title && value.title !== '个人已评价样例表现'
      ? value.title
      : translateUi('个人已评价样例表现', language))
  );
}
