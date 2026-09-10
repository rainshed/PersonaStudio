import test from 'node:test';
import assert from 'node:assert/strict';
import {hierarchyIndex, visibleNodes, ancestors, layoutVisible, routeEdges, segmentHitsCard, segmentOverlap, relationSections, groupConnections, belongsTo, revealAncestors} from '../src/ai_persona/static/knowledge-graph-model.mjs';

const node = (id, depth = 0, cluster = '0', order = 0, contextual = false) => ({id, depth, cluster, order, contextual, width:236, height:112});
const edge = (source, target, type = 'broader_than', id = `${source}-${target}-${type}`) => ({id, source, target, type});
const chain = [node('root'), node('middle',1), node('leaf',2), node('deep',3)];
const chainEdges = [edge('root','middle'), edge('middle','leaf'), edge('leaf','deep')];

test('folding follows hierarchy only and preserves independent concepts', () => {
  const nodes = [...chain, node('method',0,'0',1,true), node('isolated',0,'1')];
  const edges = [...chainEdges, edge('method','deep','applied_in')];
  const index = hierarchyIndex(nodes, edges);
  assert.deepEqual([...visibleNodes(index,new Set(['root']))].sort(), ['isolated','method','middle','root']);
  assert.deepEqual([...visibleNodes(index,new Set())].sort(), ['isolated','method','root']);
});

test('a shared child remains visible through any expanded parent path', () => {
  const nodes = ['root','left','right','shared'].map(id=>node(id));
  const edges = [edge('root','left'),edge('root','right'),edge('left','shared'),edge('right','shared')];
  const index = hierarchyIndex(nodes,edges);
  assert.equal(visibleNodes(index,new Set(['root','left'])).has('shared'),true);
  assert.equal(visibleNodes(index,new Set(['root','right'])).has('shared'),true);
  assert.equal(visibleNodes(index,new Set(['root'])).has('shared'),false);
  assert.deepEqual([...ancestors(index,'shared')].sort(),['left','right','root']);
});

test('search can reveal an arbitrary deep concept without expanding its children', () => {
  const index = hierarchyIndex(chain,chainEdges);
  const opened = ancestors(index,'leaf');
  const visible = visibleNodes(index,opened);
  assert.equal(visible.has('leaf'),true);
  assert.equal(visible.has('deep'),false);
  assert.deepEqual([...opened].sort(),['middle','root']);
});

test('collapsing shrinks the tree without inventing parents for unrelated records', () => {
  const nodes = [...chain,node('method',0,'related:methods',2,true)];
  const edges = [...chainEdges,edge('method','deep','applied_in')];
  const index = hierarchyIndex(nodes,edges);
  const full = layoutVisible(nodes,edges,new Set(nodes.map(n=>n.id)));
  const folded = layoutVisible(nodes,edges,visibleNodes(index,new Set(['root'])));
  assert.ok(folded.bounds[3]<full.bounds[3]);
  assert.equal(folded.positions.get('method').y,full.positions.get('method').y);
  const scoped = layoutVisible(nodes,edges,visibleNodes(index,new Set(['root'])),'0');
  assert.equal(scoped.positions.has('method'),false);
  assert.equal(scoped.positions.size,2);
  assert.equal(folded.routes.size,1);
});

test('group filtering counts each shared node once and produces non-overlapping cards', () => {
  const nodes = [...chain,node('other',0,'1'),node('sibling',1,'0',2)];
  const edges = [...chainEdges,edge('root','sibling')];
  const result = layoutVisible(nodes,edges,new Set(nodes.map(n=>n.id)),'0');
  assert.equal(result.positions.size,5);
  assert.equal(result.clusters.length,1);
  const placed=[...result.positions.values()];
  for(let a=0;a<placed.length;a++) for(let b=a+1;b<placed.length;b++) {
    const p=placed[a],q=placed[b];
    assert.ok(p.x+p.width<=q.x||q.x+q.width<=p.x||p.y+p.height<=q.y||q.y+q.height<=p.y);
  }
});

