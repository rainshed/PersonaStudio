import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeRequest } from '../src/transport.mjs';
import { emptyRoutes } from '../src/routing.mjs';

const runtime = process.argv[2];
if (!runtime) throw new Error('需要当前 DSH 的 node_modules 目录。');
const directory = await mkdtemp(join(tmpdir(), 'radar-runtime-'));
const socket = join(directory, 'bridge.sock'), overlay = join(directory, 'overlay.yml');
await writeFile(overlay, `- id: paper-radar\n  config:\n    socketPath: ${socket}\n    paperRadarUrl: http://127.0.0.1:4317\n`);
const child = spawn(process.execPath, [join(runtime, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', overlay, '--no-open', '--port', '0']);
let logs = '', exited = false;
const collect = (chunk) => { logs = (logs + String(chunk).replace(/https?:\/\/[^\s]+/g, '[URL redacted]').replace(/(token|key|secret)=\S+/gi, '$1=[redacted]')).slice(-15000); };
child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('exit', () => { exited = true; });
try {
  let ready = false;
  for (let i = 0; i < 40 && !exited; i++) {
    try { await bridgeRequest(socket, '/status', {}, { timeout: 1000 }); ready = true; break; } catch { await delay(500); }
  }
  if (!ready) throw new Error(`真实 DSH 插件加载失败：\n${logs}`);
  const catalog = await bridgeRequest(socket, '/catalog', {}, { timeout: 30000 });
  const snapshot = await bridgeRequest(socket, '/snapshot', { routes: emptyRoutes() });
  console.log(JSON.stringify({ loaded: true, model: catalog.defaults, providers: catalog.groups.map((g) => ({ id: g.id, models: g.models.length })), resolved: snapshot.selections.summary }, null, 2));
  if (process.argv.includes('--model-call')) {
    const selection = snapshot.selections.summary;
    const result = await bridgeRequest(socket, '/generate', { id: `verify-${Date.now()}`, selection, systemPrompt: 'This is a connectivity check. Answer concisely.', prompt: 'Reply with exactly OK.', maxTokens: 2048, businessTask: 'plugin-installation-check' }, { timeout: 180000 });
    console.log(JSON.stringify({ actualModelCall: true, text: result.text, provider: result.providerId, model: result.modelId, reasoningEffort: result.reasoningEffort, usage: result.usage }, null, 2));
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && !exited; i++) await delay(100);
  if (!exited) child.kill('SIGKILL');
  await rm(directory, { recursive: true, force: true });
}
