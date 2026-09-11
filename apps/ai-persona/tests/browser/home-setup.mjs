// Home onboarding against a disposable server on an independent port.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url));
const app = resolve(directory, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'persona-home-'));
const output = resolve(app, '../../browser-results');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_PERSONA_')));
Object.assign(env, {PYTHONPATH:join(app,'src'), PYTHONUNBUFFERED:'1', PYTHONNOUSERSITE:'1',
  AI_PERSONA_CONFIG:join(scratch,'config.toml'), AI_PERSONA_MODEL_DATA_DIR:join(scratch,'models'),
  AI_PERSONA_MODEL_RUNTIME_CACHE_DIR:join(scratch,'runtime'), AI_PERSONA_LEARNING_DIR:join(scratch,'learning'),
  AI_PERSONA_SEMANTIC_SEARCH:'0', CODEX_HOME:join(scratch,'codex')});
await mkdir(output,{recursive:true});
const server = spawn(join(app,'.venv/bin/python'),[join(directory,'serve.py'),'empty'],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let log='', browser;
server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
const errors=[];
try {
  await expect.poll(()=>log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1],{timeout:30000}).toBeTruthy();
  const firstURL=log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1380,height:1000}});
  context.setDefaultTimeout(10000);
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===firstURL||url.protocol==='data:')return route.continue();
    errors.push('Unexpected request: '+url.origin);return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(firstURL+'/');
  // Home setup uses independent, read-only checks and stays useful when a check fails.
  const setupItem = key => page.locator(`[data-setup-item="${key}"]`);
  const refreshSetup = async () => {
    await expect(page.locator('#home-setup-refresh')).toBeEnabled();
    await page.locator('#home-setup-refresh').click();
    await expect(page.locator('#home-setup-refresh')).toBeEnabled();
  };
  await expect(page.locator('#home-setup-progress')).toHaveText('已完成 0 / 3 项');
  await expect(page.locator('.home-support')).toContainText('当前版本仅支持 Codex 接入');
  await expect(page.locator('.home-review-rule')).toContainText('必须经你审核通过');
  await expect(page.locator('.persona-home a[href="/ai"]')).toHaveCount(1);
  for (const path of ['knowledge', 'preferences', 'materials']) {
    await expect(page.locator(`.home-enrichment a[href="/${path}/new"]`)).toBeVisible();
  }
  let modelReady = true, connections = [], mcpState = {configured:false, client_read:null}, failMcp = false;
  const readinessRoute = route => route.fulfill({json:{ready:modelReady, status:modelReady?'configured':'needs_account'}});
  const integrationsRoute = route => route.fulfill({json:{demo:false, connections}});
  const mcpRoute = route => failMcp ? route.fulfill({status:503,json:{error:{message:'offline'}}}) : route.fulfill({json:mcpState});
  await page.route('**/api/studio/readiness', readinessRoute);
  await page.route('**/api/studio/integrations', integrationsRoute);
  await page.route('**/api/studio/mcp-setup', mcpRoute);
  await refreshSetup();
  await expect(page.locator('#home-setup-progress')).toHaveText('已完成 1 / 3 项');
  await expect(setupItem('hook').locator('a')).toHaveClass(/primary-button/);
  await page.screenshot({path:join(output,'home-guide-desktop.png'),fullPage:true,animations:'disabled'});

  connections = [{enabled:true,verified:false}];
  mcpState = {configured:true,client_read:null};
  await refreshSetup();
  await expect(setupItem('hook')).toContainText('继续设置');
  await expect(setupItem('mcp')).toContainText('待实际查询');
  await expect(page.locator('#home-setup-ready')).toBeHidden();
  connections = [{enabled:true,verified:true,preferences:false,learning:false}];
  mcpState = {configured:true,client_read:{tool:"get_knowledge_map"}};
  await refreshSetup();
  await expect(page.locator('#home-setup-ready')).toBeVisible();
  await expect(page.locator('#home-setup-details')).toBeHidden();
  await page.locator('#home-setup-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#home-setup-toggle')).toHaveAttribute('aria-expanded','true');
  await expect(page.locator('#home-setup-details')).toBeVisible();
  await page.locator('#home-setup-toggle').click();
  await expect(page.locator('#home-setup-details')).toBeHidden();

  // A second unfinished active connection must not be hidden by a verified connection.
  connections.push({enabled:true,verified:false});
  await page.reload();
  await expect(setupItem('hook')).toContainText('部分已验证');
  await expect(page.locator('#home-setup-progress')).toHaveText('已完成 2 / 3 项');
  failMcp = true;
  await refreshSetup();
  await expect(setupItem('mcp')).toContainText('状态暂不可读取');
  await expect(setupItem('model')).toContainText('✓ 已配置');
  await expect(page.locator('.home-enrichment a[href="/materials/new"]')).toBeVisible();
  failMcp = false; connections = []; mcpState = {configured:false,client_read:null};
  await refreshSetup();
  await expect(setupItem('mcp')).toContainText('配置 MCP');

  await context.addCookies([{name:'ai_persona_locale',value:'en',url:firstURL}]);
  await page.reload();
  await expect(page.locator('#home-setup-progress')).toHaveText('1 / 3 complete');
  await expect(page.locator('.home-review-rule')).toContainText('require your review and approval');
  await page.setViewportSize({width:320,height:900});
  await expect(setupItem('hook').locator('a')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:'English home fits at 320px'}).toBeLessThanOrEqual(320);
  await page.screenshot({path:join(output,'home-guide-mobile-en.png'),fullPage:true,animations:'disabled'});
  await context.addCookies([{name:'ai_persona_locale',value:'zh-CN',url:firstURL}]);
  await page.reload();
  await expect(page.locator('#home-setup-progress')).toHaveText('已完成 1 / 3 项');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth),{message:'Chinese home fits at 320px'}).toBeLessThanOrEqual(320);
  await page.screenshot({path:join(output,'home-guide-mobile.png'),fullPage:true,animations:'disabled'});

  await page.unroute('**/api/studio/readiness', readinessRoute);
  await page.unroute('**/api/studio/integrations', integrationsRoute);
  await page.unroute('**/api/studio/mcp-setup', mcpRoute);
  for (const key of ['hook','mcp']) {
    await page.goto(firstURL+'/');
    await setupItem(key).locator('a').click();
    await expect(page).toHaveURL(firstURL+`/settings?tab=sources#${key}-setup`);
    await expect(page.locator(`#${key}-setup`)).toBeInViewport();
  }
  await page.goto(firstURL+'/');
  await setupItem('model').locator('a').click();
  await expect(page).toHaveURL(firstURL+'/settings/models');
  await page.setViewportSize({width:1380,height:1000});
  console.log('Home setup states, recovery, keyboard, bilingual mobile layout and direct settings links passed');

  assert.deepEqual(errors,[]);
} finally {
  if(browser)await browser.close();
  if(server.exitCode===null){
    const stopped=new Promise(resolve=>server.once('exit',resolve));
    server.kill('SIGTERM');
    const force=setTimeout(()=>server.kill('SIGKILL'),5000);
    await stopped;clearTimeout(force);
  }
  await rm(scratch,{recursive:true,force:true});
}
