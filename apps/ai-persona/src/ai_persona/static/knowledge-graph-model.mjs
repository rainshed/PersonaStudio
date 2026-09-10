// Pure graph operations shared by the interactive canvas and its regression tests.
export function hierarchyIndex(nodes, edges) {
  const parents = new Map(nodes.map(node => [node.id, []]));
  const children = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    if (edge.type !== 'broader_than') continue;
    children.get(edge.source).push(edge.target);
    parents.get(edge.target).push(edge.source);
  }
  return { parents, children, roots: nodes.filter(node => !parents.get(node.id).length).map(node => node.id) };
}

export function visibleNodes(index, expanded) {
  const visible = new Set();
  const pending = [...index.roots];
  while (pending.length) {
    const id = pending.pop();
    if (visible.has(id)) continue;
    visible.add(id);
    if (expanded.has(id)) pending.push(...index.children.get(id));
  }
  return visible;
}

export function ancestors(index, id) {
  const result = new Set();
  const pending = [...(index.parents.get(id) ?? [])];
  while (pending.length) {
    const parent = pending.pop();
    if (result.has(parent)) continue;
    result.add(parent);
    pending.push(...index.parents.get(parent));
  }
  return result;
}

export function relationSections(id, edges) {
  const sections = new Map();
  const names = { broader_than: ['children', 'parents'], requires: ['prerequisites', 'dependents'],
    applied_in: ['applications', 'appliedConcepts'], related_to: ['related', 'related'] };
  for (const edge of edges) {
    if (edge.source !== id && edge.target !== id) continue;
    const outgoing = edge.source === id;
    const key = names[edge.type][outgoing ? 0 : 1];
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(outgoing ? edge.target : edge.source);
  }
  return sections;
}

export function belongsTo(node, group) {
  return group === 'all' || (node.groups ?? [node.cluster]).includes(group);
}

// Reveal the actual application targets of a contextual method, then its card.
export function revealAncestors(nodes, index, id, group = 'all') {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const node = byId.get(id);
  const result = ancestors(index, id);
  for (const target of node?.anchors ?? []) {
    if (!belongsTo(byId.get(target), group)) continue;
    for (const parent of ancestors(index, target)) result.add(parent);
  }
  return result;
}

export function groupConnections(nodes, edges, group) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const groups = new Map();
  if (group === 'all') return groups;
  for (const edge of edges) {
    if (edge.type === 'broader_than') continue;
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (belongsTo(source, group) === belongsTo(target, group)) continue;
    const other = belongsTo(source, group) ? target : source;
    for (const destination of other.groups ?? [other.cluster]) {
      if (!groups.has(destination)) groups.set(destination, new Set());
      groups.get(destination).add(other.id);
    }
  }
  return groups;
}

