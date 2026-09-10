(() => {
  'use strict';
  const form = document.getElementById('setup-form');
  if (!form) return;
  const status = document.getElementById('setup-status');
  const submit = document.getElementById('setup-submit');
  const path = document.getElementById('workspace-path');
  const personaId = document.getElementById('persona-id');
  const details = document.getElementById('setup-details');
  const detailText = document.getElementById('setup-error-details');
  const openRunning = document.getElementById('setup-open-running');
  function showDetails(value) {
    detailText.textContent = typeof value === 'string' ? value : '';
    details.hidden = !detailText.textContent;
  }
  function updateFields() {
    const mode = form.elements.mode.value;
    document.getElementById('workspace-fields').hidden = mode === 'demo';
    document.getElementById('persona-id-field').hidden = mode !== 'create';
    path.required = mode !== 'demo';
    path.disabled = mode === 'demo';
    personaId.required = mode === 'create';
    personaId.disabled = mode !== 'create';
  }
  form.addEventListener('change', updateFields);
  updateFields();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    status.dataset.error = 'false';
    status.textContent = form.dataset.busy;
    showDetails('');
    details.open = false;
    openRunning.hidden = true;
    openRunning.removeAttribute('href');
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Persona-Setup': form.dataset.token, 'X-Persona-Language': form.dataset.language},
        body: JSON.stringify({mode: form.elements.mode.value, path: path.value, persona_id: personaId.value})
      });
      const result = await response.json();
      showDetails(result.details);
      if (!response.ok || !result.ok) throw new Error(result.error || form.dataset.failed);
      const destination = new URL(result.url);
      if (destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1') throw new Error(form.dataset.failed);
      if (document.getElementById('setup-ai-next').checked) {
        destination.pathname = '/settings/models';
      }
      if (result.warning) {
        status.textContent = result.warning;
        openRunning.href = destination.href;
        openRunning.hidden = false;
        submit.textContent = form.dataset.retry;
        submit.disabled = false;
        return;
      }
      status.textContent = form.dataset.ready;
      location.assign(destination.href);
    } catch (error) {
      status.dataset.error = 'true';
      status.textContent = error.message || form.dataset.failed;
      submit.disabled = false;
      submit.textContent = form.dataset.retry;
    }
  });
})();
