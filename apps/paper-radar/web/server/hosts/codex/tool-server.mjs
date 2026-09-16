import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { toolContent, toolTextValue, MAX_TOOL_RESPONSE_BYTES } from '@paper-radar/host-contract/tool-content';
import { codexToolDefinitions } from '@paper-radar/host-contract/context';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const contextPath = process.argv[2];
if (!contextPath) throw new Error('缺少 Paper Radar 工具上下文。');
const context = JSON.parse(await readFile(contextPath, 'utf8'));

function call(name, args) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      id: context.id,
      token: context.token,
      name,
      arguments: args ?? {},
    });
    const req = request(
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
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_TOOL_RESPONSE_BYTES) req.destroy(new Error('工具响应过大。'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if ((res.statusCode ?? 500) >= 400)
              reject(new Error(value.message ?? '工具调用未完成。'));
            else resolve(value.value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const tools = new Map(context.tools.map((tool) => [tool.name, tool]));
// Raw task-specific JSON Schemas require the SDK's low-level server API.
// oxlint-disable-next-line typescript/no-deprecated
const server = new Server(
  { name: 'paper-radar-internal', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: codexToolDefinitions([...tools.values()]),
}));
server.setRequestHandler(CallToolRequestSchema, async (requestMessage) => {
  const { name, arguments: args } = requestMessage.params;
  if (!tools.has(name)) throw new Error('本任务未开放此工具。');
  const value = await call(name, args);
  return {
    content: toolContent(value),
    ...(value && typeof value === 'object' ? { structuredContent: toolTextValue(value) } : {}),
  };
});
await server.connect(new StdioServerTransport());