export function layoutVisible(nodes, edges, visible, group = 'all') {
  const allById = new Map(nodes.map(node => [node.id, node]));
  const displayGroups = new Map();
  const active = nodes.filter(node => {
    if (!belongsTo(node, group)) return false;
    if (!node.contextual || !node.anchors?.length) {
      displayGroups.set(node.id, group === 'all' ? node.cluster : group);
      return visible.has(node.id);
    }
    const anchors = node.anchors.map(id => allById.get(id)).filter(target => visible.has(target.id) && belongsTo(target, group));
    if (!anchors.length) return false;
    const destination = group !== 'all' ? group : anchors.find(target => target.cluster === node.cluster)?.cluster ?? anchors[0].cluster;
    displayGroups.set(node.id, destination);
    return true;
  });
  const positions = new Map(), clusters = [];
  const index = hierarchyIndex(nodes, edges);
  const compare = (a, b) => (a.title ?? a.id).toLowerCase().localeCompare((b.title ?? b.id).toLowerCase()) || a.id.localeCompare(b.id);
  let cursor = 40;
  for (const cluster of new Set(active.map(node => displayGroups.get(node.id)))) {
    const members = active.filter(node => displayGroups.get(node.id) === cluster);
    const core = members.filter(node => !node.contextual);
    const context = members.filter(node => node.contextual);
    const byId = new Map(core.map(node => [node.id, node]));
    const local = new Map();
    let width = 236, contextBox = null;
    if (!core.length) {
      // A standalone connected collection retains its own concepts and relations.
      const columns = Math.min(3, members.length);
      width = columns * 236 + (columns - 1) * 48;
      members.sort(compare).forEach((node, i) => local.set(node.id, {x:(i % columns) * 284, y:68 + Math.floor(i / columns) * 184}));
    } else {
      const owned = new Map(core.map(node => [node.id, []]));
      const roots = [];
      for (const node of core) {
        const parents = index.parents.get(node.id).filter(id => byId.has(id)).map(id => byId.get(id));
        parents.sort((a,b) => b.depth - a.depth || compare(a,b));
        if (parents.length) owned.get(parents[0].id).push(node);
        else roots.push(node);
      }
      roots.sort(compare);
      for (const children of owned.values()) children.sort(compare);
      const widths = new Map();
      function measure(node) {
        const children = owned.get(node.id);
        const span = Math.max(node.width, children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0,children.length-1) * 48);
        widths.set(node.id, span);
        return span;
      }
      const depths = [...new Set(core.map(node=>node.depth))].sort((a,b)=>a-b);
      function place(node, left) {
        local.set(node.id, {x:left+(widths.get(node.id)-node.width)/2, y:68+depths.indexOf(node.depth)*184});
        for (const child of owned.get(node.id)) {
          place(child,left);
          left += widths.get(child.id)+48;
        }
      }
      width = roots.reduce((sum,root)=>sum+measure(root),0)+Math.max(0,roots.length-1)*48;
      let left = 0;
      for (const root of roots) { place(root,left); left+=widths.get(root.id)+48; }
      if (context.length) {
        const anchorRow = node => {
          const rows = (node.anchors ?? []).filter(id => local.has(id)).map(id => (local.get(id).y - 68) / 184);
          return rows.length ? Math.min(...rows) : depths.length;
        };
        context.sort((a,b) => anchorRow(a) - anchorRow(b) || compare(a,b));
        const x = width + 96;
        let row = -1;
        for (const node of context) {
          row = Math.max(row+1, anchorRow(node));
          local.set(node.id, {x,y:68+row*184});
        }
        const top = Math.min(...context.map(node=>local.get(node.id).y))-36;
        const bottom = Math.max(...context.map(node=>local.get(node.id).y+node.height))+16;
        contextBox = {x:cursor+x-16,y:top,width:268,height:bottom-top};
        width = x + 236;
      }
    }
    let bottom = 0;
    for (const node of members) {
      const position = {...node, ...local.get(node.id), displayGroup:cluster};
      position.x += cursor;
      positions.set(node.id, position);
      bottom = Math.max(bottom, position.y + node.height);
    }
    clusters.push({id:cluster,x:cursor-24,y:16,width:width+48,height:bottom+8,count:members.length,contextBox});
    cursor += width+104;
  }
  const routes = routeEdges(edges.filter(edge => positions.has(edge.source) && positions.has(edge.target)), [...positions.values()]);
  const allX = [...positions.values()].flatMap(node => [node.x, node.x + node.width]);
  const allY = [...positions.values()].flatMap(node => [node.y, node.y + node.height]);
  for (const route of routes.values()) for (const point of route.points) { allX.push(point[0]); allY.push(point[1]); }
  const right = Math.max(300, ...allX) + 40;
  const bottom = Math.max(240, ...allY) + 40;
  const left = Math.min(0, ...allX.map(x => x - 24));
  const top = Math.min(0, ...allY.map(y => y - 24));
  return { positions, clusters, routes, bounds: [left, top, right - left, bottom - top] };
}

export function segmentHitsCard(a, b, node, padding = 0) {
  const left = node.x - padding, right = node.x + node.width + padding;
  const top = node.y - padding, bottom = node.y + node.height + padding;
  if (a[0] === b[0]) return a[0] > left && a[0] < right && Math.max(a[1], b[1]) > top && Math.min(a[1], b[1]) < bottom;
  return a[1] > top && a[1] < bottom && Math.max(a[0], b[0]) > left && Math.min(a[0], b[0]) < right;
}

function simplify(points) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const previous = result.at(-2);
    if (previous && ((previous[0] === last[0] && last[0] === point[0]) ||
        (previous[1] === last[1] && last[1] === point[1]))) result.pop();
    result.push(point);
  }
  return result;
}

function roundedPath(points) {
  const commands = [`M ${points[0].join(' ')}`];
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1], point = points[i], after = points[i + 1];
    const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    const radius = Math.min(6, distance(before, point) / 2, distance(point, after) / 2);
    const approach = point.map((value, axis) => value + Math.sign(before[axis] - value) * radius);
    const departure = point.map((value, axis) => value + Math.sign(after[axis] - value) * radius);
    commands.push(`L ${approach.join(' ')} Q ${point.join(' ')} ${departure.join(' ')}`);
  }
  commands.push(`L ${points.at(-1).join(' ')}`);
  return commands.join(' ');
}

export function segmentOverlap(a, b, c, d) {
  const vertical = a[0] === b[0];
  if (vertical !== (c[0] === d[0]) || a[vertical ? 0 : 1] !== c[vertical ? 0 : 1]) return 0;
  const axis = vertical ? 1 : 0;
  return Math.max(0, Math.min(Math.max(a[axis],b[axis]),Math.max(c[axis],d[axis])) - Math.max(Math.min(a[axis],b[axis]),Math.min(c[axis],d[axis])));
}

