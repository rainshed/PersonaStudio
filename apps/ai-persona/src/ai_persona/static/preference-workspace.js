(() => {
  const root = document.querySelector('[data-preference-workspace]');
  if (!root) return;
  const popovers = [...root.querySelectorAll('[data-record-menu], .pw-filters, [data-scene-picker]')];
  popovers.forEach(popover => popover.addEventListener('toggle', () => {
    if (popover.open) popovers.forEach(other => { if (other !== popover) other.open = false; });
  }));
  document.addEventListener('click', event => {
    popovers.forEach(popover => { if (!popover.contains(event.target)) popover.open = false; });
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const popover = popovers.find(item => item.open && item.contains(event.target));
    if (popover) { popover.open = false; popover.querySelector('summary').focus(); }
  });
  root.querySelectorAll('[data-copy-path]').forEach(button => {
    const input = document.getElementById(button.dataset.copyPath);
    const status = button.parentElement.querySelector('.pw-copy-status');
    input.addEventListener('click', () => input.select());
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        status.textContent = button.dataset.copiedLabel;
      } catch {
        input.focus(); input.select();
        status.textContent = button.dataset.copyFallback;
      }
    });
  });
  const search = root.querySelector('[data-scene-search]');
  if (search) search.addEventListener('input', () => {
    let visible = 0;
    const query = search.value.trim().toLocaleLowerCase();
    root.querySelectorAll('[data-scene-choice]').forEach(choice => {
      choice.hidden = !choice.textContent.toLocaleLowerCase().includes(query);
      if (!choice.hidden) visible++;
    });
    root.querySelector('[data-no-scenes]').hidden = visible > 0;
  });
})();
