/* Shared safe DOM helpers: model and material text is always text, never executable HTML. */
window.PersonaAI = (() => {
  const zh = document.documentElement.lang === 'zh-CN';
  const L = (cn, en) => zh ? cn : en;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const api = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AI-Persona': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok || result.ok === false) {
      const error = new Error(result.error?.message || result.error || L('请求未完成', 'Request failed'));
      error.code = result.error?.code || result.code;
      throw error;
    }
    return result;
  };
  const button = (text, action, className = 'button ghost') => {
    const b = node('button', text, className); b.type = 'button';
    b.addEventListener('click', action); return b;
  };
  const notice = (id, text, error = false) => {
    const el = document.getElementById(id); el.textContent = text;
    el.className = 'ai-notice' + (error ? ' ai-error' : ''); el.hidden = !text;
  };
  const modelLabel = (name, id) => {
    const normalize = value => (value || '').toLowerCase().replace(/[\s._-]+/g, '');
    if (!name || normalize(name) === normalize(id)) return name || id;
    return id ? name + ' · ' + id : name;
  };
  return { L, node, api, button, notice, modelLabel };
})();
