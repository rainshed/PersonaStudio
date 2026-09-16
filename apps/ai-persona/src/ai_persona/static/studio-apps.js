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
      if (!response.ok || !result.url) throw new Error('launch failed');
      window.location.assign(result.url);
    } catch {
      output.textContent = zh ? 'Paper Radar 未能启动。请确认已完成安装，并检查 Paper Radar 的运行状态。' : 'Paper Radar could not start. Check its installation and running status.';
    } finally { button.disabled = false; button.textContent = label; }
  });
});
