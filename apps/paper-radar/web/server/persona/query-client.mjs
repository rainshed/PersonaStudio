import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AnalysisError, hash } from '../analyses/contracts.mjs';

export const QUERY_VERSION = 'ai-persona.query-result/v2';
export const QUERY_TOOLS = [
  'get_knowledge_map',
  'search_knowledge',
  'get_persona_records',
  'list_source_files',
  'search_source_content',
  'read_source',
];
export const personaConnectionId = (config) =>
  config.connection_id ??
  'persona-' +
    hash({
      command: config.command,
      args: config.args,
      env: config.env || {},
    }).slice(0, 24);
const envelope = z.object({
  schema_version: z.literal(QUERY_VERSION),
  tool: z.string(),
  ok: z.boolean(),
  persona_revision: z.number().int().positive().nullable(),
  scope: z
    .object({ tag_ids: z.array(z.string()), tag_match: z.enum(['any', 'all']) })
    .nullable(),
  data: z.record(z.string(), z.unknown()),
  coverage: z.record(z.string(), z.unknown()),
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .loose()
    .nullable(),
});
const shapes = {
  get_knowledge_map: ['domains', 'nodes', 'edges', 'frontier'],
  search_knowledge: ['hits', 'nodes', 'edges', 'excerpts'],
  get_persona_records: ['items'],
  list_source_files: ['entries'],
  search_source_content: ['matches', 'index_coverage'],
  read_source: [],
};
export const sameScope = (a, b) =>
  !!a &&
  !!b &&
  a.tag_match === b.tag_match &&
  JSON.stringify([...new Set(a.tag_ids)].sort((a, b) => a.localeCompare(b))) ===
    JSON.stringify([...new Set(b.tag_ids)].sort((a, b) => a.localeCompare(b)));
export const protocolError = () =>
  new AnalysisError(
    'persona_protocol',
    'AI Persona 查询响应不符合当前接口，请更新两端后重新连接。',
  );

