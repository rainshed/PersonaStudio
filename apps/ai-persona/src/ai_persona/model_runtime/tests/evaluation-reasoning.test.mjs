import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PiEngine, providerCatalog} from '../engine.mjs';
import {ModelStore} from '../store.mjs';
import {ModelService} from '../service.mjs';

void test('evaluation effort is forwarded unchanged and unsupported effort never calls engine',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'persona-reasoning-'));
  const store=await new ModelStore(directory).open();const calls=[];
  const service=new ModelService(store,{generate:async(c,r)=>{calls.push({c,r});return {text:'OK',modelId:c.modelId,usage:{},stopReason:'stop'};}});
  t.after(async()=>{await service.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const provider=providerCatalog().find(p=>p.id==='openai');
  const model=provider.models.find(m=>m.reasoningLevels.includes('high'));
  await service.saveConnection({id:'test',name:'test',providerId:provider.id,authType:'api_key',modelId:model.id,apiKey:'local-fixture'});
  const c=service.config().settings.connections[0];
  const raw={task:'activation',prompt:'fixture',experimentSelection:{connectionId:c.id,modelId:c.modelId,revision:c.revision},reasoning:'high'};
  assert.equal(service.config().capabilities.evaluationReasoning,1);
  await service.run(raw);assert.equal(calls.length,1);assert.equal(calls[0].r.reasoning,'high');
  await assert.rejects(service.run({...raw,reasoning:'off'}),{code:'invalid_reasoning'});
  await assert.rejects(service.run({...raw,reasoning:'invented'}),{code:'invalid_reasoning'});
  assert.equal(calls.length,1);
});

void test('Pi adapter forwards reasoning to streamSimple and records the effective mapping',async()=>{
  const engine=new PiEngine({});const options=[];
  const model={id:'fixture',provider:'fixture',reasoning:true,thinkingLevelMap:{low:'low',high:'high'},maxTokens:4096};
  engine.collection=()=>({getModel:()=>model,streamSimple:(_m,_context,o)=>{options.push(o);return {async *[Symbol.asyncIterator](){yield {type:'text_delta'};},result:async()=>({content:[{type:'text',text:'OK'}],usage:{input:1,output:1,cost:{total:0}},stopReason:'stop'})};}});
  const connection={providerId:'fixture',modelId:'fixture',maxTokens:2048,authType:'api_key'};
  const output=await engine.generate(connection,{prompt:'test',reasoning:'high'});
  assert.equal(options[0].reasoning,'high');assert.equal(output.reasoningEffort,'high');
  await engine.generate(connection,{prompt:'test'});assert.equal('reasoning' in options[1],false);
  model.reasoning=false;
  await assert.rejects(engine.generate(connection,{prompt:'test',reasoning:'high'}),{code:'invalid_reasoning'});
  assert.equal(options.length,2);
});

void test('published task effort survives routing and stays out of explicit experiments',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'persona-published-effort-'));
  const store=await new ModelStore(directory).open(), calls=[];
  const service=new ModelService(store,{generate:async(c,r)=>{calls.push(r);return {text:'OK',modelId:c.modelId,usage:{},stopReason:'stop'};}});
  t.after(async()=>{await service.close();await store.close();await rm(directory,{recursive:true,force:true});});
  const provider=providerCatalog().find(p=>p.id==='openai'), model=provider.models.find(m=>m.reasoningLevels.includes('high'));
  await service.saveConnection({id:'test',name:'test',providerId:provider.id,authType:'api_key',modelId:model.id,apiKey:'local-fixture'});
  const settings=service.config().settings,c=settings.connections[0];
  await service.routing({...settings,defaultConnectionId:c.id,defaultModelId:c.modelId,overrides:{...settings.overrides,activation:c.id},overrideModelIds:{...settings.overrideModelIds,activation:c.modelId},overrideReasoning:{activation:'high'}});
  assert.equal(service.config().settings.overrideReasoning.activation,'high');
  await service.run({task:'activation',prompt:'fixture'});
  assert.equal(calls[0].reasoning,'high');
  await service.run({task:'activation',prompt:'fixture',experimentSelection:{connectionId:c.id,modelId:c.modelId,revision:c.revision}});
  assert.equal(calls[1].reasoning,undefined);
  await service.run({task:'conversation_signal',prompt:'fixture'});
  assert.equal(calls[2].reasoning,undefined);
  await assert.rejects(service.routing({...service.config().settings,overrideReasoning:{activation:'invented'}}),{code:'invalid_request'});
  assert.equal(service.config().settings.overrideReasoning.activation,'high');
});

