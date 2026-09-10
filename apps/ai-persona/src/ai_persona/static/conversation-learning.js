import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
import {LearningWorkerControl} from './learning-worker-control.mjs?v=20260907.toggle1';
import {CodexSetup} from './codex-setup.mjs?v=20260909.remote1';
import {SettingsWorkspace} from './settings-workspace.mjs?v=20260909.setup1';

(() => {
  const $ = (id) => document.getElementById(id);
  const settingsForm = $('learning-settings'), retentionForm = $('learning-retention');
  let config = null;
  const workerControl = new LearningWorkerControl();
  let refreshSequence = 0, refreshing = 0, lastRefresh = 0;
  const errorLabels = {not_configured:ui('尚未配置模型'),context_length:ui('输入超过阶段预算'),
    runtime_missing:ui('模型运行依赖缺失，请运行 ai-persona models-install 并重启模型服务，无需重新授权'),
    runtime_unavailable:ui('本机模型服务不可用，请检查运行环境'),
    auth_required:ui('模型认证失败或没有访问权限，请在模型设置中检查授权'),
    connection_error:ui('模型网络连接失败，请稍后重试'),
    invalid_request:ui('模型接口拒绝了请求，请检查服务版本与任务配置'),
    invalid_model_output:ui('模型输出不符合约定'),internal_error:ui('内部错误，可检查后重试'),
    timeout:ui('模型请求超时'),stale_record:ui('Persona 已更新，请重试'),context_incomplete:ui('缺少相关记录'),
    codex_origin_unverified:ui('Codex 未提供人工来源验证（按来源信任设置处理）'),codex_identity_weak:ui('Codex 事件身份为兼容识别'),
    context_unavailable:ui('上下文不可用'),context_path_rejected:ui('上下文路径未授权'),
    context_format_unsupported:ui('会话格式暂不兼容'),capture_failed:ui('采集失败')};
  const fields = (form) => form.elements;
  const node = (tag,text,cls) => { const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el; };
  function notice(text,error=false){for(const id of ['learning-message','learning-settings-message']){const el=$(id);el.textContent=text;el.hidden=!text||id!=='learning-message';el.className=error?'error':'evaluation-muted';}}
  async function api(path,body){
    const response=await fetch('/api/learning/v1/'+path,{method:body===undefined?'GET':'POST',
      headers:body===undefined?{}:{'Content-Type':'application/json','X-AI-Persona':'1'},
      body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();if(!response.ok){const error=new Error(value.error?.message||ui('请求失败'));error.fields=value.error?.fields;throw error;}return value;
  }
  let settingsWrites=Promise.resolve();
  function saveSettings(patch){
    const write=settingsWrites.then(async()=>{
      const current=await api('config');
      return api('settings',{...current.settings,...patch});
    });
    settingsWrites=write.catch(()=>{});
    return write;
  }
  const savingForms=new Set();
  async function saveForm(form,action){if(savingForms.has(form))return;if(!config){notice(ui('尚未读取配置，请刷新后重试。'),true);return;}savingForms.add(form);
    const controls=[...form.elements],disabled=controls.map(n=>n.disabled);for(const n of controls)n.disabled=true;
    try{await action();}catch(e){notice(e.message,true);}finally{controls.forEach((n,i)=>{n.disabled=disabled[i];});savingForms.delete(form);}}
  const workspace=new SettingsWorkspace();
  const setup=new CodexSetup({api,workspace,onSaved:()=>refresh()});
  function renderMode(sync = false) {
    const f=fields(settingsForm);
    if (sync) { f.enabled.checked=f.learning_mode.value!=='off'; f.allow_model_calls.checked=f.learning_mode.value==='learn'; }
    else f.learning_mode.value=!f.enabled.checked?'off':f.allow_model_calls.checked?'learn':'capture';
    const modes={off:[ui('已关闭'),ui('不接收新的学习输入。')],capture:[ui('仅接收'),ui('接收范围内的新输入，暂不调用模型分析。')],learn:[ui('自动学习'),ui('接收并分析输入，按来源确认规则生成待审核候选，会消耗模型额度。')]};
    $('learning-mode-status').textContent=modes[f.learning_mode.value][0];
    $('learning-mode-help').textContent=modes[f.learning_mode.value][1];
  }
  fields(settingsForm).learning_mode.addEventListener('change',()=>renderMode(true));
  settingsForm.addEventListener('settings-restored',()=>renderMode());
  function renderWorker(){
    const view=workerControl.view,toggle=$('learning-worker-toggle'),status=$('learning-worker-status');
    toggle.textContent=view.label;toggle.disabled=view.disabled;
    toggle.setAttribute('aria-busy',String(workerControl.transitioning));
    status.textContent=ui('后台：')+view.status;status.dataset.state=view.state;
    $('learning-worker-help').textContent=view.hint;
  }
  async function refresh(fill=false){
    const sequence=++refreshSequence;refreshing++;lastRefresh=Date.now();
    try {
    let next;
    try { next=await api('config'); }
    catch(e){if(sequence===refreshSequence){workerControl.unavailable();renderWorker();}throw e;}
    if(sequence!==refreshSequence)return;
    config=next;const warning=workerControl.update(config);renderWorker();if(warning)notice(warning,true);
    $('learning-health').textContent=(config.settings.enabled?ui('采集已启用'):ui('采集关闭'))+' · '+
      (config.settings.allow_model_calls?ui('允许模型分析'):ui('模型分析关闭'));
    if(fill){const f=fields(settingsForm);for(const [key,value]of Object.entries(config.settings)){
      if(key==='learning_types'){for(const type of ['knowledge_node','preference','relation'])f[type].checked=value.includes(type);}
      else if(f[key]){if(typeof value==='boolean')f[key].checked=value;else f[key].value=value;}
    }renderMode();workspace.markSaved(settingsForm);
    if(retentionForm){for(const key of ['event_retention_days','observation_retention_days'])fields(retentionForm)[key].value=config.settings[key];workspace.markSaved(retentionForm);}}
    $('learning-diagnostics').textContent=[...new Set(config.diagnostics.map(d=>errorLabels[d.code]||d.code))].slice(0,3).join(' · ');
    setup.render(config);
    const enabled=config.connections.filter(c=>c.enabled);
    $('learning-source-summary').textContent=enabled.length?ui('接收已启用连接的信息：')+enabled.map(c=>c.name).join('、'):ui('尚无已启用的应用连接，请先配置应用接入。');
    await workspace.refresh(config);
    } finally { refreshing--; }
  }
  settingsForm.onsubmit=async e=>{e.preventDefault();await saveForm(settingsForm,async()=>{const f=fields(settingsForm),value={};
    for(const key of ['enabled','allow_model_calls'])value[key]=f[key].checked;
    for(const key of ['daily_calls','daily_tokens','event_retention_days','observation_retention_days'])if(f[key])value[key]=Number(f[key].value);
    value.learning_types=['knowledge_node','preference','relation'].filter(key=>f[key].checked);
    await saveSettings(value);workspace.markSaved(settingsForm);notice(ui('学习设置已保存。后台将按设置执行。'));await refresh();});};
  if(retentionForm)retentionForm.onsubmit=async e=>{e.preventDefault();await saveForm(retentionForm,async()=>{
    const value={};for(const key of ['event_retention_days','observation_retention_days'])value[key]=Number(fields(retentionForm)[key].value);
    await saveSettings(value);workspace.markSaved(retentionForm);notice(ui('保留策略已保存，学习与偏好应用开关未改变。'));await refresh();
  });};
  $('learning-worker-toggle').onclick=async()=>{
    const action=workerControl.begin();if(!action)return;
    refreshSequence++;notice('');renderWorker();
    try {
      await api('worker/'+action,{});workerControl.finish();
    } catch(e){workerControl.failed();notice(e.message,true);}
    renderWorker();await refresh().catch(e=>notice(e.message,true));
  };
  if($('learning-refresh'))$('learning-refresh').onclick=()=>workspace.reload();
  refresh(true).catch(e=>notice(e.message,true));
  fetch('/api/models/config').then(async response=>{if(!response.ok)throw new Error();return response.json();}).then(value=>{
    for(const el of document.querySelectorAll('[data-model-task]')) {
      const task=el.dataset.modelTask, route=value.taskRoutes?.find(t=>t.id===task);
      const previous=value.settings.routingVersion!==3?route?.previous?.[0]:null;
      const id=previous?previous.connectionId:route?.connectionId||value.settings.defaultConnectionId;
      const c=value.settings.connections.find(c=>c.id===id);
      const model=previous?previous.modelId:route?.connectionId?route.modelId||c?.modelId:value.settings.defaultModelId||c?.modelId;
      el.textContent=(el.dataset.modelLabel?ui(el.dataset.modelLabel)+'：':'')+(c?ui('当前模型：')+c.name+' / '+model:ui('尚未配置模型。'));
      if(c&&c.authType!=='none'&&!c.hasCredential)el.append(node('span',ui(' · 尚未完成认证')));
      if(value.settings.routingVersion!==3)el.append(node('span',ui(' · 配置调整待保存')));
      const link=node('a',ui('模型设置'));link.href='/settings/models';el.append(link);
    }
  }).catch(()=>{for(const el of document.querySelectorAll('[data-model-task]')){el.textContent=ui('暂时无法读取模型配置。');const link=node('a',ui('检查模型设置'));link.href='/settings/models';el.append(link);}});
  setInterval(()=>{
    if(!document.hidden&&!refreshing&&!workerControl.busy&&Date.now()-lastRefresh>=(workerControl.transitioning?1000:10000))refresh().catch(()=>{});
  },1000);
})();
