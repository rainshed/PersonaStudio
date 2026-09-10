// End-to-end draft, onboarding and workspace checks in disposable workspaces.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url));
const app = resolve(directory, '../..'), root = resolve(app, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'persona-ux-'));
const python = join(app, '.venv/bin/python');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_PERSONA_')));
Object.assign(env, {PYTHONPATH: join(app,'src'), PYTHONUNBUFFERED:'1', PYTHONNOUSERSITE:'1',
  AI_PERSONA_CONFIG:join(scratch,'config.toml'), AI_PERSONA_DEMO_HOME:join(scratch,'demo'),
  AI_PERSONA_MODEL_DATA_DIR:join(scratch,'models'), AI_PERSONA_MODEL_RUNTIME_CACHE_DIR:join(scratch,'runtime'),
  AI_PERSONA_LEARNING_DIR:join(scratch,'learning'), AI_PERSONA_SEMANTIC_SEARCH:'0', CODEX_HOME:join(scratch,'codex')});
const workspace = join(scratch,'first'), second = join(scratch,'second');
const output = join(root,'browser-results');
await mkdir(output,{recursive:true});
const guide = spawn(python,[join(directory,'serve.py'),'setup'],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let log='', browser;
guide.stdout.on('data',v=>log+=v);guide.stderr.on('data',v=>log+=v);
const errors=[];
async function command(args) {
  const child=spawn(python,['-m','ai_persona',...args],{cwd:scratch,env,stdio:'ignore'});
  await new Promise(resolve=>child.on('exit',resolve));
}
try {
  await expect.poll(()=>log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1],{timeout:30000}).toBeTruthy();
  const setup=log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1380,height:1000}});
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(30000);
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='127.0.0.1'||url.protocol==='data:')return route.continue();
    errors.push('Unexpected browser request: '+url.origin);return route.abort();
  });
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  const page=await context.newPage();
  await page.goto(setup+'/?lang=zh-CN');
  await page.locator('[name=mode][value=create]').check();
  await page.locator('#workspace-name').fill('研究笔记');
  await page.locator('#workspace-location summary').click();
  await page.locator('#workspace-path').fill(workspace);
  await page.locator('#setup-submit').click();
  await page.waitForURL(url=>url.origin!==setup,{timeout:30000});
  const firstURL=new URL(page.url()).origin;
  await expect(page.locator('.workspace-menu')).toContainText('研究笔记');
  console.log('Friendly workspace creation and manual-first entry passed');

  await page.goto(firstURL+'/preferences/new');
  await page.locator('[name=instruction]').fill('回答先给结论，再解释推导。');
  await expect(page.locator('.editor-draft-bar')).toContainText('草稿已保存');
  await page.reload();
  await page.getByRole('button',{name:'恢复草稿',exact:true}).first().click();
  await expect(page.locator('[name=instruction]')).toHaveValue('回答先给结论，再解释推导。');
  await expect(page.locator('.editor-draft-bar')).toContainText('草稿已保存');
  const other=await context.newPage();
  await other.goto(firstURL+'/preferences/new');
  await other.locator('[name=instruction]').fill('另一个标签页的独立草稿。');
  await expect(other.locator('.editor-draft-bar')).toContainText('草稿已保存');
  const drafts=await (await context.request.get(firstURL+'/api/studio/editor-drafts?page=%2Fpreferences%2Fnew')).json();
  assert.equal(drafts.items.length,2);
  await other.close();
  // Invalid form handling must retain all current input.
  await page.route('**/preferences/proposals*',route=>route.fulfill({status:422,contentType:'text/html',body:'<div role="alert">验证失败测试</div>'}));
  await page.locator('form.edit-layout button.primary-button').click();
  await expect(page.locator('.editor-draft-bar')).toContainText('验证失败测试');
  await expect(page.locator('[name=instruction]')).toHaveValue('回答先给结论，再解释推导。');
  await page.unroute('**/preferences/proposals*');
  await page.route('**/preferences/proposals*',route=>route.abort('failed'));
  await page.locator('form.edit-layout button.primary-button').click();
  await expect(page.locator('form.edit-layout button.primary-button')).toBeDisabled();
  await expect(page.locator('form.edit-layout .editor-draft-recovery[role=alert]')).toContainText('尚未确认保存成功');
  await page.getByRole('button',{name:'已检查记录，允许重试'}).click();
  await page.unroute('**/preferences/proposals*');
  await page.locator('form.edit-layout button.primary-button').click();
  await page.waitForURL(url=>url.pathname!='/preferences/new');
  await expect(page.locator('main')).toContainText('回答先给结论，再解释推导。');
  console.log('Draft reload, independent tabs, validation and confirmed save passed');

  await page.goto(firstURL+'/preferences/contexts/new');
  await page.locator('[name=name]').fill('技术说明');
  await page.locator('[name=description]').fill('解释技术问题时使用。');
  await page.locator('[name=request_examples]').fill('解释谱聚类');
  await page.locator('[data-add-example]').click();
  await page.locator('[name=request_examples]').nth(1).fill('解释特征向量');
  await expect(page.locator('.editor-draft-bar')).toContainText('草稿已保存');
  await page.locator('.language-switcher button').click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect(page.locator('[name=request_examples]').nth(1)).toHaveValue('解释特征向量');
  await page.locator('form[data-context-editor] button.primary-button').click();
  await page.waitForURL(url=>url.pathname!='/preferences/contexts/new');
  console.log('Context examples and language-switch recovery passed');

  await page.goto(firstURL+'/ai');
  await expect(page.locator('#ai-root')).toHaveAttribute('data-draft-mounted','true');
  await page.locator('#ai-message').fill('请整理这份材料的知识点。');
  await page.locator('#ai-send').click();
  await page.waitForURL('**/settings/models?return_to=*');
  await expect(page.locator('#model-runtime-install')).toBeVisible();
  await page.getByRole('link',{name:'← Return to your task'}).click();
  await page.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect(page.locator('#ai-message')).toHaveValue('请整理这份材料的知识点。');
  await expect(page.locator('.editor-draft-bar')).toContainText('Draft saved');
  console.log('Missing-model setup and return preserve AI input');

  await page.goto(firstURL+'/materials/new?use=extract');
  await page.locator('label.import-kind-card:has([value=text])').click();
  await page.locator('[name=source_title]').fill('自写课程笔记');
  await page.locator('[name=source_text]').fill('# 谱聚类\n谱聚类使用相似度矩阵的特征向量，将图中的节点分为不同组。');
  await page.locator('[data-import-submit]').click();
  await page.waitForURL('**/materials/imports/*?use=extract');
  await expect(page.locator('.editor-draft-bar')).toContainText('Draft saved');
  await page.locator('[name=authors]').fill('测试作者');
  await expect(page.locator('.editor-draft-bar')).toContainText('Draft saved');
  await page.locator('[data-use-material=extract]').click();
  await page.waitForURL('**/extract?task=*');
  await expect(page.locator('#ex-members')).toContainText('自写课程笔记');
  await expect(page.locator('#ex-status')).not.toContainText('正在整理');
  await page.locator('#ex-goal').fill('保留这段新的分析目标。');
  await expect(page.locator('.editor-draft-bar')).toContainText('Draft saved');
  await page.reload();
  await page.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect(page.locator('#ex-goal')).toHaveValue('保留这段新的分析目标。');
  await expect(page.locator('.editor-draft-bar')).toContainText('Draft saved');
  await page.screenshot({path:join(output,'first-use-extraction.png'),fullPage:true});
  console.log('Shared text source, author draft and extraction-goal recovery passed');

  // Keep one old tab alive to prove that switching never retargets its writes.
  const old=await context.newPage();await old.goto(firstURL+'/preferences/new');
  await page.goto(firstURL+'/workspaces');
  await page.locator('#open-workspace-manager').click();
  await page.waitForURL(url=>url.origin!==firstURL,{timeout:20000});
  await page.locator('[name=mode][value=create]').check();
  await page.locator('#workspace-location summary').click();
  await page.locator('#workspace-path').fill(second);
  await page.locator('#workspace-name').fill('第二个工作区');
  await page.locator('#confirm-switch').check();
  await page.locator('#setup-submit').click();
  await expect(page.locator('.workspace-menu')).toContainText('第二个工作区',{timeout:30000});
  const secondURL=new URL(page.url()).origin;
  const state=await (await context.request.get(secondURL+'/api/studio/editor-drafts?page=%2Fpreferences%2Fnew')).json();
  assert.equal(state.items.length,0);
  const oldIdentity=await old.locator('meta[name=persona-workspace]').getAttribute('content');
  const rejected=await context.request.post(secondURL+'/api/studio/editor-drafts',{headers:{'X-AI-Persona':'1','X-Persona-Workspace':oldIdentity,Origin:secondURL},data:{}});
  assert.equal(rejected.status(),409);
  await page.goto(secondURL+'/workspaces');
  await page.screenshot({path:join(output,'first-use-workspaces.png'),fullPage:true});
  console.log('Independent coordinator switches workspace and rejects stale writes');
  assert.deepEqual(errors,[]);
  console.log('First-use UX browser checks passed');
} finally {
  if(browser)await browser.close();
  await command(['stop','--workspace',second]);
  await command(['stop','--workspace',workspace]);
  guide.kill('SIGTERM');
  await rm(scratch,{recursive:true,force:true});
}