void test('saved effort follows all four feature routes after reopening the store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'persona-feature-effort-'));
  let store = await new ModelStore(directory).open();
  const calls = [];
  const engine = {generate: async (c, r) => {
    calls.push(r);
    return {text: 'OK', modelId: c.modelId, reasoningEffort: r.reasoning ?? null, usage: {}, stopReason: 'stop'};
  }};
  let service = new ModelService(store, engine);
  t.after(async () => {await service.close(); await store.close(); await rm(directory, {recursive: true, force: true});});
  const provider = providerCatalog().find(p => p.id === 'openai');
  const model = provider.models.find(m => ['low', 'medium', 'high'].every(v => m.reasoningLevels.includes(v)));
  await service.saveConnection({id: 'account', name: 'fixture', providerId: provider.id, authType: 'api_key', modelId: model.id, apiKey: 'local-fixture'});
  await service.routing({...service.config().settings, defaultConnectionId: 'account', defaultModelId: model.id,
    overrideReasoning: {maintenance: 'high', conversation_learning: 'medium', conversation_signal: 'low', activation: null}});
  await service.close(); await store.close();
  store = await new ModelStore(directory).open(); service = new ModelService(store, engine);
  const routes = service.config().taskRoutes;
  assert.equal(routes.find(r => r.id === 'maintenance').connectionId, null, 'model can inherit while effort is explicit');
  assert.equal(routes.find(r => r.id === 'maintenance').reasoning, 'high');
  for (const [task, expected] of [['maintenance', 'high'], ['material', 'high'], ['conversation_candidate', 'medium'], ['conversation_signal', 'low'], ['activation', undefined]]) {
    await service.run({task, prompt: 'fixture'});
    assert.equal(calls.at(-1).reasoning, expected, task);
    assert.equal(service.config().runs[0].reasoning, expected ?? null);
    assert.equal(service.config().runs[0].reasoningEffort, expected ?? null);
  }
  await service.routing({...service.config().settings, overrideReasoning: {maintenance: null}});
  await service.run({task: 'maintenance', prompt: 'fixture'});
  assert.equal(calls.at(-1).reasoning, undefined, 'reset to default removes explicit effort');
});

void test('connection tests send the selected effort through HTTP and reject unsupported levels', async t => {
  const {createModelServer} = await import('../daemon.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'persona-test-effort-'));
  const store = await new ModelStore(directory).open(), calls = [];
  const service = new ModelService(store, {generate: async(c, r) => {
    calls.push(r); return {text: 'OK', modelId: c.modelId, reasoningEffort: r.reasoning ?? null, usage: {}, stopReason: 'stop'};
  }});
  const server = createModelServer(service, 'fixture-token');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await service.close(); await store.close(); await rm(directory, {recursive: true, force: true});});
  const provider = providerCatalog().find(p => p.id === 'openai'), model = provider.models.find(m => m.reasoningLevels.includes('high'));
  await service.saveConnection({id: 'account', name: 'fixture', providerId: provider.id, authType: 'api_key', modelId: model.id, apiKey: 'local-fixture'});
  const request = reasoning => fetch(`http://127.0.0.1:${server.address().port}/test`, {method: 'POST', headers: {'Authorization': 'Bearer fixture-token', 'Content-Type': 'application/json'}, body: JSON.stringify({id: 'account', modelId: model.id, reasoning})});
  const high = await request('high'); assert.equal(high.status, 200);
  assert.equal((await high.json()).reasoning, 'high');
  assert.equal(calls[0].reasoning, 'high');
  assert.equal(service.config().runs[0].reasoning, 'high');
  const invalid = await request('invented'); assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'invalid_reasoning'); assert.equal(calls.length, 1);
  assert.equal(service.config().runs[0].reasoning, 'high', 'rejected input creates no model run');
  const defaults = await request(null); assert.equal(defaults.status, 200);
  assert.equal((await defaults.json()).reasoning, null);
});
