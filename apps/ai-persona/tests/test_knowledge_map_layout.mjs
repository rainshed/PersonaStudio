import test from 'node:test';
import {createRequire} from 'node:module';
import {edgePath} from '../src/ai_persona/static/knowledge-map/edge-path.mjs';
const require=createRequire(import.meta.url);
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ELK=require('../src/ai_persona/static/knowledge-map/vendor/elk-api.js');
const {Worker}=require('../src/ai_persona/static/knowledge-map/vendor/elk-worker.min.js');
const {layout,index,visible,segmentHits}=require('../src/ai_persona/static/knowledge-map/layout-core.js');
const elk=new ELK({workerFactory:()=>new Worker()});
const node=(id,width=160,height=46)=>({id,title:id,width,height});
const edge=(a,b,type='broader_than')=>({id:a+'_'+b+'_'+type,source:a,target:b,type});
function samplePath(path){
  let current;
  const samples=[];
  for(const match of path.matchAll(/([MLQC])([^MLQC]+)/g)){
    const values=match[2].trim().split(/[\s,]+/).map(Number);
    const controls=Array.from({length:values.length/2},(_,i)=>({x:values[2*i],y:values[2*i+1]}));
    if(match[1]==='M')samples.push(controls[0]);
    else for(let step=1;step<=128;step++){
      // De Casteljau evaluation checks the rendered curve, not just the router's polyline.
      const t=step/128,work=[current,...controls].map(p=>({...p}));
      for(let count=work.length-1;count>0;count--)for(let i=0;i<count;i++){
        work[i]={x:(1-t)*work[i].x+t*work[i+1].x,y:(1-t)*work[i].y+t*work[i+1].y};
      }
      samples.push(work[0]);
    }
    current=controls.at(-1);
  }
  return samples;
}
function verify(graph,result){
  assert.deepEqual(new Set(result.nodes.map(n=>n.id)),new Set(graph.nodes.map(n=>n.id)));
  assert.equal(result.nodes.length,graph.nodes.length);
  assert.deepEqual(new Set(result.edges.map(e=>e.id)),new Set(graph.edges.map(e=>e.id)));
  for(let i=0;i<result.nodes.length;i++)for(let j=i+1;j<result.nodes.length;j++){
    const a=result.nodes[i],b=result.nodes[j];
    assert.ok(!(a.x<b.x+b.width-.1&&a.x+a.width>b.x+.1&&a.y<b.y+b.height-.1&&a.y+a.height>b.y+.1),'overlapping nodes');
  }
  for(const e of result.edges){assert.ok(e.points.length>=2);for(let i=1;i<e.points.length;i++){
    const a=e.points[i-1],b=e.points[i];assert.ok(Math.abs(a.x-b.x)<.1||Math.abs(a.y-b.y)<.1,'non-orthogonal route');
    for(const n of result.nodes)assert.ok(!segmentHits(a,b,n,0),`edge crosses a node: ${e.id}`);
  }
    const samples=samplePath(edgePath(e,result.nodes));
    assert.deepEqual(samples[0],e.points[0]);
    assert.deepEqual(samples.at(-1),e.points.at(-1));
    for(const p of samples)for(const n of result.nodes){
      assert.ok(!(p.x>n.x+.01&&p.x<n.x+n.width-.01&&p.y>n.y+.01&&p.y<n.y+n.height-.01),`smoothed curve crosses ${n.id}: ${e.id}`);
    }
  }
}
test('shared children remain visible through another expanded parent',()=>{
  const graph={nodes:['r','a','b','c'].map(x=>node(x)),edges:[edge('r','a'),edge('r','b'),edge('a','c'),edge('b','c')]};
  assert.equal(index(graph).parents.get('c').length,2);
  assert.equal(visible(graph,new Set(['a'])).nodes.length,4);
  assert.equal(visible(graph,new Set(['a','b'])).nodes.length,3);
});
test('a wide tree, a deep tree, shared parents, and disconnected nodes route without overlap',async()=>{
  const wide={nodes:['r',...Array.from({length:30},(_,i)=>'n'+i)].map(x=>node(x)),edges:Array.from({length:30},(_,i)=>edge('r','n'+i))};
  const deep={nodes:Array.from({length:12},(_,i)=>node('n'+i,i%2?230:140)),edges:Array.from({length:11},(_,i)=>edge('n'+i,'n'+(i+1)))};
  const diamond={nodes:['r','a','b','c','other'].map(x=>node(x)),edges:[edge('r','a'),edge('r','b'),edge('a','c'),edge('b','c')]};
  for(const graph of [wide,deep,diamond])for(const direction of ['auto','right','down'])verify(graph,await layout(graph,direction,elk));
});
test('collapsing a main branch preserves its side of a bilateral tree',async()=>{
  const graph={nodes:['r','a','b','c',...Array.from({length:8},(_,i)=>'leaf'+i)].map(x=>node(x)),edges:[edge('r','a'),edge('r','b'),edge('r','c'),...Array.from({length:8},(_,i)=>edge(i<5?'a':i<7?'b':'c','leaf'+i))]};
  const before=await layout(visible(graph,new Set()),'auto',elk);
  for(const collapsed of [new Set(['a']),new Set(['a','b','c'])]){
    const after=await layout(visible(graph,collapsed),'auto',elk);
    verify(visible(graph,collapsed),after);
    for(const id of ['a','b','c'])assert.equal(Math.sign(after.nodes.find(n=>n.id===id).x),Math.sign(before.nodes.find(n=>n.id===id).x));
  }
});
test('different and reciprocal relations on one pair keep distinct routes and ports',async()=>{
  const parallel=[edge('a','b','requires'),edge('a','b','applied_in'),edge('a','b','related_to'),edge('b','a','requires')];
  const graph={nodes:['root','a','b','c'].map(x=>node(x)),edges:[edge('root','a'),edge('root','b'),edge('root','c'),...parallel]};
  for(const mode of ['auto','right','down']){
    const result=await layout(graph,mode,elk);
    verify(graph,result);
    const routes=result.edges.filter(e=>parallel.some(p=>p.id===e.id));
    assert.equal(new Set(routes.map(e=>JSON.stringify(e.points))).size,parallel.length);
    // At the shared source, arrowed and undirected relations cannot lie on top of each other.
    const outgoing=routes.filter(e=>e.source==='a');
    assert.equal(new Set(outgoing.map(e=>JSON.stringify(e.points[0]))).size,outgoing.length);
  }
});
if(process.env.PERSONA_GRAPH_SNAPSHOT){
  const datasets=JSON.parse(fs.readFileSync(process.env.PERSONA_GRAPH_SNAPSHOT,'utf8'));
  for(const data of datasets)test(`${data.id}: exported graph retains every active node and relation in all layouts`,async()=>{
    const graph={...data,nodes:data.nodes.map(n=>({...n,width:Math.min(241,Math.max(150,n.title.length*10+45)),height:n.title.length>17?64:46}))};
    for(const mode of ['auto','right','down'])verify(graph,await layout(graph,mode,elk));
  });
}
