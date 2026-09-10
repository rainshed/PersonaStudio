import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
export const errorHelp = {
  auth_required:ui('模型认证失效或无权限，请检查模型授权。'),not_configured:ui('尚未配置模型。'),
  timeout:ui('请求已超过等待时间。'),runtime_missing:ui('本机模型运行依赖缺失。'),runtime_unavailable:ui('本机模型服务不可用。'),
  connection_error:ui('连接模型失败。'),invalid_model_output:ui('模型输出未通过格式校验。'),
  incompatible:ui('提示词版本与当前程序不一致，请更新服务后重试。'),
  context_length:ui('输入超过本阶段预算。'),context_incomplete:ui('缺少相关记录。'),context_unavailable:ui('必要上下文不可用。'),
  stale_record:ui('Persona 已更新，需要重新分析。'),context_changed:ui('准备偏好时配置发生变化，本轮没有提供偏好。'),
  context_budget_exceeded:ui('完整偏好内容超过提供上限，本轮没有提供。'),empty_user_input:ui('未发现有效用户正文。'),
  disabled:ui('该能力或来源已关闭。'),context_path_rejected:ui('上下文路径不在允许范围。'),
};
export function runtimeSummary(value, names) {
  const runtime=value.runtime||{}, code=runtime.error_code||runtime.error?.code;
  const parts=[names[value.status]||value.status];
  if(runtime.stage)parts.push(runtime.stage);
  if(code)parts.push(errorHelp[code]||runtime.error?.message||ui('处理遇到异常，可展开技术详情查看。'));
  if(value.type==='learning') {
    if(value.triggered===true&&!value.review.total)parts.push(runtime.outcome==='ignored'?ui('进入学习后未形成新的候选。'):ui('本轮触发学习，但尚无可审核候选；触发判断仍可独立反馈。'));
    if(['queued','paused','paused_budget'].includes(value.status))parts.push(ui('请在来源与运行设置查看后台状态、开关及预算。'));
  }
  if(value.type==='activation')parts.push(value.status==='returned'?ui('偏好已提供给 Agent，不代表它实际遵循。'):value.status==='prepared'?ui('偏好已准备，尚未确认提供给 Agent。'):value.status==='failed'?ui('本轮没有提供偏好；若判定已完成，仍可独立反馈。'):'');
  return parts.filter(Boolean).join(' · ');
}
