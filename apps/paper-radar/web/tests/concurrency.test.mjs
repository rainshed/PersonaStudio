import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runConcurrent, modelConcurrency } from '../server/concurrency.mjs';

async function until(check) {
  for(let i=0;i<500;i++){if(check())return;await delay(2);}
  throw new Error('Expected pool state did not arrive');
}
void test('the active paper pool follows setting changes in both directions without restarting completed work',async()=>{
  let limit=1,notify;const started=[],release=new Map();let subscribed=false;
  const work=runConcurrent([0,1,2,3,4],async id=>{started.push(id);await new Promise(resolve=>release.set(id,resolve));},{
    limit:()=>limit,signal:new AbortController().signal,
    subscribe(fn){subscribed=true;notify=fn;return()=>{subscribed=false;};},
  });
  await until(()=>started.length===1);limit=3;notify();await until(()=>started.length===3);
  limit=1;notify();release.get(0)();release.get(1)();await delay(5);assert.deepEqual(started,[0,1,2]);
  release.get(2)();await until(()=>started.length===4);assert.deepEqual(started,[0,1,2,3]);
  release.get(3)();await until(()=>started.length===5);release.get(4)();await work;
  assert.equal(subscribed,false);assert.equal(new Set(started).size,5);
});
void test('cancelling a paper queue drains active tasks and never starts queued papers',async()=>{
  const controller=new AbortController(),started=[],release=[];let subscribed=false;
  const work=runConcurrent([0,1,2,3],async id=>{started.push(id);await new Promise(resolve=>release.push(resolve));},{limit:()=>2,signal:controller.signal,subscribe(){subscribed=true;return()=>{subscribed=false;};}});
  const rejected=assert.rejects(work,{name:'AbortError'});
  await until(()=>started.length===2);controller.abort();release.forEach(fn=>fn());await rejected;
  assert.deepEqual(started,[0,1]);assert.equal(subscribed,false);
});
void test('model stages use the DSH queue instead of blocking at the old two-request gate',async()=>{
  const controller=new AbortController();controller.abort();
  // At three busy requests the former caller-side cap would try to wait and
  // reject this signal. DSH admission is now solely its shared FIFO queue.
  assert.equal(modelConcurrency({mode:'dsh',running:3,concurrency:6}), 6);
});
