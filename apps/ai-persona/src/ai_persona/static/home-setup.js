(() => {
  'use strict';
  const root = document.getElementById('home-setup');
  if (!root) return;
  const zh = document.documentElement.lang === 'zh-CN';
  const text = (cn, en) => zh ? cn : en;
  const details = document.getElementById('home-setup-details');
  const ready = document.getElementById('home-setup-ready');
  const toggle = document.getElementById('home-setup-toggle');
  const refresh = document.getElementById('home-setup-refresh');
  const progress = document.getElementById('home-setup-progress');
  const items = [...root.querySelectorAll('[data-setup-item]')];
  const states = new Map(items.map(item => [item.dataset.setupItem, 'checking']));
  let expanded = false;
  let loading = false;

  function render() {
    const values = [...states.values()];
    const count = values.filter(state => state === 'done').length;
    const complete = count === items.length;
    progress.textContent = values.includes('checking')
      ? text('正在检查设置…', 'Checking setup…')
      : text(`已完成 ${count} / 3 项`, `${count} / 3 complete`);
    ready.hidden = !complete;
    details.hidden = complete && !expanded;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
    toggle.textContent = expanded ? text('收起设置 ⌃', 'Hide setup ⌃') : text('查看设置 ⌄', 'View setup ⌄');
    let highlighted = false;
    for (const item of items) {
      const state = states.get(item.dataset.setupItem);
      const primary = !highlighted && ['todo', 'waiting'].includes(state);
      const action = item.querySelector('[data-setup-action]');
      action.classList.toggle('primary-button', primary);
      action.classList.toggle('ghost', !primary);
      if (primary) highlighted = true;
    }
  }

  function update(key, state, label, action) {
    states.set(key, state);
    const item = items.find(item => item.dataset.setupItem === key);
    const status = item.querySelector('[data-setup-status]');
    status.dataset.state = state;
    status.textContent = label;
    item.querySelector('[data-setup-action]').textContent = `${action} →`;
    render();
  }

  const checks = {
    model: ['/api/studio/readiness', value => {
      if (typeof value.ready !== 'boolean' || value.status === 'unavailable') throw new Error('model status');
      return value.ready
        ? ['done', text('✓ 已配置', '✓ Configured'), text('管理模型', 'Manage model')]
        : ['todo', text('未配置', 'Not configured'), text('设置模型', 'Set up model')];
    }],
    hook: ['/api/studio/integrations', value => {
      if (!Array.isArray(value.connections)) throw new Error('Hook status');
      if (!value.connections.length) return ['todo', text('未接入', 'Not connected'), text('设置 Hook', 'Set up Hook')];
      const active = value.connections.filter(connection => connection.enabled !== false);
      if (!active.length) return ['todo', text('未启用', 'Disabled'), text('管理 Hook', 'Manage Hook')];
      if (active.every(connection => connection.verified === true)) return ['done', text('✓ 已验证', '✓ Verified'), text('管理 Hook', 'Manage Hook')];
      return ['waiting', active.some(connection => connection.verified === true)
        ? text('部分已验证', 'Partially verified') : text('待完成接入', 'Setup incomplete'), text('继续设置', 'Continue setup')];
    }],
    mcp: ['/api/studio/mcp-setup', value => {
      if (!('client_read' in value) || typeof value.configured !== 'boolean') throw new Error('MCP status');
      if (value.client_read) return ['done', text('✓ 已收到查询', '✓ Read received'), text('管理 MCP', 'Manage MCP')];
      if (value.configured) return ['waiting', text('待实际查询', 'Awaiting a read'), text('测试 MCP', 'Test MCP')];
      return ['todo', text('未配置', 'Not configured'), text('配置 MCP', 'Set up MCP')];
    }],
  };

  async function load() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    await Promise.allSettled(Object.entries(checks).map(async ([key, [url, describe]]) => {
      try {
        const response = await fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(10000)});
        if (!response.ok) throw new Error('setup status');
        update(key, ...describe(await response.json()));
      } catch {
        update(key, 'unknown', text('状态暂不可读取', 'Status unavailable'), text('查看设置', 'View settings'));
      }
    }));
    loading = false;
    refresh.disabled = false;
  }

  toggle.addEventListener('click', () => { expanded = !expanded; render(); });
  refresh.hidden = false;
  refresh.addEventListener('click', load);
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  load();
})();
