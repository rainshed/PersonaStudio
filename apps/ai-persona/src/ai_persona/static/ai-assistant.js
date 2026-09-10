(() => {
  const { L, node, api, notice } = window.PersonaAI;
  const $ = id => document.getElementById(id), root = $('ai-root');
  const vocabulary = JSON.parse($('ai-labels').textContent);
  let session = null, timer, busy = false, dirty = false, editors = [];
  let options = [], inputDirty = false, suggestedMessage = '', pendingFiles = [];
  const scenarios = {
    paper: { mode: 'link', types: ['material', 'knowledge_node'],
      message: L('请整理这篇论文的材料信息、核心问题、方法与结论，提取相关知识和关系候选。优先复用已有概念，为每项候选附上原文依据；不要推断我的掌握程度。', 'Summarize the paper and propose a Material, knowledge and relationships. Reuse existing concepts, cite source evidence, and do not infer my knowledge level.') },
    notes: { mode: 'file', types: ['knowledge_node'],
      message: L('请从这份 notes 中提取核心概念、定义和它们之间的关系，整理成知识结构候选。区分原文陈述与推测，优先复用已有知识，并附上原文依据。', 'Extract concepts, definitions and relationships from these notes. Reuse existing knowledge, distinguish statements from speculation, and cite source evidence.') },
    course: { mode: 'file', types: ['course', 'knowledge_node'],
      message: L('请根据课程截图或大纲整理课程名称、简介、章节安排和主要内容，并提取相关知识与关系候选。没有明确写出的信息请留空或向我询问。', 'Use the course screenshot or syllabus to propose course details, an outline, knowledge and relationships. Ask about information absent from the source.') },
  };
  function sourceNotice(message = '', error = false, reviewUrl = '') {
    const box = $('ai-source-notice');
    box.hidden = !message; box.classList.toggle('ai-error', error);
    box.replaceChildren(node('span', message));
    if (reviewUrl) {
      const link = node('a', L('打开材料导入核对 ↗', 'Review material import ↗'));
      link.href = reviewUrl; link.target = '_blank'; link.rel = 'noopener'; box.append(link);
    }
  }
  function sourceMode(mode) {
    for (const button of root.querySelectorAll('[data-source-mode]')) {
      const active = button.dataset.sourceMode === mode;
      button.setAttribute('aria-pressed', String(active));
      $('ai-source-' + button.dataset.sourceMode).hidden = !active;
    }
  }
  function chooseScenario(key) {
    const value = scenarios[key];
    if (!value || ['running', 'submitting'].includes(session?.status) || session?.can_refine === false) return;
    sourceMode(value.mode);
    for (const button of root.querySelectorAll('[data-scenario]')) button.setAttribute('aria-pressed', String(button.dataset.scenario === key));
    const types = new Set(value.types);
    for (const id of selectedValues('ai-record-options')) {
      const type = options.find(r => r.id === id)?.entity_type;
      if (type) types.add(type.startsWith('preference') ? 'preference' : type);
    }
    for (const box of $('ai-target-types').querySelectorAll('input')) box.checked = types.has(box.value);
    if (!$('ai-message').value.trim() || $('ai-message').value === suggestedMessage) {
      $('ai-message').value = value.message; suggestedMessage = value.message;
    }
    syncCollection(); inputDirty = true;
  }
  function renderSelectedMaterials() {
    $('ai-selected-materials').replaceChildren(...selectedValues('ai-material-options').map(id => {
      const item = options.find(r => r.id === id), chip = node('span', null, 'ai-source-chip');
      const link = node('a', item?.title || id); link.href = '/materials/' + encodeURIComponent(id);
      link.target = '_blank'; link.rel = 'noopener';
      const remove = node('button', '×'); remove.type = 'button';
      remove.setAttribute('aria-label', L('取消选择：', 'Deselect: ') + (item?.title || id));
      remove.disabled = ['running', 'submitting'].includes(session?.status) || session?.can_refine === false;
      remove.addEventListener('click', () => {
        for (const box of $('ai-material-options').querySelectorAll('input')) if (box.value === id) box.checked = false;
        inputDirty = true; renderSelectedMaterials();
      });
      chip.append(link, remove); return chip;
    }));
  }
  function syncCollection() {
    if (!$('ai-target-types').querySelector('[value="material"]').checked) {
      for (const box of $('ai-attachments').querySelectorAll('[data-collect]')) {
        box.checked = false; box.closest('.ai-source-card').querySelector('.field').hidden = true;
      }
    }
  }
  const selectedValues = id => [...$(id).querySelectorAll('input:checked')].map(i => i.value);
  function taskInput() {
    return { target_types: selectedValues('ai-target-types'), record_ids: selectedValues('ai-record-options'),
      material_ids: selectedValues('ai-material-options'), knowledge_root: $('ai-root-choice').value || null,
      attachment_ids: [...$('ai-attachments').querySelectorAll('[data-use]:checked')].map(i => i.value),
      collect_attachment_ids: [...$('ai-attachments').querySelectorAll('[data-collect]:checked')].map(i => i.value),
      attachment_relationships: Object.fromEntries([...$('ai-attachments').querySelectorAll('[data-collect]:checked')].map(i => [i.value, i.closest('.ai-source-card').querySelector('select').value]).filter(([,v]) => v)),
      reading: $('ai-reading').value };
  }
  function fillChoices(id, records, selected) {
    $(id).replaceChildren(...records.map(r => {
      const label = node('label', null, 'ai-check'), input = node('input');
      input.type = 'checkbox'; input.id = id + '-' + r.id; input.value = r.id; input.checked = selected.includes(r.id);
      label.dataset.search = `${r.title} ${r.id}`.toLocaleLowerCase();
      label.append(input, node('span', `${r.title} · ${vocabulary.entities[r.entity_type] || r.entity_type}${r.status === 'active' ? '' : ' · ' + r.status}`));
      return label;
    }));
  }
  function renderInputs(spec) {
    if (!spec) {
      const record = options.find(r => r.id === root.dataset.recordId);
      spec = { target_types: record ? [record.entity_type.startsWith('preference') ? 'preference' : record.entity_type] : root.dataset.materialId ? ['knowledge_node', 'material'] : ['knowledge_node'],
        record_ids: record ? [record.id] : [], material_ids: root.dataset.materialId ? [root.dataset.materialId] : [], reading: 'targeted' };
    }
    for (const box of $('ai-target-types').querySelectorAll('input')) box.checked = spec.target_types.includes(box.value);
    fillChoices('ai-material-options', options.filter(r => r.entity_type === 'material' && r.status === 'active'), spec.material_ids || []);
    fillChoices('ai-record-options', options, spec.record_ids || []);
    $('ai-root-choice').replaceChildren(node('option', L('不限定分支', 'All branches')));
    $('ai-root-choice').firstChild.value = '';
    for (const r of options.filter(r => r.entity_type === 'knowledge_node' && r.status === 'active')) {
      const option = node('option', r.title); option.value = r.id; $('ai-root-choice').append(option);
    }
    $('ai-root-choice').value = spec.knowledge_root || ''; $('ai-reading').value = spec.reading;
    renderAttachments(spec); renderSelectedMaterials(); inputDirty = false;
  }
  function renderAttachments(spec) {
    $('ai-attachments').replaceChildren(...(session?.attachments || []).map(a => {
      const card = node('div', null, 'ai-source-card'), label = node('label', null, 'ai-check'), use = node('input');
      use.type = 'checkbox'; use.id = 'use-' + a.id; use.value = a.id; use.dataset.use = ''; use.checked = (spec.attachment_ids || []).includes(a.id);
      label.append(use, node('strong', a.title)); card.append(label);
      const meta = a.material_metadata;
      if (meta) card.append(node('p', [meta.bibliography?.authors?.join(', '), meta.bibliography?.published_at, a.arxiv_request ? 'arXiv: ' + a.arxiv_request : ''].filter(Boolean).join(' · '), 'ai-source-meta'));
      const links = node('div', null, 'ai-source-links');
      for (const [suffix, title] of [['', L('查看原文件 ↗', 'Original file ↗')], ['?view=text', L('查看提取文字 ↗', 'Extracted text ↗')]]) {
        if (suffix && a.parse_status === 'needs_text') continue;
        const link = node('a', title);
        link.href = endpoint('sources/' + encodeURIComponent(a.id)) + suffix;
        link.target = '_blank'; link.rel = 'noopener'; links.append(link);
      }
      card.append(links);
      for (const warning of a.warnings || []) card.append(node('p', warning, 'ai-source-meta'));
      if (a.parse_status === 'needs_text') card.append(node('p', L('未能提取正文。请取消勾选这份依据，补充可读取的 PDF、文字或截图后再开始。', 'No readable text. Deselect this source and add a readable PDF, text or screenshot.'), 'ai-error'));
      const collectLabel = node('label', null, 'ai-check'), collect = node('input');
      collect.type = 'checkbox'; collect.id = 'collect-' + a.id; collect.value = a.id; collect.dataset.collect = ''; collect.checked = (spec.collect_attachment_ids || []).includes(a.id);
      collectLabel.append(collect, node('span', L('同时生成材料收录候选', 'Also propose adding to Materials'))); card.append(collectLabel);
      const relationLabel = node('label', null, 'field'), relationship = node('select');
      relationLabel.append(node('span', L('我与这份材料的关系', 'My relationship to this material')));
      for (const [v,text] of [['',L('请选择实际情况', 'Choose the actual state')],['skimmed',L('略读过', 'Skimmed')],['read',L('读过', 'Read')],['studied',L('学习过', 'Studied')],['authored',L('我写的', 'Authored by me')]]) { const o=node('option',text); o.value=v; relationship.append(o); }
      relationship.id = 'relationship-' + a.id; relationship.value = spec.attachment_relationships?.[a.id] || '';
      relationLabel.append(relationship); relationLabel.hidden = !collect.checked; card.append(relationLabel);
      collect.addEventListener('change', () => { relationLabel.hidden = !collect.checked; if (collect.checked) { use.checked = true; $('ai-target-types').querySelector('[value="material"]').checked = true; } });
      use.addEventListener('change', () => { if (!use.checked) { collect.checked = false; relationLabel.hidden = true; } card.classList.toggle('ai-source-inactive', !use.checked); });
      card.classList.toggle('ai-source-inactive', !use.checked);
      return card;
    }));
  }
  async function ensureSession() {
    if (session) return;
    const spec = taskInput();
    if (!spec.target_types.length) throw new Error(L('请至少选择一种维护对象。', 'Choose at least one target type.'));
    session = await api('/api/ai/sessions', { maintenance: spec });
    window.history.replaceState(null, '', '/ai?session=' + session.id);
  }
  async function addAttachment(text, title) {
    await ensureSession();
    await saveEdits();
    const spec = taskInput();
    session = await api(endpoint('attachment'), { version: session.version, text, title });
    spec.attachment_ids.push(session.attachments.at(-1).id);
    renderAttachments(spec); inputDirty = true; render(); await historyList();root.dispatchEvent(new Event('input',{bubbles:true}));
  }
  async function addSource(kind, payload) {
    await ensureSession(); await saveEdits();
    const spec = taskInput();
    const result = await api(endpoint(kind), { version: session.version, ...payload });
    session = result.session;
    if (result.existing_material_id) {
      options = (await api('/api/ai/options')).records;
      spec.material_ids = [...new Set([...spec.material_ids, result.existing_material_id])];
    }
    if (result.source_id) {
      spec.attachment_ids = [...new Set([...spec.attachment_ids, result.source_id])];
      if (spec.target_types.includes('material')) {
        spec.collect_attachment_ids = [...new Set([...spec.collect_attachment_ids, result.source_id])];
      }
    }
    renderInputs(spec); inputDirty = true; render(); await historyList();
    sourceNotice(result.message || L('资料已加入依据。请核对提取文字，并填写本次需求。', 'Source added. Check the extracted text and describe your request.'), false, result.import_review_url);
    return result;
  }
  function validArxivLink(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error(L('目前只支持 arXiv 链接', 'Only arXiv links are currently supported')); }
    if (!['http:', 'https:'].includes(url.protocol) || !['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
      throw new Error(L('目前只支持 arXiv 链接', 'Only arXiv links are currently supported'));
    }
    if (!/^\/(abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v[1-9]\d*)?(\.pdf)?\/?$/i.test(url.pathname)) {
      throw new Error(L('请输入有效的 arXiv 论文链接（abs 或 pdf）。', 'Enter a valid arXiv paper link (abs or pdf).'));
    }
    return value;
  }
  function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error(L('文件读取失败，请重新选择。', 'Could not read the file. Choose it again.')));
      reader.readAsDataURL(file);
    });
  }
  function showPendingFiles() {
    $('ai-file-selection').textContent = pendingFiles.length ? pendingFiles.map(f => f.name).join('、') : L('尚未选择文件', 'No files selected');
  }
  async function intake(fn) {
    return action(async () => {
      try { await fn(); } catch (error) { sourceNotice(error.message, true); throw error; }
    });
  }
  const status = { idle: L('未开始', 'Not started'), running: L('正在分析', 'Analyzing'), ready: L('等待补充／无变更', 'Needs input / no changes'), failed: L('分析失败', 'Failed'), cancelled: L('已取消', 'Cancelled'), submitting: L('正在送审', 'Submitting'), submitted: L('已送入审核区', 'Sent to review'), submission_failed: L('送审未完成', 'Submission incomplete') };
  const operations = { create: L('新增', 'Create'), update: L('修改', 'Update'), relate: L('建立关联', 'Relate'), archive: L('归档', 'Archive'), restore: L('恢复', 'Restore'), unrelate: L('移除关联', 'Remove relation') };
  const labels = { instruction: L('偏好要求', 'Instruction'), condition: L('适用条件', 'Condition'), rationale: L('理由', 'Rationale'), name: L('名称', 'Name'), title: L('标题', 'Title'), summary: L('摘要', 'Summary'), description: L('描述', 'Description'), body: L('备注', 'Notes'), activation: L('触发条件', 'Activation'), aliases: L('别名', 'Aliases'), behavior: L('要求强度', 'Behavior'), scope: L('适用范围', 'Scope'), context_refs: L('关联场景', 'Context refs'), context_client_refs: L('依赖的新场景', 'New context dependencies'), knowledge_level: L('掌握程度', 'Knowledge level'), interest_level: L('兴趣', 'Interest'), statement: L('关系说明', 'Relationship statement') };
  Object.assign(labels, vocabulary.fields);
  const show = (text, error = false) => notice('ai-notice', text, error);
  const endpoint = action => `/api/ai/sessions/${session.id}${action ? '/' + action : ''}`;
  async function action(fn) {
    if (busy) return;
    busy = true; root.setAttribute('aria-busy', 'true');
    for (const field of $('ai-inputs').querySelectorAll('fieldset')) field.disabled = true;
    for (const button of root.querySelectorAll('[data-scenario]')) button.disabled = true;
    for (const id of ['ai-add-text', 'ai-add-arxiv', 'ai-upload-files', 'ai-send']) $(id).disabled = true;
    try { await fn(); } catch (error) { show(error.message, true); }
    finally {
      busy = false; root.setAttribute('aria-busy', 'false');
      for (const field of $('ai-inputs').querySelectorAll('fieldset')) field.disabled = ['running', 'submitting'].includes(session?.status) || session?.can_refine === false;
      for (const button of root.querySelectorAll('[data-scenario]')) button.disabled = ['running', 'submitting'].includes(session?.status) || session?.can_refine === false;
      for (const id of ['ai-add-text', 'ai-add-arxiv', 'ai-upload-files', 'ai-send']) $(id).disabled = ['running', 'submitting'].includes(session?.status) || session?.can_refine === false;
    }
  }
  async function historyList() {
    const result = await api('/api/ai/sessions');
    $('ai-history').replaceChildren(...result.sessions.map(s => {
      const a = node('a', s.title + ' · ' + (status[s.status] || s.status));
      a.href = '/ai?session=' + s.id;
      if (session?.id === s.id) a.setAttribute('aria-current', 'page');
      return a;
    }));
  }
  function renderDraft() {
    const draft = session?.draft;
    $('ai-draft-panel').hidden = !draft; editors = []; dirty = false;
    $('ai-result-summary').textContent = draft ? L(' · ' + draft.changes.length + ' 项候选', ' · ' + draft.changes.length + ' candidates') : '';
    if (!draft) return;
    const locked = ['running', 'submitting'].includes(session.status) || session.can_refine === false;
    $('ai-draft-status').textContent = status[session.status] || session.status;
    const refTitle = ref => {
      const candidate = draft.changes.find(c => c.client_ref === ref);
      return candidate?.values.title || candidate?.values.name || options.find(r => r.id === ref)?.title || session.attachments?.find(a => a.id === ref)?.title || ref;
    };
    $('ai-changes').replaceChildren();
    $('ai-questions').hidden = !draft.questions.length;
    $('ai-questions').textContent = draft.questions.join('\n');
    for (const change of draft.changes) {
      const card = node('article', null, 'ai-draft-card');
      const head = node('label', null, 'ai-check'), selected = node('input');
      selected.type = 'checkbox'; selected.checked = true; selected.disabled = locked;
      head.append(selected, node('strong', `${operations[change.operation]} · ${change.values.title || change.values.name || change.values.instruction?.slice(0, 60) || change.target_id || vocabulary.entities[change.entity_type] || change.entity_type}`));
      card.append(head, node('p', change.reason, 'ai-muted'));
      const inputs = [];
      for (const [key, value] of Object.entries(change.values)) {
        const label = node('label', null, 'field');
        const choices = vocabulary.choices[key];
        const lineList = Array.isArray(value) && value.every(v => typeof v === 'string');
        const structured = typeof value === 'object' && !lineList;
        if (['source_ref', 'target_ref', 'source_id', 'target_id', 'context_refs', 'context_client_refs'].includes(key)) {
          const input = node('input'); input.type = 'hidden';
          input.value = lineList ? value.join('\n') : String(value);
          const title = key.startsWith('source') ? L('来源', 'Source') : key.startsWith('target') ? L('目标', 'Target') : L('关联场景', 'Contexts');
          card.append(node('p', title + '：' + (lineList ? value.map(refTitle).join('、') : refTitle(value)), 'ai-source-meta'));
          inputs.push({ key, input, type: typeof value, structured, lineList });
          continue;
        }
        label.append(node('span', (labels[key] || key) + (structured ? ' · JSON' : lineList ? L(' · 每行一项', ' · One per line') : '')));
        if (Object.hasOwn(change.before || {}, key)) label.append(node('p', L('当前：', 'Current: ') + JSON.stringify(change.before[key]), 'ai-before'));
        const input = node(choices ? 'select' : 'textarea');
        if (choices) {
          for (const [choice, label] of Object.entries(choices)) { const o = node('option', label); o.value = choice; input.append(o); }
          if (!Object.hasOwn(choices, value)) { const o = node('option', String(value)); o.value = String(value); input.append(o); }
        } else input.rows = structured ? 4 : (String(value).length > 90 ? 3 : 2);
        input.value = structured ? JSON.stringify(value, null, 2) : lineList ? value.join('\n') : String(value);
        input.disabled = locked; input.setAttribute('aria-label', labels[key] || key);
        label.append(input);
        if (structured) { const details = node('details'); details.append(node('summary', (labels[key] || key) + L(' · 展开编辑结构', ' · Edit structure')), label); card.append(details); }
        else card.append(label);
        inputs.push({ key, input, type: typeof value, structured, lineList });
      }
      for (const evidence of change.evidence || []) {
        const sourceTitle = session.checkpoint?.context?.sources?.find(s => s.source_id === evidence.source_id)?.origin?.title || evidence.file;
        const evidenceKind = evidence.evidence_kind === 'explicit_user_statement' ? L('你的明确陈述', 'Your explicit statement') : L('参考原文', 'Reference source');
        const ev = node('div', `${sourceTitle} · L${evidence.line_start}–L${evidence.line_end} · ${evidenceKind}`, 'ai-evidence');
        if (session.material_id) {
          const link = node('a', L(' 查看证据', ' View evidence'));
          link.href = `/materials/${session.material_id}/source-text#L${evidence.line_start}`;
          link.target = '_blank'; link.rel = 'noopener'; ev.append(link);
        }
        if (evidence.source_id) {
          const basis = Object.values(session.checkpoint?.ledger?.basis || {}).find(b => b.source_id === evidence.source_id && b.file === evidence.file && b.line_start === evidence.line_start && b.line_end === evidence.line_end);
          if (basis) { const details = node('details'); details.append(node('summary', L('查看原文依据', 'View source excerpt')), node('pre', basis.text)); ev.append(details); }
        }
        card.append(ev);
      }
      if (change.conflicts?.length) card.append(node('div', change.conflicts.join('\n'), 'ai-notice ai-error'));
      card.addEventListener('input', () => { dirty = true; $('ai-draft-status').textContent = L('有未保存的编辑', 'Unsaved edits'); });
      editors.push({ change, selected, inputs }); $('ai-changes').append(card);
    }
    if (!draft.changes.length) $('ai-changes').append(node('p', L('当前没有变更候选。可以继续对话补充要求。', 'No changes proposed. Continue the conversation to refine the request.'), 'ai-muted'));
    $('ai-save').disabled = locked;
    $('ai-submit').hidden = !['ready', 'submission_failed'].includes(session.status) || !draft.changes.length || !!draft.questions.length;
    $('ai-submit').disabled = locked;
  }
  function renderProgress() {
    const coverage = session?.coverage;
    $('ai-coverage').hidden = !coverage;
    if (coverage) {
      const range = coverage.line_end ? `L1–L${coverage.line_end}` : L('尚未完成阅读', 'Reading not completed');
      $('ai-coverage').replaceChildren(node('div', `${coverage.file} · ${range} / ${coverage.total_lines} ${L('行', 'lines')} · ${coverage.complete ? L('提取文本已读完', 'Extracted text read') : L('尚未覆盖全文', 'Incomplete coverage')}`));
      if (coverage.chunks_total) $('ai-coverage').append(node('div', L('已完成文本段：', 'Segments completed: ') + `${coverage.chunks_done}/${coverage.chunks_total}`));
      const link = node('a', L('查看材料原文 ↗', 'View source ↗'));
      link.href = `/materials/${session.material_id}/source-text`; link.target = '_blank'; link.rel = 'noopener';
      $('ai-coverage').append(link);
    }
    if (session?.maintenance && session.checkpoint?.context?.sources) {
      const sources = session.checkpoint.context.sources, ranges = session.checkpoint.ledger?.coverage || {};
      $('ai-coverage').hidden = !sources.length;
      $('ai-coverage').replaceChildren(...sources.map(source => {
        let count = 0, end = 0;
        for (const [start, stop] of [...(ranges[source.source_id] || [])].sort((a,b) => a[0]-b[0])) {
          count += Math.max(0, stop - Math.max(end, start-1)); end = Math.max(end, stop);
        }
        return node('p', `${source.origin.title} · ${L('实际读取', 'Read')} ${count}/${source.line_count} ${L('行', 'lines')} · ${count >= source.line_count ? L('全文已读', 'Full text read') : L('部分内容', 'Partial coverage')}`);
      }));
    }
    const runs = session?.model_runs || [];
    const runStatus = { succeeded: L('成功', 'Succeeded'), timeout: L('超时', 'Timeout'), cancelled: L('已取消', 'Cancelled'), invalid_model_output: L('输出格式无效', 'Invalid output'), invalid_evidence: L('证据范围无效', 'Invalid evidence') };
    $('ai-runs').hidden = !runs.length;
    $('ai-run-list').replaceChildren(...runs.slice(-20).map(r => {
      const first = r.firstContentMs == null ? L('首内容事件未观测到', 'First content event unavailable') : L('首内容 ', 'First content ') + (r.firstContentMs / 1000).toFixed(1) + 's';
      const usage = r.usage ? ` · tokens ${r.usage.input ?? '?'} → ${r.usage.output ?? '?'}` : '';
      return node('p', `${r.stage || ''} · ${runStatus[r.status || 'succeeded'] || r.status} · ${((r.durationMs || 0) / 1000).toFixed(1)}s · ${first}${usage}`, 'ai-muted');
    }));
    $('ai-resume').hidden = !['failed', 'cancelled'].includes(session?.status);
    $('ai-resume-hint').hidden = $('ai-resume').hidden;
    $('ai-resume-hint').textContent = session?.checkpoint?.parts?.length || Object.values(session?.checkpoint?.analyses || {}).some(parts => parts.length)
      ? L('已保存完成的材料分析；继续时会核对来源、模型和 Persona 版本。', 'Completed analysis is saved; continuing checks source, model and Persona versions.')
      : L('资料和需求已保留；当前阶段尚未完成，继续时会重试该阶段，并尽量复用已有补读。', 'Sources and your request are retained. Continuing retries the unfinished stage and reuses saved reads where possible.');
  }
  function render() {
    $('ai-scope').textContent = session ? `${session.title} · ${status[session.status] || session.status}${session.record_id ? ' · ' + session.record_id : ''}${session.material_id ? ' · ' + session.material_id : ''}` :
      (root.dataset.materialId ? L('材料整理：', 'Material: ') + root.dataset.materialId : root.dataset.recordId ? L('围绕此记录维护：', 'Record: ') + root.dataset.recordId : L('统一维护入口 · 支持多轮对话', 'Unified maintenance · multi-turn conversation'));
    $('ai-inputs').hidden = !!session && !session.maintenance;
    $('ai-messages').replaceChildren(...(session?.messages || []).map(m => node('div', m.content, 'ai-message ' + m.role)));
    const working = ['running', 'submitting'].includes(session?.status);
    for (const id of ['ai-add-text', 'ai-add-arxiv', 'ai-upload-files']) $(id).disabled = busy || working || session?.can_refine === false;
    for (const button of root.querySelectorAll('[data-scenario]')) button.disabled = busy || working || session?.can_refine === false;
    $('ai-message').disabled = working || session?.can_refine === false;
    for (const field of $('ai-inputs').querySelectorAll('fieldset')) field.disabled = busy || working || session?.can_refine === false;
    $('ai-progress').hidden = !working;
    const progress = session?.model_progress;
    const elapsed = session?.stage_started_at ? Math.max(0, (Date.now() - Date.parse(session.stage_started_at)) / 1000).toFixed(0) : '0';
    const limit = progress?.attemptTimeoutMs ? L(` · 本次调用最多等待 ${Math.round(progress.attemptTimeoutMs / 1000)} 秒`, ` · Up to ${Math.round(progress.attemptTimeoutMs / 1000)}s for this call`) : '';
    const phase = progress?.phase === 'receiving' ? L('已收到模型内容', 'Receiving model content') : progress?.phase === 'retrying' ? L('短暂连接错误，正在重试', 'Retrying a transient connection error') : L('等待本阶段结果', 'Waiting for this stage');
    $('ai-progress').textContent = `${session?.stage || status[session?.status] || ''} · ${elapsed}s · ${phase}${limit} · ${L('可离开后回来查看', 'You can return later')}`;
    renderProgress();
    $('ai-cancel').hidden = session?.status !== 'running';
    $('ai-send').disabled = busy || working || session?.can_refine === false;
    $('ai-review').hidden = !session?.submission;
    $('ai-review-state').hidden = !session?.submission;
    if (session?.submission) {
      // Keep navigation on this Studio origin even when it runs on a non-default port.
      $('ai-review').href = '/inbox?' + new URLSearchParams({item:'assistant:' + session.id, return_to:'/ai?session=' + session.id});
      const count = session.submission.proposals.filter(p => p.status === 'pending_review').length;
      $('ai-review-state').textContent = session.can_refine === false
        ? L('这组候选已有审核决定。可查看审核结果；如需继续维护，请新建任务。', 'This group has review decisions. View the results or start a new task.')
        : working
          ? L(`原有 ${count} 条候选仍在待审核区；新结果校验成功后更新同一组。`, `${count} existing candidates remain in review until the new result is validated.`)
          : session.status === 'submitted'
            ? L(`${count} 条候选已进入待审核区。批准后才会生效；也可以继续对话修改。`, `${count} candidates are in review. Only approval makes them effective. You can also keep refining them here.`)
            : L(`原有 ${count} 条候选仍在待审核区，本轮尚未替换它们。`, `${count} existing candidates remain in review; this turn has not replaced them.`);
    }
    if (session?.error) show(session.error.message === '模型响应超时，已完成的分析已保留，可继续分析'
      ? L('本阶段未能在等待上限内完成。请查看下方阶段记录，并点击“继续分析”重试。', 'This stage exceeded its time limit. Check the stage history below and continue to retry.') : session.error.message, true);
    renderSelectedMaterials();
    if (!dirty) renderDraft();
  }
  async function poll() {
    clearTimeout(timer);
    if (!session || !['running', 'submitting'].includes(session.status)) return;
    timer = setTimeout(async () => {
      try {
        session = await api(endpoint()); render();
        if (session.status === 'running' || session.status === 'submitting') poll(); else await historyList();
      } catch (error) { show(error.message, true); }
    }, 1400);
  }
  async function saveEdits() {
    if (!dirty) return;
    const changes = editors.filter(e => e.selected.checked).map(e => ({ ...e.change,
      values: Object.fromEntries(e.inputs.map(({ key, input, type, structured, lineList }) => [key,
        lineList ? input.value.split('\n').map(v => v.trim()).filter(Boolean) :
          structured || type === 'boolean' || type === 'number' ? JSON.parse(input.value) : input.value])),
    }));
    session = await api(endpoint('edit'), { version: session.version, draft: { ...session.draft, changes } });
    dirty = false;
    render();
  }
  $('ai-message-form').addEventListener('persona:send', e => { e.preventDefault(); action(async () => {
    if ($('ai-paste').value.trim()) throw new Error(L('请先点击“添加文本依据”，再发送需求。', 'Add the pasted text source before sending.'));
    if ($('ai-arxiv-url').value.trim()) throw new Error(L('请先点击“添加论文”，再开始整理。', 'Add the paper before starting.'));
    if (pendingFiles.length) throw new Error(L('请先点击“上传并读取”，再开始整理。', 'Upload and read the selected files before starting.'));
    if (!$('ai-message').value.trim()) throw new Error(L('请描述你希望如何整理这些资料。', 'Describe how you want to organize the sources.'));
    const input = taskInput();
    if (input.collect_attachment_ids.some(id => !input.attachment_relationships[id])) {
      throw new Error(L('请为需要收录的材料选择“我与这份材料的关系”，或取消材料收录。', 'Choose your actual relationship to each Material, or deselect collection.'));
    }
    await ensureSession();
    await saveEdits(); show('');
    if (session.maintenance) {
      session = await api(endpoint('input'), { version: session.version, input: taskInput() });
      inputDirty = false;
    }
    session = await api(endpoint('message'), { version: session.version, message: $('ai-message').value });
    $('ai-message').value = ''; render(); poll(); await historyList();
    root.dispatchEvent(new Event('input', {bubbles:true}));
  }); });
  $('ai-save').addEventListener('click', () => action(async () => {
    await saveEdits(); await historyList();
    if (session.error) show(session.error.message, true);
    else show(session.status === 'submitted' ? L('已更新待审核候选，批准后才会生效。', 'Review candidates updated; approval is still required.') : L('编辑已保存，请继续补充信息。', 'Edits saved. Continue with the missing information.'));
  }));
  $('ai-submit').addEventListener('click', () => action(async () => {
    await saveEdits();
    session = await api(endpoint('submit'), { version: session.version }); render(); await historyList();
    show(L('已生成待审核提案，正式 Persona 尚未改变。', 'Pending proposals created. Effective Persona is unchanged.'));
  }));
  $('ai-cancel').addEventListener('click', () => action(async () => {
    session = await api(endpoint('cancel'), { version: session.version }); clearTimeout(timer); render(); await historyList();root.dispatchEvent(new Event('input',{bubbles:true}));
  }));
  $('ai-resume').addEventListener('click', () => action(async () => {
    if (dirty) throw new Error(L('请先保存草稿编辑；保存后可通过新消息继续。', 'Save draft edits first, then continue with a new message.'));
    if (inputDirty) throw new Error(L('依据或范围已更改，请填写需求并发送新一轮。', 'Sources or scope changed. Send a new request.'));
    show(''); session = await api(endpoint('resume'), { version: session.version });
    render(); poll(); await historyList();
  }));
  $('ai-inputs').addEventListener('change', () => { inputDirty = true; renderSelectedMaterials(); });
  $('ai-target-types').addEventListener('change', syncCollection);
  for (const button of root.querySelectorAll('[data-source-mode]')) button.addEventListener('click', () => sourceMode(button.dataset.sourceMode));
  for (const button of root.querySelectorAll('[data-scenario]')) button.addEventListener('click', () => chooseScenario(button.dataset.scenario));
  $('ai-refresh-materials').addEventListener('click', () => action(async () => {
    const spec = taskInput(); options = (await api('/api/ai/options')).records; renderInputs(spec);
    inputDirty = true; show(L('材料列表已刷新。', 'Materials refreshed.'));
  }));
  for (const [searchId, listId] of [['ai-material-search', 'ai-material-options'], ['ai-record-search', 'ai-record-options']]) {
    $(searchId).addEventListener('input', () => { const q = $(searchId).value.toLocaleLowerCase(); for (const row of $(listId).children) row.hidden = !row.dataset.search.includes(q); });
  }
  $('ai-add-text').addEventListener('click', () => action(async () => {
    if (!$('ai-paste').value.trim()) throw new Error(L('请粘贴参考文本。', 'Paste reference text first.'));
    await addAttachment($('ai-paste').value, ($('ai-paste-title').value || L('参考文本', 'Reference text')) + '.txt');
    $('ai-paste').value = ''; $('ai-paste-title').value = ''; show(L('文本已加入依据。', 'Reference text added.'));
  }));
  $('ai-add-arxiv').addEventListener('click', () => intake(async () => {
    const url = validArxivLink($('ai-arxiv-url').value.trim());
    sourceNotice(L('正在通过材料导入流程获取论文与正文…', 'Importing the paper and its text…')); show('');
    const result = await addSource('arxiv', { url });
    if (result.source_id || result.existing_material_id || result.import_review_url) $('ai-arxiv-url').value = '';
  }));
  $('ai-files').addEventListener('change', () => { pendingFiles = [...$('ai-files').files]; showPendingFiles(); });
  for (const event of ['dragover', 'drop']) $('ai-drop-zone').addEventListener(event, e => e.preventDefault());
  $('ai-drop-zone').addEventListener('drop', e => {
    if (busy || ['running', 'submitting'].includes(session?.status) || session?.can_refine === false) return;
    pendingFiles = [...e.dataTransfer.files]; showPendingFiles();
  });
  $('ai-upload-files').addEventListener('click', () => intake(async () => {
    if (!pendingFiles.length) throw new Error(L('请先选择文件。', 'Choose a file first.'));
    show('');
    while (pendingFiles.length) {
      const file = pendingFiles[0];
      if (!file.size || file.size > 20 * 1024 * 1024 || !/\.(txt|md|markdown|pdf|png|jpe?g|webp)$/i.test(file.name)) {
        throw new Error(L('请选择非空且不超过 20 MB 的 PDF、TXT、Markdown 或图片。', 'Choose a nonempty PDF, text, Markdown or image file up to 20 MB.'));
      }
      sourceNotice(L('正在上传并读取：', 'Uploading and reading: ') + file.name);
      await addSource('file', { filename: file.name, content_base64: await fileBase64(file) });
      pendingFiles.shift(); showPendingFiles();
    }
    $('ai-files').value = '';
  }));
  window.addEventListener('beforeunload', event => { if (!window.PersonaDrafts?.isLeaving() && (dirty || (window.PersonaDrafts?.hasUnpersisted(root) ?? inputDirty))) { event.preventDefault(); event.returnValue = ''; } });
  action(async () => {
    options = (await api('/api/ai/options')).records;
    const id = new URLSearchParams(location.search).get('session');
    if (id) session = await api('/api/ai/sessions/' + encodeURIComponent(id));
    renderInputs(session?.maintenance);
    if (!session && !root.dataset.materialId && !root.dataset.recordId) { chooseScenario('paper'); inputDirty = false; }
    if (root.dataset.materialId || session?.maintenance?.material_ids?.length) sourceMode('existing');
    showPendingFiles();
    render(); await historyList(); poll();
    window.PersonaDrafts?.mount(root, {query:['session','material_id','record_id'],exclude:'#ai-draft-panel',extraPending:()=>pendingFiles.length>0||dirty,beforeSave:async()=>{if(dirty)await saveEdits();}});
    if (!session && root.dataset.materialId) $('ai-message').value = L('请根据这份材料整理摘要、相关知识与关系候选。优先复用已有概念，并给出原文证据。', 'Analyze this material: propose a summary, knowledge and relationships. Reuse existing concepts and cite source evidence.');
  });
})();
