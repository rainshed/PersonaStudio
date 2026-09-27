(() => {
  'use strict';
  const form = document.querySelector('#idea-editor');
  if (!form) return;
  const zh = document.documentElement.lang === 'zh-CN', L = (a,b) => zh ? a : b;
  const $ = id => document.getElementById(id), field = name => form.elements.namedItem(name);
  let item = JSON.parse($('idea-data').textContent), busy = false, uploading = false;
  field('idea_identifier').addEventListener('input',()=>{if(!item.revision)item.id=field('idea_identifier').value;});
  let execution = item.execution_status, resources = item.resources, writingResources = false;
  const outcomes = {success:L('成功完成','Completed'),partial:L('部分完成','Partially completed'),abandoned:L('放弃','Abandoned')};
  const statuses = {not_started:L('未开始执行','Not started'),in_progress:L('执行中','In progress'),ended:L('已结束','Ended')};
  const el = (tag, text, cls) => { const n = document.createElement(tag); if(text)n.textContent=text; if(cls)n.className=cls; return n; };
  const changed = n => n.dispatchEvent(new Event('input',{bubbles:true}));
  const message = (text, error=false) => { $('idea-save-message').textContent=text; $('idea-save-message').dataset.error=String(error); };
  const currentClosure = () => JSON.parse(field('closure_json').value);
  if(item.closure){field('ending_outcome').value=item.closure.outcome;field('ending_summary').value=item.closure.summary;}
  const draft = window.PersonaDrafts.mount(form,{extraPending:()=>uploading});
  async function api(url, data) {
    const response = await fetch(url, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(data)});
    const value = await response.json();
    if(!response.ok) { const error=Error(value.error?.message || L('操作失败，输入已保留。','The operation failed. Your input is preserved.')); error.code=value.error?.code; throw error; }
    return value;
  }
  function values() {
    return {...window.IdeaLinks.values(), ...Object.fromEntries(['title','body','novelty','novelty_reason','difficulty','difficulty_reason','execution_status','status'].map(k=>[k,field(k).value]).concat([['resources',JSON.parse(field('resources_json').value)],['closure',currentClosure()]]))};
  }
  function paintEnding() {
    const closure=currentClosure();
    $('idea-ending-panel').hidden=!closure;
    $('idea-reopen').hidden=field('execution_status').value!=='ended';
    if(closure) { $('idea-ending-title').textContent=L('已结束 · ','Ended · ')+outcomes[closure.outcome]; $('idea-ending-summary').textContent=closure.summary; }
  }
  function endingPrompt() {
    const prompts={success:L('取得了什么成果？一句话也可以。','What did you achieve? One sentence is enough.'),partial:L('完成了哪些部分？哪些尚未完成，为什么？','Which parts worked, which did not, and why?'),abandoned:L('为什么决定放弃？留下值得记住的判断。','Why did you stop? Record what is worth remembering.')};
    field('ending_summary').placeholder=prompts[field('ending_outcome').value] || L('先选择结束结果，再写下简要说明。','Choose a result, then add a short summary.');
  }
  function openEnding() {
    if(busy)return;
    $('idea-closure-error').textContent=''; endingPrompt(); $('idea-closure-dialog').showModal();
  }
  function restart(next) {
    execution=next; field('execution_status').value=next;
    field('closure_json').value='null'; form.querySelectorAll('[name=ending_outcome]').forEach(r=>r.checked=false); field('ending_summary').value='';
    changed(field('closure_json')); changed(field('execution_status')); paintEnding();
    message(L('保存后开始新一轮，上一轮的结果仍可在历史版本中查看。','Save to begin a new round. The previous result remains in history.'));
  }
  field('execution_status').addEventListener('change',()=>{
    const next=field('execution_status').value;
    if(next==='ended' && execution!=='ended') {field('execution_status').value=execution;openEnding();return;}
    if(execution==='ended'&&next!=='ended')restart(next);else execution=next;
  });
  $('idea-reopen').onclick=()=>restart('in_progress');
  $('idea-edit-ending').onclick=openEnding;
  form.querySelectorAll('[name=ending_outcome]').forEach(n=>n.addEventListener('change',endingPrompt));
  document.querySelectorAll('[data-close]').forEach(n=>n.onclick=()=>$(n.dataset.close).close());
  async function save(ending) {
    if(busy||uploading||$('idea-reference-dialog')?.open)return false;
    if(!field('title').value.trim()) {message(L('请填写标题。','Please enter a title.'),true);field('title').focus();return false;}
    busy=true; $('idea-save').disabled=true; $('idea-confirm-ending').disabled=true;
    const pendingEnding=ending?null:{outcome:field('ending_outcome').value,summary:field('ending_summary').value};
    const submitted=values();
    if(ending) {submitted.execution_status='ended';submitted.closure=ending;}
    // Freeze the editor until publication finishes; a late response cannot erase new input.
    const controls=[...form.querySelectorAll('input,textarea,select,button')];
    const disabled=controls.map(n=>n.disabled); controls.forEach(n=>n.disabled=true);
    message(L('正在保存…','Saving…')); $('idea-saved-status').textContent=L('正在保存…','Saving…');
    try {
      await draft.save();
      const result=await api('/api/ideas/'+item.id,{expected_revision:item.revision,values:submitted});
      item=result.item; execution=item.execution_status;
      window.IdeaLinks.saved(item);resources=item.resources;field('resources_json').value=JSON.stringify(resources);renderResources();
      ['title','body','novelty','novelty_reason','difficulty','difficulty_reason','execution_status','status'].forEach(k=>field(k).value=item[k]);
      field('record_revision').value=item.revision; field('closure_json').value=JSON.stringify(item.closure);
      history.replaceState(null,'','/ideas/'+item.id);
      form.querySelectorAll('[name=ending_outcome]').forEach(r=>r.checked=r.value===item.closure?.outcome);
      field('ending_summary').value=item.closure?.summary||'';
      let cleaned=true;
      try {await draft.close();draft.status('');} catch {cleaned=false;}
      $('idea-saved-status').textContent=L('已保存','Saved')+' · v'+item.revision;
      message(cleaned ? (result.changed ? L('已保存，完整版本已保留。','Saved with a complete revision.') : L('没有内容变化，未新增版本。','No changes; no new revision.')) : L('内容已保存。旧草稿清理失败，可稍后丢弃。','Saved. The old draft could not be cleared; discard it later.'));
      if(pendingEnding && (pendingEnding.outcome!==(item.closure?.outcome||'') || pendingEnding.summary!==(item.closure?.summary||''))){
        form.querySelectorAll('[name=ending_outcome]').forEach(r=>r.checked=r.value===pendingEnding.outcome);
        field('ending_summary').value=pendingEnding.summary;changed(field('ending_summary'));
        if(cleaned){try{await draft.save();}catch{draft.status(L('结束说明草稿尚未保存，请保留当前页面。','The ending draft is not saved. Keep this page open.'));}}
      }
      $('idea-inspect-latest').hidden=true;
      paintEnding(); if(ending)$('idea-closure-dialog').close();
      return true;
    } catch(error) {
      message(error.message,true); $('idea-saved-status').textContent=L('保存失败 · 输入已保留','Save failed · input preserved');
      if(ending)$('idea-closure-error').textContent=error.message;
      $('idea-inspect-latest').href='/ideas/'+item.id; $('idea-inspect-latest').hidden=false;
      return false;
    } finally {
      controls.forEach((n,i)=>n.disabled=disabled[i]); busy=false;
      $('idea-save').disabled=false; $('idea-confirm-ending').disabled=false;
      $('idea-history').disabled=!item.revision; $('idea-context').disabled=!item.revision;
    }
  }
  $('idea-create-project')?.addEventListener('click',async()=>{
    if(busy||uploading)return;
    const trigger=$('idea-create-project');trigger.disabled=true;
    try{
      if(!await save())return;
      const destination=item.project?'/projects/#project/'+encodeURIComponent(item.project.id)+'/ideas':'/projects/#projects/from/'+encodeURIComponent(item.id);
      location.assign(destination);
    }finally{trigger.disabled=false;}
  });
  if($('idea-create-project'))$('idea-create-project').disabled=false;
  form.addEventListener('submit',e=>{e.preventDefault();save();});
  $('idea-confirm-ending').onclick=()=>{
    const outcome=field('ending_outcome').value, summary=field('ending_summary').value.trim();
    if(!outcome||!summary) { $('idea-closure-error').textContent=L('请选择结束结果，并填写简要说明。','Choose an outcome and enter a short summary.'); return; }
    save({outcome,summary});
  };
  form.addEventListener('input',()=>{if(!busy)$('idea-saved-status').textContent=L('有未保存的修改','Unsaved changes');});
  field('closure_json').addEventListener('input',paintEnding);
  function resourceHref(r) {return r.kind==='link'?r.url:'/api/ideas/file?'+new URLSearchParams({source_ref:r.source_ref,file_path:r.file_path});}
  function storeResources(render=false) {
    writingResources=true;field('resources_json').value=JSON.stringify(resources);changed(field('resources_json'));writingResources=false;
    if(render)renderResources();
  }
  function renderResources() {
    const root=$('idea-resources');root.replaceChildren();$('idea-resource-count').textContent=resources.filter(r=>!window.IdeaLinks.managed(r)).length;
    resources.forEach((r,index)=>{
      if(window.IdeaLinks.managed(r))return;
      const row=el('div',null,'idea-resource');row.dataset.draftIgnore='true';
      const head=el('div',null,'idea-resource-head'), a=el('a',(r.kind==='file'?'↓ ':'↗ ')+(r.title||r.url||r.file_path));
      a.href=resourceHref(r);a.target='_blank';a.rel='noopener noreferrer';
      head.append(a);
      [['↑',-1],['↓',1],[L('移除','Remove'),0]].forEach(([label,delta])=>{
        const b=el('button',label,'button small');b.type='button';b.setAttribute('aria-label',delta?(delta<0?L('上移资源','Move up'):L('下移资源','Move down')):L('移除资源关联','Remove reference'));
        b.disabled=delta && (index+delta<0 || index+delta>=resources.length);
        b.onclick=()=>{if(delta){[resources[index],resources[index+delta]]=[resources[index+delta],resources[index]];}else resources.splice(index,1);storeResources(true);};head.append(b);
      });
      const title=el('input');title.value=r.title;title.placeholder=L('资源名称','Resource name');title.setAttribute('aria-label',L('资源名称','Resource name'));
      title.oninput=()=>{r.title=title.value; a.textContent=(r.kind==='file'?'↓ ':'↗ ')+(r.title||r.url||r.file_path);storeResources();};
      const note=el('textarea',null,'idea-resource-note');note.rows=2;note.value=r.note||'';note.placeholder=L('备注（选填）','Note (optional)');note.setAttribute('aria-label',L('资源备注','Resource note'));note.oninput=()=>{r.note=note.value;storeResources();};
      row.append(head,title,note);root.append(row);
    });
  }
  field('resources_json').addEventListener('input',()=>{if(!writingResources){try{resources=JSON.parse(field('resources_json').value);renderResources();}catch{message(L('资源草稿无法读取。','Cannot read resource draft.'),true);}}});
  $('idea-add-link').onclick=()=>{
    const url=field('link_url').value.trim();
    try {const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol)||/\s/.test(url))throw Error();}
    catch {$('idea-resource-message').textContent=L('请输入完整的 HTTP(S) 链接。','Enter a complete HTTP(S) URL.');return;}
    resources.push({id:'res_'+crypto.randomUUID(),kind:'link',title:field('link_title').value.trim(),note:'',url});
    field('link_url').value='';field('link_title').value='';storeResources(true);$('idea-resource-message').textContent='';
  };
  async function loadFiles() {
    const result=await api('/api/ideas/files'), select=$('idea-existing');
    select.replaceChildren(new Option(L('选择一个文件…','Choose a file…'),''));
    result.items.forEach(r=>select.add(new Option(r.title,JSON.stringify(r))));
  }
  $('idea-reuse').onclick=()=>{
    if(!$('idea-existing').value)return;
    resources.push({...JSON.parse($('idea-existing').value),id:'res_'+crypto.randomUUID(),kind:'file',note:''});storeResources(true);
  };
  $('idea-file').onchange=async()=>{
    const file=$('idea-file').files[0];if(!file)return;
    if(!file.size||file.size>Number(form.dataset.uploadMb)*1024*1024){$('idea-resource-message').textContent=L('文件为空或超过上传限制。','The file is empty or exceeds the upload limit.');return;}
    uploading=true;$('idea-save').disabled=true;$('idea-file').disabled=true;
    $('idea-resource-message').textContent=L('正在上传…','Uploading…');
    try {
      const response=await fetch('/api/ideas/upload?'+new URLSearchParams({filename:file.name}),{method:'POST',headers:{'X-AI-Persona':'1','Content-Type':file.type||'application/octet-stream'},body:file});
      const result=await response.json();if(!response.ok)throw Error(result.error.message);
      resources.push(result.item);storeResources(true);$('idea-file').value='';
      $('idea-resource-message').textContent=L('文件已上传，保存想法后建立关联。','Uploaded. Save the idea to keep this reference.');
      await draft.save();await loadFiles();
    }catch(error){$('idea-resource-message').textContent=error.message;}
    finally{uploading=false;$('idea-save').disabled=false;$('idea-file').disabled=false;}
  };
  // Text-first Markdown rendering: raw HTML never becomes markup. Images remain links.
  function inline(text,parent){window.IdeaLinks.renderInline(text,parent,inlinePlain);}
  function inlinePlain(text, parent) {
    const pattern=/(`[^`]+`|!?\[[^\]]*\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let at=0;
    for(const m of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(at,m.index)));const token=m[0];
      if(token.startsWith('`'))parent.append(el('code',token.slice(1,-1)));
      else if(token.startsWith('**'))parent.append(el('strong',token.slice(2,-2)));
      else if(token.startsWith('*'))parent.append(el('em',token.slice(1,-1)));
      else {const match=token.match(/^(!?)\[([^\]]*)\]\((.*)\)$/);try {const url=new URL(match[3]);if(!['http:','https:'].includes(url.protocol))throw Error();const a=el('a',match[1]?L('图片引用：','Image: ')+(match[2]||match[3]):match[2]);a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}catch{parent.append(document.createTextNode(token));}}
      at=m.index+token.length;
    }
    parent.append(document.createTextNode(text.slice(at)));
  }
  function markdown(text, root) {
    root.replaceChildren();let code=null,list=null,fence=null,paragraph=[];
    const flush=()=>{if(paragraph.length){const p=el('p');inline(paragraph.join('\n'),p);root.append(p);paragraph=[];}};
    for(const line of text.split('\n')) {
      const marker=line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if(code){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim()){code=null;fence=null;}else code.append(document.createTextNode(line+'\n'));continue;}
      if(marker){flush();list=null;fence=marker[1];const pre=el('pre');code=el('code');pre.append(code);root.append(pre);continue;}
      if(!line.trim()){flush();list=null;continue;}
      const heading=line.match(/^(#{1,6})\s+(.*)/),li=line.match(/^\s*([-*+] |\d+\. )(.*)/),quote=line.match(/^>\s?(.*)/);
      if(heading){flush();const n=el('h'+heading[1].length);inline(heading[2],n);root.append(n);list=null;}
      else if(li){flush();const type=/\d/.test(li[1])?'ol':'ul';if(!list||list.tagName.toLowerCase()!==type){list=el(type);root.append(list);}const n=el('li');inline(li[2],n);list.append(n);}
      else if(quote){flush();const n=el('blockquote');inline(quote[1],n);root.append(n);list=null;}
      else{paragraph.push(line);list=null;}
    }
    flush();if(!text.trim())root.append(el('p',L('还没有正文。','No note yet.')));
  }
  function preview(on) {$('idea-body').hidden=on;$('idea-rendered').hidden=!on;$('idea-write').setAttribute('aria-pressed',!on);$('idea-preview').setAttribute('aria-pressed',on);if(on)markdown(field('body').value,$('idea-rendered'));}
  $('idea-preview').onclick=()=>preview(true);$('idea-write').onclick=()=>preview(false);
  async function copy(text, target) {try{await navigator.clipboard.writeText(text);target.textContent=L('已复制','Copied');}catch{target.textContent=L('无法自动复制，请选中文字后复制。','Select the text and copy it manually.');}}
  $('idea-history').onclick=async()=>{
    $('idea-history-dialog').showModal();const root=$('idea-history-list');root.textContent=L('正在读取…','Loading…');
    try {const result=await api('/api/ideas/'+item.id+'/history');root.replaceChildren();result.items.forEach(r=>{
      const entry=el('details',null,'idea-history-entry');entry.append(el('summary','v'+r.revision+' · '+new Date(r.updated_at).toLocaleString()+' · '+statuses[r.execution_status]+(r.closure?' · '+outcomes[r.closure.outcome]:'')));
      const novelty={unknown:L('尚未判断','Not assessed'),novel:L('新颖','Novel'),incremental:L('增量改进','Incremental'),non_novel:L('不新颖','Not novel')};
      const difficulty={unknown:L('尚未判断','Not assessed'),low:L('低','Low'),medium:L('中','Medium'),high:L('高','High')};
      const meta=[L('执行状态：','Execution: ')+statuses[r.execution_status],L('归档状态：','Archive: ')+(r.status==='archived'?L('已归档','Archived'):L('当前想法','Current idea')),L('新颖性：','Novelty: ')+novelty[r.novelty],L('判断说明：','Reason: ')+(r.novelty_reason||'—'),L('实现难度：','Difficulty: ')+difficulty[r.difficulty],L('判断说明：','Reason: ')+(r.difficulty_reason||'—')];
      if(r.closure)meta.push(L('结束结果：','Outcome: ')+outcomes[r.closure.outcome],r.closure.summary);
      const text='# '+r.title+'\n\n'+meta.join('\n')+'\n\n'+r.body+'\n\n'+r.resources.map(x=>'- '+(x.title||x.url||x.file_path)+' · '+(x.url||x.file_path)+' '+(x.note||'')).join('\n');
      entry.append(el('h3',r.title),el('pre',meta.join('\n')));const note=el('article',null,'idea-markdown');markdown(r.body,note);entry.append(note);r.resources.forEach(x=>{const a=el('a',x.title||x.url||x.file_path);a.href=resourceHref(x);a.target='_blank';a.rel='noopener noreferrer';entry.append(a);});
      const b=el('button',L('复制此版本','Copy this revision'),'button small');b.type='button';b.onclick=()=>copy(text,b);entry.append(b);root.append(entry);
    });}catch(error){root.textContent=error.message;}
  };
  async function loadContext() {
    $('idea-context-text').value='';$('idea-copy-context').disabled=true;
    try {const result=await api('/api/ideas/'+item.id+'/context?resources='+$('idea-context-resources').checked);$('idea-context-text').value=result.text;$('idea-copy-context').disabled=false;$('idea-context-message').textContent='';}
    catch(error){$('idea-context-message').textContent=error.message;}
  }
  $('idea-context').onclick=()=>{$('idea-context-dialog').showModal();loadContext();};
  $('idea-context-resources').onchange=loadContext;
  $('idea-copy-context').onclick=()=>copy($('idea-context-text').value,$('idea-context-message'));
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='s'){event.preventDefault();if(!$('idea-closure-dialog').open)save();}});
  paintEnding();renderResources();loadFiles().catch(e=>$('idea-resource-message').textContent=e.message);
})();
