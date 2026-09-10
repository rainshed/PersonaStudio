/* Pure layout functions shared by the local Worker and the geometric checks. */
(function(scope){
  const primary=e=>e.type==='broader_than';
  function index(data){
    const parents=new Map(data.nodes.map(n=>[n.id,[]]));
    const children=new Map(data.nodes.map(n=>[n.id,[]]));
    for(const e of data.edges.filter(primary)){parents.get(e.target)?.push(e.source);children.get(e.source)?.push(e.target);}
    const roots=data.nodes.filter(n=>!parents.get(n.id).length).map(n=>n.id);
    return {parents,children,roots};
  }
  function visible(data,collapsed){
    const ix=index(data), seen=new Set(),todo=[...ix.roots];
    while(todo.length){const id=todo.pop();if(seen.has(id))continue;seen.add(id);if(!collapsed.has(id))todo.push(...ix.children.get(id));}
    // Keep malformed/rootless components inspectable rather than dropping records.
    if(!ix.roots.length) data.nodes.forEach(n=>seen.add(n.id));
    const weights=new Map();
    // Reserve each main branch's original side as descendants are collapsed.
    if(isTree(data))for(const id of ix.children.get(ix.roots[0]))weights.set(id,[...descendants(id,ix)].filter(n=>!ix.children.get(n).length).length);
    return {nodes:data.nodes.filter(n=>seen.has(n.id)).map(n=>({...n,branchWeight:weights.get(n.id)})),edges:data.edges.filter(e=>seen.has(e.source)&&seen.has(e.target))};
  }
  function descendants(id,ix){const result=new Set(),todo=[id];while(todo.length){const n=todo.pop();if(result.has(n))continue;result.add(n);todo.push(...ix.children.get(n));}return result;}
  function isTree(data){const ix=index(data);return ix.roots.length===1&&[...ix.parents.values()].every(p=>p.length<=1)&&descendants(ix.roots[0],ix).size===data.nodes.length;}
  function bounds(nodes,edges=[]){
    if(!nodes.length)return {x:0,y:0,width:400,height:300};
    const xs=nodes.flatMap(n=>[n.x,n.x+n.width]),ys=nodes.flatMap(n=>[n.y,n.y+n.height]);
    for(const e of edges)for(const p of e.points??[]){xs.push(p.x);ys.push(p.y);}
    const x=Math.min(...xs)-16,y=Math.min(...ys)-16;
    return {x,y,width:Math.max(...xs)-x+16,height:Math.max(...ys)-y+16};
  }
  async function layered(data,direction,elk,onlyHierarchy=false){
    const graph={id:'root',layoutOptions:{
      'elk.algorithm':'layered','elk.direction':direction,'elk.edgeRouting':'ORTHOGONAL',
      'elk.spacing.nodeNode':'8','elk.layered.spacing.nodeNodeBetweenLayers':'58',
      'elk.spacing.componentComponent':'40','elk.padding':'[top=12,left=12,bottom=12,right=12]',
      'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.randomSeed':'7',
      'elk.layered.nodePlacement.strategy':'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges':'false',
    },children:data.nodes.map(n=>({id:n.id,width:n.width,height:n.height})),
      edges:data.edges.filter(e=>!onlyHierarchy||primary(e)).map(e=>({id:e.id,sources:[e.source],targets:[e.target],
        layoutOptions:{'elk.layered.priority.direction':primary(e)?'100':'0'}}))};
    const output=await elk.layout(graph),byId=new Map(data.nodes.map(n=>[n.id,n]));
    const nodes=output.children.map(n=>({...byId.get(n.id),x:n.x,y:n.y}));
    const edges=output.edges.map(e=>({...data.edges.find(o=>o.id===e.id),points:e.sections?.flatMap(s=>[s.startPoint,...(s.bendPoints??[]),s.endPoint])??[]}));
    return {nodes,edges,bounds:bounds(nodes,edges),kind:direction==='RIGHT'?'right':'down'};
  }
  // Routing on a rectilinear visibility grid. Expanded node rectangles are obstacles.
  function segmentHits(a,b,n,pad=3){
    const l=n.x-pad,r=n.x+n.width+pad,t=n.y-pad,d=n.y+n.height+pad;
    if(Math.abs(a.x-b.x)<.01)return a.x>l+.01&&a.x<r-.01&&Math.max(a.y,b.y)>t+.01&&Math.min(a.y,b.y)<d-.01;
    return a.y>t+.01&&a.y<d-.01&&Math.max(a.x,b.x)>l+.01&&Math.min(a.x,b.x)<r-.01;
  }
  class Heap{constructor(){this.items=[];}push(item){let i=this.items.length;this.items.push(item);while(i){const p=(i-1)>>1;if(this.items[p].score<=item.score)break;this.items[i]=this.items[p];i=p;}this.items[i]=item;}pop(){const first=this.items[0],last=this.items.pop();if(this.items.length){let i=0;while(i*2+1<this.items.length){let j=i*2+1;if(j+1<this.items.length&&this.items[j+1].score<this.items[j].score)j++;if(this.items[j].score>=last.score)break;this.items[i]=this.items[j];i=j;}this.items[i]=last;}return first;}get length(){return this.items.length;}}
  function simplify(points){const out=[];for(const p of points){const last=out.at(-1),before=out.at(-2);if(last&&Math.abs(last.x-p.x)<.01&&Math.abs(last.y-p.y)<.01)continue;if(before&&((before.x===last.x&&last.x===p.x)||(before.y===last.y&&last.y===p.y)))out.pop();out.push(p);}return out;}
  function routeOne(e,nodes,parallel=[],used=[]){
    const a=nodes.find(n=>n.id===e.source),b=nodes.find(n=>n.id===e.target);
    const ac={x:a.x+a.width/2,y:a.y+a.height/2},bc={x:b.x+b.width/2,y:b.y+b.height/2};
    const side=(n,s)=>s==='r'?{x:n.x+n.width,y:n.y+n.height/2}:s==='l'?{x:n.x,y:n.y+n.height/2}:s==='b'?{x:n.x+n.width/2,y:n.y+n.height}:{x:n.x+n.width/2,y:n.y};
    const stub=(p,s)=>({x:p.x+(s==='r'?4:s==='l'?-4:0),y:p.y+(s==='b'?4:s==='t'?-4:0)});
    const horizontal=Math.abs(bc.x-ac.x)>Math.abs(bc.y-ac.y);
    const sa=horizontal?(bc.x>ac.x?'r':'l'):(bc.y>ac.y?'b':'t');
    const sb={r:'l',l:'r',t:'b',b:'t'}[sa];
    const start=side(a,sa),end=side(b,sb);
    // Different relations between the same pair need their own entry/exit ports.
    if(parallel.length>1){
      const extent=horizontal?Math.min(a.height,b.height):Math.min(a.width,b.width);
      const offset=(parallel.findIndex(item=>item.id===e.id)-(parallel.length-1)/2)*Math.min(8,(extent-12)/(parallel.length-1));
      start[horizontal?'y':'x']+=offset;end[horizontal?'y':'x']+=offset;
    }
    const s=stub(start,sa),t=stub(end,sb);
    const tracks=parallel.length>1?used.flatMap(edge=>edge.points):[];
    const xs=[...new Set([s.x,t.x,...nodes.flatMap(n=>[n.x-4,n.x+n.width+4]),...tracks.flatMap(p=>[p.x-6,p.x+6])])].sort((x,y)=>x-y);
    const ys=[...new Set([s.y,t.y,...nodes.flatMap(n=>[n.y-4,n.y+n.height+4]),...tracks.flatMap(p=>[p.y-6,p.y+6])])].sort((x,y)=>x-y);
    const sharedLength=(p,q)=>{
      let length=0;
      for(const edge of used)for(let i=1;i<edge.points.length;i++){
        const a=edge.points[i-1],b=edge.points[i],vertical=p.x===q.x;
        if(vertical!==(a.x===b.x)||(vertical?p.x!==a.x:p.y!==a.y))continue;
        const axis=vertical?'y':'x';
        length+=Math.max(0,Math.min(Math.max(p[axis],q[axis]),Math.max(a[axis],b[axis]))-Math.max(Math.min(p[axis],q[axis]),Math.min(a[axis],b[axis])));
      }
      return length;
    };
    const width=xs.length,begin=ys.indexOf(s.y)*width+xs.indexOf(s.x),goal=ys.indexOf(t.y)*width+xs.indexOf(t.x);
    const point=id=>({x:xs[id%width],y:ys[Math.floor(id/width)]});
    const cost=new Map([[begin,0]]),previous=new Map(),heap=new Heap(),done=new Set();
    heap.push({id:begin,score:0});
    while(heap.length){const {id}=heap.pop();if(done.has(id))continue;done.add(id);if(id===goal){const path=[];let cursor=id;while(cursor!==undefined){path.unshift(point(cursor));cursor=previous.get(cursor);}return simplify([start,...path,end]);}
      const x=id%width,y=Math.floor(id/width),p=point(id);
      for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
        if(nx<0||nx>=width||ny<0||ny>=ys.length)continue;const next=ny*width+nx,q=point(next);
        if(nodes.some(n=>segmentHits(p,q,n)))continue;
        const g=cost.get(id)+Math.abs(q.x-p.x)+Math.abs(q.y-p.y)+(parallel.length>1?sharedLength(p,q)*20:0);
        if(g<(cost.get(next)??Infinity)){cost.set(next,g);previous.set(next,id);heap.push({id:next,score:g+Math.abs(q.x-t.x)+Math.abs(q.y-t.y)});}
      }
    }
    throw new Error('无法为关联安排不穿过节点的连线');
  }
  async function bilateral(data,elk){
    const ix=index(data),root=data.nodes.find(n=>n.id===ix.roots[0]),branches=ix.children.get(root.id);
    if(!branches.length)return {nodes:[{...root,x:0,y:0}],edges:[],bounds:bounds([{...root,x:0,y:0}]),kind:'bilateral'};
    const weights=branches.map(id=>data.nodes.find(n=>n.id===id).branchWeight??[...descendants(id,ix)].reduce((sum,n)=>sum+(!ix.children.get(n).length?1:0),0));
    let chosen=1,best=Infinity;
    if(branches.length<17){for(let mask=1;mask<(1<<branches.length)-1;mask++){let a=0,b=0;weights.forEach((w,i)=>{if(mask&(1<<i))a+=w;else b+=w;});if(Math.abs(a-b)<best){best=Math.abs(a-b);chosen=mask;}}}
    const sides=[new Set([root.id]),new Set([root.id])];let sums=[0,0];
    branches.forEach((id,i)=>{const side=branches.length<17?(chosen&(1<<i)?0:1):(sums[0]<=sums[1]?0:1);sums[side]+=weights[i];for(const child of descendants(id,ix))sides[side].add(child);});
    const layouts=[];
    for(let i=0;i<2;i++){const ids=sides[i];const part={nodes:data.nodes.filter(n=>ids.has(n.id)),edges:data.edges.filter(e=>primary(e)&&ids.has(e.source)&&ids.has(e.target))};layouts.push(await layered(part,i?'RIGHT':'LEFT',elk,true));}
    const nodes=[],edges=[];
    layouts.forEach((layout,i)=>{const origin=layout.nodes.find(n=>n.id===root.id);const dx=-origin.x-root.width/2,dy=-origin.y-root.height/2;
      for(const n of layout.nodes)if(i===0||n.id!==root.id)nodes.push({...n,x:n.x+dx,y:n.y+dy});
      for(const e of layout.edges)edges.push({...e,points:e.points.map(p=>({x:p.x+dx,y:p.y+dy}))});});
    const secondary=data.edges.filter(e=>!primary(e)).sort((a,b)=>a.id.localeCompare(b.id));
    for(const e of secondary){
      const parallel=secondary.filter(other=>(other.source===e.source&&other.target===e.target)||(other.source===e.target&&other.target===e.source));
      edges.push({...e,points:routeOne(e,nodes,parallel,edges.filter(other=>parallel.some(p=>p.id===other.id)))});
    }
    return {nodes,edges,bounds:bounds(nodes,edges),kind:'bilateral'};
  }
  async function layout(data,mode,elk){
    const ix=index(data);
    if((mode==='auto'||mode==='bilateral')&&isTree(data)&&ix.children.get(ix.roots[0]).length>1)return bilateral(data,elk);
    return layered(data,mode==='down'?'DOWN':'RIGHT',elk);
  }
  scope.GraphLayout={index,visible,isTree,layout,segmentHits,bounds,simplify};
  if(typeof module!=='undefined')module.exports=scope.GraphLayout;
})(typeof self!=='undefined'?self:globalThis);
