import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ModelStore } from './store.mjs';
import { ModelService } from './service.mjs';
import { ModelError, normalizeError } from './engine.mjs';

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1200000) throw new ModelError('invalid_request', '请求过大');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new ModelError('invalid_request', '请求格式无效'); }
}
export function createModelServer(service, token) {
  const controllers = new Map();
  return createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    const hosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!hosts.includes(req.headers.host) || req.headers.origin ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return json(res, 403, { code: 'forbidden', error: '模型服务仅允许本机应用访问' });
    }
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      let result;
      if (req.method === 'GET' && path === '/health') result = { ok: true, pid: process.pid };
      else if (req.method === 'GET' && path === '/config') result = service.config();
      else if (req.method === 'GET' && /^\/progress\/[a-zA-Z0-9-]{1,80}$/.test(path)) {
        const run = service.activeRuns.get(path.split('/').at(-1));
        result = run ? { ...run, elapsedMs: Date.now() - Date.parse(run.startedAt) } : {};
      }
      else if (req.method === 'GET' && path === '/auth/active')
        result = { session: service.activeLogin() };
      else if (req.method === 'GET' && /^\/auth\/[a-zA-Z0-9-]+$/.test(path))
        result = service.loginState(path.split('/').at(-1));
      else if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new ModelError('invalid_request', '需要 JSON 请求');
        const input = await readBody(req);
        switch (path) {
          case '/connections': result = await service.saveConnection(input); break;
          case '/remove': result = await service.remove(input.id); break;
          case '/disconnect': result = await service.disconnect(input.id); break;
          case '/routing': result = await service.routing(input); break;
          case '/test': result = await service.run({ connectionId: input.id, modelId: input.modelId, reasoning: input.reasoning }); break;
          case '/generate': {
            const runId = input.runId;
            if (runId != null && (typeof runId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)))
              throw new ModelError('invalid_request', '请求标识无效');
            if (runId && controllers.has(runId)) throw new ModelError('busy', '请求正在运行');
            const controller = new AbortController();
            if (runId) controllers.set(runId, controller);
            try { result = await service.run({ ...input, signal: controller.signal }); }
            finally { if (runId) controllers.delete(runId); }
            break;
          }
          case '/cancel': controllers.get(input.runId)?.abort(); result = { ok: true }; break;
          case '/auth/start': result = service.startLogin(input.id); break;
          case '/auth/answer': result = service.answerLogin(input.id, input); break;
          case '/auth/cancel': result = service.cancelLogin(input.id); break;
          default: throw new ModelError('not_found', '接口不存在');
        }
      } else throw new ModelError('not_found', '接口不存在');
      json(res, 200, result);
    } catch (error) {
      const safe = normalizeError(error);
      json(res, safe.code === 'not_found' ? 404 : 400,
        { code: safe.code, error: safe.message, retryable: safe.retryable,
          model_run: safe.modelRun });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.AI_PERSONA_MODEL_DATA_DIR ||
    join(homedir(), '.local', 'share', 'ai-persona', 'models');
  const store = await new ModelStore(directory).open();
  const service = new ModelService(store);
  const token = randomBytes(32).toString('hex');
  const server = createModelServer(service, token);
  const descriptor = join(directory, 'runtime.json');
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    server.close();
    await service.close();
    await unlink(descriptor).catch(() => {});
    await store.close();
    process.exit(0);
  }
  server.on('error', close);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  server.listen(0, '127.0.0.1', async () => {
    const data = { pid: process.pid, port: server.address().port, token, version: 1 };
    await writeFile(descriptor + '.tmp', JSON.stringify(data), { mode: 0o600 });
    await rename(descriptor + '.tmp', descriptor);
  });
}
