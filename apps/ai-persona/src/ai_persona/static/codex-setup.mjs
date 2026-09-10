import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
const $=id=>document.getElementById(id);
const lines=text=>text.split('\n').map(v=>v.trim()).filter(Boolean);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
const button=(text,action)=>{const el=node('button',ui(text),'button ghost');el.type='button';el.onclick=action;return el;};
export class CodexSetup {
  constructor({api,workspace,onSaved}) {
    this.api=api;this.workspace=workspace;this.onSaved=onSaved;this.form=$('learning-connection');this.f=this.form.elements;
    this.step=1;this.editing=null;this.setup=null;this.busy=false;this.epoch=0;this.initialized=false;this.signature=null;
    $('learning-source-new').onclick=()=>this.run(()=>this.open());
    for(const id of ['setup-close','setup-done'])$(id).onclick=()=>this.close();
    document.querySelectorAll('[data-setup-step],[data-setup-go]').forEach(el=>el.onclick=()=>this.go(Number(el.dataset.setupStep||el.dataset.setupGo)));
    $('setup-form-back').onclick=()=>this.go(1);
    this.form.onsubmit=e=>{e.preventDefault();if(this.step===1){if(this.validateScope())this.go(2);}else this.run(()=>this.save());};
    this.f.scope_mode.onchange=()=>this.updateFields();this.f.roots.addEventListener('input',()=>this.updateFields());
    this.form.querySelectorAll('[name=context_mode]').forEach(el=>el.onchange=()=>this.updateFields());
    this.form.addEventListener('settings-restored',()=>this.updateFields());
    $('setup-use-detected').onclick=()=>{this.f.roots.value=this.environment.sessions.path;this.f.roots.dispatchEvent(new Event('input',{bubbles:true}));};
    $('setup-detect').onclick=()=>this.run(async()=>{this.environment=await this.api('codex/environment?home='+encodeURIComponent(this.f.codex_home.value.trim()));this.showEnvironment();});
    $('setup-install').onclick=()=>this.run(async()=>{
      const result=await this.api(this.route('install'),{revision:this.setup.installation.revision});
      $('setup-install-result').textContent=result.changed?ui('配置已安装。请在 Codex 中审查并信任。')+(result.backup?' '+ui('原文件备份：')+result.backup:''):ui('配置已是最新，无需重复安装。');
      $('setup-install-result').hidden=false;await this.refreshStatus();
    });
    $('setup-check-install').onclick=()=>this.run(()=>this.refreshStatus());
    $('setup-start-probe').onclick=()=>this.run(async()=>{this.setup.probe=(await this.api(this.route('probe'),{})).probe;this.showProbe();});
    $('setup-check-probe').onclick=()=>this.run(()=>this.refreshStatus());
    $('setup-copy-hook').onclick=()=>this.copy($('learning-hook-json').textContent,$('setup-copy-hook'));
    $('setup-copy-probe').onclick=()=>this.copy($('setup-test-text').value,$('setup-copy-probe'));
    setInterval(()=>{if(!this.busy&&!this.polling&&!document.hidden&&!$('codex-setup').hidden&&this.step===4&&this.setup?.probe?.status==='waiting'){
      this.polling=true;this.refreshStatus().catch(e=>this.notice(e.message,true)).finally(()=>{this.polling=false;});
    }},2000);
  }
  route(action=''){return 'connections/'+encodeURIComponent(this.editing.id)+'/setup'+(action?'/'+action:'');}
  notice(text,error=false){const el=$('setup-notice');el.dataset.error=String(error);el.textContent=text;el.hidden=!text;el.className=error?'settings-inline-warning':'settings-note';}
  async run(action){if(this.busy)return;this.busy=true;this.notice('');const controls=[...$('codex-setup').querySelectorAll('input,textarea,select,button')];const disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
    try{await action();}catch(e){this.notice(e.message,true);}finally{this.busy=false;controls.forEach((c,i)=>{if(c.isConnected)c.disabled=disabled[i];});this.updateFields();this.updateNavigation();}}
  async copy(text,control){try{await navigator.clipboard.writeText(text);control.textContent=ui('已复制');setTimeout(()=>{control.textContent=ui(control.id==='setup-copy-hook'?'复制配置片段':'复制测试消息');},1800);}catch{this.notice(ui('无法自动复制，请选中上方内容手动复制。'),true);}}
  async open(connection=null,step=1){
    if(this.workspace.isDirty(this.form)&&!confirm(ui('放弃尚未保存的来源设置？')))return;
    const epoch=++this.epoch;this.editing=connection;this.setup=null;this.stale=false;this.step=1;$('codex-setup').hidden=false;this.notice(ui('正在读取接入配置…'));
    const setup=connection?await this.api('connections/'+encodeURIComponent(connection.id)+'/setup'):null;
    const env=setup?.environment||await this.api('codex/environment');if(epoch!==this.epoch)return;
    this.setup=setup;this.editing=setup?.connection||connection;this.environment=env;this.fill(this.editing);this.showEnvironment();this.workspace.markSaved(this.form);
    $('setup-heading').textContent=ui(connection?'管理 Codex 接入':'连接你的 Codex');$('setup-install-result').hidden=true;
    this.notice('');this.go(step);if(setup)this.showStatus();
    const url=new URL(location.href);if(connection)url.searchParams.set('setup',connection.id);else url.searchParams.delete('setup');history.replaceState({},'',url);
    $('codex-setup').scrollIntoView({block:'start',behavior:'smooth'});
  }
  fill(c){
    this.f.id.value=c?.id||'';this.f.name.value=c?.name||ui('我的 Codex');this.f.adapter.value='codex';
    this.f.enabled.checked=c?c.enabled:true;this.f.trust_user_messages.checked=!!c?.trust_user_messages;
    this.f.scope_mode.value=c?.scope_mode||'restricted';this.f.projects.value=Object.keys(c?.adapter_config?.project_scopes||{}).join('\n');
    this.f.conversations.value=(c?.allowed_conversations||[]).join('\n');
    const roots=c?.adapter_config?.transcript_roots||[];
    this.f.context_mode.value=c?(roots.length?'history':'prompt'):'history';
    this.f.roots.value=c?roots.join('\n'):(this.environment.sessions.readable?this.environment.sessions.path:'');
    this.f.codex_home.value=this.environment.codex_home;this.updateFields();
  }
  close(){if(this.busy)return;if(this.workspace.isDirty(this.form)&&!confirm(ui('放弃尚未保存的来源设置？')))return;
    this.epoch++;$('codex-setup').hidden=true;this.workspace.markSaved(this.form);const url=new URL(location.href);url.searchParams.delete('setup');history.replaceState({},'',url);}
  updateFields(){const all=this.f.scope_mode.value==='all';$('setup-projects').hidden=all;this.f.projects.disabled=all;this.f.conversations.disabled=all;$('learning-global-warning').hidden=!all;
    const readHistory=this.f.context_mode.value==='history';$('setup-context-options').hidden=!readHistory;this.f.roots.disabled=!readHistory;this.f.roots.readOnly=!!this.environment?.remote;this.f.codex_home.readOnly=!!this.environment?.remote;this.form.querySelectorAll('[name=context_mode]').forEach(el=>el.disabled=this.busy||!!this.environment?.remote);$('setup-allowed-roots').textContent=ui('保存后允许读取：')+(this.f.roots.value.trim()||ui('尚未选择目录'));}
  showEnvironment(){const found=this.environment.sessions;$('setup-detected').textContent=this.environment.remote?ui('远端会话目录由接入客户端管理：')+found.path:(found.readable?ui('检测到可读取目录：'):ui('默认目录尚不可读取：'))+found.path;
    $('setup-use-detected').disabled=!found.readable;}
  validateScope(){if(!this.f.name.value.trim()){this.notice(ui('请填写连接名称。'),true);this.f.name.focus();return false;}
    if(this.f.scope_mode.value!=='all'&&!lines(this.f.projects.value).length){this.notice(ui('请添加项目路径，或选择此来源的所有 Codex 会话。'),true);this.f.projects.focus();return false;}return true;}
  go(step){if(step>2&&(!this.editing||!this.setup)){this.notice(ui('请先完成前两步并保存接入设置。'),true);return;}
    if(step>2&&this.workspace.isDirty(this.form)){this.notice(ui('请先保存当前修改，再继续安装或验证。'),true);return;}
    if(step===5&&!this.verified())return;
    this.step=step;this.notice('');document.querySelectorAll('[data-setup-panel]').forEach(el=>el.hidden=Number(el.dataset.setupPanel)!==step);
    this.form.hidden=step>2;this.updateNavigation();if(this.setup)this.showStatus();
  }
  updateNavigation(){document.querySelectorAll('[data-setup-step]').forEach(el=>{const step=Number(el.dataset.setupStep);el.setAttribute('aria-current',step===this.step?'step':'false');el.disabled=this.busy||(step>2&&(!this.editing||!this.setup))||(step===5&&!this.verified());});
    $('setup-form-back').hidden=this.step===1;$('setup-form-next').textContent=ui(this.step===1?'下一步：会话前文':'保存并继续');
    $('setup-finish-probe').disabled=this.busy||!this.verified();$('setup-start-probe').disabled=this.busy||this.stale;
    if(this.setup){$('setup-install').disabled=this.busy||this.stale||!this.setup.installation.can_install||this.setup.installation.installed;}
    if(this.environment){$('setup-use-detected').disabled=this.busy||!this.environment.sessions.readable;$('setup-detect').disabled=this.busy||!!this.environment.remote;}
  }
  async save(){if(!this.validateScope()){this.go(1);return;}const readHistory=this.f.context_mode.value==='history';
    if(readHistory&&!lines(this.f.roots.value).length){this.notice(ui('请选择会话目录，或选择仅使用本次输入。'),true);return;}
    const projectScopes={};for(const path of lines(this.f.projects.value))projectScopes[path]=this.editing?.adapter_config?.project_scopes?.[path]||'scope_'+crypto.randomUUID();
    const value={...this.editing,id:this.editing?.id||'conn_'+crypto.randomUUID(),name:this.f.name.value.trim(),adapter:'codex',enabled:this.f.enabled.checked,
      scope_mode:this.f.scope_mode.value,trust_user_messages:this.f.trust_user_messages.checked,allowed_scopes:Object.values(projectScopes),allowed_conversations:lines(this.f.conversations.value),
      adapter_config:{...this.editing?.adapter_config,project_scopes:projectScopes,transcript_roots:readHistory?lines(this.f.roots.value):[],codex_home:this.f.codex_home.value.trim()},
      capabilities:this.editing?.capabilities||{stable_event_identity:false,message_revisions:false,verified_human_origin:false,context_snapshot:true}};
    const saved=await this.api('codex/connections',{connection:value,expected_revision:this.setup?.connection_revision||''});
    this.editing=saved.connection;this.setup=saved.setup;this.environment=saved.setup.environment;this.fill(this.editing);this.workspace.markSaved(this.form);this.go(3);
    const url=new URL(location.href);url.searchParams.set('setup',this.editing.id);history.replaceState({},'',url);
    window.dispatchEvent(new Event('persona-source-changed'));await this.onSaved();
  }
  async refreshStatus(){if(!this.editing)return;const epoch=this.epoch;const setup=await this.api(this.route());if(epoch!==this.epoch)return;if(this.setup&&setup.connection_revision!==this.setup.connection_revision){this.stale=true;setup.connection_revision=this.setup.connection_revision;setup.probe={status:'stale'};this.notice(ui('接入设置已变化，请重新打开引导后继续。'),true);}this.setup=setup;this.showStatus();}
  showStatus(){const install=this.setup.installation;$('setup-hook-path').textContent=install.path;
    $('setup-install-state').textContent=ui(install.status==='remote'?'配置位于远端，接收情况可在下一步验证':install.installed?'配置已安装，实际接收仍需验证':install.status==='update'?'检测到旧配置，安装时更新本连接':install.can_install?'尚未安装本连接的配置':'需要手动处理');
    const warnings=[install.error,install.inline_hooks?ui('检测到 config.toml 中也有 Hook。请检查是否已包含此连接，避免重复安装。'):null,
      install.hooks_disabled?ui('Codex 配置中关闭了 Hook。请先在 Codex 中启用，再进行接入验证。'):null].filter(Boolean);
    $('setup-install-warning').textContent=warnings.join(' ');$('setup-install-warning').hidden=!warnings.length;
    $('learning-hook-json').textContent=JSON.stringify(install.snippet,null,2);
    $('setup-test-scope').textContent=ui('测试消息应发送到：')+(this.editing.scope_mode==='all'?(this.environment.remote?this.environment.hostname+ui(' 上的 Codex 会话'):ui('此配置下的任一本机 Codex 会话')):Object.keys(this.editing.adapter_config.project_scopes||{}).join('、'));
    this.showProbe();this.updateNavigation();this.updateCard(this.editing.id,this.setup);
  }
  verified(){const p=this.setup?.probe;return !this.stale&&p?.status==='received'&&p.scope_ok&&['readable','disabled'].includes(p.context_status);}
  showProbe(){const p=this.setup?.probe;const box=$('setup-probe-result');box.replaceChildren();$('setup-probe-message').hidden=p?.status!=='waiting';$('setup-start-probe').textContent=ui(p?'重新生成测试消息':'生成测试消息');
    if(!p){box.append(node('p',ui('尚未开始验证。')));}
    else if(p.status==='waiting'){$('setup-test-text').value=p.message;box.append(node('p',ui('等待 Codex 测试消息… 此页面会自动检查。')));}
    else if(p.status==='expired'||p.status==='stale'){box.append(node('p',ui(p.status==='expired'?'测试消息已过期，请重新生成。':'接入设置已修改，请重新验证。')));}
    else {
      const row=(ok,text)=>box.append(node('p',(ok?'✓ ':'! ')+text,ok?'setup-check-ok':'setup-check-warning'));
      row(true,ui('已收到 Codex 测试消息'));
      row(p.scope_ok,ui(p.scope_ok?'接收范围匹配':'当前项目或会话不在接收范围内，请调整范围后重新验证。'));
      if(p.scope_ok){const messages={disabled:'已选择仅使用本次输入，不读取前文。',readable:p.context_messages?'前文读取成功':'会话文件可读取，当前暂无可用前文。',context_unavailable:'未取得会话文件，请确认 Codex 提供会话路径，并检查读取目录。',context_path_rejected:'会话文件不在允许目录内，或路径包含不支持的链接。',context_session_mismatch:'会话文件与当前会话不匹配。',context_format_unsupported:'会话文件不可读取或格式暂不兼容。',context_changed:'读取时会话文件发生变化，请重新测试。'};
        row(['readable','disabled'].includes(p.context_status),ui(messages[p.context_status]||'前文读取未通过，请检查目录设置。')+(p.context_messages?' · '+p.context_messages+ui(' 条前文'):''));}
      box.append(node('small',ui('验证时间：')+new Date(p.received_at*1000).toLocaleString()));
    }
    $('setup-complete-summary').textContent=this.editing?.enabled?ui(p?.context_status==='disabled'?'接收范围已验证，当前仅使用本次输入。':'接收范围与前文读取已验证。接下来配置模型和自动功能。'):ui('接入已验证，但此连接的接收开关仍关闭。请先返回接收范围步骤开启并保存。');
    this.updateNavigation();
  }
  updateCard(id,setup){const card=[...document.querySelectorAll('[data-setup-connection]')].find(el=>el.dataset.setupConnection===id);if(!card)return;const p=setup.probe;
    const verified=p?.status==='received'&&p.scope_ok&&['readable','disabled'].includes(p.context_status);
    card.textContent=verified?ui('接入已验证')+' · '+new Date(p.received_at*1000).toLocaleString():ui(p?.status==='stale'?'配置已变化，请重新验证':'尚未完成接入验证');
  }
  render(config){
    const signature=JSON.stringify(config.connections);if(signature===this.signature)return;this.signature=signature;
    const list=$('learning-connections');list.replaceChildren();const codex=config.connections.filter(c=>c.adapter==='codex');
    for(const c of codex){const card=node('article',null,'settings-source-card');const head=node('div',null,'settings-section-head');head.append(node('h3',c.name),node('span',ui(c.enabled?'接收已启用':'接收已暂停'),'settings-state'));card.append(head);
      const dl=node('dl');for(const [label,value] of [['接收范围',c.scope_mode==='all'?(c.adapter_config.remote_host?c.adapter_config.remote_host+ui(' 上的 Codex 会话'):ui('所有本机 Codex 会话')):Object.keys(c.adapter_config.project_scopes||{}).join('、')||ui('尚未指定项目')],['会话前文',ui(c.adapter_config.transcript_roots?.length?'允许读取当前会话前文':'仅使用本次输入')],['输入确认',ui(c.trust_user_messages?'信任此连接的用户消息':'逐条确认未验证的输入')]])dl.append(node('dt',ui(label)),node('dd',value));card.append(dl);const verification=node('p',ui('正在检查接入状态…'),'settings-note');verification.dataset.setupConnection=c.id;card.append(verification);
      const actions=node('div',null,'setup-inline-actions');actions.append(button('编辑接入设置',()=>this.run(()=>this.open(c,1))),button('安装与验证',()=>this.run(()=>this.open(c,3))));card.append(actions);list.append(card);this.api('connections/'+encodeURIComponent(c.id)+'/setup').then(setup=>this.updateCard(c.id,setup)).catch(()=>{if(verification.isConnected)verification.textContent=ui('暂时无法检查接入，请点击安装与验证。');});
    }
    if(!codex.length)list.append(node('p',ui('用下面的引导完成首次接入。保存连接后，还需安装并验证。'),'settings-note'));
    if(config.connections.some(c=>c.adapter!=='codex'))list.append(node('p',ui('已有其他类型的旧连接保留，当前页面仅支持配置 Codex。'),'settings-note'));
    if(!this.initialized){this.initialized=true;const id=new URL(location.href).searchParams.get('setup');const selected=codex.find(c=>c.id===id);
      if(selected)this.run(()=>this.open(selected,3));else if(!codex.length)this.run(()=>this.open());}
  }
}
