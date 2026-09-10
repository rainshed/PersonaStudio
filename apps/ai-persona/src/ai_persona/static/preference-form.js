(() => {
  for (const form of document.querySelectorAll('[data-preference-scope-form]')) {
    const scopedOption = form.querySelector('input[name="scope"][value="contexts"]');
    const contextPanel = form.querySelector('.preference-context-options');
    const contextInputs = [...contextPanel.querySelectorAll('input[name="context_refs"]')];
    const error = form.querySelector('[data-preference-context-error]');
    const hasSelection = () => contextInputs.some(input => input.checked);

    const syncScope = () => {
      const scoped = scopedOption.checked;
      contextPanel.hidden = !scoped;
      for (const input of contextInputs) {
        input.disabled = !scoped;
        if (!scoped) input.checked = false;
      }
      if (!scoped || hasSelection()) error.hidden = true;
    };

    form.addEventListener('change', event => {
      if (event.target.name === 'scope' || event.target.name === 'context_refs') {
        syncScope();
      }
    });
    form.addEventListener('submit', event => {
      // Archive and restore actions do not save the form's scope selection.
      if (event.submitter?.hasAttribute('formaction')) return;
      syncScope();
      if (scopedOption.checked && !hasSelection()) {
        event.preventDefault();
        error.hidden = false;
        (contextInputs[0] || contextPanel.querySelector('a'))?.focus();
      }
    });
    syncScope();
    window.addEventListener('pageshow', syncScope);
  }
})();
