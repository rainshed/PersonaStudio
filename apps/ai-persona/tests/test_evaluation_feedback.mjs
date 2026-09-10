import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// DOM contract stub, not a browser or the user's real UI.
class Element {
  constructor(tag) {this.tag = tag; this.children = []; this.events = {}; this.attributes = {}; this.dataset = {}; this.classList = {add() {}, toggle() {}};}
  append(...items) {this.children.push(...items);}
  get options(){return this.children.filter(c=>c.tag==='option');}
  focus(){}
  closest(){return this.parentLabel??=new Element('label');}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  replaceChildren(...items) {this.children = [...items];}
  addEventListener(name, callback) {this.events[name] = callback;}
  setAttribute(name, value) {this.attributes[name] = value;}
  querySelectorAll(selector) {return this.children.flatMap(child => [...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector)]);}
}
const script = readFileSync(new URL('../src/ai_persona/static/evaluation-feedback.js', import.meta.url), 'utf8');

function fixture() {
  const result = {id: 'result_test', case_id: null, decisions: [
    {subject: {kind: 'activation_context', context_key: 'note'}, triggered: false, name: '写作'},
    {subject: {kind: 'activation_context', context_key: 'draw'}, triggered: true, name: '绘图'},
    {subject: {kind: 'activation_context', context_key: 'waiting'}, triggered: null, name: '待判定'},
  ], feedback: {revision: 0, subjects: {}}};
  const requests = [];
  let fail = false, failRead = false, hold = null;
  const context = vm.createContext({
    window: {}, document: {createElement: tag => new Element(tag)}, crypto: {randomUUID: () => 'explicit-click'},
    fetch: async (path, options) => {
      requests.push({path, options});
      if (options.method === 'POST') {
        if (hold) await hold;
        if (fail) return {ok: false, json: async () => ({message: '反馈已更新，请刷新后重试。'})};
        const raw = JSON.parse(options.body);
        const previous = result.feedback.subjects[raw.subject.context_key];
        const feedback = {subject: {context_key: raw.subject.context_key, kind: raw.subject.kind}, rating: raw.rating || previous.rating, reason: raw.reason, active: !path.endsWith('/withdraw')};
        result.feedback.subjects[raw.subject.context_key] = feedback;
        result.case_id = 'case_result_test'; result.feedback.revision++;
        return {ok: true, json: async () => structuredClone({case_id: result.case_id, feedback: result.feedback})};
      }
      if (failRead) throw new Error('network unavailable');
      return {ok: true, json: async () => structuredClone(result)};
    },
  });
  vm.runInContext(script, context);
  return {result, requests, fail: () => {fail = true;}, failRead: value => {failRead = value;}, hold: value => {hold = value;}, ...context.window.EvaluationFeedback, container: new Element('div')};
}

test('render does not create cases; only decided subjects get two rating buttons', async () => {
  const f = fixture(); await f.render(f.container, f.result.id);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.method, 'GET');
  assert.equal(f.container.querySelectorAll('button').length, 4);
  assert.equal(f.container.querySelectorAll('textarea').length, 0);
});

test('matched and unmatched views share one result but never rate hidden scenes', async () => {
  const f = fixture(), negative = new Element('div');
  await f.render(f.container, f.result.id, null, {decisionScope:'matched'});
  await f.render(negative, f.result.id, null, {decisionScope:'unmatched'});
  assert.equal(f.container.querySelectorAll('button').length,2);
  assert.equal(negative.querySelectorAll('button').length,2);
  await negative.querySelectorAll('button')[1].events.click();
  assert.deepEqual(Object.keys(f.result.feedback.subjects),['note']);
  assert.equal(f.container.querySelectorAll('button').length,2);
  assert.ok(f.container.querySelectorAll('button').every(b => b.attributes['aria-pressed'] === 'false'));
  assert.equal(negative.querySelectorAll('button')[1].attributes['aria-pressed'],'true');
});

