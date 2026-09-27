/* Stable Markdown citation rules, shared with the research workspace. */
(function(root){
  let library = [];
  const get = id => library.find(r => r.id === id);
  const escapedAt = (text, index) => { let n = 0; while (index > 0 && text[--index] === '\\') n++; return n % 2 === 1; };
  function inlineTokens(text, offset = 0) {
    const tokens = []; let index = 0, start = 0;
    const plain = end => { if (end > start) tokens.push({ kind: 'text', text: text.slice(start, end), start: start + offset, end: end + offset }); };
    while (index < text.length) {
      if (text[index] === '`' && !escapedAt(text, index)) {
        const run = text.slice(index).match(/^`+/)[0]; let close = text.indexOf(run, index + run.length);
        while (close >= 0 && (text[close - 1] === '`' || text[close + run.length] === '`')) close = text.indexOf(run, close + run.length);
        if (close >= 0) { plain(index); tokens.push({ kind: 'code', text: text.slice(index + run.length, close), start: index + offset, end: close + run.length + offset }); index = close + run.length; start = index; continue; }
      }
      if (text[index] === '[' && text[index - 1] !== '!' && !escapedAt(text, index)) {
        const match = text.slice(index).match(/^\[((?:\\.|[^\]\\\n])+)\]\(kb:([A-Za-z0-9_-]+)\)/);
        if (match) { plain(index); tokens.push({ kind: 'ref', id: match[2], title: match[1].replace(/\\([\\\[\]])/g, '$1'), text: match[0], start: index + offset, end: index + match[0].length + offset }); index += match[0].length; start = index; continue; }
      }
      index++;
    }
    plain(text.length); return tokens;
  }
  function citations(body) {
    let offset = 0, fence = null, paragraphStart = 0, paragraph = []; const refs = [];
    const flush = () => { if (paragraph.length) refs.push(...inlineTokens(paragraph.join('\n'), paragraphStart).filter(token => token.kind === 'ref')); paragraph = []; };
    for (const line of String(body || '').split('\n')) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker) { flush(); fence = { char: marker[1][0], length: marker[1].length }; }
      else if (!line.trim() || (line.startsWith('$$') && line.endsWith('$$'))) flush();
      else if (/^(?:#{1,6}\s|[-*]\s|> )/.test(line)) { flush(); refs.push(...inlineTokens(line, offset).filter(token => token.kind === 'ref')); }
      else { if (!paragraph.length) paragraphStart = offset; paragraph.push(line); }
      offset += line.length + 1;
    }
    flush();
    return refs;
  }
  function related(record) {
    const items = new Map();
    for (const id of record?.related_refs || []) items.set(id, { id, manual: true, occurrences: [] });
    for (const ref of citations(record?.body)) {
      if (!items.has(ref.id)) items.set(ref.id, { id: ref.id, manual: false, occurrences: [] });
      items.get(ref.id).occurrences.push(ref);
    }
    return [...items.values()].map(ref => ({ ...ref, record: get(ref.id), title: get(ref.id)?.title || ref.occurrences[0]?.title || ref.id }));
  }
  function stripCitations(body) {
    let result = String(body || '');
    for (const ref of citations(result).reverse()) result = result.slice(0, ref.start) + ref.title + result.slice(ref.end);
    return result;
  }
  function makeCitation(id, title = get(id)?.title || id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid reference id');
    return `[${title.replace(/[\\\[\]]/g, '\\$&')}](${`kb:${id}`})`;
  }
  const api = {inlineTokens, citations, related, stripCitations, makeCitation, get, setLibrary(items){library=items;}};
  if(typeof module !== "undefined" && module.exports)module.exports=api;else root.IdeaReferenceRules=api;
})(typeof window !== "undefined" ? window : globalThis);
