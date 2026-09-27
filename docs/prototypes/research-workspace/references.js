/* Shared reference rules, a live catalog adapter, and legacy demo references. */
(function (root) {
  'use strict';
  const library = [
    { id: 'kn_quasi', kind: 'knowledge', title: '近守恒量', path: '统计物理 / 非平衡动力学', aliases: ['quasi-conserved quantity', '慢变量'], summary: '在一定近似和时间尺度内变化缓慢的物理量，可以作为理解慢弛豫的线索。', body: '## 核心想法\n先明确近似条件，再比较这个量的变化时间与观测量的弛豫时间。\n\n## 使用时关心什么\n- 近似成立的参数范围\n- 被忽略项的大小\n- 小尺寸观察能否推广\n\n这是一条用于演示引用交互的知识笔记。' },
    { id: 'kn_size', kind: 'knowledge', title: '有限尺寸效应', path: '统计物理 / 数值研究', aliases: ['finite-size effects', '尺寸外推'], summary: '有限系统的行为可能与大尺寸极限不同，需要比较多个尺寸并说明外推条件。', body: '## 检查思路\n在相同初态、精度和参数约定下比较多个尺寸。\n\n## 保留哪些信息\n- 实际覆盖的尺寸\n- 已检查的数值误差\n- 仍未完成的外推\n\n单个尺寸上的差异可以作为进一步检查的线索。' },
    { id: 'kn_perturb', kind: 'knowledge', title: '微扰展开', path: '量子力学 / 近似方法', aliases: ['perturbation theory', '弱耦合'], summary: '围绕可处理的极限展开，逐阶保留修正，并检查截断后的适用范围。', body: '## 从哪里开始\n选择一个可以求解的基准，明确展开参数。\n\n## 计算后的检查\n记录保留的阶数、可能的小分母和误差估计。用一个最小数值例子检验表达式。' },
    { id: 'kn_symmetry', kind: 'knowledge', title: '对称性扇区', path: '量子多体 / 对称性', aliases: ['symmetry sector'], summary: '利用守恒量划分状态空间；不同扇区中的初态、观测量和统计权重需要分别说明。', body: '## 数值约定\n明确扇区定义、初态所在空间以及观测量归一化。\n\n## 比较时的限制\n保留各扇区的条件，避免超出已计算样本的解释。' },
    { id: 'kn_tensor', kind: 'knowledge', title: '张量网络', path: '计算物理 / 数值方法', aliases: ['tensor network', 'MPS'], summary: '用局域张量表示多体态或算符，并通过截断控制计算规模。', body: '## 实际使用\n计算中需要同时考虑截断、时间演化步长和系统尺寸。\n\n## 阅读线索\n先熟悉表示方式，再比较不同算法的误差来源。' },
    { id: 'kn_convergence', kind: 'knowledge', title: '数值收敛', path: '计算物理 / 结果检查', aliases: ['convergence', '误差'], summary: '系统改变计算精度或控制参数，判断目标观测量是否达到可接受的稳定程度。', body: '## 检查维度\n- 时间步长\n- 截断阈值\n- 系统尺寸\n\n分别记录每个维度的变化，方便以后复查。' },
    { id: 'kn_effective', kind: 'knowledge', title: '有效哈密顿量', path: '量子多体 / 有效理论', aliases: ['effective Hamiltonian'], summary: '在指定能量或约束空间中，用较少的自由度描述关心的物理过程。', body: '## 推导顺序\n明确目标空间，选择合适的投影，再保留需要的修正阶数。\n\n## 适用范围\n把能量尺度与近似条件一起记录。' },
    { id: 'kn_old_boundary', kind: 'knowledge', title: '单尺寸边界解释（旧笔记）', path: '历史笔记 / 边界条件', aliases: [], archived: true, summary: '早期只基于单个尺寸提出的解释，后续整理时已归档。', body: '## 历史记录\n保留最初讨论的上下文，便于追踪研究思路。\n\n这条笔记已归档，已有引用仍可查看。' },
    { id: 'mat_noneq', kind: 'material', title: '非平衡动力学阅读笔记', path: '阅读笔记 · 2026', aliases: ['慢弛豫', 'prethermalization'], summary: '围绕慢变量、时间尺度与数值证据整理的一份阅读笔记。', author: '演示资料', body: '## 阅读问题\n什么样的时间尺度分离值得进一步检查？\n\n## 笔记摘记\n先明确观测量与初态，再区分近似机制、数值误差和有限尺寸限制。\n\n## 下一次阅读\n整理各篇材料使用的参数范围与验证方法。\n\n此内容是虚构的演示材料。' },
    { id: 'mat_boundary', kind: 'material', title: '边界条件对照方法备忘', path: '方法笔记 · 2026', aliases: ['开放边界', '周期边界'], summary: '记录开放与周期边界对照中需要保持一致的设置及复查项目。', author: '演示资料', body: '## 对照清单\n- 相同初态定义\n- 相同耦合参数\n- 相同求解精度\n- 可比较的观测量\n\n## 结果描述\n写明已计算的尺寸，以及哪些结论仍需要增加证据。' },
    { id: 'mat_tensor', kind: 'material', title: '张量网络收敛检查清单', path: '方法清单 · 2026', aliases: ['MPS', '截断', '时间步长'], summary: '将时间步长、截断与尺寸检查分开记录，方便复用已有的计算基准。', author: '演示资料', body: '## 开始前\n记录算法版本、初态、观测量和参数。\n\n## 收敛检查\n逐个改变控制参数，保存目标观测量与计算成本。\n\n## 收尾\n留下一组最小基准和仍未解决的误差来源。' },
    { id: 'mat_perturb', kind: 'material', title: '弱耦合展开推导手稿', path: '推导笔记 · 2026', aliases: ['微扰', '近守恒量'], summary: '从零耦合基准出发，记录最低阶表达式及尚待处理的修正项。', author: '演示资料', body: '## 推导入口\n固定展开参数与符号约定。\n\n## 已完成\n最低阶结构与零耦合基准的核对。\n\n## 待检查\n高阶修正的大小，以及表达式适用的时间尺度。' },
  ].map(item => ({ archived: false, source: 'demo', ...item }));
  let liveLibrary = null;
  function liveItem(item) {
    if (!item || !/^ps_[a-f0-9]{16}_[a-f0-9]{32}$/.test(item.id) || !['knowledge','material'].includes(item.kind) || typeof item.title !== 'string') throw new Error('Invalid library item');
    let detailUrl = '';
    try { const url = new URL(item.detail_url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) detailUrl = url.href; } catch {}
    return { ...item, source: 'live', archived: item.archived === true, aliases: Array.isArray(item.aliases) ? item.aliases : [], tags: Array.isArray(item.tags) ? item.tags : [], summary: String(item.summary || ''), path: String(item.path || ''), body: String(item.body || ''), detail_url: detailUrl };
  }
  function setLiveLibrary(items) {
    const next = items.map(liveItem);
    if (new Set(next.map(item => item.id)).size !== next.length) throw new Error('Duplicate library IDs');
    liveLibrary = next;
  }
  function setLiveDetail(item) {
    const next = liveItem(item);
    if (!liveLibrary) throw new Error('Live library is not connected');
    const index = liveLibrary.findIndex(record => record.id === next.id);
    if (index < 0) liveLibrary.push(next); else liveLibrary[index] = next;
  }
  const seedLinks = {
    p_spin: ['kn_quasi', 'kn_size', 'mat_noneq'], p_tensor: ['kn_tensor', 'mat_tensor'], p_geometry: ['kn_effective'],
    i1: ['kn_perturb', 'mat_perturb'], i2: ['mat_boundary', 'kn_old_boundary'], i3: ['kn_size'], i4: ['kn_size'],
    i5: ['kn_symmetry'], i6: ['mat_noneq'], i7: ['kn_perturb'], i8: ['kn_convergence', 'mat_tensor'], i9: ['kn_effective'],
  };
  const get = id => liveLibrary?.find(item => item.id === id) || library.find(item => item.id === id);
  const escapedAt = (text, index) => { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2 === 1; };
  function inlineTokens(text, offset = 0) {
    const tokens = []; let index = 0, start = 0;
    const plain = end => { if (end > start) tokens.push({ kind: 'text', text: text.slice(start, end), start: start + offset, end: end + offset }); };
    while (index < text.length) {
      if (text[index] === '`' && !escapedAt(text, index)) {
        const run = text.slice(index).match(/^`+/)[0]; let close = text.indexOf(run, index + run.length);
        while (close >= 0 && (text[close - 1] === '`' || text[close + run.length] === '`')) close = text.indexOf(run, close + run.length);
        if (close >= 0) { plain(index); tokens.push({ kind: 'code', text: text.slice(index + run.length, close), start: index + offset, end: close + run.length + offset }); index = close + run.length; start = index; continue; }
      }
      if (text[index] === '[' && text[index - 1] !== '!' && !escapedAt(text, index)) {
        const match = text.slice(index).match(/^\[((?:\\.|[^\]\\\n])+)\]\(kb:([A-Za-z0-9_-]+)\)/);
        if (match) { plain(index); tokens.push({ kind: 'ref', id: match[2], title: match[1].replace(/\\([\\\[\]])/g, '$1'), text: match[0], start: index + offset, end: index + match[0].length + offset }); index += match[0].length; start = index; continue; }
      }
      index++;
    }
    plain(text.length); return tokens;
  }
  function citations(body) {
    let offset = 0, fence = null, paragraphStart = 0, paragraph = []; const refs = [];
    const flush = () => { if (paragraph.length) refs.push(...inlineTokens(paragraph.join('\n'), paragraphStart).filter(token => token.kind === 'ref')); paragraph = []; };
    for (const line of String(body || '').split('\n')) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker) { flush(); fence = { char: marker[1][0], length: marker[1].length }; }
      else if (!line.trim() || (line.startsWith('$$') && line.endsWith('$$'))) flush();
      else if (/^(?:#{1,6}\s|[-*]\s|> )/.test(line)) { flush(); refs.push(...inlineTokens(line, offset).filter(token => token.kind === 'ref')); }
      else { if (!paragraph.length) paragraphStart = offset; paragraph.push(line); }
      offset += line.length + 1;
    }
    flush();
    return refs;
  }
  function related(record) {
    const items = new Map();
    for (const id of record?.related_refs || []) items.set(id, { id, manual: true, occurrences: [] });
    for (const ref of citations(record?.body)) {
      if (!items.has(ref.id)) items.set(ref.id, { id: ref.id, manual: false, occurrences: [] });
      items.get(ref.id).occurrences.push(ref);
    }
    return [...items.values()].map(ref => ({ ...ref, record: get(ref.id), title: get(ref.id)?.title || ref.occurrences[0]?.title || ref.id }));
  }
  function stripCitations(body) {
    let result = String(body || '');
    for (const ref of citations(result).reverse()) result = result.slice(0, ref.start) + ref.title + result.slice(ref.end);
    return result;
  }
  function makeCitation(id, title = get(id)?.title || id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid reference id');
    return `[${title.replace(/[\\\[\]]/g, '\\$&')}](${`kb:${id}`})`;
  }
  function matches(record, id) { return !id || related(record).some(ref => ref.id === id); }
  function backlinks(db, id) {
    return ['projects', 'ideas'].flatMap(type => db[type].filter(record => !record.archived && (type !== 'ideas' || !record.project || !db.projects.find(p => p.id === record.project)?.archived)).flatMap(record => {
      const ref = related(record).find(item => item.id === id);
      return ref ? [{ type, record, ref }] : [];
    }));
  }
  function descendants(db, project) {
    const items = new Map();
    for (const idea of db.ideas.filter(item => item.project === project && !item.archived)) for (const ref of related(idea)) {
      if (!items.has(ref.id)) items.set(ref.id, { ...ref, ideas: [] });
      items.get(ref.id).ideas.push(idea);
    }
    return [...items.values()];
  }
  function search(query, kind = 'all', includeArchived = false) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return (liveLibrary || library).filter(item => (includeArchived || !item.archived) && (kind === 'all' || item.kind === kind) && words.every(word => [item.title, item.path, item.summary, ...item.aliases, ...(item.tags || [])].join(' ').toLocaleLowerCase().includes(word)));
  }
  function seedRecords(db) {
    for (const type of ['projects', 'ideas']) for (const record of db[type]) record.related_refs = [...(seedLinks[record.id] || [])];
    const project = db.projects.find(p => p.id === 'p_spin'), idea = db.ideas.find(i => i.id === 'i1');
    if (project) project.body = project.body.replace('有限尺寸效应。', makeCitation('kn_size') + '。');
    if (idea) idea.body = idea.body.replace('缓慢变化的量', makeCitation('kn_quasi', '缓慢变化的量'));
  }
  const api = { library, get, inlineTokens, citations, related, makeCitation, stripCitations, matches, backlinks, descendants, search, seedRecords, setLiveLibrary, setLiveDetail };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ResearchReferences = api;
})(typeof window !== 'undefined' ? window : globalThis);
