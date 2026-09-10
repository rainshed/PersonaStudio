/* Environment checks never start login or make a provider request. */
(() => {
  'use strict';
  const { L, api, node } = window.PersonaAI;
  const $ = id => document.getElementById(id);
  if (!$('model-setup')) return;
  let resolveReady, timer, busy = false, ready = false, currentConfig;
  const prepared = new Promise(resolve => { resolveReady = resolve; });
  const steps = ['runtime', 'account', 'auth', 'test'];
  function progress(done) {
    const current = done.indexOf(false);
    steps.forEach((step, i) => {
      const el = $('model-step-' + step);
      el.dataset.done = String(done[i]);
      if (i === current) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
  }
  function update(config) {
    currentConfig = config;
    if (!ready) return;
    const settings = config.settings;
    const connection = settings.connections.find(c => c.id === settings.defaultConnectionId)
      || settings.connections[0];
    const credential = !!connection && (connection.authType === 'none' || connection.hasCredential);
    const latestTest = config.runs.find(r => r.connectionId === connection?.id
      && r.connectionRevision === connection?.revision && r.modelId === settings.defaultModelId
      && r.task === 'test');
    const verified = credential && !!settings.defaultModelId && latestTest?.status === 'succeeded';
    progress([true, !!connection, credential, !!verified]);
    $('model-setup-title').textContent = verified ? L('AI 连接已验证', 'AI connection verified') : L('完成 AI 设置', 'Set up AI');
    $('model-setup-message').textContent = !connection
      ? L('环境已就绪。下一步：点击“添加账号连接”，选择平台与认证方式。', 'Environment ready. Next: add an account connection and choose a provider and authentication method.')
      : !credential ? L('账号已添加。下一步：完成账号授权，或编辑连接并保存 API Key。', 'Account added. Next: authorize the account, or edit the connection to save an API key.')
      : !verified ? L('凭据已保存，尚未确认模型可用。下一步：选择默认模型，点击“测试连接（真实调用）”，再保存模型设置。', 'Credentials saved; model access is not yet verified. Choose a default model, run the connection test, then save model settings.')
      : L('默认模型已测试并保存。你可以开始使用 AI；其他模型和功能仍可分别测试。', 'Your default model has been tested and saved. You can start using AI; other models and features can be tested separately.');
  }
  function render(result) {
    const state = result.status;
    ready = state === 'ready';
    $('model-setup').dataset.state = state;
    $('model-controls').disabled = !ready;
    $('model-controls').hidden = !ready;
    $('model-runtime-install').hidden = !['not_installed', 'failed'].includes(state) || result.can_install === false;
    $('model-node-download').hidden = state !== 'needs_node' || result.can_install === false;
    $('model-runtime-check').disabled = state === 'installing';
    $('model-runtime-checks').replaceChildren(...(result.checks || [])
      .filter(c => c.name !== 'model_runtime')
      .map(c => node('li', c.name + (c.version ? ' ' + c.version : '') + ' · '
        + (c.ok ? L('可用', 'Ready') : L('需要安装或更新', 'Install or update required')))));
    $('model-runtime-checks').hidden = ready;
    const messages = {
      installing: L('正在下载并检查模型组件，请稍候。可以刷新页面查看进度。', 'Downloading and checking model components. You can reload this page to check progress.'),
      needs_node: L('请先安装 Node.js 22.19 或更新的 LTS 版本（包含 npm），然后重新检查。若仍未识别，请重新启动 Studio。', 'Install Node.js LTS 22.19 or newer, including npm, then check again. Restart Studio if the new installation is not detected.'),
      not_installed: L('浏览和编辑已经可用。启用 AI 还需要下载模型组件，点击下方按钮即可安装。', 'Browsing and editing are ready. To enable AI, install the model components with the button below.'),
      failed: result.error === 'install_timeout'
        ? L('下载超时。请检查网络后重新安装；已有账号不会被删除。', 'Download timed out. Check your network and try again; existing accounts are preserved.')
        : L('安装未完成。请检查网络和应用缓存目录的写入权限，然后重试。若持续失败，可在终端运行 models-install 查看详情。', 'Installation did not finish. Check your network and write access to the application cache, then retry. Run models-install in a terminal for details if it keeps failing.'),
      ready: L('环境已就绪，正在加载账号设置…', 'Environment ready. Loading account settings…'),
    };
    $('model-setup-message').dataset.error = String(state === 'failed');
    $('model-setup-message').textContent = result.can_install === false && !ready
      ? L('请在运行 Studio 的电脑上打开模型设置，完成环境安装后再回来。', 'Open model settings on the computer running Studio to install its components, then return here.')
      : messages[state];
    progress([ready, false, false, false]);
    if (ready) { resolveReady(); if (currentConfig) update(currentConfig); }
    if (state === 'installing') timer = setTimeout(() => check(), 1200);
  }
  async function check(install = false) {
    if (busy) return;
    busy = true; clearTimeout(timer);
    $('model-runtime-install').disabled = true;
    $('model-runtime-check').disabled = true;
    try {
      render(await api('/api/models/runtime' + (install ? '/install' : ''), install ? {} : undefined));
    } catch (error) {
      $('model-setup').dataset.state = 'failed';
      $('model-setup-message').dataset.error = 'true';
      $('model-setup-message').textContent = L('环境检查未完成，请重新检查。', 'Environment check failed. Please check again.');
      $('model-runtime-check').disabled = false;
    } finally {
      busy = false; $('model-runtime-install').disabled = false;
    }
  }
  $('model-runtime-install').addEventListener('click', () => check(true));
  $('model-runtime-check').addEventListener('click', () => check());
  window.addEventListener('pagehide', () => clearTimeout(timer));
  window.PersonaModelSetup = { prepare: () => prepared, update };
  check();
})();
