// Real first-use installation and browser flows; provider responses are local fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url));
const app = resolve(directory, '../..'), root = resolve(app, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'personastudio-first-use-'));
const workspace = join(scratch, 'my-persona');
const python = process.env.AI_PERSONA_TEST_PYTHON || join(app, '.venv/bin/python');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_PERSONA_')));
Object.assign(env, {PYTHONPATH: join(app, 'src'), PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
  AI_PERSONA_CONFIG: join(scratch, 'config.toml'), AI_PERSONA_DEMO_HOME: join(scratch, 'demo'),
  AI_PERSONA_MODEL_DATA_DIR: join(scratch, 'models'), AI_PERSONA_MODEL_RUNTIME_CACHE_DIR: join(scratch, 'runtime'),
  AI_PERSONA_LEARNING_DIR: join(scratch, 'learning')});
const output = join(root, 'browser-results');
await mkdir(output, {recursive: true});
let browser, guide, studioURL, calls = 0;
const errors = [], events = [];
function record(message) { events.push(message); console.log(message); }
const provider = createServer(async (req, res) => {
  calls++;
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = JSON.parse(Buffer.concat(parts).toString());
  assert.equal(req.url, '/v1/chat/completions');
  assert(body.messages.some(m => m.content === 'Reply with exactly the word OK.'));
  if (req.headers.authorization !== 'Bearer local-fixture-key') {
    res.writeHead(401, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error: {message: 'invalid API key'}}));
    return;
  }
  res.writeHead(200, {'Content-Type': 'text/event-stream'});
  const base = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model'};
  res.end('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {role: 'assistant', content: 'OK'}, finish_reason: null}]})
    + '\n\ndata: ' + JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}})
    + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerURL = 'http://127.0.0.1:' + provider.address().port;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(args) {
  const child = spawn(python, ['-m', 'ai_persona', ...args], {cwd: scratch, env, stdio: 'ignore'});
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Test cleanup command failed: ' + args[0]))); });
}
try {
  guide = spawn(existsSync(python) ? python : 'uv', existsSync(python)
    ? [join(directory, 'serve.py'), 'setup']
    : ['run', '--locked', '--no-editable', '--project', app, 'python', join(directory, 'serve.py'), 'setup'], {cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  guide.stdout.on('data', chunk => {log += chunk;});
  guide.stderr.on('data', chunk => {log += chunk;});
  const deadline = Date.now() + 30000;
  while (!log.includes('READY ') && Date.now() < deadline) { assert.equal(guide.exitCode, null, log); await delay(50); }
  const base = log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert(base, log);
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({locale: 'en-US', viewport: {width: 1360, height: 1000}});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.continue();
    errors.push('Unexpected external browser request: ' + url.origin); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?lang=en');
  await page.locator('[name=mode][value=create]').check();
  await page.locator('#workspace-path').fill(workspace);
  await page.locator('#setup-submit').click();
  await page.waitForURL('**/settings/models', {timeout: 25000});
  studioURL = new URL(page.url()).origin;
  await expect(page.locator('#model-runtime-install')).toBeVisible();
  await expect(page.locator('#model-new')).toBeDisabled();
  assert.equal(calls, 0);
  // Exercise the missing-Node guidance without modifying the machine's Node installation.
  await page.route('**/api/models/runtime', route => route.fulfill({json: {
    status: 'needs_node', can_install: true, checks: [{name: 'node', ok: false, version: null}],
  }}));
  await page.reload();
  await expect(page.locator('#model-node-download')).toBeVisible();
  await expect(page.locator('#model-runtime-install')).toBeHidden();
  await expect(page.locator('#model-runtime-check')).toBeEnabled();
  await page.unroute('**/api/models/runtime');
  await page.locator('#model-runtime-check').click();
  await expect(page.locator('#model-runtime-install')).toBeVisible();
  await page.screenshot({path: join(output, 'model-setup-start.png'), fullPage: true});
  record('New workspace redirects to AI setup; missing components have an actionable installation step.');
  await page.locator('#model-runtime-install').click();
  await expect(page.locator('#model-setup')).toHaveAttribute('data-state', 'installing', {timeout: 5000});
  await page.reload();
  await expect(page.locator('#model-new')).toBeEnabled({timeout: 310000});
  await expect(page.locator('#model-step-runtime')).toHaveAttribute('data-done', 'true');
  await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'false');
  record('Page-triggered pinned npm installation completes in an empty cache; reload resumes the job.');
  // Exercise the actual shipped OAuth adapter up to the point requiring user login.
  await page.locator('#model-new').click();
  await page.locator('#model-form [name=name]').fill('Fictional subscription account');
  await page.locator('#model-form [name=providerId]').selectOption('openai-codex');
  await page.locator('#model-form button[type=submit]').click();
  await expect(page.locator('#model-step-auth')).toHaveAttribute('data-done', 'false');
  await page.getByRole('button', {name: 'Authorize', exact: true}).click();
  await expect(page.locator('#auth-input select')).toBeVisible({timeout: 10000});
  assert.deepEqual(await page.locator('#auth-input select option').evaluateAll(options => options.map(o => o.value)), ['browser', 'device_code']);
  await page.reload();
  await expect(page.locator('#auth-input select')).toBeVisible({timeout: 10000});
  await page.locator('#auth-cancel').click();
  await expect(page.locator('#model-auth')).toBeHidden();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Delete connection', exact: true}).click();
  await expect(page.locator('#model-connections')).toContainText('No account connections yet.');
  assert.equal(calls, 0);
  record('Real OAuth adapter displays browser/device-code choices; pending login resumes after reload and cancels without credentials or network login.');
  // API-key storage and real SDK requests terminate at our local fixture provider.
  await page.locator('#model-new').click();
  await page.locator('#model-form [name=name]').fill('Local test provider');
  await page.locator('#model-form [name=providerId]').selectOption('custom');
  await page.locator('#model-form [name=authType]').selectOption('api_key');
  await page.locator('#model-form [name=apiKey]').fill('local-fixture-key');
  await page.locator('#model-form [name=customModel]').fill('fixture-model');
  await page.locator('#model-form [name=baseUrl]').fill(providerURL + '/v1');
  await page.locator('#model-form button[type=submit]').click();
  await expect(page.locator('#model-step-auth')).toHaveAttribute('data-done', 'true');
  await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'false');
  assert.equal(calls, 0, 'Saving a key must not make an automatic paid request');
  const testDefault = async () => {
    if (!(await page.locator('#model-default select[name=default]').inputValue()))
      await page.locator('#model-default select[name=default]').selectOption({index: 1});
    await page.locator('#model-default .settings-connection-test').click();
    await expect(page.locator('#model-default [data-state=success]')).toBeVisible({timeout: 10000});
    await page.locator('#routing-form button[type=submit]').click();
    await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'true');
  };
  await testDefault();
  await page.reload();
  await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'true');
  record('Credentials alone are not shown as verified; test + saved default completes setup and survives reload.');
  // A new credential revision must invalidate the old successful test.
  if ((await page.locator('#model-accounts').getAttribute('open')) === null) await page.locator('#model-accounts > summary').click();
  await page.getByRole('button', {name: 'Edit connection', exact: true}).click();
  await page.locator('#model-form [name=apiKey]').fill('invalid-fixture-key');
  await page.locator('#model-form button[type=submit]').click();
  await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'false');
  await page.locator('#model-default .settings-connection-test').click();
  await expect(page.locator('#model-default [data-state=error]')).toBeVisible({timeout: 10000});
  await expect(page.locator('#model-step-test')).toHaveAttribute('data-done', 'false');
  await page.getByRole('button', {name: 'Edit connection', exact: true}).click();
  await page.locator('#model-form [name=apiKey]').fill('local-fixture-key');
  await page.locator('#model-form button[type=submit]').click();
  await testDefault();
  record('Changed credentials invalidate old success; authentication failure stays incomplete and retry succeeds.');
  await page.screenshot({path: join(output, 'model-setup-ready.png'), fullPage: true});
  await context.addCookies([{name: 'ai_persona_locale', value: 'zh-CN', url: studioURL}]);
  await page.setViewportSize({width: 390, height: 844});
  await page.reload();
  await expect(page.locator('#model-setup-title')).toHaveText('AI 连接已验证');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({path: join(output, 'model-setup-mobile.png'), fullPage: true});
  assert.deepEqual(errors, []);
  const report = {ok: true, events, errors, localFixtureCalls: calls,
    realProviderLogin: 'Not performed: account owner must complete browser login or enter their own API key.'};
  await writeFile(join(output, 'model-setup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  if (studioURL) await command(['stop', '--workspace', workspace]);
  await command(['models-stop']);
  if (guide && guide.exitCode === null) {
    const exited = new Promise(resolve => guide.once('exit', resolve)); guide.kill('SIGTERM'); await exited;
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  await rm(scratch, {recursive: true, force: true});
}
