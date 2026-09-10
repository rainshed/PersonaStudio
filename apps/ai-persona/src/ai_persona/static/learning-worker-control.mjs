import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
// Backend state is authoritative; a successful POST only acknowledges a request.
export class LearningWorkerControl {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.worker = null;
    this.enabled = false;
    this.pending = null;
    this.busy = false;
  }

  update(config) {
    this.worker = config.worker;
    this.enabled = config.settings.enabled;
    if (!this.pending || this.busy) return;
    const {action, since} = this.pending;
    if ((action === 'start' && this.worker.running) ||
        (action === 'stop' && !this.worker.running)) {
      this.pending = null;
    } else if (action === 'start' && this.now() - since >= 15000) {
      this.pending = null;
      return ui('尚未确认后台启动成功，请检查状态后重试。');
    }
  }

  get transitioning() {
    return this.busy || Boolean(this.pending) || Boolean(this.worker?.stopping);
  }

  get view() {
    if (!this.worker) return {state:'unknown', status:ui('状态未知'), label:ui('读取状态中…'), disabled:true,
      hint:ui('暂时无法确认后台状态，请重新加载设置页面。')};
    if (this.pending?.action === 'start') return {state:'starting', status:ui('正在启动'), label:ui('正在启动…'), disabled:true,
      hint:ui('正在等待后台进程启动，确认运行后即可停止。')};
    if (this.pending?.action === 'stop' || this.worker.stopping) return {state:'stopping', status:ui('正在停止'), label:ui('正在停止…'), disabled:true,
      hint:ui('等待当前任务结束后退出；如需阻止当前任务送审，请在任务详情中取消它。')};
    if (this.worker.running) return {state:'running', status:ui('运行中'), label:ui('停止后台处理'), disabled:false,
      hint:ui('后台处理已开启；是否分析任务仍取决于采集、来源、模型开关与预算。关闭页面不影响后台运行。')};
    return {state:'stopped', status:ui('已停止'), label:ui('启动后台处理'), disabled:!this.enabled,
      hint:this.enabled?ui('后台不会处理新任务；启动后会继续处理队列中的任务。'):ui('请先启用并保存“对话采集”，再启动后台处理。')};
  }

  begin() {
    if (this.busy || this.view.disabled) return null;
    const action = this.worker.running ? 'stop' : 'start';
    this.pending = {action, since:this.now()};
    this.busy = true;
    return action;
  }

  finish() {
    this.busy = false;
  }

  unavailable() {
    this.worker = null;
  }

  failed() {
    this.busy = false;
    this.pending = null;
    this.unavailable();
  }
}
