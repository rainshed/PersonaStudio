/* One visibility policy for inline validation, async tasks and server-rendered errors. */
(() => {
  const zh = document.documentElement.lang === 'zh-CN';
  const L = (cn, en) => zh ? cn : en;
  const selector = '[role="alert"],.ai-error,.error,.context-field-error,[data-state="error"],[data-error="true"]';
  let seen = new Set(), scheduled = false, lastAction = null;
  function reveal(element) {
    if (!element?.isConnected) return;
    const dialog = document.querySelector('dialog[open]');
    if (dialog && !dialog.contains(element)) return;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Leave a visible inline message beside its control. Scroll only when necessary.
    let outside = rect.top < 72 || rect.bottom > innerHeight - 24 || rect.left < 0 || rect.right > innerWidth;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.top < bounds.top || rect.bottom > bounds.bottom)) outside = true;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.left < bounds.left || rect.right > bounds.right)) outside = true;
    }
    if (outside) {
      element.scrollIntoView({ block: rect.height > innerHeight - 100 ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
      element.setAttribute('tabindex', '-1');
      element.focus({ preventScroll: true });
    }
  }
  function scan() {
    scheduled = false;
    const next = new Set(), fresh = [];
    const dialog = document.querySelector('dialog[open]');
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest('[hidden],[aria-hidden="true"],dialog:not([open])')) continue;
      const text = el.textContent.trim();
      if (!text || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') continue;
      const owner = el.id || el.parentElement?.closest('[id]')?.id || '';
      // Stable across polling that replaces DOM nodes with identical errors.
      const key = owner + '\n' + text;
      // Defer newly arriving background errors until the modal closes; do not lose them.
      if (dialog && !dialog.contains(el)) {
        if (seen.has(key)) next.add(key);
        continue;
      }
      next.add(key);
      if (!seen.has(key)) fresh.push(el);
    }
    seen = next;
    if (!fresh.length) return;
    const candidates = dialog ? fresh.filter(el => dialog.contains(el)) : fresh;
    const y = lastAction?.isConnected ? lastAction.getBoundingClientRect().top : innerHeight / 2;
    candidates.sort((a, b) => Math.abs(a.getBoundingClientRect().top - y) - Math.abs(b.getBoundingClientRect().top - y));
    reveal(candidates[0]);
  }
  function schedule() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(scan); }
  }
  function report(message, anchor = lastAction) {
    const container = anchor?.closest('form,section,article,dialog') || document.querySelector('main') || document.body;
    let el = container.querySelector(':scope > [data-request-error]');
    if (!el) {
      el = document.createElement('p'); el.dataset.requestError = '';
      el.className = 'request-error'; el.setAttribute('role', 'alert'); container.append(el);
    }
    el.textContent = message; el.hidden = false;
    reveal(el);
  }
  for (const type of ['click', 'submit']) document.addEventListener(type, event => {
    lastAction = event.submitter || event.target.closest('button,input,select,textarea,a,form') || event.target;
  }, true);
  document.addEventListener('htmx:beforeRequest', event => {
    const anchor = event.detail?.requestConfig?.elt || event.detail?.elt || event.target;
    const container = anchor?.closest('form,section,article,dialog');
    const previous = container?.querySelector(':scope > [data-request-error]');
    if (previous) previous.hidden = true;
  });
  for (const type of ['htmx:responseError', 'htmx:sendError', 'htmx:timeout']) {
    document.addEventListener(type, event => {
      let message = type === 'htmx:timeout'
        ? L('请求超时，请检查当前状态后重试。', 'The request timed out. Check its current status before retrying.')
        : L('操作未完成，请检查连接后重试。', 'The action failed. Check the connection and retry.');
      const xhr = event.detail?.xhr;
      if (xhr?.responseText) {
        try {
          const value = JSON.parse(xhr.responseText);
          const detail = value.error?.message || value.error || value.message;
          if (typeof detail === 'string') message = detail;
        } catch {
          // Extract only a designated error message; never inject a failed HTML response.
          const doc = new DOMParser().parseFromString(xhr.responseText, 'text/html');
          const detail = doc.querySelector(selector)?.textContent.trim();
          if (detail) message = detail;
        }
      }
      report(message, event.detail?.requestConfig?.elt || event.detail?.elt || event.target);
    });
  }
  window.addEventListener('error', event => {
    if (event.error) report(L('页面操作发生异常，请刷新页面后重试；未保存的输入请先复制。', 'A page error occurred. Copy unsaved input, then refresh and retry.'));
  });
  window.addEventListener('unhandledrejection', () => report(L('操作未能完成，请检查当前状态后重试。', 'The action could not finish. Check its current status before retrying.')));
  new MutationObserver(schedule).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'class', 'role', 'data-state', 'data-error', 'open', 'style'],
  });
  window.PersonaErrors = { reveal, report };
  schedule();
})();
