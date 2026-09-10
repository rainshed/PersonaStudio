const zh = document.documentElement.lang.startsWith('zh');
const t = (a,b) => zh ? a : b;
const node = (tag,text,cls) => {const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
async function request(path,body){
  const response=await fetch('/api/content-reset'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-AI-Persona':'1'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  let result;try{result=await response.json();}catch{throw Error(t('服务未返回有效结果，请检查 Studio 是否仍在运行。','Studio did not return a valid response. Check that it is running.'));}
  if(!response.ok||result.ok===false)throw Error(result.error?.message||t('清理未完成。','Reset failed.'));
  return result;
}
export async function openContentReset(taskId=null){
  const dialog=node('dialog',null,'content-reset-dialog');
  dialog.setAttribute('aria-labelledby','content-reset-title');
  const title=node('h2',taskId?t('清除本次提取结果','Clear this extraction'):t('清空内容，保留配置','Clear content, keep settings'));title.id='content-reset-title';
  const description=node('p',taskId?t('保留本集合的输入材料和提取设置，清除本次草稿、提案及可安全移除的已采纳内容，方便重新整理。','Keep this collection’s inputs and settings; remove its drafts, proposals and accepted content that can safely be removed.'):t('清空知识、关系、材料、个人偏好、审核记录和任务内容。保留模型连接、登录授权、应用接入、语言和提取规则。','Clear knowledge, relations, materials, preferences, reviews and task content. Keep model connections, authentication, integrations, language and extraction settings.'));
  const content=node('div'), status=node('p',t('正在计算清理范围…','Preparing preview…'));
  status.setAttribute('role','status');status.tabIndex=-1;
  const backupLabel=node('label',null,'ai-check'),backup=node('input');backup.type='checkbox';backupLabel.append(backup,document.createTextNode(t('清理前保存一份本地备份（可选）','Save a local backup before clearing (optional)')));
  const actions=node('div',null,'ai-actions'),cancel=node('button',t('取消','Cancel'),'button ghost'),confirm=node('button',t('确认清理','Confirm clearing'),'button primary-button');confirm.disabled=true;
  cancel.onclick=()=>dialog.close();actions.append(cancel,confirm);dialog.append(title,description,content,backupLabel,status,actions);document.body.append(dialog);dialog.showModal();
  let working=false,plan;
  dialog.addEventListener('cancel',e=>{if(working)e.preventDefault();});dialog.addEventListener('close',()=>dialog.remove());
  const error=e=>{status.textContent=e.message;status.setAttribute('role','alert');status.focus();status.scrollIntoView({block:'nearest'});};
  const labels={knowledge_node:t('知识点','Knowledge'),relation:t('关系','Relations'),material:t('材料记录','Materials'),course:t('课程','Courses'),tag:t('标签','Tags'),evidence:t('依据记录','Evidence records'),preference:t('个人偏好','Preferences'),preference_context:t('偏好场景','Preference contexts'),preference_example:t('偏好示例','Preference examples')};
  try{
    plan=await request('/preview'+(taskId?'?task_id='+encodeURIComponent(taskId):''));
    const list=node('ul');for(const [key,label] of Object.entries(labels)){const count=plan.counts[key];if(count)list.append(node('li',`${label}：${count}`));}
    list.append(node('li',t('提案与审核记录','Proposals and reviews')+'：'+plan.proposal_count));
    if(!taskId){list.append(node('li',t('未完成编辑草稿','Unfinished editor drafts')+'：'+(plan.editor_drafts||0)),node('li',t('来源文件','Sources')+'：'+plan.source_count),node('li',t('材料整理任务','Extraction tasks')+'：'+plan.extraction_tasks),node('li',t('维护会话','Assistant sessions')+'：'+plan.assistant_sessions),node('li',t('学习事件','Learning events')+'：'+plan.learning_events),node('li',t('测试与评估文件','Evaluation files')+'：'+plan.evaluation_files));}
    content.append(list);
    if(plan.protected.length){content.append(node('h3',t('以下内容将保留','Content to preserve')));const kept=node('ul');for(const item of plan.protected)kept.append(node('li',item.title+' — '+item.reason));content.append(kept);}
    status.textContent=t('清理前会停止正在运行的任务。确认后立即生效；未选择备份时无法恢复。','Running tasks will be stopped first. Clearing takes effect immediately and cannot be undone without a backup.');confirm.disabled=false;
  }catch(e){error(e);}
  confirm.onclick=async()=>{
    working=true;confirm.disabled=true;cancel.disabled=true;backup.disabled=true;status.textContent=t('正在停止任务并清理，请稍候…','Stopping tasks and clearing content…');
    try{
      const result=await request('',{task_id:taskId,token:plan.token,backup:backup.checked,confirm:'clear-content'});
      content.replaceChildren();backupLabel.hidden=true;confirm.hidden=true;status.textContent=result.message;
      if(result.backup)content.append(node('p',t('备份已保存到：','Backup saved to: ')+result.backup));
      cancel.textContent=t('返回工作区','Return to workspace');cancel.disabled=false;cancel.onclick=()=>location.assign(result.url);dialog.addEventListener('close',()=>location.assign(result.url),{once:true});
    }catch(e){error(e);cancel.disabled=false;confirm.hidden=true;cancel.textContent=t('关闭并重新预览','Close and preview again');}
    finally{working=false;}
  };
}
document.querySelectorAll('[data-content-reset]').forEach(button=>button.addEventListener('click',()=>openContentReset()));