test('negative original result can be rated; key ordering does not lose selected feedback', async () => {
  const f = fixture(); await f.render(f.container, f.result.id);
  await f.container.querySelectorAll('button')[1].events.click();
  const submitted = JSON.parse(f.requests.find(r => r.options.method === 'POST').options.body);
  assert.equal(submitted.subject.context_key, 'note');
  assert.equal(submitted.rating, 'unsatisfied');
  assert.equal(submitted.expected_feedback_revision, 0);
  assert.equal(f.container.querySelectorAll('button')[1].attributes['aria-pressed'], 'true');
  assert.equal(f.container.querySelectorAll('textarea').length, 1);
  assert.equal(f.container.querySelectorAll('label')[0].querySelectorAll('button').length, 0, 'save action must not pollute the reason accessible name');
  // The other trigger has not been automatically rated.
  assert.deepEqual(Object.keys(f.result.feedback.subjects), ['note']);
});

test('reason is a separate optional update and does not submit a new trigger label', async () => {
  const f = fixture(); await f.render(f.container, f.result.id);
  await f.container.querySelectorAll('button')[1].events.click();
  f.container.querySelectorAll('textarea')[0].value = '只用于修改提示词';
  await f.container.querySelectorAll('button').find(b => b.textContent === '保存理由').events.click();
  const update = f.requests.filter(r => r.options.method === 'POST').at(-1);
  assert.match(update.path, /cases\/case_result_test\/reason$/);
  assert.deepEqual(Object.keys(JSON.parse(update.options.body)).sort(), ['expected_feedback_revision', 'reason', 'subject']);
  assert.equal(JSON.parse(update.options.body).reason, '只用于修改提示词');
});

test('failed persistence reports conflict and permits retry, without displaying saved state', async () => {
  const f = fixture(); await f.render(f.container, f.result.id); f.fail();
  await f.container.querySelectorAll('button')[0].events.click();
  assert.equal(f.result.feedback.revision, 0);
  assert.ok(f.container.querySelectorAll('button').every(b => !b.disabled));
  assert.ok(f.container.querySelectorAll('p').some(p => p.textContent.includes('反馈已更新')));
});

test('row and drawer share drafts, keep controls during polling, and cancel only one subject', async () => {
  const f = fixture(), drawer = new Element('div'), stale = structuredClone(f.result);
  await f.render(f.container, f.result.id);
  await f.container.querySelectorAll('button')[1].events.click();
  await f.render(drawer, f.result.id);
  const text = drawer.querySelectorAll('textarea')[0]; text.value = '尚未保存的理由'; text.events.input();
  assert.equal(f.container.querySelectorAll('textarea')[0].value, text.value);
  assert.ok(f.container.querySelectorAll('small').some(e => e.textContent === '理由尚未保存'));
  assert.equal(f.hasDrafts(), true);
  await f.render(drawer, f.result.id);
  assert.equal(drawer.querySelectorAll('textarea')[0], text, 'polling must preserve focus/textarea identity');
  await f.render(f.container, f.result.id, null, {value: stale});
  assert.equal(f.container.querySelectorAll('textarea')[0].value, text.value, 'old revision must not overwrite the new rating');
  const writes = f.requests.filter(r => r.options.method === 'POST').length;
  await drawer.querySelectorAll('button')[1].events.click();
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, writes, 'selected rating is a no-op');
  await drawer.querySelectorAll('button').find(b => b.textContent === '取消反馈').events.click();
  assert.equal(f.result.feedback.subjects.note.active, false);
  assert.equal(f.result.feedback.subjects.draw, undefined);
  assert.equal(f.hasDrafts(), false);
  assert.equal(f.container.querySelectorAll('textarea').length, 0);
  assert.equal(f.container.querySelectorAll('button')[1].attributes['aria-pressed'], 'false');
  await f.container.querySelectorAll('button')[0].events.click();
  assert.equal(f.result.case_id, 'case_result_test', 're-rating reuses the same case');
});

test('uncertain persistence blocks writes until a read recovers the canonical state', async () => {
  const f = fixture(); await f.render(f.container, f.result.id);
  f.fail(); f.failRead(true);
  await f.container.querySelectorAll('button')[0].events.click();
  assert.ok(f.container.querySelectorAll('button').filter(b => b.textContent !== '重试读取').every(b => b.disabled));
  f.failRead(false);
  await f.container.querySelectorAll('button').find(b => b.textContent === '重试读取').events.click();
  assert.ok(f.container.querySelectorAll('button').every(b => !b.disabled));
  assert.equal(f.result.feedback.revision, 0);
});

