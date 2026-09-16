import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../server/hosts/transport.mjs';

// An in-memory host double: no provider SDK, credentials or network connection.
export function testHost({ modelId = 'fixture-model', generate, agent } = {}) {
  const settings = {
    dsh: { protocol: 'paper-radar-harness/v1' },
    defaultConnectionId: 'test-model',
    overrides: {},
    fallback: { enabled: false, connectionId: null },
    connections: [
      {
        id: 'test-model',
        name: 'Test host',
        revision: 'r1',
        modelId,
        providerId: 'fixture-host',
        contextWindow: 500000,
        maxTokens: 8192,
      },
    ],
  };
  const host = {
    mode: 'dsh',
    supportsAgents: true,
    managesConcurrency: true,
    concurrency: 4,
    running: 0,
    store: { state: { settings } },
    config: () => ({ mode: 'dsh', settings, connected: true }),
    async close() {},
    async run(request, options = {}) {
      const frozen = options.settings ?? settings;
      const id =
        request.connectionId ??
        frozen.overrides[request.task] ??
        frozen.defaultConnectionId;
      const c = frozen.connections.find((c) => c.id === id);
      if (!c)
        throw new BridgeError('not_configured', 'Test host model is missing');
      const current = settings.connections.find((v) => v.id === c.id);
      if (!current || current.revision !== c.revision)
        throw new BridgeError('connection_changed', 'Host model changed');
      const attempt = {
        id: randomUUID(),
        started_at: new Date().toISOString(),
      };
      options.signal?.throwIfAborted();
      await options.beforeAttempt?.(c, attempt);
      try {
        const result = (await generate?.(c, request, options)) ?? {
          text: '{"issues":[]}',
        };
        options.signal?.throwIfAborted();
        options.onAttempt?.({
          ...attempt,
          status: 'succeeded',
          usage: { input: 10, output: 20 },
        });
        return {
          ...result,
          providerId: c.providerId,
          modelId: c.modelId,
          requestId: randomUUID(),
        };
      } catch (error) {
        options.onAttempt?.({
          ...attempt,
          status: 'failed',
          error: { code: error.code, message: error.message },
        });
        throw error;
      }
    },
    async runAgent(request, options) {
      const c = (options.settings ?? settings).connections[0];
      const attempt = {
        id: randomUUID(),
        started_at: new Date().toISOString(),
      };
      options.signal?.throwIfAborted();
      await options.beforeAttempt?.(c, attempt);
      try {
        const data = await agent({
          request,
          options,
          task: JSON.parse(request.prompt),
          c,
        });
        options.signal?.throwIfAborted();
        options.onAttempt?.({
          ...attempt,
          status: 'succeeded',
          usage: { input: 10, output: 20 },
        });
        return {
          data,
          text: JSON.stringify(data),
          providerId: c.providerId,
          modelId: c.modelId,
          requestId: randomUUID(),
        };
      } catch (error) {
        options.onAttempt?.({
          ...attempt,
          status: 'failed',
          error: { code: error.code, message: error.message },
        });
        throw error;
      }
    },
  };
  return host;
}
