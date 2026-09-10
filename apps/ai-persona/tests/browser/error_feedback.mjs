/** Offline browser regression: actual shared assets, no accounts or model calls. */
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const asset = name => fileURLToPath(new URL('../../src/ai_persona/static/' + name, import.meta.url));
const browser = await chromium.launch({headless: true});
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({viewport: {width, height: 800}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<html lang="zh-CN"><body><main>
      <div id="top-error" class="ai-notice" hidden></div>
      <div style="height:2400px"></div>
      <form id="request"><button type="button" id="submit">保存</button><p id="near-error" role="alert" hidden></p></form>
      <details id="collapsed"><summary>详情</summary><p id="folded-error" role="alert" hidden></p></details>
      <dialog id="modal"><button id="modal-action">提交</button><div style="height:1200px"></div><p id="modal-error" role="alert" hidden></p></dialog>
    </main></body></html>`);
    await page.addStyleTag({path: asset('error-feedback.css')});
    await page.addScriptTag({path: asset('error-feedback.js')});
    await page.addScriptTag({path: asset('ai-common.js')});
    await page.locator('#submit').click();
    assert(await page.evaluate(() => scrollY) > 1500);
    await page.evaluate(() => PersonaAI.notice('top-error', '保存失败，请重新选择。', true));
    await expect(page.locator('#top-error')).toBeInViewport();
    await expect(page.locator('#top-error')).toBeFocused();

    // Repeated polling replaces the node but must not drag a reader back to the top.
    await page.locator('#submit').click();
    const position = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      const el = document.querySelector('#top-error'); el.replaceWith(el.cloneNode(true));
    });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => scrollY), position);
    await page.evaluate(() => PersonaAI.notice('top-error', ''));
    await page.waitForTimeout(50);

    // Inline errors stay beside the action without moving a visible control away.
    await page.evaluate(() => {
      const el = document.querySelector('#near-error'); el.textContent = '请选择账号'; el.hidden = false;
    });
    await expect(page.locator('#near-error')).toBeInViewport();
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - position) <= 32);
    await expect(page.locator('#submit')).toBeInViewport();
    await page.evaluate(() => {
      const el = document.querySelector('#folded-error'); el.textContent = '字段无效'; el.hidden = false;
    });
    await expect(page.locator('#collapsed')).toHaveAttribute('open', '');
    await expect(page.locator('#folded-error')).toBeInViewport();

    // HTMX response/network failures are shown by the originating form as safe text.
    await page.locator('#submit').click();
    await page.evaluate(() => document.querySelector('#request').dispatchEvent(new CustomEvent('htmx:responseError', {
      bubbles: true, detail: {requestConfig: {elt: document.querySelector('#submit')}, xhr: {
        responseText: JSON.stringify({error: {message: '<img src=x onerror=alert(1)> 请求失败'}}),
      }},
    })));
    await expect(page.locator('#request > [data-request-error]')).toBeInViewport();
    await expect(page.locator('#request > [data-request-error]')).toContainText('<img src=x');
    assert.equal(await page.locator('#request img').count(), 0);
    await page.evaluate(() => document.querySelector('#request').dispatchEvent(new CustomEvent('htmx:sendError', {bubbles: true})));
    await expect(page.locator('#request > [data-request-error]')).toContainText('检查连接');
    await page.evaluate(() => document.querySelector('#request').dispatchEvent(new CustomEvent('htmx:beforeRequest', {bubbles: true})));
    await expect(page.locator('#request > [data-request-error]')).toBeHidden();

    // A panel can clip an error even when its coordinates fall inside the window.
    await page.evaluate(() => {
      const panel = document.createElement('div'); panel.id = 'scroll-panel';
      panel.style.cssText = 'position:fixed;top:100px;left:20px;width:250px;height:120px;overflow:auto;background:white';
      panel.innerHTML = '<div style="height:240px"></div><p id="clipped-error" role="alert">保存遇到冲突</p>';
      document.body.append(panel);
    });
    await expect.poll(() => page.locator('#scroll-panel').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.locator('#scroll-panel').evaluate(el => el.remove());

    // An error in a modal scrolls its own container and receives keyboard focus.
    await page.evaluate(() => document.querySelector('#modal').showModal());
    await page.locator('#modal-action').click();
    await page.evaluate(() => {
      const el = document.querySelector('#modal-error'); el.textContent = '模型不可用'; el.hidden = false;
    });
    await expect(page.locator('#modal-error')).toBeInViewport();
    await expect(page.locator('#modal-error')).toBeFocused();
    await page.evaluate(() => PersonaAI.notice('top-error', '后台分析未完成', true));
    await page.waitForTimeout(50);
    await expect(page.locator('#modal-error')).toBeFocused();
    await page.evaluate(() => document.querySelector('#modal').close());
    await expect(page.locator('#top-error')).toBeInViewport();
    await expect(page.locator('#top-error')).toBeFocused();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Error visibility passed: desktop/mobile, inline, offscreen, repeated polling, collapsed details, modal and failed requests.');
} finally { await browser.close(); }
