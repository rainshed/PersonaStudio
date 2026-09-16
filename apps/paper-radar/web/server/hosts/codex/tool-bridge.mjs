import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BridgeError,
  readJson,
  sendJson,
} from '../transport.mjs';

export const CODEX_TOOL_PROTOCOL = 'paper-radar-codex-tools/v1';

export class CodexToolBridge {
  constructor(directory) {
    this.directory = directory;
    this.tasks = new Map();
    this.path = join(directory, `tools-${process.pid}.sock`);
  }

  async open() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      // Keep Unix socket paths below platform limits, even for a long data directory.
      this.socketDirectory = await mkdtemp(join(tmpdir(), 'pr-host-'));
      await chmod(this.socketDirectory, 0o700);
      this.path = join(this.socketDirectory, 'callback.sock');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await unlink(this.path).catch(() => {});
      const server = (this.server = createServer(async (req, res) => {
        try {
          if (
            req.method !== 'POST' ||
            req.url !== '/tool' ||
            req.headers['x-paper-radar-protocol'] !== CODEX_TOOL_PROTOCOL
          )
            throw new BridgeError(
              'protocol_error',
              'Codex 工具回调协议不兼容。',
              false,
              403,
            );
          const input = await readJson(req);
          const task = this.tasks.get(input.id);
          if (!task || task.token !== input.token)
            throw new BridgeError(
              'not_found',
              'Codex 工具任务已经关闭。',
              false,
              404,
            );
          task.signal.throwIfAborted();
          if (!task.tools.has(input.name))
            throw new BridgeError('invalid_tool', '本任务未开放此工具。');
          if (input.name === task.submitTool) {
            task.submissions++;
            if (task.maxAttempts != null && task.submissions > task.maxAttempts)
              throw new BridgeError(
                'budget_exceeded',
                '结果校验重试次数已达到上限。',
                true,
              );
          }
          const value = await task.onTool(input.name, input.arguments ?? {});
          task.signal.throwIfAborted();
          if (input.name === task.submitTool) task.submitted = input.arguments;
          sendJson(res, 200, { value: value ?? { ok: true } });
        } catch (error) {
          sendJson(res, error.httpStatus ?? 400, {
            code: error.code ?? 'tool_error',
            message: error.message ?? '工具调用未完成。',
            retryable: !!error.retryable,
          });
        }
      }));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.path, resolve);
      });
      await chmod(this.path, 0o600);
    })();
    return this.opening;
  }

  async register(request, options, signal) {
    await this.open();
    const id = randomUUID();
    const token = randomUUID();
    const file = join(this.directory, `task-${id}.json`);
    const task = {
      id,
      token,
      signal,
      tools: new Set(request.tools.map((tool) => tool.name)),
      submitTool: request.submitTool,
      maxAttempts: request.maxAttempts,
      submissions: 0,
      submitted: null,
      onTool: options.onTool,
    };
    this.tasks.set(id, task);
    await writeFile(
      file,
      `${JSON.stringify({
        protocol: CODEX_TOOL_PROTOCOL,
        id,
        token,
        socketPath: this.path,
        tools: request.tools,
      })}\n`,
      { mode: 0o600 },
    );
    return {
      id,
      file,
      task,
      close: async () => {
        this.tasks.delete(id);
        await unlink(file).catch(() => {});
      },
    };
  }

  async close() {
    await this.opening?.catch(() => {});
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    await unlink(this.path).catch(() => {});
    await rm(this.socketDirectory, { recursive: true, force: true });
  }
}
