import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';

const app=fileURLToPath(new URL('../..',import.meta.url));
const child=spawn('uv',['run','--locked','--no-editable','--project',app,'--extra','dev','python',fileURLToPath(new URL('./serve_extraction.py',import.meta.url))],{env:{...process.env,PYTHONPATH:resolve(app,'src')},stdio:['ignore','pipe','pipe']});
let log='',browser;
child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
try{
  let base;for(let i=0;i<300;i++){base=log.match(/READY (http:\/\/127.0.0.1:\d+)/)?.[1];if(base)break;if(child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}assert(base,log);
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await mkdir(resolve('.qa/content-reset'),{recursive:true});
  await page.goto(base+'/extract');
  await expect(page.locator('#ex-files')).toBeEnabled();
  await page.locator('#ex-files').setInputFiles({name:'paper.md',mimeType:'text/markdown',buffer:Buffer.from('# A paper\nSpectral clustering uses eigenvectors.\n')});
  await expect(page.locator('.ex-member')).toHaveCount(1);
  await page.locator('#ex-start').click();await expect(page.locator('#ex-status')).toContainText('等待审核',{timeout:30000});
  await page.locator('#ex-clear-results').click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'确认清理',exact:true})).toBeEnabled();
  await expect(dialog).toContainText('保留本集合的输入材料');
  await expect(dialog.locator('input[type=checkbox]')).not.toBeChecked();
  await page.screenshot({path:resolve('.qa/content-reset/batch-preview.png')});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('.review-item')).toHaveCount(3);
  await page.locator('#ex-clear-results').click();await dialog.getByRole('button',{name:'确认清理',exact:true}).click();
  await expect(dialog).toContainText('本次提取结果已清除');await dialog.getByRole('button',{name:'返回工作区',exact:true}).click();
  await expect(page.locator('.ex-member')).toHaveCount(1);await expect(page.locator('.review-item')).toHaveCount(0);
  await page.locator('#ex-start').click();await expect(page.locator('#ex-status')).toContainText('等待审核',{timeout:30000});await expect(page.locator('.review-item')).toHaveCount(3);
  await page.goto(base+'/settings?tab=retention');await page.locator('[data-content-reset]').click();
  await expect(dialog.getByRole('button',{name:'确认清理',exact:true})).toBeEnabled();
  await expect(dialog).toContainText('保留模型连接');
  await page.screenshot({path:resolve('.qa/content-reset/all-preview.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await dialog.evaluate(n=>n.getBoundingClientRect().right<=innerWidth));
  await page.screenshot({path:resolve('.qa/content-reset/mobile-preview.png')});
  // A change after preview must fail locally in the dialog, with no deletion.
  await page.request.post(base+'/api/extraction',{headers:{'X-AI-Persona':'1'},data:{}});
  await dialog.getByRole('button',{name:'确认清理',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('变化');await expect(dialog.getByRole('alert')).toBeInViewport();
  await dialog.getByRole('button',{name:'关闭并重新预览',exact:true}).click();
  await page.locator('[data-content-reset]').click();await dialog.locator('input[type=checkbox]').check();await dialog.getByRole('button',{name:'确认清理',exact:true}).click();
  await expect(dialog).toContainText('内容已清空',{timeout:30000});await expect(dialog).toContainText('备份已保存到');await dialog.getByRole('button',{name:'返回工作区',exact:true}).click();
  await expect(page).toHaveURL(base+'/');
  assert.deepEqual((await (await page.request.get(base+'/api/extraction')).json()).tasks,[]);
  await page.goto(base+'/settings?tab=retention');await expect(page.locator('[data-content-reset]')).toBeVisible();
  assert.deepEqual(errors,[]);console.log('Content reset UI passed: previews, cancel, batch rerun, stale preview, full reset, optional backup and mobile layout.');
}finally{if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
