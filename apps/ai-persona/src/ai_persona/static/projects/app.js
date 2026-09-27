(() => {
  'use strict';
  const KEY = 'personastudio-research-workspace-demo-v2.1';
  let DRAFT_KEY = `${KEY}:drafts`;
  const R = window.ResearchReferences;
  const L = window.ResearchLibrary;
  const liveLibrary = L.state.mode === 'live';
  const integrated = window.ResearchLibraryConfig?.integrated === true;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clone = value => structuredClone(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const excerpt = value => R.stripCitations(value).split('\n\n')[0].replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s*\n\s*/g, ' · ');
  const uid = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  const now = () => new Date().toISOString();
  const shortDate = value => new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const fullDate = value => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1v15"/>',
    file: '<path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h5"/>',
    bulb: '<path d="M9 18h6M10 21h4M8 14a6 6 0 118 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
    folder: '<path d="M3 7V5h6l2 2h10v13H3ZM3 9h18"/>',
    projects: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 5V3h8v2M3 10h18M8 14h3M8 17h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    tasks: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    arrowUp: '<path d="M6 18 18 6M6 6h12v12"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    history: '<path d="M3 11a9 9 0 119 10M3 5v6h6M12 7v5l4 2"/>',
    pin: '<path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4ZM12 15v6"/>',
    spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
    flag: '<path d="M5 21V3m0 1c5-3 9 4 15 0v10c-6 4-10-3-15 0"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 01-6-6l5-5a4 4 0 016 0m0 2 1-1a4 4 0 016 6l-5 5a4 4 0 01-6 0" transform="translate(2 1) scale(.9)"/>',
    git: '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="6" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10M17 8v3a5 5 0 01-5 5H7"/>',
    server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.1M7 17.5h.1M11 6.5h6M11 17.5h6"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3M12 14v3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    sliders: '<path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
    edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
    chart: '<path d="M4 3v17h17M7 15l4-5 4 3 6-8"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v13h14V8M10 12h4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    warning: '<path d="m12 3 10 18H2ZM12 9v5M12 17h.01"/>',
    minus: '<path d="M5 12h14"/>',
    return: '<path d="M8 4 3 9l5 5M3 9h12a6 6 0 010 12"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  const tag = (label, tone = '', symbol = '') => `<span class="tag ${tone}">${symbol ? icon(symbol) : ''}${esc(label)}</span>`;
  const button = (label, action, data = '', cls = '', symbol = '') => `<button type="button" class="button ${cls.includes('primary')?'primary-button':'ghost'} ${cls}" data-action="${action}" ${data}>${symbol ? icon(symbol) : ''}${label}</button>`;
  const ib = (symbol, label, action, data = '') => `<button type="button" class="icon-btn" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}" ${data}>${icon(symbol)}</button>`;
  const ps = { active: ['推进中', 'blue'], paused: ['暂缓', 'amber'], completed: ['已结项', 'green'], stopped: ['已停止', ''] };
  const es = { pending: ['待探索', ''], exploring: ['探索中', 'blue'], paused: ['暂缓', 'amber'], closed: ['已结束', ''], abandoned: ['已放弃', 'amber'] };
  const vs = { unassessed: ['未判断', ''], supported: ['得到支持', 'green'], unsupported: ['不支持', 'red'], inconclusive: ['证据不足', 'amber'] };
  const ts = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' };
  const novelty = { unknown: '未判断', novel: '新颖', incremental: '增量改进', non_novel: '不新颖' };
  const difficulty = { unknown: '未判断', low: '低', medium: '中', high: '高' };
  const resourceData = { fig_boundary: { title: '边界条件对照图', subtitle: '比较图 · 示意', kind: 'chart' }, note_run: { title: '计算与检查记录', subtitle: 'N = 12 / 16 / 20', kind: 'file' }, resource_estimate: { title: '计算资源估算', subtitle: '资源安排 · 示例', kind: 'server' } };
  const emptyProjects = () => ({version:0,projects:[],ideas:[],tasks:[],updates:[],history:{},events:[],imports:{}});
  let projectReady=!integrated, projectError='', projectBusy=false, projectWorkspace='', browserBackup=null;
  let db;
  let formalIdeas = [], formalReady = false, formalError = '';
  const formalProjection = () => { if(integrated) db.ideas = formalIdeas; };

  let storageAvailable = true;
  try { browserBackup=JSON.parse(localStorage.getItem(KEY)); } catch {}
  db=integrated?emptyProjects():(browserBackup?.projects&&browserBackup?.version?browserBackup:window.createResearchDemo());
  let drafts;
  try { drafts = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { drafts = {}; }
  try { if (!integrated && !localStorage.getItem(KEY)) localStorage.setItem(KEY, JSON.stringify(db)); } catch { storageAvailable = false; }
  let route = { page: 'project', id: 'p_spin', tab: 'overview' };
  let filter = 'all', query = '', taskIdea = '', showInvalid = false, showActivity = false, includeArchive = false, ideaScope = 'independent';
  let detailState = null, formState = null, toastTimer;
  let referenceFilter = '', referenceState = null, referenceStack = [];
  const get = (type, id) => db[type].find(x => x.id === id) || (integrated && type==='ideas' ? db.legacy_ideas?.find(x=>x.id===id) : null);
  const currentProject = () => get('projects', route.id);
  const projectIdeas = p => db.ideas.filter(x => x.project === p && !x.archived);
  const projectTasks = p => db.tasks.filter(x => x.project === p && !x.archived).sort((a, b) => a.order - b.order);
  const projectUpdates = p => db.updates.filter(x => x.project === p && !x.archived).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const stats = p => { const t = projectTasks(p); return { done: t.filter(x => x.state === 'done').length, open: t.filter(x => ['todo', 'doing'].includes(x.state)).length, cancelled: t.filter(x => x.state === 'cancelled').length, total: t.filter(x => x.state !== 'cancelled').length }; };
  const effective = u => u && !u.archived && u.validity === 'valid';
  const projectFor = (type, item) => type === 'projects' ? item.id : item.project;
  function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3600); }
  async function saveTransaction(edit) {
    if(projectBusy){toast('正在保存，请稍候。');return false;}
    if(integrated&&!projectReady){toast(projectError||'项目尚未读取完成，请重试连接。');return false;}
    projectBusy=true;
    try {
      const next=clone(db);edit(next);
      if(integrated){
        const changes=[];
        for(const kind of ['projects','tasks','updates'])for(const record of next[kind]){
          const old=db[kind].find(r=>r.id===record.id);
          if(JSON.stringify(old)===JSON.stringify(record))continue;
          const entry=next.events.find(e=>e.type===kind&&e.target===record.id);
          changes.push({collection:kind,value:record,label:next.history[`${kind}:${record.id}`]?.at(-1)?.action_label||'保存',progress:entry?.progress||false,note:entry?.note||''});
        }
        if(!changes.length)return true;
        db=await formalRequest('/api/projects',{workspace_key:projectWorkspace,expected_revision:db.version,changes});
        projectError='';formalProjection();render();renderLibraryStatus();return true;
      }
      const latest=JSON.parse(localStorage.getItem(KEY));
      if(latest&&latest.version!==db.version){db=latest;render();toast('另一标签页更新了记录，请核对后重试。当前表单仍保留。');return false;}
      next.version+=1;localStorage.setItem(KEY,JSON.stringify(next));db=next;render();return true;
    }catch(error){
      const message=error.message||'保存未完成，请保留输入后重试。';
      if($('#form-error'))$('#form-error').textContent=message;
      if(error.status===409)projectError=message;
      toast(message);renderLibraryStatus();return false;
    }finally{projectBusy=false;}
  }
  function put(next, type, value, label, progress = false, note = '') {
    const list = next[type], index = list.findIndex(x => x.id === value.id), old = list[index];
    const record = { ...value, created_at: old?.created_at || value.created_at || now(), updated_at: now(), revision: (old?.revision || 0) + 1, archived: value.archived || false };
    if (index >= 0) list[index] = record; else list.unshift(record);
    const key = `${type}:${value.id}`;
    next.history[key] ||= []; next.history[key].push({ ...clone(record), action_label: label });
    const project = projectFor(type, record);
    if (project) next.events.unshift({ id: `${type}:${record.id}:${record.revision}`, project, type, target: record.id, revision: record.revision, label: `${label}：${record.title || '研究进展'}`, time: record.updated_at, progress, note, verdict: record.verdict || null });
    return record;
  }
  function update(type, id, patch, label, progress = false, note = '') { return saveTransaction(next => put(next, type, { ...get(type, id), ...patch }, label, progress, note)); }
  function activityTime(p) { return [...db.events.filter(x => x.project === p).map(x => x.time), ...['projects','ideas','tasks','updates'].flatMap(type => db[type].filter(x => projectFor(type, x) === p).map(x => x.updated_at))].sort().at(-1); }
  function progressTime(p) { return [...projectUpdates(p).map(x => x.created_at), ...db.events.filter(x => x.project === p && x.progress).map(x => x.time)].sort().at(-1); }
  function parseRoute() {
    const parts = location.hash.slice(1).split('/');
    if(integrated && parts[0]==='ideas'){location.replace('/ideas');return;}
    route = parts[0] === 'projects' ? { page: 'projects' } : parts[0] === 'ideas' ? { page: 'ideas' } : (integrated&&!get('projects',parts[1]) ? {page:'projects'} : { page: 'project', id: get('projects', parts[1]) ? parts[1] : 'p_spin', tab: ['overview','ideas','tasks','updates'].includes(parts[2]) ? parts[2] : 'overview' });
    filter = route.tab === 'tasks' ? 'open' : 'all'; query = ''; taskIdea = ''; showInvalid = false; showActivity = false; referenceFilter = '';
    if ($('#detail').open) $('#detail').close(); detailState = null;
    render(); window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function render() {
    $('#page').setAttribute('aria-busy', String(integrated && !projectReady && !projectError));
    document.title = `${route.page === 'project' ? currentProject()?.title : route.page === 'ideas' ? '研究想法' : '项目'} · AI Persona`;
    if(integrated&&!projectReady){$('#page').innerHTML=`<div class="page-inner">${empty(projectError?'项目暂时无法读取':'正在读取项目',esc(projectError||'正在连接当前 Persona…'),'folder')}${button('重新连接','refresh-projects','','primary')}</div>`;return;}
    $('#page').innerHTML = `<div class="page-inner">${route.page === 'projects' ? renderProjects() : route.page === 'ideas' ? renderStandalone() : renderProject()}</div>`;
    if (detailState && $('#detail').open) renderDetail();
  }
  function renderProject() {
    const p = currentProject(), s = stats(p.id), ideas = projectIdeas(p.id), updates = projectUpdates(p.id);
    return `<nav class="project-breadcrumb" aria-label="项目导航"><a href="#projects">全部项目</a>${icon('chevron')}<span>${esc(p.title)}</span></nav>${p.archived ? `<div class="archive-banner">${icon('archive')}项目已归档，研究记录仍保留。${button('恢复项目','restore-project',`data-id="${p.id}"`,'small')}</div>` : ''}<section class="project-heading"><div><p class="eyebrow">PROJECT</p><div class="title-line"><h1>${esc(p.title)}</h1><button class="tag ${ps[p.state][1]} status-button" data-action="project-status" data-id="${p.id}"><i class="tiny-dot"></i>${ps[p.state][0]}${icon('down')}</button></div><p class="lead">${esc(p.subtitle || p.goal || '从一个问题开始，让每一步探索都有迹可循。')}</p></div><div class="heading-actions">${button('复制上下文','context',`data-id="${p.id}"`,'','copy')}${button('记录进展','new-update',`data-project="${p.id}"`,'primary','plus')}</div></section><div class="project-meta"><span>${icon('clock')}最近活动 ${shortDate(activityTime(p.id))}</span><span>${icon('chart')}最近记录进展 ${progressTime(p.id) ? shortDate(progressTime(p.id)) : '暂无'}</span><span>${icon('lock')}私人研究记录</span></div><nav class="project-tabs" aria-label="项目工作区">${[['overview','概览','grid',''],['ideas',integrated?'想法':'探索方向','bulb',ideas.length],['tasks','待办','tasks',s.open],['updates','进展与结果','chart',updates.length]].map(([tab,label,symbol,count]) => `<a href="#project/${p.id}/${tab}" class="${route.tab === tab ? 'active' : ''}" ${route.tab === tab ? 'aria-current="page"' : ''}>${icon(symbol)}${label}${count !== '' ? `<span class="tab-count">${count}</span>` : ''}</a>`).join('')}</nav><div id="workspace-content">${route.tab === 'overview' ? renderOverview(p) : route.tab === 'ideas' ? renderIdeas(p) : route.tab === 'tasks' ? renderTasks(p) : renderUpdates(p)}</div>`;
  }
  const sectionHead = (label, action = '', symbol = '', subtext = '') => `<div class="panel-head"><h2>${symbol ? icon(symbol) : ''}${label}${subtext ? `<span class="subtext">${subtext}</span>` : ''}</h2>${action}</div>`;
  function renderOverview(p) {
    const pinned = get('updates', p.current), s = stats(p.id), tasks = projectTasks(p.id).filter(x => ['todo','doing'].includes(x.state)).sort((a,b) => (a.state === 'doing' ? -1 : 1) - (b.state === 'doing' ? -1 : 1)).slice(0,3);
    const ideas = projectIdeas(p.id).filter(x => ['exploring','pending'].includes(x.state)).slice(0,2), key = projectUpdates(p.id).find(x => x.key && effective(x));
    return `<div class="overview-grid"><div class="main-column"><section class="panel current-panel">${sectionHead('当前进度',pinned ? `<button class="text-link" data-action="detail" data-type="updates" data-id="${pinned.id}">查看记录 ${icon('arrow')}</button>` : '', 'pin')}<div class="panel-body">${pinned ? `<h2 class="current-judgment">${esc(pinned.title || `${shortDate(pinned.occurred_at)} 的研究进展`)}</h2><p class="current-summary">${esc(excerpt(pinned.body))}</p>${!effective(pinned) ? `<div class="notice danger">${icon('warning')}这条进展${pinned.validity === 'superseded' ? '已被替代' : pinned.archived ? '已归档' : '已撤回'}，请更换当前进度。</div>` : ''}${progressTime(p.id) > pinned.updated_at ? `<div class="notice blue">${icon('info')}此后有新的研究记录，可以检查是否需要更新当前进度。</div>` : ''}` : `<h2 class="current-judgment">从第一条进展开始</h2><p class="current-summary">留下现在的判断、还不确定的地方，以及下一步。</p>${button('记录并设为当前进度','new-update',`data-project="${p.id}" data-pin="true"`,'soft','plus')}`}<div class="focus-lines"><div class="focus-line"><span>${icon('target')}当前重点</span><strong>${esc(p.focus || '还没有设定当前重点。')}</strong></div>${p.blocker ? `<div class="focus-line"><span>${icon('pause')}主要卡点</span><strong>${esc(p.blocker)}</strong></div>` : ''}<div class="focus-line next"><span>${icon('arrow')}下一步</span><strong>${esc(p.next || '添加一个可以开始的小行动。')}</strong></div></div><div class="current-footer"><span>${icon('clock')}${pinned ? `${shortDate(pinned.created_at)} 记录 · ${effective(pinned) ? '已置顶' : '需要更新'}` : '尚未置顶进展'}</span><button class="text-link" data-action="edit-project" data-id="${p.id}">调整重点与下一步 ${icon('edit')}</button></div></div></section><section class="panel">${sectionHead('接下来做什么',`<a class="text-link" href="#project/${p.id}/tasks">全部待办 ${icon('arrow')}</a>`,'tasks',s.open ? `${s.open} 项未完成` : '')}${tasks.length ? tasks.map(taskRow).join('') : `<div class="panel-body"><p class="field-help">暂时没有未完成的待办，随时添加下一步行动。</p></div>`}${quickTask(p.id)}<div class="task-panel-footer"><span>${s.total ? `已完成 ${s.done} / ${s.total}` : '暂无待办'}${s.cancelled ? ` · 另有 ${s.cancelled} 项取消` : ''}</span><span>行动记录</span></div></section><section class="panel">${sectionHead('正在探索',`<a class="text-link" href="#project/${p.id}/ideas">全部方向 ${icon('arrow')}</a>`,'bulb')}${ideas.length ? ideas.map(i => `<div class="idea-mini"><span class="idea-symbol">${icon('bulb')}</span><div><h3><button data-action="detail" data-type="ideas" data-id="${i.id}" class="task-title">${esc(i.title)}</button></h3><div class="meta">${tag(...es[i.state])}${integrated?tag(novelty[i.novelty]):tag(...vs[i.verdict])}</div></div>${ib('chevron','查看探索方向','detail',`data-type="ideas" data-id="${i.id}"`)}</div>`).join('') : `<div class="panel-body"><p class="field-help">还没有正在探索的方向。</p></div>`}</section></div><aside class="side-column"><section class="panel">${sectionHead('本阶段目标',ib('edit','编辑项目目标','edit-project',`data-id="${p.id}"`),'flag')}<div class="panel-body"><p class="goal-note">${esc(p.goal || '目标待补充')}</p><button class="goal-footer" data-action="project-background" data-id="${p.id}">${icon('book')}研究背景与约定 ${icon('arrowUp')}</button></div></section>${referenceSection('projects',p,true)}<section class="panel">${sectionHead('工作入口',ib('sliders','管理工作入口','work-entries',`data-id="${p.id}"`),'folder')}<div class="panel-body">${p.entries.length ? p.entries.map(e => `<div class="entry"><span class="entry-symbol">${icon(e.kind === 'local' ? 'folder' : e.kind === 'repo' ? 'git' : 'server')}</span><div class="entry-info"><strong>${esc(e.label)}</strong><small title="${esc(e.target)}">${esc(e.detail || e.target)}</small></div>${ib(e.kind === 'remote' ? 'copy' : 'arrowUp', e.kind === 'remote' ? '复制服务器路径' : `打开${e.label}`,e.kind === 'remote' ? 'copy-entry' : 'open-entry',`data-project="${p.id}" data-id="${e.id}"`)}</div>`).join('') : button('添加工作入口','work-entries',`data-id="${p.id}"`,'small full','plus')}<p class="side-footnote">工作资料仍在熟悉的位置，随时回去继续。</p></div></section><section class="panel">${sectionHead('主要结果',`<a class="text-link" href="#project/${p.id}/updates">${icon('arrow')}</a>`,'spark')}${key ? `<div class="key-mini"><div class="overline">${icon('check')}${key.review === 'reviewed' ? '已按所列检查复核' : '初步结果'}</div><h3>${esc(key.title)}</h3><p>结论仅覆盖记录中列明的条件。</p><button class="text-link" data-action="detail" data-type="updates" data-id="${key.id}">查看依据 ${icon('arrow')}</button></div>` : `<div class="panel-body"><p class="field-help">有了值得保留的结论，可以将进展标为主要结果。</p></div>`}</section><section class="panel">${sectionHead('还想弄清楚','','search')}<div class="panel-body question-list">${(p.questions || []).length ? p.questions.map((q,n) => `<div class="question-item"><span>0${n+1}</span><p>${esc(q)}</p></div>`).join('') : `<p class="field-help">在项目概览中补充待解决的问题。</p>`}</div></section></aside></div>`;
  }
  function taskRow(t) { const idea = get('ideas',t.idea); return `<div class="task-row ${t.state === 'done' ? 'done' : ''}" data-task="${t.id}"><button type="button" class="task-check ${t.state === 'done' ? 'checked' : t.state === 'cancelled' ? 'cancelled' : ''}" aria-label="${t.state === 'done' ? '重开' : t.state === 'cancelled' ? '恢复' : '完成'}待办：${esc(t.title)}" aria-pressed="${t.state === 'done'}" data-action="toggle-task" data-id="${t.id}">${t.state === 'done' ? icon('check') : t.state === 'cancelled' ? icon('minus') : ''}</button><div class="task-copy"><button class="task-title" data-action="detail" data-type="tasks" data-id="${t.id}">${esc(t.title)}</button><div class="task-subline">${idea ? `<button data-action="detail" data-type="ideas" data-id="${idea.id}">${icon('bulb')}${esc(idea.title)}</button>` : '<span>项目待办</span>'}${t.state === 'done' ? `<span>${shortDate(t.completed_at)} 完成</span>` : ''}</div></div><span class="task-status ${t.state}">${ts[t.state]}</span></div>`; }
  const quickTask = (project, idea = '') => `<form class="task-add" data-form="quick-task" data-project="${project}" data-idea="${idea}">${icon('plus')}<input name="title" aria-label="添加待办" placeholder="添加一个具体行动，回车保存…" autocomplete="off" maxlength="300" required><button class="icon-btn" type="submit" aria-label="保存待办">${icon('return')}</button></form>`;
  const segment = (items, active = filter) => `<div class="segmented" aria-label="筛选">${items.map(([value,label]) => `<button type="button" data-action="filter" data-value="${value}" class="${value === active ? 'active' : ''}" aria-pressed="${value === active}">${label}</button>`).join('')}</div>`;
  const empty = (title, body, symbol = 'search') => `<div class="empty-state">${icon(symbol)}<h3>${title}</h3><p>${body}</p></div>`;
  function ideaRow(i) { const taskCount = projectTasks(i.project).filter(t => t.idea === i.id), open = taskCount.filter(t => ['todo','doing'].includes(t.state)).length; return `<div class="idea-table-row"><div class="idea-table-title"><span class="idea-symbol">${icon('bulb')}</span><div><button data-action="detail" data-type="ideas" data-id="${i.id}">${esc(i.title)}</button><p>${esc((i.state === 'abandoned' ? i.closure_note : i.verdict_note) || excerpt(i.body) || '刚刚记下，等待探索。')}</p>${referenceSummary(i)}<small>${shortDate(i.updated_at)} 更新</small></div></div>${tag(...es[i.state])}${integrated?tag(novelty[i.novelty]):tag(...vs[i.verdict])}<button class="count-link" data-action="idea-tasks" data-id="${i.id}">${icon('tasks')}${open} / ${taskCount.filter(t=>t.state!=='cancelled').length}</button></div>`; }
  function filteredIdeas(p) { return projectIdeas(p.id).filter(item => (filter === 'all' || item.state === filter) && R.matches(item,referenceFilter) && [item.title,item.body,item.verdict_note,item.closure_note,...R.related(item).map(ref=>ref.title)].join(' ').toLowerCase().includes(query.toLowerCase())); }
  function renderIdeas(p) {
    if(integrated){const items=filteredIdeas(p);return `<div class="section-title-row"><div><h2>项目中的想法</h2><p>与“想法”共用同一条记录，判断、正文和引用会同步更新。</p></div><div class="heading-actions">${button('关联已有想法','link-existing-idea',`data-project="${p.id}"`,'','link')}${button('新建想法','new-idea',`data-project="${p.id}"`,'primary','plus')}</div></div>${!formalReady?`<div class="notice">${esc(formalError||'正在读取想法…')}${button('重新读取','refresh-ideas')}</div>`:''}<div class="toolbar reference-list-toolbar">${segment([['all','全部'],['exploring','执行中'],['pending','未开始'],['closed','已结束'],['abandoned','已放弃']])}<label class="search-box">${icon('search')}<input id="idea-search" aria-label="搜索探索方向" placeholder="搜索想法…" value="${esc(query)}"></label>${referenceFilterControl()}</div><div class="panel"><div class="idea-table-head"><span>想法与关联线索</span><span>执行状态</span><span>新颖性</span><span>未完 / 总待办</span></div><div id="idea-results">${items.length?items.map(ideaRow).join(''):empty('还没有关联的想法','新建一个想法，或把已有的独立想法关联到这个项目。')}</div></div><p class="idea-note"><a href="/ideas?project=${encodeURIComponent(p.id)}">在想法列表中查看此项目 →</a></p>`;}
    const items=filteredIdeas(p);
    return `<div class="section-title-row"><div><h2>把值得尝试的方向留下来</h2><p>可以直接记录判断，也可以拆成几个具体行动。</p></div>${button('添加探索方向','new-idea',`data-project="${p.id}"`,'primary','plus')}</div><div class="toolbar reference-list-toolbar">${segment([['all','全部'],['exploring','探索中'],['pending','待探索'],['closed','已结束'],['abandoned','已放弃'],['paused','暂缓']])}<label class="search-box">${icon('search')}<input id="idea-search" aria-label="搜索探索方向" placeholder="搜索方向与判断…" value="${esc(query)}"></label>${referenceFilterControl()}</div><div class="panel"><div class="idea-table-head"><span>探索方向</span><span>探索状态</span><span>当前判断</span><span>未完 / 总待办</span></div><div id="idea-results">${items.length?items.map(ideaRow).join(''):empty('没有匹配的探索方向','试试其他状态、关键词或关联内容。')}</div></div><p class="idea-note">${icon('info')}每个方向都保留独立的判断依据与结束理由。</p>`;
  }
  function renderTasks(p) { const s = stats(p.id), items = projectTasks(p.id).filter(t => (filter === 'all' || filter === 'open' && ['todo','doing'].includes(t.state) || t.state === filter) && (!taskIdea || t.idea === taskIdea)); return `<div class="section-title-row"><div><h2>把下一步变成具体行动</h2><p>对照、推导、计算与整理，都可以从一条待办开始。</p></div>${button('添加待办','new-task',`data-project="${p.id}"`,'primary','plus')}</div><div class="toolbar">${segment([['open','未完成'],['done','已完成'],['cancelled','已取消'],['all','全部']])}<div class="toolbar-right"><span class="task-summary">${s.total ? `已完成 <strong>${s.done} / ${s.total}</strong>` : '暂无待办'}${s.cancelled ? `<span class="separator">·</span>${s.cancelled} 项取消` : ''}</span><select id="task-idea-filter" class="task-filter-select" aria-label="按关联方向筛选"><option value="">全部探索方向</option>${projectIdeas(p.id).map(i=>`<option value="${i.id}" ${taskIdea===i.id?'selected':''}>${esc(i.title)}</option>`).join('')}</select></div></div><div class="panel tasks-full">${items.length ? items.map(taskRow).join('') : empty('这里暂时没有待办',filter==='open'?'下一步想做什么？可以直接记在下面。':'切换筛选查看其他行动。','tasks')}${quickTask(p.id)}<div class="task-panel-footer"><span>显示 ${items.length} 条待办</span><span>点击任务可补充说明与结果</span></div></div>`; }
  function resultTag(u) { return u.validity === 'withdrawn' ? tag('已撤回','red') : u.validity === 'superseded' ? tag('已被替代','amber') : tag(u.review === 'reviewed' ? '已按所列检查复核' : '初步记录',u.review === 'reviewed' ? 'green' : ''); }
  const resources = ids => ids?.length ? `<div class="resource-tiles">${ids.map(id => {const r = resourceData[id]; return r ? `<button class="resource-tile" data-action="resource" data-id="${id}">${icon(r.kind)}<span>${esc(r.title)}<small>${esc(r.subtitle)}</small></span></button>` : '';}).join('')}</div>` : '';
  function updateCard(u,p) { return `<article class="timeline-item"><div class="timeline-date"><strong>${new Date(u.occurred_at).getDate()}</strong>${new Date(u.occurred_at).getMonth()+1} 月</div><div class="panel timeline-card ${effective(u)?'':'invalid'}"><div class="timeline-card-head"><div class="tags">${u.key?tag('主要结果','green','spark'):tag('研究进展')}${resultTag(u)}${p.current===u.id?tag('当前进度','blue','pin'):''}</div>${ib('pin',p.current===u.id?'清除当前进度置顶':'置顶为当前进度','pin-update',`data-id="${u.id}"`)}</div><h3><button data-action="detail" data-type="updates" data-id="${u.id}">${esc(u.title||`${shortDate(u.occurred_at)} 的研究进展`)}</button></h3><p>${esc(excerpt(u.body))}</p>${u.validity==='superseded'?`<button class="related-link" data-action="detail" data-type="updates" data-id="${u.superseded_by}">${icon('arrow')}已由后续对照记录替代</button>`:''}${resources(u.resources)}<div class="timeline-card-foot"><span>${shortDate(u.created_at)} 记录</span>${u.ideas.slice(0,1).map(id=>{const i=get('ideas',id);return i?`<button data-action="detail" data-type="ideas" data-id="${id}">${icon('bulb')}${esc(i.title)}</button>`:''}).join('')}<button class="text-link" data-action="detail" data-type="updates" data-id="${u.id}">完整记录 ${icon('arrow')}</button></div></div></article>`; }
  function renderUpdates(p) {
    const list = projectUpdates(p.id).filter(u => (filter !== 'key' || u.key) && (showInvalid || effective(u)));
    const events = db.events.filter(x=>x.project===p.id && x.type!=='updates' && (x.progress || showActivity) && filter!=='key');
    const combined = [...list.map(u=>({time:u.created_at,html:updateCard(u,p)})), ...events.map(e=>({time:e.time,html:e.progress?`<article class="timeline-item"><div class="timeline-date"><strong>${new Date(e.time).getDate()}</strong>${new Date(e.time).getMonth()+1} 月</div><div class="panel timeline-card"><div class="timeline-card-head"><div class="tags">${tag('探索判断','blue','bulb')}${e.verdict?tag(...vs[e.verdict]):''}</div>${ib('history','查看当时版本','event-history',`data-id="${e.id}"`)}</div><h3><button data-action="detail" data-type="${e.type}" data-id="${e.target}">${esc(e.label)}</button></h3><p>${esc(e.note || '查看记录了解当时的判断。')}</p><div class="timeline-card-foot"><span>${shortDate(e.time)} · 修订 v${e.revision}</span><button class="text-link" data-action="event-history" data-id="${e.id}">当时的记录 ${icon('arrow')}</button></div></div></article>`:`<div class="activity-row">${icon('check')}${esc(e.label)}<time>${shortDate(e.time)}</time></div>`}))].sort((a,b)=>b.time.localeCompare(a.time));
    return `<div class="section-title-row"><div><h2>每一次判断，都有来处</h2><p>记录新发现、卡点与方向变化，重要的结论可以单独留下。</p></div>${button('记录进展','new-update',`data-project="${p.id}"`,'primary','plus')}</div><div class="toolbar">${segment([['all','研究记录'],['key','主要结果']])}<div class="toolbar-right"><label class="check-label"><input type="checkbox" id="show-invalid" ${showInvalid?'checked':''}>显示已替代 / 撤回</label><label class="check-label"><input type="checkbox" id="show-activity" ${showActivity?'checked':''}>显示操作记录</label></div></div><div class="timeline-layout"><div class="timeline-list">${combined.length?combined.map(x=>x.html).join(''):`<div class="panel">${empty('还没有这类研究记录','可以记录一次发现，也可以只是一个新的问题。','chart')}</div>`}</div><aside class="panel timeline-aside"><h3>记录一段有意义的变化</h3><p>不必每天更新。得到新结果、遇到卡点，或改变方向时，留下一段话就好。</p><div class="legend"><div>${icon('chart')}<p><strong>研究进展</strong>发现了什么，还不能判断什么。</p></div><div>${icon('spark')}<p><strong>主要结果</strong>从进展中选出值得继续引用的结论。</p></div><div>${icon('pin')}<p><strong>当前进度</strong>置顶最能代表项目现状的一条记录。</p></div></div></aside></div>`;
  }
  function projectMatches(p) { return (includeArchive||!p.archived) && R.matches(p,referenceFilter) && [p.title,p.goal,...R.related(p).map(ref=>ref.title)].join(' ').toLowerCase().includes(query.toLowerCase()); }
  function projectCards(list) {
    return list.length?list.map(p=>{const s=stats(p.id);return `<a class="panel project-card" href="#project/${p.id}/overview"><div class="project-card-top"><span class="project-card-icon">${icon('projects')}</span>${p.archived?tag('已归档'):tag(...ps[p.state])}</div><h2>${esc(p.title)}</h2><p>${esc(p.goal||'目标待补充')}</p>${referenceSummary(p,false)}<div class="card-footer"><span>${projectIdeas(p.id).length} 个想法 · ${s.open} 项待办</span><span>${shortDate(activityTime(p.id))} 更新 ${icon('arrow')}</span></div></a>`;}).join(''):`<div class="panel reference-list-empty">${empty(db.projects.length?'没有匹配的项目':'从第一个项目开始',db.projects.length?'试试其他关键词或关联内容。':'新建项目，或把一个值得继续推进的想法升级为项目。','projects')}</div>`;
  }
  function renderProjects() {
    const list=db.projects.filter(projectMatches);
    return `<section class="page-head simple-head collection-heading"><div><p class="eyebrow duplicate-in-english">PROJECTS</p><h1>项目</h1><p class="lead">把值得持续投入的问题，放在一个可以接着做的地方。</p></div><div class="heading-actions">${button('新建项目','new-project','','primary','plus')}</div></section><div class="toolbar reference-list-toolbar"><span class="task-summary" id="project-count">${list.length} 个项目</span><label class="search-box">${icon('search')}<input id="project-search" aria-label="搜索项目" placeholder="搜索项目或关联内容…" value="${esc(query)}"></label>${referenceFilterControl()}<label class="check-label"><input type="checkbox" id="include-archive" ${includeArchive?'checked':''}>包括已归档项目</label></div><div class="project-grid" id="project-results">${projectCards(list)}</div><div class="collection-callout">${icon('bulb')}还没有决定正式推进？先随手记录一个想法。<a class="text-link" href="/ideas">去想法 ${icon('arrow')}</a></div>`;
  }
  function standaloneMatches(i) { return !i.archived&&(!i.project||!get('projects',i.project)?.archived)&&(ideaScope==='all'||!i.project)&&R.matches(i,referenceFilter)&&[i.title,i.body,...R.related(i).map(ref=>ref.title)].join(' ').toLowerCase().includes(query.toLowerCase()); }
  function standaloneCards(list) {
    return list.length?list.map(i=>{const linked=db.projects.filter(p=>p.origin?.id===i.id);return `<article class="panel independent-card"><div class="tags">${tag(...es[i.state])}${i.project?tag(get('projects',i.project)?.title||'研究项目','blue'):tag('独立想法','outline')}${linked.length?tag('已发起项目','green'):''}</div><h2><button data-action="detail" data-type="ideas" data-id="${i.id}">${esc(i.title)}</button></h2><p>${esc(excerpt(i.body)||'这个想法还可以慢慢展开。')}</p>${referenceSummary(i)}<div class="card-footer"><span>${shortDate(i.updated_at)} 更新</span>${linked.length?`<a class="text-link" href="#project/${linked[0].id}/overview">进入项目 ${icon('arrow')}</a>`:`<button class="text-link" data-action="new-project" data-origin="${i.id}">创建研究项目 ${icon('arrow')}</button>`}</div></article>`;}).join(''):`<div class="panel reference-list-empty">${empty('没有匹配的想法','试试其他关键词、范围或关联内容。')}</div>`;
  }
  function renderStandalone() {
    const list=db.ideas.filter(standaloneMatches);
    return `<section class="page-head simple-head collection-heading"><div><div class="eyebrow">A PLACE FOR A MAYBE</div><h1>研究想法</h1><p class="lead">不必想得完整。先记下来，值得投入时再成为一个项目。</p></div>${button('记录想法','new-idea','','primary','plus')}</section><form class="quick-capture" data-form="quick-idea">${icon('bulb')}<input name="title" placeholder="此刻，有什么值得想一想？" aria-label="一句话记录想法" required maxlength="300"><button class="button ghost soft" type="submit">记下来 ${icon('return')}</button></form><div class="toolbar reference-list-toolbar"><div class="segmented"><button data-action="idea-scope" data-value="independent" class="${ideaScope==='independent'?'active':''}">独立想法</button><button data-action="idea-scope" data-value="all" class="${ideaScope==='all'?'active':''}">全部想法</button></div><span class="task-summary" id="standalone-count">${list.length} 条想法</span><label class="search-box">${icon('search')}<input id="global-idea-search" aria-label="搜索研究想法" placeholder="搜索想法或关联内容…" value="${esc(query)}"></label>${referenceFilterControl()}</div><div class="independent-grid" id="standalone-results">${standaloneCards(list)}</div>`;
  }
  // Detail drawers, forms and user actions are defined below.
  function renderContent() { const p=currentProject(); $('#workspace-content').innerHTML=route.tab==='ideas'?renderIdeas(p):route.tab==='tasks'?renderTasks(p):renderUpdates(p); }
  function options(map,value) { return Object.entries(map).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${esc(Array.isArray(v)?v[0]:v)}</option>`).join(''); }
  function inlineMarkdown(text) {
    return R.inlineTokens(text).map(token => token.kind === 'code' ? `<code>${esc(token.text)}</code>` : token.kind === 'ref' ? `<button type="button" class="inline-reference ${R.get(token.id)?.archived ? 'archived' : ''}" data-action="reference-preview" data-id="${esc(token.id)}" data-label="${esc(token.title)}" title="查看${esc(R.get(token.id)?.title || token.title)}">${icon(R.get(token.id)?.kind === 'material' ? 'book' : 'layers')}${esc(token.title)}${R.get(token.id)?.archived ? '<small>已归档</small>' : ''}</button>` : esc(token.text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')).join('');
  }
  function markdown(body) {
    const lines=String(body||'').split('\n');let result='',paragraph=[],list=[],code=null,fence=null;
    const flush=()=>{if(paragraph.length){result+=`<p>${inlineMarkdown(paragraph.join('\n'))}</p>`;paragraph=[];}if(list.length){result+=`<ul>${list.map(x=>`<li>${inlineMarkdown(x)}</li>`).join('')}</ul>`;list=[];}};
    for(const line of lines){const marker=line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);if(code!==null){if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim()){result+=`<pre>${esc(code.join('\n'))}</pre>`;code=null;fence=null;}else code.push(line);continue;}if(marker){flush();code=[];fence={char:marker[1][0],length:marker[1].length};continue;}if(!line.trim()){flush();continue;}if(line.startsWith('$$')&&line.endsWith('$$')){flush();const expr=line.slice(2,-2).trim();result+=expr==='C(t) = \\langle S^z(t) S^z(0) \\rangle'?'<div class="formula"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>C</mi><mo>(</mo><mi>t</mi><mo>)</mo><mo>=</mo><mo>⟨</mo><msup><mi>S</mi><mi>z</mi></msup><mo>(</mo><mi>t</mi><mo>)</mo><msup><mi>S</mi><mi>z</mi></msup><mo>(</mo><mn>0</mn><mo>)</mo><mo>⟩</mo></math></div>':`<pre>${esc(line)}</pre>`;continue;}const h=line.match(/^#{1,6}\s+(.*)/);if(h){flush();result+=`<h3>${inlineMarkdown(h[1])}</h3>`;}else if(/^[-*]\s/.test(line)){if(paragraph.length)flush();list.push(line.slice(2));}else if(line.startsWith('> ')){flush();result+=`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`;}else{if(list.length)flush();paragraph.push(line);}}
    flush();if(code!==null)result+=`<pre>${esc(code.join('\n'))}</pre>`;return result||'<p class="muted">还没有正文，可以随时补充。</p>';
  }
  function openDetail(type,id) { if(integrated && type==='ideas'){if(id.startsWith('idea_'))location.assign('/ideas/'+encodeURIComponent(id));else{toast('这是一条旧浏览器想法，可在想法页选择导入。');location.assign('/ideas');}return;}  if(!get(type,id)){toast('这条记录暂时不可用。');return;}detailState={type,id};renderDetail();if(!$('#detail').open)$('#detail').showModal(); }
  function renderDetail() {
    const {type,id}=detailState,item=get(type,id);if(!item)return;const p=get('projects',item.project),linked=type==='ideas'?db.projects.filter(x=>x.origin?.id===id):[];
    let content='',footer='';
    if(type==='ideas'){
      const tasks=projectTasks(item.project).filter(t=>t.idea===id),terminal=['closed','abandoned'].includes(item.state);
      content=`${linked.length?`<div class="notice blue">${icon('projects')}已发起项目：<a href="#project/${linked[0].id}/overview">${esc(linked[0].title)} ${icon('arrow')}</a></div>`:''}<section class="drawer-section"><div class="section-heading">当前判断<button class="text-link" data-action="decision" data-id="${id}" data-mode="judgment">记录新判断 ${icon('edit')}</button></div><div class="decision-card ${vs[item.verdict][1]}"><div class="decision-header"><strong>${vs[item.verdict][0]}</strong>${icon('target')}</div><p>${esc(item.verdict_note||'还没有形成判断，可以先开始探索。')}</p>${item.verdict!=='unassessed'?'<div class="conditions">判断以这里列明的证据和适用条件为准。</div>':''}</div>${item.closure_note?`<div class="reason-card"><h4>${item.state==='abandoned'?'放弃理由':terminal?'本轮结束说明':'上一轮结束说明'}</h4><p>${esc(item.closure_note)}</p></div>`:''}</section>${referenceSection('ideas',item)}<section class="drawer-section"><h3>想法与讨论</h3><div class="rich-text">${markdown(item.body)}</div></section>${p?`<section class="drawer-section"><div class="section-heading">关联待办 <span>${tasks.filter(t=>t.state==='done').length} / ${tasks.filter(t=>t.state!=='cancelled').length} 已完成</span></div><div class="drawer-tasks">${tasks.map(taskRow).join('')}${quickTask(p.id,id)}</div></section>`:''}<section class="drawer-section"><details class="details-box"><summary>新颖性与实现难度</summary><div class="two-cols"><div><h4>新颖性 · ${novelty[item.novelty]}</h4><p>${esc(item.novelty_reason||'尚未补充说明。')}</p></div><div><h4>实现难度 · ${difficulty[item.difficulty]}</h4><p>${esc(item.difficulty_reason||'尚未补充说明。')}</p></div></div></details>${resources(item.resources)}</section>`;
      footer=`<div>${ib('history','查看修订历史','history',`data-type="ideas" data-id="${id}"`)}${button('编辑','edit-idea',`data-id="${id}"`,'','edit')}${ib('more','更多探索操作','idea-more',`data-id="${id}"`)}</div><div>${terminal?button('重新探索','reopen-idea',`data-id="${id}"`,'primary','return'):item.state==='exploring'?button('结束探索','decision',`data-id="${id}" data-mode="close"`,'primary','check'):button('开始探索','start-idea',`data-id="${id}"`,'primary','play')}</div>`;
    }else if(type==='tasks'){
      const i=get('ideas',item.idea);content=`<section class="drawer-section"><h3>任务说明</h3><div class="rich-text">${markdown(item.body)}</div></section>${i?`<section class="drawer-section"><h3>关联探索方向</h3><div class="decision-card"><button class="text-link" data-action="detail" data-type="ideas" data-id="${i.id}">${icon('bulb')}${esc(i.title)} ${icon('arrow')}</button><p>${vs[i.verdict][0]}${i.verdict_note?' · '+esc(i.verdict_note):''}</p></div></section>`:''}${resources(item.resources)}${item.completed_at?`<div class="detail-meta">完成于 ${fullDate(item.completed_at)}</div>`:''}`;
      footer=`<div>${ib('history','查看修订历史','history',`data-type="tasks" data-id="${id}"`)}${button('编辑待办','edit-task',`data-id="${id}"`,'','edit')}</div>${button(item.state==='done'?'重新打开':item.state==='cancelled'?'恢复待办':'标记完成','toggle-task',`data-id="${id}"`,'primary',item.state==='done'?'return':'check')}`;
    }else{
      const replacement=get('updates',item.superseded_by);content=`${!effective(item)?`<div class="notice ${item.validity==='withdrawn'?'danger':''}">${icon('warning')}<div>${item.validity==='withdrawn'?'这条记录已撤回。':'这条记录已被后续结果替代。'}${item.status_note?`<br>${esc(item.status_note)}`:''}${replacement?`<br><button class="text-link" data-action="detail" data-type="updates" data-id="${replacement.id}">${esc(replacement.title)} ${icon('arrow')}</button>`:''}</div></div>`:''}<div class="rich-text">${markdown(item.body)}</div>${item.review==='reviewed'&&item.review_note?`<div class="decision-card green"><strong>复核范围</strong><p>${esc(item.review_note)}</p></div>`:''}${resources(item.resources)}${item.ideas.length?`<section class="drawer-section" style="margin-top:24px"><h3>相关探索</h3>${item.ideas.map(i=>get('ideas',i)).filter(Boolean).map(i=>`<button class="related-link" data-action="detail" data-type="ideas" data-id="${i.id}">${icon('bulb')}${esc(i.title)} ${icon('arrow')}</button>`).join('')}</section>`:''}<div class="detail-meta">发生于 ${shortDate(item.occurred_at)} · 记录于 ${fullDate(item.created_at)}</div>`;
      footer=`<div>${ib('history','查看修订历史','history',`data-type="updates" data-id="${id}"`)}${button('编辑','edit-update',`data-id="${id}"`,'','edit')}${button('结果状态','result-status',`data-id="${id}"`,'')}</div><div>${ib('spark',item.key?'取消主要结果标记':'标为主要结果','toggle-key',`data-id="${id}"`)}${button(p?.current===id?'取消置顶':'设为当前进度','pin-update',`data-id="${id}"`,'primary','pin')}</div>`;
    }
    $('#detail').innerHTML=`<div class="drawer-head"><div class="overline"><span>${p?esc(p.title):'独立想法'} / ${type==='ideas'?'探索方向':type==='tasks'?'待办':'研究进展'}</span>${ib('close','关闭详情','close-detail')}</div><h2 id="detail-title">${esc(item.title||`${shortDate(item.created_at)} 的研究进展`)}</h2><div class="tags">${type==='ideas'?tag(...es[item.state])+tag(...vs[item.verdict]):type==='tasks'?tag(ts[item.state],item.state==='done'?'green':'blue'):resultTag(item)+(item.key?tag('主要结果','green','spark'):'')}${type!=='updates'?`<small class="muted">${shortDate(item.updated_at)} 更新</small>`:''}</div></div><div class="drawer-body">${content}</div><div class="drawer-footer">${footer}</div>`;
  }
  const field = (label,name,value='',opts={}) => `<label class="field ${opts.title?'title-field':''}"><span>${label}${opts.optional?'<small>可选</small>':''}</span>${opts.area?`<textarea name="${name}" rows="${opts.rows||3}" ${opts.required?'required':''} placeholder="${esc(opts.placeholder||'')}" maxlength="30000">${esc(value)}</textarea>`:`<input name="${name}" type="${opts.type||'text'}" value="${esc(value)}" ${opts.required?'required':''} placeholder="${esc(opts.placeholder||'')}" maxlength="${opts.title?300:2000}">`}${opts.help?`<p class="field-help">${opts.help}</p>`:''}</label>`;
  const selectField=(label,name,map,value)=>`<label class="field"><span>${label}</span><select name="${name}">${options(map,value)}</select></label>`;
  function formValues(form) { const values={};for(const e of form.elements){if(!e.name)continue;if(e.name==='related_refs'){try{const refs=JSON.parse(e.value);values[e.name]=Array.isArray(refs)?[...new Set(refs.filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id)))]:[];}catch{values[e.name]=[];}}else if(e.type==='radio'){if(e.checked)values[e.name]=e.value;}else values[e.name]=e.type==='checkbox'?e.checked:e.value;}return values; }
  function showModal(title,subtitle,body,actions='',wide=false) {
    formState=null;const modal=$('#modal');modal.className=`modal ${wide?'wide':''}`;modal.innerHTML=`<div class="modal-head"><div><h2 id="modal-title">${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div>${ib('close','关闭对话框','close-modal')}</div><div class="modal-body">${body}</div>${actions?`<div class="modal-actions">${actions}</div>`:''}`;if(!modal.open)modal.showModal();
  }
  function openForm(key,title,subtitle,body,onSave,label='保存',wide=false) {
    const modal=$('#modal');modal.className=`modal ${wide?'wide':''}`;
    modal.innerHTML=`<form id="editor-form" data-form="editor"><div class="modal-head"><div><h2 id="modal-title">${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div>${ib('close','关闭对话框','close-modal')}</div><div class="modal-body">${body}<p class="form-error" id="form-error" role="alert"></p></div><div class="modal-actions"><span class="draft-status" id="draft-status"></span>${button('取消','close-modal')}<button class="button primary-button" type="submit">${label}</button></div></form>`;
    const form=$('#editor-form');enhanceReferenceEditor(form,key);const baseline=formValues(form);formState={key,onSave,baseline};
    if(drafts[key]) {for(const e of form.elements){if(!e.name||!Object.hasOwn(drafts[key],e.name))continue;const v=drafts[key][e.name];if(e.type==='checkbox')e.checked=v===true;else if(e.type==='radio')e.checked=e.value===v;else e.value=e.name==='related_refs'?JSON.stringify(v):v;}$('#draft-status').textContent='已恢复上次草稿';}
    refreshEditorReferences();
    if(!modal.open)modal.showModal();
  }
  function persistDraft() {
    if(!formState||!$('#editor-form'))return;
    const values=formValues($('#editor-form'));
    if(JSON.stringify(values)===JSON.stringify(formState.baseline))delete drafts[formState.key];else drafts[formState.key]=values;
    try{localStorage.setItem(DRAFT_KEY,JSON.stringify(drafts));$('#draft-status').textContent=drafts[formState.key]?'草稿已保留':'';}catch{$('#draft-status').textContent='草稿暂未保存';}
  }
  function closeModal() {if(projectBusy)return;const hasDraft=formState&&drafts[formState.key];formState=null;$('#modal').close();if(hasDraft)toast('草稿已保留，下次打开可继续。');}
  function formError(message){$('#form-error').textContent=message;return false;}
  function historyBody(type,item) { let lines=[];if(type==='ideas')lines=[`探索状态：${es[item.state][0]}`,`当前判断：${vs[item.verdict][0]}`,`判断依据：${item.verdict_note||'未填写'}`,`结束／放弃理由：${item.closure_note||'未填写'}`,`新颖性：${novelty[item.novelty]} · ${item.novelty_reason||'无说明'}`,`实现难度：${difficulty[item.difficulty]} · ${item.difficulty_reason||'无说明'}`];else if(type==='tasks')lines=[`任务状态：${ts[item.state]}`,`完成时间：${item.completed_at?fullDate(item.completed_at):'未完成'}`];else if(type==='updates')lines=[`主要结果：${item.key?'是':'否'}`,`有效状态：${({valid:'有效',withdrawn:'已撤回',superseded:'已被替代'})[item.validity]}`,`状态说明：${item.status_note||'未填写'}`,`复核范围：${item.review_note||'未填写'}`,`替代记录：${get('updates',item.superseded_by)?.title||'无'}`];else lines=[`项目状态：${ps[item.state][0]}`,`目标：${item.goal||''}`,`下一步：${item.next||''}`];if(['projects','ideas'].includes(type))lines.push(`相关知识与材料：${R.related(item).map(ref=>ref.title).join('、')||'无'}`);return `${esc(item.title||'研究进展')}\n\n${esc(lines.join('\n'))}\n\n${esc(item.body||'')}`; }
  function showHistory(type,id,revision=null){const item=get(type,id),list=(db.history[`${type}:${id}`]||[]).filter(x=>!revision||x.revision===revision).toReversed();showModal(revision?'当时的记录':'修订历史',esc(item?.title||'研究记录'),list.map((r,n)=>`<details class="history-entry" ${n===0?'open':''}><summary><strong>v${r.revision}</strong>${esc(r.action_label||'保存')} · ${fullDate(r.updated_at)}</summary><div class="history-body">${historyBody(type,r)}</div></details>`).join('')||'<p class="field-help">暂无记录。</p>',button('完成','close-modal'),'wide');}
  function editIdea(id,project=null){if(integrated){location.assign(id?'/ideas/'+encodeURIComponent(id):'/ideas/new'+(project?'?project='+encodeURIComponent(project):''));return;}const item=id?get('ideas',id):{id:uid('i'),project,title:'',body:'',state:'pending',verdict:'unassessed',verdict_note:'',closure_note:'',novelty:'unknown',novelty_reason:'',difficulty:'unknown',difficulty_reason:'',resources:[]};openForm(id?`edit-idea:${id}`:`new-idea:${project||'independent'}`,id?'编辑探索想法':project?'添加探索方向':'记录一个想法',project||item.project?esc(get('projects',project||item.project).title):'一句话就能开始，其余内容可以慢慢补充。',`${field('一句话总结','title',item.title,{required:true,title:true,placeholder:'例如：是否可以从一个可解析极限理解这个现象？'})}${field('自由讨论','body',item.body,{optional:true,area:true,rows:5,placeholder:'可以写假设、线索，或还没有想清楚的问题…'})}<details class="optional-fields"><summary>新颖性与实现难度</summary><div class="two-cols">${selectField('新颖性','novelty',novelty,item.novelty)}${selectField('实现难度','difficulty',difficulty,item.difficulty)}</div>${field('新颖性说明','novelty_reason',item.novelty_reason,{optional:true,area:true,rows:2})}${field('难度说明','difficulty_reason',item.difficulty_reason,{optional:true,area:true,rows:2})}</details>`,async v=>{if(!v.title.trim())return formError('写下一句话总结即可。');const candidate={...item,...v,title:v.title.trim()};if(await saveTransaction(next=>put(next,'ideas',candidate,id?'编辑想法':'添加探索方向'))){toast(id?'想法已保存。':'已记下这个方向。');openDetail('ideas',item.id);return true;}return false;},id?'保存修改':'记下来');}
  function editTask(id,project,idea=''){
    const item=id?get('tasks',id):{id:uid('t'),project,idea:idea||null,title:'',body:'',state:'todo',completed_at:null,order:projectTasks(project).length,resources:[]};project=item.project;
    openForm(id?`edit-task:${id}`:`new-task:${project}:${idea}` ,id?'编辑待办':'添加待办',esc(get('projects',project).title),`${field('具体做什么','title',item.title,{required:true,title:true,placeholder:'例如：完成边界条件对照并生成比较图'})}<div class="two-cols">${selectField('任务状态','state',ts,item.state)}<label class="field"><span>关联探索方向 <small>可选</small></span><select name="idea"><option value="">项目待办，不关联方向</option>${projectIdeas(project).map(i=>`<option value="${i.id}" ${i.id===item.idea?'selected':''}>${esc(i.title)}</option>`).join('')}</select></label></div>${field('简要说明','body',item.body,{optional:true,area:true,rows:5,placeholder:'完成标准、目前的卡点，或完成后留下的说明。'})}`,async v=>{if(!v.title.trim())return formError('请写下具体行动。');const completed_at=v.state==='done'?(item.state==='done'?item.completed_at:now()):null;const candidate={...item,...v,title:v.title.trim(),idea:v.idea||null,completed_at};if(await saveTransaction(next=>put(next,'tasks',candidate,id?'更新待办':'添加待办'))){toast(id?'待办已保存。':'待办已添加。');return true;}return false;},id?'保存修改':'添加待办');
  }
  function editProject(id){const p=get('projects',id);openForm(`project:${id}`,'项目概览',esc(p.title),`${field('项目名称','title',p.title,{required:true,title:true})}${field('本阶段目标','goal',p.goal,{area:true,rows:2,optional:true})}${field('当前重点','focus',p.focus,{optional:true})}${field('主要卡点','blocker',p.blocker,{optional:true})}${field('下一步','next',p.next,{optional:true})}<details class="optional-fields"><summary>研究背景与待解决问题</summary>${field('研究背景与约定','body',p.body,{area:true,rows:6,optional:true})}${field('还想弄清楚的问题','questions',(p.questions||[]).join('\n'),{area:true,rows:3,optional:true,help:'每行记录一个问题。'})}</details>`,async v=>{if(!v.title.trim())return formError('项目需要一个名称。');if(await update('projects',id,{...v,title:v.title.trim(),questions:v.questions.split('\n').map(x=>x.trim()).filter(Boolean)},'修改项目概览')){toast('项目概览已更新。');return true;}return false;});}
  function newProject(origin,force=false){const source=get('ideas',origin),existing=origin?db.projects.find(p=>p.origin?.id===origin):null;
    if(existing&&!force){showModal('这个想法已经发起项目',esc(source.title),`<div class="decision-card"><strong>${esc(existing.title)}</strong><p>${esc(existing.goal||'目标待补充')}</p></div>`,button('另起一个项目','new-project',`data-origin="${origin}" data-force="true"`)+`<a class="button primary-button" href="#project/${existing.id}/overview" data-action="close-modal">进入已有项目 ${icon('arrow')}</a>`);return;}
    const id=uid('p');openForm(`new-project:${origin||'direct'}`,source?'升级为项目':'创建项目',source?'创建一个项目来持续推进。原想法、知识引用、附件与历史完整保留，并自动关联到项目。':'先为值得持续研究的问题取一个名字。',`${source?`<div class="notice blue">${icon('bulb')}来源想法：${esc(source.title)} · v${source.revision}</div>`:''}${field('项目名称','title',source?.title||'',{title:true,required:true,placeholder:'准备持续研究的问题'})}${field('本阶段目标','goal','',{optional:true,area:true,rows:3,placeholder:'这一次，最想弄清楚什么？'})}${field('下一步行动','next','',{optional:true,placeholder:'从一个具体的小行动开始'})}<p class="field-help">目录、代码仓库和详细计划，可以在项目里慢慢补充。${integrated?'项目会保存在当前 Persona，可从其他设备继续。':''}</p>`,async v=>{if(!v.title.trim())return formError('请填写项目名称。');const p={id,title:v.title.trim(),goal:v.goal,state:'active',subtitle:'',focus:'',blocker:'',next:v.next,body:'',current:null,origin:source?{id:source.id,revision:source.revision}:null,entries:[],questions:[]};if(await saveTransaction(next=>put(next,'projects',p,'创建项目'))){location.hash=`project/${id}/overview`;if(integrated&&source?.id.startsWith('idea_')){try{await formalRequest('/api/ideas/'+source.id,{expected_revision:source.revision,values:{project:{id,title:p.title}}});await refreshFormalIdeas();toast('项目已创建，并已关联来源想法。');}catch(error){toast('项目已保存；来源想法关联未完成：'+error.message+' 请回到想法页关联此项目。');}}else toast('项目已创建。');return true;}return false;},'创建项目');
  }
  function projectStatus(id){const p=get('projects',id),s=stats(id);openForm(`project-status:${id}`,'项目状态',esc(p.title),`<div class="choice-group">${Object.entries(ps).map(([k,v])=>`<label class="choice"><input type="radio" name="state" value="${k}" ${k===p.state?'checked':''}>${v[0]}</label>`).join('')}</div>${s.open?`<div class="notice blue">${icon('tasks')}还有 ${s.open} 项未完成的待办，可以保留到以后继续。</div><label class="check-label"><input type="checkbox" name="cancel_tasks">结项或停止时，同时取消这些未完成待办</label>`:''}${field('阶段说明','note','',{area:true,rows:3,optional:true,placeholder:'留下目前做到的地方与仍未解决的问题。'})}<label class="check-label"><input type="checkbox" name="archived" ${p.archived?'checked':''}>归档项目，从默认列表中收起</label>`,async v=>{if(await saveTransaction(next=>{put(next,'projects',{...p,state:v.state,archived:v.archived},'变更项目状态',false,v.note);if(v.cancel_tasks&&['completed','stopped'].includes(v.state))for(const task of next.tasks.filter(t=>t.project===id&&['todo','doing'].includes(t.state)))put(next,'tasks',{...task,state:'cancelled',completed_at:null},'取消待办');})){toast('项目状态已更新。');return true;}return false;},'保存状态');}
  function decision(id,mode){const i=get('ideas',id),abandon=mode==='abandon',close=mode==='close',tasks=projectTasks(i.project).filter(t=>t.idea===id&&['todo','doing'].includes(t.state));
    const title=abandon?'放弃这个方向':close?'结束本轮探索':'记录新判断';
    openForm(`decision:${id}:${mode}`,title,esc(i.title),`${abandon?`<div class="decision-card ${vs[i.verdict][1]}"><strong>已有判断 · ${vs[i.verdict][0]}</strong><p>${esc(i.verdict_note||'尚未形成判断。')}</p></div><p class="field-help" style="margin-bottom:18px">保留已有判断，记下这次为什么不继续。</p>`:`${selectField('当前判断','verdict',vs,i.verdict)}${field('判断依据与适用条件','verdict_note',i.verdict_note,{area:true,rows:4,optional:close,placeholder:'有哪些证据？结论只适用于哪些范围？'})}`}${close||abandon?field(abandon?'为什么放弃这个方向？':'本轮为什么结束？','closure_note','',{area:true,rows:3,required:true,placeholder:abandon?'例如：方向可行，但投入超出本阶段预算。':'一句话就好，留下本轮的收获或结束原因。'}):''}${(close||abandon)&&tasks.length?`<div class="pending-tasks"><h4>还有 ${tasks.length} 项关联待办</h4><ul>${tasks.map(t=>`<li>${esc(t.title)}</li>`).join('')}</ul><label class="check-label"><input type="checkbox" name="cancel_tasks">同时取消以上待办</label><p class="field-help">未勾选时保留，之后仍可继续执行。</p></div>`:''}`,async v=>{if((close||abandon)&&!v.closure_note.trim())return formError('请用一句话留下结束或放弃的理由。');if(!close&&!abandon&&!v.verdict_note.trim())return formError('请简要说明这次判断的依据。');const candidate={...i,state:abandon?'abandoned':close?'closed':i.state,verdict:abandon?i.verdict:v.verdict,verdict_note:abandon?i.verdict_note:v.verdict_note,closure_note:close||abandon?v.closure_note:i.closure_note};if(await saveTransaction(next=>{put(next,'ideas',candidate,abandon?'放弃方向':close?'结束探索':'记录新判断',true,abandon?v.closure_note:v.verdict_note||v.closure_note);if(v.cancel_tasks)for(const task of tasks)put(next,'tasks',{...task,state:'cancelled',completed_at:null},'取消待办');})){toast(abandon?'已记录放弃理由，已有判断仍保留。':close?'本轮探索已结束。':'新判断已记录。');return true;}return false;},abandon?'记录并放弃':close?'结束探索':'保存判断');
  }
  function editUpdate(id,project,pin=false){const item=id?get('updates',id):{id:uid('u'),project,title:'',body:'',key:false,validity:'valid',review:'preliminary',superseded_by:null,status_note:'',review_note:'',ideas:[],tasks:[],resources:[],occurred_at:now()};project=item.project;const p=get('projects',project),date=new Date(item.occurred_at).toLocaleDateString('en-CA');
    openForm(id?`update:${id}`:`new-update:${project}`,id?'编辑研究进展':'记录研究进展',esc(p.title),`${field('简短标题','title',item.title,{optional:true,title:true,placeholder:'这次最值得留下的变化是什么？'})}${field('这次有了什么进展？','body',item.body,{required:true,area:true,rows:8,placeholder:'获得了什么结果？\n改变了什么判断，还有哪些限制？\n下一步准备做什么？',help:'支持 Markdown。可以记录发现、卡点，也可以是一段阶段总结。'})}<div class="two-cols">${field('研究发生日期','occurred_date',date,{type:'date',required:true})}<div class="field"><span>展示方式</span><label class="check-label" style="margin:12px 0"><input type="checkbox" name="key" ${item.key?'checked':''}>标为主要结果</label><label class="check-label"><input type="checkbox" name="pin" ${p.current===item.id||pin?'checked':''}>设为当前进度</label></div></div><details class="optional-fields"><summary>关联探索方向</summary>${projectIdeas(project).map(i=>`<label class="check-label" style="margin:10px 0"><input type="checkbox" name="idea:${i.id}" ${item.ideas.includes(i.id)?'checked':''}>${esc(i.title)}</label>`).join('')||'<p class="field-help">项目尚未添加探索方向。</p>'}</details>`,async v=>{if(!v.body.trim())return formError('写下一段进展后再保存。');if(v.pin&&!effective(item))return formError('这条记录已失效，请选择有效的进展置顶。');const occurred_at=v.occurred_date===date?item.occurred_at:new Date(`${v.occurred_date}T12:00:00`).toISOString();const candidate={...item,title:v.title.trim(),body:v.body.trim(),key:v.key,occurred_at,ideas:Object.entries(v).filter(([k,selected])=>k.startsWith('idea:')&&selected).map(([k])=>k.slice(5))};if(await saveTransaction(next=>{put(next,'updates',candidate,id?'修订研究进展':'记录研究进展',!id);if(v.pin&&p.current!==item.id)put(next,'projects',{...p,current:item.id},'置顶当前进度');else if(!v.pin&&p.current===item.id)put(next,'projects',{...p,current:null},'清除当前进度');})){toast(id?'进展已保存。':'研究进展已记录。');if(id)renderDetail();return true;}return false;},id?'保存修改':'保存进展');
  }
  function setResultStatus(id){
    const u=get('updates',id),others=projectUpdates(u.project).filter(x=>x.id!==id&&effective(x));
    openForm(`result:${id}`,'结果状态',esc(u.title),`${selectField('这条记录目前是否有效','validity',{valid:'当前有效',superseded:'已被后续结果替代',withdrawn:'已撤回'},u.validity)}<label class="field" id="replacement-field"><span>替代它的进展</span><select name="superseded_by"><option value="">选择同项目的后续进展</option>${others.map(x=>`<option value="${x.id}" ${x.id===u.superseded_by?'selected':''}>${esc(x.title||shortDate(x.created_at))}</option>`).join('')}</select></label>${field('替代或撤回的原因','status_note',u.status_note,{area:true,rows:2,placeholder:'选择替代或撤回时，请留下原因。',optional:true})}${selectField('复核情况','review',{preliminary:'初步记录',reviewed:'已按所列检查复核'},u.review)}${field('已复核的范围','review_note',u.review_note,{area:true,rows:2,placeholder:'已检查哪些尺寸、精度或适用条件？',optional:true})}<div class="notice blue">${icon('info')}复核范围与撤回原因分别保留；调整“主要结果”标记不改变它们。</div>`,async v=>{
      if(v.validity==='superseded'&&!v.superseded_by)return formError('请选择替代它的进展。');
      if(v.validity!=='valid'&&!v.status_note.trim())return formError('请留下替代或撤回的原因。');
      let target=v.validity==='superseded'?v.superseded_by:null;const seen=new Set([id]);
      while(target){if(seen.has(target))return formError('替代关系不能形成循环。');seen.add(target);target=get('updates',target)?.superseded_by;}
      if(await update('updates',id,{validity:v.validity,review:v.review,status_note:v.status_note,review_note:v.review_note,superseded_by:v.validity==='superseded'?v.superseded_by:null},'修改结果状态')){toast('结果状态已保存。');return true;}return false;
    },'保存状态');$('#replacement-field').hidden=$('#editor-form').elements.validity.value!=='superseded';
  }
  function workEntries(id){const p=get('projects',id),local=p.entries.find(x=>x.kind==='local'),repo=p.entries.find(x=>x.kind==='repo'),remote=p.entries.find(x=>x.kind==='remote');openForm(`entries:${id}`,'项目工作入口','保留实际工作的位置，方便下次继续。',`${field('本机工作目录','local',local?.target||'',{optional:true,placeholder:'~/Research/my-project',help:'保存路径，方便在对应电脑上定位；手机端可复制路径。'})}${field('代码仓库','repo',repo?.target||'',{optional:true,placeholder:'https://github.com/…'})}${field('服务器目录','remote',remote?.target||'',{optional:true,placeholder:'/research/my-project/runs'})}`,async v=>{if(v.repo.trim()){try{const u=new URL(v.repo);if(!['http:','https:'].includes(u.protocol))throw Error();}catch{return formError('代码仓库请填写 HTTP(S) 链接。');}}const entries=[['local',v.local,'本机工作目录','Mac · 主目录'],['repo',v.repo,'项目代码仓库','代码仓库'],['remote',v.remote,'计算服务器','服务器 · 结果目录']].filter(x=>x[1].trim()).map(([kind,target,label,detail])=>({id:p.entries.find(e=>e.kind===kind)?.id||uid('w'),kind,target:target.trim(),label,detail}));if(await update('projects',id,{entries},'更新工作入口')){toast('工作入口已保存。');return true;}return false;});}
  async function copyText(text){try{await navigator.clipboard.writeText(text);toast('已复制。');return true;}catch{showModal('复制内容','可以选中以下文本手动复制。',`<textarea class="context-output" readonly aria-label="可复制文本">${esc(text)}</textarea>`,button('完成','close-modal'));$('.context-output').select();return false;}}
  function contextText(p,opts){const lines=[`# ${p.title}`,''];if(opts.goal)lines.push('## 当前目标',p.goal||'目标待补充',`当前重点：${p.focus||'待补充'}`,`主要卡点：${p.blocker||'暂无记录'}`,`下一步：${p.next||'待补充'}`,'');const current=get('updates',p.current);if(opts.current&&current)lines.push(`## 当前进度${effective(current)?'':'（已失效，需要更新）'}`,`记录于 ${fullDate(current.created_at)}`,current.body,'');if(opts.results){lines.push('## 当前有效的主要结果');for(const u of projectUpdates(p.id).filter(x=>x.key&&effective(x)))lines.push(`### ${u.title}`,`发生于 ${shortDate(u.occurred_at)} · ${u.review==='reviewed'?'已按所列检查复核':'初步结果'}`,u.body,u.review_note||'','');}if(opts.ideas){lines.push('## 探索方向');for(const i of projectIdeas(p.id))lines.push(`### ${i.title}`,integrated?`执行状态：${es[i.state][0]}；新颖性：${novelty[i.novelty]}；实现难度：${difficulty[i.difficulty]}`:`探索状态：${es[i.state][0]}；当前判断：${vs[i.verdict][0]}`,integrated?`新颖性说明：${i.novelty_reason||'未填写'}\n难度说明：${i.difficulty_reason||'未填写'}`:`判断依据：${i.verdict_note||'未填写'}`,integrated?i.body:'',i.closure_note?`结束／放弃理由：${i.closure_note}`:'','');}if(opts.tasks){lines.push('## 下一步行动');for(const t of projectTasks(p.id).filter(x=>['todo','doing'].includes(x.state)))lines.push(`- [ ] ${t.title}（${ts[t.state]}）${t.body?'：'+t.body:''}`);lines.push('');}if(opts.questions)lines.push('## 待解决问题',...(p.questions||[]).map(q=>`- ${q}`),'');if(opts.history){lines.push('## 历史结果（已失效，不作为当前结论）');for(const u of projectUpdates(p.id).filter(x=>!effective(x)))lines.push(`### ${u.title}（${u.validity==='superseded'?'已被替代':'已撤回'}）`,u.body,`原因：${u.status_note}`,u.superseded_by?`替代记录：${get('updates',u.superseded_by)?.title||u.superseded_by}`:'','');}if(opts.references){lines.push('## 关联知识与材料');for(const owner of [p,...(opts.ideas?projectIdeas(p.id):[])]){const refs=R.related(owner);if(refs.length){lines.push(`### 来自：${owner.title}`);for(const ref of refs)lines.push(`- ${ref.title}${ref.record?.archived?'（已归档）':''}${ref.record?' · '+ref.record.path:'（条目暂不可用）'}`);lines.push('');}}}if(opts.links)lines.push('## 网页入口',...p.entries.filter(e=>e.kind==='repo').map(e=>`${e.label}：${e.target}`),'');if(opts.paths)lines.push('## 工作目录',...p.entries.filter(e=>e.kind!=='repo').map(e=>`${e.label}：${e.target}`),'');return lines.filter(x=>x!==undefined).join('\n');}
  function showContext(id){const p=get('projects',id);showModal('复制项目上下文','选择这次讨论需要的内容，预览后再复制。',`<div class="context-grid"><div class="context-options" id="context-options" data-project="${id}"><h3>本次包含</h3>${[['goal','目标与下一步',true],['current','当前进度',true],['results','有效主要结果',true],['ideas','探索方向与判断',true],['tasks','未完成待办',true],['questions','待解决问题',true],['references','关联知识与材料',false],['history','历史失效结果',false],['links','网页与仓库链接',false],['paths','本机与服务器路径',false]].map(([key,label,checked],n)=>`${n===6?'<div class="option-divider"></div>':''}<label><input type="checkbox" name="${key}" ${checked?'checked':''}>${label}</label>`).join('')}</div><div><textarea id="context-output" class="context-output" readonly aria-label="项目上下文预览"></textarea><p class="context-footer-note">在此预览、复制。你决定何时、向哪个 AI 提供这些内容。</p></div></div>`,button('下载 Markdown','download-context','','','download')+button('复制上下文','copy-context','','primary','copy'),true);refreshContext();}
  function refreshContext(){const root=$('#context-options');if(!root)return;const opts=Object.fromEntries($$('input',root).map(e=>[e.name,e.checked]));$('#context-output').value=contextText(get('projects',root.dataset.project),opts);}
  function download(name,text){const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function resource(id){const r=resourceData[id];if(!r)return;const figure=`<div class="figure-preview"><svg viewBox="0 0 490 270" role="img" aria-label="虚构演示：两种边界条件下关联函数随时间衰减的示意曲线"><g stroke="#e4eaf5" stroke-width="1"><path d="M55 35v190h405M55 65h405M55 115h405M55 165h405"/></g><g fill="#94a2b9" font-family="system-ui" font-size="10"><text x="20" y="42">C(t)</text><text x="440" y="250">t / t₀</text><text x="46" y="242">0</text><text x="44" y="69">1</text><text x="242" y="27">开放边界</text><text x="343" y="27">周期边界</text></g><path d="M219 23h17" stroke="#6e89da" stroke-width="2"/><path d="M319 23h17" stroke="#65a592" stroke-width="2" stroke-dasharray="4 3"/><path d="M55 57 C74 92 79 134 99 121S127 104 146 145S170 161 193 156S224 169 248 176S281 175 305 183S350 192 378 195S421 198 454 201" fill="none" stroke="#6e89da" stroke-width="2.3"/><path d="M55 57 C72 102 83 127 103 120S134 126 153 151S182 157 204 163S238 172 263 178S302 184 326 188S392 199 454 203" fill="none" stroke="#65a592" stroke-width="2.3" stroke-dasharray="5 4"/></svg><p class="figure-caption">用于展示结果图预览的虚构示意，不代表实际计算数据。</p></div>`;showModal(r.title,r.subtitle,id==='fig_boundary'?figure:`<div class="rich-text">${markdown(id==='resource_estimate'?'## 本轮资源估算\n更大尺寸的计算需要超出本阶段预算的内存和运行时间。\n\n## 当前决策\n保留这条验证路线，优先完成小尺寸对照与解析推导。':'## 本轮计算设置\n- 尺寸：N = 12、16、20\n- 固定初态和耦合参数\n- 对比开放与周期边界\n- 已核对归一化与零耦合极限\n\n## 限制\n尚未完成可靠的尺寸外推。')}</div>`,button('完成','close-modal'),true);}
  function about(){if(integrated){showModal('数据与存储','项目与想法都保存在当前 Persona。','<p class="field-help">项目、待办、进展和关联信息保存到服务器，并保留修订历史。使用同一个工作区地址，可以在手机和电脑继续编辑。未提交的表单草稿保存在当前浏览器。</p>',button('完成','close-modal','','primary'));return;}showModal('研究工作区 · 交互演示','虚构项目，可自由尝试。所有修改只保存在这份浏览器演示中。',`<div class="about-grid"><div class="about-card">${icon('bulb')}<strong>试一次探索结束</strong>打开“边界条件”方向，查看判断、理由与已经完成的待办。</div><div class="about-card">${icon('tasks')}<strong>勾选一个具体行动</strong>在项目和方向详情中查看同一条任务的变化。</div><div class="about-card">${icon('chart')}<strong>留下一次新进展</strong>记录结果、标记主要结果，或置顶为当前进度。</div><div class="about-card">${icon('copy')}<strong>带着上下文继续讨论</strong>选择项目内容，预览、复制或下载 Markdown。</div></div><div class="notice blue">${icon('info')}${liveLibrary?'已连接正式知识与材料，读取不会修改正式记录。项目、想法及其关联仍保存在此浏览器；初始研究项目为示例。':'演示不连接正式 Persona 数据，也不访问你的科研目录或外部模型。'}目录打开与示例附件仍使用虚构内容。${storageAvailable?'':'当前浏览器存储不可用，修改可能无法保留。'}</div>`,button('重置演示','reset','','','history')+button('开始体验','close-modal','','primary'));}
  // Knowledge/material references share a picker and keep their editor underneath.
  function referenceChip(ref, type, id, editable = true) {
    const target = ref.record, symbol = target?.kind === 'material' ? 'book' : target ? 'layers' : 'warning';
    return `<div class="reference-item"><div class="reference-chip ${target?.kind || ''} ${target?.archived || !target ? 'archived' : ''}"><button type="button" data-action="reference-preview" data-id="${esc(ref.id)}" data-label="${esc(ref.title)}" title="${esc(ref.title)}">${icon(symbol)}<span>${esc(ref.title)}</span>${target?.archived ? '<small>已归档</small>' : !target ? '<small>暂不可用</small>' : liveLibrary && target.source==='demo' ? '<small>示例</small>' : ''}</button>${editable && ref.manual ? ib('close',`移除关联：${ref.title}`,'reference-remove',`data-type="${type}" data-id="${id}" data-ref="${esc(ref.id)}"`) : ''}</div>${ref.occurrences.length ? `<button class="reference-origin" type="button" data-action="reference-locate" data-type="${type}" data-id="${id}" data-ref="${esc(ref.id)}">正文引用 · ${ref.occurrences.length} 处 ${icon('arrow')}</button>` : ''}</div>`;
  }
  function referenceSection(type, item, panel = false) {
    const refs = R.related(item), children = type === 'projects' ? R.descendants(db, item.id) : [];
    const add = ib('plus','添加关联知识或材料','reference-add',`data-type="${type}" data-id="${item.id}"`);
    return `<section class="${panel ? 'panel reference-panel' : 'drawer-section reference-section'}">${panel ? sectionHead('相关知识与材料',add,'layers') : `<div class="section-heading">相关知识与材料 ${add}</div>`}<div class="${panel ? 'panel-body' : ''}"><div class="reference-cloud">${refs.slice(0,4).map(ref=>referenceChip(ref,type,item.id)).join('') || '<p class="field-help">关联已有知识或材料，留下这段研究的线索。</p>'}</div>${refs.length>4 ? `<details class="reference-more"><summary>展开另外 ${refs.length-4} 项</summary><div class="reference-cloud">${refs.slice(4).map(ref=>referenceChip(ref,type,item.id)).join('')}</div></details>` : ''}${children.length ? `<details class="reference-descendants"><summary>探索方向引用的内容 <span>${children.length}</span></summary><p>保留在各自的探索方向中。</p>${children.map(ref=>`<div class="reference-descendant"><button class="reference-name" data-action="reference-preview" data-id="${esc(ref.id)}">${icon(ref.record?.kind==='material'?'book':'layers')}${esc(ref.title)}</button><div>${ref.ideas.map(idea=>`<button data-action="detail" data-type="ideas" data-id="${idea.id}">${esc(idea.title)} ${icon('arrow')}</button>`).join('')}</div></div>`).join('')}</details>` : ''}</div></section>`;
  }
  function referenceSummary(item, interactive = true) {
    const refs = R.related(item); if (!refs.length) return '';
    return `<div class="reference-summary">${refs.slice(0,2).map(ref=>interactive ? `<button type="button" data-action="reference-preview" data-id="${esc(ref.id)}" title="${esc(ref.title)}">${icon(ref.record?.kind==='material'?'book':'layers')}<span>${esc(ref.title)}</span></button>` : `<span title="${esc(ref.title)}">${icon(ref.record?.kind==='material'?'book':'layers')}<span>${esc(ref.title)}</span></span>`).join('')}${refs.length>2?`<small>+${refs.length-2}</small>`:''}</div>`;
  }
  function referenceFilterControl() {
    const target = R.get(referenceFilter);
    return `<div class="reference-filter"><button class="button ghost small ${referenceFilter?'soft':''}" data-action="reference-filter" aria-label="按关联知识或材料筛选">${icon('layers')}<span>${target?esc(target.title):'关联知识或材料'}</span>${icon('down')}</button>${referenceFilter?ib('close','清除关联筛选','reference-filter-clear'):''}</div>`;
  }
  function referenceEditorRecord() {
    const form = $('#editor-form'); return form ? { body: form.elements.body?.value || '', related_refs: formValues(form).related_refs || [] } : { body: '', related_refs: [] };
  }
  function enhanceReferenceEditor(form, key) {
    if (!/^(edit-idea:|new-idea:|project:)/.test(key) || !form.elements.body) return;
    const type = key.startsWith('project:') ? 'projects' : 'ideas';
    const item = key.startsWith('new-idea:') ? null : get(type,key.split(':').slice(1).join(':'));
    form.dataset.referenceEditor = 'true'; form.dataset.referenceType = type;
    const hidden = document.createElement('input'); hidden.type='hidden'; hidden.name='related_refs'; hidden.value=JSON.stringify(item?.related_refs || []); form.append(hidden);
    const bodyField = form.elements.body.closest('label');
    bodyField.insertAdjacentHTML('beforebegin',`<section class="editor-reference-section"><div class="section-heading">相关知识与材料 ${button('添加关联','reference-add', 'data-type="editor"','small','plus')}</div><div class="reference-cloud" id="editor-reference-list"></div></section><div class="reference-editor-toolbar"><span>Markdown</span><div>${button('插入引用','reference-insert','','small','link')}<button class="button ghost small" type="button" data-action="reference-editor-preview" aria-pressed="false">预览正文</button></div></div>`);
    bodyField.classList.add('reference-body-field');
    bodyField.insertAdjacentHTML('afterend','<div class="rich-text reference-editor-preview" id="reference-editor-preview" hidden></div><p class="reference-editor-hint">引用会自动汇总到上方；点击引用可查看原条目。</p>');
  }
  function refreshEditorReferences() {
    const root = $('#editor-reference-list'); if (!root) return;
    const record = referenceEditorRecord();
    root.innerHTML = R.related(record).map(ref=>referenceChip(ref,'editor','')).join('') || '<span class="field-help">从知识库选择，或在正文中插入引用。</span>';
    const preview = $('#reference-editor-preview'); if (preview && !preview.hidden) preview.innerHTML=markdown(record.body);
  }
  function editorSelection() {
    const area = $('#editor-form')?.elements.body;
    return area ? { area, start: area.selectionStart, end: area.selectionEnd } : null;
  }
  function openReferencePicker(mode, type = null, id = null, kind = 'all') {
    referenceStack=[]; referenceState={view:'picker',mode,type,id,kind,query:'',selected:new Set(),selection:mode==='inline'?editorSelection():null};
    renderReferenceDialog(); $('#reference-search').focus();
    if(liveLibrary && (Date.now()-L.state.loadedAt>30000 || L.state.status==='error')) L.refresh();
  }
  function currentReferenceOwner() {
    return referenceState?.type === 'editor' ? referenceEditorRecord() : referenceState?.type ? get(referenceState.type,referenceState.id) : null;
  }
  async function openReferencePreview(id, label = '') {
    if ($('#reference-dialog').open && referenceState) referenceStack.push(referenceState);
    referenceState={view:'preview',id,label}; renderReferenceDialog();
    await loadReferenceDetail();
  }
  async function loadReferenceDetail() {
    const s=referenceState;
    if(!s || !liveLibrary || !s.id?.startsWith('ps_'))return;
    s.loading=true; s.error=''; renderReferenceDialog();
    try { await L.detail(s.id); }
    catch(error) { s.error=error.status===404?error.message:'暂时无法读取条目，请重试。编辑内容和引用仍会保留。'; }
    finally { s.loading=false; if(referenceState===s)renderReferenceDialog(); }
  }
  function libraryStatus() {
    if(!liveLibrary)return '';
    const s=L.state;
    const text=s.status==='loading'?'正在读取正式知识库…':s.status==='error'?s.error:`${s.workspace.name} · ${s.counts.knowledge} 个知识点 · ${s.counts.material} 份材料`;
    return `<span>${esc(text)}</span>${button(s.status==='error'?'重试连接':'刷新','library-refresh','','small')}`;
  }
  function renderLibraryStatus() {
    if(!liveLibrary)return;
    const s=L.state,root=$('#library-connection'); root.hidden=s.status!=='error'&&!projectError;root.classList.toggle('error',s.status==='error'||!!projectError);
    root.innerHTML=`<div><strong>${s.status==='ready'?'已连接正式知识库':s.status==='loading'?'正在连接正式知识库…':'正式知识库暂不可用'}</strong><small>${s.status==='ready'?`${esc(s.workspace.name)} · ${s.counts.knowledge} 个知识点 · ${s.counts.material} 份材料 · ${integrated?(projectError?'项目保存需要检查':projectReady?'项目、待办与进展已同步工作区':'正在读取项目'):'项目与想法保存在此浏览器'}`:esc(s.error||'正在读取知识点与材料，已有编辑内容会保留。')}</small>${projectError?`<small role="alert">${esc(projectError)}</small>`:''}</div>${projectError?button('读取最新记录','refresh-projects','','small'):button(s.status==='error'?'重试连接':'刷新知识库','library-refresh','','small')}`;
    if(referenceState?.view==='picker') {
      if(s.status==='ready')for(const id of referenceState.selected)if(!R.get(id)||R.get(id).archived)referenceState.selected.delete(id);
      $('#reference-library-status').innerHTML=libraryStatus();
      $('#reference-results').innerHTML=referenceResultRows();
      const apply=$('#reference-apply');if(apply){const count=referenceState.selected.size;$('#reference-selection-count').textContent=`已选 ${count} 项`;apply.textContent=`添加 ${count} 项关联`;apply.disabled=s.status!=='ready'||!count;}
    }
  }
  function closeReferenceDialog() {
    $('#reference-dialog').close(); referenceState=null; referenceStack=[];
  }
  function referenceBack() {
    if (!referenceStack.length) return closeReferenceDialog();
    referenceState=referenceStack.pop(); renderReferenceDialog();
  }
  function referenceResultRows() {
    const s=referenceState, owner=currentReferenceOwner(), existing=new Set(owner?.related_refs || []), inline=new Set(R.citations(owner?.body).map(ref=>ref.id));
    if(liveLibrary && L.state.status!=='ready')return `<div class="reference-empty"><strong>${L.state.status==='loading'?'正在读取知识点与材料…':'暂时无法显示正式知识库'}</strong><p>${L.state.status==='loading'?'读取完成后可继续选择。':'请点击上方“重试连接”。已有引用与编辑内容会保留。'}</p></div>`;
    const results=R.search(s.query,s.kind,s.mode==='filter');
    return results.length ? results.map(item=>{
      const glyph=icon(item.kind==='material'?'book':'layers');
      const copy=`<span class="reference-result-icon ${item.kind}">${glyph}</span><span class="reference-result-copy"><strong>${esc(item.title)}${item.archived?'<small>已归档</small>':''}</strong><small>${item.kind==='material'?'材料':'知识点'} · ${esc(item.path)}</small><span>${esc(item.summary)}</span></span>`;
      const linked=existing.has(item.id);
      return `<div class="reference-result">${s.mode==='manual'?`<label class="reference-result-main ${linked?'already-related':''}"><input type="checkbox" data-reference-choice="${item.id}" aria-label="关联：${esc(item.title)}" ${linked||s.selected.has(item.id)?'checked':''} ${linked?'disabled':''}>${copy}<span class="reference-result-state">${linked?'已添加':inline.has(item.id)?'正文已引用':''}</span></label>`:`<button type="button" class="reference-result-main" data-action="reference-choose" data-id="${item.id}">${copy}<span class="reference-result-state">${s.mode==='inline'?'引用':s.mode==='filter'?'筛选':icon('chevron')}</span></button>`}${s.mode!=='browse'?ib('info',`预览：${item.title}`,'reference-preview',`data-id="${item.id}"`):''}</div>`;
    }).join('') : `<div class="reference-empty">${icon('search')}<strong>没有找到匹配的内容</strong><p>试试标题、别名或关键词，也可以切换知识点与材料。</p></div>`;
  }
  function renderReferenceDialog() {
    const dialog=$('#reference-dialog'),s=referenceState;if(!s)return;
    dialog.className=`modal reference-dialog ${s.view==='full'?'reference-full':''}`;
    let title, subtitle, body, actions='';
    if(s.view==='picker') {
      title=s.mode==='manual'?'关联知识与材料':s.mode==='inline'?'在正文中插入引用':s.mode==='filter'?'按关联内容筛选':'知识与材料';
      subtitle=s.mode==='manual'?'选择与这段研究有关的内容。':s.mode==='inline'?'选中后会插入到刚才的光标位置。':s.mode==='filter'?(route.page==='projects'?'筛选项目自身关联的知识点或材料。':'找到关联同一条知识或材料的想法。'):(liveLibrary?'浏览正式知识库，查看当前浏览器中关联的研究。':'浏览示例知识库，查看它们在哪些研究中被引用。');
      body=`<div id="reference-library-status" class="reference-library-status">${libraryStatus()}</div><div class="reference-search-tools"><label class="search-box">${icon('search')}<input id="reference-search" type="search" aria-label="搜索知识点或材料" placeholder="搜索标题、别名或关键词…" value="${esc(s.query)}" autocomplete="off"></label><div class="segmented">${[['all','全部'],['knowledge','知识点'],['material','材料']].map(([kind,label])=>`<button type="button" data-action="reference-kind" data-kind="${kind}" aria-pressed="${s.kind===kind}" class="${s.kind===kind?'active':''}">${label}</button>`).join('')}</div></div><div id="reference-results" class="reference-results">${referenceResultRows()}</div><p id="reference-message" role="alert" class="form-error"></p>`;
      actions=s.mode==='manual'?`<span id="reference-selection-count" class="reference-selection-count">已选 ${s.selected.size} 项</span>${button('取消','reference-close')}<button type="button" id="reference-apply" class="button primary-button" data-action="reference-apply" ${s.selected.size?'':'disabled'}>添加 ${s.selected.size} 项关联</button>`:button(s.mode==='filter'?'取消筛选选择':'完成','reference-close');
    } else {
      const item=R.get(s.id), links=R.backlinks(db,s.id);title=item?.title||s.label||'条目暂不可用';
      subtitle=item?`${item.kind==='material'?'材料':'知识点'} · ${item.path}`:'引用仍然保留，可以继续编辑当前记录。';
      const isReal=liveLibrary&&s.id.startsWith('ps_');
      const loadState=s.loading?'<div class="reference-load-state" role="status">正在读取正式条目…</div>':s.error?`<div class="reference-load-state" role="alert">${esc(s.error)} ${button('重新读取','reference-retry','','small')}</div>`:'';
      const backlinkList=`<section class="reference-backlinks"><div class="section-heading">相关研究 <span>${links.length}</span></div>${links.length?links.slice(0,s.view==='full'?links.length:4).map(link=>`<button class="reference-backlink" data-action="reference-open-owner" data-type="${link.type}" data-id="${link.record.id}"><span class="reference-backlink-icon">${icon(link.type==='projects'?'projects':'bulb')}</span><span><strong>${esc(link.record.title)}</strong><small>${link.type==='projects'?'研究项目':link.record.project?esc(get('projects',link.record.project)?.title||'探索方向'):'独立想法'} · ${[link.ref.manual?'手动关联':'',link.ref.occurrences.length?`正文引用 ${link.ref.occurrences.length} 处`:''].filter(Boolean).join(' · ')}</small></span>${icon('arrow')}</button>`).join(''):'<p class="field-help">当前工作区暂时没有项目或想法引用它。</p>'}${links.length>4&&s.view!=='full'?`<p class="field-help">另有 ${links.length-4} 条，在条目详情中查看。</p>`:''}</section>`;
      body=loadState+(item?`${item.archived?`<div class="notice">${icon('archive')}此条目已归档，已有引用继续保留。</div>`:''}${liveLibrary&&item.source==='demo'?'<div class="notice">这是此前保留的演示条目，不属于正式知识库。可以保留或手动移除关联。</div>':''}${!s.loading&&!s.error?`<p class="reference-preview-summary">${esc(item.summary||'尚未填写条目摘要。')}</p>${s.view==='full'?`<div class="rich-text reference-full-body">${item.body?markdown(item.body):'<p class="field-help">此条目暂无补充正文。</p>'}</div>`:''}`:''}${backlinkList}<p class="reference-demo-note">${icon('lock')}${isReal?'正式知识库 · 相关研究来自此浏览器':liveLibrary?'此前的演示条目':'虚构示例库 · 相关研究仅在此演示中显示'}</p>`:s.loading||s.error?'':`<div class="reference-empty">${icon('warning')}<strong>暂时找不到这个条目</strong><p>正文中的文字和引用已保留。可以关闭预览，继续当前研究。</p></div>`);
      actions=button(referenceStack.length?'返回':'关闭','reference-back')+(item?.detail_url?`<a class="button ghost" href="${esc(item.detail_url)}" target="_blank" rel="noopener noreferrer">在正式库打开 ${icon('arrowUp')}</a>`:'')+(item&&s.view!=='full'&&!s.loading&&!s.error?button(isReal?'查看条目详情':'查看完整条目','reference-full',`data-id="${item.id}"`,'primary','arrow'):'');
    }
    dialog.innerHTML=`<div class="modal-head"><div>${referenceStack.length?'<button class="reference-back-button" type="button" data-action="reference-back">← 返回</button>':''}<h2 id="reference-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div>${ib('close','关闭知识与材料弹层','reference-close')}</div><div class="modal-body">${body}</div><div class="modal-actions">${actions}</div>`;
    if(!dialog.open)dialog.showModal();
  }
  async function applyReferenceSelection() {
    const s=referenceState, ids=[...s.selected]; if(!ids.length)return;
    if(liveLibrary && (L.state.status!=='ready' || ids.some(id=>!R.get(id) || R.get(id).archived))) { $('#reference-message').textContent='所选内容已变化或知识库暂不可用，请刷新后重新选择。'; return; }
    if(s.type==='editor') {
      const form=$('#editor-form');form.elements.related_refs.value=JSON.stringify([...new Set([...referenceEditorRecord().related_refs,...ids])]);
      refreshEditorReferences();persistDraft();closeReferenceDialog();
    } else {
      const item=get(s.type,s.id);
      if(!item||!(await update(s.type,s.id,{related_refs:[...new Set([...(item.related_refs||[]),...ids])]},'关联知识与材料'))) { $('#reference-message').textContent='关联暂未保存，请保留选择并重试。';return; }
      closeReferenceDialog();toast(`已添加 ${ids.length} 项关联。`);
    }
  }
  function chooseReference(id) {
    const s=referenceState;
    if(liveLibrary && (L.state.status!=='ready' || !R.get(id)))return;
    if(s.mode==='inline' && R.get(id)?.archived){$('#reference-message').textContent='该条目已归档，请选择其他条目。';return;}
    if(s.mode==='browse')return openReferencePreview(id);
    if(s.mode==='filter'){referenceFilter=id;closeReferenceDialog();render();return;}
    const selection=s.selection;
    if(s.mode!=='inline'||!selection?.area?.isConnected)return;
    const text=R.makeCitation(id), area=selection.area;
    if(area.value.length-(selection.end-selection.start)+text.length>area.maxLength){$('#reference-message').textContent='正文已接近长度限制，请先缩短内容。';return;}
    area.setRangeText(text,selection.start,selection.end,'end');
    area.dispatchEvent(new Event('input',{bubbles:true}));closeReferenceDialog();
    const details=area.closest('details');if(details)details.open=true;
    area.focus();area.setSelectionRange(selection.start+text.length,selection.start+text.length);
  }
  async function removeReference(type,id,ref) {
    if(type==='editor') {
      const form=$('#editor-form');form.elements.related_refs.value=JSON.stringify(referenceEditorRecord().related_refs.filter(value=>value!==ref));
      refreshEditorReferences();persistDraft();return;
    }
    const item=get(type,id);if(!item)return;
    if(await update(type,id,{related_refs:(item.related_refs||[]).filter(value=>value!==ref)},'移除手动关联'))toast(R.citations(item.body).some(x=>x.id===ref)?'已移除手动关联，正文引用仍保留。':'已移除关联。');
  }
  function locateReference(type,id,ref) {
    if(type!=='editor'){if(type==='projects')editProject(id);else editIdea(id);}
    const area=$('#editor-form')?.elements.body;if(!area)return;
    const match=R.citations(area.value).find(item=>item.id===ref);
    const field=area.closest('label');field.hidden=false;$('#reference-editor-preview').hidden=true;
    const toggle=$('[data-action="reference-editor-preview"]');toggle.textContent='预览正文';toggle.setAttribute('aria-pressed','false');
    const details=area.closest('details');if(details)details.open=true;
    $('[data-action="reference-insert"]').disabled=false;area.focus();if(match)area.setSelectionRange(match.start,match.end);area.scrollIntoView({block:'center'});
  }
  function toggleReferenceEditorPreview() {
    const area=$('#editor-form')?.elements.body,preview=$('#reference-editor-preview');if(!area||!preview)return;
    preview.hidden=!preview.hidden;area.closest('label').hidden=!preview.hidden;
    const toggle=$('[data-action="reference-editor-preview"]');toggle.textContent=preview.hidden?'预览正文':'继续编辑';toggle.setAttribute('aria-pressed',String(!preview.hidden));
    $('[data-action="reference-insert"]').disabled=!preview.hidden;refreshEditorReferences();if(preview.hidden)area.focus();
  }
  function openReferenceOwner(type,id) {
    if($('#editor-form'))persistDraft();closeReferenceDialog();
    if($('#modal').open)closeModal();
    if(type==='projects'){const hash=`#project/${id}/overview`;if(location.hash===hash)parseRoute();else location.hash=hash;}else openDetail('ideas',id);
  }
  function upgradeReferenceDemo() {
    if(db.libraryVersion)return;
    const old=clone(db),next=clone(db),seed=window.createResearchDemo();
    for(const type of ['projects','ideas'])for(const item of next[type]){
      if(Array.isArray(item.related_refs))continue;
      const sample=seed[type].find(record=>record.id===item.id);
      if(sample&&item.revision===1&&item.title===sample.title&&item.body===R.stripCitations(sample.body))put(next,type,{...item,related_refs:sample.related_refs,body:sample.body},'补充关联示例');
      else item.related_refs=[];
    }
    next.libraryVersion=1;next.version+=1;
    try { if(!localStorage.getItem(`${KEY}:before-references`))localStorage.setItem(`${KEY}:before-references`,JSON.stringify(old));localStorage.setItem(KEY,JSON.stringify(next));db=next; }
    catch { db=next;storageAvailable=false; }
  }
  async function action(name,d){
    switch(name){
      case 'refresh-ideas':await refreshFormalIdeas();break;
      case 'refresh-projects':{const input=$('[data-form=quick-task] input[name=title]'),pending=input?.value;closeModal();await refreshProjects();parseRoute();const replacement=$('[data-form=quick-task] input[name=title]');if(pending&&replacement)replacement.value=pending;toast('已读取最新记录。未提交的表单草稿仍保留，请核对后继续。');break;}
      case 'import-projects':importProjects();break;
      case 'confirm-import-projects':{if(projectBusy)break;const ids=$$('input[name=import-project]:checked').map(e=>e.value);if(!ids.length){$('#project-import-error').textContent='请先选择项目。';break;}projectBusy=true;try{db=await formalRequest('/api/projects/import',{workspace_key:projectWorkspace,expected_revision:db.version,snapshot:browserBackup,project_ids:ids});formalProjection();$('#modal').close();await refreshFormalIdeas();render();toast('所选项目已保存到工作区，原浏览器备份仍保留。');}catch(error){$('#project-import-error').textContent=error.message;}finally{projectBusy=false;}break;}
      case 'link-existing-idea':{await refreshFormalIdeas();if(!formalReady){toast(formalError);break;}const candidates=db.ideas.filter(i=>!i.project&&!i.archived);showModal('关联已有想法','选择一个独立想法，它的正文、附件与历史版本都会保留。',candidates.length?candidates.map(i=>button(esc(i.title),'attach-formal-idea',`data-id="${i.id}" data-project="${d.project}"`,'full')).join(''):'<p>暂无独立想法。你可以先新建一个想法。</p>',button('关闭','close-modal'));break;}
      case 'attach-formal-idea':{const i=get('ideas',d.id),p=get('projects',d.project);await formalRequest('/api/ideas/'+i.id,{expected_revision:i.revision,values:{project:{id:p.id,title:p.title}}});$('#modal').close();await refreshFormalIdeas();toast('已关联，原想法的内容与历史仍保留。');break;}

      case 'reference-add':openReferencePicker('manual',d.type,d.id);break;
      case 'reference-insert':openReferencePicker('inline','editor');break;
      case 'reference-preview':openReferencePreview(d.id,d.label);break;
      case 'reference-remove':await removeReference(d.type,d.id,d.ref);break;
      case 'reference-locate':locateReference(d.type,d.id,d.ref);break;
      case 'reference-filter':openReferencePicker('filter');break;
      case 'reference-filter-clear':referenceFilter='';render();break;
      case 'reference-browse':openReferencePicker('browse',null,null,d.kind||'all');break;
      case 'reference-close':closeReferenceDialog();break;
      case 'reference-back':referenceBack();break;
      case 'reference-apply':await applyReferenceSelection();break;
      case 'reference-choose':chooseReference(d.id);break;
      case 'reference-full':referenceStack.push(referenceState);referenceState={view:'full',id:d.id};renderReferenceDialog();await loadReferenceDetail();break;
      case 'reference-retry':await loadReferenceDetail();break;
      case 'library-refresh':await L.refresh();break;
      case 'reference-kind':referenceState.kind=d.kind;renderReferenceDialog();break;
      case 'reference-editor-preview':toggleReferenceEditorPreview();break;
      case 'reference-open-owner':openReferenceOwner(d.type,d.id);break;
      case 'about':about();break;
      case 'scope-info':showModal(esc(d.label),'当前演示聚焦研究项目与想法。',`<p class="field-help">${esc(d.label)}沿用 PersonaStudio 已有模块。本演示可以从侧栏进入“研究项目”和“研究想法”，体验新的研究工作流程。</p>`,button('继续查看研究工作区','close-modal','','primary'));break;
      case 'close-modal':closeModal();break;
      case 'close-detail':$('#detail').close();detailState=null;break;
      case 'detail':openDetail(d.type,d.id);break;
      case 'filter':filter=d.value;renderContent();break;
      case 'idea-scope':ideaScope=d.value;render();break;
      case 'new-idea':editIdea(null,d.project||null);break;
      case 'edit-idea':editIdea(d.id);break;
      case 'new-task':editTask(null,d.project,d.idea||'');break;
      case 'edit-task':editTask(d.id);break;
      case 'new-project':newProject(d.origin,d.force==='true');break;
      case 'edit-project':{editProject(d.id);if(d.focus==='body'){const area=$('#editor-form textarea[name="body"]');area.closest('details').open=true;area.focus();area.scrollIntoView({block:'center'});}break;}
      case 'project-status':projectStatus(d.id);break;
      case 'restore-project':if(await update('projects',d.id,{archived:false},'恢复项目'))toast('项目已恢复。');break;
      case 'project-background':{const p=get('projects',d.id);showModal('研究背景与约定',esc(p.title),`<div class="rich-text">${markdown(p.body)}</div>`,button('编辑背景','edit-project',`data-id="${d.id}" data-focus="body"`,'','edit')+button('完成','close-modal'));break;}
      case 'toggle-task':{const t=get('tasks',d.id),state=t.state==='done'?'todo':t.state==='cancelled'?'todo':'done';if(await update('tasks',t.id,{state,completed_at:state==='done'?now():null},state==='done'?'完成待办':'重开待办'))toast(state==='done'?'待办已完成。':'待办已重新打开。');break;}
      case 'idea-tasks':{const i=get('ideas',d.id);if(route.tab!=='tasks'){location.hash=`project/${i.project}/tasks`;setTimeout(()=>{taskIdea=i.id;filter='all';renderContent();},0);}else{taskIdea=i.id;filter='all';renderContent();}break;}
      case 'decision':decision(d.id,d.mode);break;
      case 'reopen-idea':if(await update('ideas',d.id,{state:'exploring'},'重新探索'))toast('已重新探索，原判断与理由仍保留。');break;
      case 'start-idea':if(await update('ideas',d.id,{state:'exploring'},'开始探索'))toast('已开始探索。');break;
      case 'idea-more':{const i=get('ideas',d.id);showModal('探索方向的其他操作',esc(i.title),`<div style="display:grid;gap:10px">${button('记录放弃理由','decision',`data-id="${i.id}" data-mode="abandon"`,'full danger','pause')}${button(i.state==='paused'?'继续探索':'暂缓探索','pause-idea',`data-id="${i.id}"`,'full','pause')}${button('从这个方向创建研究项目','new-project',`data-origin="${i.id}"`,'full','projects')}</div>`,button('返回','close-modal'));break;}
      case 'pause-idea':{const i=get('ideas',d.id);if(await update('ideas',i.id,{state:i.state==='paused'?'exploring':'paused'},'调整探索状态')){closeModal();toast('探索状态已更新。');}break;}
      case 'new-update':editUpdate(null,d.project,d.pin==='true');break;
      case 'edit-update':editUpdate(d.id);break;
      case 'toggle-key':{const u=get('updates',d.id);if(await update('updates',u.id,{key:!u.key},u.key?'取消主要结果标记':'标记主要结果'))toast(u.key?'已取消主要结果标记。':'已标为主要结果。');break;}
      case 'pin-update':{const u=get('updates',d.id),p=get('projects',u.project);if(p.current!==u.id&&!effective(u)){toast('请选择当前有效的研究进展。');break;}if(await update('projects',p.id,{current:p.current===u.id?null:u.id},p.current===u.id?'清除当前进度':'置顶当前进度'))toast(p.current===u.id?'已取消置顶。':'已设为当前进度。');break;}
      case 'result-status':setResultStatus(d.id);break;
      case 'history':showHistory(d.type,d.id);break;
      case 'event-history':{const e=db.events.find(x=>x.id===d.id);if(e)showHistory(e.type,e.target,e.revision);break;}
      case 'work-entries':workEntries(d.id);break;
      case 'copy-entry':{const e=get('projects',d.project)?.entries.find(x=>x.id===d.id);if(e)await copyText(e.target);break;}
      case 'open-entry':{const e=get('projects',d.project)?.entries.find(x=>x.id===d.id);if(!e)break;if(integrated){const repo=e.kind==='repo'&&/^https?:\/\//.test(e.target);showModal(repo?'代码仓库':'工作目录',esc(e.label),`<div class="path-preview">${esc(e.target)}</div><p class="field-help">${repo?'打开项目的代码仓库。':'在对应电脑上使用此路径；可以复制后继续操作。'}</p>`,(repo?`<a class="button primary-button" href="${esc(e.target)}" target="_blank" rel="noopener noreferrer">打开代码仓库 ↗</a>`:'')+button('复制地址','copy-entry',`data-project="${d.project}" data-id="${e.id}"`)+button('关闭','close-modal'));break;}showModal(e.kind==='local'?'打开项目目录':'打开代码仓库',esc(e.label),`<div class="path-preview">${icon(e.kind==='local'?'folder':'git')} ${esc(e.target)}</div><div class="notice blue">${icon('info')}这是一个演示${e.kind==='local'?'目录':'链接'}。正式接入后，此处会${e.kind==='local'?'在当前电脑上打开已登记的工作目录':'打开项目的代码仓库'}。</div>`,button('复制地址','copy-entry',`data-project="${d.project}" data-id="${e.id}"`,'','copy')+button('知道了','close-modal','','primary'));break;}
      case 'resource':resource(d.id);break;
      case 'context':showContext(d.id);break;
      case 'copy-context':await copyText($('#context-output').value);break;
      case 'download-context':download('研究项目上下文.md',$('#context-output').value);toast('Markdown 已下载。');break;
      case 'reset':if(integrated)break;showModal('重置这份演示？','重新回到最初的虚构项目与记录。','<p class="field-help">这会清除你在本演示里新建或修改的内容及草稿。正式 Persona 工作区不受影响。</p>',button('保留我的修改','close-modal')+button('重置演示数据','confirm-reset','','danger'));break;
      case 'confirm-reset':if(integrated)break;try{db=window.createResearchDemo();drafts={};localStorage.setItem(KEY,JSON.stringify(db));localStorage.removeItem(DRAFT_KEY);formState=null;$('#modal').close();if($('#detail').open)$('#detail').close();detailState=null;location.hash='project/p_spin/overview';parseRoute();toast('已恢复初始演示。');}catch{toast('重置失败，请检查浏览器存储。');}break;
    }
  }
  document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(!target)return;if(target.tagName!=='A')event.preventDefault();action(target.dataset.action,target.dataset).catch(()=>toast('操作没有完成，请重试。'));});
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!form.dataset.form)return;event.preventDefault();const v=formValues(form);
    if(form.dataset.form==='editor'){if(!formState)return;const active=formState;if(form.dataset.saving)return;form.dataset.saving='true';const controls=[...form.elements];const disabled=controls.map(e=>e.disabled);controls.forEach(e=>e.disabled=true);let saved=false;try{saved=await active.onSave(v);}catch(error){formError(error.message||'保存未完成，请重试。');}finally{delete form.dataset.saving;controls.forEach((e,i)=>e.disabled=disabled[i]);}if(saved){delete drafts[active.key];try{localStorage.setItem(DRAFT_KEY,JSON.stringify(drafts));}catch{}formState=null;$('#modal').close();}return;}
    if(!v.title?.trim())return;
    if(form.dataset.form==='quick-task'){const project=form.dataset.project,idea=form.dataset.idea||null,item={id:uid('t'),project,idea,title:v.title.trim(),state:'todo',body:'',completed_at:null,order:projectTasks(project).length,resources:[]};if(await saveTransaction(next=>put(next,'tasks',item,'添加待办')))toast('待办已添加。');}
    if(form.dataset.form==='quick-idea'){const item={id:uid('i'),project:null,title:v.title.trim(),body:'',state:'pending',verdict:'unassessed',verdict_note:'',closure_note:'',novelty:'unknown',novelty_reason:'',difficulty:'unknown',difficulty_reason:'',resources:[]};if(await saveTransaction(next=>put(next,'ideas',item,'记录想法')))toast('已记下这个想法。');}
  });
  document.addEventListener('input',event=>{const e=event.target;if(e.closest('#editor-form'))persistDraft();if(e.id==='idea-search'){query=e.value;const p=currentProject(),items=filteredIdeas(p);$('#idea-results').innerHTML=items.length?items.map(ideaRow).join(''):empty('没有匹配的探索方向','试试其他状态或关键词。');}});
  document.addEventListener('change',event=>{const e=event.target;if(e.id==='task-idea-filter'){taskIdea=e.value;renderContent();}else if(e.id==='show-invalid'){showInvalid=e.checked;renderContent();}else if(e.id==='show-activity'){showActivity=e.checked;renderContent();}else if(e.id==='include-archive'){includeArchive=e.checked;render();}else if(e.closest('#context-options'))refreshContext();else if(e.name==='validity'&&$('#replacement-field'))$('#replacement-field').hidden=e.value!=='superseded';if(e.closest('#editor-form'))persistDraft();});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'&&$('#editor-form')){event.preventDefault();if(!$('#reference-dialog').open)$('#editor-form').requestSubmit();}});
  $('#modal').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
  $('#detail').addEventListener('close',()=>{detailState=null;});
  $('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
  $('#detail').addEventListener('click',event=>{if(event.target===$('#detail')){const r=$('#detail').getBoundingClientRect();if(event.clientX<r.left){$('#detail').close();detailState=null;}}});
  document.addEventListener('input',event=>{
    const e=event.target;
    if(e.id==='reference-search'&&referenceState?.view==='picker'){referenceState.query=e.value;$('#reference-results').innerHTML=referenceResultRows();}
    if(e.closest('#editor-form')?.dataset.referenceEditor&&e.name==='body')refreshEditorReferences();
    if(e.id==='project-search'){query=e.value;const list=db.projects.filter(projectMatches);$('#project-results').innerHTML=projectCards(list);$('#project-count').textContent=`${list.length} 个项目`;}
    if(e.id==='global-idea-search'){query=e.value;const list=db.ideas.filter(standaloneMatches);$('#standalone-results').innerHTML=standaloneCards(list);$('#standalone-count').textContent=`${list.length} 条想法`;}
  });
  document.addEventListener('change',event=>{
    const e=event.target;if(!e.dataset.referenceChoice||referenceState?.view!=='picker')return;
    if(e.checked)referenceState.selected.add(e.dataset.referenceChoice);else referenceState.selected.delete(e.dataset.referenceChoice);
    const count=referenceState.selected.size;$('#reference-selection-count').textContent=`已选 ${count} 项`;$('#reference-apply').textContent=`添加 ${count} 项关联`;$('#reference-apply').disabled=!count;
  });
  $('#reference-dialog').addEventListener('cancel',event=>{event.preventDefault();closeReferenceDialog();});
  document.addEventListener('click',event=>{if(event.target.closest('[data-studio-navigation]') && $('#editor-form'))persistDraft();});
  window.addEventListener('pagehide',()=>{if($('#editor-form'))persistDraft();});
  window.addEventListener('hashchange',parseRoute);
  window.addEventListener('storage',event=>{if(integrated)return;if(event.key!==KEY)return;try{const fresh=JSON.parse(event.newValue);if(fresh?.version&&!$('#modal').open){db=fresh;formalProjection();render();toast('演示已同步另一个标签页的修改。');}}catch{}});
  if(!integrated)upgradeReferenceDemo();
  if(integrated){formalProjection();es.pending=['未开始执行',''];es.exploring=['执行中','blue'];}
  parseRoute();
  if(integrated)Promise.all([refreshProjects(),refreshFormalIdeas()]).then(()=>{
    parseRoute();const parts=location.hash.slice(1).split('/');
    if(projectReady&&formalReady&&parts[0]==='projects'&&parts[1]==='from'&&get('ideas',parts[2]))newProject(parts[2]);
  });
  async function refreshProjects(){
    try{
      const result=await formalRequest('/api/projects');db=result;projectWorkspace=result.workspace_key;projectReady=true;projectError='';
      DRAFT_KEY=`personastudio-projects:${projectWorkspace}:drafts`;
      try{drafts=JSON.parse(localStorage.getItem(DRAFT_KEY))||{};}catch{drafts={};}
      formalProjection();render();renderLibraryStatus();return true;
    }catch(error){projectError=error.message;projectReady=false;render();renderLibraryStatus();return false;}
  }
  function importProjects(){
    const choices=(browserBackup?.projects||[]).filter(p=>!db.imports?.[p.id]);
    showModal('导入浏览器项目','只导入你选择的项目；原浏览器备份保持不变。',
      `<p class="field-help">旧记录可能含有虚构示例，请核对后选择。项目会连同待办、进展和修订历史一起保存；关联的旧想法也会导入，并保留原文与判断。</p>${choices.length?choices.map(p=>`<label class="check-label" style="margin:16px 0"><input type="checkbox" name="import-project" value="${esc(p.id)}">${esc(p.title)} <small>${browserBackup.tasks?.filter(t=>t.project===p.id).length||0} 项待办 · ${browserBackup.updates?.filter(u=>u.project===p.id).length||0} 条进展</small></label>`).join(''):'<p>此浏览器没有尚未导入的项目。</p>'}<p id="project-import-error" class="form-error" role="alert"></p>`,
      button('取消','close-modal')+(choices.length?button('导入选中项目','confirm-import-projects','','primary'):''));
  }
  async function formalRequest(url,values){const response=await fetch(url,values?{method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(values)}:{cache:'no-store'});const data=await response.json();if(!response.ok){const error=Error(data.error?.message||'工作区请求失败，请重试。');error.status=response.status;throw error;}return data;}
  async function refreshFormalIdeas(){
    try{const data=await formalRequest('/api/ideas');formalIdeas=data.items.map(i=>({...i,project:i.project?.id||null,state:i.execution_status==='ended'?(i.closure?.outcome==='abandoned'?'abandoned':'closed'):i.execution_status==='in_progress'?'exploring':'pending',verdict:'unassessed',verdict_note:'',closure_note:i.closure?.summary||'',archived:i.status==='archived'}));formalReady=true;formalError='';
      let imports={...db.idea_imports};try{imports={...JSON.parse(localStorage.getItem(KEY+':imports')),...imports};}catch{}
      // Resolve legacy task/result references in memory; their original IDs remain in the backup.
      for(const t of db.tasks)if(imports[t.idea])t.idea=imports[t.idea];
      for(const u of db.updates)u.ideas=u.ideas.map(id=>imports[id]||id);
      for(const p of db.projects)if(imports[p.origin?.id])p.origin.id=imports[p.origin.id];
    }catch(e){formalReady=false;formalError=e.message;formalIdeas=[];}
    formalProjection();render();
  }
  window.addEventListener('pageshow',event=>{if(integrated&&event.persisted){refreshFormalIdeas();refreshProjects().then(parseRoute);}});
  window.addEventListener('beforeunload',event=>{if(projectBusy){event.preventDefault();event.returnValue='';}});
  window.addEventListener('research-library-change',()=>{
    renderLibraryStatus();
    if(L.state.status==='ready') {
      if(!$('#modal').open && !$('#reference-dialog').open)render();
      refreshEditorReferences();
    }
  });
  renderLibraryStatus();
  if(liveLibrary)L.refresh();
})();
