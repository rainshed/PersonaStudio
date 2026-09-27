(() => {
  'use strict';
  const R=window.IdeaReferenceRules, $=id=>document.getElementById(id);
  const KEY='personastudio-research-workspace-demo-v2.1';
  const zh=document.documentElement.lang==='zh-CN', L=(a,b)=>zh?a:b;
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,fn,cls='button small')=>{const b=node('button',text,cls);b.type='button';b.onclick=fn;return b;};
  const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}};
  const trial=read(KEY,{}), projects=JSON.parse($('idea-projects-data')?.textContent||'[]'), imports=()=>read(KEY+':imports',{});
  const form=$('idea-editor'), field=name=>form?.elements.namedItem(name);
  let catalog=[], workspace='', loadError='', generation=0;
  let item=form?JSON.parse($('idea-data').textContent):null;
  const list=$('ideas-list-data')?JSON.parse($('ideas-list-data').textContent):[];
  const signal=n=>n.dispatchEvent(new Event('input',{bubbles:true}));
  const current=()=>({...item, body:field('body').value, related_refs:JSON.parse(field('related_refs_json').value)});
  const managed=r=>r.id.startsWith('res_kb_')||r.id.startsWith('res_project_');
  async function request(url,values){
    const response=await fetch(url,values===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(values)});
    const data=await response.json();if(!response.ok)throw Error(data.error?.message||L('无法读取，请重试。','Could not load. Please retry.'));return data;
  }
  const titleFor=(ref,record=item)=>R.get(ref.id)?.title||record?.resources?.find(r=>r.id==='res_kb_'+ref.id)?.title||ref.title;
  function fillProjects(select,selected,includeAll=false){
    if(!select)return;
    const available=new Map(projects.filter(p=>!p.archived||p.id===selected?.id).map(p=>[p.id,p]));
    if(selected&&!available.has(selected.id))available.set(selected.id,selected);
    if(!includeAll){select.replaceChildren(new Option(L('独立想法 · 暂不关联项目','Independent idea'),''));}
    for(const p of available.values())if(![...select.options].some(o=>o.value===p.id))select.add(new Option(p.title+(p.archived?' · 已归档':''),p.id));
    if(selected)select.value=selected.id;
  }
  function projectChanged(){
    const p=JSON.parse(field('project_json').value);fillProjects($('idea-project-select'),p);
    $('idea-project-select').value=p?.id||'';
    const create=$('idea-create-project');if(create){
      $('idea-project-action-label').textContent=p?L('进入项目','Open project'):L('升级为项目','Turn into project');
      create.title=L('先保存当前修改，再继续。','Saves your changes before continuing.');
      $('idea-project-heading').textContent=p?(projects.find(x=>x.id===p.id)?.title||p.title):L('准备好推进了吗？','Ready to move forward?');
      $('idea-project-help').textContent=p?L('这个想法已关联项目。继续记录判断，也可以进入项目安排下一步。','This idea belongs to a project. Keep your reasoning here and plan the next step there.'):L('点击顶部“升级为项目”，设定目标、安排待办并记录进展。原想法与历史会完整保留。','Use Turn into project above to set a goal, plan tasks and track progress. Your idea and history stay intact.');
    }
    const a=$('idea-open-project');a.hidden=!p;a.href=p?'/projects/#project/'+encodeURIComponent(p.id)+'/ideas':'#';
  }
  function renderRelated(){
    if(!form)return;
    const refs=R.related(current()), root=$('idea-related');root.replaceChildren();$('idea-reference-count').textContent=refs.length||'';
    for(const ref of refs){
      const r=R.get(ref.id), chip=node('div',null,'idea-ref-chip'+(!r||r.archived?' muted':''));
      chip.append(button((r?.kind==='material'?'▤ ':'◇ ')+titleFor(ref),()=>preview(ref.id,titleFor(ref)),'idea-ref-title'));
      if(ref.manual)chip.append(node('small',L('关联','Related')));
      if(ref.occurrences.length)chip.append(button(L('正文 '+ref.occurrences.length+' 处','Cited '+ref.occurrences.length),()=>{
        $('idea-write').click();const first=ref.occurrences[0];field('body').focus();field('body').setSelectionRange(first.start,first.end);field('body').scrollIntoView({block:'center'});
      },'text-link'));
      if(r?.archived)chip.append(node('small',L('已归档','Archived')));
      else if(!r&&!loadError&&catalog.length)chip.append(node('small',L('旧引用 / 不可用','Unavailable')));
      if(ref.manual){const remove=button('×',()=>{field('related_refs_json').value=JSON.stringify(current().related_refs.filter(id=>id!==ref.id));signal(field('related_refs_json'));},'idea-ref-remove');remove.setAttribute('aria-label',L('移除关联：','Remove: ')+titleFor(ref));chip.append(remove);}
      root.append(chip);
    }
    if(!refs.length)root.append(node('p',L('把已有知识和读过的材料放在这里，也可以在正文中引用它们。','Connect knowledge and reading materials, or cite them in your note.'),'field-help'));
    $('idea-library-status').textContent=loadError||'';
  }
  function renderList(){
    const choices=new Map();
    for(const i of list){
      const root=document.querySelector('[data-idea-links="'+i.id+'"]');if(!root)continue;root.replaceChildren();
      const excerpt=root.closest('.idea-row').querySelector('.material-summary');if(excerpt&&(i.closure?.summary||i.body))excerpt.textContent=R.stripCitations(i.closure?.summary||i.body).split('\n\n').filter(Boolean).slice(0,2).join(' · ').replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm,'').replace(/\*\*/g,'').slice(0,180);
      const local=projects.find(p=>p.id===i.project?.id);
      if(i.project)root.append(node('span',local?.title||i.project.title,'idea-project-pill'));
      const refs=R.related(i);
      refs.slice(0,3).forEach(ref=>root.append(node('span',(R.get(ref.id)?.kind==='material'?'▤ ':'◇ ')+titleFor(ref,i),'idea-list-ref')));
      if(refs.length>3)root.append(node('span','+'+(refs.length-3),'idea-list-ref'));
      refs.forEach(ref=>choices.set(ref.id,titleFor(ref,i)));
    }
    const select=$('idea-related-filter');if(!select)return;const selected=select.value;
    select.replaceChildren(new Option(L('全部知识与材料','All knowledge & materials'),''));
    choices.forEach((title,id)=>select.add(new Option(title,id)));select.value=selected;
    select.onchange=()=>{let count=0;for(const i of list){const row=document.querySelector('[data-idea="'+i.id+'"]');if(!row)continue;row.hidden=!!select.value&&!R.related(i).some(r=>r.id===select.value);if(!row.hidden)count++;}$('idea-related-filter-count').textContent=L('显示 '+count+' 个想法','Showing '+count+' ideas');};
  }
  async function loadLibrary(){
    try{const data=await request('/api/ideas/library');catalog=data.items;workspace=data.workspace_key;R.setLibrary(catalog);loadError='';}
    catch{loadError=L('知识库暂时不可用，已有引用仍保留。点击“添加关联”可重试。','Library unavailable. Existing references are preserved. Retry with Add related item.');}
    renderRelated();renderList();
  }
  function openDialog(title){const dialog=$('idea-reference-dialog');$('idea-reference-title').textContent=title;const content=$('idea-reference-content');content.replaceChildren();if(!dialog.open)dialog.showModal();return content;}
  async function preview(id,title){
    const turn=++generation, content=openDialog(title||R.get(id)?.title||id);content.append(node('p',L('正在读取…','Loading…')));
    try{
      const r=await request('/api/ideas/library/'+encodeURIComponent(id));if(turn!==generation)return;content.replaceChildren();
      $('idea-reference-title').textContent=r.title;
      content.append(node('p',(r.kind==='material'?L('材料','Material'):L('知识点','Knowledge'))+' · '+r.path+(r.archived?' · 已归档':''),'field-help'));
      if(r.summary)content.append(node('p',r.summary,'idea-reference-summary'));
      const body=node('pre',r.body||L('暂时没有更多正文。','No additional text.'),'idea-reference-body');content.append(body);
      const a=node('a',L('在知识库中打开 ↗','Open in library ↗'),'button');a.href=r.detail_url;a.target='_blank';a.rel='noopener noreferrer';content.append(a);
    }catch(e){if(turn===generation){content.replaceChildren(node('p',e.message));content.append(button(L('重试','Retry'),()=>preview(id,title)));}}
  }
  async function picker(mode){
    const body=field('body'), selection=[body.selectionStart,body.selectionEnd], turn=++generation;
    let content=openDialog(mode==='inline'?L('在正文中插入引用','Insert a citation'):L('添加相关知识与材料','Add related knowledge & materials'));
    if(!catalog.length){content.textContent=L('正在连接知识库…','Loading library…');await loadLibrary();if(turn!==generation)return;}
    content.replaceChildren();
    if(loadError){content.append(node('p',loadError),button(L('重试','Retry'),()=>picker(mode)));return;}
    content.append(node('p',mode==='inline'?L('选择一项，插入光标所在位置。正文引用会自动显示在关联区。','Choose an item to cite at the cursor.'):L('只建立“与它有关”的关系，可多选。正文已有的引用会自动合并显示。','Select related items. Citations are included automatically.'),'field-help'));
    const tools=node('div',null,'idea-picker-tools'), search=node('input'), kind=node('select');search.type='search';search.placeholder=L('搜索名称、别名、摘要…','Search title, aliases, summary…');search.setAttribute('aria-label',L('搜索知识与材料','Search library'));
    [[L('全部','All'),''],[L('知识','Knowledge'),'knowledge'],[L('材料','Materials'),'material']].forEach(([name,value])=>kind.add(new Option(name,value)));kind.setAttribute('aria-label',L('引用类型','Reference type'));tools.append(search,kind);content.append(tools);
    const results=node('div',null,'idea-picker-results'), selected=new Set(current().related_refs);content.append(results);
    const footer=node('div',null,'idea-dialog-actions');content.append(footer);
    const apply=button('',()=>{field('related_refs_json').value=JSON.stringify([...selected]);signal(field('related_refs_json'));$('idea-reference-dialog').close();},'button primary-button');
    if(mode==='manual')footer.append(apply);
    const paint=()=>{results.replaceChildren();apply.textContent=L('完成 · '+selected.size+' 项关联','Apply · '+selected.size+' related items');const words=search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const items=catalog.filter(r=>!r.archived&&(!kind.value||r.kind===kind.value)&&words.every(w=>[r.title,r.path,r.summary,...r.aliases,...r.tags].join(' ').toLowerCase().includes(w)));
      if(!items.length)results.append(node('p',L('没有匹配的内容，试试其他关键词。','No matches. Try another search.')));
      items.forEach(r=>{const row=node(mode==='manual'?'label':'button',null,'idea-picker-row');if(mode==='inline')row.type='button';
        if(mode==='manual'){const check=node('input');check.type='checkbox';check.checked=selected.has(r.id);check.onchange=()=>{if(check.checked)selected.add(r.id);else selected.delete(r.id);apply.textContent=L('完成 · '+selected.size+' 项关联','Apply · '+selected.size+' related items');};row.append(check);}
        const copy=node('span');copy.append(node('small',(r.kind==='knowledge'?L('知识','Knowledge'):L('材料','Material'))+' · '+r.path),node('strong',r.title),node('span',r.summary||'','idea-picker-summary'));row.append(copy);
        if(mode==='inline')row.onclick=()=>{body.setRangeText(R.makeCitation(r.id,r.title),...selection,'end');signal(body);$('idea-reference-dialog').close();$('idea-write').click();body.focus();};results.append(row);
      });
    };search.oninput=paint;kind.onchange=paint;paint();search.focus();
  }
  if(form){
    projectChanged();field('project_json').addEventListener('input',projectChanged);
    $('idea-project-select').onchange=()=>{const p=projects.find(p=>p.id===$('idea-project-select').value)||item.project;field('project_json').value=JSON.stringify($('idea-project-select').value&&p?{id:p.id,title:p.title}:null);signal(field('project_json'));};
    field('related_refs_json').addEventListener('input',renderRelated);field('body').addEventListener('input',renderRelated);
    $('idea-add-reference').onclick=()=>picker('manual');$('idea-insert-reference').onclick=()=>picker('inline');
    $('idea-reference-close').onclick=()=>{$('idea-reference-dialog').close();generation++;};$('idea-reference-dialog').addEventListener('cancel',()=>generation++);
    if(!item.revision){const requested=new URLSearchParams(location.search).get('project'), p=projects.find(p=>p.id===requested&&!p.archived);if(p){field('project_json').value=JSON.stringify({id:p.id,title:p.title});projectChanged();}}
    window.IdeaLinks={managed,values:()=>({related_refs:JSON.parse(field('related_refs_json').value),project:JSON.parse(field('project_json').value)}),saved(next){item=next;field('related_refs_json').value=JSON.stringify(next.related_refs);field('project_json').value=JSON.stringify(next.project);projectChanged();renderRelated();},renderInline(text,parent,plain){for(const token of R.inlineTokens(text)){if(token.kind==='code')parent.append(node('code',token.text));else if(token.kind==='ref')parent.append(button(token.title,()=>preview(token.id,token.title),'idea-inline-reference'));else plain(token.text,parent);}}};
    renderRelated();
  }else if($('ideas-list-data')){
    fillProjects($('idea-project-filter'),null,true);
    const requested=new URLSearchParams(location.search).get('project');if(requested)$('idea-project-filter').value=requested;
    const legacy=(trial.legacy_ideas||trial.ideas||[]).filter(i=>!i.id.startsWith('idea_'));
    if(legacy.length){$('idea-import-open').hidden=false;$('idea-import-open').onclick=()=>{const root=$('idea-import-list');root.replaceChildren();const known=imports();legacy.forEach(i=>{const label=node('label',null,'idea-import-row'), check=node('input');check.type='checkbox';check.value=i.id;check.disabled=!!known[i.id];const copy=node('span');copy.append(node('strong',i.title),node('small',(projects.find(p=>p.id===i.project)?.title||'独立想法')+(known[i.id]?' · 已导入':'')));label.append(check,copy);root.append(label);const details=node('details',null,'idea-import-preview');details.append(node('summary','查看原文与判断'));details.append(node('pre',(i.body||'无正文')+'\n\n探索状态：'+i.state+'\n判断：'+(i.verdict_note||'尚未判断')+(i.closure_note?'\n结束说明：'+i.closure_note:'')));root.append(details);});$('idea-import-dialog').showModal();};}
    $('idea-import-close').onclick=()=>$('idea-import-dialog').close();
    $('idea-import-confirm').onclick=async()=>{
      const selected=[...$('idea-import-list').querySelectorAll('input:checked')].map(n=>n.value);if(!selected.length){$('idea-import-message').textContent='请先选择需要导入的想法。';return;}
      const controls=[...$('idea-import-dialog').querySelectorAll('input,button')];controls.forEach(n=>n.disabled=true);
      try{
        if(!workspace){await loadLibrary();if(!workspace)throw Error('知识库连接失败，请重试。');}
        const known=imports(), formal=await request('/api/ideas');
        for(const id of selected){
          const i=legacy.find(x=>x.id===id), hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(workspace+'\n'+id));
          const target='idea_import_'+[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
          if(!formal.items.some(x=>x.id===target)){
            const project=projects.find(p=>p.id===i.project), ended=['closed','abandoned'].includes(i.state);
            const closure=ended?{outcome:i.state==='abandoned'?'abandoned':'partial',summary:i.closure_note||'从浏览器记录导入：本轮探索已结束，结果待补充。'}:null;
            const values={title:i.title,body:(i.body||'')+'\n\n---\n\n## 浏览器记录中的判断\n\n原探索状态：'+i.state+'\n\n原判断：'+(i.verdict||'unassessed')+'\n\n'+(i.verdict_note||'尚未填写判断说明。')+(i.closure_note?'\n\n结束说明：'+i.closure_note:'')+(i.related_refs?.length?'\n\n原关联标记：'+i.related_refs.join('、'):'')+(i.resources?.length?'\n\n原资源标记：'+i.resources.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('、'):''),novelty:i.novelty||'unknown',novelty_reason:i.novelty_reason||'',difficulty:i.difficulty||'unknown',difficulty_reason:i.difficulty_reason||'',status:i.archived?'archived':'active',execution_status:ended?'ended':i.state==='exploring'?'in_progress':'not_started',closure,related_refs:(i.related_refs||[]).filter(id=>catalog.some(r=>r.id===id&&!r.archived)),project:project?{id:project.id,title:project.title}:null};
            await request('/api/ideas/'+target,{expected_revision:0,values});
          }
          known[id]=target;localStorage.setItem(KEY+':imports',JSON.stringify(known));
        }
        location.assign('/ideas');
      }catch(e){$('idea-import-message').textContent=e.message+' 已成功导入的记录不会重复创建。';controls.forEach(n=>n.disabled=false);}
    };
    renderList();
  }
  loadLibrary();
})();
