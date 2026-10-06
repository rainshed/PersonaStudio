(() => {
  'use strict';
  const root = document.documentElement;
  if (root.dataset.ui !== 'studio') return;
  const narrow = matchMedia('(max-width: 900px)');

  // Inside the AI drawer, assistant links stay in the drawer; everything else opens in the page (<base target="_top">).
  if (window.top !== window && document.body?.classList.contains('evaluation-embedded')) {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || event.defaultPrevented) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname !== '/ai') return;
      event.preventDefault();
      url.searchParams.set('embed', '1');
      location.assign(url.href);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      try { window.parent.document.querySelector('#ps-drawer [data-ps-drawer-close]')?.click(); } catch { /* not our page */ }
    });
  }

  // ---- mobile navigation ----
  const navToggle = document.querySelector('[data-ps-nav-toggle]');
  const setNav = (open) => {
    root.classList.toggle('ps-nav-open', open);
    navToggle?.setAttribute('aria-expanded', String(open));
  };
  navToggle?.addEventListener('click', () => setNav(!root.classList.contains('ps-nav-open')));
  document.querySelector('[data-ps-nav-close]')?.addEventListener('click', () => setNav(false));
  narrow.addEventListener('change', () => setNav(false));

  // ---- AI drawer ----
  const drawer = document.getElementById('ps-drawer');
  const frame = drawer?.querySelector('iframe');
  const openDrawer = (href) => {
    if (!drawer) return;
    if (frame) {
      // A link with context (record_id, material_id, session…) restarts the drawer on that task.
      const target = new URL(href || frame.dataset.src, location.href);
      target.searchParams.set('embed', '1');
      if (!frame.src || target.search !== '?embed=1') frame.src = target.pathname + target.search;
    }
    drawer.hidden = false;
    root.classList.add('ps-drawer-open');
    drawer.querySelector('[data-ps-drawer-close]')?.focus();
  };
  const closeDrawer = () => {
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    root.classList.remove('ps-drawer-open');
  };
  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-ps-drawer-open], a[href]');
    const url = link?.href ? new URL(link.href, location.href) : null;
    const assistant = link && (link.matches('[data-ps-drawer-open]') || (url.origin === location.origin && url.pathname === '/ai'));
    if (assistant && !event.defaultPrevented) {
      // The full page stays the fallback: modified clicks, small screens and the /ai page itself.
      if (event.metaKey || event.ctrlKey || event.shiftKey || narrow.matches || location.pathname === '/ai' || !drawer || link.closest('#ps-drawer')) return;
      event.preventDefault();
      setNav(false);
      if (!drawer.hidden && link.matches('[data-ps-drawer-open]')) closeDrawer(); else openDrawer(url?.search ? url.href : null);
      return;
    }
    if (event.target.closest('[data-ps-drawer-close]')) closeDrawer();
  });

  // ---- command palette ----
  const palette = document.getElementById('ps-palette');
  const config = JSON.parse(document.getElementById('ps-palette-data')?.textContent || '{}');
  const input = palette?.querySelector('input');
  const list = palette?.querySelector('.ps-palette-list');
  const labels = config.labels || {};
  let records = null;
  let loading = null;
  let results = [];
  let active = 0;
  let returnFocus = null;

  const loadRecords = () => {
    if (records || loading) return loading;
    loading = fetch('/api/studio-ui/v1/index', { headers: { Accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : { items: [] })
      .then((data) => { records = data.items || []; render(); })
      .catch(() => { records = []; })
      .finally(() => { loading = null; });
    return loading;
  };
  const normalize = (value) => String(value || '').toLocaleLowerCase();
  const matches = (query, ...values) => !query || values.some((value) => normalize(value).includes(query));

  const collect = () => {
    const query = normalize(input.value.trim());
    const items = [];
    (config.pages || []).filter(([, title]) => matches(query, title)).slice(0, query ? 6 : 5)
      .forEach(([url, title]) => items.push({ group: labels.pages, title, hint: labels.page, run: () => location.assign(url) }));
    (config.actions || []).filter((action) => matches(query, action.label, action.hint)).forEach((action) => items.push({
      group: labels.actions, title: action.label, hint: action.hint,
      run: () => {
        if (action.drawer) { closePalette(false); openDrawer(); return; }
        location.assign(action.url);
      },
    }));
    if (query && records) {
      const counts = {};
      records.forEach((record) => {
        if ((counts[record.kind] || 0) >= 6 || !matches(query, record.title, ...(record.aliases || []))) return;
        counts[record.kind] = (counts[record.kind] || 0) + 1;
        items.push({ group: labels[record.kind] || record.kind, title: record.title, hint: '', run: () => location.assign(record.url) });
      });
    }
    return items;
  };

  const render = () => {
    if (!palette || palette.hidden) return;
    results = collect();
    active = Math.min(active, Math.max(results.length - 1, 0));
    list.replaceChildren();
    if (!results.length) {
      const empty = document.createElement('p');
      empty.className = 'ps-palette-empty';
      empty.textContent = labels.empty || 'No matches';
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    let group = null;
    results.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        const heading = document.createElement('div');
        heading.className = 'ps-palette-group';
        heading.textContent = group;
        list.append(heading);
      }
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ps-palette-item';
      option.id = `ps-palette-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === active));
      option.tabIndex = -1;
      const title = document.createElement('span');
      title.textContent = item.title;
      option.append(title);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'ps-palette-hint';
        hint.textContent = item.hint;
        option.append(hint);
      }
      option.addEventListener('mousemove', () => { if (active !== index) { active = index; highlight(); } });
      option.addEventListener('click', () => item.run());
      list.append(option);
    });
    highlight();
  };
  const highlight = () => {
    list.querySelectorAll('.ps-palette-item').forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
    const current = document.getElementById(`ps-palette-option-${active}`);
    if (current) { input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
  };
  const openPalette = () => {
    if (!palette) return;
    returnFocus = document.activeElement;
    setNav(false);
    palette.hidden = false;
    input.value = '';
    active = 0;
    render();
    input.focus();
    loadRecords();
  };
  function closePalette(restore = true) {
    if (!palette || palette.hidden) return;
    palette.hidden = true;
    if (restore && returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }
  input?.addEventListener('input', () => { active = 0; render(); });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(active + 1, results.length - 1); highlight(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); results[active]?.run(); }
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-ps-palette-open]')) { event.preventDefault(); openPalette(); }
    else if (event.target.closest('[data-ps-palette-close]')) closePalette();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && palette) {
      event.preventDefault();
      if (palette.hidden) openPalette(); else closePalette();
    } else if (event.key === 'Escape') {
      if (palette && !palette.hidden) { event.preventDefault(); closePalette(); }
      else if (drawer && !drawer.hidden) closeDrawer();
      else if (root.classList.contains('ps-nav-open')) setNav(false);
    }
  });
})();
