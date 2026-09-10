(() => {
  const form = document.querySelector('[data-context-editor]');
  if (!form) return;

  const list = form.querySelector('[data-example-list]');
  const template = form.querySelector('[data-example-template]');
  let nextId = list.children.length;

  function renumber() {
    [...list.children].forEach((row, index) => {
      const input = row.querySelector('textarea');
      if (!input.id) input.id = `context-example-${++nextId}`;
      const label = row.querySelector('label');
      label.htmlFor = input.id;
      label.textContent = form.dataset.exampleLabel.replace('{number}', index + 1);
      const remove = row.querySelector('[data-remove-example]');
      const removeLabel = form.dataset.removeLabel.replace('{number}', index + 1);
      remove.setAttribute('aria-label', removeLabel);
      remove.title = removeLabel;
    });
  }

  function grow(input) {
    if (!input.getClientRects().length) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + 2}px`;
  }

  function addExample() {
    const row = template.content.firstElementChild.cloneNode(true);
    list.append(row);
    renumber();
    const input = row.querySelector('textarea');
    grow(input);
    input.focus();
  }

  form.querySelector('[data-add-example]').addEventListener('click', addExample);
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-example]');
    if (!button) return;
    const row = button.closest('[data-example-row]');
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    if (!list.children.length) addExample();
    else {
      renumber();
      next.querySelector('textarea').focus();
    }
  });

  form.querySelectorAll('[required]').forEach((input) => {
    const validate = () => input.setCustomValidity(
      input.value.trim() ? '' : input.dataset.requiredMessage
    );
    validate();
    input.addEventListener('input', () => {
      validate();
      input.removeAttribute('aria-invalid');
      const error = form.querySelector(`#${input.id}-error`);
      if (error) error.hidden = true;
    });
  });

  form.addEventListener('input', (event) => {
    if (event.target.matches('textarea')) grow(event.target);
  });
  const growAll = () => form.querySelectorAll('textarea').forEach(grow);
  form.querySelector('details').addEventListener('toggle', growAll);
  new ResizeObserver(growAll).observe(form);
  renumber();
  growAll();
})();
