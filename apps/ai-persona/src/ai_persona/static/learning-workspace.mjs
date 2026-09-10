/* Task workspace: stable master/detail selection, independent feedback and review. */
import {LearningReviewPanel} from './learning-review.mjs?v=20260911.review2';
export class LearningListState {
  constructor() {this.ids = []; this.items = new Map(); this.sequence = 0;}
  apply(response, replace = false) {
    if (replace) {this.ids = response.events.map(e => e.id); this.items.clear();}
    for (const item of [...response.events, ...(response.updates || [])]) {
      if (!this.ids.includes(item.id)) continue;
      const previous = this.items.get(item.id);
      if (previous && item.version < previous.version) continue;
      if (previous?.current_result_id === item.current_result_id && previous?.feedback.revision > item.feedback.revision) continue;
      this.items.set(item.id, item);
    }
  }
}

export class LearningWorkspace {
  constructor({api, node, button, notice, labels, errorLabels}) {
    Object.assign(this, {api, node, button, notice, labels, errorLabels});
    this.$ = id => document.getElementById('learning-' + id);
    this.feedback = window.EvaluationFeedback;
    this.list = new LearningListState(); this.rows = new Map(); this.selected = null;
    this.detailSequence = 0; this.detailValue = null; this.detailParts = null; this.started = false;
    this.cursors = []; this.cursor = null; this.nextCursor = null; this.configSignature = '';
    this.savedForms = new Map(); this.query = {};
    this.detailScrolls = new Map();
    this.candidates = new LearningReviewPanel({api, node, button, notice, refresh: () => this.load(false)});
    this.initialEvent = new URLSearchParams(location.search).get('event');
    this.initialSettings = new URLSearchParams(location.search).get('settings') === '1';
    this.taskDialog = this.$('task-dialog'); this.settingsDialog = this.$('settings-dialog');
    const initial = history.state?.learningWorkspace;
    if (initial) {this.query = initial.query || {}; this.cursor = initial.cursor; this.cursors = initial.cursors || [];}
    this.restore = initial;
    for (const [key, value] of Object.entries(this.query)) if (this.$('filters').elements[key]) this.$('filters').elements[key].value = value;
    this.$('filters').addEventListener('submit', event => {event.preventDefault(); this.filter();});
    for (const select of this.$('filters').querySelectorAll('select')) select.addEventListener('change', () => this.filter());
    for (const tab of this.$('feedback-tabs').querySelectorAll('button')) {
      tab.setAttribute('aria-pressed', String(tab.dataset.feedbackFilter === (this.query.feedback || '')));
      tab.onclick = () => {this.$('filters').elements.feedback.value = tab.dataset.feedbackFilter; this.filter();};
    }
    this.$('new').onclick = () => this.reload();
    this.$('prev').onclick = () => {if (this.cursors.length) {this.cursor = this.cursors.pop(); this.load(true).catch(e => notice(e.message, true));}};
    this.$('next').onclick = () => {if (this.nextCursor) {this.cursors.push(this.cursor); this.cursor = this.nextCursor; this.load(true).catch(e => notice(e.message, true));}};
    this.$('detail-close').onclick = () => {this.taskDialog.hidden = true; this.$('list-pane').hidden = false; this.rows.get(this.selected)?.title.focus({preventScroll:true});};
    this.$('settings-close').onclick = () => this.settingsDialog.close();
    this.$('settings-open').onclick = event => {this.openDialog(this.settingsDialog, event.currentTarget);};
    this.$('detail-prev').onclick = () => this.neighbor(-1);
    this.$('detail-next').onclick = () => this.neighbor(1);
    for (const dialog of [this.settingsDialog]) dialog.addEventListener('close', () => {
      dialog.returnFocus?.focus({preventScroll: true});
      if (dialog.pageScroll) window.scrollTo(dialog.pageScroll.x, dialog.pageScroll.y);
    });
    window.addEventListener('beforeunload', event => {
      if (this.candidates.hasDrafts() || this.feedback.hasDrafts() || [...this.savedForms.keys()].some(f => this.isDirty(f))) {event.preventDefault(); event.returnValue = '';}
    });
    window.addEventListener('pagehide', () => this.remember());
    window.addEventListener('pageshow', () => {if (this.started) this.load(false).catch(e => notice(e.message, true));});
    document.addEventListener('visibilitychange', () => {if (!document.hidden && this.started) this.load(false).catch(e => notice(e.message, true));});
  }
  formValue(form) {return JSON.stringify([...form.elements].filter(f => f.name).map(f => [f.name, f.type === 'checkbox' ? f.checked : f.value]));}
  markSaved(form) {this.savedForms.set(form, this.formValue(form));}
  isDirty(form) {return this.savedForms.has(form) && this.savedForms.get(form) !== this.formValue(form);}
  remember() {
    const url = new URL(location.href);
    if (this.selected || this.initialEvent) url.searchParams.set('event', this.selected || this.initialEvent); else url.searchParams.delete('event');
    history.replaceState({...history.state, learningWorkspace: {query: this.query, cursor: this.cursor, cursors: this.cursors, scroll: window.scrollY, listScroll: this.$('events').scrollTop}}, '', url);
  }
  openDialog(dialog, source) {
    if (!dialog.open) {
      dialog.returnFocus = source || document.activeElement;
      dialog.pageScroll = {x: window.scrollX, y: window.scrollY};
      dialog.showModal(); window.scrollTo(dialog.pageScroll.x, dialog.pageScroll.y);
    }
  }
  async refresh(config) {
    const signature = JSON.stringify(config.connections.map(c => [c.id, c.name]));
    if (signature !== this.configSignature) {
      this.configSignature = signature;
      const select = this.$('filters').elements.connection_id, value = select.value || this.query.connection_id;
      const option = (title, id) => {const o = this.node('option', title); o.value = id; return o;};
      select.replaceChildren(option('全部来源', ''), ...config.connections.map(c => option(c.name, c.id)));
      select.value = value || '';
    }
    if (!this.started) {
      this.started = true; await this.load(true);
      if (this.restore?.scroll) window.scrollTo(0, this.restore.scroll);
      if (this.restore?.listScroll) this.$('events').scrollTop = this.restore.listScroll;
      const id = this.initialEvent; this.initialEvent = null;
      if (id) await this.openDetail(id, this.rows.get(id)?.title || this.$('tasks-title'));
      if (this.initialSettings) this.openDialog(this.settingsDialog, this.$('settings-open'));
    } else await this.load(false);
  }
  filter() {
    this.query = Object.fromEntries(new FormData(this.$('filters')));
    this.cursor = null; this.cursors = [];
    this.load(true).catch(e => this.notice(e.message, true));
    for (const tab of this.$('feedback-tabs').querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab.dataset.feedbackFilter === this.query.feedback));
  }
  reload() {this.cursor = null; this.cursors = []; return this.load(true).catch(e => this.notice(e.message, true));}
  async load(replace) {
    // A timer must not supersede an explicit filter/page/reload request with an
    // update-only response: that would leave stale (or empty) row membership.
    if (!replace && this.replacing) return;
    const request = ++this.list.sequence;
    if (replace) this.replacing = request;
    try {
    const query = new URLSearchParams({...this.query, limit: '20'});
    if (this.cursor) query.set('cursor', this.cursor);
    if (!replace) query.set('ids', this.list.ids.join(','));
    const response = await this.api('events?' + query);
    if (request !== this.list.sequence) return;
    this.cursor = response.cursor; this.nextCursor = response.next_cursor;
    this.list.apply(response, replace);
    if (replace) {
      const nextRows = new Map();
      for (const id of this.list.ids) nextRows.set(id, this.rows.get(id) || this.createRow(id));
      for (const [id, row] of this.rows) if (!nextRows.has(id)) this.feedback.destroy(row.feedback);
      this.rows = nextRows;
      this.$('events').replaceChildren(...this.list.ids.map(id => this.rows.get(id).root));
    }
    for (const id of this.list.ids) await this.updateRow(this.list.items.get(id));
    if (!this.list.ids.length) this.$('events').replaceChildren(this.node('p', response.all_count ? '没有符合当前条件的任务。可以更改筛选条件。' : '尚未接收任务。请在学习设置中配置来源。', 'learning-empty'));
    this.$('count').textContent = `符合条件 ${response.total} 条 · 每页 20 条`;
    this.$('page').textContent = `第 ${this.cursors.length + 1} 页`;
    this.$('prev').disabled = !this.cursors.length; this.$('next').disabled = !response.has_more;
    this.$('new').hidden = !response.new_count;
    this.$('new').textContent = `有 ${response.new_count} 条新任务，点击更新`;
    this.markSelection(); this.remember();
    if (replace && !this.selected && !this.initialEvent && this.list.ids.length && this.candidates) await this.openDetail(this.list.ids[0], this.rows.get(this.list.ids[0])?.title, false);
    if (!replace && this.selected) await this.readDetail(this.selected, false);
    } finally {if (this.replacing === request) this.replacing = null;}
  }
  status(item) {return this.labels[item.status === 'completed' ? item.outcome : item.status] || this.labels[item.status] || item.status;}
  createRow(id) {
    const n = this.node, root = n('article', '', 'learning-task'); root.dataset.taskId = id;
    const main = n('div', ''), title = this.button('', event => this.openDetail(id, title)); title.className = 'learning-task-title';
    const meta = n('div', '', 'learning-task-meta'), source = n('span', ''), time = n('span', ''), status = n('span', '', 'learning-status-chip'); meta.append(source, time, status);
    const inputState = n('small', '', 'evaluation-muted'), review = n('p', '', 'evaluation-muted');
    const changed = n('p', '', 'learning-task-note'), feedback = n('span', '', 'learning-feedback-state');
    main.append(title, meta, feedback, inputState, review, changed); root.append(main);
    return {root, title, source, time, status, inputState, review, feedback, changed};
  }
  reviewText(summary) {
    if (!summary || summary.unavailable) return '候选状态暂不可用';
    if (!summary.total) return '本次未生成候选';
    const types = {knowledge_node: '知识', preference: '偏好', relation: '关系', preference_context: '场景'};
    const descriptions = Object.entries(summary.types).map(([key, count]) => `${types[key] || key} ${count} 条`);
    const approved = (summary.statuses.accepted || 0) + (summary.statuses.edited_and_accepted || 0);
    const pending = (summary.statuses.pending_review || 0) + (summary.statuses.deferred || 0);
    return `${descriptions.join(' · ')}；已通过 ${approved} 条，待审核 ${pending} 条`;
  }
  async mountFeedback(container, item, compact = false) {
    if (item.feedback_value && (item.feedback.can_rate || item.feedback.can_withdraw)) {
      await this.feedback.render(container, item.current_result_id, async () => {await this.load(false);}, {value: item.feedback_value, compact});
    } else {
      this.feedback.destroy(container);
      const text = item.feedback.disabled_reason || '暂无有效触发判断';
      if (container.dataset.unavailable !== text || container.querySelector('button')) {
        container.replaceChildren(this.node('p', text, 'learning-feedback-unavailable'));
        if (item.feedback.state === 'unavailable') container.append(this.button('重试读取', () => this.load(false)));
      }
      container.dataset.unavailable = text;
    }
  }
  async updateRow(item) {
    const row = this.rows.get(item.id); if (!row) return;
    row.title.textContent = item.input_preview || '输入内容已清理';
    row.root.setAttribute('aria-label', `任务：${item.input_preview || item.id}`);
    row.source.textContent = item.source_name; row.time.textContent = new Date(item.created * 1000).toLocaleString();
    const decision = item.triggered === true ? '触发学习' : item.triggered === false ? '不触发学习' : '';
    row.status.textContent = item.status === 'completed' && decision ? decision : [this.status(item), decision].filter(Boolean).join(' · ');
    row.inputState.textContent = item.input_state === 'benchmark' ? '输入来自已保存的样例快照' : item.input_state === 'expired' ? '原临时输入已清理' : '';
    row.review.textContent = item.change_set_id ? this.reviewText(item.review_summary) : '';
    const matchesFeedback = this.query.feedback === 'rated' ? ['satisfied', 'unsatisfied'].includes(item.feedback.state) : item.feedback.state === this.query.feedback;
    row.changed.textContent = this.query.feedback && !matchesFeedback ? '状态已更新，刷新列表后移出当前筛选。' : '';
    row.feedback.textContent = {satisfied:'已反馈 · 满意', unsatisfied:'已反馈 · 不满意', unrated:'未反馈', unavailable:'反馈状态暂不可用'}[item.feedback.state] || '未反馈';
    row.feedback.dataset.state = item.feedback.state;
  }
  markSelection() {
    for (const [id, row] of this.rows) {row.root.dataset.selected = String(id === this.selected); row.title.setAttribute('aria-pressed', String(id === this.selected));}
    const index = this.list.ids.indexOf(this.selected);
    this.$('detail-prev').disabled = index <= 0; this.$('detail-next').disabled = index < 0 || index >= this.list.ids.length - 1;
  }
  neighbor(offset) {const id = this.list.ids[this.list.ids.indexOf(this.selected) + offset]; if (id) this.openDetail(id, this.rows.get(id)?.title);}
  async openDetail(id, source, userAction = true) {
    if (this.selected) this.detailScrolls.set(this.selected, this.$('detail').scrollTop);
    this.settingsDialog.close(); this.selected = id; this.taskDialog.hidden = false;
    if (userAction && window.matchMedia('(max-width: 760px)').matches) this.$('list-pane').hidden = true;
    this.taskDialog.returnFocus = source || this.rows.get(id)?.title;
    this.markSelection(); this.remember(); await this.readDetail(id, true);
  }
  async readDetail(id, replace) {
    const request = ++this.detailSequence;
    if (replace) {
      if (this.detailParts) this.feedback.destroy(this.detailParts.feedback);
      this.$('detail').replaceChildren(this.node('p', '正在读取任务…')); this.detailParts = null;
    }
    try {
      const value = await this.api('events/' + encodeURIComponent(id));
      if (request !== this.detailSequence || this.selected !== id) return;
      this.detailValue = value;
      if (!this.detailParts) this.createDetail();
      const p = this.detailParts;
      this.$('detail-meta').textContent = `${value.source_name} · ${new Date(value.created * 1000).toLocaleString()}`;
      p.status.textContent = `${this.status(value)} · ${value.triggered === null ? '暂无判断' : value.triggered ? '触发学习' : '不触发学习'}`;
      const content = value.judgment_input || value.event?.message?.content || [];
      p.input.textContent = (value.user_input ?? content.map(x => x.text || '').join('\n')) || '输入内容已清理。';
      p.context.hidden = !value.context_snapshot; p.contextText.textContent = value.context_snapshot ? JSON.stringify(value.context_snapshot, null, 2) : '';
      p.explanation.textContent = (value.observations || []).map(o => o.signal.statement).join('\n');
      await this.mountFeedback(p.feedback, value);
      if (request !== this.detailSequence || this.selected !== id) return;
      p.review.textContent = this.reviewText(value.review_summary); p.reviewLink.hidden = !value.change_set_id;
      p.reviewLink.href = '/review?change_set=' + encodeURIComponent(value.change_set_id || '');
      p.error.textContent = value.error_code ? this.errorLabels[value.error_code] || value.error_code : '';
      const basis = {trusted_source:'按来源信任设置继续，未验证人工输入',verified_human:'采集端已验证人工来源',confirmed_human:'你已确认本条为人工输入'};
      p.origin.textContent = [basis[value.origin_basis], `任务：${value.id}`, `版本：${value.version}`, value.current_result_id ? `本轮结果：${value.current_result_id}` : '本轮尚无结果'].filter(Boolean).join('\n');
      const historySignature = JSON.stringify((value.history || []).map(r => [r.id, r.feedback.revision]));
      if (p.history.dataset.signature !== historySignature) p.history.replaceChildren(...(value.history || []).map(result => {
        const rated = Object.values(result.feedback.subjects).some(f => f.active);
        const a = this.node('a', `${new Date(result.created_at).toLocaleString()} · ${rated ? '已有反馈' : '未反馈或已撤回'}`, 'button ghost');
        a.href = '/evaluations?result=' + encodeURIComponent(result.id); a.addEventListener('click', () => this.remember()); return a;
      }));
      p.history.dataset.signature = historySignature;
      p.historyDetails.hidden = !value.history?.length;
      this.taskActions(value, p.actions);
      if (this.candidates) await this.candidates.load(id, p.candidates);
      if (replace && request === this.detailSequence && this.selected === id) this.$('detail').scrollTop = this.detailScrolls?.get(id) || 0;
    } catch (error) {
      if (request !== this.detailSequence) return;
      if (replace) this.$('detail').replaceChildren(this.node('p', error.message, 'error'), this.button('重试读取', () => this.readDetail(id, true)));
      else this.notice(error.message, true);
    }
  }
  createDetail() {
    const n = this.node, p = {}, container = this.$('detail'); container.replaceChildren();
    p.status = n('p', '', 'learning-status-chip'); p.input = n('pre', '');
    p.context = n('details', ''); p.contextText = n('pre', ''); p.context.append(n('summary', '必要上下文'), p.contextText);
    p.explanation = n('p', '', 'learning-explanation'); p.feedback = n('div', ''); p.review = n('p', '');
    p.reviewLink = n('a', '在待审核区查看', 'learning-review-link'); p.reviewLink.addEventListener('click', () => this.remember());
    p.candidates = n('div', '', 'learning-candidates');
    const runtime = n('details', ''); p.origin = n('p', '', 'evaluation-muted'); p.error = n('p', '', 'error'); p.actions = n('div', '', 'learning-actions');
    runtime.append(n('summary', '运行与来源信息'), p.origin, p.error, p.actions);
    p.historyDetails = n('details', ''); p.history = n('div', '', 'learning-actions'); p.historyDetails.append(n('summary', '历史结果／反馈'), p.history);
    container.append(p.status, n('h3', '用户输入'), p.input, p.context, p.explanation,
      n('h3', '这次应该触发学习吗？'), p.feedback, n('h3', '候选内容 · 在这里审核'),
      p.review, p.reviewLink, p.candidates, runtime, p.historyDetails);
    this.detailParts = p;
  }
  taskActions(value, container) {
    const signature = JSON.stringify([value.id, value.status]); if (container.dataset.signature === signature) return;
    container.dataset.signature = signature; container.replaceChildren();
    const run = async action => {
      const current = this.detailValue;
      await this.api(`events/${current.id}/${action}`, {version: current.version});
      await this.load(false);
    };
    if (value.status === 'waiting_origin') {
      container.append(this.button('仅确认本条为人工输入', () => run('confirm-human')),
        this.button('信任此来源并继续', async () => {
          const config = await this.api('config'), connection = config.connections.find(c => c.id === this.detailValue.connection_id);
          if (!connection) throw new Error('来源连接不存在。');
          const saved = await this.api('connections', {...connection, trust_user_messages: true});
          this.notice(`已信任来源，${saved.resumed_events} 条任务重新排队。候选仍须审核。`); await this.load(false);
        }));
    }
    if (['failed','retryable_failed','paused','paused_budget'].includes(value.status)) container.append(this.button('重试任务', () => run('retry')));
    if (!['completed','cancelled'].includes(value.status)) container.append(this.button('取消任务', () => run('cancel')));
  }
}
