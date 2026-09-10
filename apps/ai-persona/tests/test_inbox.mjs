import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {feedbackText, reviewText, InboxListState, InboxWorkspace, safeReturnPath} from '../src/ai_persona/static/inbox.mjs';
import {LearningReviewPanel} from '../src/ai_persona/static/learning-review.mjs';

test('review-only results never acquire an unrated label', () => {
  assert.equal(feedbackText({supported:false, state:'not_applicable'}), '');
  assert.equal(feedbackText({supported:true, state:'waiting', total:0}), '暂无可评价判断');
  assert.equal(feedbackText({supported:true, state:'unavailable', total:0}), '反馈状态暂不可用');
  assert.equal(feedbackText({supported:true, total:2, rated:1, has_unsatisfied:true}), '已反馈 1／2 · 含不满意');
  assert.equal(reviewText({total:3, pending:0, statuses:{rejected:3}}), '审核完成 · 已通过 0 条 · 已拒绝 3 条');
  assert.equal(reviewText({total:0}), '');
});

test('list polling retains selected membership and accepts filter-exit rows', () => {
  const state = new InboxListState();
  const row = (id, revision) => ({id, result_id:'result_' + id, feedback:{revision}});
  state.apply({items:[row('a',0),row('b',0)]}, true);
  state.apply({items:[row('new',0),row('b',0)],updates:[{...row('a',2),matches:false}]}, false);
  assert.deepEqual(state.ids, ['a','b']); assert.equal(state.items.get('a').matches, false);
  state.apply({items:[row('a',1)]}, false);
  assert.equal(state.items.get('a').feedback.revision,2);
});

test('shared review routes to an exact inbox item without inferring satisfaction', async () => {
  const requests = [];
  const panel = new LearningReviewPanel({api:async (path, body) => {requests.push({path,body}); return {};}, notice:()=>{}, refresh:async()=>{}, reviewPath:id=>'items/'+encodeURIComponent(id)+'/review'});
  panel.render = () => {};
  await panel.decide({value:{id:'prop_a',revision:4}, eventId:'assistant:ai_material', root:{querySelectorAll:()=>[]}, message:{}, container:{}}, 'defer');
  assert.deepEqual(requests,[{path:'items/assistant%3Aai_material/review/prop_a',body:{action:'defer',revision:4,updates:{}}}]);
});

test('workspace template and controller agree; no bottom-of-page jump or HTML injection', () => {
  const html = readFileSync(new URL('../src/ai_persona/templates/inbox.html',import.meta.url),'utf8');
  const js = readFileSync(new URL('../src/ai_persona/static/inbox.mjs',import.meta.url),'utf8');
  for (const [,id] of js.matchAll(/this\.\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="inbox-${id}"`),id);
  assert.ok(!js.includes('scrollIntoView') && !js.includes('innerHTML'));
  assert.ok(js.includes('feedback.supported') && js.includes('view-help'));
});

test('return links cannot leave the local origin, including backslash URLs', () => {
  const origin = 'http://127.0.0.1:8765';
  for (const value of ['//example.com', '/\\example.com', 'https://example.com', null]) assert.equal(safeReturnPath(value, origin), null);
  assert.equal(safeReturnPath('/evaluations?case=case_test', origin), '/evaluations?case=case_test');
});

test('returning to an unselected history entry clears detail but does not discard edit drafts', () => {
  const nodes = {title:{},meta:{},detail:{replaceChildren(...children){this.children=children;}},root:{querySelector(){return workspace;}}};
  const workspace = {dataset:{detailOpen:'true'}}, destroyed = [];
  const state = {parts:{feedbackContainers:['view']},selected:'learning:a',detailSequence:1,candidates:{drafts:new Map([['prop_a','draft']])},feedback:{destroy:c=>destroyed.push(c)},$:id=>nodes[id],node:(_tag,text)=>({text})};
  InboxWorkspace.prototype.clearDetail.call(state);
  assert.equal(state.selected,null); assert.equal(state.parts,null); assert.equal(state.detailSequence,2);
  assert.equal(workspace.dataset.detailOpen,'false'); assert.deepEqual(destroyed,['view']);
  assert.equal(state.candidates.drafts.get('prop_a'),'draft');
});