test('pending saves are shared and cannot submit twice from separate views', async () => {
  const f = fixture(), drawer = new Element('div');
  await f.render(f.container, f.result.id); await f.render(drawer, f.result.id);
  let release; f.hold(new Promise(resolve => {release = resolve;}));
  const save = f.container.querySelectorAll('button')[0].events.click();
  assert.ok(drawer.querySelectorAll('button').every(b => b.disabled));
  await drawer.querySelectorAll('button')[0].events.click();
  release(); await save;
  assert.equal(f.requests.filter(r => r.options.method === 'POST').length, 1);
  assert.equal(drawer.querySelectorAll('button')[0].attributes['aria-pressed'], 'true');
});

test('external feedback updates clear a stale local cancellation notice', async () => {
  const f = fixture(); await f.render(f.container, f.result.id);
  await f.container.querySelectorAll('button')[0].events.click();
  await f.container.querySelectorAll('button').find(b => b.textContent === '取消反馈').events.click();
  f.result.feedback.subjects.note.active = true; f.result.feedback.revision++;
  await f.render(f.container, f.result.id);
  assert.equal(f.container.querySelectorAll('button')[0].attributes['aria-pressed'], 'true');
  assert.ok(!f.container.querySelectorAll('p').some(p => p.textContent.includes('已取消反馈')));
});

test('benchmark management template and JS agree on every required element ID', () => {
  const html = readFileSync(new URL('../src/ai_persona/templates/evaluations.html', import.meta.url), 'utf8');
  const manager = readFileSync(new URL('../src/ai_persona/static/evaluations.js', import.meta.url), 'utf8');
  for (const match of manager.matchAll(/el\('([a-z-]+)'\)/g)) assert.ok(html.includes(`id="evaluation-${match[1]}"`), match[1]);
  assert.ok(!manager.includes('innerHTML'));
});

