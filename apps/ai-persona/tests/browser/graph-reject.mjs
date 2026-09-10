import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
const app=fileURLToPath(new URL('../..',import.meta.url));
const child=spawn('uv',['run','--locked','--no-editable','--project',app,'--extra','dev','python',fileURLToPath(new URL('./serve_extraction.py',import.meta.url))],{env:{...process.env,PYTHONPATH:resolve(app,'src')},stdio:['ignore','pipe','pipe']});
let log='',browser;child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
try{
 let base;for(let i=0;i<300;i++){base=log.match(/READY (http:\/\/127.0.0.1:\d+)/)?.[1];if(base)break;if(child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}assert(base,log);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/extract');await expect(page.locator('#ex-runtime')).toContainText('已登录');
 await expect(page.locator('#ex-language')).toBeVisible();await expect(page.locator('#ex-language')).toHaveValue('zh');
 await page.locator('#ex-language').selectOption('en');await page.locator('#ex-rules summary').click();await page.locator('#ex-defaults').click();await expect(page.locator('#ex-policy-feedback')).toContainText('保存');
 await page.reload();await expect(page.locator('#ex-language')).toHaveValue('en');
 await page.locator('#ex-files').setInputFiles([{name:'one.md',mimeType:'text/markdown',buffer:Buffer.from('# First paper\nSpectral clustering partitions similarity graphs using eigenvectors.\n')},{name:'two.md',mimeType:'text/markdown',buffer:Buffer.from('# Second paper\nSpectral clustering uses graph Laplacian eigenvectors.\n')}]);
 await expect(page.locator('.ex-member')).toHaveCount(2);await page.locator('#ex-start').click();await expect(page.locator('#ex-status')).toContainText('等待审核',{timeout:30000});
 await expect(page.locator('#ex-run-budget')).toContainText('English');const taskId=new URL(page.url()).searchParams.get('task');
 const task=await (await page.request.get(base+'/api/extraction/'+taskId)).json();assert.equal(task.run_policy.output_language,'en');
 await expect(page.locator('.review-item')).toHaveCount(5);await page.getByRole('button',{name:'显示图谱',exact:true}).click();
 const close=page.locator('.node-reject:visible');await expect(close).toHaveCount(1);await expect(close).toHaveAttribute('title',/2 条/);
 // A failed graph action must report locally and leave the proposal pending; never retry the write.
 let writes=0;await page.route('**/api/inbox/v1/items/**/review/*',route=>{writes++;return route.fulfill({status:503,json:{error:{message:'暂时无法保存'}}});});
 await close.click();await expect(page.locator('.review-message')).toContainText('拒绝未能确认');assert.equal(writes,1);await expect(close).toBeEnabled();
 await page.unroute('**/api/inbox/v1/items/**/review/*');
 await page.setViewportSize({width:390,height:844});await close.focus();await page.keyboard.press('Enter');
 await expect(page.locator('.review-message')).toContainText('同时拒绝了 2 条');await expect(close).toHaveCount(0);
 const url=base+'/api/inbox/v1/items/'+encodeURIComponent('change_set:'+task.submissions[0].change_set_id)+'/review';const result=await (await page.request.get(url)).json();
 assert.equal(result.proposals.filter(p=>p.status==='rejected').length,3);assert(result.proposals.filter(p=>p.entity_type==='material').every(p=>p.status==='pending_review'));
 await page.reload();await expect(page.locator('.review-item')).toHaveCount(5);await page.getByRole('button',{name:'显示图谱',exact:true}).click();await expect(page.locator('#graph .node[data-status="rejected"]')).toHaveCount(1);await expect(page.locator('.node-reject:visible')).toHaveCount(0);
 await page.goto(base+'/knowledge');await expect(page.locator('#graph .node')).not.toHaveCount(0);await expect(page.locator('.node-reject')).toHaveCount(0);
 assert.deepEqual(errors,[]);console.log('Graph reject and output language passed: defaults persistence, task snapshot, graph rejection, dependent relations, local failures, keyboard/mobile, home unchanged.');
}finally{await browser?.close();child.kill('SIGTERM');}
