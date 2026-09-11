(() => {
  const root = document.getElementById('persona-home');
  if (!root) return;
  const zh = document.documentElement.lang === 'zh-CN';
  const expand = document.getElementById('home-expand-changes');
  const extra = document.getElementById('home-extra-changes');
  if (expand && extra) {
    extra.hidden = true;
    expand.hidden = false;
    expand.addEventListener('click', () => {
      extra.hidden = !extra.hidden;
      expand.setAttribute('aria-expanded', String(!extra.hidden));
      expand.textContent = extra.hidden ? expand.dataset.expandLabel + ' ⌄' : expand.dataset.collapseLabel + ' ⌃';
    });
  }

  const panel = document.getElementById('home-runtime-issue');
  const message = document.getElementById('home-runtime-message');
  const runtime = document.getElementById('home-runtime');
  const label = document.getElementById('home-runtime-label');
  if (!panel || !message || !runtime || !label) return;
  const text = (cn, en) => zh ? cn : en;
  function show(status, state, notice = '') {
    label.textContent = status;
    runtime.dataset.state = state;
    message.textContent = notice;
    panel.hidden = !notice;
  }

  fetch('/api/studio/v1/health', {cache: 'no-store', signal: AbortSignal.timeout(10000)})
    .then(response => { if (!response.ok) throw new Error('health'); return response.json(); })
    .then(value => {
      const learning = value.learning;
      if (!learning || !Array.isArray(value.warnings)) throw new Error('health schema');
      let status, state = 'idle', notice = '';
      if (!learning.enabled) {
        status = text('对话学习未启用', 'Conversation learning is disabled');
      } else if (!learning.allow_model_calls) {
        status = text('对话学习已暂停模型调用', 'Learning model calls are paused');
      } else if (learning.worker_stopping) {
        status = text('对话学习后台正在停止', 'Learning worker is stopping');
      } else if (value.waiting_for_worker > 0) {
        status = text('对话学习任务正在等待', 'Learning tasks are waiting');
        state = 'attention';
        notice = text(`对话学习后台已停止，${value.waiting_for_worker} 条任务正在等待。`, `The learning worker is stopped; ${value.waiting_for_worker} tasks are waiting.`);
      } else if (learning.worker_running) {
        status = text('对话学习后台运行中', 'Learning worker is running');
        state = 'running';
      } else {
        status = text('对话学习后台未运行', 'Learning worker is not running');
      }
      // Historical failures stay in activity records; they are not current health.
      if (value.warnings.length) {
        notice += (notice ? ' ' : '') + text('部分运行记录暂不可读取，可在运行记录中查看详情。', 'Some activity records are unavailable. See activity records for details.');
        state = 'attention';
      }
      show(status, state, notice);
    })
    .catch(() => show(
      text('运行状态暂不可读取', 'Runtime status unavailable'), 'unknown',
      text('暂时无法获取运行状态，请稍后重试或查看运行设置。', 'Runtime status is unavailable. Try again later or check runtime settings.'),
    ));
})();
