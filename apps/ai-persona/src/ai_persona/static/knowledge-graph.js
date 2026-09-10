import {mountKnowledgeGraph} from './knowledge-graph-view.mjs?v=20260911.review2';
(async()=>{
  const panel=document.querySelector('[data-knowledge-graph]');if(!panel)return;
  const tabs = [...document.querySelectorAll('[data-knowledge-view]')];
  let onShown = () => {};
  function setView(id, updateUrl = true) {
    tabs.forEach(tab => {
      const active = tab.dataset.knowledgeView === id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', tab.dataset.knowledgeView);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const section = document.getElementById(tab.dataset.knowledgeView);
      section.hidden = !active;
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', tab.id);
    });
    if (updateUrl) history.replaceState(history.state, '', `#${id}`);
    if (id === 'graph') requestAnimationFrame(onShown);
  }
  document.querySelector('[data-view-tabs]').setAttribute('role', 'tablist');
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', event => { event.preventDefault(); setView(tab.dataset.knowledgeView); });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(i + 1) % tabs.length];
      setView(target.dataset.knowledgeView);
      target.focus();
    });
  });
  const initialView = () => location.hash === '#knowledge-list' || (!location.hash &&
    ['q', 'knowledge_level', 'tag_id'].some(key => new URLSearchParams(location.search).get(key))) ? 'knowledge-list' : 'graph';
  window.addEventListener('hashchange', () => setView(initialView(), false));
  setView(initialView(), false);

  await mountKnowledgeGraph(panel, JSON.parse(document.querySelector('[data-graph-data]').textContent), JSON.parse(document.querySelector('[data-graph-labels]').textContent));
})().catch(console.error);
