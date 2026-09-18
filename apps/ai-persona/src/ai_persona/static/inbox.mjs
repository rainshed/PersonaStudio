import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
import {LearningReviewPanel} from './learning-review.mjs?v=20260917.review-performance1';
import {runtimeSummary} from './studio-runtime.mjs?v=20260910.tools-only';

export const typeNames = {learning:ui('对话学习'), activation:ui('偏好场景判断'), material:ui('材料整理'), maintenance:ui('自然语言维护'), proposal:ui('其他候选')};
export function safeReturnPath(target, origin) {
  if (!target?.startsWith('/') || target.startsWith('//')) return null;
  try {const url = new URL(target, origin); return url.origin === origin ? url.pathname + url.search + url.hash : null;} catch {return null;}
}
const runNames = {queued:ui('排队中'), running:ui('处理中'), completed:ui('处理完成'), failed:ui('运行失败'), retryable_failed:ui('可重试失败'), waiting_context:ui('等待上下文'), waiting_origin:ui('等待来源确认'), paused:ui('已暂停'), paused_budget:ui('预算暂停'), cancelled:ui('已取消'), returned:ui('已提供偏好'), prepared:ui('偏好已准备'), no_content:ui('无偏好需要提供'), skipped:ui('已跳过'), submitted:ui('已送审'), submitting:ui('正在送审'), submission_failed:ui('送审失败'), draft:ui('候选已生成'), idle:ui('尚未开始')};
export function feedbackText(feedback) {
  if (!feedback.supported) return '';
  if (feedback.state === 'unavailable') return ui('反馈状态暂不可用');
  if (!feedback.total) return ui('暂无可评价判断');
  if (!feedback.rated) return ui('未反馈');
  if (feedback.total === 1) return feedback.has_unsatisfied ? ui('已反馈 · 不满意') : ui('已反馈 · 满意');
  return ui('已反馈 {0}／{1}', feedback.rated, feedback.total)+(feedback.has_unsatisfied ? ui(' · 含不满意') : '');
}
export function reviewText(review) {
  if (!review.total) return '';
  const accepted = (review.statuses.accepted || 0) + (review.statuses.edited_and_accepted || 0);
  return [review.pending ? ui('待审核 {0} 条', review.pending) : ui('审核完成'), ui('已通过 {0} 条', accepted), review.statuses.rejected ? ui('已拒绝 {0} 条', review.statuses.rejected) : '', review.statuses.deferred ? ui('暂缓 {0} 条', review.statuses.deferred) : ''].filter(Boolean).join(' · ');
}
export class InboxListState {
  constructor() {this.ids = []; this.items = new Map();}
  apply(response, replace) {
    if (replace) {this.ids = response.items.map(i => i.id); this.items.clear();}
    for (const item of [...response.items, ...(response.updates || [])]) {
      if (!this.ids.includes(item.id)) continue;
      const old = this.items.get(item.id);
      if (old?.result_id === item.result_id && old?.feedback.revision > item.feedback.revision) continue;
      this.items.set(item.id, item);
    }
  }
}

