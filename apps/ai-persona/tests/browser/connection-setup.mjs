// The copy-to-Codex path, including clipboard failure and independent status checks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url)), app = resolve(directory, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'persona-connection-'));
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
  const url=log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1380,height:1000},permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url+'/settings?tab=sources');
  const health=await (await page.request.get(url+'/healthz')).json();
  const status=kind=>page.locator(`[data-connection-status="${kind}"]`);
  await expect(status('hook')).toHaveText('未接入');
  await expect(status('mcp')).toHaveText('未配置');
  await expect(page.locator('#connection-setup a[download]')).toHaveCount(0);
  await expect(page.locator('#mcp-manual')).not.toHaveAttribute('open','');
  await expect(page.locator('#hook-manual')).not.toHaveAttribute('open','');
  for(const kind of ['hook','mcp']) {
    const prompt=await page.locator(`[data-connection-prompt="${kind}"]`).inputValue();
    assert.ok(prompt.includes(health.workspace_id));
    assert.ok(prompt.includes(url));
    assert.match(prompt,/raw\.githubusercontent\.com\/rainshed\/PersonaStudio\/[a-f0-9]{40}\//);
    assert.match(prompt,new RegExp(`CODEX_${kind.toUpperCase()}_SETUP.md`));
    await page.locator(`[data-copy-connection="${kind}"]`).click();
    await expect(page.locator(`[data-copy-feedback="${kind}"]`)).toContainText('已复制');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),prompt);
  }
  await page.screenshot({path:join(output,'connection-setup-desktop.png'),fullPage:true});
  // Manual controls remain reachable after folding the detailed setup.
  await page.locator('#hook-manual > summary').click();
  await page.locator('#learning-source-new').click();
  await expect(page.locator('#codex-setup')).toBeVisible();
  await page.locator('#setup-close').click();
  await page.locator('#hook-manual > summary').click();

  let failed=false;
  await page.route('**/api/studio/mcp-setup',r=>failed?r.fulfill({status:503,json:{}}):r.fulfill({json:{configured:true,client_read:null}}));
  await page.route('**/api/studio/integrations',r=>r.fulfill({json:{connections:[{enabled:true,verified:true}]}}));
  const refresh=async()=>{
    await expect(page.locator('[data-connection-refresh]')).toBeEnabled();
    await page.locator('[data-connection-refresh]').click();
    await expect(page.locator('[data-connection-refresh]')).toBeEnabled();
  };
  await refresh();
  await expect(status('hook')).toHaveText('已验证接入');
  await expect(status('mcp')).toHaveText('待实际查询');
  failed=true;await refresh();
  await expect(status('mcp')).toHaveText('状态暂不可读取');
  await expect(status('hook')).toHaveText('已验证接入');
  await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{value:async()=>{throw Error('clipboard unavailable');}}));
  await page.locator('[data-copy-connection="mcp"]').click();
  await expect(page.locator('[data-prompt-preview="mcp"]')).toHaveAttribute('open','');
  await expect(page.locator('[data-copy-feedback="mcp"]')).toContainText('无法自动复制');
  assert.equal(await page.locator('[data-connection-prompt="mcp"]').evaluate(el=>el.selectionEnd-el.selectionStart===el.value.length),true);

  for(const locale of ['zh-CN','en']) {
    await context.addCookies([{name:'ai_persona_locale',value:locale,url}]);
    await page.setViewportSize({width:320,height:900});
    await page.reload();
    await expect(page.locator('[data-copy-connection="hook"]')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await expect(page.locator('[data-copy-connection="mcp"]')).toHaveText(locale==='en'?'Copy MCP setup instructions':'复制 MCP 接入指令');
    await page.screenshot({path:join(output,`connection-setup-mobile-${locale}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log('Connection setup: context, clipboard/fallback, manual controls, status recovery, bilingual mobile passed');
} finally {
  if(browser)await browser.close();
  if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}
  await rm(scratch,{recursive:true,force:true});
}