test('routes avoid cards across skipped levels, upward links and same-level links', () => {
  const nodes = [node('root'),node('blocker',1),node('leaf',2),node('left',1,'0',-1),node('right',1,'0',1)];
  const edges=[edge('root','leaf'),edge('leaf','root','requires'),edge('left','right','related_to'),edge('leaf','left','applied_in')];
  const result=layoutVisible(nodes,edges,new Set(nodes.map(n=>n.id)));
  assert.equal(result.routes.size,edges.length);
  for(const route of result.routes.values()) for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1],b=route.points[i];
    assert.ok(a[0]===b[0]||a[1]===b[1]);
    for(const card of result.positions.values()) assert.equal(segmentHitsCard(a,b,card),false);
  }
  for(const route of result.routes.values()) for(const [x,y] of route.points) {
    const [left,top,width,height]=result.bounds;
    assert.ok(x>=left&&x<=left+width&&y>=top&&y<=top+height);
  }
});

test('different relations between the same concepts retain separate ports', () => {
  const nodes=[{...node('a'),x:40,y:68},{...node('b'),x:316,y:224}];
  const routes=routeEdges([edge('a','b','requires'),edge('a','b','applied_in')],nodes);
  assert.notEqual(routes.get('a-b-requires').path,routes.get('a-b-applied_in').path);
});

test('preview sections explain the direction of every supported relation', () => {
  const edges=[edge('parent','subject'),edge('subject','child'),edge('subject','needed','requires'),
    edge('dependent','subject','requires'),edge('subject','context','applied_in'),edge('method','subject','applied_in'),edge('peer','subject','related_to')];
  assert.deepEqual(Object.fromEntries(relationSections('subject',edges)),{
    parents:['parent'],children:['child'],prerequisites:['needed'],dependents:['dependent'],
    applications:['context'],appliedConcepts:['method'],related:['peer']});
});

test('an empty workspace has valid finite bounds', () => {
  const layout=layoutVisible([],[],new Set());
  assert.equal(layout.positions.size,0);
  assert.ok(layout.bounds.every(Number.isFinite));
});


test('separate trees reserve contiguous subtrees despite cross-group applications', () => {
  const nodes=[node('physics'),node('thermal',1),node('transport',1),node('eth',2),node('super',2),
    node('numerical',0,'methods'),node('ed',1,'methods'),node('tensor',1,'methods')];
  const edges=[edge('physics','thermal'),edge('physics','transport'),edge('thermal','eth'),edge('transport','super'),
    edge('numerical','ed'),edge('numerical','tensor')];
  const visible=new Set(nodes.map(n=>n.id));
  const base=layoutVisible(nodes,edges,visible);
  const application=edge('tensor','super','applied_in');
  const updated=layoutVisible(nodes,[...edges,application],visible);
  assert.deepEqual(updated.positions,base.positions);
  for(const e of edges)assert.deepEqual(updated.routes.get(e.id),base.routes.get(e.id));
  const p=updated.positions;
  assert.ok(p.get('eth').x<p.get('super').x);
  assert.ok(Math.max(...['physics','thermal','transport','eth','super'].map(id=>p.get(id).x+236))<p.get('ed').x);
  const connections=groupConnections(nodes,[...edges,application],'0');
  assert.deepEqual([...connections.get('methods')],['tensor']);
});

test('independent branches never share line segments, including adversarial interleaved cards', () => {
  // This exact shape used to produce the false join after adding a numerical-method root.
  const cards=[{...node('physics'),x:560,y:68},{...node('numerical'),x:280,y:68},
    {...node('thermal',1),x:140,y:252},{...node('ed',1),x:0,y:252},{...node('tensor',1),x:420,y:252}];
  const edges=[edge('physics','thermal'),edge('numerical','ed'),edge('numerical','tensor')];
  const routes=routeEdges(edges,cards);
  assertRoutes(routes,edges,cards);
});

function assertRoutes(routes, edges, cards) {
  for(const [id,route] of routes) for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1],b=route.points[i];
    for(const card of cards)assert.equal(segmentHitsCard(a,b,card),false,`${id} crosses ${card.id}`);
    for(const [otherId,otherRoute] of routes) {
      if(id>=otherId)continue;
      const edge=edges.find(e=>e.id===id),other=edges.find(e=>e.id===otherId);
      if([edge.source,edge.target].some(n=>n===other.source||n===other.target))continue;
      for(let j=1;j<otherRoute.points.length;j++)assert.equal(segmentOverlap(a,b,otherRoute.points[j-1],otherRoute.points[j]),0,`${id} merges with ${otherId}`);
    }
  }
}

