/* Isolated, browser-local UI prototype. No Persona APIs or model calls. */
'use strict';
const KEY = 'personastudio-ideas-prototype-v1';
const DRAFT_KEY = `${KEY}-draft`;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const statusLabels = { not_started: '未执行', in_progress: '执行中', completed: '已完成', paused: '暂缓' };
const noveltyLabels = { unknown: '未判断 / 不确定', novel: '新颖', incremental: '部分新颖', non_novel: '不新颖' };
const difficultyLabels = { unknown: '未判断 / 不确定', low: '低', medium: '中', high: '高' };
const paths = {
  home:'M3 10 12 3l9 7v10H3Z M9 20v-7h6v7',
  network:'M8 7h8M6 9v6m12-6v6M8 17h8 M4 4h4v5H4z M16 4h4v5h-4z M4 15h4v5H4z M16 15h4v5h-4z',
  library:'M4 4h4v16H4z M10 4h4v16h-4z M16 5l3-1 4 15-3 1z',
  bulb:'M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0l-1 2H9z M12 1v1',
  sliders:'M4 7h7m4 0h5M4 17h3m4 0h9 M11 4v6m-4 4v6',
  archive:'M4 8v12h16V8M3 4h18v4H3z M9 12h6',
  lock:'M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3',
  info:'M12 11v6m0-10v.2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  'arrow-up-right':'M6 18 18 6M6 6h12v12',
  'arrow-right':'M4 12h16m-6-6 6 6-6 6',
  'arrow-left':'M20 12H4m6-6-6 6 6 6',
  'chevron-right':'m9 5 7 7-7 7',
  'chevron-down':'m6 9 6 6 6-6',
  chevrons:'m8 8 4-4 4 4m-8 8 4 4 4-4',
  plus:'M12 5v14M5 12h14',
  pen:'m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15z M4 15l5 4',
  sort:'M7 4v16m-3-3 3 3 3-3M13 6h7m-7 6h5m-5 6h3',
  search:'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  leaf:'M5 19C-1 9 11 2 21 3c0 13-6 19-14 15M4 21 16 9',
  check:'m5 12 4 4L19 6',
  history:'M3 10a9 9 0 1 1 2 9M3 4v6h6M12 7v5l3 2',
  more:'M5 12h.01M12 12h.01M19 12h.01',
  sparkle:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  mountain:'m2 20 8-15 4 7 3-5 5 13H2 M7 11l3 2 3-2',
  text:'M4 5h16M4 10h10M4 15h16M4 20h10',
  link:'m10 14 4-4m-5-3 3-3a5 5 0 0 1 7 7l-3 3m-1 3-3 3a5 5 0 0 1-7-7l3-3',
  file:'M5 3h9l5 5v13H5z M14 3v6h5M8 13h8m-8 4h6',
  code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  copy:'M8 8h13v13H8z M16 5V2H2v14h3',
  x:'m6 6 12 12M6 18 18 6',
  flag:'M5 22V3m0 0c5-4 8 5 15 0v10c-7 5-10-4-15 0',
  restart:'M3 11a9 9 0 1 1 3 8M3 4v7h7',
  upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  download:'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
  folder:'M3 6h7l2 3h9v12H3z M3 6V3h7l2 3h8v3',
  inbox:'M3 13 6 4h12l3 9v7H3z M3 13h5l2 3h4l2-3h5',
  save:'M4 3h13l4 4v14H3V3h1 M7 3v6h10V3 M7 21v-8h10v8',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"${name === 'more' ? ' style="stroke-width:4;stroke-linecap:round"' : ''}><path d="${paths[name] || paths.file}"/></svg>`;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const uid = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const safeURL = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
const hydrateIcons = (root = document) => $$('[data-icon]', root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
const snapshot = (record) => { const { history, ...rest } = record; return clone(rest); };
const business = (record) => JSON.stringify(Object.fromEntries(['title','body','execution_status','novelty','difficulty','failure','resources','status'].map(k => [k,record[k]])));
const timestamp = (value, full = false) => new Date(value).toLocaleString('zh-CN', full ? {month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false} : {month:'2-digit',day:'2-digit'});
function seedData() {
  const seed = [
    {title:'能否利用模型中间表示，减少新任务的标注需求？', execution_status:'in_progress', novelty:'incremental', difficulty:'medium', body:'最初的想法是：预训练模型的中间表示，可能已经包含新任务所需的信息。如果能够找到并复用这些表示，是否可以用更少的标注完成迁移？\n\n## 讨论与当前判断\n\n目前判断为**部分新颖**，但与已有方法的边界还没有完全厘清。真正需要验证的，不是能否复用表示，而是如何找到值得复用的那一层。\n\n- 对比不同层表示在小样本任务中的迁移效果\n- 固定数据与训练预算，排除额外计算带来的改善\n- 先在一个足够小的问题上，做最小验证\n\n> 难度暂记为中等。当前的瓶颈是验证方法，而不是代码实现。\n\n## 9 月 20 日 · 一点新进展\n\n小样本测试中观察到了一些改善，但还不能排除随机波动。下一步换一组数据，并补充不同随机种子的对照。', resources:[{id:'res_report',title:'小样本实验笔记',note:'初步观察 · Markdown',fileId:'sample-report',filename:'小样本实验笔记.md'},{id:'res_code',title:'实验代码与对照设计',note:'固定版本后补充实验结果',url:'https://github.com/example/idea-experiment'}]},
    {title:'让检索记住“为什么读过”，而不只是“读过什么”',execution_status:'in_progress',novelty:'novel',difficulty:'medium',body:'检索结果往往能匹配主题，但不理解我当时阅读这篇文章的动机。\n\n## 一个可能的切入点\n\n在笔记里保留一个可选的阅读问题，比较基于主题与基于问题的检索差异。\n\n> 这里的新颖性是个人当前判断，还没有做系统性的文献检索。',resources:[{id:'res_retrieval',title:'检索对照笔记',note:'先比较五个真实研究问题',url:'https://example.org/retrieval-notes'}]},
    {title:'从论文的失败案例中，整理一份“问题地图”',execution_status:'not_started',novelty:'unknown',difficulty:'unknown',body:'阅读时常会遇到被轻轻带过的 negative results。也许这些不成立的条件，比最终的结论更能提示下一步该问什么。\n\n先把这个念头记下来。',resources:[]},
    {title:'用张量网络描述长上下文中的信息压缩',execution_status:'in_progress',novelty:'incremental',difficulty:'high',body:'尝试把长序列的信息传递与矩阵乘积态中的键维联系起来。\n\n## 还没有想清楚的问题\n\n- 压缩误差是否能找到可解释的度量？\n- 最简单的可比较基线应该是什么？\n\n这只是一个类比，还不是已验证的理论联系。',resources:[{id:'res_tn',title:'推导草稿',note:'待补充边界条件',url:'https://example.org/tensor-network-notes'}]},
    {title:'合成数据能否保留小众领域的推理结构？',execution_status:'paused',novelty:'incremental',difficulty:'high',body:'初步生成的数据看起来流畅，但关键推理步骤可能丢失。\n\n暂缓原因：缺少足够可靠的人工评价样本。等收集到更好的真实问题后再继续，不把资源不足视为失败。',resources:[]},
    {title:'让主动学习优先询问“最有分歧”的样本',execution_status:'not_started',novelty:'unknown',difficulty:'low',body:'如果两个小模型对同一个样本产生分歧，把它交给人来标注，是否比简单的不确定性采样更有效？',resources:[]},
    {title:'少量领域样本能改善通用嵌入的检索表现吗？',execution_status:'completed',novelty:'non_novel',difficulty:'low',body:'已完成本轮对照实验。\n\n在当前数据上观察到有限改善，需要保留数据范围的限制。这次工作主要帮助我理解领域适配的基本流程。',resources:[]},
    {title:'仅调整最后一层，能否替代完整的领域微调？',execution_status:'completed',novelty:'incremental',difficulty:'low',failure:{reason:'完整测试未复现小样本上的改善。多次重复后，结果与冻结基线的差异仍在随机波动范围内，本轮没有达到预期。'},body:'先前的小样本结果较好，因此尝试扩大测试范围。\n\n## 这次留下的经验\n\n完整测试暴露了对样本划分的敏感性。下一次需要在早期就固定多组划分，避免过早根据单次结果判断。',resources:[]},
    {title:'用阅读时间推断论文的重要性',execution_status:'paused',novelty:'non_novel',difficulty:'medium',status:'archived',body:'归档备忘：阅读时间同时受难度、熟悉程度和注意力影响，不能直接视为重要性。暂时保留这个问题，不继续推进。',resources:[]},
  ];
  return seed.map((item, index) => {
    const record = {id:`idea_demo_${index+1}`,title:'',body:'',execution_status:'not_started',novelty:'unknown',difficulty:'unknown',failure:null,resources:[],status:'active',revision:1,created_at:`2026-09-${String(10+index).padStart(2,'0')}T08:00:00+02:00`,updated_at:`2026-09-${String(20-Math.floor(index/2)).padStart(2,'0')}T${index%2?'09':'14'}:20:00+02:00`,...item};
    if (index === 0) {
      const v1 = {...clone(record),body:'预训练模型的中间表示，可能已经包含新任务所需的信息。先从小样本迁移做一个最小验证。',novelty:'unknown',difficulty:'unknown',execution_status:'not_started',resources:[],updated_at:record.created_at};
      const v2 = {...clone(record),revision:2,body:record.body.split('## 9 月')[0].trim(),updated_at:'2026-09-18T16:30:00+02:00',resources:[]};
      record.revision = 3;
      record.history = [v1,v2,snapshot(record)];
    } else record.history = [snapshot(record)];
    return record;
  });
}
let records;
try { records = JSON.parse(localStorage.getItem(KEY)) || seedData(); } catch { records = seedData(); }
let selectedId = records.find(r => r.status === 'active')?.id || null;
let draft = selectedId ? snapshot(records.find(r => r.id === selectedId)) : null;
let baseRevision = draft?.revision;
let editMode = false;
let activeTab = 'all';
let archiveView = false;
let query = '';
let filters = {execution_status:[],novelty:[],difficulty:[],failure:[],includeArchived:false};
let restoredDraft = false;
try { const saved = JSON.parse(localStorage.getItem(DRAFT_KEY)); if (saved?.draft && records.some(r => r.id === saved.draft.id)) { draft = saved.draft; selectedId = draft.id; baseRevision = saved.baseRevision; restoredDraft = true; editMode = true; } } catch { /* A damaged optional draft never hides the notebook. */ }
let toastTimer;
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('visible'),3700); }
const current = () => records.find(r=>r.id===selectedId);
const isDirty = () => draft && current() && business(draft) !== business(current());
function persistDraft() {
  try { if (isDirty()) localStorage.setItem(DRAFT_KEY,JSON.stringify({draft,baseRevision})); else localStorage.removeItem(DRAFT_KEY); }
  catch { toast('本地草稿保存失败，请复制内容后再离开。'); }
  updateSaveIndicator();
}
function updateSaveIndicator() {
  const el=$('#save-indicator'); if (!el) return;
  el.className=`save-indicator${isDirty()?' dirty':''}`;
  el.innerHTML=`${icon(isDirty()?'pen':'check')}<span>${isDirty()?'未保存 · 草稿已保留':'已保存'}</span>`;
  const save=$('#save-button'); if (save) save.hidden=!isDirty();
  const foot=$('#inline-save'); if (foot) foot.hidden=!isDirty();
}
function saveRecord(message = '已保存，思考又向前了一点。') {
  if (!draft?.title.trim()) { toast('写一句话总结，就可以保存。'); return false; }
  const previous=current(); if (!previous) return false;
  if (!isDirty()) { toast('内容没有变化，已保留当前版本。'); return true; }
  let disk;
  try { disk=JSON.parse(localStorage.getItem(KEY)) || records; } catch { toast('无法读取本地记录，已保留当前输入。'); return false; }
  const latest=disk.find(r=>r.id===draft.id);
  if (!latest || latest.revision !== baseRevision) { openConflict(); return false; }
  const next={...clone(draft),title:draft.title.trim(),revision:latest.revision+1,created_at:latest.created_at,updated_at:new Date().toISOString()};
  next.history=[...latest.history,snapshot(next)];
  const nextRecords=disk.map(r=>r.id===next.id?next:r);
  try { localStorage.setItem(KEY,JSON.stringify(nextRecords)); } catch { toast('保存失败：浏览器存储空间不足。输入仍保留在页面中。'); return false; }
  records=nextRecords; draft=snapshot(next); baseRevision=next.revision;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* Successful record remains durable. */ }
  render(); toast(message); return true;
}
function createRecord(title, body='') {
  if (!title.trim()) return false;
  const now=new Date().toISOString();
  const record={id:uid('idea'),title:title.trim(),body,execution_status:'not_started',novelty:'unknown',difficulty:'unknown',failure:null,resources:[],status:'active',revision:1,created_at:now,updated_at:now};
  record.history=[snapshot(record)];
  let disk;
  try { disk=JSON.parse(localStorage.getItem(KEY)) || records; localStorage.setItem(KEY,JSON.stringify([record,...disk])); } catch { toast('保存失败，请检查浏览器存储空间。'); return false; }
  records=[record,...disk];selectedId=record.id;draft=snapshot(record);baseRevision=1;archiveView=false;activeTab='all';query='';$('#search').value='';resetFilters();editMode=false;
  render();$('#modal').close();$('.notebook').classList.add('detail-open');toast('已记下这个想法。其他内容，可以慢慢补充。');return true;
}
function safeNavigate(callback) {
  if (!isDirty()) { callback(); return; }
  showModal('保留这次思考','这条想法还有未保存的修改。',`<p class="about-text">保存后再离开，会生成一个新的修订版本。</p>`,`<button class="button ghost" data-modal="stay">继续编辑</button><button class="button" data-modal="discard">放弃修改</button><button class="button primary" data-modal="save-leave">保存并继续</button>`);
  $('[data-modal="discard"]').onclick=()=>{draft=snapshot(current());baseRevision=draft.revision;persistDraft();$('#modal').close();callback();};
  $('[data-modal="save-leave"]').onclick=()=>{if(saveRecord()){ $('#modal').close();callback(); }};
}
function selectIdea(id) {
  safeNavigate(()=>{selectedId=id;draft=snapshot(current());baseRevision=draft.revision;editMode=false;renderList();renderDetail();$('.notebook').classList.add('detail-open');});
}
function resetFilters(){filters={execution_status:[],novelty:[],difficulty:[],failure:[],includeArchived:false};renderFilters();}
function filteredRecords() {
  return records.filter(r=>{
    if(archiveView ? r.status!=='archived' : !filters.includeArchived && r.status==='archived')return false;
    if(activeTab!=='all'&&r.execution_status!==activeTab)return false;
    if(['execution_status','novelty','difficulty'].some(k=>filters[k].length&&!filters[k].includes(r[k])))return false;
    if(filters.failure.length&&!filters.failure.includes(r.failure?'yes':'no'))return false;
    const haystack=[r.title,r.body,r.failure?.reason||'',...r.resources.flatMap(x=>[x.title,x.note])].join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }).sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
}
function statusMarkup(record) { const cls=record.failure?'failed':record.execution_status;return `<span class="status-inline ${cls}"><span class="status-dot"></span>${record.failure?'已结束 · 失败':statusLabels[record.execution_status]}</span>`; }
function render() { renderCounts();renderList();renderDetail(); }
function renderCounts() {
  const active=records.filter(r=>r.status==='active');$('#nav-count').textContent=active.length;$('#archive-count').textContent=records.length-active.length;
  const scope=records.filter(r=>archiveView?r.status==='archived':(filters.includeArchived||r.status==='active'));
  $('#all-count').textContent=scope.length;$('#progress-count').textContent=scope.filter(r=>r.execution_status==='in_progress').length;$('#new-count').textContent=scope.filter(r=>r.execution_status==='not_started').length;
  $('#ideas-nav').classList.toggle('active',!archiveView);$('#archive-nav').classList.toggle('active',archiveView);
  $('#page-title').innerHTML=`${archiveView?'想法归档':'研究想法'}<span class="heading-dot">.</span>`;$('#breadcrumb-title').textContent=archiveView?'想法归档':'研究想法';
  $$('[data-tab]').forEach(btn=>btn.setAttribute('aria-selected',String(btn.dataset.tab===activeTab)));
}
function renderList() {
  const list=filteredRecords();$('#result-count').textContent=`${list.length} 条想法`;
  const count=['execution_status','novelty','difficulty','failure'].reduce((n,k)=>n+filters[k].length,0)+(filters.includeArchived?1:0);$('#filter-dot').hidden=!count;
  $('#idea-list').innerHTML=list.length?list.map(r=>`<button class="idea-card${r.id===selectedId?' selected':''}" data-select="${esc(r.id)}" aria-pressed="${r.id===selectedId}"><div class="card-overline">${statusMarkup(r)}<span class="card-date">${timestamp(r.updated_at)}</span></div><h3>${esc(r.title)}</h3><p class="card-excerpt">${esc(r.body.replace(/[#*>`\n]/g,' ').slice(0,100)||'这个念头，等你慢慢展开。')}</p><div class="card-meta"><span class="mini-tag">${r.novelty==='unknown'?'新颖性待判断':noveltyLabels[r.novelty]}</span><span class="mini-tag">${r.difficulty==='unknown'?'难度待判断':`难度 · ${difficultyLabels[r.difficulty]}`}</span>${r.resources.length?`<span class="resource-count">${icon('link')}${r.resources.length}</span>`:''}${r.status==='archived'?'<span class="mini-tag">已归档</span>':''}</div></button>`).join(''):`<div class="empty-state">${icon('search')}<h3>${query?'还没有找到这个想法':'这里暂时没有想法'}</h3><p>试试其他关键词，或调整筛选条件。</p><button class="button small" data-action="clear-filters">清除搜索与筛选</button></div>`;
}
function options(map,value){return Object.entries(map).map(([v,label])=>`<option value="${v}"${v===value?' selected':''}>${label}</option>`).join('');}
function resourceMarkup(resource,editable=true) {
  const url=resource.url?safeURL(resource.url):null;
  const title=resource.title||(url?new URL(url).hostname:resource.filename)||'来源文件';
  const kind=resource.fileId?'file':url?.includes('github.com')?'code':'link';
  const label=resource.note||(url?new URL(url).hostname:resource.filename)||'';
  return `<div class="resource-card"><span class="resource-symbol">${icon(kind)}</span><div class="resource-copy">${url?`<a class="resource-title" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${esc(title)}</a>`:`<button class="resource-title" data-download="${esc(resource.fileId||'')}" data-filename="${esc(resource.filename||'file')}" title="下载 ${esc(title)}">${esc(title)}</button>`}<p title="${esc(label)}">${esc(label)}</p></div>${editable?`<button class="icon-button" data-edit-resource="${esc(resource.id)}" aria-label="编辑资源 ${esc(title)}">${icon('more')}</button>`:''}</div>`;
}
function renderDetail() {
  const el=$('#idea-detail');
  if(!draft){el.innerHTML=`<div class="empty-state">${icon('bulb')}<h3>每个研究，都始于一个念头。</h3><p>先写一句话，让它有一个可以回来的地方。</p><button class="button primary" data-action="new">记录新想法</button></div>`;return;}
  el.innerHTML=`<button class="back-button" data-action="back">${icon('arrow-left')}返回想法列表</button><div class="detail-top"><span class="detail-type">${icon('file')}IDEA / RESEARCH NOTE</span><div class="detail-actions"><span id="save-indicator" class="save-indicator"></span><button id="save-button" class="button primary small" data-action="save" hidden>保存</button><button class="icon-button" data-action="history" title="修订历史" aria-label="修订历史">${icon('history')}</button><button class="icon-button" data-action="menu" title="更多操作" aria-label="更多操作" aria-expanded="false">${icon('more')}</button></div><div class="menu" id="detail-menu" hidden><button data-action="edit">${icon('pen')}编辑标题与正文</button><button data-action="history">${icon('history')}查看修订历史</button><button data-action="context">${icon('copy')}复制为 AI 上下文</button>${draft.failure?`<button data-action="restart">${icon('restart')}重新开始</button>`:`<button class="danger" data-action="failure">${icon('flag')}标记本轮失败</button>`}<button data-action="archive">${icon('archive')}${draft.status==='archived'?'恢复归档':'归档这个想法'}</button></div></div>
  ${draft.status==='archived'?'<div class="archived-ribbon">这个想法已归档，正文、资源和历史均保留。</div>':''}
  ${editMode?`<textarea class="title-editor" id="edit-title" aria-label="一句话总结" maxlength="500">${esc(draft.title)}</textarea>`:`<h2 class="detail-title">${esc(draft.title)}</h2>`}
  <div class="detail-meta"><label class="status-select">${statusMarkup(draft)}${icon('chevron-down')}<select id="execution-status" aria-label="执行状态">${options(statusLabels,draft.execution_status)}</select></label><span class="meta-separator"></span><span>更新于 ${timestamp(draft.updated_at,true)}</span><span class="meta-separator"></span><span>第 ${draft.revision} 次修订</span></div>
  <div class="attributes"><label class="attribute"><i>${icon('sparkle')}</i><div><div class="attribute-label">新颖性</div><select id="novelty" aria-label="新颖性">${options(noveltyLabels,draft.novelty)}</select></div><i>${icon('chevron-down')}</i></label><label class="attribute"><i>${icon('mountain')}</i><div><div class="attribute-label">实现难度</div><select id="difficulty" aria-label="实现难度">${options(difficultyLabels,draft.difficulty)}</select></div><i>${icon('chevron-down')}</i></label></div><div class="attribute-help">基于你当前的理解，判断随时可以改变。</div>
  ${draft.failure?`<section class="failure-box"><h3>本轮已结束 · 失败</h3><p>${esc(draft.failure.reason||'失败理由待补充')}</p><div class="failure-actions"><button data-action="failure">补充或修改理由</button><button data-action="undo-failure">撤销失败标记</button><button data-action="restart">重新开始</button></div></section>`:''}
  <section><div class="note-heading"><h3>${icon('text')}思考与讨论</h3><div class="editor-toggle" aria-label="正文模式"><button data-action="preview" class="${!editMode?'active':''}">阅读</button><button data-action="edit" class="${editMode?'active':''}">编辑</button></div></div>${editMode?`<textarea class="body-editor" id="edit-body" aria-label="思考与讨论正文" placeholder="问题、猜想、推导，或者一段还没想清楚的讨论…">${esc(draft.body)}</textarea><p class="editor-hint">支持 Markdown · 自由写，不必套用模板 · ⌘ / Ctrl + S 保存</p>`:`<div class="markdown">${markdown(draft.body)||'<p class="note-empty">想法已经记下了。点击「编辑」，慢慢展开你的思考。</p>'}</div>`}<div id="inline-save" class="inline-save" hidden><span>本地草稿尚未形成正式修订</span><button class="button primary small" data-action="save">${icon('save')}保存修改</button></div></section>
  <section class="resources-section"><div class="resources-heading"><h3>${icon('link')}相关资源<span>${draft.resources.length}</span></h3><button class="text-button" data-action="resource">${icon('plus')}添加资源</button></div><div class="resource-grid">${draft.resources.map(r=>resourceMarkup(r)).join('')}</div>${!draft.resources.length?'<div class="resource-empty">参考资料、讨论链接，或任何阶段的结果，都可以放在这里。</div>':''}<p class="resources-footnote">${icon('info')}链接仅保存地址，重要结果可以留一份本地副本。</p></section><div class="detail-footer"><button class="context-button" data-action="context">${icon('copy')}复制为 AI 上下文${icon('arrow-up-right')}</button><span>你的想法，由你决定如何分享。</span></div>`;
  updateSaveIndicator();
}
function markdown(source='') {
  // Escape first; only our own elements are emitted. Images never perform a request.
  function inline(value) {
    const tokens=[];
    const token=(html)=>{tokens.push(html);return `\u0000${tokens.length-1}\u0000`;};
    let result=esc(value).replace(/`([^`]+)`/g,(_,text)=>token(`<code>${text}</code>`));
    result=result.replace(/!\[([^\]]*)\]\(([^)]*)\)/g,(_,alt)=>token(`<span class="image-placeholder">图片引用：${alt||'未命名图片'}（演示中不自动加载）</span>`));
    result=result.replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,encoded)=>{
      const decoded=encoded.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
      const url=safeURL(decoded);return token(url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`:`${label}（不支持的链接协议）`);
    });
    result=result.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>');
    return result.replace(/\u0000(\d+)\u0000/g,(_,n)=>tokens[Number(n)]||'');
  }
  const lines=source.replace(/\u0000/g,'').replace(/\r\n/g,'\n').split('\n');let html='',paragraph=[],list=[],listType='',code=null,quotes=[];
  const flush=()=>{if(paragraph.length){html+=`<p>${paragraph.map(inline).join('<br>')}</p>`;paragraph=[];}if(list.length){html+=`<${listType}>${list.map(x=>`<li>${inline(x)}</li>`).join('')}</${listType}>`;list=[];listType='';}if(quotes.length){html+=`<blockquote>${quotes.map(inline).join('<br>')}</blockquote>`;quotes=[];}};
  for(const line of lines){
    if(/^\s*```/.test(line)){if(code!==null){html+=`<pre><code>${esc(code.join('\n'))}</code></pre>`;code=null;}else{flush();code=[];}continue;}
    if(code!==null){code.push(line);continue;}
    if(!line.trim()){flush();continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){flush();const n=Math.min(heading[1].length,3);html+=`<h${n}>${inline(heading[2])}</h${n}>`;continue;}
    if(/^---+$/.test(line)){flush();html+='<hr>';continue;}
    const item=line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);if(item){const type=item[1]?'ul':'ol';if(paragraph.length||quotes.length||(listType&&listType!==type))flush();listType=type;list.push(item[2]);continue;}
    if(/^>\s?/.test(line)){if(paragraph.length||list.length)flush();quotes.push(line.replace(/^>\s?/,''));continue;}
    if(list.length||quotes.length)flush();paragraph.push(line);
  }
  flush();if(code!==null)html+=`<pre><code>${esc(code.join('\n'))}</code></pre>`;return html;
}
function renderFilters(){
  const groups=[['execution_status','执行状态',statusLabels],['novelty','新颖性',noveltyLabels],['difficulty','实现难度',difficultyLabels],['failure','失败记录',{yes:'有失败标记',no:'无失败标记'}]];
  $('#filters').innerHTML=groups.map(([name,label,values])=>`<fieldset class="filter-group"><legend>${label}</legend><div class="filter-choices">${Object.entries(values).map(([value,title])=>`<label><input type="checkbox" data-filter="${name}" value="${value}"${filters[name].includes(value)?' checked':''}>${title==='未判断 / 不确定'?'未判断':title}</label>`).join('')}</div></fieldset>`).join('')+`<div class="filter-bottom"><label><input type="checkbox" id="include-archived"${filters.includeArchived?' checked':''}>包含归档</label><button data-action="reset-filters">重置筛选</button></div>`;
}