export function routeEdges(edges, nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const routes = new Map(), used = [];
  // Hierarchy is routed first so adding a contextual edge never moves its ports.
  const sorted = [...edges].sort((a,b)=>Number(b.type==='broader_than')-Number(a.type==='broader_than') || a.id.localeCompare(b.id));
  const ports = new Map();
  function portKey(edge, source) {
    const node = byId.get(source ? edge.source : edge.target);
    const down = edge.type === 'broader_than' && byId.get(edge.target).y > byId.get(edge.source).y;
    return `${node.id}:${source && down ? 'bottom' : 'top'}`;
  }
  for (const edge of sorted) for (const source of [true,false]) {
    const key=portKey(edge,source);
    if (!ports.has(key)) ports.set(key,[]);
    ports.get(key).push(edge.id);
  }
  function port(edge, source) {
    const node=byId.get(source?edge.source:edge.target), key=portKey(edge,source), ids=ports.get(key);
    // Allocate hierarchy separately: adding a non-hierarchy relation preserves it.
    const kind=edges.filter(item=>ids.includes(item.id) && (item.type==='broader_than')===(edge.type==='broader_than')).sort((a,b)=>a.id.localeCompare(b.id));
    const index=kind.findIndex(item=>item.id===edge.id);
    const spread=Math.min(14,(edge.type==='broader_than'?120:60)/Math.max(1,kind.length-1));
    const offset=(index-(kind.length-1)/2)*spread+(edge.type==='broader_than'?0:70);
    return [node.x+node.width/2+offset,key.endsWith(':bottom')?node.y+node.height:node.y];
  }
  const lanes = [...new Set(nodes.flatMap(node => [node.x - 20, node.x + node.width + 20]))];
  const hierarchyCount=sorted.filter(edge=>edge.type==='broader_than').length;
  for (let edgeIndex=0;edgeIndex<sorted.length;edgeIndex++) {
    const edge=sorted[edgeIndex], source=byId.get(edge.source), target=byId.get(edge.target);
    const downward=edge.type==='broader_than'&&target.y>source.y;
    const start=port(edge,true),end=port(edge,false);
    const phase=edge.type==='broader_than'?(edgeIndex+1)/(hierarchyCount+1)*24:30+(edgeIndex-hierarchyCount+1)/(sorted.length-hierarchyCount+1)*18;
    const candidates=[];
    const outer=Math.min(...nodes.map(node=>node.x))-32-edgeIndex*5;
    // Alternate horizontal tracks are essential when an application approaches
    // a row from above and meets a hierarchy bus approaching from below.
    for (const offset of [0,6,-6,12,-12,18,-18,24,-24]) {
      const distance=12+phase+offset;
      if(distance<8||distance>64)continue;
      const exit=[start[0],start[1]+(downward?distance:-distance)];
      const entry=[end[0],end[1]-distance];
      const add=points=>{points.trackPenalty=Math.abs(offset)*6;candidates.push(points);};
      if(downward) {
        const middle=start[1]+distance;
        add([start,[start[0],middle],[end[0],middle],end]);
      }
      for(const lane of [start[0],end[0],...lanes.map(x=>x+phase/6),outer]) {
        add([start,exit,[lane,exit[1]],[lane,entry[1]],entry,end]);
      }
    }
    let best=null,bestScore=Infinity;
    for(const candidate of candidates) {
      const points=simplify(candidate);
      let score=points.length*10+candidate.trackPenalty,blocked=false;
      for(let i=1;i<points.length;i++) {
        const a=points[i-1],b=points[i];
        if(nodes.some(node=>segmentHitsCard(a,b,node,node.id===source.id||node.id===target.id?0:8))) {blocked=true;break;}
        score+=Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]);
        for(const {c,d,edge:other} of used) {
          const independent=![edge.source,edge.target].some(id=>id===other.source||id===other.target);
          if(independent&&segmentOverlap(a,b,c,d)>0) {blocked=true;break;}
          const vertical=a[0]===b[0];
          if(vertical!==(c[0]===d[0])) {
            const [v1,v2,h1,h2]=vertical?[a,b,c,d]:[c,d,a,b];
            if(v1[0]>Math.min(h1[0],h2[0])&&v1[0]<Math.max(h1[0],h2[0])&&h1[1]>Math.min(v1[1],v2[1])&&h1[1]<Math.max(v1[1],v2[1]))score+=36;
          }
        }
        if(blocked)break;
      }
      if(!blocked&&score<bestScore){best=points;bestScore=score;}
    }
    if(!best)throw new Error(`No unobstructed route for ${edge.id}`);
    let label=best[0],length=-1;
    for(let i=1;i<best.length;i++){
      const a=best[i-1],b=best[i];used.push({c:a,d:b,edge});
      const size=Math.abs(a[0]-b[0]);
      if(size>length){label=[(a[0]+b[0])/2,(a[1]+b[1])/2-8];length=size;}
    }
    routes.set(edge.id,{points:best,path:roundedPath(best),label});
  }
  return routes;
}
