import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CodexModelService } from '../server/hosts/codex/models.mjs';
import { CodexToolBridge } from '../server/hosts/codex/tool-bridge.mjs';
import { HostModelService } from '../server/hosts/service.mjs';

const toolServer = fileURLToPath(
  new URL('../server/hosts/codex/tool-server.mjs', import.meta.url),
);

function callback(context, name, args) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      id: context.id,
      token: context.token,
      name,
      arguments: args,
    });
    const req = httpRequest(
      {
        socketPath: context.socketPath,
        path: '/tool',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'x-paper-radar-protocol': context.protocol,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) reject(new Error(value.message));
          else resolve(value.value);
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

class FakeAppServer {
  constructor() {
    this.listeners = new Set();
    this.context = null;
    this.closed = false;
    this.skills = [
      {
        name: 'unrelated-skill',
        path: '/test/unrelated/SKILL.md',
        enabled: true,
      },
    ];
  }
  async open() {
    return this;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(method, params) {
    for (const listener of this.listeners) listener({ method, params });
  }
  async request(method, params) {
    if (method === 'config/read')
      return {
        config: {
          web_search: 'disabled',
          features: {
            hooks: false,
            apps: false,
            auth_elicitation: false,
            goals: false,
            memories: false,
            multi_agent: false,
            remote_plugin: false,
            shell_tool: false,
            unified_exec: false,
            skill_mcp_dependency_install: false,
            tool_suggest: false,
          },
          agents: { enabled: false },
          tools: { view_image: false },
        },
      };
    if (method === 'hooks/list') return { data: [{ hooks: [] }] };
    if (method === 'skills/list')
      return { data: [{ cwd: '/test', skills: this.skills, errors: [] }] };
    if (method === 'skills/config/write') {
      const skill = this.skills.find((item) => item.path === params.path);
      if (skill) skill.enabled = params.enabled;
      return {};
    }
    if (method === 'mcpServerStatus/list') {
      if (!params?.threadId) return { data: [], nextCursor: null };
      return {
        data: [
          {
            name: 'paper-radar',
            tools: Object.fromEntries(
              this.context.tools.map((tool) => [tool.name, {}]),
            ),
          },
          { name: 'ai-persona', tools: {} },
        ],
        nextCursor: null,
      };
    }
    if (method === 'account/read')
      return {
        account: {
          type: 'chatgpt',
          email: 'reader@example.test',
          planType: 'plus',
        },
        requiresOpenaiAuth: true,
      };
    if (method === 'account/rateLimits/read')
      return { rateLimits: { primary: { usedPercent: 5 } } };
    if (method === 'model/list')
      return {
        data: [
          {
            id: 'gpt-test',
            model: 'gpt-test',
            displayName: 'GPT Test',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: '' },
              { reasoningEffort: 'medium', description: '' },
              { reasoningEffort: 'high', description: '' },
            ],
          },
        ],
        nextCursor: null,
      };
    if (method === 'thread/start') {
      const path = params.config.mcp_servers['paper-radar'].args[1];
      this.context = JSON.parse(await readFile(path, 'utf8'));
      return { thread: { id: 'thread-test' } };
    }
    if (method === 'turn/start') {
      setTimeout(async () => {
        await callback(this.context, 'finish', { answer: 'accepted' });
        this.emit('thread/tokenUsage/updated', {
          threadId: 'thread-test',
          turnId: 'turn-test',
          tokenUsage: {
            last: { inputTokens: 10, outputTokens: 4 },
          },
        });
        this.emit('item/agentMessage/delta', {
          threadId: 'thread-test',
          turnId: 'turn-test',
          delta: '{"status":"submitted"}',
        });
        this.emit('turn/completed', {
          threadId: 'thread-test',
          turn: { id: 'turn-test', status: 'completed', error: null },
        });
      }, 5);
      return { turn: { id: 'turn-test', status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') return {};
    if (method === 'account/login/start')
      return {
        type: 'chatgpt',
        loginId: 'login-test',
        authUrl: 'https://example.test/login',
      };
    if (method === 'account/logout') return {};
    throw new Error(`Unexpected RPC: ${method}`);
  }
  async close() {
    this.closed = true;
  }
}

class UnsafeAppServer extends FakeAppServer {
  async request(method, params) {
    if (method === 'mcpServerStatus/list' && !params?.threadId)
      return {
        data: [{ name: 'ai-persona', tools: { persona_search: {} } }],
        nextCursor: null,
      };
    return super.request(method, params);
  }
}

class ExitingAppServer extends FakeAppServer {
  async request(method, params) {
    if (method === 'turn/start') {
      setTimeout(() => {
        const error = Object.assign(new Error('App Server exited'), {
          code: 'codex_unavailable',
        });
        for (const listener of this.listeners)
          listener({ method: '$paperRadar/appServerExited', error });
      }, 5);
      return { turn: { id: 'turn-test', status: 'inProgress' } };
    }
    return super.request(method, params);
  }
}

class UninterruptibleAppServer extends FakeAppServer {
  constructor() {
    super();
    this.terminations = 0;
  }
  async request(method, params) {
    if (method === 'turn/start')
      return { turn: { id: 'turn-test', status: 'inProgress' } };
    if (method === 'turn/interrupt') throw new Error('interrupt unavailable');
    return super.request(method, params);
  }
  async terminate() {
    this.terminations++;
  }
}

void test('a completed Codex turn with no submission does not interrupt or terminate parallel tasks', { timeout: 5000 }, async (t) => {
  let bothStarted;
  const ready = new Promise((resolve) => { bothStarted = resolve; });
  class ParallelAppServer extends UninterruptibleAppServer {
    constructor() {
      super();
      this.contexts = new Map();
      this.started = [];
      this.interrupts = 0;
    }
    async request(method, params) {
      if (method === 'thread/start') {
        await super.request(method, params);
        const id = 'thread-' + this.contexts.size;
        this.contexts.set(id, this.context);
        return { thread: { id } };
      }
      if (method === 'turn/start') {
        this.started.push(params.threadId);
        if (this.started.length === 2) bothStarted();
        return { turn: { id: 'turn-' + params.threadId, status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') this.interrupts++;
      return super.request(method, params);
    }
    async terminate() {
      await super.terminate();
      const error = Object.assign(new Error('Shared App Server stopped'), { code: 'codex_unavailable' });
      for (const listener of this.listeners)
        listener({ method: '$paperRadar/appServerExited', error });
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-parallel-failure-'));
  const client = new ParallelAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  await service.routing({ ...structuredClone(service.routes), concurrency: 2 });
  const request = {
    task: 'screen', prompt: 'Submit a result.',
    tools: [{ name: 'finish', description: 'Finish.', parameters: { type: 'object' } }],
    submitTool: 'finish',
  };
  const attempts = [];
  const outcomes = [0, 1].map(() => service.runAgent(request, {
    settings: service.store.state.settings,
    onTool: async () => ({ accepted: true }),
    onAttempt: (attempt) => attempts.push(attempt),
  }).then((value) => ({ value }), (error) => ({ error })));
  await ready;
  const [failedThread, healthyThread] = client.started;
  client.emit('turn/completed', {
    threadId: failedThread,
    turn: { id: 'turn-' + failedThread, status: 'completed', error: null },
  });
  const first = await Promise.race(outcomes);
  assert.equal(first.error?.code, 'invalid_output');
  assert.equal(client.interrupts, 0);
  assert.equal(client.terminations, 0);
  await callback(client.contexts.get(healthyThread), 'finish', { answer: 'accepted' });
  client.emit('turn/completed', {
    threadId: healthyThread,
    turn: { id: 'turn-' + healthyThread, status: 'completed', error: null },
  });
  const results = await Promise.all(outcomes);
  assert.deepEqual(results.find((result) => result.value)?.value.data, { answer: 'accepted' });
  assert.deepEqual(attempts.map((attempt) => attempt.status).sort((a, b) => a.localeCompare(b)), ['invalid_output', 'succeeded']);
  assert.equal(service.bridge.tasks.size, 0);
});

void test('a terminal failed Codex turn retains its original error without interrupting it', async (t) => {
  class FailedTurnAppServer extends UninterruptibleAppServer {
    async request(method, params) {
      if (method === 'turn/start') {
        setTimeout(() => this.emit('turn/completed', {
          threadId: 'thread-test',
          turn: { id: 'turn-test', status: 'failed', error: { message: 'Context is too large', codexErrorInfo: 'ContextWindowExceeded' } },
        }), 5);
      }
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-failed-terminal-'));
  const client = new FailedTurnAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  await assert.rejects(service.runAgent({
    task: 'screen', tools: [{ name: 'finish', description: 'Finish.', parameters: { type: 'object' } }], submitTool: 'finish',
  }, { settings: service.store.state.settings, onTool: async () => ({ accepted: true }) }), { code: 'context_length' });
  assert.equal(client.terminations, 0);
});

void test('foreign completion events during Codex thread setup cannot complete the new task', async (t) => {
  class SetupEventAppServer extends FakeAppServer {
    async request(method, params) {
      const response = await super.request(method, params);
      if (method === 'thread/start') this.emit('turn/completed', {
        threadId: 'unrelated-thread', turn: { id: 'unrelated-turn', status: 'completed', error: null },
      });
      return response;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-setup-event-'));
  const service = await new CodexModelService({ directory, client: new SetupEventAppServer() }).open();
  t.after(() => service.close());
  const result = await service.runAgent({
    task: 'screen', tools: [{ name: 'finish', description: 'Finish.', parameters: { type: 'object' } }], submitTool: 'finish',
  }, { settings: service.store.state.settings, onTool: async () => ({ accepted: true }) });
  assert.deepEqual(result.data, { answer: 'accepted' });
});

void test('a turn that finishes while cancellation is pending does not terminate the App Server', async (t) => {
  const controller = new AbortController();
  class FinishingAppServer extends UninterruptibleAppServer {
    async request(method, params) {
      if (method === 'turn/start') setTimeout(() => controller.abort(), 5);
      if (method === 'turn/interrupt') this.emit('turn/completed', {
        threadId: params.threadId,
        turn: { id: params.turnId, status: 'interrupted', error: null },
      });
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-cancel-terminal-'));
  const client = new FinishingAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  await assert.rejects(service.runAgent({
    task: 'screen', tools: [{ name: 'finish', description: 'Finish.', parameters: { type: 'object' } }], submitTool: 'finish',
  }, { settings: service.store.state.settings, signal: controller.signal, onTool: async () => ({ accepted: true }) }), { code: 'cancelled' });
  assert.equal(client.terminations, 0);
});

void test('Codex host freezes routes, passes only task MCP tools and returns validated submission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-test-'));
  const client = new FakeAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  const initial = await service.config();
  assert.equal(initial.connected, true);
  assert.equal(initial.isolation.ok, true);
  assert.equal(initial.isolation.persona_mcp_callable, false);
  assert.deepEqual(initial.isolation.skills_enabled, []);
  assert.equal(client.skills[0].enabled, false);

  const draft = structuredClone(service.routes);
  draft.concurrency = 2;
  draft.presets.fast = {
    model: { provider: 'codex', model: 'gpt-test' },
    reasoningEffort: 'low',
  };
  draft.presets.deep = {
    model: { provider: 'codex', model: 'gpt-test' },
    reasoningEffort: 'high',
  };
  const saved = await service.routing(draft);
  assert.equal(saved.routing.concurrency, 2);

  const calls = [];
  const attempts = [];
  const contextEvents = [];
  const output = await service.runAgent(
    {
      task: 'screen',
      prompt: 'Use the task tool and submit.',
      systemPrompt: 'Do the fixed task.',
      tools: [
        {
          name: 'finish',
          description: 'Submit the fixed result.',
          parameters: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      ],
      submitTool: 'finish',
      maxAttempts: 3,
      executionMs: 5000,
    },
    {
      settings: service.store.state.settings,
      onTool: async (name, args) => {
        calls.push({ name, args });
        return { accepted: true };
      },
      onAttempt: (attempt) => attempts.push(attempt),
      onContext: event => contextEvents.push(event),
    },
  );
  assert.deepEqual(output.data, { answer: 'accepted' });
  assert.equal(contextEvents[0].kind, 'host_input');
  assert.equal(contextEvents[0].content.messages.at(-1).text, 'Use the task tool and submit.');
  assert.deepEqual(contextEvents[0].content.tool_definitions.map(t => t.name), ['finish']);
  assert.deepEqual(calls, [{ name: 'finish', args: { answer: 'accepted' } }]);
  assert.equal(output.modelId, 'gpt-test');
  assert.deepEqual(output.usage, { input: 10, output: 4, cost: null });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].attempt_unit, 'agent-turn');
  assert.deepEqual(
    client.context.tools.map((tool) => tool.name),
    ['finish'],
  );
  const runtime = await readFile(
    join(directory, 'runtime-home/config.toml'),
    'utf8',
  );
  assert.match(runtime, /hooks = false/);
  assert.match(runtime, /shell_tool = false/);
  assert.match(runtime, /\[mcp_servers\.ai-persona\]/);
  assert.match(runtime, /enabled = false/);
});

void test('Codex can submit a task result with approvals disabled and a read-only sandbox', async (t) => {
  class ApprovalAwareAppServer extends FakeAppServer {
    async request(method, params) {
      if (method === 'thread/start') this.threadConfig = params;
      if (method === 'turn/start') {
        this.turnConfig = params;
        setTimeout(async () => {
          const permission = this.threadConfig.config.mcp_servers['paper-radar']
            .tools?.task_submit_result?.approval_mode;
          if (permission === 'approve') {
            await callback(this.context, 'task_submit_result', { answer: 'accepted' });
          } else {
            this.emit('item/completed', {
              threadId: 'thread-test',
              item: { type: 'mcpToolCall', server: 'paper-radar', tool: 'task_submit_result', status: 'failed',
                error: { message: 'MCP tool call requires approval, but approval policy is never' } },
            });
          }
          this.emit('turn/completed', { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } });
        }, 5);
        return { turn: { id: 'turn-test', status: 'inProgress' } };
      }
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-tool-grant-'));
  const client = new ApprovalAwareAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  let submissions = 0;
  const output = await service.runAgent({
    task: 'single', prompt: 'Submit the test result.', submitTool: 'task_submit_result',
    tools: [{ name: 'task_submit_result', description: 'Submit.', parameters: { type: 'object' } }],
  }, { settings: service.store.state.settings, onTool: async () => { submissions++; return { accepted: true }; } });
  assert.deepEqual(output.data, { answer: 'accepted' });
  assert.equal(submissions, 1);
  assert.equal(client.threadConfig.approvalPolicy, 'never');
  assert.equal(client.threadConfig.sandbox, 'read-only');
  assert.equal(client.turnConfig.approvalPolicy, 'never');
  assert.deepEqual(client.turnConfig.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  const servers = client.threadConfig.config.mcp_servers;
  assert.deepEqual(Object.keys(servers['paper-radar'].tools), ['task_submit_result']);
  assert.equal(servers['ai-persona'].enabled, false);
});

void test('Codex reports a rejected submission tool instead of hiding its cause behind missing output', async (t) => {
  const message = 'MCP tool call requires approval, but approval policy is never';
  class RejectedSubmissionAppServer extends FakeAppServer {
    async request(method, params) {
      if (method === 'turn/start') {
        setTimeout(() => {
          this.emit('item/completed', {
            threadId: 'thread-test',
            item: { type: 'mcpToolCall', server: 'paper-radar', tool: 'finish', status: 'failed', error: { message } },
          });
          this.emit('item/completed', { threadId: 'thread-test', item: { type: 'agentMessage', text: '{"status":"submitted"}' } });
          this.emit('turn/completed', { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } });
        }, 5);
        return { turn: { id: 'turn-test', status: 'inProgress' } };
      }
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-tool-failure-'));
  const service = await new CodexModelService({ directory, client: new RejectedSubmissionAppServer() }).open();
  t.after(() => service.close());
  const attempts = [];
  await assert.rejects(service.runAgent({
    task: 'single', prompt: 'Submit the result.', submitTool: 'finish',
    tools: [{ name: 'finish', description: 'Submit.', parameters: { type: 'object' } }],
  }, {
    settings: service.store.state.settings,
    onTool: () => assert.fail('The rejected tool must not reach business validation.'),
    onAttempt: (attempt) => attempts.push(attempt),
  }), (error) => error.code === 'invalid_output' && error.message.includes(message));
  assert.deepEqual(attempts[0].tool_error, { tool: 'finish', message });
  assert.equal(attempts[0].status, 'invalid_output');
  assert.equal(service.bridge.tasks.size, 0);
});

void test('Codex host fails closed when a foreign Persona MCP is callable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-unsafe-'));
  const service = await new CodexModelService({
    directory,
    client: new UnsafeAppServer(),
  }).open();
  t.after(() => service.close());
  const config = await service.config();
  assert.equal(config.connected, false);
  assert.equal(config.error.code, 'codex_isolation_failed');
  assert.throws(() => service.store.state.settings, {
    code: 'codex_isolation_failed',
  });
});

void test('an App Server exit terminates an unbounded Codex turn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-exit-'));
  const service = await new CodexModelService({
    directory,
    client: new ExitingAppServer(),
  }).open();
  t.after(() => service.close());
  await assert.rejects(
    service.runAgent(
      {
        task: 'single',
        prompt: 'Submit the task.',
        tools: [
          {
            name: 'finish',
            description: 'Finish.',
            parameters: { type: 'object', additionalProperties: false },
          },
        ],
        submitTool: 'finish',
        executionMs: null,
      },
      {
        settings: service.store.state.settings,
        onTool: async () => ({ accepted: true }),
      },
    ),
    { code: 'codex_unavailable' },
  );
});

void test('cancellation terminates the dedicated App Server when interrupt fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-cancel-'));
  const client = new UninterruptibleAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  const controller = new AbortController();
  const attempts = [];
  const run = service.runAgent(
    {
      task: 'single',
      prompt: 'Wait for cancellation.',
      tools: [
        {
          name: 'finish',
          description: 'Finish.',
          parameters: { type: 'object', additionalProperties: false },
        },
      ],
      submitTool: 'finish',
      executionMs: null,
    },
    {
      settings: service.store.state.settings,
      signal: controller.signal,
      onTool: async () => ({ accepted: true }),
      onAttempt: (attempt) => attempts.push(attempt),
    },
  );
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(run, { code: 'cancelled' });
  assert.equal(client.terminations, 1);
  assert.equal(attempts[0].status, 'cancelled');
});

void test('Paper Radar MCP exposes exactly the registered tools over stdio', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-tool-test-'));
  const bridge = new CodexToolBridge(directory);
  const registration = await bridge.register(
    {
      tools: [
        {
          name: 'paper_echo',
          description: 'Echo a fixed task value.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      submitTool: null,
      maxAttempts: 1,
    },
    { onTool: async (_name, args) => ({ echoed: args.value }) },
    new AbortController().signal,
  );
  const client = new Client(
    { name: 'paper-radar-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [toolServer, registration.file],
    stderr: 'pipe',
  });
  t.after(async () => {
    await client.close();
    await registration.close();
    await bridge.close();
  });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ['paper_echo'],
  );
  const result = await client.callTool({
    name: 'paper_echo',
    arguments: { value: 'fixed' },
  });
  assert.deepEqual(result.structuredContent, { echoed: 'fixed' });
});

function fakeHost(mode, connected = true) {
  const calls = [];
  const settings = { connections: [], [mode]: { protocol: 'test' } };
  return {
    mode,
    concurrency: mode === 'dsh' ? 3 : 5,
    running: 0,
    calls,
    store: { state: { settings } },
    async open() {
      return this;
    },
    async config() {
      return { mode, connected, routing: { revision: 0 } };
    },
    onConcurrencyChange() {
      return () => {};
    },
    run(request) {
      calls.push({ kind: 'run', request });
      return mode;
    },
    runAgent(request) {
      calls.push({ kind: 'agent', request });
      return mode;
    },
    routing() {
      return mode;
    },
    async close() {},
  };
}

void test('host selection affects only new settings while frozen jobs retain their backend', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-host-test-'));
  const dsh = fakeHost('dsh');
  const codex = fakeHost('codex');
  const service = await new HostModelService({
    directory,
    dsh,
    codex,
    defaultBackend: 'dsh',
  }).open();
  t.after(() => service.close());
  const frozenDsh = service.store.state.settings;
  const switched = await service.selectBackend({
    backend: 'codex',
    revision: 0,
  });
  assert.equal(switched.activeBackend, 'codex');
  assert.equal(service.store.state.settings.codex.protocol, 'test');
  assert.equal(service.concurrencyForSettings(frozenDsh), 3);
  assert.equal(service.concurrencyForSettings(service.store.state.settings), 5);
  assert.equal(
    await service.runAgent({ task: 'screen' }, { settings: frozenDsh }),
    'dsh',
  );
  assert.equal(
    await service.runAgent(
      { task: 'screen' },
      { settings: service.store.state.settings },
    ),
    'codex',
  );
  assert.equal(dsh.calls.length, 1);
  assert.equal(codex.calls.length, 1);
});

void test('cancellation during turn setup cannot leave an unbounded turn waiting forever', { timeout: 2000 }, async (t) => {
  class SlowStartingAppServer extends UninterruptibleAppServer {
    async request(method, params) {
      if (method === 'turn/start') {
        // The RPC can finish concurrently with cancellation. Simulate a host
        // that has accepted the turn but returns after the signal is aborted.
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return super.request(method, params);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-codex-setup-cancel-'));
  const controller = new AbortController();
  const client = new SlowStartingAppServer();
  const service = await new CodexModelService({ directory, client }).open();
  t.after(() => service.close());
  await assert.rejects(service.runAgent({
    task: 'single', prompt: 'Wait for cancellation.', executionMs: null,
    tools: [{ name: 'finish', description: 'Finish.', parameters: { type: 'object' } }],
    submitTool: 'finish',
  }, {
    settings: service.store.state.settings,
    signal: controller.signal,
    onTool: async () => ({ accepted: true }),
  }), { code: 'cancelled' });
  assert.equal(service.running, 0);
  assert.equal(client.terminations, 1);
  assert.equal(service.bridge.tasks.size, 0);
  assert.equal(client.listeners.size, 0);
});
