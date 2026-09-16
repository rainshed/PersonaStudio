import type { DailyItem, DailyRun } from './daily-api';

export const activeRun = (status: string) =>
  ['queued', 'running'].includes(status);
export function generationNotice(run: DailyRun, reused = false) {
  const batch = run.date ? `${run.date} 的日报` : '日报';
  const prefix = reused ? `已打开已有的${batch}。` : '';
  if (activeRun(run.status))
    return (
      prefix +
      (run.discovery
        ? '正在初筛论文，结果会陆续显示，离开页面后任务仍会继续。'
        : run.source?.kind === 'announcement_date'
          ? `正在检查 ${run.source.date} 的公告，请稍候。`
          : '正在检查最新公告，请稍候。')
    );
  if (run.status === 'completed')
    return prefix + `${batch}已完成，可查看推荐结果。`;
  if (run.status === 'cancelled')
    return prefix + '任务已取消。点击“继续未完成部分”后才会继续。';
  if (run.status === 'paused')
    return prefix + '任务因请求额度暂停，可调整额度后继续。';
  return (
    prefix +
    (run.error?.message ?? '任务未全部完成，请查看状态并重试未完成部分。')
  );
}

export function emptyDailyMessage(run: DailyRun, filter: string, query = '') {
  if (query)
    return {
      title: '没有匹配的论文',
      description: '请修改搜索词，或清空搜索查看本分类。',
    };
  if (activeRun(run.status) && !run.discovery)
    return {
      title:
        run.source?.kind === 'announcement_date'
          ? `正在读取 ${run.source.date} 的公告`
          : '正在读取最新公告',
      description: '正在核对公告日期与论文范围，候选数量尚未确定。',
    };
  if (run.status === 'cancelled')
    return {
      title: '本批任务已取消',
      description:
        '已完成内容仍可查看；未完成部分需要点击“继续未完成部分”后才会处理。',
    };
  if (['failed', 'interrupted', 'paused'].includes(run.status))
    return {
      title: '本批任务尚未完成',
      description: run.error?.message ?? run.message,
    };
  if (run.stats.total === 0)
    return {
      title: '本批没有符合订阅范围的候选',
      description: '本次公告读取已结束，可以查看公告来源与版本动态。',
    };
  if (filter === 'recommended' && activeRun(run.status))
    return {
      title: '正在筛选推荐论文',
      description: '推荐结果会陆续显示，无需等待全部完成。',
    };
  const titles: Record<string, string> = {
    followed_authors: '本批暂无关注作者的论文',
    recommended: '本批暂无推荐论文',
    not_recommended: '本批暂无未推荐论文',
    needs_confirmation: '本批没有关联待确认的论文',
    unscreened: '本批初筛已全部完成',
    pending: '本批没有待处理论文',
    excluded: '本批没有单列的版本动态',
  };
  return {
    title: titles[filter] ?? '本分类暂无论文',
    description: '可以切换分类查看其他论文。',
  };
}

export function detailStatus(status: string) {
  return (
    (
      {
        not_requested: '尚未请求详细分析',
        queued: '详细分析排队中',
        running: '正在详细分析',
        available: '详细报告已就绪',
        partial: '详细报告部分完成',
        failed: '详细分析失败',
        cancelled: '详细分析已取消',
        interrupted: '详细分析已中断',
      } as Record<string, string>
    )[status] ?? '尚未请求详细分析'
  );
}
export function screeningHeading(item: DailyItem) {
  if (item.excluded) return '版本变化';
  if (item.final_decision === 'recommended') return '推荐理由';
  if (item.final_decision === 'not_recommended') return '未推荐原因';
  return item.screening ? '关联待确认' : '初筛进度';
}

export function analysisDecisionNotice(item: DailyItem) {
  if (!item.analysis_decision) return null;
  const opinion = {
    recommended: '模型认为值得关注',
    not_recommended: '模型认为与当前研究范围关联较弱',
    undetermined: '模型尚不能确定相关性',
  }[item.analysis_decision];
  const location =
    item.final_decision === 'recommended'
      ? '已保留在推荐列表'
      : '保留初筛时的列表归属';
  return `全文补充意见：${opinion}。${location}。`;
}
