document.querySelectorAll('[data-open-paper-radar]').forEach((form) => {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    const output = form.querySelector('[role="alert"]');
    const zh = document.documentElement.lang.startsWith('zh');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = zh ? '正在打开…' : 'Opening…';
    output.textContent = '';
    try {
      const response = await fetch('/studio/paper-radar', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AI-Persona': '1' }, body: '{}',
        signal: AbortSignal.timeout(60000) });
      const result = await response.json();
      if (!response.ok || !result.url) {
        output.textContent = typeof result.error?.message === 'string' ? result.error.message
          : zh ? 'Paper Radar 未能启动，请在扩展应用中检查关联目录。' : 'Paper Radar could not start. Check its linked directory in Extensions.';
        return;
      }
      window.location.assign(result.url);
    } catch (error) {
      output.textContent = error.name === 'TimeoutError'
        ? zh ? '等待 Paper Radar 启动超时，请检查其运行状态后重试。' : 'Waiting for Paper Radar timed out. Check its status before retrying.'
        : zh ? '无法连接到启动服务，请刷新页面后重试。' : 'Could not reach the launcher. Refresh the page and try again.';
    } finally { button.disabled = false; button.textContent = label; }
  });
});

document.querySelector('[data-paper-radar-settings]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const output = form.querySelector('[role="status"]');
  const zh = document.documentElement.lang.startsWith('zh');
  button.disabled = true;
  output.textContent = '';
  try {
    const response = await fetch('/studio/paper-radar/settings', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Persona': '1' },
      body: JSON.stringify({ home: form.elements.home.value }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) {
      output.textContent = typeof result.error?.message === 'string' ? result.error.message
        : zh ? '未能保存关联，请刷新后重试。' : 'Could not save the link. Refresh and try again.';
      return;
    }
    form.elements.home.value = result.home;
    output.textContent = zh ? '已保存。现在可以打开 Paper Radar。' : 'Saved. You can now open Paper Radar.';
  } catch {
    output.textContent = zh ? '未能保存关联，请刷新后重试。' : 'Could not save the link. Refresh and try again.';
  } finally { button.disabled = false; }
});

document.querySelector('[data-copy-install]')?.addEventListener('click', async () => {
  const output = document.querySelector('[data-copy-result]');
  const zh = document.documentElement.lang.startsWith('zh');
  try {
    await navigator.clipboard.writeText(document.querySelector('[data-install-command]').textContent);
    output.textContent = zh ? '已复制。打开终端粘贴并运行。' : 'Copied. Paste and run in Terminal.';
  } catch {
    output.textContent = zh ? '请选中上方命令并复制到终端。' : 'Select the command above and copy it into Terminal.';
  }
});
