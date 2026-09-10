import test from 'node:test';
import assert from 'node:assert/strict';
import {changedFields, fieldInput, LearningReviewPanel} from '../src/ai_persona/static/learning-review.mjs';

test('partial edits retain untouched properties, including explicit clears and null', () => {
  const original = {title:'Knowledge', aliases:['A'], tags:['tag'], scope_note:'scope', body:'notes', interest_level:'unspecified'};
  assert.deepEqual(changedFields(original, {title:'Corrected'}), {title:'Corrected'});
  assert.deepEqual(changedFields(original, {aliases:[], scope_note:null, body:'', tags:['tag']}), {aliases:[], scope_note:null, body:''});
  assert.deepEqual(original.aliases, ['A']);
});

test('field types come from the server, not hand-written entity field sets', () => {
  assert.deepEqual(fieldInput({kind:'lines'}, ' A\r\n\nB '), ['A', 'B']);
  assert.equal(fieldInput({kind:'select', nullable:true}, ''), null);
  assert.equal(fieldInput({kind:'textarea'}, ''), '');
  assert.deepEqual(fieldInput({kind:'json'}, '{"intents":[]}'), {intents:[]});
  assert.throws(() => fieldInput({kind:'json'}, '{'));
});

test('drafts survive task switching; empty edit sessions are not unsaved changes', () => {
  const panel = new LearningReviewPanel({});
  panel.drafts.set('a', {updates:{}}); assert.equal(panel.hasDrafts(), false);
  panel.drafts.get('a').updates = {title:'Changed'};
  panel.drafts.set('b', {updates:{}}); assert.equal(panel.hasDrafts(), true);
  panel.drafts.delete('a'); assert.equal(panel.hasDrafts(), false);
  panel.drafts.get('b').invalid = true; assert.equal(panel.hasDrafts(), true);
});

test('late candidate reads cannot replace another selected task', async () => {
  const pending = [], rendered = [];
  const panel = new LearningReviewPanel({api: () => new Promise(resolve => pending.push(resolve))});
  panel.render = (id, _, value) => rendered.push([id, value]);
  const container = {isConnected:true};
  const old = panel.load('old', container), latest = panel.load('new', container);
  pending[1]({proposals:['new']}); await latest;
  pending[0]({proposals:['old']}); await old;
  assert.deepEqual(rendered, [['new', {proposals:['new']}]]);
});

test('review write carries the displayed revision and never creates trigger feedback', async () => {
  const requests = [], panel = new LearningReviewPanel({api: async (url, body) => {requests.push({url,body}); return {};}, notice:()=>{}, refresh:async()=>{}});
  panel.render = () => {};
  panel.drafts.set('p', {revision:7, updates:{title:'Corrected'}});
  const card = {value:{id:'p', revision:7}, eventId:'learn_a', root:{querySelectorAll:()=>[]}, message:{}, container:{}};
  await panel.decide(card, 'accept');
  assert.deepEqual(requests, [{url:'events/learn_a/review/p', body:{action:'accept', revision:7, updates:{title:'Corrected'}}}]);
  assert.equal(panel.drafts.has('p'), false);
});

test('an old poll cannot reopen an already reviewed candidate', () => {
  const panel = new LearningReviewPanel({});
  const root = {}, container = {children:[root]};
  panel.cards.set('p', {root, value:{id:'p',revision:2,status:'accepted'}});
  panel.paint = () => assert.fail('an older proposal must not be painted');
  panel.render('event', container, {references:{},proposals:[{id:'p',revision:1,status:'pending_review'}]});
  assert.equal(panel.cards.get('p').value.status, 'accepted');
});
