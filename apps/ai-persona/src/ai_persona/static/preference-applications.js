/* Saved context is data: render all user text through textContent. */
(() => {
  const ui=window.StudioI18n?.ui||((text,...args)=>text.replace(/\{(\d+)\}/g,(_m,i)=>String(args[Number(i)]??'')));
  const root = document.getElementById('preference-applications');
  if (!root) return;
  const $ = id => document.getElementById(id), base = '/api/preferences/application';
  const node = (tag, text = '', cls = '') => {const n = document.createElement(tag); n.textContent = text; n.className = cls; return n;};
  let settings;
  let savedForm = '', configReady = false;
  const formState = () => JSON.stringify([$('pa-enabled').checked,$('pa-timeout').value,[...$('pa-connections').querySelectorAll('input:checked')].map(n=>n.value)]);
  $('pa-settings-form').addEventListener('input',()=>{$('pa-settings-message').textContent=formState()===savedForm?ui('已保存'):ui('有未保存的修改');});
  window.addEventListener('beforeunload',event=>{if(configReady&&formState()!==savedForm){event.preventDefault();event.returnValue='';}});
  async function api(path, body) {
    const response = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', 'X-AI-Persona': '1'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || value.message || ui('操作未完成，请重试。'));
    return value;
  }

  async function configuration() {
    const value = await api('/config'); settings = value.settings;
    $('pa-enabled').checked = settings.enabled; $('pa-timeout').value = settings.timeout_seconds;
    $('pa-setting-status').textContent = settings.enabled ? ui('已开启') : ui('已关闭');
    const list = $('pa-connections'); list.replaceChildren();
    for (const c of value.connections) {
      const row = node('div', '', 'pa-connection'), label = node('label', '', 'pa-check'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = c.id; input.name = 'connection'; input.checked = settings.connection_ids.includes(c.id);
      label.append(input, node('span', c.name)); row.append(label, node('small', c.scope_mode === 'all' ? ui('范围：该来源对应主机上的所有 Codex 会话') : ui('范围：{0}',c.projects.map(p => p.split('/').filter(Boolean).at(-1)).join('、') || ui('尚未指定项目'))));
      list.append(row);
    }
    if (!value.connections.length) {list.append(node('p', ui('还没有 Codex 来源。'), 'pa-muted')); const a = node('a', ui('管理应用接入')); a.href = '/settings?tab=sources'; list.append(a);}
    savedForm=formState();configReady=true;
  }
  $('pa-revert').addEventListener('click',()=>{
    if(!configReady)return;
    const [enabled,timeout,ids]=JSON.parse(savedForm);
    $('pa-enabled').checked=enabled;$('pa-timeout').value=timeout;
    for(const input of $('pa-connections').querySelectorAll('input'))input.checked=ids.includes(input.value);
    $('pa-settings-message').textContent=ui('已撤销未保存的修改。');
  });
  let saving=false;
  $('pa-settings-form').addEventListener('submit', async e => {
    e.preventDefault();if(saving)return;saving=true;$('pa-settings-message').dataset.error='false';
    const controls=[...e.target.elements],disabled=controls.map(c=>c.disabled);for(const c of controls)c.disabled=true;
    try {
      if(!configReady)throw new Error(ui('尚未读取设置，请刷新后重试。'));
      const next = {...settings, enabled: $('pa-enabled').checked, timeout_seconds: Number($('pa-timeout').value), connection_ids: [...$('pa-connections').querySelectorAll('input:checked')].map(n => n.value)};
      if (next.enabled && !next.connection_ids.length) throw new Error(ui('请先选择一个应用来源。'));
      settings = (await api('/config', next)).settings;
      $('pa-setting-status').textContent = settings.enabled ? ui('已开启') : ui('已关闭');
      $('pa-settings-message').textContent = ui('设置已保存，后续请求使用新设置。');
      savedForm=formState();
    } catch (error) {$('pa-settings-message').dataset.error='true';$('pa-settings-message').textContent = error.message;}
    finally {controls.forEach((c,i)=>{c.disabled=disabled[i];});saving=false;}
  });
  window.addEventListener('persona-source-changed',()=>{if(configReady&&formState()!==savedForm){$('pa-settings-message').textContent=ui('来源已更新；当前未保存的设置保留，保存后请刷新可选来源。');return;}configuration().catch(e=>{$('pa-message').dataset.error='true';$('pa-message').textContent=e.message;});});
  configuration().catch(e=>{$('pa-message').dataset.error='true';$('pa-message').textContent=e.message;});
})();