// Only the six current read tools are available. No legacy protocol negotiation.
export class PersonaQueryClient {
  constructor(
    configPath,
    { clientFactory, timeoutMs = 300000, configuration } = {},
  ) {
    this.configPath = configPath;
    this.clientFactory = clientFactory;
    this.timeoutMs = timeoutMs;
    this.client = null;
    this.pending = null;
    this.configuration = configuration;
    this.inflight = 0;
    this.retiring = new Set();
  }
  // Called only after the settings manager has drained task and query activity.
  useConfiguration(config, candidate) {
    const old = this.client;
    this.configuration = structuredClone(config);
    this.identity = personaConnectionId(config);
    this.client = candidate?.client ?? null;
    if (candidate) candidate.client = null;
    if (this.client) {
      const current = this.client;
      current.onclose = () => {
        if (this.client === current) this.client = null;
      };
    }
    if (old && old !== this.client) {
      const closing = Promise.resolve()
        .then(() => old.close())
        .catch(() => {})
        .finally(() => this.retiring.delete(closing));
      this.retiring.add(closing);
    }
  }
  async connect() {
    if (this.client) return this.client;
    if (!this.pending) this.pending = this.open();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  async open() {
    let config;
    try {
      config =
        this.configuration ??
        JSON.parse(await readFile(this.configPath, 'utf8'));
    } catch {
      throw new AnalysisError(
        'persona_unavailable',
        '尚未配置 AI Persona 本机连接；可以不选标签先生成总结。',
        true,
      );
    }
    if (
      typeof config.command !== 'string' ||
      !Array.isArray(config.args) ||
      config.args.some((v) => typeof v !== 'string')
    )
      throw new AnalysisError('persona_unavailable', 'Persona 连接配置无效。');
    this.identity = personaConnectionId(config);
    const client = this.clientFactory
      ? await this.clientFactory(config)
      : new Client(
          { name: 'PaperRadar', version: '0.3.0' },
          { capabilities: {} },
        );
    try {
      if (!this.clientFactory) {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: 'pipe',
        });
        transport.stderr?.on('data', () => {});
        await client.connect(transport, { timeout: 20000 });
      }
      const tools = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw protocolError();
        seen.add(cursor);
      } while (cursor);
      if (
        QUERY_TOOLS.some((name) => {
          const tool = tools.find((t) => t.name === name);
          return (
            !tool?.inputSchema?.properties?.scope ||
            !tool.inputSchema.properties.expected_persona_revision
          );
        })
      )
        throw new AnalysisError(
          'persona_version',
          '当前 AI Persona 未提供所需的新查询接口，请更新 AI Persona 并重新连接。',
        );
      this.client = client;
      client.onclose = () => {
        if (this.client === client) this.client = null;
      };
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof AnalysisError
        ? error
        : new AnalysisError(
            'persona_unavailable',
            '无法连接 AI Persona 本机服务。',
            true,
          );
    }
  }
  async call(name, args, signal) {
    this.inflight++;
    try {
      return await this.query(name, args, signal);
    } finally {
      this.inflight--;
    }
  }
  async query(name, args, signal) {
    if (!QUERY_TOOLS.includes(name))
      throw new AnalysisError(
        'out_of_scope',
        '该工具不属于 PaperRadar 的只读查询范围。',
      );
    signal?.throwIfAborted();
    const client = await this.connect();
    let reply;
    try {
      reply = await client.callTool({ name, arguments: args }, undefined, {
        timeout: this.timeoutMs,
        signal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new AnalysisError(
        'persona_unavailable',
        'Persona 查询未完成，请检查服务连接。',
        true,
      );
    }
    // TextContent is another MCP encoding of the same v2 envelope, never an old DTO.
    let raw = reply.structuredContent;
    if (!raw) {
      try {
        raw = JSON.parse(reply.content.find((c) => c.type === 'text').text);
      } catch {
        throw protocolError();
      }
    }
    const parsed = envelope.safeParse(raw);
    if (!parsed.success || parsed.data.tool !== name) throw protocolError();
    const value = parsed.data;
    if (!value.ok || reply.isError) {
      const code = value.error?.code ?? 'query_unavailable';
      const messages = {
        version_changed: 'Persona 内容已变化，需要重新准备同一标签范围的依据。',
        source_changed: '材料来源已变化，不能混用旧证据。',
        invalid_cursor: '查询分页已失效，需要重新读取。',
        invalid_reference: '所选标签已失效，请重新选择。',
        not_found_or_not_visible: '记录或来源不可用，或不在选定范围内。',
        budget_too_small: '查询内容超过读取预算，请缩小范围。',
        query_unavailable: 'Persona 查询暂时不可用，请稍后重试。',
      };
      throw new AnalysisError(
        code,
        messages[code] ?? value.error?.message ?? 'Persona 查询失败。',
        value.error?.retryable ?? false,
      );
    }
    if (
      !value.persona_revision ||
      shapes[name].some((key) => !Array.isArray(value.data[key]))
    )
      throw protocolError();
    if (args.scope && !sameScope(args.scope, value.scope))
      throw new AnalysisError('out_of_scope', 'Persona 返回了不同的标签范围。');
    if (
      args.expected_persona_revision &&
      value.persona_revision !== args.expected_persona_revision
    )
      throw new AnalysisError(
        'version_changed',
        'Persona 返回了不同版本的内容。',
      );
    const images = reply.content?.filter(c => c.type === 'image') ?? [];
    if (images.length > 4 || images.some(c => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(c.mimeType) || typeof c.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(c.data)) || images.reduce((n, c) => n + c.data.length, 0) > 20 * 1024 * 1024) throw protocolError();
    if (images.length) value._image_content = images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }));
    return value;
  }
  async close() {
    if (this.pending) await this.pending.catch(() => {});
    const client = this.client;
    this.client = null;
    if (client) await client.close();
    await Promise.allSettled(this.retiring);
  }
}