test('multi-parent DAG remains routable in every folding and group state', () => {
  const nodes=[node('physics'),node('thermal',1),node('transport',1),node('scars',2),node('super',2),node('pxp',3),node('nodal',3),
    node('numerical',0,'methods'),node('ed',1,'methods'),node('tensor',1,'methods'),
    node('levy',0,'related:methods',0,true),node('wigner',0,'related:methods',0,true)];
  const edges=[edge('physics','thermal'),edge('physics','transport'),edge('thermal','scars'),edge('transport','super'),
    edge('scars','pxp'),edge('super','pxp'),edge('super','nodal'),edge('numerical','ed'),edge('numerical','tensor'),
    edge('tensor','super','applied_in'),edge('ed','scars','applied_in'),edge('levy','super','applied_in'),edge('wigner','nodal','applied_in')];
  const index=hierarchyIndex(nodes,edges),parents=nodes.filter(n=>index.children.get(n.id).length);
  for(let mask=0;mask<2**parents.length;mask++) {
    const visible=visibleNodes(index,new Set(parents.filter((_,i)=>mask&(1<<i)).map(n=>n.id)));
    for(const group of ['all','0','methods','related:methods']) {
      const result=layoutVisible(nodes,edges,visible,group),cards=[...result.positions.values()];
      assertRoutes(result.routes,edges,cards);
      for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++) {
        const a=cards[i],b=cards[j];
        assert.ok(a.x+236<=b.x||b.x+236<=a.x||a.y+112<=b.y||b.y+112<=a.y);
      }
    }
  }
});


test('methods follow the visibility of application targets and search reveals them together', () => {
  const nodes=[...chain,{...node('method',0,'0',0,true),groups:['0'],anchors:['leaf']}];
  const edges=[...chainEdges,edge('method','leaf','applied_in')];
  const index=hierarchyIndex(nodes,edges);
  const closed=layoutVisible(nodes,edges,visibleNodes(index,new Set(['root'])),'0');
  assert.equal(closed.positions.has('method'),false);
  const opened=revealAncestors(nodes,index,'method','0');
  const shown=layoutVisible(nodes,edges,visibleNodes(index,opened),'0');
  assert.ok(shown.positions.has('method')&&shown.positions.has('leaf'));
  assert.equal(shown.positions.has('deep'),false);
  assert.equal(shown.positions.get('method').y,shown.positions.get('leaf').y);
  assert.ok(shown.positions.get('method').x>shown.positions.get('leaf').x);
  assert.ok(shown.clusters[0].contextBox);
  assert.ok(shown.routes.has('method-leaf-applied_in'));
  assertRoutes(shown.routes,edges,[...shown.positions.values()]);
});

test('shared contextual records are available in both groups and counted once in overview', () => {
  const nodes=[node('physics',0,'physics'),node('transport',1,'physics'),node('numerical',0,'numerical'),node('ed',1,'numerical'),
    {...node('tool',0,'physics',0,true),groups:['physics','numerical'],anchors:['transport','ed']}];
  const edges=[edge('physics','transport'),edge('numerical','ed'),edge('tool','transport','applied_in'),edge('tool','ed','applied_in')];
  const index=hierarchyIndex(nodes,edges),all=new Set(nodes.map(n=>n.id));
  for(const group of ['physics','numerical']) {
    const layout=layoutVisible(nodes,edges,all,group);
    assert.equal(layout.positions.size,3);
    assert.ok(layout.positions.has('tool'));
    assert.equal(layout.positions.get('tool').displayGroup,group);
    assertRoutes(layout.routes,edges,[...layout.positions.values()]);
  }
  assert.equal(layoutVisible(nodes,edges,all).positions.size,5);
  // In overview it accompanies the visible application when the home branch closes.
  const visible=visibleNodes(index,new Set(['numerical']));
  assert.equal(layoutVisible(nodes,edges,visible).positions.get('tool').displayGroup,'numerical');
  assert.ok(belongsTo(nodes.at(-1),'numerical'));
  assert.deepEqual([...revealAncestors(nodes,index,'tool','numerical')],['numerical']);
});


test('application links can choose another track when a hierarchy bus occupies their row', () => {
  const cards=[{...node('parent'),x:0,y:436},{...node('child'),x:600,y:620},
    {...node('problem'),x:300,y:620},{...node('method'),x:1000,y:620},{...node('other'),x:1400,y:620}];
  const edges=[edge('parent','child','broader_than','a'),edge('method','problem','applied_in','b'),edge('other','method','related_to','c')];
  const routes=routeEdges(edges,cards);
  assert.equal(routes.size,3);
  assertRoutes(routes,edges,cards);
});
