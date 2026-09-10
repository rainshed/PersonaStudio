/* Explicit feedback shared by task rows, drawers and benchmark management. */
(() => {
  const ui=window.StudioI18n?.ui||((text,...args)=>text.replace(/\{(\d+)\}/g,(_m,i)=>String(args[Number(i)]??'')));
  const base = '/api/evaluations/v1', entries = new Map(), bindings = new WeakMap();
  const node = (tag, text, cls = '') => {
    const value = document.createElement(tag); value.textContent = text; value.className = cls; return value;
  };
  const subjectKey = s => `${s.kind}:${s.context_key || ''}`;
  async function api(path, data) {
    const response = await fetch(base + '/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {'Content-Type': 'application/json', 'X-AI-Persona': '1'},
      ...(data === undefined ? {} : {body: JSON.stringify(data)}),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.error?.message || ui('操作未完成。'));
    return value;
  }
  function entry(id) {
    if (!entries.has(id)) entries.set(id, {id, value: null, views: new Set(), drafts: new Map(), pending: false, uncertain: false, error: '', notice: '', undoKey: null});
    return entries.get(id);
  }
  function accept(e, value) {
    if (e.value && value.feedback.revision < e.value.feedback.revision) return;
    if (!e.pending && e.value && value.feedback.revision > e.value.feedback.revision) {
      e.notice = ''; e.undoKey = null; e.error = '';
    }
    if (!e.pending && e.uncertain) e.error = '';
    e.value = value; e.uncertain = false;
    for (const [key] of e.drafts) {
      const feedback = Object.values(value.feedback.subjects).find(f => subjectKey(f.subject) === key);
      if (!feedback?.active || feedback.rating !== 'unsatisfied') e.drafts.delete(key);
    }
  }
  function emit(e) {
    for (const view of e.views) {
      if (view.connected && view.container.isConnected === false) {e.views.delete(view); continue;}
      view.connected ||= view.container.isConnected === true;
      paint(e, view);
    }
  }
  function paint(e, view) {
    const {container, compact, decisionScope, sceneDetails} = view, value = e.value;
    if (!value) return;
    const signature = JSON.stringify([value.decisions, value.feedback, e.pending, e.uncertain, e.error, e.notice, e.undoKey, compact, decisionScope, sceneDetails]);
    if (view.signature === signature) return;
    view.signature = signature;
    const focus = container.contains?.(document.activeElement) ? document.activeElement?.dataset?.feedbackFocus : null;
    container.replaceChildren(); container.classList.add('evaluation-feedback');
    container.classList.toggle('evaluation-feedback-compact', Boolean(compact));
    if (!compact) container.append(node('p', ui('评价是否应该触发学习／偏好场景，不是评价生成内容。明确点击后保存为个人测试样例。'), 'evaluation-muted'));
    if (!value.decisions.length) container.append(node('p', ui('尚无可评价的触发判断。'), 'evaluation-muted'));
    let undo = null;
    for (const decision of value.decisions.filter(d => !decisionScope || (decisionScope === 'matched' ? d.triggered === true : d.triggered === false))) {
      const key = subjectKey(decision.subject), card = node('section', '', 'evaluation-decision');
      const decided = typeof decision.triggered === 'boolean';
      const previous = Object.values(value.feedback.subjects).find(f => subjectKey(f.subject) === key);
      const active = previous?.active ? previous : null;
      card.append(node('strong', `${decision.name || ui('对话学习')}：${decided ? decision.triggered ? ui('触发') : ui('不触发') : ui('暂无判断')}`));
      if(decision.subject.kind==='activation_context'){
        const scene=sceneDetails?.[decision.subject.context_key];
        card.dataset.sceneText=[decision.name,scene?.description,...(scene?.activation?.intents||[]),...(scene?.activation?.artifact_types||[]),...(scene?.activation?.excludes||[])].filter(Boolean).join(' ');
        if(scene){
          card.append(node('p',ui('当时条件：')+(scene.description||scene.activation?.intents?.join('；')||ui('未填写描述')),'evaluation-muted'));
          const snapshot=node('details','');snapshot.append(node('summary',ui('完整触发条件 · 当时 v')+(scene.revision||ui('未知'))));
          for(const [label,key] of [[ui('典型请求'),'intents'],[ui('产物类型'),'artifact_types'],[ui('排除'),'excludes']])if(scene.activation?.[key]?.length)snapshot.append(node('p',label+'：'+scene.activation[key].join('；')));
          card.append(snapshot);
          if(scene.changed)card.append(node('p',ui('当前配置已修改、停用或删除；这里评价的仍是当时版本。'),'evaluation-muted'));
          if(scene.current_url){const a=node('a',ui('查看当前场景配置'));a.href=scene.current_url;card.append(a);}
        }else card.append(node('p',ui('当时的完整场景条件不可用，不使用当前配置补造。'),'evaluation-muted'));
      }
      if (decision.reason) card.append(node('p', decision.reason, 'evaluation-muted'));
      const actions = node('div', '', 'evaluation-actions');
      const addButton = (title, action, suffix) => {
        const b = node('button', title, 'button ghost'); b.type = 'button'; b.disabled = e.pending || e.uncertain;
        b.dataset.feedbackFocus = `${key}:${suffix}`;
        b.addEventListener('click', action); actions.append(b); return b;
      };
      if (decided) {
        for (const [rating, title] of [['satisfied', ui('满意')], ['unsatisfied', ui('不满意')]]) {
          const b = addButton(title, async () => {
            if (active?.rating === rating || e.pending || e.uncertain) return;
            await save(e, view, `results/${e.id}/feedback`, {
              subject: decision.subject, rating, reason: '',
              expected_feedback_revision: e.value.feedback.revision, idempotency_key: crypto.randomUUID(),
            }, active ? ui('反馈已更新。') : ui('已保存为个人测试样例。'), () => {e.undoKey = active ? null : key;});
          }, rating);
          b.setAttribute('aria-pressed', String(active?.rating === rating));
        }
      }
      const withdraw = async () => {
        if (e.pending || e.uncertain) return;
        await save(e, view, `cases/${value.case_id}/withdraw`, {
          subject: decision.subject, expected_feedback_revision: e.value.feedback.revision,
        }, ui('已取消反馈，不再作为有效回测样例；学习任务和 Persona 未改变。'));
      };
      if (active) {
        addButton(ui('取消反馈'), withdraw, 'withdraw');
        if (e.undoKey === key) undo = withdraw;
      }
      card.append(actions);
      if (active?.rating === 'unsatisfied') {
        const field = node('label', '', 'evaluation-reason');
        field.append(node('span', ui('理由（选填，仅用于改进提示词，不参与回测）')));
        const input = node('textarea', ''); input.rows = 2; input.maxLength = 2000;
        input.setAttribute('aria-label', ui('理由（选填，仅用于改进提示词，不参与回测）'));
        input.dataset.feedbackFocus = `${key}:reason`;
        input.value = e.drafts.has(key) ? e.drafts.get(key) : active.reason || '';
        const state = node('small', e.drafts.has(key) ? ui('理由尚未保存') : active.reason ? ui('理由已保存') : ui('不填写也已完成反馈'), 'evaluation-muted');
        state.dataset.reasonState = key;
        input.addEventListener('input', () => {
          e.drafts.set(key, input.value); state.textContent = ui('理由尚未保存');
          for (const other of e.views) for (const text of other.container.querySelectorAll('textarea')) {
            if (text !== input && text.dataset.feedbackFocus === input.dataset.feedbackFocus) text.value = input.value;
          }
          for (const other of e.views) for (const label of other.container.querySelectorAll('small')) {
            if (label.dataset.reasonState === key) label.textContent = ui('理由尚未保存');
          }
        });
        field.append(input, state); card.append(field);
        const b = node('button', ui('保存理由'), 'button ghost'); b.type = 'button'; b.disabled = e.pending || e.uncertain;
        b.dataset.feedbackFocus = `${key}:save-reason`;
        b.addEventListener('click', async () => {
          if (e.pending || e.uncertain) return;
          const text = input.value;
          await save(e, view, `cases/${value.case_id}/reason`, {
            subject: decision.subject, reason: text, expected_feedback_revision: e.value.feedback.revision,
          }, ui('理由已保存，仅用于提示词改进。'), () => {
            if (e.drafts.get(key) === text) e.drafts.delete(key);
          });
        }); card.append(b);
      }
      card.append(node('p', active ? ui('已反馈：{0} · 已保存为个人测试样例',active.rating === 'satisfied' ? ui('满意') : ui('不满意')) : decided ? ui('未反馈') : '', 'evaluation-muted'));
      container.append(card);
    }
    const message = node('p', e.pending ? ui('正在保存…') : e.error || e.notice, e.error ? 'error evaluation-muted' : 'evaluation-muted');
    message.setAttribute('role', 'status'); container.append(message);
    if (undo && !e.pending && !e.uncertain && !e.error) {
      const cancel = node('button', ui('撤销'), 'button ghost'); cancel.type = 'button';
      cancel.addEventListener('click', undo); message.append(cancel);
    }
    if (e.uncertain) {
      const retry = node('button', ui('重试读取'), 'button ghost'); retry.type = 'button'; retry.disabled = e.pending;
      retry.addEventListener('click', async () => {
        if (e.pending) return;
        e.pending = true; emit(e);
        try {accept(e, await api('results/' + e.id)); e.error = '';}
        catch (error) {e.error = error.message + ui(' 无法确认最新状态，请重试读取。');}
        finally {e.pending = false; emit(e);}
      }); container.append(retry);
    }
    if (focus) for (const control of [...container.querySelectorAll('button'), ...container.querySelectorAll('textarea')]) {
      if (control.dataset.feedbackFocus === focus) control.focus?.({preventScroll: true});
    }
  }
  async function save(e, view, path, raw, notice, success) {
    e.pending = true; e.error = ''; e.notice = ''; e.undoKey = null; emit(e);
    let saved;
    try {
      saved = await api(path, raw);
      const result = saved.result || e.value;
      accept(e, {...result, id: e.id, case_id: saved.case_id, feedback: saved.feedback});
      success?.(); e.notice = notice+(saved.answer_sync_state==='failed'?ui(' 审核答案同步失败，反馈和已发布内容已保存；可在样例页重试读取。'):'');
    } catch (error) {
      e.error = error.message;
      try {accept(e, await api('results/' + e.id));} catch {e.uncertain = true; e.error += ui(' 无法确认最新状态，请重试读取。');}
    } finally {e.pending = false; emit(e);}
    if (saved) try {await view.onSaved?.(saved);} catch (error) {e.error = ui('反馈已保存，但任务状态刷新失败：{0}',error.message); emit(e);}
  }
  function destroy(container) {
    const old = bindings.get(container); if (old) old.entry.views.delete(old.view);
    bindings.delete(container);
  }
  async function render(container, id, onSaved, options = {}) {
    const e = entry(id);
    const value = options.value || await api('results/' + encodeURIComponent(id));
    accept(e, value);
    let binding = bindings.get(container);
    if (!binding || binding.entry !== e) {
      destroy(container);
      const view = {container, onSaved, compact: options.compact, decisionScope: options.decisionScope, sceneDetails:options.sceneDetails, signature: null};
      binding = {entry: e, view}; bindings.set(container, binding); e.views.add(view);
    } else {binding.view.onSaved = onSaved; binding.view.compact = options.compact; binding.view.decisionScope = options.decisionScope; binding.view.sceneDetails=options.sceneDetails;}
    e.views.add(binding.view);
    emit(e); return e.value;
  }
  const hasDrafts = () => [...entries.values()].some(e => e.drafts.size);
  window.EvaluationFeedback = {api, render, node, destroy, hasDrafts};
})();
