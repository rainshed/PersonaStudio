(() => {
  const locations = ['models', 'sources', 'capabilities', 'retention'];
  const remember = value => {
    if (locations.includes(value)) document.cookie = 'persona-settings-tab=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax';
  };
  const current = location.pathname === '/settings/models' ? 'models' : new URLSearchParams(location.search).get('tab');
  remember(current);
  document.querySelectorAll('[data-settings-location]').forEach(link => {
    link.addEventListener('click', event => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) remember(link.dataset.settingsLocation);
    });
  });
  window.addEventListener('popstate', () => remember(new URLSearchParams(location.search).get('tab')));
})();
