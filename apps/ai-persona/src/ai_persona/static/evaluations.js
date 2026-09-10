/* Guided evaluations. Feedback is edited at its original result in the inbox. */
(() => {
  const ui=window.StudioI18n?.ui||((text,...args)=>text.replace(/\{(\d+)\}/g,(_m,i)=>String(args[Number(i)]??'')));
  const {api, node} = window.EvaluationFeedback;
  const el = id => document.getElementById('evaluation-' + id);
  const selected = new Set(), selectedRevisions = new Map(), expandedReportItems = new Set();
  const modeNames = {activation:ui('偏好触发'),learning_trigger:ui('对话学习触发'),learning_content:ui('候选生成（固定原观察）'),learning_pipeline:ui('完整对话学习流程')};
  const states = {active:ui('可回测'),withdrawn:ui('已撤回'),completed:ui('已完成'),succeeded:ui('已完成'),running:ui('进行中'),queued:ui('等待运行'),failed:ui('失败'),cancelled:ui('已取消'),interrupted:ui('已中断'),completed_with_errors:ui('结束，部分结果未完成'),deleted:ui('已删除'),not_run:ui('未运行完成')};
  const effortNames={minimal:ui('最低'),low:ui('低'),medium:ui('中'),high:ui('高'),xhigh:ui('很高'),max:ui('最高')};
  let capabilities=[], prompts=[], cases=[], currentRun=null, timer=null, listRequest=0, detailRequest=0, casePage=0, view='run', preview=null, previewRequest=0, submitting=false, reportRequest=0;
  let step=1, config=null, baseline=null, editingPrompt=null, requestId=null, autoSelect=true, reportFilter='all', loading=true;
  const capability = () => el('capability').value;
  const mode = () => capability()==='persona.activation'?'activation':'learning_trigger';
  const intent = () => document.querySelector('input[name=evaluation-intent]:checked').value;
  const comparing = () => intent()!=='current';
  const automatic = () => intent()==='automatic';
  const stamp = value => new Date(value).toLocaleString(document.documentElement?.lang);
  const tell = (message,error=false) => {el('notice').hidden=!message;el('notice').textContent=message;el('notice').classList.toggle('error',error);};
  const handle = fn => async (...args) => {try{await fn(...args);}catch(e){tell(e.message,true);}};
  const button = (title,action) => {const b=node('button',title,'button ghost');b.type='button';b.addEventListener('click',handle(action));return b;};
  const link = (title,href) => {const a=node('a',title,'button ghost');a.href=href;return a;};
  const json = (title,value,open=false) => {const d=node('details','');d.open=open;d.append(node('summary',title),node('pre',JSON.stringify(value,null,2)));return d;};
  const option = (label,value) => {const o=node('option',label);o.value=value;return o;};
  const inputText = result => result.display_input ?? result.input?.current_user_prompt ?? result.input?.user_prompt ?? result.input?.event?.message?.content?.map(p=>p.text).join('\n') ?? '';
  const promptIds = () => mode()==='activation'?['ai-persona.activation']:['ai-persona.conversation-signal'];
  const versionControls = () => [...el('versions').querySelectorAll('select[data-prompt]')];
  const chosen = () => cases.filter(c=>selected.has(c.case_id));
  let lastIntent='current',candidateDrafts={};
  const captureCandidate=()=>({changes:['prompt','model','reasoning'].filter(k=>el('change-'+k).checked),connection:el('connection').value,model:el('model-id').value,reasoning:el('reasoning').value,versions:versionControls().map(s=>[s.dataset.prompt,s.value])});
  function restoreCandidate(draft){
    if(!draft)return;
    for(const key of ['prompt','model','reasoning'])el('change-'+key).checked=draft.changes?.includes(key)||false;
    if([...el('connection').options].some(o=>o.value===draft.connection))el('connection').value=draft.connection;
    populateModels(draft.model);populateReasoning(draft.reasoning);
    for(const [id,value] of draft.versions||[]){const select=versionControls().find(s=>s.dataset.prompt===id);if(select&&[...select.options].some(o=>o.value===value))select.value=value;}
  }
  function switchIntent(){
    candidateDrafts[lastIntent]=captureCandidate();
    const next=intent();restoreCandidate(candidateDrafts[next]||candidateDrafts[lastIntent]);lastIntent=next;
    el('step-label-2').hidden=!comparing();el('step-label-3').textContent=comparing()?ui('3 确认并运行'):ui('2 确认并运行');updateChanges();invalidatePreview();updateSelection();
  }
  function saveDraft(){
    if(loading)return;
    try{sessionStorage.setItem('persona-evaluation-draft-v2',JSON.stringify({capability:capability(),selected:[...selected],revisions:[...selectedRevisions],compare:comparing(),intent:intent(),candidateDrafts,optimizer:{connection:el('optimizer-connection').value,model:el('optimizer-model').value,reasoning:el('optimizer-reasoning').value,rounds:el('max-rounds').value},repeat:el('repeat').value,changes:['prompt','model','reasoning'].filter(k=>el('change-'+k).checked),connection:el('connection').value,model:el('model-id').value,reasoning:el('reasoning').value,versions:versionControls().map(s=>[s.dataset.prompt,s.value]),budget:['max-calls','max-tokens','timeout'].map(k=>[k,el(k).value])}));}catch{}
  }
  function locationState(key,value) {
    const q=new URLSearchParams(location.search);q.set('view',view);q.set('capability',capability());
    q.set('status',el('case-status').value||'active');q.set('page',String(casePage));
    el('search').value?q.set('q',el('search').value):q.delete('q');
    if(view!=='cases'){q.delete('case');q.delete('result');}if(view!=='reports')q.delete('run');
    if(key){value?q.set(key,value):q.delete(key);for(const other of ['case','run','result'])if(other!==key)q.delete(other);}
    history.replaceState(history.state||{},'','/evaluations?'+q);
    for(const input of document.querySelectorAll('form[action="/language"] input[name="return_to"]'))input.value='/evaluations?'+q;
  }
  function pushNavigation(){history.replaceState({evaluation:{listScroll:el('list').scrollTop,detailScroll:el('detail').scrollTop}},'');history.pushState({},'',location.href);}
  function focusDetail(){const heading=el('detail').querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
  function showView(value,push=false) {
    if(push)pushNavigation();detailRequest++;reportRequest++;
    view=['cases','run','reports'].includes(value)?value:'run';
    for(const key of ['cases','run','reports']){el(key+'-panel').hidden=key!==view;el(key+'-tab').setAttribute('aria-pressed',String(key===view));}
    if(view!=='reports')clearTimeout(timer);locationState();updateSelection();
  }
  function showStep(value){
    step=value;for(const n of [1,2,3]){el('step-'+n).hidden=n!==step;el('step-label-'+n).setAttribute('aria-current',n===step?'step':'false');}
    el('step-label-2').hidden=!comparing();el('step-label-3').textContent=comparing()?ui('3 确认并运行'):ui('2 确认并运行');
    const heading=el('step-'+step).querySelector('h2');heading.tabIndex=-1;heading.focus({preventScroll:true});
  }
  function updateSelection(){
    const labels=chosen().flatMap(c=>c.trigger_labels||[]),positive=labels.filter(l=>l.expected_trigger).length;
    el('selection').textContent=ui('已选择 {0} 条样例',selected.size);
    el('coverage').textContent=ui('该触发：{0} 个判断；不该触发：{1} 个判断。',positive,labels.length-positive)+(mode()==='activation'?' '+ui('偏好触发按已评价的场景分别计算。'):'');
    el('empty').hidden=cases.some(c=>c.status==='active'&&c.replay_capabilities?.includes(mode()));
    el('workload').textContent=automatic()?ui('每个候选都会重复检查。下一步会预览开发样例、验收样例和总调用上限。'):ui('{0} 条样例 × {1} 个方案 × {2} 次 = {3} 次独立检查。',selected.size,comparing()?2:1,el('repeat').value,selected.size*(comparing()?2:1)*Number(el('repeat').value));
    el('next-step').disabled=selected.size===0;el('to-run').disabled=selected.size===0;
    saveDraft();
  }
  function invalidatePreview(){previewRequest++;preview=null;requestId=null;el('consent').checked=false;el('consent').disabled=true;el('start').disabled=true;if(step===3)el('model-preview').replaceChildren(node('p',ui('配置已变化，请更新检查预览。'),'evaluation-muted'));saveDraft();}
  function resultLink(id,caseId){return '/inbox?'+new URLSearchParams({view:'all',item:'result:'+id,return_to:'/evaluations?'+new URLSearchParams({view:'cases',capability:capability(),status:el('case-status').value||'active',page:String(casePage),q:el('search').value||'',...(caseId?{case:caseId}:{})})});}
  function modes(){
    el('versions').replaceChildren();
    for(const p of prompts.filter(p=>promptIds().includes(p.id))){
      const label=node('label',p.name||p.id),select=node('select','');select.dataset.prompt=p.id;
      select.append(option(ui('当前启用版本'),''));
      for(const version of p.versions||[]){const o=option(`${version.note||version.id.slice(0,8)} · ${stamp(version.created_at)}`,version.id);o.disabled=version.compatible===false;select.append(o);}
      label.append(select);el('versions').append(label,button(ui('编辑并另存提示词'),()=>editPrompt(p.id,select.value||p.active_version)));
    }
    el('process').textContent=mode()==='activation'?ui('读取样例中保存的输入与偏好场景 → 判断各场景是否触发 → 对照已评价的场景。'):ui('读取样例中保存的对话 → 判断是否触发学习 → 必要时补充已保存的上下文后再判断。处理步骤固定，可调整这一判断使用的提示词和模型。');
  }
  async function loadModels(){
    const current=capability();
    const [value,selection]=await Promise.all([api('models'),api('selection?'+new URLSearchParams({mode:mode()}))]);
    if(current!==capability())return;
    config=value;baseline=selection;
    el('baseline').replaceChildren(node('p',selection.name+' / '+selection.selection.modelId),node('p',ui('思考强度：{0}',effortNames[selection.reasoning]||ui('跟随模型默认（未指定）')),'evaluation-muted'));
    for(const p of prompts.filter(p=>promptIds().includes(p.id)))el('baseline').append(node('p',`${p.name} · ${p.active.note||p.active_version.slice(0,8)}`,'evaluation-muted'));
    el('connection').replaceChildren(...config.settings.connections.map(c=>option(c.name||c.id,c.id)));el('connection').value=baseline.selection.connectionId;populateModels();updateChanges();
    const kept=el('optimizer-connection').value;
    el('optimizer-connection').replaceChildren(...config.settings.connections.map(c=>option(c.name||c.id,c.id)));
    el('optimizer-connection').value=config.settings.connections.some(c=>c.id===kept)?kept:baseline.selection.connectionId;populateOptimizer();
  }
  function populateModels(preferred){
    const connection=config?.settings.connections.find(c=>c.id===el('connection').value);
    const models=config?.providers?.find(p=>p.id===connection?.providerId)?.models||[];
    const ids=[...new Set([connection?.modelId,...models.map(m=>m.id),...(connection?.id===baseline?.selection.connectionId?[baseline.selection.modelId]:[])].filter(Boolean))];
    el('model-id').replaceChildren(...ids.map(id=>option(models.find(m=>m.id===id)?.name||id,id)));
    el('model-id').value=preferred&&ids.includes(preferred)?preferred:connection?.id===baseline?.selection.connectionId?baseline.selection.modelId:connection?.modelId||ids[0]||'';populateReasoning();
  }
  function populateReasoning(preferred){
    const connectionId=automatic()||el('change-model').checked?el('connection').value:baseline?.selection.connectionId;
    const modelId=automatic()||el('change-model').checked?el('model-id').value:baseline?.selection.modelId;
    const connection=config?.settings.connections.find(c=>c.id===connectionId);
    const levels=config?.capabilities?.evaluationReasoning===1?(config.providers?.find(p=>p.id===connection?.providerId)?.models.find(m=>m.id===modelId)?.reasoningLevels||[]):[];
    el('reasoning').replaceChildren(option(ui('跟随模型默认（未指定）'),''),...levels.map(v=>option(effortNames[v]||v,v)));
    const initial=preferred===undefined&&connectionId===baseline?.selection.connectionId&&modelId===baseline?.selection.modelId?baseline?.reasoning:preferred;
    el('reasoning').value=levels.includes(initial)?initial:'';
    el('reasoning').disabled=levels.length===0;
    el('reasoning-hint').textContent=levels.length?ui('只显示这个模型支持的档位。默认档位由模型服务决定。'):ui('此模型未提供可设置的思考档位，将使用模型默认行为。');
  }
  function updateChanges(){
    for(const key of ['prompt','model','reasoning'])el(key==='prompt'?'versions':key+'-fields').hidden=!el('change-'+key).checked;
    el('automatic-settings').hidden=!automatic();
    for(const key of ['model','reasoning']){el('change-'+key).closest('label').hidden=automatic();if(automatic())el(key+'-fields').hidden=false;}
    el('reference').hidden=automatic();
    el('adjustment-help').textContent=automatic()?ui('当前方案 A 固定不变。选择改进模型和候选触发模型后，AI 会从起始提示词提出改进。'):ui('修改前使用当前方案。候选方案从当前方案复制，只有勾选的项目会改变。');
    el('prompt-choice-label').textContent=automatic()?ui('选择起始提示词（可选）'):ui('修改提示词');
    el('start').textContent=automatic()?ui('开始自动改进'):ui('开始检查');
    const titles={prompt:ui('提示词'),model:ui('模型'),reasoning:ui('思考强度')};
    const changes=Object.keys(titles).filter(k=>el('change-'+k).checked).map(k=>titles[k]);
    el('changes').textContent=automatic()?ui('AI 将改进提示词；候选触发模型按上方选择固定。'):changes.length?ui('本次调整：{0}',changes.join('、')):ui('尚未修改；两个方案将使用相同配置。');
  }
  function populateOptimizer(preferred,effort){
    const connection=config?.settings.connections.find(c=>c.id===el('optimizer-connection').value);
    const models=config?.providers?.find(p=>p.id===connection?.providerId)?.models||[];
    const kept=preferred||el('optimizer-model').value;
    const ids=[...new Set([connection?.modelId,...models.map(m=>m.id)].filter(Boolean))];
    el('optimizer-model').replaceChildren(...ids.map(id=>option(models.find(m=>m.id===id)?.name||id,id)));
    el('optimizer-model').value=ids.includes(kept)?kept:connection?.modelId||ids[0]||'';
    const levels=config?.capabilities?.evaluationReasoning===1?(models.find(m=>m.id===el('optimizer-model').value)?.reasoningLevels||[]):[];
    const old=effort??el('optimizer-reasoning').value;
    el('optimizer-reasoning').replaceChildren(option(ui('跟随模型默认（未指定）'),''),...levels.map(v=>option(effortNames[v]||v,v)));
    el('optimizer-reasoning').value=levels.includes(old)?old:'';el('optimizer-reasoning').disabled=!levels.length;
  }
  async function editPrompt(id,version){
    const p=prompts.find(p=>p.id===id),v=p.versions.find(v=>v.id===version)||p.active;
    editingPrompt={id,version:v.id,templates:v.templates};el('prompt-fields').replaceChildren();
    for(const [key,value] of Object.entries(v.templates)){const label=node('label',key==='system'?ui('判断规则'):key==='user'?ui('输入模板'):key),area=node('textarea','');area.value=value;area.dataset.field=key;area.rows=key==='system'?14:5;area.maxLength=50000;label.append(area);el('prompt-fields').append(label);}
    el('prompt-note').value='';el('prompt-error').textContent='';el('prompt-editor').showModal();
  }
  async function improvementReference(){
    const current=capability(),ids=new Set(selected),values=(await api('references?capability_id='+encodeURIComponent(current))).items;
    if(current!==capability())return;
    const container=el('reference-list');container.replaceChildren();
    for(const item of values.filter(v=>ids.has(v.case_id))){const card=node('section','','evaluation-decision');card.append(node('strong',item.subject.context_key||ui('对话学习触发')),node('p',item.input_text),node('p',item.reason),button(ui('查看对应样例'),()=>openCase(item.case_id)));container.append(card);}
    if(!container.children.length)container.append(node('p',ui('所选样例没有填写不满意理由。仍可调整并检查。'),'evaluation-muted'));
  }
  function configuration(){
    const variants=[{source:'active'}];
    if(comparing())variants.push({source:'active',...(el('change-prompt').checked?{versions:Object.fromEntries(versionControls().filter(s=>s.value).map(s=>[s.dataset.prompt,s.value]))}:{}),...(automatic()||el('change-model').checked?{connection_id:el('connection').value,model_id:el('model-id').value}:{}),...(automatic()||el('change-reasoning').checked?{reasoning:el('reasoning').value||null}:{})});
    return {mode:mode(),cases:chosen().map(c=>({case_id:c.case_id,benchmark_revision:selectedRevisions.get(c.case_id)||c.benchmark_revision})),variants,repeat_count:Number(el('repeat').value),max_calls:Number(el('max-calls').value),max_tokens:Number(el('max-tokens').value),timeout_seconds:Number(el('timeout').value),...(automatic()?{optimization:{optimizer:{connection_id:el('optimizer-connection').value,model_id:el('optimizer-model').value,reasoning:el('optimizer-reasoning').value||null},max_rounds:Number(el('max-rounds').value)}}:{})};
  }
  function planCard(v,index,promptVersions){
    const section=node('section','','evaluation-plan');section.append(node('h3',index===0?ui('A · 当前方案'):ui('B · 候选方案')));
    section.append(node('p',`${v.connection_name||v.selection?.connectionId} / ${v.selection?.modelId}`));
    section.append(node('p',ui('思考强度：{0}',v.reasoning?effortNames[v.reasoning]||v.reasoning:ui('跟随模型默认（未指定）'))));
    for(const [key,p] of Object.entries(promptVersions||{}))if(promptIds().includes(key))section.append(node('p',`${prompts.find(p=>p.id===key)?.name||key} · ${p.note||p.id.slice(0,8)}`,'evaluation-muted'));
    return section;
  }
  async function previewPlan(){
    if(!selected.size)throw new Error(ui('请先选择测试样例。'));
    const raw=configuration(),request=++previewRequest;el('to-confirm').disabled=true;el('next-step').disabled=true;el('preview').disabled=true;
    try{
      const value=await api(automatic()?'optimizations/preview':'preview',raw);if(request!==previewRequest)return;
      preview={...value,raw};requestId=crypto.randomUUID();showStep(3);
      const container=el('model-preview');container.replaceChildren();const grid=node('div','','evaluation-plan-grid');
      value.variants.forEach((v,i)=>grid.append(planCard(v,i,Object.values(v.prompt_versions)[0])));container.append(grid);
      if(value.optimization){const opt=value.optimization;container.append(node('h3',ui('改进模型')),node('p',`${opt.optimizer.connection_name} / ${opt.optimizer.selection.modelId} · ${effortNames[opt.optimizer.reasoning]||ui('模型默认思考强度')}`),node('p',ui('开发 {0} 条 · 独立验收 {1} 条 · 每个方案重复 {2} 次 · 最多改进 {3} 轮',opt.split.development.length,opt.split.validation.length,value.repeat_count,opt.max_rounds)),node('p',ui('改进模型只读取开发样例及其反馈理由。验收只在候选冻结后运行。'),'evaluation-muted'));if(opt.split.grouping_note)container.append(node('p',opt.split.grouping_note,'evaluation-muted'));if(opt.split.limitation)container.append(node('p',opt.split.limitation,'evaluation-warning'));}
      else container.append(node('p',ui('{0} 条样例 × {1} 个方案 × {2} 次 = {3} 次独立检查。',value.cases.length,value.variants.length,value.repeat_count,value.planned_replays)));
      container.append(node('p',ui('预计最多 {0} 次模型调用；上限 {1} 次、{2} token、{3} 秒。',value.maximum_calls,value.budget.max_calls,value.budget.max_tokens,value.budget.timeout_seconds),'evaluation-muted'));
      if(value.budget_may_limit_run)container.append(node('p',ui('调用上限低于预计用量，可能只能完成部分检查。可在“运行限额”中调整。'),'evaluation-warning'));
      for(const [key,title] of [['should_trigger',ui('该触发')],['should_not_trigger',ui('不该触发')]])if(!value.coverage[key])container.append(node('p',ui('“{0}”暂无对应样例，本次无法计算这一类正确率。',title),'evaluation-warning'));
      if(!automatic()&&comparing()&&value.variants[0].selection.modelId===value.variants[1].selection.modelId&&value.variants[0].selection.connectionId===value.variants[1].selection.connectionId&&value.variants[0].reasoning===value.variants[1].reasoning&&JSON.stringify(value.variants[0].prompt_versions)===JSON.stringify(value.variants[1].prompt_versions))container.append(node('p',ui('两个方案的配置相同，本次比较只能观察重复运行的波动。'),'evaluation-warning'));
      el('consent').disabled=false;el('consent').checked=false;
    }finally{el('to-confirm').disabled=false;el('preview').disabled=false;el('next-step').disabled=!selected.size;}
  }
  async function refreshList() {
    const request=++listRequest,current=capability();
    const response=await api('cases?capability_id='+encodeURIComponent(current)),values=response.items;
    if(request!==listRequest||current!==capability())return;
    if(response.answer_sync_state==='failed')tell(ui('审核答案同步失败，反馈与已发布内容不受影响；请稍后刷新重试。'),true);
    cases=values;
    const valid=new Set(cases.filter(c=>c.status==='active'&&c.replay_capabilities?.includes(mode())).map(c=>c.case_id));
    for(const id of selected)if(!valid.has(id)){selected.delete(id);selectedRevisions.delete(id);invalidatePreview();}
    if(autoSelect){for(const c of cases.filter(c=>valid.has(c.case_id)).slice(0,200))selected.add(c.case_id);autoSelect=false;}
    const status=el('case-status').value||'active',query=(el('search').value||'').toLocaleLowerCase();
    const filtered=cases.filter(c=>(status==='all'||status==='unavailable'&&c.status==='active'&&!c.replay_capabilities?.includes(mode())||status==='withdrawn'&&c.status==='withdrawn'||status==='active'&&c.status==='active'&&c.replay_capabilities?.includes(mode()))&&(!query||(c.input_preview||'').toLocaleLowerCase().includes(query)));
    casePage=Math.min(casePage,Math.max(0,Math.ceil(filtered.length/20)-1));
    const list=el('list');list.replaceChildren();
    for(const item of filtered.slice(casePage*20,(casePage+1)*20)){
      const row=node('div','','evaluation-list-item'),checkbox=node('input','');checkbox.type='checkbox';checkbox.checked=selected.has(item.case_id);checkbox.disabled=!valid.has(item.case_id);checkbox.setAttribute('aria-label',ui('选择样例 ')+(item.input_preview||stamp(item.created_at)));
      checkbox.addEventListener('change',()=>{autoSelect=false;if(checkbox.checked&&selected.size>=200){checkbox.checked=false;tell(ui('一次最多检查 200 条样例，请分批选择。'),true);return;}checkbox.checked?selected.add(item.case_id):selected.delete(item.case_id);selectedRevisions.delete(item.case_id);invalidatePreview();updateSelection();});
      row.dataset.caseId=item.case_id;
      row.append(checkbox,button(item.input_preview||stamp(item.created_at),()=>openCase(item.case_id)));
      row.append(node('small',(item.status==='active'&&!item.replay_capabilities?.length?ui('缺少回放输入'):states[item.status])+' · '+item.trigger_labels.length+ui(' 个有效标签 · ')+item.content_gold.length+ui(' 条审核答案 · v')+item.benchmark_revision,'evaluation-muted'));list.append(row);
    }
    if(!filtered.length)list.append(node('p',ui('当前没有符合条件的测试样例。只有在反馈与审核中明确评价，才会收录。'),'evaluation-muted'));
    el('case-count').textContent=filtered.length+ui(' 条样例 · 第 ')+(casePage+1)+ui(' 页');
    el('prev').disabled=casePage===0;el('next').disabled=(casePage+1)*20>=filtered.length;updateSelection();
  }
  function resultDetails(result,container){
    container.append(node('p',inputText(result)||ui('输入内容已清理；不补造历史输入。'),'evaluation-input'),node('p',ui('原运行：')+(states[result.state]||result.state)+' · '+stamp(result.created_at),'evaluation-muted'));
    if(result.generation!=null)container.append(json(ui('原生成内容（不是标准答案）'),result.generation));
    container.append(json(ui('必要输入与原运行快照'),{input:result.input,prompt_snapshot:result.prompt_snapshot,stages:result.stages,environment_changed:result.environment_changed}));
  }
  async function openResult(id,navigate=true){
    const request=++detailRequest,result=await api('results/'+id);if(request!==detailRequest)return;
    if(navigate)pushNavigation();showView('cases');locationState('result',id);el('root').dataset.detailOpen='true';const container=el('detail');container.replaceChildren(node('h2',ui('历史运行结果')));resultDetails(result,container);
    const replay=result.parent_case_id||String(result.task_ref||'').startsWith('evaluation:');
    container.append(replay?node('p',ui('这是评测模拟结果，不收集新的触发反馈。')):link(ui('前往原结果反馈'),resultLink(id)));focusDetail();
  }
  async function openCase(id,navigate=true){
    const request=++detailRequest,item=await api('cases/'+id);if(request!==detailRequest)return;
    if(navigate)pushNavigation();showView('cases');locationState('case',id);el('root').dataset.detailOpen='true';
    const container=el('detail');container.dataset.caseId=id;container.replaceChildren(node('h2',ui('测试样例 · v')+item.benchmark_revision),node('p',item.status==='active'&&!item.replay_capabilities.length?ui('缺少回放输入'):states[item.status]||item.status,'evaluation-muted'));resultDetails(item.result,container);
    if(item.answer_sync_state==='failed')container.append(node('p',ui('审核答案同步失败，下面的答案可能不完整；请重新打开样例重试。已发布内容不受影响。'),'error'));
    container.append(node('p',ui('可回放：')+(item.replay_capabilities.map(m=>modeNames[m]).join('、')||ui('缺少必要快照')),'evaluation-muted'));
    for(const label of item.trigger_labels)container.append(node('p',(label.subject.context_key||ui('对话学习'))+ui('：原判断')+(label.actual_trigger?ui('触发'):ui('不触发'))+ui(' → 期望')+(label.expected_trigger?ui('触发'):ui('不触发'))));
    container.append(json(ui('审核答案（')+item.content_gold.length+ui(' 条，仅代表已通过部分）'),item.content_gold,item.content_gold.length>0),node('p',ui('冻结版本：当前 v')+item.benchmark_revision+ui('，共 ')+item.revision_count+ui(' 个历史版本。正式记录的后续编辑不会改写过去的审核答案。'),'evaluation-muted'));
    const actions=node('div','','evaluation-actions');actions.append(link(ui('修改原反馈／取消反馈'),resultLink(item.result_id,item.case_id)));
    actions.append(button(ui('删除样例'),async()=>{
      if(!confirm(ui('彻底删除此样例、理由、历史输入及报告中的该样例正文？已导出的备份不会自动删除。此操作不可恢复，原业务记录和 Persona 不受影响。')))return;
      await api('cases/'+id+'/delete',{confirm:true});selected.delete(id);selectedRevisions.delete(id);invalidatePreview();container.replaceChildren(node('p',ui('样例及本地历史正文已删除。原业务记录和 Persona 未改变。')));await refreshList();await refreshRuns();
    }));container.append(actions);focusDetail();
  }
  async function refreshSuites(){
    const current=capability(),all=(await api('suites')).items;if(current!==capability())return;
    const suites=all.filter(s=>s.cases.some(c=>cases.some(i=>i.case_id===c.case_id)));
    el('suites').replaceChildren(...suites.map(s=>button(s.name+' · '+s.cases.length+ui(' 条'),async()=>{
      autoSelect=false;selected.clear();selectedRevisions.clear();
      for(const c of s.cases)if(cases.some(i=>i.case_id===c.case_id&&i.status==='active'&&i.replay_capabilities?.includes(mode()))){selected.add(c.case_id);selectedRevisions.set(c.case_id,c.benchmark_revision);}
      invalidatePreview();await refreshList();tell(ui('已选择该测试集仍有效的标签，使用集合中保存的冻结版本。已撤回标签仍被排除。'));
    })));
    if(!suites.length)el('suites').append(node('p',ui('开始评测时会保存所选样例及版本。'),'evaluation-muted'));
  }
  const fraction = v => !v || v.rate == null ? ui('无法计算') : `${(v.rate * 100).toFixed(1)}% · ${v.numerator}/${v.denominator}`;
  const trigger = v => v===true?ui('触发'):v===false?ui('不触发'):ui('未判定');
  function caseUnstable(items){
    const groups=new Map();for(const item of items)for(const unit of item.score?.units||[]){if(!unit.completed)continue;const key=item.variant+JSON.stringify(unit.subject);if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(unit.actual);}return [...groups.values()].some(v=>v.size>1);
  }
  async function openRun(id, activate = true, navigate = true) {
    if(activate){showView('reports',navigate);locationState('run',id);}
    currentRun=id;clearTimeout(timer);const request=++reportRequest,run=await api('runs/'+id);
    if(currentRun!==id||request!==reportRequest||view!=='reports')return;
    if(run.capability_id!==capability()){el('capability').value=run.capability_id;selected.clear();selectedRevisions.clear();autoSelect=true;modes();await refreshList();locationState('run',id);}
    renderReport(run);
    if(['queued','running'].includes(run.status)&&view==='reports')timer=setTimeout(handle(()=>openRun(id,false)),1500);
    else await refreshRuns();
  }
  function renderReport(run){
    const id=run.id,container=el('report'),running=['queued','running'].includes(run.status);
    const variantName=label=>run.comparison_labels?.[label]||(run.workflow_version===2?(label==='A'?ui('当前方案'):ui('候选方案')):ui('历史方案 {0}',label));
    container.replaceChildren(node('h2',`${modeNames[run.mode]} · ${states[run.status]||run.status}`));
    if(run.created_at)container.append(node('p',ui('配置固定于 {0}，后续修改不会改变这份报告。',stamp(run.created_at)),'evaluation-muted'));
    const done=(run.results||[]).filter(r=>!['queued','running'].includes(r.status)).length,total=run.planned_replays||run.results?.length||0;
    const progressLabel=node('p',ui('已结束 {0}/{1} 次检查 · 每条样例重复 {2} 次 · 已调用模型 {3} 次',done,total,run.repeat_count||1,run.calls||0),'evaluation-muted');container.append(progressLabel);
    const progress=node('progress','');progress.max=Math.max(1,total);progress.value=done;progress.setAttribute('aria-label',ui('检查进度'));container.append(progress);
    if(run.kind==='optimization'){progress.max=Math.max(1,run.budget.max_calls);progress.value=run.calls||0;progress.setAttribute('aria-label',ui('模型调用额度使用'));progressLabel.textContent=ui('已调用 {0}/{1} 次模型 · 每个方案重复 {2} 次',run.calls||0,run.budget.max_calls,run.repeat_count||1);}
    if(running)container.append(button(ui('停止检查并保留结果'),async()=>{await api(`runs/${id}/cancel`,{});await openRun(id,false);await refreshRuns();}));
    else if(!run.private_content_deleted)container.append(button(ui('用这些样例手动改进'),()=>continueRun(run)));
    if(run.kind==='optimization'){renderOptimization(run,container);if(running)return;}
    if(!running&&run.variants?.length===2&&!run.parent_id&&!run.private_content_deleted)renderCandidate(run,container);
    if(['cancelled','interrupted','completed_with_errors','failed'].includes(run.status))container.append(node('p',ui('已保留完成的结果。未完成项目单独列出，不算作判断错误。'),'evaluation-warning'));
    if(run.error)container.append(node('p',run.error.message,'evaluation-warning'));
    const grid=node('div','','evaluation-plan-grid');
    for(const [name,stats] of Object.entries(run.report?.variants||{})){
      const card=node('section','','evaluation-plan evaluation-scorecard'),variant=run.variants?.[name==='A'?0:1];card.append(node('h3',`${name} · ${variantName(name)}`));
      card.append(node('p',[variant?.connection_name,variant?.selection?.modelId||run.selection?.modelId].filter(Boolean).join(' / '), 'evaluation-muted'));
      card.append(node('p',ui('思考强度：{0}',variant?.reasoning?effortNames[variant.reasoning]||variant.reasoning:ui('跟随模型默认（未指定）')),'evaluation-muted'));
      if(variant?.source==='original')card.append(node('p',ui('提示词：各样例原运行版本'),'evaluation-muted'));
      else for(const [key,v] of Object.entries(Object.values(variant?.snapshots||{})[0]?.versions||{}))if(prompts.some(p=>p.id===key))card.append(node('p',`${prompts.find(p=>p.id===key)?.name||key} · ${v.note||v.id.slice(0,8)}`,'evaluation-muted'));
      for(const [key,title] of [['should_not_trigger',ui('不该触发的正确率')],['should_trigger',ui('该触发的正确率')]]){
        const metric=node('div','','evaluation-score');metric.append(node('span',title),node('strong',fraction(stats[key])));
        if(stats[key]?.rate==null)metric.append(node('small',stats.coverage?.[key]?ui('暂无完成的有效判断'):ui('暂无对应样例')));card.append(metric);
      }
      card.append(node('p',ui('重复判断一致率：{0}',fraction(stats.stability))));
      card.append(node('p',ui('失败 {0} · 未判定 {1} · 未运行完成 {2} · 等待中 {3}',stats.failures||0,stats.undecided||0,stats.not_run||0,stats.pending||0),'evaluation-muted'));
      grid.append(card);
    }
    container.append(grid,node('p',ui('正确率按已完成的明确判断计算，斜线两侧的计数为“正确数/有效判断数”。重复判断一致率仅统计所有重复均完成的样例判断，一致也可能一直判错。'),'evaluation-muted'));
    container.append(node('h3',ui('逐条查看结果')));
    const filter=node('select','');filter.setAttribute('aria-label',ui('筛选检查结果'));filter.append(option(ui('全部结果'),'all'),option(ui('有错误或未完成'),'issues'),option(ui('重复判断不一致'),'unstable'));filter.value=reportFilter;filter.addEventListener('change',()=>{reportFilter=filter.value;renderReport(run);});container.append(filter);
    const grouped=new Map();for(const item of run.results||[]){if(!grouped.has(item.case_id))grouped.set(item.case_id,[]);grouped.get(item.case_id).push(item);}
    let displayed=0;
    for(const [caseId,items] of grouped){
      if(reportFilter==='issues'&&!items.some(i=>i.status!=='succeeded'||i.score?.units?.some(u=>!u.correct)))continue;
      if(reportFilter==='unstable'&&!caseUnstable(items))continue;
      displayed++;const detail=node('details','','evaluation-trial'),key=id+':'+caseId;
      detail.open=expandedReportItems.has(key);detail.addEventListener('toggle',()=>detail.open?expandedReportItems.add(key):expandedReportItems.delete(key));
      const reference=items.find(i=>i.reference)?.reference,summary=inputText(reference||{})||items[0].input_preview||ui('样例 {0}',[...grouped.keys()].indexOf(caseId)+1);
      detail.append(node('summary',summary.slice(0,110)+(caseUnstable(items)?' · '+ui('判断有波动'):'')));
      if(reference)detail.append(node('p',inputText(reference),'evaluation-input'));
      const wrap=node('div','','evaluation-table-scroll'),table=node('table','','evaluation-results-table'),head=node('tr','');
      for(const title of [ui('方案 / 次数'),ui('检查对象'),ui('期望'),ui('实际'),ui('结果')])head.append(node('th',title));const thead=node('thead','');thead.append(head);table.append(thead);const body=node('tbody','');
      for(const item of [...items].sort((a,b)=>(a.repeat_index||1)-(b.repeat_index||1)||a.variant.localeCompare(b.variant))){
        const units=item.score?.units?.length?item.score.units:[null];
        for(const unit of units){const row=node('tr','');for(const text of [`${item.variant} · ${ui('第 {0} 次',item.repeat_index||1)}`,unit?.subject?.context_key||ui('对话学习触发'),unit?trigger(unit.expected):'—',item.status==='succeeded'&&unit?trigger(unit.actual):'—',item.status!=='succeeded'?states[item.status]||item.status:!unit?.completed?ui('未判定'):unit.correct?ui('正确'):ui('错误')])row.append(node('td',text));body.append(row);}
        if(item.error){const row=node('tr',''),cell=node('td',item.error.message,'evaluation-muted');cell.colSpan=5;row.append(cell);body.append(row);}
      }
      table.append(body);wrap.append(table);detail.append(wrap);
      for(const item of items){
        const rawDetail=node('details',''),trialKey=key+':'+item.variant+':'+(item.repeat_index||1);rawDetail.open=expandedReportItems.has(trialKey);rawDetail.addEventListener('toggle',()=>rawDetail.open?expandedReportItems.add(trialKey):expandedReportItems.delete(trialKey));rawDetail.append(node('summary',ui('{0} · 第 {1} 次 · 查看输出与调用记录',item.variant,item.repeat_index||1)));
        if(item.output)rawDetail.append(json(ui('本次模拟输出'),item.output));
        if(item.reference)rawDetail.append(json(ui('冻结输入与审核参考'),item.reference));
        if(item.calls?.length)rawDetail.append(json(ui('模型调用与实际用量'),item.calls));
        if(!running&&item.status==='succeeded'&&item.score?.content?.semantic_status!=='not_scored'&&item.score?.content?.reference_count){
          const judgments=[['correct',ui('内容符合标准答案')],['incorrect',ui('内容不符合')],['undetermined',ui('暂无法判断')]],saved=judgments.find(([v])=>v===item.score.content.semantic_status);
          rawDetail.append(node('p',saved?ui('已保存内容评价：{0}',saved[1]):ui('内容评价：尚未评价')));
          for(const [judgment,title] of judgments){const control=button(title,async()=>{await api(`runs/${id}/review`,{case_id:item.case_id,variant:item.variant,repeat_index:item.repeat_index||1,judgment});expandedReportItems.add(key);expandedReportItems.add(trialKey);await openRun(id,false);tell(ui('已保存内容评价：{0}',title));});control.setAttribute('aria-pressed',String(saved?.[0]===judgment));rawDetail.append(control);}
        }
        detail.append(rawDetail);
      }
      if(!items.every(i=>i.status==='deleted'))detail.append(button(ui('查看原测试样例'),()=>openCase(caseId)));
      container.append(detail);
    }
    if(!displayed)container.append(node('p',ui('没有符合条件的结果。'),'evaluation-muted'));
    container.append(json(ui('固定版本、模型与预算'),{variants:run.variants,budget:run.budget,build_signature:run.build_signature,suite:run.suite,actual_tokens:run.actual_tokens}));
  }
  const outcomes={improved:ui('两类正确率均未下降，至少一类提高'),simplified:ui('正确率相同，提示词更简洁'),unchanged:ui('没有观察到改善'),tradeoff:ui('一类提高，但另一类下降'),regressed:ui('出现退步'),insufficient:ui('证据不足'),invalid:ui('候选格式不符合要求'),not_evaluated:ui('额度不足，未评测此候选'),stopped:ui('未提出进一步修改')};
  function renderOptimization(run,container){
    const opt=run.optimization;
    if(!opt){container.append(node('p',ui('关联样例已删除，自动改进派生内容已清理。'),'evaluation-warning'));return;}
    const section=node('section','','evaluation-optimization-report');
    section.append(node('h3',ui('自动改进进度')),node('p',`${ui('改进模型')}：${opt.optimizer.connection_name} / ${opt.optimizer.selection.modelId} · ${effortNames[opt.optimizer.reasoning]||ui('模型默认思考强度')}`));
    if(opt.split.grouping_note)section.append(node('p',opt.split.grouping_note,'evaluation-muted'));if(opt.split.limitation)section.append(node('p',opt.split.limitation,'evaluation-warning'));
    const stageNames={starting_comparison:ui('起始方案检查'),validation:ui('独立验收'),exploratory_comparison:ui('开发样例上的最终比较')};
    for(const stage of run.stages||[]){const line=node('div','','evaluation-stage');line.append(button((stageNames[stage.name]||ui('第 {0} 轮比较',stage.name.split('_')[1]))+' · '+(states[stage.status]||stage.status),()=>openRun(stage.run_id)));section.append(line);}
    for(const round of run.rounds||[]){const detail=node('details','','evaluation-round');detail.append(node('summary',ui('第 {0} 轮',round.round)+' · '+(outcomes[round.decision]||states[round.status]||ui('正在修改'))));if(round.summary)detail.append(node('p',ui('模型说明：')+round.summary));if(round.hypothesis)detail.append(node('p',ui('预期作用（模型推测）：')+round.hypothesis,'evaluation-muted'));if(round.error)detail.append(node('p',round.error,'evaluation-warning'));if(round.report){const a=round.report.variants?.A,b=round.report.variants?.B;for(const [key,title] of [['should_not_trigger',ui('不该触发的正确率')],['should_trigger',ui('该触发的正确率')]])detail.append(node('p',title+'：'+fraction(a?.[key])+' → '+fraction(b?.[key])));}detail.append(json(ui('完整修改与模型输出'),{templates:round.templates,model_output:round.model_output}));section.append(detail);}
    if(run.outcome)section.append(node('h3',(opt.split.independent_validation?ui('独立验收结论'):ui('探索结果'))+'：'+(outcomes[run.outcome]||run.outcome)),node('p',ui('这是本次样例上的观察。重复运行不增加独立样例数，也不能证明统计显著性。'),'evaluation-muted'));
    if(run.stop_reason&&!['running','queued'].includes(run.status))section.append(node('p',ui('停止原因：')+run.stop_reason));
    for(const [role,title] of [['optimizer',ui('改进模型')],['baseline_trigger',ui('当前方案触发模型')],['candidate_trigger',ui('候选方案触发模型')]]){const usage=run.usage_by_role?.[role];if(usage)section.append(node('p',ui('{0}：{1} 次调用 · 已报告用量 {2} token · 失败 {3} 次 · {4} 秒',title,usage.calls,usage.actual_tokens,usage.failed||0,((usage.duration_ms||0)/1000).toFixed(1)),'evaluation-muted'));}
    section.append(json(ui('逐次调用记录'),run.call_log||[]));container.append(section);
    if(run.final_run_id)container.append(node('h3',opt.split.independent_validation?ui('以下为独立验收结果'):ui('以下为开发样例上的最终比较')));
  }
  function renderCandidate(run,container){
    const [a,b]=run.variants,key=run.current_plan?.prompt_id;
    const av=Object.values(a.snapshots||{})[0]?.versions?.[key],bv=Object.values(b.snapshots||{})[0]?.versions?.[key];if(!av||!bv)return;
    const section=node('section','','evaluation-candidate-report');section.append(node('h3',ui('候选方案改了什么？')));
    section.append(node('p',`${ui('触发模型')}：${a.connection_name||a.selection.connectionId} / ${a.selection.modelId} → ${b.connection_name||b.selection.connectionId} / ${b.selection.modelId}`));
    section.append(node('p',`${ui('思考强度')}：${effortNames[a.reasoning]||ui('模型默认')} → ${effortNames[b.reasoning]||ui('模型默认')}`));
    if(a.selection.modelId!==b.selection.modelId||a.selection.connectionId!==b.selection.connectionId)section.append(node('p',ui('这里比较的是整套方案的变化，不能把全部提升归因于提示词。'),'evaluation-muted'));
    for(const name of Object.keys(av.templates)){const detail=node('details','');detail.append(node('summary',(name==='system'?ui('判断规则'):ui('输入模板'))+' · '+ui('{0} → {1} 字符',av.templates[name].length,bv.templates[name].length)));const grid=node('div','','evaluation-plan-grid');for(const [title,text] of [[ui('当前方案'),av.templates[name]],[ui('候选方案'),bv.templates[name]]]){const panel=node('div','');panel.append(node('strong',title),node('pre',text,'evaluation-prompt-text'));grid.append(panel);}detail.append(grid);section.append(detail);}
    for(const [field,diff] of Object.entries(run.prompt_changes||{})){if(!diff)continue;const detail=node('details','');detail.append(node('summary',ui('逐行修改对照')+' · '+field));const pre=node('pre','','evaluation-prompt-text');for(const line of diff.split('\n'))pre.append(node('span',line+'\n',line.startsWith('+')?'evaluation-diff-add':line.startsWith('-')?'evaluation-diff-remove':''));detail.append(pre);section.append(detail);}
    if(run.report?.comparison){const improved=new Set(run.report.comparison.filter(i=>i.change==='improved').map(i=>i.case_id)),regressed=new Set(run.report.comparison.filter(i=>i.change==='regressed').map(i=>i.case_id));section.append(node('p',ui('至少一次变好的样例 {0} 条；至少一次变差的样例 {1} 条。可在下方查看每次判断。',improved.size,regressed.size)));}
    if(run.publication&&!run.publication.rolled_back_at)section.append(node('p',ui('此候选方案已启用。')),button(ui('回退整套方案'),async()=>{await api(`runs/${run.id}/rollback`,{confirm:true});await openRun(run.id,false);await loadModels();tell(ui('已回退提示词、触发模型和思考强度。'));}));
    else if(run.publication?.rolled_back_at)section.append(node('p',ui('已回退此方案。如需再次启用，请重新比较。')));
    else if(run.status==='succeeded'&&!run.imported&&run.current_plan)section.append(node('p',ui('启用会一起切换这项能力的提示词、触发模型和思考强度。改进模型仅用于本次任务。'),'evaluation-muted'),button(ui('启用候选方案'),async()=>{await api(`runs/${run.id}/apply`,{confirm:true});await openRun(run.id,false);prompts=(await api('prompts')).items;await loadModels();tell(ui('候选方案已启用。'));}));
    container.append(section);
  }
  async function continueRun(run){
    if(run.kind==='optimization'&&!run.private_content_deleted){await api(`runs/${run.id}/promote`,{confirm:true});prompts=(await api('prompts')).items;}
    el('capability').value=run.capability_id;modes();autoSelect=false;selected.clear();selectedRevisions.clear();
    for(const ref of run.suite.cases){selected.add(ref.case_id);selectedRevisions.set(ref.case_id,ref.benchmark_revision);}
    document.querySelector('input[name=evaluation-intent][value=compare]').checked=true;lastIntent='compare';el('repeat').value=String([1,3,5,10].includes(run.repeat_count)?run.repeat_count:5);
    await refreshList();await loadModels();
    const candidate=run.variants?.[1]||run.variants?.[0];
    if(candidate?.selection&&config.settings.connections.some(c=>c.id===candidate.selection.connectionId)){el('change-model').checked=true;el('connection').value=candidate.selection.connectionId;populateModels(candidate.selection.modelId);}
    el('change-reasoning').checked=true;populateReasoning(candidate?.reasoning);
    const bundle=Object.values(candidate?.snapshots||{})[0];el('change-prompt').checked=!!bundle;
    for(const select of versionControls()){const id=bundle?.versions?.[select.dataset.prompt]?.id;if([...select.options].some(o=>o.value===id))select.value=id;}
    updateChanges();invalidatePreview();showView('run',true);showStep(2);await improvementReference();await refreshSuites();
  }
  async function refreshRuns(){
    const current=capability(),all=(await api('runs')).items;if(current!==capability())return;
    const runs=all.filter(r=>r.capability_id===current&&!r.parent_id);
    el('runs').replaceChildren(...runs.map(run=>button(`${stamp(run.created_at)} · ${run.kind==='optimization'?ui('自动改进')+' · ':''}${states[run.status]||run.status} · ${ui('{0} 次重复',run.repeat_count||1)}`,()=>openRun(run.id))));
    if(!runs.length)el('runs').append(node('p',ui('还没有检查记录。从“开始检查”创建第一次检查。'),'evaluation-muted'));
    const active=all.find(r=>['queued','running'].includes(r.status));el('active-run').hidden=!active;
    if(active)el('active-run').replaceChildren(node('span',ui('有一次检查正在进行，刷新页面后仍可继续查看。')),button(ui('查看进度'),()=>openRun(active.id)));
  }
  async function download(mode) {
    const value = await api('export', {mode});
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
    const link = node('a', ''); link.href = url; link.download = `ai-persona-evaluations-${mode}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    tell(mode === 'backup' ? ui('用户备份已导出，包含反馈理由。请妥善保管。') : ui('评测数据已导出，不包含反馈理由。'));
  }


  el('capability').addEventListener('change',handle(async()=>{
    loading=true;candidateDrafts={};lastIntent=intent();selected.clear();selectedRevisions.clear();autoSelect=true;expandedReportItems.clear();currentRun=null;clearTimeout(timer);detailRequest++;casePage=0;cases=[];
    el('detail').replaceChildren(node('p',ui('选择一条样例查看详情。'),'evaluation-muted'));el('report').replaceChildren();el('root').dataset.detailOpen='false';invalidatePreview();tell('');modes();showStep(1);locationState('case',null);
    for(const key of ['prompt','model','reasoning'])el('change-'+key).checked=false;updateChanges();
    await refreshList();await Promise.all([refreshRuns(),refreshSuites()]);loading=false;updateSelection();await loadModels();
  }));
  for(const key of ['cases','run','reports'])el(key+'-tab').addEventListener('click',handle(async()=>{showView(key,true);if(key==='reports'&&currentRun)await openRun(currentRun,true,false);if(key==='reports')await refreshRuns();}));
  el('refresh').addEventListener('click',handle(async()=>{invalidatePreview();await refreshList();await Promise.all([refreshRuns(),refreshSuites()]);prompts=(await api('prompts')).items;const versions=versionControls().map(s=>[s.dataset.prompt,s.value]);modes();for(const [id,v] of versions){const s=versionControls().find(s=>s.dataset.prompt===id);if(s&&[...s.options].some(o=>o.value===v))s.value=v;}await loadModels();}));
  for(const id of ['case-status','search'])el(id).addEventListener('change',handle(async()=>{casePage=0;await refreshList();locationState();}));
  el('prev').addEventListener('click',handle(async()=>{casePage=Math.max(0,casePage-1);await refreshList();locationState();}));
  el('next').addEventListener('click',handle(async()=>{casePage++;await refreshList();locationState();}));
  el('case-back').addEventListener('click',()=>{el('root').dataset.detailOpen='false';const row=[...el('list').children].find(row=>row.dataset.caseId===el('detail').dataset.caseId);(row?.querySelector('button')||el('list').querySelector('button'))?.focus({preventScroll:true});});
  el('choose').addEventListener('click',()=>{el('root').dataset.detailOpen='false';showView('cases',true);});
  el('to-run').addEventListener('click',()=>{showView('run',true);showStep(1);});
  async function selectAll(){autoSelect=false;selected.clear();selectedRevisions.clear();for(const c of cases.filter(c=>c.status==='active'&&c.replay_capabilities?.includes(mode())).slice(0,200))selected.add(c.case_id);invalidatePreview();await refreshList();}
  for(const id of ['select-all','use-all'])el(id).addEventListener('click',handle(selectAll));
  el('backup').addEventListener('click',handle(()=>download('backup')));
  el('export').addEventListener('click',handle(()=>download('benchmark')));
  el('import').addEventListener('change',handle(async event=>{
    const file=event.target.files[0];if(!file)return;
    try{if(file.size>32000000)throw new Error(ui('备份超过 32 MB 上限。'));if(!confirm(ui('导入由明确反馈创建的样例，不覆盖已有数据。是否继续？')))return;
      const result=await api('import',JSON.parse(await file.text()));tell(ui('已导入 ')+result.imported+ui(' 条样例。'));await refreshList();await refreshSuites();
    }finally{event.target.value='';}
  }));
  for(const key of ['prompt','model','reasoning'])el('change-'+key).addEventListener('change',()=>{if(key==='model')populateReasoning();updateChanges();invalidatePreview();});
  el('connection').addEventListener('change',()=>{populateModels();invalidatePreview();});
  el('model-id').addEventListener('change',()=>{populateReasoning();invalidatePreview();});
  el('run-form').addEventListener('input',event=>{if(event.target===el('consent'))return;invalidatePreview();updateSelection();});
  for(const radio of document.querySelectorAll('input[name=evaluation-intent]'))radio.addEventListener('change',switchIntent);
  el('optimizer-connection').addEventListener('change',()=>{el('optimizer-model').value='';populateOptimizer();invalidatePreview();});
  el('optimizer-model').addEventListener('change',()=>{populateOptimizer(el('optimizer-model').value);invalidatePreview();});
  el('consent').addEventListener('change',()=>{el('start').disabled=submitting||!preview||!el('consent').checked;});
  el('next-step').addEventListener('click',handle(async()=>{if(comparing()){showStep(2);if(!baseline)await loadModels();await improvementReference();}else await previewPlan();}));
  el('back-1').addEventListener('click',()=>showStep(1));
  el('back-2').addEventListener('click',()=>showStep(comparing()?2:1));
  el('to-confirm').addEventListener('click',handle(previewPlan));el('preview').addEventListener('click',handle(previewPlan));
  el('reference').addEventListener('toggle',handle(async()=>{if(el('reference').open)await improvementReference();}));
  const hasPromptDraft=()=>el('prompt-editor').open&&editingPrompt&&([...el('prompt-fields').querySelectorAll('textarea')].some(a=>a.value!==editingPrompt.templates[a.dataset.field])||el('prompt-note').value.trim());
  const discardPrompt=()=>!hasPromptDraft()||confirm(ui('提示词修改尚未保存，放弃这次编辑？'));
  el('prompt-cancel').addEventListener('click',()=>{if(discardPrompt())el('prompt-editor').close();});
  el('prompt-editor').addEventListener('cancel',event=>{if(!discardPrompt())event.preventDefault();});
  window.addEventListener('beforeunload',event=>{if(hasPromptDraft()){event.preventDefault();event.returnValue='';}});
  el('prompt-form').addEventListener('submit',async event=>{
    event.preventDefault();el('prompt-save').disabled=true;el('prompt-error').textContent='';
    try{
      const raw={templates:Object.fromEntries([...el('prompt-fields').querySelectorAll('textarea')].map(a=>[a.dataset.field,a.value])),note:el('prompt-note').value,base_version:editingPrompt.version};
      const response=await fetch('/api/prompts/v1/prompts/'+editingPrompt.id+'/versions',{method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify(raw)});
      const value=await response.json();if(!response.ok)throw new Error(value.message||ui('保存失败，请重试。'));
      const kept=new Map(versionControls().map(s=>[s.dataset.prompt,s.value]));kept.set(editingPrompt.id,value.id);prompts=(await api('prompts')).items;modes();for(const select of versionControls())select.value=kept.get(select.dataset.prompt)||'';
      el('change-prompt').checked=true;updateChanges();invalidatePreview();el('prompt-editor').close();tell(ui('已保存并选入候选方案。当前启用的提示词未改变。'));
    }catch(e){el('prompt-error').textContent=e.message;}finally{el('prompt-save').disabled=false;}
  });
  el('run-form').addEventListener('submit',handle(async event=>{
    event.preventDefault();if(submitting)return;if(!preview||!el('consent').checked)throw new Error(ui('请先确认检查配置并同意发送必要输入。'));
    const frozen=preview,raw={...frozen.raw,expected_plan:frozen.fingerprint,request_id:requestId,confirmed_model_calls:true};submitting=true;el('start').disabled=true;
    try{const run=await api(raw.optimization?'optimizations':'runs',raw);invalidatePreview();tell(ui('检查已开始，每次结果都会单独保存。'));await refreshSuites();await refreshRuns();await openRun(run.id);}
    finally{submitting=false;el('start').disabled=!preview||!el('consent').checked;}
  }));
  window.addEventListener('pagehide',()=>{clearTimeout(timer);saveDraft();});
  async function restoreLocation(draft=null){
    const query=new URLSearchParams(location.search),cap=query.get('capability')||draft?.capability,position=history.state?.evaluation;
    if(['persona.activation','persona.conversation_learning'].includes(cap))el('capability').value=cap;
    const sameDraft=draft?.capability===capability()?draft:null;
    if(sameDraft){candidateDrafts=sameDraft.candidateDrafts||{};autoSelect=false;for(const id of sameDraft.selected||[])selected.add(id);for(const [id,v] of sameDraft.revisions||[])selectedRevisions.set(id,v);el('repeat').value=['1','3','5','10'].includes(sameDraft.repeat)?sameDraft.repeat:'5';document.querySelector('input[name=evaluation-intent][value='+(['current','compare','automatic'].includes(sameDraft.intent)?sameDraft.intent:sameDraft.compare?'compare':'current')+']').checked=true;for(const key of ['prompt','model','reasoning'])el('change-'+key).checked=sameDraft.changes?.includes(key)||false;for(const [id,v] of sameDraft.budget||[])if(['max-calls','max-tokens','timeout'].includes(id))el(id).value=v;}
    el('case-status').value=['active','withdrawn','unavailable','all'].includes(query.get('status'))?query.get('status'):'active';el('search').value=query.get('q')||'';casePage=Math.max(0,Math.min(100000,Number(query.get('page'))||0));
    detailRequest++;reportRequest++;currentRun=null;clearTimeout(timer);modes();invalidatePreview();showView(query.get('view'));showStep(1);const restoreRevision=detailRequest;
    await refreshList();await Promise.all([refreshRuns(),refreshSuites()]);
    if(restoreRevision!==detailRequest){loading=false;return;}
    try{await loadModels();if(sameDraft){if(sameDraft.optimizer){const o=sameDraft.optimizer;if([...el('optimizer-connection').options].some(v=>v.value===o.connection))el('optimizer-connection').value=o.connection;populateOptimizer(o.model,o.reasoning);if(['1','3','5','10'].includes(o.rounds))el('max-rounds').value=o.rounds;}if([...el('connection').options].some(o=>o.value===sameDraft.connection))el('connection').value=sameDraft.connection;populateModels(sameDraft.model);populateReasoning(sameDraft.reasoning);for(const [id,v] of sameDraft.versions||[]){const s=versionControls().find(s=>s.dataset.prompt===id);if(s&&[...s.options].some(o=>o.value===v))s.value=v;}}}catch(e){tell(e.message,true);}
    lastIntent=intent();updateChanges();loading=false;updateSelection();
    if(restoreRevision!==detailRequest)return;
    if(query.get('case'))await openCase(query.get('case'),false);
    else if(query.get('run'))await openRun(query.get('run'),true,false);
    else if(query.get('result'))await openResult(query.get('result'),false);
    else{el('root').dataset.detailOpen='false';if(query.get('view')==='reference'){document.querySelector('input[name=evaluation-intent][value=compare]').checked=true;showStep(2);el('reference').open=true;await improvementReference();}}
    if(position){el('list').scrollTop=position.listScroll||0;el('detail').scrollTop=position.detailScroll||0;}
  }
  window.addEventListener('popstate',handle(()=>restoreLocation()));
  handle(async()=>{[capabilities,prompts]=await Promise.all([api('capabilities').then(v=>v.capabilities),api('prompts').then(v=>v.items)]);let draft;try{draft=JSON.parse(sessionStorage.getItem('persona-evaluation-draft-v2'));}catch{}await restoreLocation(draft);})();
})();
