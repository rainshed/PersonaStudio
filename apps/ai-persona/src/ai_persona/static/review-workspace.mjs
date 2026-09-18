import {mountKnowledgeGraph} from './knowledge-graph-view.mjs?v=20260911.review2';
const open = p => ['pending_review','deferred'].includes(p.status);
export class ReviewWorkspace {
  constructor(owner,eventId,container){
    Object.assign(this,{owner,eventId,container}); this.checked=new Set();this.current=null;this.graph=null;this.version=0;
    const n=owner.node,b=owner.button;
    this.root=n('section','','review-workspace');this.toolbar=n('div','','review-toolbar');
    this.mode=b('显示图谱',()=>{this.mapHost.hidden=!this.mapHost.hidden;this.mode.textContent=this.mapHost.hidden?'显示图谱':'收起图谱';if(!this.mapHost.hidden)this.draw().catch(e=>this.error(e.message));});
    this.selectAll=b('选择全部待审核',()=>{this.checked=new Set(this.result.proposals.filter(p=>open(p)&&!p.stale).map(p=>p.id));this.paintList();});
    this.clear=b('清空选择',()=>{this.checked.clear();this.paintList();});
    this.accept=b('通过所选',()=>this.batch());this.accept.className='button primary-button';
    this.context=n('label');this.expand=n('input');this.expand.type='checkbox';this.expand.onchange=()=>this.draw();this.context.append(this.expand,n('span','展开已有邻居'));
    this.toolbar.append(this.mode,this.selectAll,this.clear,this.accept,this.context);
    this.message=n('p','','review-message');this.message.setAttribute('role','status');this.message.tabIndex=-1;
    this.mapHost=n('div','','review-map');this.mapHost.hidden=true;
    this.columns=n('div','','review-columns');this.list=n('div','','review-item-list');this.list.setAttribute('aria-label','审核内容');this.rows=new Map();this.detail=n('div','','review-inspector');
    this.columns.append(this.list,this.detail);this.root.append(this.toolbar,this.message,this.mapHost,this.columns);container.replaceChildren(this.root);
  }
  render(roots){
    this.roots=roots;
    const ids=new Set(this.result.proposals.filter(open).map(p=>p.id));for(const id of this.checked)if(!ids.has(id))this.checked.delete(id);
    if(!this.result.proposals.some(p=>p.id===this.current))this.current=this.result.proposals.find(open)?.id||this.result.proposals[0]?.id;
    this.paintList();this.showDetail();this.draw().catch(e=>this.error(e.message));
  }
  select(id){const previous=this.current;this.current=id;this.showDetail();this.rows.get(previous)?.classList.remove('selected');this.rows.get(id)?.classList.add('selected');this.detail.scrollIntoView({block:'nearest',behavior:'smooth'});}
  showDetail(){const card=this.owner.cards.get(this.current);if(card&&this.detail.firstChild!==card.root)this.detail.replaceChildren(card.root);}
  paintList(){
    const n=this.owner.node;this.list.replaceChildren();this.rows.clear();
    for(const p of this.result.proposals){const row=n('div','','review-item');row.classList.toggle('selected',p.id===this.current);const check=n('input');check.type='checkbox';check.checked=this.checked.has(p.id);check.disabled=!open(p)||p.stale||this.processing;check.setAttribute('aria-label','选择 '+p.title);
      check.onchange=()=>{check.checked?this.checked.add(p.id):this.checked.delete(p.id);this.paintList();};
      const button=this.owner.button(p.title,()=>this.select(p.id));button.className='review-item-title';button.append(n('small',({knowledge_node:'知识点',material:'材料',relation:'关系'}[p.entity_type]||'内容')+' · '+({pending_review:'待审核',deferred:'稍后审核',accepted:'已通过',edited_and_accepted:'已通过',rejected:'已拒绝',stale:'已过期'}[p.status]||p.status)));
      row.append(check,button);this.list.append(row);this.rows.set(p.id,row);
    }
    const total=this.result.proposals.filter(open).length;
    this.accept.textContent=`通过所选（${this.checked.size}）`;this.accept.disabled=!this.checked.size||this.processing;this.selectAll.disabled=this.processing||!total;this.clear.disabled=this.processing||!this.checked.size;
    if(!this.processing)this.message.textContent=this.operationNote || `待审核 ${total} 项 · 已选 ${this.checked.size} 项。勾选内容后可一起通过；个人状态随通过保存。图中 × 可拒绝知识点及依赖它的待审核候选。`;
  }
  async draw(){
    if(this.mapHost.hidden)return;
    const source=this.result.graph;if(!source?.nodes.length)return;
    const proposals=new Map(this.result.proposals.map(p=>[p.id,p]));
    const nodes=source.nodes.map(node=>{const p=proposals.get(node.proposal_id);const rejectable=p?.entity_type==='knowledge_node'&&open(p);return {...node,rejectable,canReject:rejectable&&!this.processing&&!this.owner.batchPending&&!this.owner.cards.get(p?.id)?.pending,rejectCount:p?.pending_dependents.length||0};});
    const data={nodes:[...nodes,...(this.expand.checked?source.context_nodes||[]:[])],edges:[...source.edges,...(this.expand.checked?source.context_edges||[]:[])]};
    const key=JSON.stringify([this.eventId,data.nodes.map(n=>[n.id,n.title]),data.edges.map(e=>[e.id,e.source,e.target,e.type])]);
    if(this.graphKey===key){this.graph?.updateStatuses(data.nodes);return;}this.graphKey=key;const version=++this.version;
    this.graph?.destroy();this.graph=null;this.mapHost.replaceChildren(document.getElementById('review-graph-template').content.cloneNode(true));
    const panel=this.mapHost.querySelector('[data-knowledge-graph]');panel.dataset.workspace+=':review:'+this.eventId;
    const labels=JSON.parse(document.querySelector('[data-graph-labels]').textContent);labels.relation_labels={...labels.relation_labels,covers:'讨论',part_of:'属于',uses:'使用'};
    const graph=await mountKnowledgeGraph(panel,structuredClone(data),labels,{onReject:item=>this.rejectNode(item),onSelect:item=>{if(item.proposal_id)this.select(item.proposal_id);else if(item.href&&item.href!=='#'){const a=this.owner.node('a','查看已有记录 →');a.href=item.href;this.detail.replaceChildren(this.owner.node('h3',item.title||'已有关系'),a);}}});
    if(version!==this.version){graph?.destroy();return;}this.graph=graph;
  }
  error(message){this.operationNote=message;this.message.textContent=message;this.message.setAttribute('role','alert');this.message.focus({preventScroll:true});this.message.scrollIntoView({block:'nearest'});}
  async rejectNode(node){
    const p=this.result.proposals.find(p=>p.id===node.proposal_id);
    if(this.processing||this.owner.batchPending||!p||!open(p)||[...this.owner.cards.values()].some(c=>c.pending))return;
    this.processing=true;this.owner.batchPending=true;this.operationNote='正在拒绝“'+p.title+'”…';this.paintList();
    let failure;
    try{
      await this.draw();
      const draft=this.owner.drafts.get(p.id);
      const result=await this.owner.api(`${this.owner.reviewPath(this.eventId)}/${encodeURIComponent(p.id)}`,{action:'reject',revision:draft?.revision??p.revision,updates:{}});
      for(const item of result.proposals)if(!open(item)){this.owner.drafts.delete(item.id);this.checked.delete(item.id);}
      this.owner.render(this.eventId,this.container,result);
      this.operationNote='已拒绝“'+p.title+'”'+(p.pending_dependents.length?'，同时拒绝了 '+p.pending_dependents.length+' 条依赖它的候选':'')+'。';
      try{await this.owner.refresh();}catch(e){failure=this.operationNote+' 列表刷新失败：'+e.message;}
    }catch(e){failure='拒绝未能确认：'+e.message;await this.owner.load(this.eventId,this.container);}
    finally{this.processing=false;this.owner.batchPending=false;this.paintList();await this.draw();if(failure)this.error(failure);else this.message.setAttribute('role','status');}
  }
  async batch(){
    if(this.processing)return;this.operationNote=null;this.message.setAttribute("role","status");
    const selected=this.result.proposals.filter(p=>this.checked.has(p.id)&&open(p));
    const missing=new Set();const byId=new Map(this.result.proposals.map(p=>[p.id,p]));
    const collect=p=>{for(const d of p.dependencies){if(!this.checked.has(d.id)&&!missing.has(d.id)){missing.add(d.id);if(byId.has(d.id))collect(byId.get(d.id));}}};selected.forEach(collect);
    if(missing.size){for(const id of missing)this.checked.add(id);this.paintList();this.error('所选关系还需要这些内容：'+[...missing].map(id=>byId.get(id)?.title||id).join('、')+'。已加入选择，请核对后再次点击“通过所选”。');return;}
    for(const p of selected){const draft=this.owner.drafts.get(p.id);if(p.stale||draft?.invalid){this.select(p.id);this.error('请先修正当前候选，再通过所选内容。');return;}}
    this.processing=true;this.owner.batchPending=true;this.paintList();let saved=0, failure=null;
    try{
      // Server-provided proposal order is topological. Stop on any uncertainty, never replay a write.
      for(const p of selected){const draft=this.owner.drafts.get(p.id);const result=await this.owner.api(`${this.owner.reviewPath(this.eventId)}/${encodeURIComponent(p.id)}`,{action:'accept',revision:draft?.revision??p.revision,updates:draft?.updates||{}});saved++;this.owner.drafts.delete(p.id);this.checked.delete(p.id);this.owner.render(this.eventId,this.container,result);}
      this.message.textContent=`已通过并保存 ${saved} 项。`;await this.owner.refresh();
    }catch(e){failure=`已保存 ${saved} 项，后续尚未处理：${e.message}`;await this.owner.load(this.eventId,this.container);}
    finally{this.processing=false;this.owner.batchPending=false;this.paintList();if(failure)this.error(failure);else {this.operationNote=`已通过并保存 ${saved} 项。`;this.message.textContent=this.operationNote;}}
  }
  destroy(){this.version++;this.graph?.destroy();}
}
