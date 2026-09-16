import { translateUi } from './ui-messages.ts';
import type { UiLanguage } from './ui-language.ts';
export type TaskNotification = {
  id: number;
  kind: 'analysis' | 'daily' | 'discussion' | 'evaluation';
  task_id: string;
  target_id: string;
  title: string;
  title_is_default?: boolean;
  status: string;
  created_at: string;
  read_at: string | null;
  href: string;
};
export type NotificationPage = {
  items: TaskNotification[];
  unread_count: number;
  latest_id: number;
  cursor: number;
  next_before: number | null;
};
export function notificationLabel(
  item: Pick<TaskNotification, 'kind' | 'status'>,
) {
  const kind = {
    analysis: '论文分析',
    evaluation: '推荐评测',
    daily: '每日初筛',
    discussion: '论文讨论',
  }[item.kind];
  const status =
    (
      {
        succeeded: '已完成',
        completed: '已完成',
        partial: '部分完成',
        failed: '失败',
        interrupted: '已中断',
        paused: '已暂停',
        cancelled: '已取消',
      } as Record<string, string>
    )[item.status] ?? '任务已更新';
  return { kind, status };
}

export function notificationTitle(
  item: TaskNotification,
  language: UiLanguage,
) {
  return item.title_is_default
    ? translateUi('我的推荐测试集', language)
    : item.title || translateUi(notificationLabel(item).kind, language);
}
