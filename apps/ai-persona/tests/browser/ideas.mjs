/** Real Studio Ideas workflows, in a fresh temporary workspace. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
const dir=dirname(fileURLToPath(import.meta.url)),app=resolve(dir,'../..'),root=resolve(app,'../..');
const scratch=await mkdtemp(join(tmpdir(),'persona-ideas-'));
const output=join(root,'.qa/ideas-production');await mkdir(output,{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AI_PERSONA_')));
Object.assign(env,{AI_PERSONA_CONFIG:join(scratch,'config.toml'),AI_PERSONA_LEARNING_DIR:join(scratch,'learning'),AI_PERSONA_MODEL_DATA_DIR:join(scratch,'models'),AI_PERSONA_DEMO_HOME:join(scratch,'demo'),PYTHONPATH:join(app,'src'),PYTHONUNBUFFERED:'1'});
const child=spawn(join(app,'.venv/bin/python'),[join(dir,'serve.py'),'demo'],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let log='',browser;const errors=[];child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
try {
  let base;for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(log);base=log.match(/READY (http:\/\/127.0.0.1:\d+)/)?.[1];if(base){try{if((await fetch(base+'/healthz')).ok)break;}catch{}}await new Promise(r=>setTimeout(r,100));}
  assert(base,log);browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){errors.push('Unexpected external request');return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const revision=()=>page.locator('[name=record_revision]').inputValue();
  async function save(){await page.locator('#idea-save').click();await expect(page.locator('#idea-save-message')).toContainText(/已保存|没有内容变化/);}
  await page.goto(base+'/ideas');await expect(page.locator('.idea-row')).toHaveCount(5);
  assert.equal(await page.locator('.main-nav a[href="/ideas"]').getAttribute('class'),'active');
  await page.screenshot({path:join(output,'list-desktop.png'),fullPage:true});
  await page.locator('a[href="/ideas/new"]').first().click();
  await page.locator('[name=title]').fill('浏览器验证：让每次判断有据可查');
  await save();assert.equal(await revision(),'1');const url=page.url(),id=url.split('/').pop();
  await page.locator('[name=novelty_reason]').fill('尚未判断，但已经发现了一个值得核对的区别。');
  await page.locator('[name=difficulty_reason]').fill('已有基线；需要补充不同条件下的比较。');
  await page.locator('[name=body]').fill('# 一个新的研究问题\n\n**假设**需要验证。\n\n- 保留原始观察\n- 记录实验条件\n\n> 先判断，再解释。\n\n```python\nprint("note")\n```\n\n<script>window.unwanted=true</script>\n\n![external](https://example.invalid/image.png)');
  await page.locator('#idea-preview').click();await expect(page.locator('#idea-rendered h1')).toHaveText('一个新的研究问题');assert.equal(await page.evaluate(()=>window.unwanted),undefined);
  await page.locator('#idea-write').click();await save();assert.equal(await revision(),'2');
  await save();assert.equal(await revision(),'2');
  // Cancel preserves the saved record, and the unfinished ending is a persistent draft.
  await page.locator('[name=execution_status]').selectOption('ended');
  await page.locator('#idea-confirm-ending').click();await expect(page.locator('#idea-closure-error')).toContainText('请选择');
  await page.locator('[name=ending_outcome][value=partial]').check();await page.locator('[name=ending_summary]').fill('完成了基线；扩展验证仍未通过。');
  await page.locator('[data-close=idea-closure-dialog]').last().click();assert.equal(await revision(),'2');
  await expect(page.locator('.editor-draft-bar')).toContainText('草稿已保存');
  await page.reload();await page.getByRole('button',{name:'恢复草稿',exact:true}).click();
  await page.locator('[name=execution_status]').selectOption('ended');
  await expect(page.locator('[name=ending_summary]')).toHaveValue('完成了基线；扩展验证仍未通过。');
  await page.screenshot({path:join(output,'ending-desktop.png'),fullPage:true});
  await page.locator('#idea-confirm-ending').click();await expect(page.locator('#idea-ending-title')).toContainText('部分完成');assert.equal(await revision(),'3');
  await page.locator('#idea-edit-ending').click();await page.locator('[name=ending_summary]').fill('取消后也要保留的结束说明草稿');await page.locator('[data-close=idea-closure-dialog]').last().click();await save();assert.equal(await revision(),'3');await page.reload();await page.getByRole('button',{name:'恢复草稿',exact:true}).click();await page.locator('#idea-edit-ending').click();await expect(page.locator('[name=ending_summary]')).toHaveValue('取消后也要保留的结束说明草稿');await page.locator('[data-close=idea-closure-dialog]').last().click();
  await page.locator('#idea-reopen').click();await save();await expect(page.locator('#idea-ending-panel')).toBeHidden();
  await page.locator('[name=execution_status]').selectOption('ended');await expect(page.locator('[name=ending_summary]')).toHaveValue('');await expect(page.locator('[name=ending_outcome]:checked')).toHaveCount(0);
  await page.locator('[name=ending_outcome][value=abandoned]').check();await page.locator('[name=ending_summary]').fill('成本过高，暂不继续这一方向。');await page.locator('#idea-confirm-ending').click();await expect(page.locator('#idea-ending-title')).toContainText('放弃');
  await page.locator('#idea-edit-ending').click();await page.locator('[name=ending_summary]').fill('投入超过当前预算，保留现有结果。');await page.locator('#idea-confirm-ending').click();await expect(page.locator('#idea-ending-summary')).toHaveText('投入超过当前预算，保留现有结果。');
  await page.locator('#idea-reopen').click();await save();
  await page.locator('[name=execution_status]').selectOption('ended');await page.locator('[name=ending_outcome][value=success]').check();await page.locator('[name=ending_summary]').fill('完成了验证，并明确了原假设不成立的条件。');await page.locator('#idea-confirm-ending').click();await expect(page.locator('#idea-ending-title')).toContainText('成功完成');
  // Files are safely downloaded, reference order and notes survive saves and history.
  await page.locator('.idea-add-resource summary').click();
  await page.locator('[name=link_url]').fill('https://example.org/research');await page.locator('[name=link_title]').fill('研究资料');await page.locator('#idea-add-link').click();
  await page.locator('#idea-file').setInputFiles({name:'experiment.txt',mimeType:'text/plain',buffer:Buffer.from('private experiment bytes')});await expect(page.locator('#idea-resource-message')).toContainText('文件已上传');
  await page.locator('.idea-resource').last().getByLabel('资源备注',{exact:true}).fill('保留原始实验记录');await page.locator('.idea-resource').last().getByRole('button',{name:'上移资源'}).click();
  await save();const resourceRevision=await revision();
  await page.reload();await expect(page.locator('.idea-resource').first()).toContainText('experiment.txt');
  const link=await page.locator('.idea-resource').first().locator('a').getAttribute('href');const download=await context.request.get(base+link);assert.equal(await download.text(),'private experiment bytes');assert.match(download.headers()['content-disposition'],/^attachment/);
  await page.locator('.idea-resource').first().getByRole('button',{name:'移除资源关联'}).click();await save();
  await page.locator('#idea-history').click();const history=page.locator('.idea-history-entry').filter({has:page.locator('summary', {hasText:'v'+resourceRevision+' ·'})});await history.locator('summary').click();await expect(history).toContainText('experiment.txt');await expect(history.locator('pre').first()).toContainText('尚未判断');await page.locator('[data-close=idea-history-dialog]').click();
  await page.locator('#idea-context').click();await expect(page.locator('#idea-context-text')).toHaveValue(/尚未判断，但已经发现/);await expect(page.locator('#idea-context-text')).toHaveValue(/原假设不成立/);await page.locator('[data-close=idea-context-dialog]').click();
  assert((await page.locator('#idea-body').boundingBox()).width>550);
  assert((await page.locator('[name=novelty_reason]').boundingBox()).width>200);
  await expect(page.locator('.editor-draft-bar')).toBeEmpty();
  await page.screenshot({path:join(output,'detail-desktop.png'),fullPage:true});
  // An error keeps the input and can be retried; a concurrent update remains protected.
  await page.locator('[name=novelty_reason]').fill('保存失败时也不能丢失这段判断依据。');
  const route=base+'/api/ideas/'+id;
  await page.route(route,r=>r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'模拟保存失败'}})}));
  await page.locator('#idea-save').click();await expect(page.locator('#idea-save-message')).toHaveText('模拟保存失败');await expect(page.locator('[name=novelty_reason]')).toHaveValue('保存失败时也不能丢失这段判断依据。');await page.unroute(route);await save();
  const oldRevision=Number(await revision());
  assert.equal((await context.request.post(route,{headers:{'X-AI-Persona':'1'},data:{expected_revision:oldRevision,values:{difficulty_reason:'另一个窗口更新'}}})).status(),200);
  await page.locator('[name=novelty_reason]').fill('保留冲突输入');await page.locator('#idea-save').click();await expect(page.locator('#idea-save-message')).toContainText('记录已在别处更新');await expect(page.locator('[name=novelty_reason]')).toHaveValue('保留冲突输入');
  // Mobile layout and dialog remain usable without horizontal overflow.
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('#idea-edit-ending').click();assert.equal(await page.evaluate(()=>document.querySelector('#idea-closure-dialog').scrollWidth<=innerWidth),true);await page.screenshot({path:join(output,`mobile-ending-${width}.png`),fullPage:true});await page.locator('[data-close=idea-closure-dialog]').last().click();}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'detail-mobile.png'),fullPage:true});
  await context.addCookies([{name:'ai_persona_locale',value:'en',url:base}]);
  const english=await context.newPage();await english.setViewportSize({width:320,height:844});
  await english.goto(base+'/ideas');await expect(english.locator('h1')).toHaveText('Ideas');
  await english.locator('.persona-nav summary').click();
  await english.screenshot({path:join(output,'english-mobile.png'),fullPage:true});
  assert.equal(await english.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify(await english.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,100),right:e.getBoundingClientRect().right})).slice(0,20))));
  await english.goto(base+'/ideas/idea_demo_adaptive_bond');
  await expect(english.locator('[name=novelty_reason]')).toBeVisible();
  assert.equal(await english.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);await writeFile(join(output,'report.json'),JSON.stringify({ok:true,scenarios:['native UI','all outcomes','cancellation','persistent drafts','reopening','no-op revisions','resources','history','local context','save failure','concurrency','safe Markdown','mobile 320/390'],errors},null,2));
  console.log('Ideas browser verification passed.');
} finally {await browser?.close();child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>child.kill('SIGKILL'),5000).unref();});await rm(scratch,{recursive:true,force:true});}
