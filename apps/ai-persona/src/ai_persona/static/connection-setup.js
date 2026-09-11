(() => {
  'use strict';
  const root = document.getElementById('connection-setup');
  if (!root) return;
  const text = (zh, en) => document.documentElement.lang === 'zh-CN' ? zh : en;
  const refresh = root.querySelector('[data-connection-refresh]');

  root.querySelectorAll('[data-copy-connection]').forEach(button => {
    const kind = button.dataset.copyConnection;
    const prompt = root.querySelector(`[data-connection-prompt="${kind}"]`);
    const feedback = root.querySelector(`[data-copy-feedback="${kind}"]`);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt.value);
        feedback.textContent = text('已复制，粘贴到 Codex 即可开始。', 'Copied. Paste into Codex to get started.');
      } catch {
        root.querySelector(`[data-prompt-preview="${kind}"]`).open = true;
        prompt.focus();
        prompt.select();
        feedback.textContent = text('无法自动复制，请复制下方已选中的指令。', 'Copy the selected instructions below; automatic copying is unavailable.');
      }
    });
  });

  const checks = {
    hook: ['/api/studio/integrations', value => {
      if (!Array.isArray(value.connections)) throw Error('Hook status');
      if (!value.connections.length) return ['todo', text('未接入', 'Not connected')];
      const active = value.connections.filter(item => item.enabled !== false);
      if (!active.length) return ['todo', text('未启用', 'Disabled')];
      return active.every(item => item.verified)
        ? ['done', text('已验证接入', 'Connection verified')]
        : ['waiting', text('待完成接入', 'Setup incomplete')];
    }],
    mcp: ['/api/studio/mcp-setup', value => {
      if (typeof value.configured !== 'boolean' || !('client_read' in value)) throw Error('MCP status');
      if (value.client_read) return ['done', text('已收到查询', 'Read received')];
      if (value.configured) return ['waiting', text('待实际查询', 'Awaiting a read')];
      return ['todo', text('未配置', 'Not configured')];
    }],
  };
  async function load() {
    if (refresh.disabled) return;
    refresh.disabled = true;
    await Promise.allSettled(Object.entries(checks).map(async ([kind, [url, describe]]) => {
      const status = root.querySelector(`[data-connection-status="${kind}"]`);
      try {
        const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
        if (!response.ok) throw Error('status unavailable');
        const [state, label] = describe(await response.json());
        status.dataset.state = state;
        status.textContent = label;
      } catch {
        status.dataset.state = 'unknown';
        status.textContent = text('状态暂不可读取', 'Status unavailable');
      }
    }));
    refresh.disabled = false;
  }
  refresh.addEventListener('click', load);
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  document.addEventListener('persona:connection-updated', load);
  load();
})();
