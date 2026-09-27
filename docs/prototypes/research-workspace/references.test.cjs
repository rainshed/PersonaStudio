const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./references.js');

test('manual association and repeated inline citations form one relationship', () => {
  const body = `${R.makeCitation('kn_quasi')} 与 ${R.makeCitation('kn_quasi', '慢变量')}`;
  const refs = R.related({ body, related_refs: ['kn_quasi', 'kn_quasi'] });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].manual, true);
  assert.equal(refs[0].occurrences.length, 2);
  assert.equal(R.related({ body, related_refs: [] })[0].manual, false);
  assert.equal(R.related({ body: '', related_refs: ['kn_quasi'] }).length, 1);
  assert.equal(R.related({ body: '', related_refs: [] }).length, 0);
});

test('code examples, escaped Markdown and images do not create relationships', () => {
  const citation = R.makeCitation('kn_size');
  const body = `\`${citation}\`\n\n\`\`\`md\n${citation}\n\`\`\`\n\n~~~\n${citation}\n~~~\n\n\\${citation}\n\n!${citation}\n\n${citation}`;
  assert.equal(R.citations(body).length, 1);
  assert.equal(body.slice(R.citations(body)[0].start, R.citations(body)[0].end), citation);
  assert.equal(R.citations(`\`line one\n${citation}\``).length, 0);
  assert.equal(R.citations(`\`\`\`\n${citation}`).length, 0);
});

test('references in headings, lists and paragraphs retain exact selection offsets', () => {
  const body = `# ${R.makeCitation('kn_size')}\n\n- ${R.makeCitation('kn_quasi')}\n> ${R.makeCitation('mat_noneq')}\n\n说明：${R.makeCitation('kn_perturb')}`;
  assert.deepEqual(R.citations(body).map(ref => ref.id), ['kn_size', 'kn_quasi', 'mat_noneq', 'kn_perturb']);
  for (const ref of R.citations(body)) assert.equal(body.slice(ref.start, ref.end), ref.text);
});

test('labels can change or contain punctuation without changing target identity', () => {
  const label = '自定义 [名称] 与 \\ 符号 <b>文本</b>';
  const body = R.makeCitation('kn_quasi', label);
  assert.equal(R.citations(body)[0].title, label);
  assert.equal(R.related({ body })[0].title, '近守恒量');
  assert.equal(R.stripCitations(body), label);
  assert.throws(() => R.makeCitation('bad\" onclick=bad'));
});

test('idea references aggregate for viewing without becoming project associations', () => {
  const project = { id: 'p', title: '项目', related_refs: [], body: '' };
  const idea = { id: 'i', title: '想法', project: 'p', related_refs: ['kn_size'], body: '' };
  const db = { projects: [project], ideas: [idea] };
  assert.equal(R.matches(project, 'kn_size'), false);
  assert.equal(R.descendants(db, 'p')[0].ideas[0].id, 'i');
  assert.deepEqual(R.backlinks(db, 'kn_size').map(link => link.type), ['ideas']);
  project.archived = true;
  assert.equal(R.backlinks(db, 'kn_size').length, 0);
});

test('archived and unavailable targets keep existing references', () => {
  assert.equal(R.related({ related_refs: ['kn_old_boundary'] })[0].record.archived, true);
  assert.equal(R.search('旧笔记').length, 0);
  assert.equal(R.search('旧笔记', 'all', true).length, 1);
  assert.equal(R.related({ body: '[以前的条目](kb:missing_record)' })[0].title, '以前的条目');
  assert.equal(R.related({ related_refs: ['missing_record'] }).length, 1);
});

test('search recognizes existing aliases and separates materials from knowledge', () => {
  assert.ok(R.search('quasi-conserved').some(item => item.id === 'kn_quasi'));
  assert.ok(R.search('MPS', 'material').every(item => item.kind === 'material'));
  assert.ok(R.search('不存在的关键词').length === 0);
});

test('live catalog replaces search without relabeling legacy references', () => {
  const id = 'ps_0123456789abcdef_0123456789abcdef0123456789abcdef';
  const item = { id, kind: 'knowledge', title: '正式条目', aliases: ['actual concept'], tags: ['方法'], summary: '正式摘要', source: 'live' };
  R.setLiveLibrary([item]);
  assert.deepEqual(R.search('').map(x => x.id), [id]);
  assert.equal(R.search('方法')[0].id, id);
  assert.equal(R.search('近守恒量').length, 0);
  assert.equal(R.get('kn_quasi').source, 'demo');
  assert.equal(R.citations(R.makeCitation(id))[0].id, id);
  R.setLiveDetail({ ...item, title: '已重命名', body: '真实条目正文' });
  assert.equal(R.related({ related_refs: [id] })[0].title, '已重命名');
  assert.equal(R.get(id).body, '真实条目正文');
  R.setLiveLibrary([]);
  assert.equal(R.search('').length, 0);
  assert.equal(R.get(id), undefined);
  assert.equal(R.related({ related_refs: [id] }).length, 1);
  assert.equal(R.get('kn_quasi').title, '近守恒量');
});
