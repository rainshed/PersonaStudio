import { createManagement } from './runtime/http.mjs';
import { Onboarding } from './runtime/onboarding.mjs';
import { runtimePaths } from './runtime/paths.mjs';
import { evaluationRoute } from './evaluations/http.mjs';
import appPackage from '../package.json' with { type: 'json' };
import { NotificationService } from './notifications/service.mjs';
import { PromptAPI } from './prompts/http.mjs';
import { promptSettingsRoute } from './prompts/settings.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RadarDatabase } from './storage/database.mjs';
import { AnalysisService } from './analyses/service.mjs';
import { ArxivReader } from './analyses/arxiv.mjs';
import { PersonaClient } from './persona/service.mjs';
import { configurePersonaSettings } from './persona/settings.mjs';
import { analysisRoute } from './analyses/http.mjs';
import { safeError } from './analyses/contracts.mjs';
import { DailyService } from './daily/service.mjs';
import { dailyRoute } from './daily/http.mjs';
import { DailyScheduler } from './daily/scheduler/service.mjs';
import { schedulerRoute } from './daily/scheduler/http.mjs';
import { parsePublicOrigin } from './public-origin.mjs';
import { DshModelService } from './hosts/dsh/models.mjs';
import { DshOperations } from './integrations/dsh/operations.mjs';
import { CodexModelService } from './hosts/codex/models.mjs';
import { HostModelService } from './hosts/service.mjs';
import { defaultSocket, BridgeError } from './hosts/transport.mjs';

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (
      Buffer.byteLength(text) >
      (req.url.startsWith('/api/evaluations/v1/imports')
        ? 50000000
        : /^\/api\/(prompts\/v1|prompt-settings)(?:\/|$)/.test(req.url)
          ? 1500000
          : 400000)
    )
      throw new BridgeError('invalid_request', '请求过大');
  }
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new BridgeError('invalid_request', '请求格式无效');
  }
}
export function createModelServer(
  service,
  { publicDirectory, analyses, daily, publicOrigin },
) {
  const external = parsePublicOrigin(publicOrigin);
  const notifications = analyses ? new NotificationService(analyses.db) : null;
  const promptAPI = analyses
    ? new PromptAPI(analyses.prompts, service, analyses)
    : null;
  const personaSettings = configurePersonaSettings(
    analyses,
    daily,
    undefined,
    promptAPI,
  );
  const dsh =
    analyses && daily
      ? new DshOperations({
          analyses,
          daily,
          models: service,
          publicOrigin: external?.origin,
        })
      : null;
  const management =
    analyses && daily
      ? createManagement(
          analyses,
          daily,
          personaSettings,
          service,
          appPackage.version,
        )
      : null;
  const instanceId = process.env.PAPER_RADAR_INSTANCE_ID || randomUUID();
  const onboarding =
    analyses && daily ? new Onboarding(analyses.db, personaSettings) : null;
  const handle = async (req, res) => {
    const port = req.socket.localPort;
    const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const localHost = localHosts.includes(req.headers.host);
    if (!localHost && (!external || req.headers.host !== external.host))
      return json(res, 403, { error: '仅允许本机或已配置的远程入口访问' });
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return json(res, 400, { error: '请求地址无效' });
    }
    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      // Serve may retain the public Host or rewrite it to the loopback target.
      // Only explicit configuration is trusted, never X-Forwarded-* headers.
      const allowedOrigins = [
        ...(localHost ? [`http://${req.headers.host}`] : []),
        ...(external ? [external.origin] : []),
      ];
      if (
        (origin && !allowedOrigins.includes(origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.method !== 'GET' &&
          (req.headers['x-paper-radar'] !== '1' ||
            !req.headers['content-type']?.startsWith('application/json')))
      )
        return json(res, 403, { error: '请求来源无效' });
      if (
        management &&
        (await management(req, url, body, res, json, localHost))
      )
        return;
      if (
        onboarding &&
        req.method === 'GET' &&
        url.pathname === '/api/onboarding'
      )
        return json(res, 200, onboarding.status());
      if (
        analyses?.taskRuntime &&
        req.method === 'GET' &&
        url.pathname === '/api/tasks'
      )
        return json(res, 200, {
          schema: 'paper-radar.task-runtime/v1',
          ...analyses.taskRuntime.snapshot(),
        });
      if (
        daily?.evaluations &&
        /^\/api\/evaluations\/v1(?:\/|$)/.test(url.pathname)
      ) {
        try {
          const result = await evaluationRoute(
            daily.evaluations,
            req,
            url,
            body,
          );
          return json(res, 200, result);
        } catch (e) {
          const error = safeError(e);
          return json(res, e.httpStatus ?? 400, {
            ...error,
            error: error.message,
          });
        }
      }
      if (notifications && /^\/api\/notifications(?:\/|$)/.test(url.pathname)) {
        try {
          if (req.method === 'GET' && url.pathname === '/api/notifications')
            return json(
              res,
              200,
              notifications.list(Object.fromEntries(url.searchParams)),
            );
          if (
            req.method === 'POST' &&
            url.pathname === '/api/notifications/read'
          )
            return json(res, 200, notifications.read(await body(req)));
          if (
            req.method === 'POST' &&
            url.pathname === '/api/notifications/claim'
          )
            return json(res, 200, notifications.claim(await body(req)));
          return json(res, 404, { code: 'not_found', error: '接口不存在' });
        } catch (e) {
          const error = safeError(e);
          return json(res, e.httpStatus ?? 400, {
            ...error,
            error: error.message,
          });
        }
      }
      if (
        dsh &&
        ['/api/dsh/operations', '/api/harness/operations'].includes(
          url.pathname,
        ) &&
        req.method === 'POST'
      ) {
        if (
          !localHost ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
            req.socket.remoteAddress,
          )
        )
          return json(res, 403, { error: '宿主操作接口仅限本机。' });
        try {
          return json(res, 200, await dsh.dispatch(await body(req)));
        } catch (e) {
          const error = safeError(e);
          return json(res, e.httpStatus ?? 400, {
            ...error,
            error: error.message,
          });
        }
      }
      if (analyses && /^\/api\/prompt-settings(?:\/|$)/.test(url.pathname)) {
        try {
          return json(
            res,
            200,
            promptSettingsRoute(
              analyses.prompts,
              req.method,
              decodeURIComponent(
                url.pathname.slice('/api/prompt-settings'.length),
              ),
              req.method === 'POST'
                ? await body(req)
                : { after: Number(url.searchParams.get('after') ?? 0) },
              { settings: service.store?.state?.settings },
            ),
          );
        } catch (e) {
          return json(res, e.status ?? 400, {
            code: e.code ?? 'invalid_request',
            message: e.message ?? '请求未完成。',
          });
        }
      }
      if (promptAPI && /^\/api\/prompts\/v1(?:\/|$)/.test(url.pathname)) {
        if (
          !localHost ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
            req.socket.remoteAddress,
          )
        )
          return json(res, 403, { message: '提示词工作台仅支持本机访问。' });
        try {
          const result = await promptAPI.dispatch(
            req.method,
            decodeURIComponent(url.pathname.slice('/api/prompts/v1'.length)),
            req.method === 'POST' ? await body(req) : {},
            Object.fromEntries(url.searchParams),
          );
          return json(res, 200, result);
        } catch (e) {
          return json(res, e.status ?? 400, {
            code: e.code ?? 'invalid_request',
            message: e.message ?? '请求未完成。',
          });
        }
      }
      if (
        daily?.scheduler &&
        /^\/api\/(subscriptions\/[^/]+\/schedule(?:\/|$)|schedule-checks(?:\/|$)|schedule-updates(?:\/|$))/.test(
          url.pathname,
        )
      ) {
        try {
          const result = await schedulerRoute(daily.scheduler, req, url, body);
          return json(res, result.status, result.body);
        } catch (e) {
          const error = safeError(e);
          return json(res, e.httpStatus ?? 400, {
            ...error,
            error: error.message,
          });
        }
      }
      if (
        daily &&
        /^\/api\/(arxiv|subscriptions|daily-runs|daily-reports|daily-items|daily-item-versions)(?:\/|$)/.test(
          url.pathname,
        )
      ) {
        try {
          const result = await dailyRoute(daily, req, url, body);
          return json(res, result.status, result.body);
        } catch (e) {
          const error = safeError(e);
          return json(res, e.httpStatus ?? 400, {
            ...error,
            error: error.message,
          });
        }
      }
      if (
        analyses &&
        (url.pathname === '/api/capabilities' ||
          /^\/api\/(persona|jobs|analyses)(?:\/|$)/.test(url.pathname))
      ) {
        try {
          const controller = new AbortController();
          const disconnect = () => controller.abort();
          res.once('close', disconnect);
          let result;
          try {
            result = await analysisRoute(
              analyses,
              req,
              url,
              body,
              controller.signal,
            );
          } finally {
            res.off('close', disconnect);
          }
          if (url.pathname === '/api/capabilities')
            Object.assign(result.body, {
              app_version: appPackage.version,
              service: 'paper-radar',
              instance_id: instanceId,
              task_runtime: !!analyses.taskRuntime,
              feedback_evaluations: !!daily?.evaluations,
              dsh_plugin: !!dsh,
              model_backend: service.mode ?? 'unavailable',
              model_backends: service.isHostRouter
                ? ['dsh', 'codex']
                : [service.mode ?? 'unavailable'],
              daily_recommendation: !!daily,
              daily_scheduler: !!daily?.scheduler,
              paper_discussion: false,
              on_demand_analysis: !!daily,
            });
          return json(res, result.status, result.body);
        } catch (e) {
          const error = safeError(e);
          return json(
            res,
            e.httpStatus ?? (error.code === 'not_found' ? 404 : 400),
            { ...error, error: error.message },
          );
        }
      }
      try {
        let result;
        if (req.method === 'GET' && url.pathname === '/api/models/config')
          result = await service.config();
        else if (
          req.method === 'GET' &&
          /^\/api\/models\/backends\/(dsh|codex)\/config$/.test(url.pathname)
        )
          result = await service.backendConfig(url.pathname.split('/').at(-2));
        else if (req.method === 'POST') {
          const input = await body(req);
          const backendRoute = url.pathname.match(
            /^\/api\/models\/backends\/(dsh|codex)\/routing$/,
          );
          if (backendRoute)
            result = await service.routing(input, backendRoute[1]);
          else if (url.pathname === '/api/models/routing')
            result = await service.routing(input);
          else if (url.pathname === '/api/models/backend')
            result = await service.selectBackend(input);
          else if (url.pathname === '/api/models/backends/codex/login')
            result = await service.startCodexLogin();
          else if (url.pathname === '/api/models/backends/codex/logout')
            result = await service.logoutCodex();
          else
            return json(res, 404, { code: 'not_found', error: '接口不存在' });
        } else return json(res, 404, { error: '接口不存在' });
        return json(res, 200, result);
      } catch (e) {
        const error = e instanceof BridgeError ? e : safeError(e);
        return json(
          res,
          e instanceof BridgeError
            ? e.httpStatus
            : error.code === 'not_found'
              ? 404
              : 400,
          {
            error: error.message,
            code: error.code,
            retryable: error.retryable,
          },
        );
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(res, 405, { error: '不支持的方法' });
    try {
      const path = resolve(
        publicDirectory,
        '.' +
          decodeURIComponent(
            url.pathname === '/' ? '/index.html' : url.pathname,
          ),
      );
      if (!path.startsWith(resolve(publicDirectory) + sep))
        return json(res, 403, { error: '路径无效' });
      const data = await readFile(path);
      const mime =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
          '.rsc': 'text/x-component',
        }[extname(path)] ?? 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      json(res, 404, { error: '页面未生成，请先构建前端' });
    }
  };
  const server = createServer((req, res) => {
    Promise.resolve(
      service.withRequest
        ? service.withRequest(req, () => handle(req, res))
        : handle(req, res),
    ).catch((e) => {
      const error = safeError(e);
      json(res, e.httpStatus ?? 503, { ...error, error: error.message });
    });
  });
  server.promptAPI = promptAPI;
  server.instanceId = instanceId;
  server.on('close', () => {
    void personaSettings?.close();
    void promptAPI?.close();
    void daily?.evaluations?.close();
  });
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const paths = runtimePaths();
  const port = Number(process.env.PAPER_RADAR_PORT ?? 4317);
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535)
    throw new Error('PAPER_RADAR_PORT 无效');
  const publicOrigin = parsePublicOrigin(
    process.env.PAPER_RADAR_PUBLIC_ORIGIN,
  )?.origin;
  const directory = paths.models;
  let activation = {};
  try {
    activation = JSON.parse(
      await readFile(
        existsSync(resolve(paths.home, 'dsh.json'))
          ? resolve(paths.home, 'dsh.json')
          : resolve(paths.home, 'harness.json'),
        'utf8',
      ),
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const requestedBackend =
    process.env.PAPER_RADAR_MODEL_BACKEND === 'harness'
      ? 'dsh'
      : process.env.PAPER_RADAR_MODEL_BACKEND;
  if (requestedBackend && !['dsh', 'codex'].includes(requestedBackend))
    throw new Error('PAPER_RADAR_MODEL_BACKEND 只支持 dsh 或 codex');
  const service = await new HostModelService({
    directory: resolve(directory, '../hosts'),
    defaultBackend:
      requestedBackend ?? (activation.enabled === true ? 'dsh' : 'codex'),
    dsh: new DshModelService({
      socketPath:
        process.env.PAPER_RADAR_DSH_SOCKET ??
        process.env.PAPER_RADAR_HARNESS_SOCKET ??
        activation.socketPath ??
        (process.env.PAPER_RADAR_HOME
          ? resolve(paths.home, 'harness.sock')
          : defaultSocket()),
      directory:
        existsSync(resolve(directory, '../dsh/routes.json')) ||
        !existsSync(resolve(directory, '../harness/routes.json'))
          ? resolve(directory, '../dsh')
          : resolve(directory, '../harness'),
    }),
    codex: new CodexModelService({
      directory: resolve(directory, '../codex'),
    }),
  }).open();
  const storage = paths.data;
  const analysisDb = await new RadarDatabase(storage).open();
  const persona = new PersonaClient(paths.personaConfig);
  const analyses = new AnalysisService(
    analysisDb,
    service,
    new ArxivReader(resolve(storage, 'cache/papers')),
    persona,
  );
  const daily = new DailyService(analyses);
  const scheduler = new DailyScheduler(daily);
  const server = createModelServer(service, {
    analyses,
    daily,
    publicDirectory: paths.publicDirectory,
    publicOrigin,
    port,
  });
  let retriedPort = false;
  server.on('error', async (error) => {
    if (
      error.code === 'EADDRINUSE' &&
      process.env.PAPER_RADAR_ALLOW_PORT_FALLBACK === '1' &&
      !retriedPort
    ) {
      retriedPort = true;
      server.listen(0, '127.0.0.1');
      return;
    }
    await scheduler.close();
    await server.promptAPI?.close();
    await daily.close();
    await analyses.close();
    await analysisDb.close();
    await service.close();
    console.error('模型服务启动失败，请检查端口是否被占用');
    process.exit(1);
  });
  const runtimeFile = resolve(paths.runtime, 'server.json');
  server.on('listening', () => {
    const actualPort = server.address().port;
    const url = `http://127.0.0.1:${actualPort}/`;
    mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
    const temporary = runtimeFile + '.' + server.instanceId + '.tmp';
    writeFileSync(
      temporary,
      JSON.stringify({
        pid: process.pid,
        port: actualPort,
        url,
        instance_id: server.instanceId,
        started_at: new Date().toISOString(),
        app_root: fileURLToPath(new URL('../../', import.meta.url)),
      }) + '\n',
      { mode: 0o600 },
    );
    renameSync(temporary, runtimeFile);
    console.log(`Paper Radar · ${url}`);
    analyses.start();
    daily.start();
    scheduler.start();
  });
  server.listen(port, '127.0.0.1');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await scheduler.close();
    await server.promptAPI?.close();
    await daily.close();
    await analyses.close();
    await analysisDb.close();
    await service.close();
    try {
      if (
        JSON.parse(readFileSync(runtimeFile, 'utf8')).instance_id ===
        server.instanceId
      )
        rmSync(runtimeFile);
    } catch {
      /* Already removed. */
    }
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
