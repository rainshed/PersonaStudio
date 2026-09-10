import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// A small DOM contract fixture. All requests use in-memory data, never live accounts.
class Element {
  constructor(tag) { this.tag=tag; this.children=[]; this.events={}; this.attributes={}; this.dataset={}; this.disabled=false; this.isConnected=true; this._value=undefined; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=items; }
  addEventListener(event, fn) { this.events[event]=fn; }
  setAttribute(key, value) { this.attributes[key]=value; }
  focus() {}
  get options() { return this.children.filter(c=>c.tag==='option'); }
  get value() { return this._value ?? (this.tag==='select' ? this.options[0]?.value ?? '' : ''); }
  set value(v) { this._value=v; }
  get selectedIndex() { return this.options.findIndex(o=>o.value===this.value); }
  set selectedIndex(i) { this._value=this.options[i]?.value ?? ''; }
  querySelectorAll(selector) { return this.children.flatMap(c=>[...(selector.split(',').includes(c.tag)?[c]:[]),...c.querySelectorAll(selector)]); }
  get textContent() { return (this.text??'')+this.children.map(c=>c.textContent).join(''); }
  set textContent(v) { this.text=v??''; this.children=[]; }
}
const script=readFileSync(new URL('../src/ai_persona/static/model-settings.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture() {
  const ids=new Map(); const $=id=>{if(!ids.has(id))ids.set(id,new Element('div'));return ids.get(id);};
  const node=(tag,text,cls)=>{const e=new Element(tag);e.textContent=text;e.className=cls;return e;};
  const form=$('model-form'), fields={};
  for(const id of ['name','providerId','authType','apiKey','customModel','imageModelIds','baseUrl','api','contextWindow','maxTokens'])fields[id]=node('input');
  form.elements={namedItem:name=>fields[name]}; form.reset=()=>{};
  const fallback=node('input');fallback.name='fallbackEnabled';fallback.checked=false;
  const routing=$('routing-form');routing.append($('model-default'),$('model-generation'),$('model-judgment'),$('model-fallback'),fallback);
  Object.defineProperty(routing,'elements',{get(){const all=routing.querySelectorAll('input,select,button');all.fallbackEnabled=fallback;return all;}});
  const tasks=['maintenance','conversation_learning','conversation_signal','activation'].map(id=>({id,name:id}));
  const config={capabilities:{persistentReasoning:1,reasoningTests:1},providers:[{id:'fixture',name:'Fixture',models:[{id:'think',reasoningLevels:['low','high'],input:['text','image']},{id:'plain',reasoningLevels:[],input:['text']}]}],tasks,runs:[{task:'activation',modelId:'think',status:'succeeded',durationMs:100,at:'2026-09-09'}, {task:'activation',modelId:'think',status:'succeeded',durationMs:100,at:'2026-09-09',reasoning:null}, {task:'maintenance',modelId:'think',status:'succeeded',durationMs:100,at:'2026-09-09',reasoning:'high',reasoningEffort:'high'}],settings:{routingVersion:3,connections:[{id:'account',name:'Fixture',providerId:'fixture',modelId:'think',authType:'none',hasCredential:true}],defaultConnectionId:'account',defaultModelId:'think',overrides:{},overrideModelIds:{},overrideReasoning:{maintenance:'high'},fallback:{enabled:false,connectionId:null}}};
  const routes=()=>{config.taskRoutes=tasks.map(t=>({...t,connectionId:config.settings.overrides[t.id]??null,modelId:config.settings.overrideModelIds[t.id]??null,reasoning:config.settings.overrideReasoning[t.id]??null}));};routes();
  const requests=[],notices=[];let failSave=false;
  const api=async(path,payload)=>{
    requests.push({path,payload});
    if(path==='/api/models/auth/active')return {session:null};
    if(path==='/api/models/routing') {if(failSave)throw new Error('save failed');Object.assign(config.settings,payload);routes();}
    return structuredClone(config);
  };
  const button=(text,fn)=>{const b=node('button',text);b.addEventListener('click',fn);return b;};
  const context=vm.createContext({window:{PersonaAI:{L:zh=>zh,node,api,button,notice:(_id,text)=>notices.push(text),modelLabel:(...v)=>v.filter(Boolean).join(' / ')},addEventListener(){}},document:{getElementById:$},setTimeout,clearTimeout});
  vm.runInContext(script,context);await flush();
  const control=name=>routing.elements.find(e=>e.name===name);
  const change=async(name,value)=>{const e=control(name);e.value=value;e.events.change();await flush();};
  const save=async()=>{routing.events.submit({preventDefault(){}});await flush();};
  return {$,control,change,save,config,requests,notices,failSave:v=>{failSave=v;}};
}

test('each feature loads and saves independent effort while its model follows default',async()=>{
  const f=await fixture();
  assert.equal(f.control('maintenanceReasoning').value,'high');
  assert.equal(f.control('maintenanceReasoning').disabled,false);
  await f.change('conversation_signalReasoning','low');
  assert.equal(f.$('model-save-state').textContent,'有未保存的修改');
  await f.save();
  const payload=f.requests.find(r=>r.path==='/api/models/routing').payload;
  assert.equal(payload.overrides.conversation_signal,null);
  assert.equal(payload.overrideReasoning.maintenance,'high');
  assert.equal(payload.overrideReasoning.conversation_signal,'low');
  assert.equal(f.$('model-save-state').textContent,'已保存');
  assert.equal(f.$('model-revert').disabled,true);
  await f.change('maintenanceReasoning','');await f.save();
  assert.equal(f.config.settings.overrideReasoning.maintenance,null);
});

test('unsupported model switch keeps the previous effort visible and blocks saving until resolved',async()=>{
  const f=await fixture();await f.change('defaultModel','plain');
  assert.equal(f.control('maintenanceReasoning').value,'high');
  assert.equal(f.control('maintenanceReasoning').attributes['aria-invalid'],'true');
  await f.save();assert.equal(f.requests.filter(r=>r.path==='/api/models/routing').length,0);
  assert.match(f.notices.at(-1),/不支持/);
  await f.change('maintenanceReasoning','');
  assert.equal(f.control('maintenanceReasoning').disabled,true);
  await f.save();assert.equal(f.config.settings.defaultModelId,'plain');
});

test('failed save preserves drafts and revert restores saved effort',async()=>{
  const f=await fixture();await f.change('maintenanceReasoning','low');f.failSave(true);await f.save();
  assert.equal(f.control('maintenanceReasoning').value,'low');assert.equal(f.$('model-save-state').textContent,'有未保存的修改');
  f.$('model-revert').events.click();assert.equal(f.control('maintenanceReasoning').value,'high');assert.equal(f.$('model-save-state').textContent,'已保存');
});

test('connection test uses unsaved effort and refresh retains it; old records are not claimed as defaults',async()=>{
  const f=await fixture();await f.change('maintenanceReasoning','low');
  const section=f.$('model-generation').children.find(s=>s.dataset.modelTask==='maintenance');
  await section.querySelectorAll('button').find(b=>b.textContent==='测试连接（真实调用）').events.click();await flush();
  assert.equal(f.requests.find(r=>r.path==='/api/models/test').payload.reasoning,'low');
  assert.equal(f.control('maintenanceReasoning').value,'low');assert.equal(f.$('model-save-state').textContent,'有未保存的修改');
  const text=f.$('model-runs').textContent;
  assert.match(text,/旧记录未记录/);assert.match(text,/模型默认（未指定）/);assert.match(text,/高 \(high\)/);
});