async function managerFixture(intercept = () => undefined) {
  const html = readFileSync(new URL('../src/ai_persona/templates/evaluations.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="evaluation-([a-z0-9-]+)"/g)].map(m => [m[1], new Element('div')]));
  elements.capability.value = 'persona.conversation_learning';
  for(const n of [1,2,3])elements['step-'+n].append(new Element('h2'));
  elements.repeat.value='5';elements['max-calls'].value='100';elements['max-tokens'].value='200000';elements.timeout.value='900';
  const radios=[new Element('input'),new Element('input'),new Element('input')];radios[0].value='current';radios[0].checked=true;radios[1].value='compare';radios[2].value='automatic';elements['max-rounds'].value='3';
  const modelConfig={capabilities:{evaluationReasoning:1},providers:[{id:'mock',models:[{id:'mock',reasoningLevels:['low','high']}]}],settings:{connections:[{id:'mock',modelId:'mock',providerId:'mock',revision:'1'}]}};
  const selection={name:'Mock',provider_id:'mock',selection:{modelId:'mock',connectionId:'mock',revision:'1'}};
  const learning = {case_id: 'learning', status: 'active', trigger_labels: [], content_gold: [], replay_capabilities:['learning_trigger'], created_at: '2026-09-08', input_preview: '学习', benchmark_revision: 1};
  const activation = {...learning, case_id: 'activation', input_preview: '偏好', replay_capabilities:['activation']};
  const runs = [
    {id: 'learning-run', capability_id: 'persona.conversation_learning', created_at: '2026-09-08', status: 'completed', mode: 'learning_pipeline', results: [
      {case_id: 'learning', variant: 'A', status: 'succeeded', score: {content: {semantic_status: 'pending_review', reference_count: 1}}},
    ]},
    {id: 'activation-run', capability_id: 'persona.activation', created_at: '2026-09-07', status: 'completed', results: []},
  ];
  const requests = [];
  const api = async (path, data) => {
    requests.push({path, data});
    const response=intercept(path,data);if(response!==undefined)return response;
    if (path === 'capabilities') return {capabilities: [
      {id: 'persona.conversation_learning', modes: ['learning_trigger'], prompts: []},
      {id: 'persona.activation', modes: ['activation'], prompts: []},
    ]};
    if(path==='models')return modelConfig;
    if(path.startsWith('selection?'))return selection;
    if(path==='preview')return {fingerprint:'frozen',cases:data.cases,repeat_count:data.repeat_count,planned_replays:data.cases.length*data.variants.length*data.repeat_count,maximum_calls:10,budget:{max_calls:100,max_tokens:200000,timeout_seconds:900},coverage:{should_trigger:1,should_not_trigger:0},variants:data.variants.map(v=>({...v,selection:selection.selection,prompt_versions:{learning:{}}}))};
    if (path === 'prompts') return {items: []};
    if (path.startsWith('cases?')) return {items: path.includes('conversation_learning') ? [learning] : [activation]};
    if (path === 'suites') return {items: [
      {name: '学习测试集', cases: [{case_id: 'learning'}]},
      {name: '偏好测试集', cases: [{case_id: 'activation'}]},
    ]};
    if (path === 'runs') return {items: structuredClone(runs)};
    if (path.endsWith('/review')) {runs[0].results[0].score.content.semantic_status = data.judgment; return {};}
    if (path.startsWith('runs/')) return structuredClone(runs.find(r => r.id === path.split('/')[1]));
    throw new Error('Unexpected request: ' + path);
  };
  const node = (tag, text, cls = '') => {const e = new Element(tag); e.textContent = text; e.className = cls; return e;};
  const context = vm.createContext({
    window: {EvaluationFeedback: {api, node}, addEventListener() {}},
    document: {getElementById: id => elements[id.replace('evaluation-', '')],querySelectorAll:selector=>selector.startsWith('form[')?[]:radios,querySelector:selector=>radios.find(r=>selector.includes('value='+r.value))||radios.findLast(r=>r.checked)},
    crypto:{randomUUID:()=> 'test-check-id'},
    location: {search: '',href:'http://localhost/evaluations'}, history:{replaceState(){},pushState(){}}, URLSearchParams, setTimeout, clearTimeout,
  });
  vm.runInContext(readFileSync(new URL('../src/ai_persona/static/evaluations.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return {elements, requests, radios};
}

test('switching capability clears stale detail/report and filters saved runs and suites', async () => {
  const {elements: e, requests} = await managerFixture();
  assert.equal(e.runs.children.length, 1);
  assert.equal(e.suites.children[0].textContent, '学习测试集 · 1 条');
  await e.runs.children[0].events.click();
  assert.ok(e.report.children.length > 0);
  e.detail.append(new Element('section')); e.consent.checked = true;
  e.capability.value = 'persona.activation'; await e.capability.events.change();
  assert.equal(e.report.children.length, 0);
  assert.match(e.detail.children[0].textContent, /选择一条样例/);
  assert.equal(e.consent.checked, false);
  assert.equal(e.runs.children.length, 1);
  assert.equal(e.suites.children[0].textContent, '偏好测试集 · 1 条');
  await e.runs.children[0].events.click();
  assert.ok(requests.some(r => r.path === 'runs/activation-run'));
});

test('saved content judgment remains visible, selected and expanded', async () => {
  const {elements: e} = await managerFixture();
  await e.runs.children[0].events.click();
  await e.report.querySelectorAll('button').find(b => b.textContent === '内容不符合').events.click();
  const chosen = e.report.querySelectorAll('button').find(b => b.textContent === '内容不符合');
  assert.equal(chosen.attributes['aria-pressed'], 'true');
  assert.ok(e.report.querySelectorAll('p').some(p => p.textContent === '已保存内容评价：内容不符合'));
  assert.equal(e.report.querySelectorAll('details')[0].open, true);
  assert.equal(e.notice.textContent, '已保存内容评价：内容不符合');
});

test('late report response cannot replace another evaluation view', async () => {
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {elements:e}=await managerFixture(path=>path==='runs/learning-run'?held:undefined);
  const pending=e.runs.children[0].events.click();
  await e['run-tab'].events.click();
  release({status:'completed',mode:'learning_pipeline',results:[],calls:0});await pending;
  assert.equal(e['run-panel'].hidden,false);
  assert.equal(e.report.children.length,0);
});

test('changing a budget invalidates an in-flight model preview', async () => {
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {elements:e}=await managerFixture(path=>path==='preview'?held:undefined);
  const checkbox=e.list.querySelectorAll('input')[0];checkbox.checked=true;checkbox.events.change();
  const pending=e.preview.events.click();
  e['max-calls'].value=1;e['run-form'].events.input({target:e['max-calls']});
  release({name:'Fake',provider_id:'mock',selection:{modelId:'mock',connectionId:'mock'}});await pending;
  assert.equal(e.consent.disabled,true);assert.equal(e.start.disabled,true);
});

test('guided start freezes the preview, records repeats and suppresses a double submit', async () => {
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {elements:e,requests,radios}=await managerFixture((path,data)=>path==='runs'&&data?held:undefined);
  radios[1].checked=true;e.repeat.value='3';e['change-model'].checked=true;e.connection.value='mock';e['model-id'].value='mock';e['change-reasoning'].checked=true;e.reasoning.value='high';
  await e.preview.events.click();assert.equal(e.consent.disabled,false);
  e.consent.checked=true;const event={preventDefault(){}};
  const first=e['run-form'].events.submit(event);await e['run-form'].events.submit(event);
  const writes=requests.filter(r=>r.path==='runs'&&r.data);assert.equal(writes.length,1);
  assert.equal(writes[0].data.expected_plan,'frozen');assert.equal(writes[0].data.repeat_count,3);
  assert.equal(writes[0].data.variants[0].source,'active');assert.equal(writes[0].data.variants[1].reasoning,'high');
  assert.equal(writes[0].data.request_id,'test-check-id');assert.equal(writes[0].data.cases[0].benchmark_revision,1);
  release({id:'learning-run'});await first;
});

test('a new preview after editing budgets requires renewed confirmation',async()=>{
  const {elements:e}=await managerFixture();await e.preview.events.click();e.consent.checked=true;e.consent.events.change();assert.equal(e.start.disabled,false);
  e['max-calls'].value='2';e['run-form'].events.input({target:e['max-calls']});assert.equal(e.consent.checked,false);assert.equal(e.start.disabled,true);
  await e.preview.events.click();assert.equal(e.consent.checked,false);assert.equal(e.start.disabled,true);
});

test('automatic and manual drafts survive switching and optimizer never replaces target selection',async()=>{
  const {elements:e,radios,requests}=await managerFixture((path,data)=>path==='optimizations/preview'?{
    fingerprint:'auto-frozen',cases:data.cases,repeat_count:1,planned_replays:2,maximum_calls:10,budget:{max_calls:100,max_tokens:200000,timeout_seconds:900},coverage:{should_trigger:1,should_not_trigger:0},
    variants:data.variants.map(v=>({selection:{connectionId:'mock',modelId:'mock'},reasoning:v.reasoning,prompt_versions:{learning:{}}})),
    optimization:{optimizer:{connection_name:'Mock',selection:{modelId:'mock'},reasoning:'high'},split:{development:['learning'],validation:[],limitation:'缺少独立验收'},max_rounds:3},
  }:undefined);
  const choose=async index=>{radios.forEach((r,i)=>r.checked=i===index);await radios[index].events.change();};
  await choose(1);e['change-reasoning'].checked=true;e.reasoning.value='high';
  await choose(2);e.reasoning.value='low';e['optimizer-reasoning'].value='high';
  assert.equal(e['automatic-settings'].hidden,false);assert.equal(e['model-fields'].hidden,false);
  await choose(1);assert.equal(e.reasoning.value,'high');assert.equal(e['automatic-settings'].hidden,true);
  await e.preview.events.click();assert.equal(requests.at(-1).data.optimization,undefined);
  await choose(2);assert.equal(e.reasoning.value,'low');assert.equal(e['optimizer-reasoning'].value,'high');
  await e.preview.events.click();
  const data=requests.findLast(r=>r.path==='optimizations/preview').data;
  assert.equal(data.variants[0].reasoning,undefined);assert.equal(data.variants[1].reasoning,'low');
  assert.equal(data.optimization.optimizer.reasoning,'high');assert.equal(data.optimization.max_rounds,3);
  assert.equal(e.consent.disabled,false);assert.equal(e.consent.checked,false);
});
