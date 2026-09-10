/** Offline browser smoke against fresh Demo/setup servers, never the user's browser. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect} from '@playwright/test';

const directory = dirname(fileURLToPath(import.meta.url));
const app = resolve(directory, '../..');
const root = resolve(app, '../..');
assert(existsSync(join(app, 'pyproject.toml')), 'Browser runner must resolve the AI Persona project');
const scratch = await mkdtemp(join(tmpdir(), 'personastudio-browser-'));
const output = resolve(process.env.AI_PERSONA_BROWSER_OUTPUT || join(root, 'browser-results'));
const screenshots = join(root, 'docs/images');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AI_PERSONA_')));
Object.assign(env, {
  AI_PERSONA_CONFIG: join(scratch, 'config.json'),
  AI_PERSONA_DEMO_HOME: join(scratch, 'demo'),
  AI_PERSONA_MODEL_DATA_DIR: join(scratch, 'models'),
  AI_PERSONA_MODEL_RUNTIME_CACHE_DIR: process.env.AI_PERSONA_BROWSER_RUNTIME_CACHE_DIR || join(scratch, 'runtime'),
  AI_PERSONA_LEARNING_DIR: join(scratch, 'learning'),
  AI_PERSONA_PROMPT_WORKBENCH_URL: 'http://127.0.0.1:1',
  PYTHONPATH: join(app, 'src'), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1',
});
await Promise.all([mkdir(output, {recursive: true}), mkdir(screenshots, {recursive: true})]);
const children = [];
const report = {pages: [], interactions: [], optionalModelResponses: [], errors: []};
const responseChecks = [];
let browser;

async function start(mode) {
  const python = process.env.AI_PERSONA_TEST_PYTHON || join(app, '.venv/bin/python');
  const command = existsSync(python) ? python : 'uv';
  const args = existsSync(python) ? [join(directory, 'serve.py'), mode]
    : ['run', '--locked', '--project', app, 'python', join(directory, 'serve.py'), mode];
  const child = spawn(command, args, {cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(child);
  let log = '';
  let spawnError;
  child.stdout.on('data', chunk => {log += chunk.toString();});
  child.stderr.on('data', chunk => {log += chunk.toString();});
  child.on('error', error => {spawnError = error;});
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`${mode} server could not launch: ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`${mode} server exited: ${log}`);
    const match = log.match(/READY (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      try {
        const response = await fetch(match[1] + (mode === 'demo' ? '/healthz' : '/'));
        if (response.ok) return match[1];
      } catch { /* The listening socket is bound before Uvicorn starts. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${mode} server failed to start: ${log}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(force);
}

try {
  const [base, setup] = await Promise.all([start('demo'), start('setup')]);
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1080}, locale: 'en-US'});
  // Block any unexpected external page request rather than allowing a model or account call.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || [base, setup].includes(url.origin)) {
      return route.continue();
    }
    report.errors.push(`Unexpected external browser request: ${url.origin}${url.pathname}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(`JavaScript: ${error.message}`));
  page.on('response', response => responseChecks.push((async () => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    const optionalModel = url.pathname === '/api/models/config'
      || url.pathname === '/api/evaluations/v1/models'
      || url.pathname === '/api/evaluations/v1/selection';
    if (optionalModel) {
      const body = await response.json().catch(() => null);
      const code = body?.error?.code || body?.code;
      if (['runtime_missing', 'not_configured'].includes(code)) {
        report.optionalModelResponses.push(`${response.status()} ${url.pathname}: ${code}`);
      } else {
        report.errors.push(`Unexpected model API failure: ${response.status()} ${url.pathname}: ${code}`);
      }
    } else if (!(url.pathname === '/api/setup' && response.status() === 400)) {
      report.errors.push(`HTTP ${response.status()} ${url.pathname}`);
    }
  })()));
  const visit = async path => {
    const response = await page.goto(base + path, {waitUntil: 'networkidle'});
    assert(response?.ok(), `${path}: HTTP ${response?.status()}`);
    await expect(page.locator('h1').first()).toBeVisible();
    report.pages.push({path, heading: await page.locator('h1').first().innerText()});
  };

  await context.addCookies([{name: 'ai_persona_locale', value: 'en', url: base}]);
  for (const path of ['/', '/knowledge', '/courses', '/materials', '/preferences', '/inbox',
    '/evaluations', '/settings', '/ai', '/knowledge/new', '/courses/new', '/materials/new',
    '/preferences/new', '/preferences/contexts/new', '/preferences/examples/new', '/preferences/try',
    '/settings?tab=sources', '/settings?tab=capabilities', '/settings?tab=retention',
    '/review', '/learning', '/preferences/applications']) await visit(path);

  await visit('/ai');
  await page.locator('[data-source-mode="text"]').click();
  await page.locator('#ai-add-text').click();
  await expect(page.locator('#ai-notice')).toContainText('Paste reference text');
  await expect(page.locator('#ai-notice')).toBeInViewport();
  await expect(page.locator('.ai-result-area #ai-notice')).toBeVisible();
  report.interactions.push('Maintenance validation is visible beside the analysis area');

  await visit('/');
  await page.screenshot({path: join(screenshots, 'studio-overview.png'), fullPage: true});

  await visit('/knowledge');
  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#nodes .node').first()).toBeVisible();
  assert(Number(await page.locator('#map').getAttribute('data-nodes')) > 0);
  await page.locator('#layout').selectOption('down');
  await expect(page.locator('#map')).toHaveAttribute('data-layout', /.+/);
  const knowledgeHref = await page.locator('#nodes a.node-open').first().getAttribute('href');
  assert(knowledgeHref?.startsWith('/knowledge/'));
  await page.locator('#list-view-tab').click();
  await expect(page.locator('#knowledge-list')).toBeVisible();
  const search = page.locator('#knowledge-list input[name=q]');
  const searchTitle = await page.locator('#knowledge-results .knowledge-title strong').first().innerText();
  const filtered = page.waitForResponse(response => new URL(response.url()).pathname === '/knowledge/table');
  await search.fill(searchTitle);
  await filtered;
  await expect(page.locator('#knowledge-results')).toContainText(searchTitle);
  await visit(knowledgeHref);
  report.interactions.push('Graph renders, changes layout, switches to list, searches, opens a detail');

  await visit('/courses/new');
  await page.locator('input[name=title]').fill('Introduction to Condensed Matter');
  await page.locator('textarea[name=description]').fill('A fictional course created in the isolated browser Demo.');
  await page.locator('form.edit-layout button[type=submit]').click();
  await expect(page.locator('h1')).toHaveText('Introduction to Condensed Matter');
  assert(!new URL(page.url()).pathname.endsWith('/new'));
  report.interactions.push('Create and immediately open a course through the normal form');

  let materialHref;
  for (const section of ['materials']) {
    await visit('/' + section);
    const candidates = await page.locator(`a[href^="/${section}/"]`).evaluateAll(links =>
      links.map(link => link.getAttribute('href')).filter(href => /^\/[^/]+\/[^/?#]+$/.test(href)
        && !href.endsWith('/new')));
    assert(candidates.length > 0, `${section} has a Demo detail link`);
    await visit(candidates[0]);
    if (section === 'materials') materialHref = candidates[0];
  }
  await visit(materialHref + '/source-text');
  await visit('/inbox');
  await page.locator('#inbox-tabs button[data-view="all"]').click();
  await expect(page.locator('#inbox-tabs button[data-view="all"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#inbox-filters input[name=q]').fill('example');
  await page.locator('#inbox-filters button[type=submit]').click();
  await expect(page.locator('#inbox-count')).not.toContainText('Loading');
  report.interactions.push('Inbox switches views and filters without model calls');

  await visit('/evaluations');
  await page.locator('#evaluation-cases-tab').click();
  await expect(page.locator('#evaluation-cases-panel')).toBeVisible();
  await page.locator('#evaluation-reports-tab').click();
  await expect(page.locator('#evaluation-reports-panel')).toBeVisible();
  report.interactions.push('Evaluation cases and report tabs open');

  await visit('/');
  await page.locator('form.language-switcher button').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('h1')).toHaveText('概览');
  await page.locator('form.language-switcher button').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('h1')).toHaveText('Overview');
  report.interactions.push('English/Chinese switch persists and preserves content');

  await page.setViewportSize({width: 390, height: 844});
  for (const path of ['/', '/knowledge', '/inbox', '/evaluations', '/settings?tab=sources']) {
    await visit(path);
    const width = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth,
                                             viewport: window.innerWidth}));
    assert(width.scroll <= width.viewport + 2, `${path} overflows at 390px: ${width.scroll}`);
  }
  report.interactions.push('Primary pages fit a 390px viewport');

  await page.setViewportSize({width: 1440, height: 1080});
  await page.goto(setup + '/?lang=en', {waitUntil: 'networkidle'});
  await expect(page.locator('h1')).toHaveText('Make your AI feel more like you');
  await expect(page.locator('input[value=demo]')).toBeChecked();
  await page.screenshot({path: join(screenshots, 'studio-setup.png'), fullPage: true});
  await page.locator('input[value=create]').check();
  await expect(page.locator('#workspace-path')).toBeVisible();
  await expect(page.locator('#persona-id')).toBeVisible();
  await page.locator('#workspace-path').fill('relative-path');
  await page.locator('#setup-submit').click();
  await expect(page.locator('#setup-status')).toHaveAttribute('data-error', 'true');
  await expect(page.locator('#setup-submit')).toBeEnabled();
  await page.locator('a[lang="zh-CN"]').click();
  await expect(page.locator('h1')).toHaveText('让 AI 更了解你');
  await page.setViewportSize({width: 390, height: 844});
  await expect(page.locator('#setup-submit')).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  report.interactions.push('Setup options, inline validation, language and mobile layout work');
  await Promise.all(responseChecks);
  assert.deepEqual(report.errors, [], 'Unexpected browser or HTTP errors');
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error.stack;
  console.error(String(error).split('\n').slice(0, 14).join('\n'));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await Promise.all(children.map(stop));
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(scratch, {recursive: true, force: true});
  console.log(JSON.stringify({ok: report.ok, pages: report.pages.length,
    interactions: report.interactions, optionalModelResponses: [...new Set(report.optionalModelResponses)],
    errors: report.errors, report: join(output, 'report.json')}, null, 2));
}
