import {ui} from './studio-i18n.mjs?v=20260908.studio3.1';
/* Shared settings controls, without a second task/feedback workspace. */
export class SettingsWorkspace {
  constructor() {
    this.savedForms = new Map();
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    const show = () => {
      const value = new URLSearchParams(location.search).get('tab');
      const tab = ['sources','capabilities','retention'].includes(value) ? value : 'sources';
      const descriptions = {
        sources: [ui('应用接入'), ui('连接你的应用，选择 Persona 可以接收的信息范围。')],
        capabilities: [ui('自动功能'), ui('决定 Persona 如何从对话中学习，以及何时应用已有偏好。')],
        retention: [ui('数据管理'), ui('管理临时内容的保留时间，了解其他数据的保存方式。')],
      };
      document.getElementById('settings-page-title').textContent = descriptions[tab][0];
      document.getElementById('settings-page-description').textContent = descriptions[tab][1];
      for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== tab;
      for (const link of tabs) link.setAttribute('aria-current', link.dataset.settingsTab === tab ? 'page' : 'false');
    };
    for (const link of tabs) link.addEventListener('click', event => {event.preventDefault(); history.pushState({},'',link.href); show();});
    window.addEventListener('popstate', show); show();
    document.querySelectorAll('[data-settings-revert]').forEach(button => button.addEventListener('click', () => {
      const form = document.getElementById(button.dataset.settingsRevert);
      const saved = this.savedForms.get(form);
      if (!saved) return;
      for (const [name, value] of JSON.parse(saved)) {
        const field = form.elements.namedItem(name);
        if (field.type === 'checkbox') field.checked = value; else field.value = value;
      }
      form.dispatchEvent(new Event('settings-restored'));
      this.markSaved(form);
    }));
    window.addEventListener('beforeunload', event => {if ([...this.savedForms.keys()].some(f=>this.isDirty(f))) {event.preventDefault();event.returnValue='';}});
  }
  formValue(form) {return JSON.stringify([...form.elements].filter(f=>f.name&&(f.type!=='radio'||f.checked)).map(f=>[f.name,f.type==='checkbox'?f.checked:f.value]));}
  markSaved(form) {
    this.savedForms.set(form,this.formValue(form));
    let status = form.querySelector('[data-save-status]');
    if (!status) {
      status=document.createElement('span');status.dataset.saveStatus='';status.setAttribute('role','status');
      const actions=form.querySelector('.settings-actions');if(actions)actions.prepend(status);else form.append(status);
      for (const event of ['input','change']) form.addEventListener(event,()=>{status.textContent=this.isDirty(form)?ui('有未保存的修改'):ui('已保存');});
    }
    status.textContent=form.id==='learning-connection'&&!form.elements.id.value?ui('新来源，尚未保存'):ui('已保存');
  }
  isDirty(form) {return this.savedForms.has(form)&&this.savedForms.get(form)!==this.formValue(form);}
  async refresh() {}
}