function showModal(title, subtitle, content, actions='',wide=false) {
  const dialog=$('#modal');
  dialog.style.width=wide?'720px':'560px';
  dialog.innerHTML=`<div class="modal-head"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button" data-modal="close" aria-label="关闭">${icon('x')}</button></div><div class="modal-body">${content}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}`;
  if(!dialog.open)dialog.showModal();
  requestAnimationFrame(()=>{const input=$('input:not([type=checkbox]):not([type=file]), textarea',dialog);if(input)input.focus();});
}
function newIdeaModal(){
  let saved={title:'',body:''};try{saved=JSON.parse(localStorage.getItem(`${KEY}-new`))||saved;}catch{}
  showModal('一个想法，从一句话开始。','还没想清楚，也值得被记下。',`<form id="new-idea-form"><label class="form-field"><span>一句话总结<small>唯一必填</small></span><input id="new-title" placeholder="如果……会不会……？" value="${esc(saved.title)}" maxlength="500" required autocomplete="off"></label><label class="form-field"><span>展开说说<small>可以以后再写</small></span><textarea id="new-body" placeholder="一个问题，一段讨论，或此刻的直觉。支持 Markdown。">${esc(saved.body)}</textarea></label><div class="modal-note">默认「未执行」，新颖性与难度暂不判断。你不需要现在就给出答案。</div></form>`,`<button class="button ghost" data-modal="close">稍后再写</button><button class="button primary" type="submit" form="new-idea-form">${icon('plus')}记下这个想法</button>`);
}
function failureModal(){
  showModal(draft.failure?'补充失败记录':'标记本轮失败','结束的是这一轮尝试，思考仍然可以继续。',`<form id="failure-form"><label class="form-field"><span>发生了什么？<small>可稍后补充</small></span><textarea id="failure-reason" placeholder="实际观察到什么？哪些预期没有实现？">${esc(draft.failure?.reason||'')}</textarea></label><div class="modal-note">保存后，执行状态会变为「已结束 · 失败」。这次记录与当前修改一起保存到修订历史中。</div></form>`,`<button class="button ghost" data-modal="close">取消</button><button class="button danger" form="failure-form" type="submit">保存失败记录</button>`);
}
function clearFailure(mode,target='in_progress'){
  showModal(mode==='undo'?'撤销失败标记':'重新开始这条想法','旧的失败理由仍会保留在修订历史中。',`<p class="about-text">${mode==='undo'?'当前失败标记将被清除，执行状态仍为「已完成」。':`当前失败标记将被清除，执行状态调整为「${statusLabels[target]}」。`}</p><div class="modal-note">当前未保存的修改也会一并保存。</div>`,`<button class="button ghost" data-modal="close">取消</button><button class="button primary" id="confirm-clear-failure">${mode==='undo'?'撤销并保存':'继续并保存'}</button>`);
  $('#confirm-clear-failure').onclick=()=>{draft.failure=null;draft.execution_status=mode==='undo'?'completed':target;persistDraft();if(saveRecord('已保存。过去的尝试仍可在历史中查看。'))$('#modal').close();};
}
function historyModal(revision){
  const list=current()?.history||[];const selected=list.find(r=>r.revision===revision)||list.at(-1);if(!selected)return;
  showModal('每一步思考，都有迹可循。','成功保存时保留完整版本。可复制旧内容，继续今天的思考。',`<div class="history-list">${[...list].reverse().map(r=>`<button data-history="${r.revision}" class="${r.revision===selected.revision?'active':''}">第 ${r.revision} 次修订<small>${timestamp(r.updated_at,true)}</small></button>`).join('')}</div><div class="history-preview"><h3>${esc(selected.title)}</h3><div class="history-properties">${statusMarkup(selected)}<span>新颖性：${noveltyLabels[selected.novelty]}</span><span>难度：${difficultyLabels[selected.difficulty]}</span><span>${selected.status==='archived'?'已归档':'有效记录'}</span></div>${selected.failure?`<div class="failure-box"><h3>本轮失败记录</h3><p>${esc(selected.failure.reason||'失败理由待补充')}</p></div>`:''}<div class="markdown">${markdown(selected.body)||'<p>这一版还没有正文。</p>'}</div><h4 class="editor-hint">相关资源 · ${selected.resources.length}</h4><div class="resource-grid">${selected.resources.map(r=>resourceMarkup(r,false)).join('')}</div></div>`,`<button class="button ghost" data-modal="close">关闭</button><button class="button" id="copy-version">${icon('copy')}复制这个版本的正文</button>`,true);
  $('#copy-version').onclick=()=>copyText(selected.body,'已复制此版本正文。');
}
function contextText(includeResources=true){
  let value=`# 研究想法：${draft.title}\n\n执行状态：${draft.failure?'已结束 · 失败':statusLabels[draft.execution_status]}\n新颖性（我的当前判断）：${noveltyLabels[draft.novelty]}\n实现难度（相对当前知识与资源）：${difficultyLabels[draft.difficulty]}\n\n## 思考与讨论\n\n${draft.body||'（暂未补充）'}`;
  if(draft.failure)value+=`\n\n## 本轮失败记录\n\n${draft.failure.reason||'失败理由待补充'}`;
  if(includeResources&&draft.resources.length)value+=`\n\n## 相关资源（未读取链接或文件内容）\n\n${draft.resources.map(r=>`- ${r.title||r.filename||r.url}${r.url?`：${r.url}`:`（本地文件：${r.filename}，不含文件内容）`}${r.note?`\n  ${r.note}`:''}`).join('\n')}`;
  return value+'\n\n---\n以上是我的研究笔记。猜想、判断与观察结果应保留其原有的不确定性，不代表已经验证的知识。';
}
function contextModal(){
  showModal('把这次思考，带进下一次对话。',`${isDirty()?'预览来自当前未保存草稿。':'预览来自当前记录。'}复制后，由你决定分享给谁。`,`<label class="checkbox-label"><input id="context-resources" type="checkbox" checked>附带资源名称、链接与说明</label><pre class="context-preview" id="context-preview" tabindex="0">${esc(contextText())}</pre><div class="modal-note">仅复制文本，不调用模型、不读取外部链接，也不会上传本地文件。</div>`,`<button class="button ghost" data-modal="close">关闭</button><button class="button primary" id="copy-context">${icon('copy')}复制上下文</button>`,true);
  $('#context-resources').onchange=e=>{$('#context-preview').textContent=contextText(e.target.checked);};
  $('#copy-context').onclick=()=>copyText($('#context-preview').textContent,'上下文已复制，可以粘贴到你选择的对话中。');
}
async function copyText(value,message){
  try{await navigator.clipboard.writeText(value);toast(message);return true;}
  catch{const input=document.createElement('textarea');input.value=value;input.style.cssText='position:fixed;opacity:0';($('#modal').open?$('#modal'):document.body).append(input);input.select();let copied=false;try{copied=document.execCommand('copy');}catch{}input.remove();toast(copied?message:'复制未获浏览器允许，请选中预览文本手动复制。');return copied;}
}
function fileDatabase(){
  return new Promise((resolve,reject)=>{const request=indexedDB.open(`${KEY}-files`,1);request.onupgradeneeded=()=>request.result.createObjectStore('files');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function saveFile(id,file){const db=await fileDatabase();try{await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').put(file,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function readFile(id){const db=await fileDatabase();try{return await new Promise((resolve,reject)=>{const req=db.transaction('files').objectStore('files').get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}finally{db.close();}}
async function downloadFile(id,filename){
  try{
    const file=id==='sample-report'?new Blob(['# 小样本实验笔记（演示）\n\n这是用于界面演示的虚构研究笔记。\n\n初步观察：不同种子下的结果仍有波动，需要增加对照。\n'],{type:'text/markdown;charset=utf-8'}):await readFile(id);
    if(!file){toast('此浏览器中找不到该文件，笔记正文和其他资源仍可使用。');return;}
    const url=URL.createObjectURL(file);const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已准备文件下载。');
  }catch{toast('文件暂时无法读取，笔记正文不受影响。');}
}
function resourceModal(type='url', resourceId=null){
  const resource=draft.resources.find(r=>r.id===resourceId);if(resource)type=resource.fileId?'file':'url';
  const sources=new Map();records.forEach(record=>record.history.forEach(version=>version.resources.forEach(r=>{if(r.fileId)sources.set(r.fileId,r);})));draft.resources.forEach(r=>{if(r.fileId)sources.set(r.fileId,r);});
  showModal(resource?'整理这个资源':'让思考与依据相连。','参考材料、讨论文档、代码与阶段结果，都可以放在这里。',`
    ${!resource?`<div class="modal-tabs"><button data-resource-tab="url" class="${type==='url'?'active':''}">${icon('link')}外部链接</button><button data-resource-tab="file" class="${type==='file'?'active':''}">${icon('upload')}本地文件</button><button data-resource-tab="existing" class="${type==='existing'?'active':''}">${icon('folder')}已有文件</button></div>`:''}
    <form id="resource-form" data-type="${type}" data-resource-id="${resource?.id||''}">
    ${type==='url'?`<label class="form-field"><span>链接地址</span><input type="url" id="resource-url" value="${esc(resource?.url||'')}" placeholder="https://…" required><small class="editor-hint">支持任意 HTTP(S) 链接，无需登录或解析。</small></label>`:type==='file'?(resource?`<div class="modal-note">已关联文件：${esc(resource.filename)}</div>`:`<label class="file-drop">${icon('upload')}选择一个文件，留住这一阶段的结果。<small>每个文件上限 5 MB · 文件保存在此浏览器</small><input type="file" id="resource-file" required aria-label="选择本地文件"></label>`):`<label class="form-field"><span>已有来源文件<small>复用文件，不重复上传</small></span><select id="resource-existing" aria-label="已有来源文件" required style="width:100%;padding:10px;border:1px solid #dfe7d4;border-radius:6px;background:#fff;color:#72865e">${[...sources.values()].map(r=>`<option value="${esc(r.fileId)}" data-filename="${esc(r.filename)}">${esc(r.filename)}</option>`).join('')}</select></label>`}
    <label class="form-field" style="margin-top:20px"><span>显示名称<small>可选</small></span><input id="resource-title" placeholder="例如：第一次实验的笔记" value="${esc(resource?.title||'')}" maxlength="200"></label><label class="form-field"><span>说明<small>可选</small></span><textarea id="resource-note" style="min-height:75px" placeholder="这个资源与想法有什么关系？">${esc(resource?.note||'')}</textarea></label><p id="resource-error" class="error-message" hidden></p>${resource?`<div class="resource-order"><span class="editor-hint">显示顺序</span><button type="button" data-reorder="-1" data-resource-id="${esc(resource.id)}" ${draft.resources.indexOf(resource)===0?'disabled':''}>前移</button><button type="button" data-reorder="1" data-resource-id="${esc(resource.id)}" ${draft.resources.indexOf(resource)===draft.resources.length-1?'disabled':''}>后移</button></div>`:''}<div class="modal-note">${resource?'移除关联会保留原文件，历史版本仍可找到它。':'添加后请保存笔记，资源关联才会进入正式修订。'}</div></form>`,`${resource?`<button class="button ghost" style="margin-right:auto;color:#b18c71" data-remove-resource="${esc(resource.id)}">移除关联</button>`:''}<button class="button ghost" data-modal="close">取消</button><button class="button primary" type="submit" form="resource-form">${resource?'完成修改':'添加关联'}</button>`);
}
async function submitResource(form){
  const button=$('[form="resource-form"]');button.disabled=true;
  const id=form.dataset.resourceId||uid('res');const resource={id,title:$('#resource-title').value.trim(),note:$('#resource-note').value.trim()};
  const type=form.dataset.type;
  const fail=(message)=>{$('#resource-error').textContent=message;$('#resource-error').hidden=false;button.disabled=false;};
  try{
    if(type==='url'){const url=safeURL($('#resource-url').value.trim());if(!url){fail('请输入以 http:// 或 https:// 开头的有效链接。');return;}resource.url=url;}
    else if(type==='file'){
      if(form.dataset.resourceId){const existing=draft.resources.find(r=>r.id===id);resource.fileId=existing.fileId;resource.filename=existing.filename;}
      else{const file=$('#resource-file').files[0];if(!file){fail('请先选择一个文件。');return;}if(file.size>MAX_FILE_SIZE){fail('文件超过 5 MB。正文和已保存的资源不受影响。');return;}resource.fileId=uid('source');resource.filename=file.name;await saveFile(resource.fileId,file);}
    }else{const selected=$('#resource-existing').selectedOptions[0];if(!selected){fail('还没有可以复用的文件。');return;}resource.fileId=selected.value;resource.filename=selected.dataset.filename;}
    if(form.dataset.resourceId)draft.resources=draft.resources.map(r=>r.id===id?resource:r);else draft.resources.push(resource);
    persistDraft();renderDetail();$('#modal').close();toast(type==='file'&&!form.dataset.resourceId?'文件已保存到此浏览器；请保存笔记以确认关联。':'资源关联已加入草稿，请保存笔记。');
  }catch{fail('资源保存失败，可能是浏览器空间不足。笔记正文仍保留。');}
}
function aboutModal(label){
  showModal(label?`${label} · 导航示意`:'研究想法 · 交互演示',label?'此演示聚焦 Ideas 模块，其他入口用于展示它在 Persona 中的位置。':'根据 PersonaStudio Idea 需求文档 v1.0 制作。',`<p class="about-lead">让想法不成熟时，<br>也能被轻松记录。</p><p class="about-text">这是一份可交互的页面原型。你可以随手记录、自由补充、调整判断、关联资源，再回顾每一次修改。</p><div class="feature-pills"><span>自由 Markdown</span><span>个人判断</span><span>失败与重新开始</span><span>修订历史</span><span>手动 AI 上下文</span></div><div class="modal-note">当前为虚构示例数据。编辑、修订历史与草稿保存在此浏览器，上传文件也仅保存在此浏览器。尚未连接正式 Persona 工作区、备份或后端权限服务。清理浏览器数据会清除此演示中的修改。</div>`,`<button class="button primary" data-modal="close">开始探索</button>`);
}
function openConflict(){
  showModal('这条想法有了更新','另一个页面已保存新版本。当前输入仍保留，未覆盖任何内容。',`<div class="modal-note">先复制你的草稿，再载入最新版本进行合并。</div><pre class="context-preview">${esc(contextText())}</pre>`,`<button class="button" id="conflict-copy">复制我的草稿</button><button class="button primary" id="conflict-reload">载入最新版本</button>`);
  $('#conflict-copy').onclick=()=>copyText(contextText(),'草稿已复制。');
  $('#conflict-reload').onclick=()=>{try{const next=JSON.parse(localStorage.getItem(KEY));const latest=next?.find(r=>r.id===selectedId);if(!latest){toast('没有找到最新记录，请先保留你的草稿。');return;}records=next;draft=snapshot(latest);baseRevision=latest.revision;persistDraft();$('#modal').close();render();}catch{toast('暂时无法读取最新版本。');}};
}
function switchScope(archived){safeNavigate(()=>{archiveView=archived;activeTab='all';query='';$('#search').value='';resetFilters();const item=filteredRecords()[0];selectedId=item?.id||null;draft=item?snapshot(item):null;baseRevision=draft?.revision;editMode=false;$('.notebook').classList.remove('detail-open');render();});}

document.addEventListener('click',event=>{
  const target=event.target.closest('button,a');
  if(!target){if(!event.target.closest('#detail-menu'))$('#detail-menu')?.setAttribute('hidden','');return;}
  if(target.dataset.select){selectIdea(target.dataset.select);return;}
  if(target.dataset.tab){activeTab=target.dataset.tab;renderCounts();renderList();return;}
  if(target.dataset.modal){$('#modal').close();return;}
  if(target.dataset.history){historyModal(Number(target.dataset.history));return;}
  if(target.dataset.resourceTab){resourceModal(target.dataset.resourceTab);return;}
  if(target.dataset.editResource){resourceModal('url',target.dataset.editResource);return;}
  if(target.dataset.download){downloadFile(target.dataset.download,target.dataset.filename);return;}
  if(target.dataset.removeResource){draft.resources=draft.resources.filter(r=>r.id!==target.dataset.removeResource);persistDraft();renderDetail();$('#modal').close();toast('已从草稿移除关联，原文件与历史均保留。');return;}
  if(target.dataset.reorder){const index=draft.resources.findIndex(r=>r.id===target.dataset.resourceId);const next=index+Number(target.dataset.reorder);if(next>=0&&next<draft.resources.length){[draft.resources[index],draft.resources[next]]=[draft.resources[next],draft.resources[index]];persistDraft();renderDetail();$('#modal').close();toast('资源顺序已调整，请保存笔记。');}return;}
  const action=target.dataset.action;
  if(action!=='menu')$('#detail-menu')?.setAttribute('hidden','');
  switch(action){
    case 'new':safeNavigate(newIdeaModal);break;
    case 'about':aboutModal();break;
    case 'placeholder':aboutModal(target.dataset.label);break;
    case 'show-active':switchScope(false);break;
    case 'show-archive':switchScope(true);break;
    case 'save':saveRecord();break;
    case 'edit':editMode=true;renderDetail();$('#edit-body')?.focus();break;
    case 'preview':editMode=false;renderDetail();break;
    case 'back':safeNavigate(()=>$('.notebook').classList.remove('detail-open'));break;
    case 'filters':{const panel=$('#filters');panel.hidden=!panel.hidden;target.setAttribute('aria-expanded',String(!panel.hidden));break;}
    case 'reset-filters':resetFilters();renderCounts();renderList();break;
    case 'clear-filters':resetFilters();query='';activeTab='all';$('#search').value='';renderCounts();renderList();break;
    case 'menu':{const panel=$('#detail-menu');panel.hidden=!panel.hidden;target.setAttribute('aria-expanded',String(!panel.hidden));break;}
    case 'failure':failureModal();break;
    case 'undo-failure':clearFailure('undo');break;
    case 'restart':clearFailure('restart');break;
    case 'history':historyModal();break;
    case 'context':contextModal();break;
    case 'resource':resourceModal();break;
    case 'archive':safeNavigate(()=>{draft.status=draft.status==='archived'?'active':'archived';persistDraft();saveRecord(draft.status==='archived'?'已归档。正文、资源与历史完整保留。':'已恢复，原来的思考仍在这里。');});break;
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='search'){query=event.target.value;renderList();}
  if(event.target.id==='edit-title'){draft.title=event.target.value;persistDraft();}
  if(event.target.id==='edit-body'){draft.body=event.target.value;persistDraft();}
  if(['new-title','new-body'].includes(event.target.id)){try{localStorage.setItem(`${KEY}-new`,JSON.stringify({title:$('#new-title').value,body:$('#new-body').value}));}catch{}}
});
document.addEventListener('change',event=>{
  const target=event.target;
  if(['novelty','difficulty'].includes(target.id)){draft[target.id]=target.value;persistDraft();}
  if(target.id==='execution-status'){if(draft.failure&&target.value!=='completed'){const value=target.value;renderDetail();clearFailure('restart',value);}else{draft.execution_status=target.value;persistDraft();renderDetail();}}
  if(target.dataset.filter){const field=target.dataset.filter;filters[field]=target.checked?[...filters[field],target.value]:filters[field].filter(v=>v!==target.value);renderCounts();renderList();}
  if(target.id==='include-archived'){filters.includeArchived=target.checked;renderCounts();renderList();}
  if(target.id==='resource-file'&&target.files[0]?.size>MAX_FILE_SIZE){$('#resource-error').textContent='文件超过 5 MB，请选择更小的文件。';$('#resource-error').hidden=false;}
});
document.addEventListener('submit',event=>{
  if(!['quick-form','new-idea-form','failure-form','resource-form'].includes(event.target.id))return;
  event.preventDefault();
  if(event.target.id==='quick-form'){const input=$('#quick-title');if(!input.value.trim()){input.focus();toast('先写一句话，记下你的好奇。');return;}const title=input.value;safeNavigate(()=>{if(createRecord(title))input.value='';});}
  if(event.target.id==='new-idea-form'){if(!$('#new-title').value.trim()){toast('标题不能只有空格。');$('#new-title').focus();return;}if(createRecord($('#new-title').value,$('#new-body').value)){try{localStorage.removeItem(`${KEY}-new`);}catch{}}}
  if(event.target.id==='failure-form'){draft.failure={reason:$('#failure-reason').value.trim()};draft.execution_status='completed';persistDraft();if(saveRecord('已记录这轮尝试，也保留了继续探索的可能。'))$('#modal').close();}
  if(event.target.id==='resource-form')submitResource(event.target);
});
document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'&&!$('#modal').open){event.preventDefault();saveRecord();return;}
  if(event.target.matches('input,textarea,select,[contenteditable]')||$('#modal').open||event.metaKey||event.ctrlKey||event.altKey)return;
  if(event.key.toLowerCase()==='n'){event.preventDefault();safeNavigate(newIdeaModal);}
  if(event.key==='/'){event.preventDefault();$('#search').focus();}
  if(event.key==='Escape')$('#detail-menu')?.setAttribute('hidden','');
});
window.addEventListener('beforeunload',event=>{if(isDirty()){event.preventDefault();event.returnValue='';}});
window.addEventListener('storage',event=>{if(event.key===KEY&&!isDirty()){try{const next=JSON.parse(event.newValue);if(!Array.isArray(next))return;records=next;const latest=current();if(latest){draft=snapshot(latest);baseRevision=latest.revision;}render();}catch{}}});
try{if(!localStorage.getItem(KEY))localStorage.setItem(KEY,JSON.stringify(records));}catch{setTimeout(()=>toast('此浏览器不能保存演示数据，修改将仅在当前页面保留。'),100);}
hydrateIcons();renderFilters();render();
if(restoredDraft)setTimeout(()=>toast('已恢复上次未保存的草稿。'),200);
