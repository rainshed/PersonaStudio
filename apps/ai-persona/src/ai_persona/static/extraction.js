import {openContentReset} from './content-reset.mjs?v=1';
import {LearningReviewPanel} from './learning-review.mjs?v=20260911.review2';
/* Application-owned progress and proposals; no model-generated markup is rendered. */
(() => {
  'use strict';
  const $ = id => document.getElementById('ex-' + id);
  let current = null, defaults = null, busy = true, lastError = '', pollBusy = false, selectedRef = null;
  const labels = {draft:'待整理', ready:'待分析', importing:'正在导入', running:'正在整理', complete:'已完成', paused:'已暂停', failed:'未完成', duplicate:'重复材料', review:'等待审核', pending_review:'待审核', accepted:'已采纳', edited_and_accepted:'编辑后采纳', rejected:'已拒绝', deferred:'已延后', stale:'已过期', existing:'已有'};
  const el = (tag, text, cls) => {const n = document.createElement(tag); if(text !== undefined) n.textContent=text; if(cls)n.className=cls; return n;};
  function feedback(where, message, success=false) {const n=$(where+'-feedback');n.replaceChildren(el('span',message));n.classList.toggle('success',success);n.setAttribute('role',success?'status':'alert');if(!success){n.focus({preventScroll:true});n.scrollIntoView({block:'nearest',behavior:'smooth'});}}
  async function api(path='', data) {const r=await fetch('/api/extraction'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-AI-Persona':'1'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});let body;try{body=await r.json();}catch{throw Error('服务未返回有效结果，请检查 Studio 是否仍在运行。');}if(!r.ok || body.ok===false)throw Error(body.error?.message||'操作未完成，请稍后重试。');return body;}
  async function action(where, fn) {if(busy)return;busy=true;controls();try{await fn();}catch(e){feedback(where,e.message);}finally{busy=false;controls();document.querySelector('.ex-compose').dispatchEvent(new Event('input',{bubbles:true}));}}
  function policy() {const raw=$('max').value.trim();if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>100)throw Error('新增知识点上限请输入 1–100 的整数。');return {goal:$('goal').value.trim(),knowledge:$('knowledge').value.trim(),relations:$('relations').value.trim(),collect_materials:$('collect').checked,output_language:$('language').value,focus:$('focus').value.trim(),reading:'targeted',max_nodes:Number($('max').value),phase_timeout_seconds:Number($('time').value)*60};}
  function fillPolicy(p) {$('goal').value=p.goal;$('knowledge').value=p.knowledge;$('relations').value=p.relations;$('collect').checked=p.collect_materials;$('focus').value=p.focus||'';$('language').value=p.output_language||'zh';$('reading').value=p.reading||'targeted';$('max').value=p.max_nodes;$('time').value=p.phase_timeout_seconds/60;budgetSummary();}
  function budgetSummary(){const raw=$('max').value.trim(),n=Number(raw),count=current?.members.filter(m=>!m.removed&&!m.duplicate_of).length||0;const valid=/^\d+$/.test(raw)&&n>=1&&n<=100;$('budget-summary').textContent=(count?count+' 份材料 · ':'')+(valid?'最多新增 '+n+' 个知识点':'请输入 1–100 的整数')+(valid&&count>1&&n<count?'（上限较低，重要概念可能暂缓）':'');}
  function deferredText(text,task){
    // Older agent outputs may embed a relation payload in a deferral note. Show its meaning, not JSON.
    const names=new Map(task.graph.nodes.flatMap(n=>[[n.id,n.title],[n.record_id,n.title]]));
    return text.replace(/[（(]b_[a-f0-9]+[）)]/g,'').split('\n').map(line=>{const at=line.indexOf('{');if(at<0||!line.slice(0,at).includes('暂缓关系'))return line;try{const item=JSON.parse(line.slice(at)),v=item.values;if(!v||!v.relation_type)return line;const source=v.source_ref||v.source_id,target=v.target_ref||v.target_id;return '因证据摘录总量限制，暂缓“'+(names.get(source)||'材料')+'”与“'+(names.get(target)||'相关知识点')+'”的关系。'+(v.statement||'');}catch{return line;}}).join('\n');
  }
  function budgetResults(task){
    const saved=task.run_policy||task.policy;
    $('run-budget').hidden=!task.run_policy&&!task.draft;
    $('run-budget').textContent='本轮实际设置：整个集合最多新增 '+saved.max_nodes+' 个知识点 · 结果语言：'+(saved.output_language==='en'?'English（英文）':'中文');
    const list=$('budget-omissions');list.replaceChildren();
    const draft=task.draft;
    $('budget-results').hidden=!draft;
    if(!draft)return;
    const omissions=draft.budget_omissions||[];
    for(const omitted of omissions){const row=el('li');row.append(el('strong',omitted.title),el('p',omitted.reason));for(const b of omitted.basis||[]){const e=task.evidence[b.ref];if(e){const m=task.members.find(m=>m.source_id===e.source_id);row.append(link((m?.title||e.source_id)+' · 第 '+e.line_start+'–'+e.line_end+' 行',`/extract/${task.id}/source/${e.source_id}?start=${e.line_start}`));}}list.append(row);}
    // Older tasks have only prose omissions; retain those without pretending they are structured concepts.
    const legacy=omissions.length?[]:(draft.deferred_items||[]).filter(t=>/max_nodes|节点预算|数量上限|节点上限/.test(t));
    legacy.forEach(t=>list.append(el('li',t)));
    $('budget-result-summary').textContent=omissions.length?'本轮上限 '+saved.max_nodes+'；以下 '+omissions.length+' 个概念因数量限制暂未建立节点，可提高上限后重新整理。':legacy.length?'此旧任务将数量限制说明保存在文字记录中：':'本轮上限 '+saved.max_nodes+'；当前结果未报告因数量上限暂缓的概念。这不代表已穷尽材料中的所有知识。';
  }
  async function ensureTask(){if(!current){current=await api('',{policy:policy()});history.replaceState(null,'','?task='+current.id);await loadHistory();render();}}
  async function loadHistory(){const value=await api();defaults=value.policy;const selected=current?.id||'';$('history').replaceChildren(new Option('新建集合',''));value.tasks.forEach(t=>$('history').append(new Option((labels[t.status]||t.status)+' · '+t.title.slice(0,45),t.id)));$('history').value=selected;}
  function controls(){budgetSummary();const running=current?.status==='running'||current?.status==='importing';['add-links','files','defaults','start','partial','new','history','goal','knowledge','relations','collect','focus','language','reading','max','time'].forEach(id=>$(id).disabled=busy||running);$('cancel').disabled=busy||!running;$('partial').disabled=busy||running||!current?.members.some(m=>m.status==='complete');document.querySelectorAll('.ex-member button,.ex-member select').forEach(n=>n.disabled=busy||running);}
  function link(text,href){const n=el('a',text);n.href=href;n.target='_blank';n.rel='noopener';return n;}
  function button(text, fn){const n=el('button',text,'button ghost');n.type='button';n.addEventListener('click',fn);return n;}
  function render(){if(!current){controls();return;}const task=current;$('clear-results').hidden=!(task.draft||task.submissions.length||task.history?.length);budgetResults(task);$('status').textContent=(labels[task.status]||task.status)+' · 集合修订 '+task.revision+' · '+task.members.filter(m=>!m.removed&&!m.duplicate_of&&m.coverage.read_lines>0).length+' / '+task.members.filter(m=>!m.removed&&!m.duplicate_of).length+' 份材料已查阅'+(task.phase==='merge'&&task.status==='running'?' · 正在跨材料整合':'');
    const memberKey=JSON.stringify([task.id,task.members]);
    if($('members').dataset.renderKey!==memberKey){
    const expanded=new Set([...$('members').querySelectorAll('details[open]')].map(n=>n.dataset.memberId));
    $('members').dataset.renderKey=memberKey;
    $('members').replaceChildren();task.members.filter(m=>!m.removed).forEach(m=>{const card=el('div',undefined,'ex-member');card.append(el('h3',m.title),el('small',((m.status==='ready'&&m.coverage.read_lines>0)?'已查阅':(labels[m.status]||m.status))+(m.version?' · '+m.version:'')+(m.duplicate_of?' · 不计为独立材料':'')));card.append(link('查看来源',`/extract/${task.id}/source/${m.source_id}`));if(m.url)card.append(document.createTextNode(' · '),link('arXiv 原文',m.url));const coverage=el('details');coverage.append(el('summary','读取情况'),el('small',`已读取 ${m.coverage.read_lines} / ${m.coverage.total_lines} 行（按需读取，不代表全文覆盖）`));card.append(coverage);m.warnings.forEach(w=>card.append(el('small',w)));if(m.unread_sections.length)coverage.append(el('small','尚未读取：'+m.unread_sections.slice(0,5).join('、')+(m.unread_sections.length>5?'…':'')));if(m.error)card.append(el('div',m.error,'ex-feedback'));if(!m.duplicate_of)card.append(button('重新分析',()=>action('input',async()=>{current=await api('/'+task.id+'/modify',{revision:current.revision,retry:m.id});render();})));card.append(button('移出集合',()=>action('input',async()=>{current=await api('/'+task.id+'/modify',{revision:current.revision,remove:m.id});render();})));const others=task.members.filter(o=>!o.removed&&!o.duplicate_of&&o.id!==m.id);if(others.length&&!m.duplicate_of){const select=el('select');select.setAttribute('aria-label','标记为重复材料');select.append(new Option('选择重复的材料…',''));others.forEach(o=>select.append(new Option('与《'+o.title+'》是同一份材料',o.id)));select.addEventListener('change',()=>{if(select.value)action('input',async()=>{current=await api('/'+task.id+'/modify',{revision:current.revision,same_as:[m.id,select.value]});render();});});const more=el('details',undefined,'ex-member-more');more.dataset.memberId=m.id;more.open=expanded.has(m.id);more.append(el('summary','更多操作'));const field=el('label');field.append(el('span','标记为重复材料'),select);more.append(field,el('small','仅用于同一篇论文的不同版本或格式。不同论文讨论相同概念时，无需标记。'));card.append(more);}$('members').append(card);});
    }
    $('summary').textContent=task.draft?.summary||'';$('events').replaceChildren(...task.events.slice(-40).map(e=>el('li',new Date(e.at*1000).toLocaleTimeString()+' '+e.message)));$('review').replaceChildren();task.submissions.forEach(s=>{$('review').append(el('span','结果已送审，可在下方直接处理。'));});(task.history||[]).flatMap(h=>h.submissions).forEach(s=>{$('review').append(link('查看此前的审核结果','/inbox?item='+encodeURIComponent('change_set:'+s.change_set_id)));});
    $('deferred').replaceChildren();[...(task.draft?.questions||[]),...(task.draft?.deferred_items||[])].forEach(t=>$('deferred').append(el('li',deferredText(t,task))));task.members.filter(m=>!m.removed&&!m.duplicate_of&&m.status!=='complete'&&['review','complete','paused'].includes(task.status)).forEach(m=>$('deferred').append(el('li',`结果尚未包含：${m.title}（${labels[m.status]||m.status}）`)));
    $('limitations').hidden=!$('deferred').children.length;
    renderReview(task);

    if(task.error&&lastError!==task.id+task.error){lastError=task.id+task.error;feedback(task.error_location==='input'?'input':'run',task.error);}controls();
  }
  let reviewKey='', reviewSignature='', reviewLoading=false;
  const reviewAPI=async(path,body)=>{const r=await fetch('/api/inbox/v1/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:body===undefined?undefined:JSON.stringify(body)});const v=await r.json();if(!r.ok){const e=Error(v.error?.message||'审核未能保存');e.fields=v.error?.fields;throw e;}return v;};
  const reviewer=new LearningReviewPanel({api:reviewAPI,node:el,button,notice:(message,error)=>feedback('run',message,!error),refresh:async()=>{if(current){current=await api('/'+current.id);render();}},reviewPath:id=>`items/${encodeURIComponent(id)}/review`,allowDefer:true});
  async function renderReview(task){
    const id=task.submissions[0]?.change_set_id;
    if(!id){reviewer.workspace?.destroy();reviewer.workspace=null;reviewKey='';reviewSignature='';$('candidates').replaceChildren(el('p',task.status==='complete'?'本次整理没有新增变更。已有知识可在知识图中查看。':'整理完成后，可以在这里直接审核。','ai-muted'));if(task.status==='complete')$('candidates').append(link('查看知识图','/knowledge'));return;}
    const signature=JSON.stringify([id,task.graph.nodes.map(n=>n.detail.status),task.graph.edges.map(e=>e.detail.status)]);
    if(reviewLoading||signature===reviewSignature)return;reviewLoading=true;
    try{reviewKey='change_set:'+id;await reviewer.load(reviewKey,$('candidates'));reviewSignature=signature;}finally{reviewLoading=false;}
  }
  window.addEventListener('beforeunload',event=>{if(reviewer.hasDrafts()){event.preventDefault();event.returnValue='';}});
  async function runtime(){const r=await api('/runtime');$('runtime').textContent=r.available?(r.authenticated?'Codex 已登录':'需要登录 Codex'):r.message;$('login').hidden=r.authenticated;$('start').textContent=r.available&&r.authenticated?'开始 / 继续整理':'先连接 Codex';return r;}
  $('add-text').addEventListener('click',()=>action('input',async()=>{const text=$('text').value.trim();if(!text)throw Error('请粘贴文本。');await ensureTask();const bytes=new TextEncoder().encode(text);let raw='';for(const b of bytes)raw+=String.fromCharCode(b);current=await api('/'+current.id+'/add',{revision:current.revision,filename:'粘贴文本.txt',content:btoa(raw)});$('text').value='';render();}));
  $('max').addEventListener('input',budgetSummary);

  $('login').addEventListener('click',()=>action('auth',async()=>{const result=await api('/login',{});feedback('auth','登录页面已准备好。完成登录后点击“刷新登录状态”。',true);if(result.auth_url)$('auth-feedback').append(document.createTextNode(' '),link('打开安全登录页面',result.auth_url));}));
  $('key-login').addEventListener('click',()=>action('auth',async()=>{const key=$('key').value;if(!key.trim())throw Error('请输入 API key。');try{await api('/login',{api_key:key});feedback('auth','已连接 Codex。',true);await runtime();}finally{$('key').value='';}}));
  $('refresh-auth').addEventListener('click',()=>action('auth',runtime));
  $('clear-results').addEventListener('click',()=>{if(current)openContentReset(current.id);});
  async function changeTask(id){if(!await window.PersonaDrafts.allowLeave()){$('history').value=current?.id||'';return;}location.assign('/extract'+(id?'?task='+encodeURIComponent(id):''));}
  $('new').addEventListener('click',()=>action('input',()=>changeTask('')));
  $('history').addEventListener('change',()=>action('input',()=>changeTask($('history').value)));
  $('defaults').addEventListener('click',()=>action('policy',async()=>{defaults=await api('/policy',policy());feedback('policy','已保存为下次默认规则。',true);}));
  $('add-links').addEventListener('click',()=>action('input',async()=>{const links=$('links').value.split(/\n/).map(x=>x.trim()).filter(Boolean);if(!links.length)throw Error('请先输入 arXiv 链接或 ID。');await ensureTask();const failed=[];for(let i=0;i<links.length;i++){feedback('input',`正在添加 ${i+1} / ${links.length}：${links[i]}`,true);try{current=await api('/'+current.id+'/add',{revision:current.revision,arxiv:links[i]});render();}catch(e){failed.push(links[i]+'：'+e.message);current=await api('/'+current.id);}}$('links').value=failed.length?links.filter(x=>failed.some(f=>f.startsWith(x+'：'))).join('\n'):'';feedback('input',failed.length?failed.join('\n'):'材料已添加。',!failed.length);render();}));
  $('files').addEventListener('change',()=>action('input',async()=>{const files=[...$('files').files];await ensureTask();const failed=[];for(const file of files){feedback('input','正在添加：'+file.name,true);try{if(file.size>20*1024*1024)throw Error('超过 20 MB，请拆分后上传。');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(Error('无法读取文件。'));r.readAsDataURL(file);});current=await api('/'+current.id+'/add',{revision:current.revision,filename:file.name,content:data});render();}catch(e){failed.push(file.name+'：'+e.message);current=await api('/'+current.id);}}$('files').value='';feedback('input',failed.length?failed.join('\n'):'文件已添加。',!failed.length);render();}));
  async function start(partial){const state=await api('/runtime');if(!state.available||!state.authenticated){$('runtime').scrollIntoView({block:'center'});throw Error('从材料提取知识需要可运行且已登录的 Codex，请先完成上方连接设置。');}const p=policy();await ensureTask();if(Object.entries(p).some(([k,v])=>v!==current.policy[k]))current=await api('/'+current.id+'/modify',{revision:current.revision,policy:p});current=await api('/'+current.id+'/start',{revision:current.revision,partial,expected_max_nodes:p.max_nodes});$('run-feedback').replaceChildren();lastError='';render();}
  $('start').addEventListener('click',()=>action('run',()=>start(false)));$('partial').addEventListener('click',()=>action('run',()=>start(true)));$('cancel').addEventListener('click',()=>action('run',async()=>{current=await api('/'+current.id+'/cancel',{});render();}));
  setInterval(async()=>{if(!current||busy||pollBusy||document.hidden)return;pollBusy=true;try{const taskId=current.id;const value=await api('/'+taskId);if(current?.id===taskId){current=value;render();}}catch(e){if(lastError!==e.message){lastError=e.message;feedback('run',e.message);}}finally{pollBusy=false;}},2500);
  controls();
  (async()=>{try{await loadHistory();const id=new URL(location.href).searchParams.get('task');if(id){current=await api('/'+id);fillPolicy(current.policy);$('history').value=id;render();}else fillPolicy(defaults);window.PersonaDrafts?.mount(document.querySelector('.ex-compose'),{query:['task'],exclude:'#ex-members'});await runtime();}catch(e){feedback('input',e.message);}finally{busy=false;controls();}})();
})();
