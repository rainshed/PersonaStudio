(function () {
  'use strict';
  const R = window.ResearchReferences;
  const apiBase = '/api/projects/library';
  const state = {mode:'live', status:'loading', workspace:null, counts:null, error:'', loadedAt:0};
  let pending;
  R.setLiveLibrary([]);
  const notify = () => window.dispatchEvent(new Event('research-library-change'));
  async function request(path) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) {
        const error = new Error(response.status === 404 ? '该条目已不在当前知识库中，已有引用仍保留。' : '暂时无法读取正式知识库，请重试。');
        error.status = response.status; throw error;
      }
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function refresh() {
    if (pending) return pending;
    state.status = 'loading'; state.error = ''; notify();
    pending = (async () => {
      try {
        const data = await request(apiBase);
        if (data.mode !== 'live' || !data.workspace?.key || !Array.isArray(data.items)) throw new Error('Invalid library response');
        R.setLiveLibrary(data.items);
        state.workspace = data.workspace; state.counts = data.counts;
        state.loadedAt = Date.now(); state.status = 'ready';
      } catch {
        state.status = 'error'; state.error = '正式知识库连接失败。已有引用和编辑内容仍保留，请重试。';
      } finally { pending = null; notify(); }
    })();
    return pending;
  }
  async function detail(id) {
    const item = await request(`${apiBase}/items/${encodeURIComponent(id)}`);
    if (item.id !== id) throw new Error('条目读取失败，请重试。');
    R.setLiveDetail(item); return R.get(id);
  }
  window.ResearchLibrary = { state, refresh, detail };
})();
