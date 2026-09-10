(() => {
  const ui=window.StudioI18n?.ui||((text,...args)=>text.replace(/\{(\d+)\}/g,(_m,i)=>String(args[Number(i)]??'')));
  const $=id=>document.getElementById(id), form=$('activation-form');
  const node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  let dirty=false,pending=false;
  $('activation-input').addEventListener('input',()=>{dirty=true;});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(pending)return;pending=true;$('activation-status').dataset.error='false';const b=form.querySelector('[type=submit]');b.disabled=true;$('activation-status').textContent=ui('正在判定…');
    try {
      const response=await fetch('/api/ai/activation',{method:'POST',headers:{'Content-Type':'application/json','X-AI-Persona':'1'},body:JSON.stringify({user_prompt:$('activation-input').value})});
      const value=await response.json();if(!response.ok)throw new Error(value.error?.message||ui('判定失败，请检查模型设置。'));
      $('activation-result').replaceChildren();dirty=false;
      $('activation-status').textContent=ui('本轮已判断 ')+value.evaluated_context_count+ui(' 个场景。未给反馈，不会自动收录测试样例。');
      if(value.result_id){const a=node('a',ui('查看判断并反馈'));a.className='button';a.href='/inbox?'+new URLSearchParams({view:'all',type:'activation',item:'result:'+value.result_id,return_to:location.pathname+location.search});$('activation-result').append(a);}
      else $('activation-result').append(node('p',ui('没有有效场景可判断；不会生成全局不触发标签。')));
    }catch(error){$('activation-status').dataset.error='true';$('activation-status').textContent=error.message;}finally{pending=false;b.disabled=false;}
  });
})();