export class InboxWorkspace {
  constructor() {
    this.$ = id => document.getElementById('inbox-' + id);
    this.node = (tag, text = '', cls = '') => {const n = document.createElement(tag); n.textContent = text; n.className = cls; return n;};
    this.notice = (message, error = false) => {const n = this.$('notice'); n.hidden = !message; n.textContent = message; n.classList.toggle('error', error);};
    this.handle = fn => async (...args) => {try {await fn(...args);} catch (e) {this.notice(e.message, true);}};
    this.button = (title, action) => {const b = this.node('button', title, 'button ghost'); b.type = 'button'; b.onclick = this.handle(action); return b;};
    this.api = async (path, body) => {
      const response = await fetch('/api/inbox/v1/' + path, {method: body === undefined ? 'GET' : 'POST', headers:{'Content-Type':'application/json','X-AI-Persona':'1'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
      const value = await response.json();
      if (!response.ok) {const e = new Error(value.error?.message || ui('读取失败，请重试。')); e.fields = value.error?.fields; throw e;}
      return value;
    };
    this.feedback = window.EvaluationFeedback;
    this.list = new InboxListState(); this.rows = new Map(); this.sequence = 0; this.detailSequence = 0;
    this.query = {view:'review', type:'', q:'', feedback:'', status:'', source:'', from:'', to:'', order:'newest', material:'', context:''};
    this.cursor = null; this.cursors = []; this.nextCursor = null; this.selected = null; this.parts = null;
    this.detailScrolls = new Map(); this.returnUrl = null;
    this.candidates = new LearningReviewPanel({api:this.api, node:this.node, button:this.button, notice:this.notice, refresh:() => this.load(false), reviewPath:id => `items/${encodeURIComponent(id)}/review`, allowDefer:true});
    this.readLocation();
    this.$('filters').onsubmit = this.handle(async event => {event.preventDefault(); this.query = {...this.query, ...Object.fromEntries(new FormData(this.$('filters')))}; await this.reload(true);});
    for (const select of this.$('filters').querySelectorAll('select')) select.onchange = () => this.$('filters').requestSubmit();
    for (const tab of this.$('tabs').querySelectorAll('button')) tab.onclick = this.handle(async () => {this.query.view = tab.dataset.view; this.query.feedback = ''; this.query.status = ''; if (this.query.view === 'feedback' && !['','learning','activation'].includes(this.query.type)) this.query.type = ''; this.syncFilters(); await this.reload(true);});
    this.$('refresh').onclick = this.handle(() => this.reload(false));
    this.$('new').onclick = this.handle(() => this.reload(false));
    this.$('prev').onclick = this.handle(async () => {if (this.cursors.length) {this.remember(); this.cursor = this.cursors.pop(); this.remember(true); await this.load(true);}});
    this.$('next').onclick = this.handle(async () => {if (this.nextCursor) {this.remember(); this.cursors.push(this.cursor); this.cursor = this.nextCursor; this.remember(true); await this.load(true);}});
    this.$('back').onclick = () => {this.$('root').querySelector('.inbox-workspace').dataset.detailOpen = 'false'; this.rows.get(this.selected)?.title.focus({preventScroll:true}); this.remember();};
    this.$('detail-prev').onclick = this.handle(() => this.neighbor(-1));
    this.$('detail-next').onclick = this.handle(() => this.neighbor(1));
    window.addEventListener('popstate', this.handle(async () => {this.readLocation(); await this.load(true); if (this.selected) await this.readDetail(true);}));
    window.addEventListener('beforeunload', event => {if (this.candidates.hasDrafts() || this.feedback.hasDrafts()) {event.preventDefault(); event.returnValue = '';}});
    window.addEventListener('pagehide', () => this.remember());
    document.addEventListener('visibilitychange', this.handle(async () => {if (!document.hidden) await this.load(false);}));
  }
  readLocation() {
    const search = new URLSearchParams(location.search), saved = history.state?.inbox;
    for (const key of Object.keys(this.query)) this.query[key] = search.get(key) || ({view:'review',order:'newest'}[key]||'');
    this.proposalTarget=search.get('proposal');
    this.selected = search.get('item') || null;
    if (!this.selected && search.get('proposal')) this.selected = 'proposal:' + search.get('proposal');
    if (!this.selected && search.get('change_set')) this.selected = 'change_set:' + search.get('change_set');
    this.cursor = saved?.cursor || null; this.cursors = saved?.cursors || []; this.restore = saved;
    this.returnUrl = safeReturnPath(search.get('return_to'), location.origin);
    this.syncFilters();
  }
  syncFilters() {
    for (const [key, value] of Object.entries(this.query)) if (this.$('filters').elements[key]) this.$('filters').elements[key].value = value;
    for (const option of this.$('filters').elements.type.options) option.disabled = this.query.view === 'feedback' && !['','learning','activation'].includes(option.value);
    for (const tab of this.$('tabs').querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab.dataset.view === this.query.view));
    this.$('view-help').textContent = {review:ui('候选只有经过你审核后才会保存。你不需要先评价触发判断。'), feedback:ui('反馈完全可选。触发与不触发都可以评价，不需要清空这个列表。'), all:ui('查看各类结果与历史。运行、反馈和审核各自独立。')}[this.query.view] || '';
  }
  remember(push = false) {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(this.query)) value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    this.selected ? url.searchParams.set('item', this.selected) : url.searchParams.delete('item');
    if(this.proposalTarget)url.searchParams.set('proposal',this.proposalTarget);else url.searchParams.delete('proposal');
    url.searchParams.delete('change_set');
    const state = {inbox:{cursor:this.cursor, cursors:this.cursors, listScroll:this.$('list').scrollTop, detailScroll:this.$('detail').scrollTop, open:this.$('root').querySelector('.inbox-workspace').dataset.detailOpen}};
    history[push ? 'pushState' : 'replaceState'](state, '', url);
  }
  async reload(push) {this.cursor = null; this.cursors = []; this.clearOutsideSelection = push; if (push) this.remember(true); this.syncFilters(); await this.load(true);}
  clearDetail() {
    if (this.parts) for (const c of this.parts.feedbackContainers) this.feedback.destroy(c);
    this.selected = null; this.parts = null; this.detailSequence++;
    this.$('title').textContent = ui('选择一条记录'); this.$('meta').textContent = '';
    this.$('detail').replaceChildren(this.node('p', ui('从当前列表选择一条记录。'), 'inbox-empty'));
    this.$('root').querySelector('.inbox-workspace').dataset.detailOpen = 'false';
  }
  async load(replace) {
    if (!replace && this.replacing) return;
    const request = ++this.sequence;
    if (replace) this.replacing = request;
    try {
      const query = new URLSearchParams({...this.query, limit:'20'});
      if (this.cursor) query.set('cursor', this.cursor);
      if (!replace) query.set('ids', this.list.ids.join(','));
      const response = await this.api('items?' + query);
      if (request !== this.sequence) return;
      this.list.apply(response, replace); this.cursor = response.cursor; this.nextCursor = response.next_cursor;
      if (replace && this.clearOutsideSelection && this.selected && !this.list.ids.includes(this.selected) && !this.candidates.hasDrafts() && !this.feedback.hasDrafts()) {
        this.clearDetail();
      }
      if (replace) this.clearOutsideSelection = false;
      if (replace) {
        this.rows = new Map(this.list.ids.map(id => [id, this.rows.get(id) || this.createRow(id)]));
        this.$('list').replaceChildren(...this.list.ids.map(id => this.rows.get(id).root));
      }
      for (const id of this.list.ids) this.paintRow(this.list.items.get(id));
      if (!this.list.ids.length) {
        const empty = this.node('div', '', 'inbox-empty');
        empty.append(this.node('p', this.query.view === 'review' ? ui('当前没有符合条件的待审核候选。') : ui('当前没有符合条件的记录。')));
        if (this.query.view === 'review') empty.append(this.button(ui('查看可反馈判断'), async () => {this.query.view = 'feedback'; this.syncFilters(); await this.reload(true);}));
        this.$('list').replaceChildren(empty);
      }
      this.$('count').textContent = ui('{0} 条记录 · {1} 条候选待审核',response.total,response.pending_count);
      for (const badge of document.querySelectorAll('[data-inbox-pending]')) {badge.textContent = response.pending_count; badge.hidden = !response.pending_count;}
      this.$('page').textContent = ui('第 {0} 页',this.cursors.length+1);
      this.$('prev').disabled = !this.cursors.length; this.$('next').disabled = !response.has_more;
      this.$('new').hidden = !response.new_count; this.$('new').textContent = ui('{0} 条新记录，点击更新',response.new_count);
      this.$('warning').hidden = !response.warnings.length; this.$('warning').textContent = response.warnings.join(' ');
      const select = this.$('filters').elements.source;
      if (JSON.stringify(response.sources) !== this.sourceSignature) {
        this.sourceSignature = JSON.stringify(response.sources);
        select.replaceChildren(...['', ...response.sources].map(value => {const o = this.node('option', value || ui('全部来源')); o.value = value; return o;})); select.value = this.query.source;
      }
      for(const [key,options,empty] of [['material',(response.materials||[]).map(m=>[m.id,m.name]),ui('全部材料')],['context',(response.contexts||[]).map(c=>[c,c]),ui('全部场景')]]){
        const field=this.$('filters').elements[key],signature=JSON.stringify(options);
        if(field.dataset.signature!==signature){field.dataset.signature=signature;field.replaceChildren(...[['',empty],...options].map(([value,label])=>{const o=this.node('option',label);o.value=value;return o;}));field.value=this.query[key];}
      }
      this.mark();
      if (this.restore) {this.$('list').scrollTop = this.restore.listScroll || 0;}
      if (this.selected) await this.readDetail(false);
      else if (this.parts || this.restore) {this.clearDetail(); this.restore = null;}
      this.remember();
    } finally {if (this.replacing === request) this.replacing = null;}
  }
  createRow(id) {
    const root = this.node('article', '', 'inbox-row'), title = this.button('', () => this.open(id)); title.className = 'inbox-row-title';
    const meta = this.node('p', '', 'inbox-row-meta'), badges = this.node('div', '', 'inbox-row-badges'), note = this.node('p', '', 'inbox-row-note');
    root.append(title, meta, badges, note); return {root, title, meta, badges, note};
  }
  paintRow(item) {
    const row = this.rows.get(item.id); if (!row) return;
    row.title.textContent = item.input_preview || ui('输入内容已清理');
    row.meta.textContent = `${typeNames[item.type]} · ${item.source_name} · ${new Date(item.created * 1000).toLocaleDateString()}`;
    const labels = [];
    if (typeof item.triggered === 'boolean') labels.push([item.triggered ? ui('触发学习') : ui('不触发学习'), '']);
    if (item.matched_count !== null) labels.push([ui('命中 {0} 个场景',item.matched_count), '']);
    const rating = feedbackText(item.feedback); if (rating) labels.push([rating, item.feedback.has_unsatisfied ? 'negative' : '']);
    const review = reviewText(item.review); if (review) labels.push([review, item.review.pending ? 'needs-review' : '']);
    if (!['completed','submitted'].includes(item.status)) labels.push([runNames[item.status] || item.status, item.status.includes('failed') ? 'negative' : '']);
    row.badges.replaceChildren(...labels.map(([text, cls]) => this.node('span', text, cls)));
    row.note.textContent = item.matches === false ? ui('状态已更新，刷新列表后移出当前筛选。') : '';
  }
  mark() {
    for (const [id, row] of this.rows) {row.root.dataset.selected = String(id === this.selected); row.title.setAttribute('aria-pressed', String(id === this.selected));}
    const index = this.list.ids.indexOf(this.selected);
    this.$('detail-prev').disabled = index <= 0; this.$('detail-next').disabled = index < 0 || index === this.list.ids.length - 1;
  }
  async neighbor(offset) {const id = this.list.ids[this.list.ids.indexOf(this.selected) + offset]; if (id) await this.open(id);}
  async open(id) {
    this.remember(); if (this.selected) this.detailScrolls.set(this.selected, this.$('detail').scrollTop);
    this.proposalTarget=null;this.selected = id; this.$('root').querySelector('.inbox-workspace').dataset.detailOpen = 'true';
    this.remember(true); this.mark(); await this.readDetail(true);
  }
  disclosure(title, content) {const d = this.node('details'); d.append(this.node('summary', title)); if (content) d.append(content); return d;}
  async readDetail(reset) {
    const id = this.selected; if (!id) return;
    const request = ++this.detailSequence;
    try {
      const value = await this.api('items/' + encodeURIComponent(id));
      if (id !== this.selected || request !== this.detailSequence) return;
      const changed = this.parts?.id !== value.id;
      if (changed) {
        if (this.parts) for (const container of this.parts.feedbackContainers) this.feedback.destroy(container);
        const input = this.node('p', '', 'inbox-input'), context = this.disclosure(ui('必要上下文'), this.node('pre'));
        const feedback = this.node('section'), review = this.node('section'), candidates = this.node('div'), status = this.node('p', '', 'evaluation-muted');
        review.append(this.node('h3', ui('候选内容 · 在这里审核')), status, candidates);
        const runtime = this.disclosure(ui('技术详情'), this.node('pre')), provided = this.disclosure(ui('本轮提供的偏好与参考示例'), this.node('pre')), history = this.disclosure(ui('历史判断与反馈'), this.node('div')), links = this.node('div', '', 'inbox-links');
        const summary=this.node('p','','inbox-runtime'),actions=this.node('div','','inbox-links'),inputState=this.node('p','','evaluation-muted'),material=this.disclosure(ui('材料来源与处理范围'),this.node('pre'));
        this.parts = {id:value.id, input, inputState, summary, actions, material, context, feedback, review, candidates, status, runtime, provided, history, links, feedbackContainers:[], resultId:null};
        this.$('detail').replaceChildren(input,inputState,summary,actions,context,material,feedback,review,provided,history,runtime,links);
      }
      this.selected = value.id; this.mark();
      this.$('title').textContent = typeNames[value.type]; this.$('meta').textContent = `${value.source_name} · ${new Date(value.created * 1000).toLocaleString()}${!this.list.ids.includes(value.id) ? ui(' · 当前列表之外的记录') : ''}`;
      const p = this.parts;
      p.input.textContent = value.input_text || ui('输入内容已清理；不使用当前上下文补造历史输入。');
      p.inputState.textContent=value.input_state==='benchmark'?ui('原任务输入已清理；这里展示已有个人测试样例快照。'):value.input_state==='expired'?ui('原输入已清理，不补读宿主会话。'):value.input_note||'';
      p.inputState.hidden=!p.inputState.textContent;
      p.summary.textContent=runtimeSummary(value,runNames);
      const actionSignature=JSON.stringify([value.actions,value.status]);
      if(p.actionSignature!==actionSignature){p.actionSignature=actionSignature;p.actions.replaceChildren(...(value.actions||[]).map(action=>this.button(ui(action.label),async()=>{
        if(p.actionPending)return;
        if(!confirm(ui(action.label)+ui('？只影响本条任务，不改变全局开关或已有反馈。')))return;
        p.actionPending=true;for(const button of p.actions.querySelectorAll('button'))button.disabled=true;
        try{const response=await fetch(action.url,{method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(action.body)}),result=await response.json();
        if(!response.ok)throw new Error(result.error?.message||ui('操作失败，请重新读取最新状态。'));
        this.notice(ui('任务状态已更新；新一轮判断不会沿用旧反馈。'));await this.load(false);
        }finally{p.actionPending=false;p.actionSignature=null;await this.readDetail(false);}
      })));}
      p.material.hidden=!value.coverage&&!value.material_source;
      p.material.querySelector('pre').textContent=JSON.stringify({source:value.material_source,coverage:value.coverage},null,2);
      p.context.hidden = !value.context; p.context.querySelector('pre').textContent = value.context ? JSON.stringify(value.context, null, 2) : '';
      p.runtime.querySelector('pre').textContent = JSON.stringify({...(value.runtime || {status:value.status}),stages:value.stages}, null, 2);
      p.provided.hidden = !value.provided_context;
      p.provided.querySelector('pre').textContent = value.provided_context ? ui('已提供给 Agent 不代表它已遵循。\n\n') + JSON.stringify(value.provided_context, null, 2) : '';
      p.review.hidden = !value.review.total; p.status.textContent = reviewText(value.review);
      if(value.answer_sync)p.status.textContent+=ui(' · 审核答案 ')+value.answer_sync.saved+'／'+value.answer_sync.expected+(value.answer_sync.state==='pending'?ui(' 待同步；已发布内容不受影响。'):ui(' 已同步'));
      p.links.replaceChildren();
      if (value.source_url) {const a = this.node('a', value.type === 'material' || value.type === 'maintenance' ? ui('返回任务／继续对话修改') : ui('查看来源与运行详情')); a.href = value.source_url; p.links.append(a);}
      if(['learning','activation'].includes(value.type)){const a=this.node('a',ui('来源与运行设置'));a.href='/settings?tab=capabilities';p.links.append(a);const model=this.node('a',ui('检查模型配置'));model.href='/settings/models';p.links.append(model);}
      if(value.runtime?.error_code==='incompatible'&&['127.0.0.1','localhost','[::1]'].includes(location.hostname)){const a=this.node('a',ui('打开提示词工作台'));a.href='/studio/workbench';a.target='_blank';a.rel='noopener';p.links.append(a);}
      for(const related of value.related||[])p.links.append(this.button(ui('同轮')+typeNames[related.type]+' →',()=>this.open(related.id)));
      for(const material of value.materials||[]){const a=this.node('a',ui('材料：')+material.name);a.href='/materials/'+encodeURIComponent(material.id);p.links.append(a);}
      if (this.returnUrl) {const a = this.node('a', ui('返回之前页面')); a.href = this.returnUrl; p.links.append(a);}
      if(value.answer_sync?.state==='pending'){const a=this.node('a',ui('查看样例并重试答案同步'));a.href='/evaluations?case='+encodeURIComponent(value.answer_sync.case_id);p.links.append(a);}
      const historyList = p.history.querySelector('div'); p.history.hidden = !value.history.length;
      historyList.replaceChildren(...value.history.map(old => this.button(ui('{0} · 历史判断',new Date(old.created_at).toLocaleString()), () => this.open('result:' + old.id))));
      p.feedback.hidden = !value.feedback.supported;
      if (value.feedback.supported) await this.paintFeedback(value);
      if (request !== this.detailSequence || this.parts !== p || value.id !== this.selected) return;
      if (value.review.total) await this.candidates.load(value.id, p.candidates);
      if (request !== this.detailSequence || this.parts !== p) return;
      if (changed || reset) this.$('detail').scrollTop = this.detailScrolls.get(value.id) || this.restore?.detailScroll || 0;
      if(changed||reset)this.$('title').focus({preventScroll:true});
      if(this.proposalTarget){const card=[...p.candidates.querySelectorAll('[data-proposal-id]')].find(c=>c.dataset.proposalId===this.proposalTarget);if(card){card.tabIndex=-1;this.$('detail').scrollTop+=card.getBoundingClientRect().top-this.$('detail').getBoundingClientRect().top-12;card.focus({preventScroll:true});this.proposalTarget=null;}}
      if (this.restore) {this.$('root').querySelector('.inbox-workspace').dataset.detailOpen = this.restore.open || 'true'; this.restore = null;}
      else if (changed && new URLSearchParams(location.search).has('item')) this.$('root').querySelector('.inbox-workspace').dataset.detailOpen = 'true';
    } catch (error) {
      if (request !== this.detailSequence) return;
      this.notice(error.message, true);
      if (!this.parts || this.parts.id !== id) {this.$('title').textContent = ui('记录暂不可用'); this.$('detail').replaceChildren(this.node('p', error.message, 'inbox-empty'), this.button(ui('重试读取'), () => this.readDetail(true)));}
    }
  }
  async paintFeedback(value) {
    const p = this.parts, result = value.feedback_value;
    if (!result || value.feedback.state === 'unavailable' || !value.feedback.total) {
      for (const c of p.feedbackContainers) this.feedback.destroy(c);
      p.feedbackContainers = []; p.resultId = null;
      p.feedback.replaceChildren(this.node('p', feedbackText(value.feedback), 'evaluation-muted')); return;
    }
    if (p.resultId !== result.id) {
      for (const c of p.feedbackContainers) this.feedback.destroy(c);
      p.resultId = result.id; p.feedbackContainers = []; p.feedback.replaceChildren();
      p.feedback.append(this.node('h3', value.type === 'activation' ? ui('场景判断是否合理？') : ui('这次应该触发学习吗？')), this.node('p', ui('满意／不满意只评价触发判断。明确点击后保存为个人测试样例，随时可以取消。'), 'evaluation-muted'));
      if (value.type === 'activation') {
        const matched = this.node('div'), unmatched = this.node('div');
        if (!result.decisions.some(d => d.triggered === true)) p.feedback.append(this.node('p', ui('本次没有命中场景，可在下方评价是否有遗漏。'), 'evaluation-muted'));
        const search=this.node('input');search.type='search';search.placeholder=ui('搜索场景名称或当时的条件');search.setAttribute('aria-label',ui('搜索未命中场景'));
        const section=this.disclosure(ui('未命中场景 · 展开可反馈漏触发'),unmatched);
        p.noScenes=this.node('p',ui('没有符合搜索条件的场景。'),'evaluation-muted');p.noScenes.hidden=true;section.append(p.noScenes);
        section.insertBefore(search,unmatched);p.sceneSearch=search;search.oninput=()=>this.filterScenes();
        p.feedback.append(matched,section);
        p.feedbackContainers = [matched, unmatched];
      } else {const c = this.node('div'); p.feedback.append(c); p.feedbackContainers = [c];}
    }
    for (const [index, container] of p.feedbackContainers.entries()) await this.feedback.render(container, result.id, () => this.load(false), {value:result, compact:true, sceneDetails:value.scenes, decisionScope:value.type === 'activation' ? index === 0 ? 'matched' : 'unmatched' : undefined});
    if (value.type === 'activation') {
      const count = result.decisions.filter(d => d.triggered === false).length;
      const d = p.feedbackContainers[1].parentElement; d.hidden = !count; d.querySelector('summary').textContent = ui('未命中场景 {0} 个 · 展开可反馈漏触发',count);
      p.feedbackContainers[0].hidden = !result.decisions.some(d => d.triggered === true);
      this.filterScenes();
    }
  }
  filterScenes(){const p=this.parts;if(!p?.sceneSearch)return;const query=p.sceneSearch.value.trim().toLocaleLowerCase();const cards=[...p.feedbackContainers[1].querySelectorAll('.evaluation-decision')];for(const card of cards)card.hidden=!(card.dataset.sceneText||card.textContent).toLocaleLowerCase().includes(query);if(p.noScenes)p.noScenes.hidden=cards.some(c=>!c.hidden);}
  async start() {await this.load(true); this.timer = setInterval(this.handle(async () => {if (!document.hidden) await this.load(false);}), 10000);}
}

if (typeof document !== 'undefined' && document.getElementById('inbox-root')) {
  const workspace = new InboxWorkspace();
  workspace.start().catch(error => workspace.notice(error.message, true));
}
