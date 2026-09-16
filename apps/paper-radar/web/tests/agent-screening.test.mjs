import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, context, record, feed, xmlEntry, subject } from './helpers/daily-fixture.mjs';
import { promptSettingsRoute } from '../server/prompts/settings.mjs';
import { parseFeed } from '../server/daily/discovery.mjs';
import { ScreeningEvidence, screeningKey } from '../server/daily/agent-screening.mjs';

const answer = (task, decision='recommended') => ({schema:task.output.schema,paper_version:task.paper.version,decision,introduction:'An abstract-grounded introduction.',reason:'A methodological connection to the selected knowledge.',criterion_ids:['selected-knowledge'],paper_evidence_ids:[task.paper.source_ref],persona_evidence_ids:[task.persona.records[0].source_ref],persona_coverage_ref:task.persona.source_ref,claims:[],open_questions:decision==='needs_review'?['Does this transfer to the selected system?']:[]});
async function setup(t,opts={}) {
  const f=await fixture(t,opts); let active=0, peak=0, calls=0; const inputs=[], systems=[];
  f.models.mode='dsh';
  f.models.runAgent=async (request,options) => {
    const task=JSON.parse(request.prompt); inputs.push(task); systems.push(request.systemPrompt); active++; peak=Math.max(peak,active);
    try {
      for (let round=0;round<(opts.rounds??1);round++) {
        const id=randomUUID(); options.beforeAttempt(f.models.store.state.settings.connections[0],{id,started_at:new Date().toISOString()}); calls++;
        await delay(opts.agentDelay??5,undefined,{signal:options.signal});
        options.onAttempt({id,status:'succeeded',duration_ms:5,usage:{input:10,output:20,cost:null}});
      }
      if (opts.failPaper===task.paper.id) throw Object.assign(new Error('fixture provider failure'),{code:'PROVIDER_ERROR'});
      let page=task.persona;
      while (page.next_offset != null) page=await options.onTool('persona_list_scope',{offset:page.next_offset});
      const data=answer(task,opts.decision??'recommended');
      await options.onTool('screening_submit_result',data);
      return {data,providerId:'fixture',modelId:'fixture-model',requestId:randomUUID(),sessionId:randomUUID(),reasoningEffort:'low'};
    } finally {active--;}
  };
  return {...f,get agentCalls(){return calls;},get peak(){return peak;},inputs,systems};
}
function nextBatch(f,extra='') {
  const xml=feed(xmlEntry('2501.10000','new',1,'2026-09-08')+extra,'2026-09-08T04:00:00Z');
  const revision=f.repo.archiveFeed({...parseFeed(xml,subject),url:`https://rss.arxiv.org/atom/${subject}`,xml})[0];
  f.daily.discovery.latest=async()=>revision; return revision;
}
void test('each paper has isolated short input; four workers execute and one failed paper does not block others',async(t)=>{
  const f=await setup(t,{count:6,agentDelay:25,failPaper:'2501.10002'});
  const run=await f.finish(f.create().run.id);
  assert.equal(run.status,'partial'); assert.equal(run.stats.screened,5); assert.equal(run.stats.failed,1); assert.equal(f.peak,4);
  assert.equal(new Set(f.inputs.map(t=>t.paper.id)).size,6);
  for(const input of f.inputs) {assert.equal(typeof input.paper.abstract,'string');assert.equal(input.persona.records.length,1);assert.ok(JSON.stringify(input).length<5000);}
  assert.equal(f.repo.items(run.id).find(i=>i.paper.id==='2501.10002').final_decision,null);
});
void test('same paper on another day links the original result and feedback with zero new calls',async(t)=>{
  const f=await setup(t,{count:1}); const first=await f.finish(f.create().run.id),original=f.daily.getItem(f.repo.items(first.id)[0].id);
  f.daily.feedback(original.screening.id,'accuracy',{value:'positive'});
  nextBatch(f); const second=await f.finish(f.create('second-day').run.id),reused=f.daily.getItem(f.repo.items(second.id)[0].id);
  assert.equal(f.agentCalls,1);assert.equal(second.usage.requests,0);assert.equal(second.stats.reused,1);
  assert.equal(reused.screening.id,original.screening.id);assert.equal(reused.screening.created_at,original.screening.created_at);assert.equal(reused.screening.feedback.accuracy.value,'positive');
  await assert.rejects(f.daily.deleteReport(first.report_id),{code:'conflict'});
  await f.daily.deleteReport(second.report_id);await f.daily.deleteReport(first.report_id);
  assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
void test('cache identity ignores display, dates, budgets and other model routes but includes complete knowledge and screening settings',async(t)=>{
  const f=await setup(t,{count:1}),run=await f.finish(f.create().run.id),saved=f.repo.get('daily_runs',run.id),paper=f.repo.items(run.id)[0].paper;
  const key=screeningKey(saved,paper),other=structuredClone(saved);
  other.subscription.name='Renamed';other.subscription.max_model_calls=999;other.date='2030-01-01';
  other.model_settings.connections.push({...other.model_settings.connections[0],id:'discussion-only',modelId:'other'});other.model_settings.overrides.discussion='discussion-only';
  assert.equal(screeningKey(other,{...paper,date:'2030-01-01'}),key);
  for(const change of [r=>r.context.revision++,r=>r.context.records[0].scope_note='Changed meaning',r=>r.context.knowledge_ids.push('new-record'),r=>r.subscription.recommendation_strictness='focused',r=>r.model_settings.connections[0].reasoningEffort='high']) {
    const changed=structuredClone(saved);change(changed);assert.notEqual(screeningKey(changed,paper),key);
  }
  assert.notEqual(screeningKey(saved,{...paper,abstract:'Corrected abstract'}),key);
  assert.notEqual(screeningKey(saved,{...paper,version:2}),key);
});
void test('explicit one-paper reassessment preserves old versions and does not rerun completed or failed siblings',async(t)=>{
  const f=await setup(t,{count:3,failPaper:'2501.10002'}); const run=await f.finish(f.create().run.id),items=f.repo.items(run.id),old=items[0].screening_version_id;
  f.daily.feedback(old,'accuracy',{value:'negative',reason:'Please reconsider'});
  const submitted=f.daily.rescreenItem(items[0].id,'one-paper-rescreen');
  assert.equal(f.daily.rescreenItem(items[0].id,'one-paper-rescreen').run.id,submitted.run.id);
  await f.finish(run.id);
  assert.equal(f.agentCalls,4);assert.notEqual(f.repo.get('daily_items',items[0].id).screening_version_id,old);
  assert.equal(f.daily.getVersion(old).feedback.accuracy.value,'negative');
  assert.equal(f.repo.get('daily_items',items[1].id).screening_version_id,items[1].screening_version_id);
  assert.equal(f.repo.get('daily_items',items[2].id).processing_status,'failed');
});
void test('overlapping batches wait for the existing paper agent and link its result without a second call',async(t)=>{
  const f=await setup(t,{count:1,agentDelay:120}); const first=f.create('overlap-first').run;
  while(!f.inputs.length) await delay(2);
  const revision=nextBatch(f);const second=f.create('overlap-second',{source:{kind:'stored_batch',batch_id:revision.batch_id,revision_id:revision.id}}).run;
  const [a,b]=await Promise.all([f.finish(first.id),f.finish(second.id)]);
  assert.equal(a.status,'completed');assert.equal(b.status,'completed');assert.equal(f.agentCalls,1);assert.equal(b.stats.reused,1);
});
void test('cancelled screening publishes no late result and releases its claim',async(t)=>{
  const f=await setup(t,{count:1,agentDelay:150});const run=f.create('cancel-agent').run;
  while(!f.inputs.length) await delay(2);
  f.daily.cancel(run.id);await delay(180);
  assert.equal(f.daily.getRun(run.id).status,'cancelled');
  assert.equal(f.repo.items(run.id)[0].screening_version_id,null);
  assert.notEqual(f.db.db.prepare('SELECT status FROM daily_screening_claims').get().status,'running');
});
void test('failure preparing a prompt releases the screening claim before any provider request',async(t)=>{
  const f=await setup(t,{count:1});f.analyses.prompts.preview=()=>{throw new Error('fixture preview failure');};
  const run=await f.finish(f.create('bad-prompt').run.id);
  assert.equal(run.status,'partial');assert.equal(f.agentCalls,0);
  assert.equal(f.db.db.prepare('SELECT status FROM daily_screening_claims').get().status,'failed');
});
void test('uncertain judgments are saved but not cached or automatically retried in a later batch',async(t)=>{
  const f=await setup(t,{count:1,decision:'needs_review'}),first=await f.finish(f.create().run.id);
  assert.equal(first.stats.needs_confirmation,1);
  nextBatch(f);const second=await f.finish(f.create('next-uncertain').run.id);
  assert.equal(f.agentCalls,1);assert.equal(second.stats.reused,0);assert.equal(second.status,'partial');
  assert.equal(f.repo.items(second.id)[0].error.code,'manual_resume_required');
});
void test('each agent round reserves a call and parallel workers cannot overspend the last slot',async(t)=>{
  const f=await setup(t,{count:4,maxCalls:3,rounds:2,agentDelay:10});const run=await f.finish(f.create().run.id);
  assert.equal(run.status,'paused');assert.equal(run.actual_attempts,3);assert.equal(f.agentCalls,3);assert.equal(run.stats.screened,0);
  assert.ok(f.repo.items(run.id).every(i=>i.final_decision===null));
});
void test('scope pages and long fields are optional reading tools, and actual delivery remains visible',async(t)=>{
  const f=await setup(t,{count:1}); const run={id:'test',subscription:f.sub,context:structuredClone(context)},item={id:'one',paper:f.revision.papers[0]};
  run.context.records=Array.from({length:12},(_,i)=>({...record,id:`r${i}`,scope_note:i===10?'x'.repeat(18000):'A concise scope',body:'b'.repeat(100000)}));
  run.context.knowledge_ids=run.context.records.map(r=>r.id);run.context.evidence=run.context.records.map(r=>({id:`persona:${r.id}:r2`,record_id:r.id,text:'record'}));
  const reader=new ScreeningEvidence(f.daily,run,item,new AbortController().signal);reader.saveProgress=()=>{};
  const task=reader.initial();assert.ok(JSON.stringify(task).length<10000);assert.ok(!JSON.stringify(task).includes('b'.repeat(100)));
  assert.equal(reader.validate(answer(task)).outcome,'recommended');assert.equal(reader.coverage().complete,false);
  let page=task.persona;while(page.next_offset!==null)page=await reader.call('persona_list_scope',{offset:page.next_offset});
  assert.equal(reader.validate(answer(task)).outcome,'recommended');assert.equal(reader.coverage().complete,false);
  let offset=0;do{const part=await reader.call('persona_read_record',{record_id:'r10',view:'screening',offset});assert.ok(part.text.length<=7000);offset=part.next_offset;}while(offset!==null);
  assert.equal(reader.validate(answer(task)).outcome,'recommended');
  await assert.rejects(reader.call('persona_read_record',{record_id:'outside',view:'body'}),{code:'invalid_reference'});
});
void test('targeted paper tools use the fixed version and expose only actually read citation IDs',async(t)=>{
  const f=await setup(t,{count:1});const run={id:'test',subscription:f.sub,context:structuredClone(context)},item={id:'one',paper:f.revision.papers[0]};
  const reader=new ScreeningEvidence(f.daily,run,item,new AbortController().signal);reader.saveProgress=()=>{};
  const task=reader.initial(),outline=await reader.call('paper_get_outline',{});
  const data=answer(task);data.paper_evidence_ids=['invented'];assert.throws(()=>reader.validate(data),{code:'invalid_reference'});
  const part=await reader.call('paper_read_section',{section_id:outline.sections[0].id});data.paper_evidence_ids=[part.id];assert.equal(reader.validate(data).outcome,'recommended');
});
void test('an optional paper read failure remains visible and does not block an uncertain submission',async(t)=>{
  const f=await setup(t,{count:1});f.analyses.arxiv.get=async()=>{throw Object.assign(new Error('source offline'),{code:'source_unavailable',retryable:true});};
  const reader=new ScreeningEvidence(f.daily,{id:'test',subscription:f.sub,context:structuredClone(context)},{id:'one',paper:f.revision.papers[0]},new AbortController().signal);reader.saveProgress=()=>{};
  const task=reader.initial();await assert.rejects(reader.call('paper_get_outline',{}),{code:'source_unavailable'});
  assert.equal(reader.validate(answer(task,'needs_review')).outcome,'needs_fulltext');
  assert.equal(reader.coverage().source_issues[0].code,'source_unavailable');
});

void test('daily dispatch uses only its pinned rule; changing another rule does not repeat screening', async (t) => {
  const f = await setup(t, { count: 1 });
  const store = f.analyses.prompts;
  const update = (id, text) => promptSettingsRoute(store, 'POST', `${id}/save`, { templates: { text }, expected_active: store.version(id).id });
  const first = f.create('rules-before').run;
  update('paper-radar.screen-balanced.zh', 'CUSTOM BALANCED ONLY');
  await f.finish(first.id);
  assert.doesNotMatch(f.systems[0], /CUSTOM BALANCED ONLY/);
  await f.finish(f.create('rules-after').run.id);
  assert.equal(f.agentCalls, 2);
  const instructions = JSON.parse(f.systems[1]).instructions;
  assert.equal(instructions.filter((b) => b.kind === 'screening_rule').length, 1);
  assert.equal(instructions.at(-1).text, 'CUSTOM BALANCED ONLY');
  assert.equal(instructions.at(-1).source.rule, 'balanced');
  update('paper-radar.screen-focused.zh', 'UNUSED FOCUSED CHANGE');
  await f.finish(f.create('unrelated-rule').run.id);
  assert.equal(f.agentCalls, 2);
});
