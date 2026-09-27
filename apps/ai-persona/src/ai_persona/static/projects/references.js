/* Project catalog adapter. Markdown parsing is shared with native Ideas. */
(function(root){
  'use strict';
  const shared = typeof module !== 'undefined' && module.exports ? require('../idea-reference-rules.js') : root.IdeaReferenceRules;
  const rules = shared.createLibrary();
  const {get, inlineTokens, citations, related, makeCitation, stripCitations} = rules;
  let liveLibrary = [];
  function liveItem(item) {
    if (!item || !/^ps_[a-f0-9]{16}_[a-f0-9]{32}$/.test(item.id) || !['knowledge','material'].includes(item.kind) || typeof item.title !== 'string') throw new Error('Invalid library item');
    let detailUrl = '';
    try { const url = new URL(item.detail_url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) detailUrl = url.href; } catch {}
    return { ...item, source: 'live', archived: item.archived === true, aliases: Array.isArray(item.aliases) ? item.aliases : [], tags: Array.isArray(item.tags) ? item.tags : [], summary: String(item.summary || ''), path: String(item.path || ''), body: String(item.body || ''), detail_url: detailUrl };
  }
  function setLiveLibrary(items) {
    const next = items.map(liveItem);
    if (new Set(next.map(item => item.id)).size !== next.length) throw new Error('Duplicate library IDs');
    liveLibrary = next;
    rules.setLibrary(next);
  }
  function setLiveDetail(item) {
    const next = liveItem(item);
    const index = liveLibrary.findIndex(record => record.id === next.id);
    if (index < 0) liveLibrary.push(next); else liveLibrary[index] = next;
  }
  function matches(record, id) { return !id || related(record).some(ref => ref.id === id); }
  function backlinks(db, id) {
    return ['projects', 'ideas'].flatMap(type => db[type].filter(record => !record.archived && (type !== 'ideas' || !record.project || !db.projects.find(p => p.id === record.project)?.archived)).flatMap(record => {
      const ref = related(record).find(item => item.id === id);
      return ref ? [{ type, record, ref }] : [];
    }));
  }
  function descendants(db, project) {
    const items = new Map();
    for (const idea of db.ideas.filter(item => item.project === project && !item.archived)) for (const ref of related(idea)) {
      if (!items.has(ref.id)) items.set(ref.id, { ...ref, ideas: [] });
      items.get(ref.id).ideas.push(idea);
    }
    return [...items.values()];
  }
  function search(query, kind = 'all', includeArchived = false) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return liveLibrary.filter(item => (includeArchived || !item.archived) && (kind === 'all' || item.kind === kind) && words.every(word => [item.title, item.path, item.summary, ...item.aliases, ...(item.tags || [])].join(' ').toLocaleLowerCase().includes(word)));
  }
  const api = {get, inlineTokens, citations, related, makeCitation, stripCitations, matches, backlinks, descendants, search, setLiveLibrary, setLiveDetail};
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ResearchReferences = api;
})(typeof window !== 'undefined' ? window : globalThis);
