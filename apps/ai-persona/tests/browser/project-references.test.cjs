const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../src/ai_persona/static/projects/references.js');

const catalog = [
  {id:'ps_0123456789abcdef_00000000000000000000000000000001',kind:'knowledge',title:'近守恒量',aliases:['quasi-conserved']},
  {id:'ps_0123456789abcdef_00000000000000000000000000000002',kind:'knowledge',title:'有限尺寸效应'},
  {id:'ps_0123456789abcdef_00000000000000000000000000000003',kind:'knowledge',title:'微扰展开'},
  {id:'ps_0123456789abcdef_00000000000000000000000000000004',kind:'material',title:'阅读笔记',aliases:['MPS']},
  {id:'ps_0123456789abcdef_00000000000000000000000000000005',kind:'knowledge',title:'旧笔记',archived:true},
];
const {beforeEach} = require('node:test');
beforeEach(()=>R.setLiveLibrary(catalog));

test('manual association and repeated inline citations form one relationship', () => {
  const body = `${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000001')} 与 ${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000001', '慢变量')}`;
  const refs = R.related({ body, related_refs: ['ps_0123456789abcdef_00000000000000000000000000000001', 'ps_0123456789abcdef_00000000000000000000000000000001'] });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].manual, true);
  assert.equal(refs[0].occurrences.length, 2);
  assert.equal(R.related({ body, related_refs: [] })[0].manual, false);
  assert.equal(R.related({ body: '', related_refs: ['ps_0123456789abcdef_00000000000000000000000000000001'] }).length, 1);
  assert.equal(R.related({ body: '', related_refs: [] }).length, 0);
});

test('code examples, escaped Markdown and images do not create relationships', () => {
  const citation = R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000002');
  const body = `\`${citation}\`\n\n\`\`\`md\n${citation}\n\`\`\`\n\n~~~\n${citation}\n~~~\n\n\\${citation}\n\n!${citation}\n\n${citation}`;
  assert.equal(R.citations(body).length, 1);
  assert.equal(body.slice(R.citations(body)[0].start, R.citations(body)[0].end), citation);
  assert.equal(R.citations(`\`line one\n${citation}\``).length, 0);
  assert.equal(R.citations(`\`\`\`\n${citation}`).length, 0);
});

test('references in headings, lists and paragraphs retain exact selection offsets', () => {
  const body = `# ${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000002')}\n\n- ${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000001')}\n> ${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000004')}\n\n说明：${R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000003')}`;
  assert.deepEqual(R.citations(body).map(ref => ref.id), ['ps_0123456789abcdef_00000000000000000000000000000002', 'ps_0123456789abcdef_00000000000000000000000000000001', 'ps_0123456789abcdef_00000000000000000000000000000004', 'ps_0123456789abcdef_00000000000000000000000000000003']);
  for (const ref of R.citations(body)) assert.equal(body.slice(ref.start, ref.end), ref.text);
});

test('labels can change or contain punctuation without changing target identity', () => {
  const label = '自定义 [名称] 与 \\ 符号 <b>文本</b>';
  const body = R.makeCitation('ps_0123456789abcdef_00000000000000000000000000000001', label);
  assert.equal(R.citations(body)[0].title, label);
  assert.equal(R.related({ body })[0].title, '近守恒量');
  assert.equal(R.stripCitations(body), label);
  assert.throws(() => R.makeCitation('bad\" onclick=bad'));
});

test('idea references aggregate for viewing without becoming project associations', () => {
  const project = { id: 'p', title: '项目', related_refs: [], body: '' };
  const idea = { id: 'i', title: '想法', project: 'p', related_refs: ['ps_0123456789abcdef_00000000000000000000000000000002'], body: '' };
  const db = { projects: [project], ideas: [idea] };
  assert.equal(R.matches(project, 'ps_0123456789abcdef_00000000000000000000000000000002'), false);
  assert.equal(R.descendants(db, 'p')[0].ideas[0].id, 'i');
  assert.deepEqual(R.backlinks(db, 'ps_0123456789abcdef_00000000000000000000000000000002').map(link => link.type), ['ideas']);
  project.archived = true;
  assert.equal(R.backlinks(db, 'ps_0123456789abcdef_00000000000000000000000000000002').length, 0);
});

test('archived and unavailable targets keep existing references', () => {
  assert.equal(R.related({ related_refs: ['ps_0123456789abcdef_00000000000000000000000000000005'] })[0].record.archived, true);
  assert.equal(R.search('旧笔记').length, 0);
  assert.equal(R.search('旧笔记', 'all', true).length, 1);
  assert.equal(R.related({ body: '[以前的条目](kb:missing_record)' })[0].title, '以前的条目');
  assert.equal(R.related({ related_refs: ['missing_record'] }).length, 1);
});

test('search recognizes existing aliases and separates materials from knowledge', () => {
  assert.ok(R.search('quasi-conserved').some(item => item.id === 'ps_0123456789abcdef_00000000000000000000000000000001'));
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
  assert.equal(R.get('ps_0123456789abcdef_00000000000000000000000000000001'), undefined);
  assert.equal(R.citations(R.makeCitation(id))[0].id, id);
  R.setLiveDetail({ ...item, title: '已重命名', body: '真实条目正文' });
  assert.equal(R.related({ related_refs: [id] })[0].title, '已重命名');
  assert.equal(R.get(id).body, '真实条目正文');
  R.setLiveLibrary([]);
  assert.equal(R.search('').length, 0);
  assert.equal(R.get(id), undefined);
  assert.equal(R.related({ related_refs: [id] }).length, 1);
  assert.equal(R.related({body:'[旧名称](kb:ps_0123456789abcdef_00000000000000000000000000000001)'})[0].title, '旧名称');
});
