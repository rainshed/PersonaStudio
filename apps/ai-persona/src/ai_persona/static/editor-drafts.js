(() => {
  'use strict';
  const zh = document.documentElement.lang === 'zh-CN', L = (a,b) => zh ? a : b;
  const managers = [], endpoint = '/api/studio/editor-drafts';
  let leaving = false;
  const node = (tag,text) => {const n=document.createElement(tag); if(text)n.textContent=text;return n;};
  async function api(value, page) {
    const response = await fetch(endpoint + (page ? '?page='+encodeURIComponent(page) : ''), value ? {method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(value)} : {});
    const result=await response.json(); if(!response.ok)throw Error(result.error?.message||L('草稿保存失败','Could not save draft'));return result;
  }
  function mount(root, options={}) {
    if(!root || root.dataset.draftMounted)return;
    root.dataset.draftMounted='true';
    const page = () => location.pathname + (options.query ? '?'+new URLSearchParams([...new URLSearchParams(location.search)].filter(([k])=>options.query.includes(k))) : '');
    const controls = () => [...root.querySelectorAll('input,textarea,select')].filter(e=>e.type!=='hidden'&&e.type!=='password'&&e.type!=='submit'&&e.type!=='button'&&!e.readOnly&&!e.closest('[data-draft-ignore]')&&!(options.exclude&&e.closest(options.exclude))&&!/password|api.?key|secret|credential|token|authorization|(?:^|[-_])auth(?:$|[-_])/i.test(e.name||e.id));
    const fields = () => {const out={};controls().filter(e=>e.type!=='file').forEach((e,i)=>{const key=e.name||e.id||'control_'+i; (out[key]||=[]).push(['checkbox','radio'].includes(e.type)?e.checked:e.value);});return out;};
    const baseline=root.querySelector('[name=record_revision]')?.value||'';
    let original=JSON.stringify(fields()), saved=options.persistInitial?'':original, savedPage=page(), id=crypto.randomUUID(), revision=0, queue=Promise.resolve(), timer, submitting=false, uncertainSave=false;
    const bar=node('div');bar.className='editor-draft-bar';bar.setAttribute('role','status');root.prepend(bar);
    const recovery=node('div');recovery.className='editor-draft-recovery';root.prepend(recovery);
    const tell=text=>{bar.textContent=text;};
    const pendingFiles=()=>controls().some(e=>e.type==='file'&&e.files.length)||!!options.extraPending?.();
    const changed=()=>JSON.stringify(fields())!==original;
    const unpersisted=()=>JSON.stringify(fields())!==saved||pendingFiles();
    function save() {
      clearTimeout(timer);
      queue=queue.catch(()=>{}).then(async()=>{
        await options.beforeSave?.();
        if(!changed() && revision===0&&!options.persistInitial){saved=original;tell(pendingFiles()?L('文件尚未上传，返回后需要重新选择。','Files are not uploaded; select them again when returning.'):'');return;}
        const value=fields(), serialized=JSON.stringify(value);
        if(serialized===saved&&savedPage===page()){tell(revision?L('草稿已保存 · 尚未正式保存','Draft saved · not yet published'):'');return;}
        tell(L('正在保存草稿…','Saving draft…'));
        const currentPage=page();const result=await api({id,page:currentPage,revision,baseline,fields:value});revision=result.revision;saved=serialized;savedPage=currentPage;
        tell(L('草稿已保存 · 尚未正式保存','Draft saved · not yet published')+(pendingFiles()?L(' · 文件尚未上传，返回后需重新选择',' · Files not uploaded; select them again when returning'):''));
      });
      return queue;
    }
    const modified=()=>{if(!changed()&&!revision&&!pendingFiles()){tell('');saved=original;return;}if(JSON.stringify(fields())===saved&&savedPage===page()&&!pendingFiles()){tell(revision?L('草稿已保存 · 尚未正式保存','Draft saved · not yet published'):'');return;}tell(L('有未保存的修改','Unsaved changes'));clearTimeout(timer);timer=setTimeout(()=>save().catch(e=>tell(e.message)),1000);};
    root.addEventListener('input',modified);root.addEventListener('change',modified);
    const manager={root,unpersisted,save,changed,async close(){clearTimeout(timer);await queue.catch(()=>{});await api({action:'close',id});saved=JSON.stringify(fields());original=saved;id=crypto.randomUUID();revision=0;savedPage=page();},status:tell};managers.push(manager);
    api(null,page()).then(result=>{
      for(const draft of result.items){
        if(draft.id===id)continue;
        const row=node('div');row.className='editor-draft-choice';
        row.append(node('strong',L('发现未完成的编辑 · ','Unfinished edit · ')+new Date(draft.updated).toLocaleString()));
        const conflict=draft.baseline!==baseline;
        if(conflict)row.append(node('p',L('正式记录已经更新。请对照草稿后在当前版本继续编辑，不会自动覆盖。','The record changed. Compare this draft with the current version; it will not overwrite your edits.')));
        const details=node('details');details.append(node('summary',L('查看草稿内容','View draft content')),node('pre',JSON.stringify(draft.fields,null,2)));row.append(details);
        const restore=node('button',L('恢复草稿','Restore draft'));restore.type='button';restore.disabled=conflict;
        restore.onclick=async()=>{
          if(changed()&&!confirm(L('恢复会替换当前输入，继续？','Replace the current input with this draft?')))return;
          // Copy the selected draft into a new edit instance, so another tab remains independent.
          root.dispatchEvent(new CustomEvent('persona:restore-draft',{detail:draft.fields}));
          const counts={};controls().filter(e=>e.type!=='file').forEach((e,i)=>{const key=e.name||e.id||'control_'+i,index=counts[key]||0;counts[key]=index+1;const value=draft.fields[key]?.[index];if(value===undefined)return;if(['checkbox','radio'].includes(e.type))e.checked=value;else e.value=value;});
          controls().forEach(e=>{e.dispatchEvent(new Event('input',{bubbles:true}));if(e.type!=='file')e.dispatchEvent(new Event('change',{bubbles:true}));});
          recovery.replaceChildren();try{await save();await api({action:'close',id:draft.id,revision:draft.revision});}catch(e){tell(e.message);}
        };
        const discard=node('button',L('丢弃草稿','Discard draft'));discard.type='button';discard.onclick=async()=>{try{await api({action:'close',id:draft.id,revision:draft.revision});row.remove();}catch(e){tell(e.message);}};
        row.append(restore,discard);recovery.append(row);
      }
    }).catch(e=>tell(e.message));
    if(options.submit)document.addEventListener('submit',async event=>{
      if(event.target!==root||event.defaultPrevented)return;
      event.preventDefault();if(submitting||uncertainSave)return;
      if(!event.submitter?.formNoValidate&&!root.reportValidity())return;
      submitting=true;
      const button=event.submitter;
      const data=new FormData(root);if(button?.name)data.append(button.name,button.value);
      const target=button?.getAttribute('formaction')||root.action;
      root.inert=true;
      if(button)button.disabled=true;
      let sent=false,received=false;
      try {
        await save();
        sent=true;const response=await fetch(target,{method:'POST',body:data});received=true;
        if(response.status>=500)uncertainSave=true;
        const body=await response.text();const doc=new DOMParser().parseFromString(body,'text/html');
        const error=[...doc.querySelectorAll('.toast.error,.import-error,.form-error,[role=alert]')].find(el=>el.textContent.trim()&&!el.closest('[hidden],[aria-hidden=true]'));
        if(!response.ok||error?.textContent.trim())throw Error(error?.textContent.trim()||L('尚未确认保存成功。输入已保留，请检查后重试。','Save not confirmed. Your input is preserved; check before retrying.'));
        if(!response.redirected){uncertainSave=true;throw Error(L('尚未确认保存成功，请检查记录后重试。','Save not confirmed. Check the record before retrying.'));}
        // A confirmed content save must not be replayed because draft cleanup failed.
        try{await manager.close();}catch{tell(L('内容已保存，旧草稿清理失败；请勿重复提交。','Content saved; old draft cleanup failed. Do not resubmit.'));}
        leaving=true;location.assign(response.url);
      }catch(e){
        if(sent&&!received)uncertainSave=true;
        tell(e.message);bar.dataset.error='true';bar.scrollIntoView({block:'center'});
        if(uncertainSave){
          const notice=node('div');notice.className='editor-draft-recovery';notice.setAttribute('role','alert');
          notice.append(node('p',L('尚未确认保存成功，输入已保留。请先查看记录，避免重复提交。','Save not confirmed. Your input is preserved. Check the records before submitting again.')));
          const inspect=node('a',L('在新标签页查看记录','Check records in a new tab'));inspect.href='/'+location.pathname.split('/')[1];inspect.target='_blank';inspect.rel='noopener';
          const retry=node('button',L('已检查记录，允许重试','I checked the records; allow retry'));retry.type='button';retry.onclick=()=>{uncertainSave=false;if(button)button.disabled=false;notice.remove();};
          notice.append(inspect,retry);root.prepend(notice);
        }
      }
      finally{submitting=false;root.inert=false;if(button)button.disabled=uncertainSave;root.querySelector('[data-import-progress]')?.setAttribute('hidden','');}
    });
    if(options.persistInitial)save().catch(e=>tell(e.message));
    return manager;
  }
  async function allowLeave() {
    const pending=managers.filter(m=>m.unpersisted());if(!pending.length)return true;
    const dialog=node('dialog');dialog.className='editor-leave-dialog';dialog.append(node('h2',L('还有未保存的修改','Unsaved changes')),node('p',L('可以保留为草稿，稍后继续。尚未上传的文件需要重新选择。','Keep a draft and continue later. Files not uploaded will need to be selected again.')));
    return new Promise(resolve=>{const finish=v=>{dialog.close();dialog.remove();resolve(v);};for(const [label,action] of [[L('继续编辑','Keep editing'),null],[L('保存草稿并离开','Save draft and leave'),'save'],[L('放弃修改','Discard changes'),'discard']]){const b=node('button',label);b.type='button';b.onclick=async()=>{if(!action){finish(false);return;}b.disabled=true;try{for(const m of pending)await (action==='save'?m.save():m.close());finish(true);}catch(e){dialog.append(node('p',e.message));b.disabled=false;}};dialog.append(b);}dialog.oncancel=e=>{e.preventDefault();finish(false);};document.body.append(dialog);dialog.showModal();});
  }
  document.addEventListener('click',async event=>{
    const link=event.target.closest('a[href]');if(!link||link.target==='_blank'||event.defaultPrevented||event.metaKey||event.ctrlKey||!managers.some(m=>m.unpersisted()))return;
    const url=new URL(link.href);if(url.origin===location.origin&&url.pathname===location.pathname&&url.search===location.search)return;
    event.preventDefault();event.stopImmediatePropagation();if(await allowLeave()){leaving=true;location.assign(link.href);}
  },true);
  document.addEventListener('submit',async event=>{
    if(!event.target.matches('.language-switcher,.mobile-language-switcher')||leaving)return;
    event.preventDefault();if(await allowLeave()){try{const data=new FormData(event.target);data.set('locale',event.submitter?.value||event.target.querySelector('[name=locale]').value);const response=await fetch(event.target.action,{method:'POST',body:data});if(!response.ok)throw Error(L('语言切换失败，输入已保留，请重试。','Could not change language. Your input is preserved; retry.'));leaving=true;location.assign(response.url);}catch(e){leaving=false;managers.forEach(m=>m.status(e.message));}}
  },true);
  window.addEventListener('beforeunload',event=>{if(!leaving&&managers.some(m=>m.unpersisted())){event.preventDefault();event.returnValue='';}});
  window.PersonaDrafts={mount,allowLeave,isLeaving:()=>leaving,hasUnpersisted:root=>managers.find(m=>m.root===root)?.unpersisted()??true,async flush(){for(const m of managers)await m.save();},leave(){leaving=true;}};
  document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('form.edit-layout,form[data-material-import-form],form[data-context-editor]').forEach(form=>mount(form,{submit:true,persistInitial:form.matches('.import-review-layout')}));});
})();
