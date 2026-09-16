import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url));
const app = resolve(directory, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'persona-extensions-'));
const output = resolve(app, '../../browser-results');
const root = join(scratch, 'installation');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_PERSONA_')));
Object.assign(env, {
  PYTHONPATH: join(app, 'src'), PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
  PERSONASTUDIO_ROOT: root, AI_PERSONA_CONFIG: join(scratch, 'config.toml'),
  AI_PERSONA_MODEL_DATA_DIR: join(scratch, 'models'),
  AI_PERSONA_MODEL_RUNTIME_CACHE_DIR: join(scratch, 'runtime'),
  AI_PERSONA_LEARNING_DIR: join(scratch, 'learning'), AI_PERSONA_SEMANTIC_SEARCH: '0',
});
await mkdir(output, { recursive: true });
const server = spawn(join(app, '.venv/bin/python'), [join(directory, 'serve.py'), 'empty'], {
  cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser;
server.stdout.on('data', value => log += value);
server.stderr.on('data', value => log += value);
const errors = [];
try {
  await expect.poll(() => log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1], { timeout: 30000 }).toBeTruthy();
  const url = log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const installed of [false, true]) {
    if (installed) {
      const launcher = join(root, 'apps/paper-radar/scripts/launcher.mjs');
      await mkdir(dirname(launcher), { recursive: true });
      await writeFile(launcher, '// availability fixture');
    }
    for (const locale of ['zh-CN', 'en']) {
      await context.addCookies([{ name: 'ai_persona_locale', value: locale, url }]);
      for (const width of [1380, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(url + '/settings/extensions');
        await expect(page.locator('h1')).toHaveText(locale === 'en' ? 'Extensions' : '扩展应用');
        if (installed) {
          await expect(page.locator('[data-copy-install]')).toHaveCount(0);
          await expect(page.locator('main [data-open-paper-radar]')).toBeVisible();
        } else {
          await expect(page.locator('[data-open-paper-radar]')).toHaveCount(0);
          await page.locator('[data-copy-install]').click();
          await expect(page.locator('[data-copy-result]')).toContainText(locale === 'en' ? 'Copied' : '已复制');
          assert.match(await page.evaluate(() => navigator.clipboard.readText()), /--with-paper-radar$/);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(output, `extensions-${installed ? 'combined' : 'persona'}-${locale}-${width}.png`), fullPage: true });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Extensions: both installation states, bilingual desktop/mobile and command copy passed.');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    const stopped = new Promise(done => server.once('exit', done));
    server.kill('SIGTERM');
    await stopped;
  }
  await rm(scratch, { recursive: true, force: true });
}
