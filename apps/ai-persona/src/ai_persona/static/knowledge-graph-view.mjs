import './knowledge-map/layout-core.js?v=20260910.2';
import {edgePath} from './knowledge-map/edge-path.mjs?v=20260910.3';

// The graph is a view of this workspace. Node links use the existing detail routes.
export async function mountKnowledgeGraph(panel, data, labels, {onSelect, onReject} = {}) {
  const lifecycle = new AbortController();
  const listen = (target, type, fn) => target.addEventListener(type, fn, {signal:lifecycle.signal});
  const $ = selector => panel.querySelector(selector);
  const map = $('#map');
  if (!map) return;
  if(onSelect)panel.querySelector("#edges").removeAttribute("aria-hidden");


  const {GraphLayout, d3} = globalThis;
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  const ix = GraphLayout.index(data);
  const world = $('#world');
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 270;
  const text = (tag, value, className) => {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const format = (key, values) => labels[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
  const collapsed = new Set(), nodeElements = new Map(), cache = new Map(), matches = new Set();
  let result = null, hovered = null, focused = null, transform = d3.zoomIdentity;
  let currentMode = 'auto', sequence = 0, needsInitialView = true;
  let worker = null, workerId = 0;
  const pending = new Map();
  function syncReject(el,node){
    const button=el.querySelector('.node-reject');if(!button)return;
    button.hidden=!node.rejectable;button.disabled=!node.canReject;
    button.setAttribute('aria-label','拒绝知识点：'+node.title);
    button.title='拒绝“'+node.title+'”'+(node.rejectCount?'，同时拒绝依赖它的 '+node.rejectCount+' 条待审核候选':'');
  }
  function startWorker() {
    worker?.terminate();
    for (const task of pending.values()) task.reject(new Error('Layout worker restarted'));
    pending.clear();
    worker = new Worker(new URL('./knowledge-map/layout-worker.js?v=20260910.2', import.meta.url));
    worker.onmessage = ({data}) => {
      const task = pending.get(data.id);
      if (!task) return;
      pending.delete(data.id);
      data.error ? task.reject(new Error(data.error)) : task.resolve(data.layout);
    };
    worker.onerror = event => {
      for (const task of pending.values()) task.reject(new Error(event.message || labels.error));
      pending.clear();
    };
  }
  const run = (graph, mode) => new Promise((resolve, reject) => {
    if (!worker) startWorker();
    const id = ++workerId;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, graph, mode});
  });

  await document.fonts.ready;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
  for (const n of data.nodes) {
    const max = 194, lines = [];
    let line = '';
    const tokens = n.title.match(/[A-Za-z0-9À-ž]+(?:[-–][A-Za-z0-9]+)*|\s+|[^\x00-\x7F]|./g) ?? [n.title];
    for (const token of tokens) {
      if (ctx.measureText(token).width > max) {
        for (const char of token) {
          if (line && ctx.measureText(line + char).width > max) { lines.push(line.trim()); line = char; }
          else line += char;
        }
      } else if (line && ctx.measureText(line + token).width > max) {
        lines.push(line.trim()); line = token.trimStart();
      } else line += token;
    }
    if (line.trim()) lines.push(line.trim());
    if (lines.length > 1 && /^[\u3400-\u9fff]$/.test(lines.at(-1))) {
      const tail = lines.at(-2).match(/[\u3400-\u9fff]+$/)?.[0];
      if (tail && tail.length < 4) {
        lines[lines.length - 2] = lines.at(-2).slice(0, -tail.length).trimEnd();
        lines[lines.length - 1] = tail + lines.at(-1);
      }
    }
    Object.assign(n, {lines, width: Math.ceil(Math.max(92, ...lines.map(s => ctx.measureText(s).width)) + 47), height: Math.max(38, lines.length * 20 + 18) + (n.statusLabel ? 16 : 0)});
  }

  // Store only navigation state, separately for each workspace and browser origin.
  // Start with every branch visible when upgrading from the hierarchy-only view.
  const stateKey = `persona-knowledge-map:v2:${panel.dataset.workspace}`;
  const signature = JSON.stringify([data.nodes.map(n => [n.id, n.width, n.height]), data.edges]);
  let saved = null;
  try {
    const candidate = JSON.parse(sessionStorage.getItem(stateKey));
    if (candidate?.signature === signature && ['auto', 'right', 'down', 'bilateral'].includes(candidate.mode) &&
      Array.isArray(candidate.collapsed) && Array.isArray(candidate.view) && candidate.view.length === 3 &&
      candidate.view.every(Number.isFinite) && candidate.view[2] >= .1 && candidate.view[2] <= 2.5) {
      saved = candidate;
      for (const id of saved.collapsed) if (byId.has(id)) collapsed.add(id);
      currentMode = saved.mode;
    }
  } catch { /* Navigation still works when session storage is unavailable. */ }
  const saveView = () => {
    if (!result || needsInitialView) return;
    try {
      sessionStorage.setItem(stateKey, JSON.stringify({signature, collapsed: [...collapsed], mode: currentMode,
        view: [transform.x, transform.y, transform.k], size: lastSize}));
    } catch { /* Storage is optional. */ }
  };
  listen(window, 'pagehide', saveView);
  $('#layout').value = currentMode;
  $('#layout option[value=bilateral]').disabled = !GraphLayout.isTree(data);

  const zoom = d3.zoom().scaleExtent([.1, 2.5]).filter(event => {
    if (event.target.closest('.mini-wrap,.zoom-tools,.relation-legend,#error')) return false;
    if (event.type === 'wheel') return true;
    return !event.button && !event.target.closest('button,a,input,select');
  }).on('zoom', event => {
    transform = event.transform;
    world.style.transform = `translate(${transform.x}px,${transform.y}px) scale(${transform.k})`;
    $('#zoom-reset').textContent = Math.round(transform.k * 100) + '%';
    $('#zoom-out').disabled = transform.k <= .1;
    $('#zoom-in').disabled = transform.k >= 2.5;
    map.classList.toggle('overview', transform.k < .35);
    // Keep arrowheads readable at every zoom level, like the line patterns.
    d3.select($('#edges')).selectAll('marker')
      .attr('markerWidth', function() { return Number(this.dataset.size || 9) / transform.k; })
      .attr('markerHeight', function() { return Number(this.dataset.size || 9) / transform.k; });
    updateMini();
  });
  d3.select(map).call(zoom).on('dblclick.zoom', null);
  function view(next, animate = true) {
    const selection = d3.select(map);
    if (animate && duration) selection.transition('view').duration(duration).call(zoom.transform, next);
    else { selection.interrupt('view'); selection.call(zoom.transform, next); }
  }
  function fit(animate = true) {
    if (!result || !map.clientWidth || !map.clientHeight) return;
    const b = result.bounds;
    const k = Math.max(.1, Math.min((map.clientWidth - 60) / b.width, (map.clientHeight - 120) / b.height, 1.2));
    view(d3.zoomIdentity.translate(map.clientWidth / 2 - (b.x + b.width / 2) * k,
      map.clientHeight / 2 - 12 - (b.y + b.height / 2) * k).scale(k), animate);
  }
  function center(id) {
    const n = result?.nodes.find(n => n.id === id);
    if (!n) return;
    const k = Math.min(1.4, Math.max(.92, transform.k));
    view(d3.zoomIdentity.translate(map.clientWidth / 2 - (n.x + n.width / 2) * k,
      map.clientHeight / 2 - (n.y + n.height / 2) * k).scale(k));
  }
  function ancestors(id) {
    const seen = new Set(), todo = [...(ix.parents.get(id) ?? [])];
    while (todo.length) {
      const n = todo.pop();
      if (seen.has(n)) continue;
      seen.add(n); todo.push(...ix.parents.get(n));
    }
    return seen;
  }
  function highlight() {
    const selected = hovered ?? focused;
    const upstream = selected ? ancestors(selected) : new Set();
    const related = new Set(selected ? [selected, ...upstream] : []);
    for (const e of data.edges) if (e.source === selected || e.target === selected) { related.add(e.source); related.add(e.target); }
    for (const [id, el] of nodeElements) {
      el.classList.toggle('selected', id === selected);
      el.classList.toggle('dimmed', !!selected && !related.has(id));
      el.classList.toggle('matched', matches.has(id));
    }
    d3.select($('#edge-layer')).selectAll('.edge-group')
      .classed('highlighted', e => !!selected && (e.source === selected || e.target === selected ||
        (e.type === 'broader_than' && upstream.has(e.source) && upstream.has(e.target))))
      .classed('dimmed', e => !!selected && !(related.has(e.source) && related.has(e.target)));
    $('#selection-caption').textContent = byId.get(selected)?.title ?? labels.help;
  }
  function applyInitialView() {
    if (!result || !map.clientWidth || !needsInitialView) return;
    needsInitialView = false;
    if (saved) {
      const size = Array.isArray(saved.size) && saved.size.every(Number.isFinite) ? saved.size : [map.clientWidth, map.clientHeight];
      view(d3.zoomIdentity.translate(saved.view[0] + (map.clientWidth - size[0]) / 2,
        saved.view[1] + (map.clientHeight - size[1]) / 2).scale(saved.view[2]), false);
      saved = null;
    } else fit(false);
  }
  async function arrange(anchor = null, doFit = false) {
    const request = ++sequence;
    $('#loading').hidden = false;
    $('#error').hidden = true;
    const prior = result?.nodes.find(n => n.id === anchor);
    const old = prior ? transform.apply([prior.x + prior.width / 2, prior.y + prior.height / 2]) : null;
    const graph = GraphLayout.visible(data, collapsed);
    const key = currentMode + ':' + graph.nodes.map(n => n.id).join(',');
    try {
      let next = cache.get(key);
      if (!next) {
        const mode = currentMode === 'auto' ? (GraphLayout.isTree(data) ? 'bilateral' : 'right') : currentMode;
        next = await run(graph, mode);
        cache.set(key, next);
        if (cache.size > 32) cache.delete(cache.keys().next().value);
      }
      if (request !== sequence) return;
      result = next;
      map.dataset.layout = result.kind;
      map.dataset.nodes = String(result.nodes.length);
      map.dataset.edges = String(result.edges.length);
      const allIds = new Set(result.nodes.map(n => n.id));
      for (const [id, el] of nodeElements) if (!allIds.has(id)) { el.remove(); nodeElements.delete(id); }
      for (const n of result.nodes) {
        let el = nodeElements.get(n.id);
        if (!el) {
          el = text('div', '', 'node ' + n.role);
          el.dataset.nodeId = n.id; el.dataset.status = n.status || '';
          el.style.width = n.width + 'px'; el.style.height = n.height + 'px';
          const link = text('a', '', 'node-open');
          link.href = n.href;
          link.setAttribute('aria-label', `${n.title} · ${n.statusLabel || labels.levels[n.level] || ''}`);
          link.title = `${n.title} · ${n.statusLabel || labels.levels[n.level] || ''}`;
          link.append(text('span', '', `node-dot ${n.level}`), text('span', n.lines.join('\n'), 'node-title'));
          if(n.statusLabel)link.append(text('small', n.statusLabel, 'node-review-status'));
          link.addEventListener('click', event => {saveView(); if(onSelect){event.preventDefault(); focused=n.id; highlight(); onSelect(n);}});
          link.addEventListener('pointerenter', () => { hovered = n.id; highlight(); });
          link.addEventListener('pointerleave', () => { hovered = null; highlight(); });
          link.addEventListener('focus', () => { hovered = n.id; highlight(); });
          link.addEventListener('blur', () => { hovered = null; highlight(); });
          el.append(link);
          if(onReject && n.proposal_id){
            const reject=text('button','×','node-reject');reject.type='button';
            reject.addEventListener('pointerdown',event=>event.stopPropagation());
            reject.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const node=byId.get(n.id);if(!node?.canReject||reject.disabled)return;reject.disabled=true;try{await onReject(node);}finally{reject.disabled=!byId.get(n.id)?.canReject;}});
            el.append(reject);
          }
          if (ix.children.get(n.id).length) {
            const toggle = text('button', '', 'branch-toggle');
            toggle.type = 'button';
            toggle.addEventListener('click', () => {
              collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id);
              hovered = null;
              arrange(n.id);
            });
            el.append(toggle);
          }
          $('#nodes').append(el); nodeElements.set(n.id, el);
        }
        syncReject(el, byId.get(n.id));
        el.style.transform = `translate(${n.x}px,${n.y}px)`;
        const toggle = el.querySelector('.branch-toggle');
        if (toggle) {
          const closed = collapsed.has(n.id);
          toggle.textContent = closed ? '+' + ix.children.get(n.id).length : '−';
          toggle.setAttribute('aria-expanded', String(!closed));
          toggle.setAttribute('aria-label', format(closed ? 'expand_branch' : 'collapse_branch', {title: n.title}));
        }
      }
      const groups = d3.select($('#edge-layer')).selectAll('.edge-group').data(result.edges, e => e.id)
        .join(enter => {
          const group = enter.append('g').attr('class', e => `edge-group relation-${e.type}`);
          group.append('title').text(e => `${byId.get(e.source).title} ${e.type === 'related_to' ? '—' : '→'} ${byId.get(e.target).title} · ${labels.relation_labels[e.type] || e.type}`);
          group.append('path').attr('class', 'edge-underlay');
          group.append('path').attr('class', 'edge');
          if(onSelect)group.attr('tabindex',0).attr('role','button').attr('aria-label',e=>`${byId.get(e.source).title} · ${labels.relation_labels[e.type] || e.type} · ${byId.get(e.target).title}`).on('click',(_event,e)=>onSelect(e)).on('keydown',(event,e)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(e);}});
          return group;
        }, update => update, exit => exit.remove());
      // Propagate each new layout to both paths; selectAll does not rebind children.
      groups.select('.edge-underlay');
      groups.select('.edge').attr('data-edge-id', e => e.id).attr('data-relation-type', e => e.type)
        .attr('marker-end', e => e.type === 'related_to' ? null : `url(#map-arrow-${['broader_than','requires','applied_in'].includes(e.type)?e.type:'broader_than'})`);
      groups.selectAll('path').transition().duration(duration).attr('d', e => edgePath(e, result.nodes));
      if (focused && !allIds.has(focused)) focused = null;
      $('#counts').textContent = format('counts', {count: result.nodes.length, total: data.nodes.length,
        edges: result.edges.length});
      for (const item of panel.querySelectorAll('[data-relation-key]')) {
        const count = result.edges.filter(e => e.type === item.dataset.relationKey).length;
        item.querySelector('[data-relation-count]').textContent = count;
        item.classList.toggle('is-empty', count === 0);
      }
      $('#layout-name').textContent = labels[result.kind];
      if (old && !doFit) {
        const n = result.nodes.find(n => n.id === anchor);
        if (n) view(d3.zoomIdentity.translate(old[0] - (n.x + n.width / 2) * transform.k,
          old[1] - (n.y + n.height / 2) * transform.k).scale(transform.k), false);
      }
      $('#graph-fallback').hidden = true;
      renderMini(); highlight();
      if (needsInitialView) applyInitialView();
      else if (doFit) fit();
    } catch (error) {
      if (request !== sequence) return;
      $('#error').hidden = false;
      $('#graph-fallback').hidden = false;
      console.error('Knowledge graph layout failed:', error);
    } finally {
      if (request === sequence) $('#loading').hidden = true;
    }
  }
  async function reveal(id) {
    for (const parent of ancestors(id)) collapsed.delete(parent);
    await arrange();
    focused = id; hovered = null;
    center(id); highlight();
    $('#search-results').hidden = true;
    nodeElements.get(id)?.querySelector('a').focus({preventScroll: true});
  }
  function renderMini() {
    if (!result) return;
    const b = result.bounds;
    $('#minimap').setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
    d3.select($('.mini-nodes')).selectAll('rect').data(result.nodes, n => n.id).join('rect')
      .attr('x', n => n.x).attr('y', n => n.y).attr('width', n => n.width).attr('height', n => n.height);
    updateMini();
  }
  function updateMini() {
    if (!result) return;
    const [x, y] = transform.invert([0, 0]);
    const [r, b] = transform.invert([map.clientWidth, map.clientHeight]);
    d3.select($('.mini-view')).attr('x', x).attr('y', y).attr('width', r - x).attr('height', b - y);
  }
  $('#minimap').addEventListener('click', event => {
    const mini = $('#minimap'), p = mini.createSVGPoint();
    p.x = event.clientX; p.y = event.clientY;
    const q = p.matrixTransform(mini.getScreenCTM().inverse());
    view(d3.zoomIdentity.translate(map.clientWidth / 2 - q.x * transform.k, map.clientHeight / 2 - q.y * transform.k).scale(transform.k));
  });
  const changeZoom = amount => d3.select(map).transition('view').duration(duration).call(zoom.scaleBy, amount);
  $('#zoom-in').addEventListener('click', () => changeZoom(1.25));
  $('#zoom-out').addEventListener('click', () => changeZoom(.8));
  $('#zoom-reset').addEventListener('click', () => d3.select(map).transition('view').duration(duration).call(zoom.scaleTo, 1));
  $('#fit').addEventListener('click', () => fit());
  $('#layout').addEventListener('change', event => { currentMode = event.target.value; arrange(null, true); });
  $('#expand-all').addEventListener('click', () => { collapsed.clear(); arrange(null, true); });
  $('#collapse-all').addEventListener('click', () => {
    for (const n of data.nodes) if (!ix.roots.includes(n.id) && ix.children.get(n.id).length) collapsed.add(n.id);
    arrange(null, true);
  });
  $('#retry-layout').addEventListener('click', () => { startWorker(); arrange(null, true); });
  function updateFullscreen() {
    $('#fullscreen').textContent = labels[document.fullscreenElement || map.classList.contains('is-fullscreen') ? 'fullscreen_exit' : 'fullscreen'];
    requestAnimationFrame(() => fit());
  }
  $('#fullscreen').addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (map.classList.contains('is-fullscreen')) map.classList.remove('is-fullscreen');
    else {
      try { await map.requestFullscreen(); }
      catch { map.classList.add('is-fullscreen'); }
    }
    updateFullscreen(); map.focus({preventScroll: true});
  });
  listen(document, 'fullscreenchange', updateFullscreen);
  $('#fullscreen-entry').addEventListener('click', () => $('#fullscreen').click());
  listen(document, 'keydown', event => {
    if (event.key === 'Escape' && map.classList.contains('is-fullscreen')) {
      map.classList.remove('is-fullscreen'); updateFullscreen(); $('#fullscreen').focus();
    }
  });
  map.addEventListener('click', event => {
    if (event.target === map) { focused = null; hovered = null; highlight(); }
  });
  map.addEventListener('keydown', event => {
    if (event.target !== map) return;
    if (event.key === 'Escape') { focused = null; hovered = null; highlight(); }
    else if (event.key === 'Home') { event.preventDefault(); fit(); }
    else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); changeZoom(event.key === '-' ? .8 : 1.25); }
  });
  $('#search').addEventListener('input', event => {
    const value = event.target.value.trim().toLocaleLowerCase(), box = $('#search-results');
    box.replaceChildren(); matches.clear();
    if (!value) { box.hidden = true; focused = null; highlight(); return; }
    const found = data.nodes.filter(n => [n.title, ...n.aliases].some(s => s.toLocaleLowerCase().includes(value)));
    for (const n of found) matches.add(n.id);
    for (const n of found.slice(0, 8)) {
      const button = text('button', n.title);
      button.type = 'button'; button.addEventListener('click', () => reveal(n.id)); box.append(button);
    }
    if (!found.length) box.append(text('p', labels.no_matches));
    box.hidden = false; highlight();
  });
  $('#search').addEventListener('keydown', event => {
    if (event.key === 'Escape') $('#search-results').hidden = true;
    if (event.key === 'Enter') { event.preventDefault(); $('#search-results button')?.click(); }
  });
  listen(document, 'pointerdown', event => {
    if (!event.target.closest('.search-wrap')) $('#search-results').hidden = true;
  });
  map.hidden = false;
  $('[data-map-controls]').hidden = false;
  $('#fullscreen-entry').hidden = false;
  let lastSize = [map.clientWidth, map.clientHeight];

  const observer = new ResizeObserver(() => {
    const size = [map.clientWidth, map.clientHeight];
    if (!size[0] || !size[1]) return;
    if (result && !needsInitialView && lastSize[0] && lastSize[1]) {
      const dx = (size[0] - lastSize[0]) / 2, dy = (size[1] - lastSize[1]) / 2;
      if (dx || dy) {
        if (document.fullscreenElement === map || map.classList.contains('is-fullscreen')) fit(false);
        else view(d3.zoomIdentity.translate(transform.x + dx, transform.y + dy).scale(transform.k), false);
      }
    }
    lastSize = size; applyInitialView(); updateMini();
  }); observer.observe(map);
  await arrange();
  return {
    reveal,
    updateStatuses(nodes) {for(const node of nodes){const original=byId.get(node.id);if(original)Object.assign(original,node);const el=nodeElements.get(node.id);if(el){syncReject(el,node);el.dataset.status=node.status || '';const label=el.querySelector('.node-review-status');if(label)label.textContent=node.statusLabel || '';}}},
    destroy() {sequence++; lifecycle.abort();observer.disconnect();worker?.terminate();pending.clear();d3.select(map).on('.zoom',null);},
  };
}
