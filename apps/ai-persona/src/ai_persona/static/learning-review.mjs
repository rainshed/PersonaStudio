import {ReviewWorkspace} from './review-workspace.mjs?v=20260911.review2';
import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
/* Schema-driven review. No independent field whitelist and no implicit feedback. */
export function fieldInput(field, value) {
  if (field.kind === 'lines') return value.split('\n').map(v => v.trim()).filter(Boolean);
  if (field.kind === 'json') return JSON.parse(value);
  if (field.nullable && value === '') return null;
  return value;
}
export function changedFields(original, current) {
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(original[key]) !== JSON.stringify(value)));
}
const states = {pending_review:ui('待审核'), deferred:ui('稍后审核'), accepted:ui('已通过'), edited_and_accepted:ui('修改后通过'), rejected:ui('已拒绝'), stale:ui('已过期')};
const types = {knowledge_node:ui('知识'), preference:ui('偏好'), relation:ui('关系'), preference_context:ui('场景'), material:ui('材料'), course:ui('课程'), evidence:ui('来源引用'), preference_example:ui('参考示例'), tag:ui('标签')};
export class LearningReviewPanel {
  constructor({api, node, button, notice, refresh, reviewPath, allowDefer = false}) {
    Object.assign(this, {api, node, button, notice, refresh, allowDefer});
    this.reviewPath = reviewPath || (id => `events/${encodeURIComponent(id)}/review`);
    this.cards = new Map(); this.drafts = new Map(); this.sequence = 0;
  }
  hasDrafts() {return [...this.drafts.values()].some(d => Object.keys(d.updates).length || d.invalid);}
  async load(eventId, container) {
    const sequence = ++this.sequence;
    try {
      const result = await this.api(this.reviewPath(eventId));
      if (sequence !== this.sequence || !container.isConnected) return;
      this.render(eventId, container, result);
    } catch (error) {
      if (sequence !== this.sequence || !container.isConnected) return;
      if (!container.children.length) container.append(this.node('p', ui('候选读取失败。'), 'error'), this.button(ui('重试读取候选'), () => this.load(eventId, container)));
      else this.notice(error.message, true);
    }
  }
  render(eventId, container, result) {
    this.references = result.references;
    if(result.graph?.nodes.length && document.getElementById('review-graph-template')) {
      if(!this.workspace || this.workspace.container!==container || this.workspace.eventId!==eventId){this.workspace?.destroy();this.workspace=new ReviewWorkspace(this,eventId,container);}
      this.workspace.result=result;
    } else {this.workspace?.destroy();this.workspace=null;}
    const roots = result.proposals.map(value => {
      let card = this.cards.get(value.id);
      if (!card) {card = {root: this.node('article', '', 'learning-candidate')}; this.cards.set(value.id, card);}
      if (card.value && (card.value.revision > value.revision || (card.value.revision === value.revision && (card.value.saved?.revision || 0) > (value.saved?.revision || 0)))) return card.root;
      card.eventId = eventId; card.container = container; card.value = value;
      if(['pending_review','deferred'].includes(value.status) && value.fields.some(f=>f.group==='personal'&&!f.readonly) && !this.drafts.has(value.id))this.drafts.set(value.id,{revision:value.revision,updates:{},errors:new Set(),raw:{},open:[],full:false});
      const signature = JSON.stringify([value, result.references]);
      if (card.signature !== signature) {card.signature = signature; this.paint(card);}
      return card.root;
    });
    if(this.workspace){this.workspace.render(roots);return;}
    if (!roots.length) roots.push(this.node('p', ui('本次没有候选内容需要审核。'), 'learning-empty'));
    if (container.children.length !== roots.length || roots.some((r, i) => container.children[i] !== r)) container.replaceChildren(...roots);
  }
  format(field, value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return ui('未设置');
    if (field.kind === 'json') return JSON.stringify(value, null, 2);
    const label = v => field.choices?.[v] || this.references?.[v] || v;
    if (Array.isArray(value)) return value.map(label).join('、');
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return label(value);
  }
  paint(card) {
    const n = this.node, value = card.value, draft = this.drafts.get(value.id), root = card.root;
    const restoreFocus=root.contains(document.activeElement);root.tabIndex=-1;
    root.dataset.proposalId = value.id;
    root.replaceChildren();
    const pending = ['pending_review', 'deferred'].includes(value.status);
    const conflict = draft && draft.revision !== value.revision;
    const editing = Boolean(draft && pending && !conflict);
    const fullEditing = editing && draft.full !== false;
    const heading = n('div', '', 'learning-candidate-head');
    heading.append(n('span', (types[value.entity_type] || value.entity_type)+' · '+({create:ui('新增'),update:ui('修改'),relate:ui('关联'),archive:ui('归档'),restore:ui('恢复')}[value.operation]||value.operation||''), 'learning-kind'), n('h4', value.title), n('span', states[value.status] || value.status, 'learning-status-chip'));
    root.append(heading);
    if (value.note) root.append(n('p', value.note, 'evaluation-muted'));
    if(value.sources?.length){const sources=n('div','','review-sources');sources.append(n('small',ui('来源：')));for(const source of value.sources){const label=n(source.url?'a':'span',source.title);if(source.url){label.href=source.url;label.target='_blank';label.rel='noopener';}sources.append(label);}root.append(sources);}
    if(value.source_evidence?.length){
      const evidence=n('details');evidence.append(n('summary',ui('查看依据 · ')+value.source_evidence.length+ui(' 条')));
      for(const item of value.source_evidence){evidence.append(n('p',ui('第 ')+item.locator.line_start+'–'+item.locator.line_end+ui(' 行')),n('p',item.body));}
      root.append(evidence);
    }
    if (value.stale) root.append(n('p', ui('Persona 已有更新，此候选不能直接通过。请重新整理任务。'), 'error'));
    if (conflict) root.append(n('p', ui('候选已在其他位置处理，未提交本地修改。请核对最新内容；可放弃本地草稿。'), 'error'));
    if (value.dependencies.length && pending) {const dependencies=n('div','','learning-dependency');dependencies.append(n('p',ui('需要先通过关联内容：')));for(const d of value.dependencies)dependencies.append(this.button(d.title,()=>this.workspace?.select(d.id)));root.append(dependencies);}
    const form = n('form', '', 'learning-candidate-fields'); card.form = form;
    form.noValidate = true;
    const validate = () => {
      for (const input of form.querySelectorAll(':invalid')) {const group = input.closest('details'); if (group) group.open = true;}
      return form.reportValidity();
    };
    form.onsubmit = event => {event.preventDefault(); if (validate()) this.decide(card, 'accept');};
    const groups = new Map();
    for (const field of value.fields) {
      let group = groups.get(field.group);
      if (!group) {
        group = n(['main','personal'].includes(field.group) ? 'div' : 'details', '', 'learning-field-group');
        if (field.group !== 'main') group.append(n(field.group==='personal'?'h5':'summary', field.group === 'personal' ? ui('我的掌握与兴趣 · 仅由你填写') : ui('更多属性')));
        if (editing && draft.open?.includes(field.group)) group.open = true;
        group.ontoggle = () => {if (draft) draft.open = [...groups].filter(([, g]) => g.open).map(([key]) => key);};
        groups.set(field.group, group); form.append(group);
      }
      const wrapper = n('div', '', 'learning-property'); wrapper.dataset.field = field.name;
      const label = n('label', field.label + (field.readonly ? ui(' · 只读') : ''));
      wrapper.append(label);
      const effective = editing && field.name in draft.updates ? draft.updates[field.name] : value.values[field.name];
      if (!editing || (field.group!=='personal' && !fullEditing) || field.readonly) wrapper.append(n('div', this.format(field, effective), 'learning-property-value'));
      else {
        let input;
        const inputId = `${value.id}-${field.name}`; label.htmlFor = inputId;
        if (field.kind === 'tags') {
          input = n('div', '', 'learning-reference-options');
          const options = {...field.choices};
          for (const ref of effective || []) if (!(ref in options)) options[ref] = ref;
          for (const [id, title] of Object.entries(options)) {
            const choice = n('label', ''), box = n('input', ''); box.type = 'checkbox'; box.value = id; box.checked = (effective || []).includes(id);
            choice.append(box, n('span', title)); input.append(choice);
          }
          if (!Object.keys(options).length) input.append(n('small', ui('暂无可选择的记录')));
        } else if (field.kind === 'select') {
          input = n('select', '');
          for (const [id, title] of Object.entries(field.choices)) {const option = n('option', title); option.value = id; input.append(option);}
          input.value = effective ?? '';
        } else {
          input = n(field.kind === 'text' ? 'input' : 'textarea', '');
          input.value = draft.raw?.[field.name] ?? (field.kind === 'lines' ? (effective || []).join('\n') : field.kind === 'json' ? JSON.stringify(effective, null, 2) : effective ?? '');
          if (input.tagName === 'TEXTAREA') input.rows = field.name === 'body' ? 5 : 3;
          if (['source_id', 'target_id'].includes(field.name)) {
            const list = n('datalist', ''); list.id = inputId + '-choices'; input.setAttribute('list', list.id);
            for (const [id, title] of Object.entries(this.references || {})) {const option = n('option', title); option.value = id; list.append(option);}
            wrapper.append(list);
          }
        }
        input.id = inputId; input.dataset.fieldInput = field.name;
        if (field.kind !== 'tags') {input.name = field.name; input.required = field.required && !field.nullable;}
        const error = n('small', '', 'error'); error.id = inputId + '-error'; input.setAttribute('aria-describedby', error.id);
        const collect = () => {
          try {
            const raw = field.kind === 'tags' ? [...input.querySelectorAll('input:checked')].map(e => e.value) : input.value;
            draft.raw ||= {}; if (field.kind !== 'tags') draft.raw[field.name] = raw;
            const next = field.kind === 'tags' ? raw : fieldInput(field, raw);
            draft.updates = changedFields(value.values, {...draft.updates, [field.name]: next});
            draft.errors.delete(field.name); error.textContent = '';
          } catch {draft.errors.add(field.name); error.textContent = ui('格式不正确，请填写有效的 JSON。');}
          draft.invalid = draft.errors.size > 0;
        };
        input.addEventListener('input', collect); input.addEventListener('change', collect);
        wrapper.append(input, error);
      }
      group.append(wrapper);
    }
    root.append(form);
    const message = n('p', '', 'error'); message.setAttribute('role', 'status'); card.message = message; root.append(message);
    const actions = n('div', '', 'learning-actions');
    if (pending) {
      if (!fullEditing && !conflict && value.fields.some(f => !f.readonly)) actions.append(this.button(ui('编辑全部属性'), () => {this.drafts.set(value.id, {revision: value.revision, updates: {}, errors: new Set(), raw: {}, open: [], ...this.drafts.get(value.id), full:true}); this.paint(card);card.form.querySelector('input,select,textarea')?.focus({preventScroll:true});}));
      const accept = this.button(Object.keys(draft?.updates||{}).length ? ui('保存并通过') : ui('通过'), () => {
        if (!validate()) return;
        return this.decide(card, 'accept');
      }); accept.classList.remove('ghost'); accept.classList.add('primary-button'); accept.disabled = value.stale || Boolean(value.dependencies.length) || conflict; actions.append(accept);
      const reject = this.button(value.pending_dependents.length ? ui('拒绝（含 {0} 条关联候选）',value.pending_dependents.length) : ui('拒绝'), () => this.decide(card, 'reject'));
      actions.append(reject);
      if (this.allowDefer && value.status !== 'deferred') actions.append(this.button(ui('稍后审核'), () => this.decide(card, 'defer')));
    }
    if (draft && (fullEditing || Object.keys(draft.updates).length)) actions.append(this.button(ui('放弃本地修改'), () => {
      if ((Object.keys(draft.updates).length || draft.invalid) && !confirm(ui('放弃这条候选尚未保存的修改？'))) return;
      this.drafts.delete(value.id); this.paint(card);
    }));
    root.append(actions);
    if(value.record_url){const link=n('a',ui('查看正式记录 →'));link.href=value.record_url;root.append(link);}
    if(pending&&value.dependent_titles?.length)root.append(n('p',ui('拒绝此项也会拒绝：')+value.dependent_titles.join('、'),'learning-dependency'));

    const audit = n('details', '', 'learning-audit'); audit.append(n('summary', ui('技术详情')));
    for (const [title, content] of [[ui('修改前（本次涉及的属性）'),value.before_patch],[ui('AI 原始候选改动'), value.original_patch], [ui('审核时修改的属性'), value.review_patch], [ui('后端当前保存值（含系统属性）'), value.saved]]) {
      audit.append(n('h5', title), n('pre', content ? JSON.stringify(content, null, 2) : ui('尚未保存')));
    }
    root.append(audit);
    if (card.pending) for (const input of root.querySelectorAll('button,input,select,textarea')) input.disabled = true;
    if(restoreFocus&&root.isConnected)root.focus({preventScroll:true});
  }
  async decide(card, action) {
    if (card.pending || this.batchPending) return;
    const {value, eventId} = card, draft = this.drafts.get(value.id);
    if (action === 'accept' && draft?.invalid) {card.message.textContent = ui('请先修正标出的属性。'); return;}
    if (action === 'defer' && (Object.keys(draft?.updates || {}).length || draft?.invalid) && !confirm(ui('暂缓审核不会保存本地修改。放弃修改并暂缓？'))) return;
    if (action === 'reject' && !confirm(value.pending_dependents.length ? ui('拒绝此候选也会拒绝依赖它的 {0} 条候选：{1}。确定吗？',value.pending_dependents.length,(value.dependent_titles||[]).join('、')) : ui('拒绝此候选？不会改变你对触发判断的反馈。'))) return;
    card.pending = true;
    if(card.root.isConnected)card.root.focus({preventScroll:true});
    for (const input of card.root.querySelectorAll('button,input,select,textarea')) input.disabled = true;
    card.message.textContent = ui('正在保存…');
    try {
      const result = await this.api(`${this.reviewPath(eventId)}/${encodeURIComponent(value.id)}`, {action, revision: draft?.revision ?? value.revision, updates: action === 'accept' ? draft?.updates || {} : {}});
      this.drafts.delete(value.id); card.pending = false;
      this.render(eventId, card.container, result);
      this.notice(action === 'accept' ? ui('已通过并保存。') : action === 'defer' ? ui('已暂缓，可以稍后继续。') : ui('候选已拒绝。触发反馈未改变。'));
      await this.refresh().catch(error => this.notice(ui('审核已保存，列表状态暂未更新：') + error.message, true));
    } catch (error) {
      card.pending = false; this.paint(card); card.message.textContent = error.message;
      for (const [name, text] of Object.entries(error.fields || {})) {
        const field = [...card.root.querySelectorAll('[data-field]')].find(e => e.dataset.field === name);
        if (field) {if (field.parentElement.tagName === 'DETAILS') field.parentElement.open = true; const target = field.querySelector('.error'); if (target) target.textContent = text;}
      }
      // Reconcile uncertain/stale writes through the server, never replay automatically.
      if (!error.fields || !Object.keys(error.fields).length) await this.load(eventId, card.container);
    }
  }
}
