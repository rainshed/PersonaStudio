(() => {
  const { L, node, api, button, notice, modelLabel } = window.PersonaAI;
  const $ = id => document.getElementById(id);
  const form = $('model-form'), routing = $('routing-form');
  let config, editing = null, auth = null, authTimer, savedRouting = null, savingRouting = false, connectionDirty = false;
  const ui = window.StudioI18n?.ui || (text => text);
  let authEpoch = 0, authStarting = false, renderedPromptId = null, submittingPromptId = null;
  let renderedAuthView = null;
  const routePickers = new Map();
  const connectionTests = new Map();
  const effortNames = {minimal: L('最低', 'Minimal'), low: L('低', 'Low'), medium: L('中', 'Medium'), high: L('高', 'High'), xhigh: L('很高', 'Very high'), max: L('最高', 'Maximum')};
  const effortLabel = value => value ? (effortNames[value] || value) + ' (' + value + ')' : L('模型默认（未指定）', 'Model default (unspecified)');
  const quickTasks = new Set(['conversation_signal', 'activation']);
  const field = name => form.elements.namedItem(name);
  const show = (text, error = false) => notice('model-notice', text, error);
  async function action(fn) {
    try { await fn(); } catch (error) { show(error.message, true); }
  }
  function options(select, items, value = '') {
    select.replaceChildren(...items.map(([id, text]) => {
      const o = node('option', text); o.value = id; return o;
    }));
    select.value = value;
    if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
  }
  const authLabels = { api_key: 'API Key', oauth: L('账号授权', 'Account login'), none: L('无需认证', 'No authentication') };
  const statusLabels = { ready: L('测试通过', 'Test passed'), untested: L('待测试', 'Untested'), auth_required: L('需要认证', 'Authentication required'), rate_limited: L('暂时限流', 'Rate limited'), quota_exceeded: L('额度不足', 'Quota exceeded'), error: L('连接异常', 'Connection error') };
  function providerFields(c) {
    const provider = config.providers.find(p => p.id === field('providerId').value);
    options(field('authType'), provider.auth.map(a => [a, authLabels[a]]), c?.authType);
    $('custom-fields').hidden = provider.id !== 'custom';
    field('customModel').required = provider.id === 'custom';
    $('provider-note').textContent = provider.description + ' ' + provider.billing;
    $('key-field').hidden = field('authType').value !== 'api_key';
  }
  function edit(c = null) {
    editing = c?.id || null; form.reset(); connectionDirty = false;
    $('model-form-title').textContent = c ? L('编辑连接', 'Edit connection') : L('添加连接', 'Add connection');
    options(field('providerId'), config.providers.map(p => [p.id, p.name]), c?.providerId || 'openai');
    providerFields(c);
    if (c) for (const name of ['name', 'baseUrl', 'api', 'contextWindow', 'maxTokens']) field(name).value = c[name];
    field('customModel').value = c?.modelId || '';
    field('imageModelIds').value = (c?.imageModelIds || []).join('\n');
    $('model-accounts').open = true;
    form.hidden = false; field('name').focus();
  }
  function accountLabel(c) {
    return modelLabel(c.name, config.providers.find(p => p.id === c.providerId)?.name);
  }
  const taskLabels = { maintenance: L('AI 维护助手', 'AI maintenance assistant'), material: L('AI 维护助手', 'AI maintenance assistant'),
    conversation_learning: L('对话学习生成', 'Learning generation'), conversation_signal: L('对话学习判定', 'Learning detection'),
    conversation_candidate: L('对话学习生成', 'Learning generation'), activation: L('偏好场景判定', 'Preference matching'), test: L('连接测试', 'Connection test') };
  const stageLabels = { maintenance: L('自然语言维护', 'Natural-language maintenance'), material: L('材料理解与整理', 'Material analysis'), conversation_signal: L('信号识别', 'Signal detection'), conversation_candidate: L('候选整理', 'Candidate generation') };
  function createRoute(task, selected) {
    const inherited = !['default', 'fallback'].includes(task.id);
    const box = node('section', null, task.id === 'default' ? 'settings-model-default' : 'settings-model-route');
    box.dataset.modelTask = task.id;
    const intro = node('div'); intro.append(node(task.id === 'default' ? 'h2' : 'h3', taskLabels[task.id] || task.name));
    if (inherited) intro.append(node('span', quickTasks.has(task.id) ? L('建议优先速度与成本', 'Prioritize speed and cost') : L('建议优先质量', 'Prioritize quality'), 'settings-priority' + (quickTasks.has(task.id) ? ' speed' : '')));
    if (task.description) intro.append(node('p', ui(task.description), 'settings-note'));
    if (task.id === 'default') intro.append(node('p', L('建议选择理解与推理能力较强的模型。未单独设置的功能会跟随这里。', 'Choose a capable reasoning model. Features without an override follow this choice.'), 'settings-note'));
    if (task.id === 'default') intro.append(node('p', L('思考强度在下方各功能中单独设置。', 'Set reasoning effort separately for each feature below.'), 'settings-note'));
    box.append(intro);
    const controls = node('div', null, 'settings-model-controls'); box.append(controls);
    const mode = node('select'); mode.setAttribute('aria-label', (taskLabels[task.id] || task.name) + L('的配置方式', ' configuration'));
    options(mode, [['inherit', L('跟随默认模型', 'Use default model')], ['custom', L('单独设置模型', 'Choose a separate model')]], selected.connectionId ? 'custom' : 'inherit');
    if (inherited) controls.append(mode);
    const fields = node('div', null, 'settings-fields'); controls.append(fields);
    const accountLabelEl = node('label', null, 'field'); accountLabelEl.append(node('span', L('账号连接', 'Account connection')));
    const account = node('select'); account.name = task.id;
    options(account, [['', L('请选择账号连接', 'Choose an account connection')], ...config.settings.connections.map(c => [c.id, accountLabel(c)])], selected.connectionId || '');
    accountLabelEl.append(account); fields.append(accountLabelEl);
    const modelLabelEl = node('label', null, 'field'); modelLabelEl.append(node('span', L('模型', 'Model')));
    const modelSlot = node('span'); modelLabelEl.append(modelSlot); fields.append(modelLabelEl);
    let reasoningValue = selected.reasoning ?? null;
    const reasoning = node('select'); reasoning.name = task.id + 'Reasoning';
    reasoning.setAttribute('aria-label', (taskLabels[task.id] || task.name) + L('的思考强度', ' reasoning effort'));
    const reasoningHint = node('small'); reasoningHint.id = task.id + '-reasoning-hint';
    reasoning.setAttribute('aria-describedby', reasoningHint.id);
    if (inherited) {
      const label = node('label', null, 'field'); label.append(node('span', L('思考强度', 'Reasoning effort')), reasoning, reasoningHint);
      controls.append(label);
    }
    const hint = node('p', '', 'settings-model-hint'); controls.append(hint);
    const warning = node('p', '', 'settings-inline-warning'); warning.hidden = true; controls.append(warning);
    let model;
    const value = () => {
      const choice = inherited && mode.value === 'inherit' ? { connectionId: null, modelId: null }
        : { connectionId: account.value || null, modelId: account.value ? model?.value?.trim() || null : null };
      return inherited ? { ...choice, reasoning: reasoningValue } : choice;
    };
    const effective = () => value().connectionId ? value() : inherited && mode.value === 'inherit' ? routePickers.get('default')?.value() : value();
    const testLine = node('div', null, 'settings-test-line');
    const testStatus = node('span', '', 'settings-test-status');
    testStatus.setAttribute('role', 'status'); testStatus.setAttribute('aria-live', 'polite'); testStatus.setAttribute('aria-atomic', 'true');
    testStatus.hidden = true;
    const reasoningLevels = () => {
      const current = effective(), c = config.settings.connections.find(c => c.id === current?.connectionId);
      return config.capabilities?.persistentReasoning === 1
        ? config.providers.find(p => p.id === c?.providerId)?.models.find(m => m.id === current?.modelId)?.reasoningLevels || [] : [];
    };
    const invalidReasoning = () => inherited && reasoningValue != null && !reasoningLevels().includes(reasoningValue);
    const validate = () => { if (invalidReasoning()) throw new Error(L('当前模型不支持已选思考强度，请重新选择：', 'Choose a supported reasoning effort for: ') + (taskLabels[task.id] || task.name)); };
    const testKey = (current, c) => JSON.stringify([current?.connectionId, current?.modelId, c?.revision, c?.hasCredential, c?.baseUrl, c?.api, inherited ? reasoningValue : null]);
    const test = button(L('测试连接（真实调用）', 'Test connection (real request)'), async () => {
      const current = effective(); if (!current?.connectionId || !current.modelId) return;
      const c = config.settings.connections.find(c => c.id === current.connectionId);
      const run = { key: testKey(current, c), state: 'pending', message: L('正在测试…', 'Testing…') };
      connectionTests.set(task.id, run); updateHint();
      try {
        await api('/api/models/test', { id: current.connectionId, modelId: current.modelId, ...(inherited ? {reasoning: reasoningValue} : {}) });
        run.state = 'success'; run.message = L('连接测试通过', 'Connection test passed');
      } catch (error) {
        run.state = 'error'; run.message = L('连接测试失败：', 'Connection test failed: ') + error.message;
      }
      // Results stay attached to the tested selection, including after a config refresh.
      if (box.isConnected) updateHint();
      try { await refresh(); } catch { /* The test result remains available if history cannot refresh. */ }
    }); test.className = 'button ghost settings-connection-test';
    testLine.append(test, testStatus); controls.append(testLine);
    function updateHint() {
      const current = effective();
      const c = config.settings.connections.find(c => c.id === current?.connectionId);
      if (inherited) {
        const levels = reasoningLevels(), invalid = invalidReasoning();
        options(reasoning, [['', effortLabel(null)], ...levels.map(v => [v, effortLabel(v)]),
          ...(invalid ? [[reasoningValue, effortLabel(reasoningValue) + L('（当前模型不支持）', ' (unsupported by this model)')]] : [])], reasoningValue || '');
        reasoning.disabled = !levels.length && !reasoningValue;
        reasoning.setAttribute('aria-invalid', String(invalid));
        reasoningHint.textContent = invalid ? L('当前模型不支持这个档位，请重新选择后保存。', 'This effort is unsupported. Choose another option before saving.')
          : config.capabilities?.persistentReasoning !== 1 ? L('请更新模型服务后设置思考强度。', 'Update the model service to configure reasoning effort.')
          : !c ? L('先选择模型，再设置思考强度。', 'Choose a model first.')
          : !levels.length ? L('此连接未提供可设置的思考档位，将使用模型默认行为。', 'This connection exposes no reasoning levels; the model controls its default behavior.')
          : L('只显示模型支持的档位。模型跟随默认时，强度仍按本功能单独设置。', 'Only supported levels are shown. Effort is independent even when the feature uses the default model.');
      }
      let result = connectionTests.get(task.id);
      if (result && result.key !== testKey(current, c)) { connectionTests.delete(task.id); result = null; }
      testStatus.hidden = !result;
      testStatus.dataset.state = result?.state || '';
      testStatus.replaceChildren();
      if (result) {
        testStatus.append(node('span', result.message));
        if (result.state === 'success') testStatus.append(node('small', L('未验证图片识别与候选生成能力。', 'Image understanding and candidate quality are not verified.')));
      }
      test.disabled = !c || !current?.modelId || (c.authType !== 'none' && !c.hasCredential) || result?.state === 'pending' || invalidReasoning();
      test.hidden = !c;
      fields.hidden = inherited && mode.value === 'inherit';
      account.disabled = fields.hidden;
      if (model) model.disabled = fields.hidden || !account.value;
      warning.hidden = true;
      if (!c) { hint.textContent = L('尚未配置，请在下方添加账号连接。', 'Not configured. Add an account connection below.'); return; }
      const entry = config.providers.find(p => p.id === c.providerId)?.models.find(m => m.id === current.modelId);
      const images = c.providerId === 'custom' ? c.imageModelIds?.includes(current.modelId) : entry?.input?.includes('image');
      const capability = images ? L('支持图片', 'Image input supported') : c.providerId === 'custom' ? L('图片能力未声明', 'Image support not declared') : L('仅文字', 'Text only');
      hint.textContent = L('当前使用：', 'Using: ') + c.name + ' / ' + (current.modelId || L('请选择模型', 'Choose a model'));
      if (inherited) hint.textContent += '\n' + L('思考强度：', 'Reasoning effort: ') + effortLabel(reasoningValue);
      if (task.id === 'default' || task.id === 'maintenance') hint.textContent += '\n' + capability + (c.providerId === 'custom' && images ? L('（配置声明，未验证）', ' (declared, unverified)') : '');
      if (c.authType !== 'none' && !c.hasCredential) hint.textContent += '\n' + L('请在账号与连接中完成认证。', 'Complete authentication under Accounts & connections.');
      if (task.id === 'maintenance' && !images) {
        warning.hidden = false; warning.textContent = L('使用截图需要支持图片的模型；自定义接口可在连接中声明支持图片的模型 ID。', 'Screenshots require an image-capable model. Declare supported model IDs in a custom connection.');
      }
    }
    function updateModel(modelId) {
      const c = config.settings.connections.find(c => c.id === account.value);
      model = node(c?.providerId === 'custom' ? 'input' : 'select'); model.name = task.id + 'Model';
      model.required = !!c;
      if (c?.providerId === 'custom') { model.value = modelId || c.modelId; model.maxLength = 200; model.placeholder = L('填写模型 ID', 'Model ID'); }
      else {
        const entries = config.providers.find(p => p.id === c?.providerId)?.models || [];
        const id = modelId || c?.modelId || '';
        const choices = entries.map(m => [m.id, modelLabel(m.name, m.id)]);
        if (id && !entries.some(m => m.id === id)) choices.unshift([id, id + L('（不在当前目录中）', ' (not in catalog)')]);
        options(model, c ? choices : [['', L('先选择账号连接', 'Choose a connection first')]], id);
      }
      model.addEventListener('input', () => { updateInherited(); updateDirty(); });
      model.addEventListener('change', () => { updateInherited(); updateDirty(); });
      modelSlot.replaceChildren(model); updateHint();
    }
    mode.addEventListener('change', () => {
      if (mode.value === 'custom' && !account.value) {
        const primary = routePickers.get('default')?.value(); account.value = primary?.connectionId || '';
        updateModel(primary?.modelId);
      }
      updateInherited(); updateDirty();
    });
    account.addEventListener('change', () => { updateModel(); updateInherited(); updateDirty(); });
    reasoning.addEventListener('change', () => { reasoningValue = reasoning.value || null; updateHint(); updateDirty(); });
    updateModel(selected.modelId);
    routePickers.set(task.id, { value, updateHint, validate });
    return box;
  }
  function routingValue() {
    return JSON.stringify({ picks: [...routePickers].map(([id, p]) => [id, p.value()]), fallback: routing.elements.fallbackEnabled.checked });
  }
  function updateDirty() {
    if (!savedRouting) return;
    const dirty = routingValue() !== savedRouting;
    $('model-save-state').textContent = dirty ? L('有未保存的修改', 'Unsaved changes') : L('已保存', 'Saved');
    $('model-revert').disabled = !dirty;
  }
  function updateInherited() {
    for (const picker of routePickers.values()) picker.updateHint();
    updateFallback();
  }
  function render(resetRouting = false) {
    window.PersonaModelSetup?.update(config);
    const pending = resetRouting ? new Map() : new Map([...routePickers].map(([id, p]) => [id, p.value()]));
    const fallbackEnabled = !resetRouting && routePickers.size ? routing.elements.fallbackEnabled.checked : config.settings.fallback.enabled;
    $('model-connections').replaceChildren();
    if (!config.settings.connections.length) $('model-connections').append(node('p', L('尚未添加账号连接。', 'No account connections yet.'), 'ai-muted'));
    for (const c of config.settings.connections) {
      const card = node('article', null, 'ai-connection');
      const credentialStatus = c.authType === 'none' ? authLabels.none : c.hasCredential
        ? L('已保存认证 · 可为多个任务选模', 'Credentials saved · choose models for multiple tasks')
        : L('尚未认证', 'Authentication required');
      card.append(node('strong', accountLabel(c)), node('p', c.authType === 'none' ? credentialStatus : authLabels[c.authType] + ' · ' + credentialStatus, 'ai-muted'));
      const actions = node('div', null, 'ai-actions');
      actions.append(button(L('编辑账号连接', 'Edit connection'), () => edit(c)));
      if (c.authType === 'oauth') actions.append(button(
        auth?.status === 'pending' && auth.connectionId === c.id ? L('继续授权', 'Resume authorization')
          : c.hasCredential ? L('重新授权', 'Reauthorize') : L('账号授权', 'Authorize'),
        () => action(() => startAuth(c.id)),
      ));
      if (c.hasCredential) actions.append(button(L('移除凭据', 'Remove credentials'), () => action(async () => {
        if (!confirm(L('移除此账号连接的凭据？使用该连接的所有模型都需要重新认证。', 'Remove credentials? All models using this connection will need authentication again.'))) return;
        config = await api('/api/models/disconnect', { id: c.id }); render();
      })));
      actions.append(button(L('删除连接', 'Delete connection'), () => action(async () => {
        if (!confirm(L('删除此账号连接及其凭据？关联任务将回到默认配置。', 'Delete this connection and its credentials? Task overrides will reset.'))) return;
        config = await api('/api/models/remove', { id: c.id }); render(true);
      })));
      card.append(actions); $('model-connections').append(card);
    }
    const connections = config.settings.connections;
    $('model-account-summary').textContent = connections.length
      ? L('已添加 ', 'Added ') + connections.length + L(' 个连接：', ' connections: ') + connections.map(c => c.name).join('、')
      : L('先添加账号连接，再选择使用的模型。', 'Add an account connection before choosing models.');
    $('model-new').className = connections.length ? 'button ghost' : 'button primary-button';
    $('model-new').disabled = false;
    $('model-accounts').dataset.empty = String(!connections.length);
    routePickers.clear(); $('model-generation').replaceChildren(); $('model-judgment').replaceChildren(); $('model-default').replaceChildren();
    if (!config.settings.connections.length) $('model-accounts').open = true;
    for (const task of [{ id: 'default', name: L('默认模型', 'Default model') }, ...config.tasks]) {
      const saved = config.taskRoutes.find(t => t.id === task.id);
      const selected = pending.get(task.id) || (task.id === 'default'
        ? { connectionId: config.settings.defaultConnectionId, modelId: config.settings.defaultModelId }
        : { ...saved, reasoning: saved && Object.hasOwn(saved, 'reasoning') ? saved.reasoning : config.settings.overrideReasoning?.[task.id] ?? null });
      $(task.id === 'default' ? 'model-default' : quickTasks.has(task.id) ? 'model-judgment' : 'model-generation').append(createRoute(task, selected));
    }
    routing.elements.fallbackEnabled.checked = fallbackEnabled;
    $('model-fallback').replaceChildren(createRoute({ id: 'fallback', name: L('备用模型', 'Fallback model') },
      pending.get('fallback') || config.settings.fallback));
    updateInherited();
    const migration = $('model-migration'); migration.replaceChildren();
    migration.hidden = config.settings.routingVersion === 3;
    if (!migration.hidden) {
      migration.append(node('strong', L('旧模型配置已保留', 'Existing model choices are preserved')),
        node('p', L('保存后应用四项功能配置：维护助手统一选模，对话学习判定与学习生成分别选模。保存前继续使用原配置。', 'Saving applies four feature selections: one model for maintenance, with learning detection and generation configured separately. Existing routing remains active until you save.')));
      if (config.settings.routingVersion === 2) migration.append(node('p', L('对话学习的两项选择已沿用当前模型，可按需要单独调整判定模型。', 'Both learning selections start with the current model. You can choose a separate detection model.')));
      const conflicts = config.taskRoutes.filter(t => t.conflict);
      if (conflicts.length) {
        const details = node('details'); details.open = true; details.append(node('summary', L('查看原有的不同选择', 'Review differing existing choices')));
        for (const group of conflicts) for (const old of group.previous)
          details.append(node('p', (stageLabels[old.task] || taskLabels[old.task]) + '：' + (old.connectionName || L('未配置', 'Not configured')) + (old.modelId ? ' / ' + old.modelId : '')));
        migration.append(details);
      }
    }
    $('model-runs').replaceChildren(...config.runs.map(r => {
      const row = node('div', null, 'settings-run');
      row.append(node('strong', taskLabels[r.taskGroup || r.task] || r.task), node('p', modelLabel(r.connectionName, r.modelId)));
      row.append(node('p', (r.stage && r.stage !== r.task ? ui(r.stage) + ' · ' : '') + (r.status === 'succeeded' ? L('成功', 'Succeeded') : statusLabels[r.status] || r.status) + ' · ' + (r.durationMs / 1000).toFixed(1) + L(' 秒', ' s') + ' · ' + new Date(r.at).toLocaleString()));
      row.append(node('p', Object.hasOwn(r, 'reasoning')
        ? L('请求的思考强度：', 'Requested reasoning effort: ') + effortLabel(r.reasoning)
        : L('思考强度：旧记录未记录', 'Reasoning effort: not recorded in this older entry')));
      if (r.reasoningEffort && r.reasoningEffort !== r.reasoning) row.append(node('p', L('模型适配档位：', 'Model adapter level: ') + r.reasoningEffort));
      if (r.usage && Number.isFinite(r.usage.input) && Number.isFinite(r.usage.output)) row.append(node('p', L('输入 ', 'Input ') + r.usage.input.toLocaleString() + ' / ' + L('输出 ', 'Output ') + r.usage.output.toLocaleString() + ' tokens'));
      return row;
    }));
    if (!config.runs.length) $('model-runs').append(node('p', L('暂无调用记录。', 'No runs yet.'), 'ai-muted'));
    updateFallback();
    if (resetRouting || savedRouting === null) savedRouting = routingValue();
    updateDirty();
  }
  function updateFallback() {
    const enabled = routing.elements.fallbackEnabled.checked;
    $('model-fallback').hidden = !enabled;
    if (!enabled) for (const input of $('model-fallback').querySelectorAll('input,select,button')) input.disabled = true;
  }

  async function refresh() { config = await api('/api/models/config'); render(); }
  function adoptAuth(session) {
    clearTimeout(authTimer); authEpoch++;
    auth = session; submittingPromptId = null;
    renderAuth(); render(); pollAuth();
  }
  async function restoreAuth() {
    const epoch = authEpoch;
    const { session } = await api('/api/models/auth/active');
    if (epoch !== authEpoch) return null;
    if (session) {
      adoptAuth(session);
      show(L('已恢复未完成的授权，请在下方继续或取消。', 'Restored the pending authorization. Continue or cancel below.'));
    }
    return session;
  }
  async function startAuth(connectionId) {
    if (authStarting) return;
    authStarting = true;
    show(L('正在准备账号授权…', 'Preparing account authorization…'));
    try {
      adoptAuth(await api('/api/models/auth/start', { id: connectionId }));
      show(L('请在下方完成授权步骤。', 'Complete the authorization steps below.'));
      $('model-auth').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      // A login in another tab may be blocking this one; expose its continuation/cancel controls.
      if (error.code === 'login_busy') await restoreAuth();
      throw error;
    } finally { authStarting = false; }
  }
  function authLink(row, url, label) {
    if (!url?.startsWith('https://')) return;
    const link = node('a', label || L('打开平台授权页面 ↗', 'Open provider authorization ↗'));
    link.href = url; link.target = '_blank'; link.rel = 'noreferrer noopener'; row.append(link);
  }
  function authText(text) {
    if (text === 'A browser window should open. Complete login to finish.')
      return L('点击下方链接，在浏览器中完成登录。', 'Open the link below and complete login in your browser.');
    if (text === 'Complete login in your browser, or paste the authorization code / redirect URL here:')
      return L('在浏览器中完成登录；若未自动返回，可在此粘贴授权码或回跳链接：', text);
    return text;
  }
  function renderAuth() {
    const c = config.settings.connections.find(c => c.id === auth?.connectionId);
    const view = JSON.stringify([auth, submittingPromptId, c?.name, c?.modelId]);
    if (view === renderedAuthView) return;
    renderedAuthView = view;
    $('model-auth').hidden = !auth;
    if (!auth) {
      $('auth-input').replaceChildren(); renderedPromptId = null;
      return;
    }
    $('model-accounts').open = true;
    const pending = auth.status === 'pending';
    $('auth-title').textContent = L('账号授权', 'Account authorization') + (c ? ' · ' + modelLabel(c.name, c.modelId) : '');
    $('auth-status').textContent = pending
      ? (auth.prompt ? L('请完成下面的授权步骤。', 'Complete the step below.')
        : auth.events?.length ? L('请在平台页面完成授权，这里会自动更新。', 'Complete authorization on the provider page. This page updates automatically.')
          : L('正在准备授权，请稍候…', 'Preparing authorization…'))
      : auth.status === 'succeeded' ? L('授权完成，可测试连接。', 'Authorized. You can test the connection.')
        : auth.status === 'cancelled' ? L('授权已取消，可以重新开始。', 'Authorization cancelled. You can start again.')
          : auth.error || L('授权已结束，请重新开始。', 'Authorization ended. Please start again.');
    $('auth-events').replaceChildren();
    for (const event of auth.events || []) {
      const row = node('div');
      if (event.message || event.instructions) row.append(node('p', authText(event.message || event.instructions)));
      if (event.userCode) row.append(node('strong', event.userCode));
      if (pending) {
        authLink(row, event.url || event.verificationUri);
        for (const link of event.links || []) authLink(row, link.url, link.label);
      }
      $('auth-events').append(row);
    }
    const prompt = pending ? auth.prompt : null;
    $('auth-form').hidden = !prompt;
    $('auth-submit').disabled = !!submittingPromptId;
    // Polling must not replace a control while the user is selecting/typing into it.
    if ((prompt?.id || null) !== renderedPromptId) {
      renderedPromptId = prompt?.id || null;
      $('auth-input').replaceChildren();
      if (prompt) {
        const codexMethod = prompt.type === 'select' && prompt.message === 'Select OpenAI Codex login method:';
        $('auth-prompt').textContent = codexMethod ? L('选择 Codex 登录方式', 'Choose a Codex login method')
          : authText(prompt.message) || L('输入授权结果', 'Enter authorization result');
        const answer = node(prompt.type === 'select' ? 'select' : 'input');
        answer.name = 'answer'; answer.required = true;
        if (prompt.type === 'select') options(answer, prompt.options.map(option => [option.id,
          codexMethod && option.id === 'browser' ? L('浏览器登录（推荐）', option.label)
            : codexMethod && option.id === 'device_code' ? L('设备码登录', option.label) : option.label]));
        else {
          answer.type = prompt.type === 'secret' ? 'password' : 'text';
          answer.placeholder = prompt.placeholder || ''; answer.autocomplete = 'off';
        }
        $('auth-input').append(answer);
      }
    }
    $('auth-cancel').hidden = !pending;
  }
  function pollAuth() {
    clearTimeout(authTimer);
    if (!auth || auth.status !== 'pending') return;
    const id = auth.id, epoch = authEpoch;
    authTimer = setTimeout(async () => {
      try {
        const state = await api('/api/models/auth/' + id);
        if (epoch !== authEpoch) return;
        auth = state; renderAuth();
        if (auth.status !== 'pending') { show(''); await refresh(); }
      } catch (error) {
        if (epoch !== authEpoch) return;
        if (error.code === 'not_found') {
          auth = { ...auth, status: 'failed', prompt: null, events: [], error: error.message };
          renderAuth(); render();
        }
        show(error.message, true);
      } finally { if (epoch === authEpoch) pollAuth(); }
    }, 1500);
  }
  field('providerId').addEventListener('change', () => providerFields());
  field('authType').addEventListener('change', () => { $('key-field').hidden = field('authType').value !== 'api_key'; });
  $('model-new').addEventListener('click', () => { if (config) edit(); });
  $('model-close').addEventListener('click', () => { form.hidden = true; field('apiKey').value = ''; connectionDirty = false; });
  form.addEventListener('input', () => { connectionDirty = true; });
  form.addEventListener('change', () => { connectionDirty = true; });
  form.addEventListener('submit', e => { e.preventDefault(); action(async () => {
    const controls = [...form.elements], disabled = controls.map(c => c.disabled);
    for (const control of controls) control.disabled = true;
    try {
      const provider = config.providers.find(p => p.id === field('providerId').value);
      const connection = { id: editing || crypto.randomUUID(), providerId: provider.id,
        name: field('name').value, authType: field('authType').value,
        apiKey: field('apiKey').value,
        ...(provider.id === 'custom' ? { modelId: field('customModel').value, imageModelIds: field('imageModelIds').value.split('\n').map(id => id.trim()).filter(Boolean) } : {}),
        baseUrl: field('baseUrl').value, api: field('api').value,
        contextWindow: Number(field('contextWindow').value),
        maxTokens: Number(field('maxTokens').value), status: 'untested' };
      const previous = config.settings.connections.find(c => c.id === editing);
      const changedService = previous && (previous.providerId !== connection.providerId || previous.authType !== connection.authType ||
        (provider.id === 'custom' && (previous.baseUrl !== connection.baseUrl || previous.api !== connection.api)));
      config = await api('/api/models/connections', connection);
      field('apiKey').value = ''; form.hidden = true; connectionDirty = false; render(!!changedService); show(L('账号连接已保存，可在任务选模中复用。', 'Account connection saved. Reuse it when choosing task models.'));
    } finally { controls.forEach((c, i) => { c.disabled = disabled[i]; }); }
  }); });
  routing.addEventListener('submit', e => { e.preventDefault(); action(async () => {
    if (savingRouting) return;
    savingRouting = true;
    const controls = [...routing.elements], disabled = controls.map(c => c.disabled);
    controls.forEach(c => { c.disabled = true; });
    try {
    for (const picker of routePickers.values()) picker.validate();
    const primary = routePickers.get('default').value(), fallback = routePickers.get('fallback').value();
    config = await api('/api/models/routing', {
      routingVersion: 3, defaultConnectionId: primary.connectionId, defaultModelId: primary.modelId,
      overrides: Object.fromEntries(config.tasks.map(t => [t.id, routePickers.get(t.id).value().connectionId])),
      overrideModelIds: Object.fromEntries(config.tasks.map(t => [t.id, routePickers.get(t.id).value().modelId])),
      overrideReasoning: Object.fromEntries(config.tasks.map(t => [t.id, routePickers.get(t.id).value().reasoning])),
      fallback: { enabled: routing.elements.fallbackEnabled.checked, ...fallback },
    }); render(true); show(L('四项功能的模型设置已保存。', 'Model settings saved for all four features.'));
    } finally { controls.forEach((c, i) => { if (c.isConnected) c.disabled = disabled[i]; }); savingRouting = false; updateInherited(); updateDirty(); }
  }); });
  $('model-revert').addEventListener('click', () => { render(true); show(L('已撤销未保存的修改。', 'Unsaved changes reverted.')); });
  routing.elements.fallbackEnabled.addEventListener('change', () => { updateInherited(); updateFallback(); updateDirty(); });
  window.addEventListener('beforeunload', event => { if ((savedRouting && routingValue() !== savedRouting) || (!form.hidden && connectionDirty)) { event.preventDefault(); event.returnValue = ''; } });
  $('auth-form').addEventListener('submit', e => { e.preventDefault(); action(async () => {
    if (!auth?.prompt || submittingPromptId) return;
    const id = auth.id, promptId = auth.prompt.id;
    const answer = $('auth-form').elements.answer.value;
    clearTimeout(authTimer); const epoch = ++authEpoch;
    submittingPromptId = promptId; renderAuth();
    try {
      await api('/api/models/auth/answer', { id, promptId, answer });
      if (epoch !== authEpoch) return;
      $('auth-input').replaceChildren(); renderedPromptId = null;
      auth = { ...auth, prompt: null }; renderAuth();
      const state = await api('/api/models/auth/' + id);
      if (epoch !== authEpoch) return;
      auth = state; show('');
      if (auth.status !== 'pending') await refresh();
    } finally {
      if (epoch === authEpoch) { submittingPromptId = null; renderAuth(); pollAuth(); }
    }
  }); });
  $('auth-cancel').addEventListener('click', () => action(async () => {
    if (!auth) return;
    const id = auth.id, epoch = ++authEpoch;
    clearTimeout(authTimer); $('auth-cancel').disabled = true;
    try {
      await api('/api/models/auth/cancel', { id });
      if (epoch !== authEpoch) return;
      adoptAuth(null); await refresh(); show(L('授权已取消，可以重新开始。', 'Authorization cancelled. You can start again.'));
    } finally { $('auth-cancel').disabled = false; if (epoch === authEpoch) pollAuth(); }
  }));
  action(async () => { await window.PersonaModelSetup?.prepare(); await refresh(); await restoreAuth(); });
})();
