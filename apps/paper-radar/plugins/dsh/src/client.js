/* DSH browser package: uses the host's React and keyed tool-card slot. */
window.__ModuleLoader__.load({ id: 'paper-radar-dsh-plugin', factory(require) {
  const React = require('react');
  const h = React.createElement;
  const labels = { queued: '等待执行', running: '处理中', completed: '已完成', succeeded: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '已中断', available: '可查看', partial: '部分完成' };
  function Card({ block, request }) {
    const original = block.meta ?? null;
    const [value, setValue] = React.useState(original), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const pending = React.useRef(null);
    React.useEffect(() => { setValue(original); }, [original]);
    const card = value?.card;
    const refresh = React.useCallback(async () => {
      if (!card) return;
      const result = await request({ operation: card.kind, id: card.id });
      setValue(result); setError('');
    }, [card?.kind, card?.id, request]);
    React.useEffect(() => {
      if (!card || !['queued', 'running'].includes(card.status)) return;
      const timer = setInterval(() => refresh().catch((e) => setError(e.message)), 4000);
      return () => clearInterval(timer);
    }, [card?.status, refresh]);
    async function act(action) {
      if (busy) return;
      setBusy(true); setError('');
      const fingerprint = JSON.stringify(action);
      if (!pending.current || pending.current.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
      try {
        const result = await request({ ...action, request_id: pending.current.key });
        pending.current = null;
        if (result.card) setValue(result); else await refresh();
      } catch (e) { setError(e.message); }
      finally { setBusy(false); }
    }
    const buttonStyle = { border: '1px solid #8b95a555', padding: '6px 12px', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' };
    if (!card) {
      const data = value?.data ?? value ?? {};
      const collection = ['jobs', 'reports', 'runs', 'items', 'results', 'subscriptions'].find((key) => Array.isArray(data[key]));
      const kind = { jobs: 'job', reports: 'report', runs: 'run', items: 'item', results: 'analysis' }[collection];
      let args = {};
      try { args = JSON.parse(block.call?.argsRaw ?? block.argsRaw ?? '{}'); } catch {}
      const next = value?.next_offset ?? data.next_offset;
      return h('section', { style: { padding: 14, fontSize: 14, lineHeight: 1.6 } },
        h('strong', null, 'PaperRadar'),
        !value ? h('p', { role: block.isError ? 'alert' : undefined }, block.isError ? (block.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').slice(0, 1800) || 'PaperRadar 操作未完成，请检查连接或原任务。' : '正在查询 PaperRadar…') : collection ? h('div', null,
          ...data[collection].map((item) => h('div', { key: item.id, style: { padding: '8px 0', borderBottom: '1px solid #8b95a533' } },
            h('span', null, item.paper?.title ?? item.subscription?.name ?? item.title ?? item.name ?? item.id),
            item.status && h('span', { style: { marginLeft: 10 } }, labels[item.status] ?? item.status),
            kind && h('button', { style: { ...buttonStyle, marginLeft: 10 }, onClick: () => request({ operation: kind, id: item.id }).then(setValue).catch((e) => setError(e.message)) }, '查看'))),
          !data[collection].length && h('p', null, '此范围暂无记录。'),
          next != null && h('button', { style: buttonStyle, onClick: () => request({ ...args, query: { ...args.query, offset: next } }).then(setValue).catch((e) => setError(e.message)) }, '下一页'))
          : h('p', null, data.connected === false ? data.error?.message ?? 'DSH 暂不可用' : data.text ?? data.message ?? (data.catalog ? `已连接 ${data.catalog.groups.length} 个宿主模型平台。任务模型与思考强度可在 PaperRadar 模型设置中选择。` : '已读取 PaperRadar 内容。')),
        data.settingsUrl && h('a', { href: data.settingsUrl, target: '_blank', rel: 'noreferrer' }, '打开设置 ↗'),
        error && h('p', { role: 'alert' }, error));
    }
    const data = value.data ?? {};
    return h('section', { style: { padding: 16, border: '1px solid #8b95a555', borderRadius: 10, fontSize: 14, lineHeight: 1.6 } },
      h('strong', null, card.title), h('div', null, labels[card.status] ?? card.status, card.stage ? ` · ${card.stage}` : ''),
      h('small', { style: { opacity: .7 } }, `${card.id} · ${card.updatedAt ?? ''}`),
      data.error && h('p', { role: 'alert' }, data.error.message),
      h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 } },
        h('a', { href: card.url, target: '_blank', rel: 'noreferrer', style: buttonStyle }, '打开完整页面 ↗'),
        h('button', { style: buttonStyle, disabled: busy, onClick: () => refresh().catch((e) => setError(e.message)) }, '刷新状态'),
        ...(card.actions ?? []).map((a) => h('button', { key: a.operation, style: buttonStyle, disabled: busy, onClick: () => act({ operation: a.operation, id: a.id }) }, a.label))),
      error && h('p', { role: 'alert' }, error), value.truncated && h('p', null, '此处显示概览，完整内容与证据请打开 PaperRadar。'));
  }
  return { inject: ['slots'], apply(ctx) {
    const request = async (args, sessionId) => {
      const response = await fetch('/api/paper-radar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...args, sessionId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'PaperRadar 请求未完成。');
      return result;
    };
    for (const name of ['paper_radar_read', 'paper_radar_action']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name, inject: (sessionId) => ({ request: (args) => request(args, sessionId) }) }, Card));
  } };
} });
