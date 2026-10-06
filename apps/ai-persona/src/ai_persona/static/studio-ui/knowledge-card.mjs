// Studio UI: a detail card for the selected knowledge node, plus mastery-level filters.
// The graph keeps its own behavior; this only replaces "open the record page" on click.
const ORDER = ['parent', 'child', 'requires', 'required_by', 'applied_in', 'uses', 'related_to'];
const OUTGOING = {broader_than: 'child', requires: 'requires', applied_in: 'applied_in', related_to: 'related_to'};
const INCOMING = {broader_than: 'parent', requires: 'required_by', applied_in: 'uses', related_to: 'related_to'};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createNodeCard(panel, data, graphLabels) {
  const extra = JSON.parse(panel.ownerDocument.querySelector('[data-studio-graph-details]')?.textContent || '{}');
  const details = extra.details || {};
  const text = extra.labels || {};
  const card = panel.querySelector('[data-studio-node-card]');
  const map = panel.querySelector('#map');
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  let graph = null;
  let current = null;

  // Dragging, wheel-zooming and double-clicking inside the card must not move the graph.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel', 'dblclick']) {
    card.addEventListener(type, (event) => event.stopPropagation(), {passive: true});
  }

  function relations(id) {
    const items = [];
    for (const edge of data.edges) {
      if (edge.source === id && OUTGOING[edge.type]) items.push({kind: OUTGOING[edge.type], id: edge.target});
      else if (edge.target === id && INCOMING[edge.type]) items.push({kind: INCOMING[edge.type], id: edge.source});
    }
    return items.filter((item) => byId.has(item.id))
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || byId.get(a.id).title.localeCompare(byId.get(b.id).title));
  }

  function place(id) {
    const target = map.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    if (!target) return;
    const area = map.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    card.classList.toggle('is-left', box.left + box.width / 2 - area.left > area.width / 2);
  }

  function render(node) {
    const info = details[node.id] || {};
    const head = element('div', 'ps-node-card-head');
    const level = element('span', 'ps-node-chip');
    level.append(element('i', `node-dot ${node.level}`), document.createTextNode(graphLabels.levels?.[node.level] || node.level));
    head.append(level);
    if (node.interest && text.interest_levels?.[node.interest]) head.append(element('span', 'ps-node-chip', text.interest_levels[node.interest]));
    const close = element('button', 'ps-node-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', text.close || 'Close');
    close.addEventListener('click', clear);
    head.append(close);

    const body = [head, element('h3', 'ps-node-title', node.title)];
    if (info.summary) body.push(element('p', 'ps-node-summary', info.summary));

    body.push(element('p', 'ps-node-section', text.relations));
    const links = relations(node.id);
    if (!links.length) body.push(element('p', 'ps-node-empty', text.none));
    for (const link of links.slice(0, 8)) {
      const row = element('button', 'ps-node-relation');
      row.type = 'button';
      row.append(element('span', 'ps-node-relation-kind', text[link.kind] || link.kind), element('span', 'ps-node-relation-title', byId.get(link.id).title));
      row.addEventListener('click', () => focus(link.id));
      body.push(row);
    }

    if (info.materials?.length) {
      body.push(element('p', 'ps-node-section', text.materials));
      for (const material of info.materials) {
        const anchor = element('a', 'ps-node-material', material.title);
        anchor.href = material.url;
        body.push(anchor);
      }
    }

    const actions = element('div', 'ps-node-actions');
    for (const [label, href, className] of [
      [text.open, node.href, 'is-primary'],
      [text.edit, `/knowledge/${encodeURIComponent(node.id)}/edit`, ''],
      [text.ask_ai, `/ai?record_id=${encodeURIComponent(node.id)}`, 'is-soft'],
    ]) {
      const anchor = element('a', `ps-node-action ${className}`.trim(), label);
      anchor.href = href;
      actions.append(anchor);
    }
    body.push(actions);
    card.replaceChildren(...body);
  }

  function select(item) {
    if (!item || item.source !== undefined) return; // edges keep their own highlight
    const node = byId.get(item.id) || item;
    current = node.id;
    render(node);
    card.hidden = false;
    place(node.id);
  }

  async function focus(id) {
    if (graph?.reveal) await graph.reveal(id);
    select(byId.get(id));
  }

  function clear() {
    current = null;
    card.hidden = true;
  }

  map.addEventListener('click', (event) => { if (event.target === map) clear(); });
  map.addEventListener('keydown', (event) => { if (event.key === 'Escape' && current) clear(); });

  for (const button of panel.querySelectorAll('[data-ps-level]')) {
    button.addEventListener('click', () => {
      const active = map.dataset.psLevel === button.dataset.psLevel;
      if (active) delete map.dataset.psLevel; else map.dataset.psLevel = button.dataset.psLevel;
      for (const other of panel.querySelectorAll('[data-ps-level]')) {
        other.setAttribute('aria-pressed', String(!active && other === button));
      }
    });
  }

  return {select, clear, attach(value) { graph = value; }};
}
