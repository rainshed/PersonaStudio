import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CodexToolBridge } from '../server/hosts/codex/tool-bridge.mjs';
import { PERSONA_QUERY_TOOLS } from '@paper-radar/host-contract/persona-tools';

void test('Codex MCP tool transport delivers Persona pixels as image content with textual provenance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-image-bridge-'));
  const bridge = new CodexToolBridge(directory);
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFf8AAAAASUVORK5CYII=';
  const value = {
    data: {
      citation_ref: 'persona:source:image',
      provenance: {
        source_id: 's',
        file_id: 'f',
        file_hash: 'sha256:image',
        locator: { pages: [1] },
      },
    },
    _image_content: [{ type: 'image', mimeType: 'image/png', data: pixel }],
  };
  const registration = await bridge.register(
    { tools: PERSONA_QUERY_TOOLS, submitTool: 'unused' },
    {
      onTool: async (name, args) => {
        assert.equal(name, 'read_source');
        assert.equal(args.view, 'image');
        return value;
      },
    },
    new AbortController().signal,
  );
  const client = new Client({ name: 'image-test', version: '1' });
  t.after(async () => {
    await client.close();
    await registration.close();
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL('../server/hosts/codex/tool-server.mjs', import.meta.url),
        ),
        registration.file,
      ],
      stderr: 'pipe',
    }),
  );
  const result = await client.callTool({
    name: 'read_source',
    arguments: { source_id: 's', file_id: 'f', view: 'image' },
  });
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, pixel);
  assert.ok(result.content[0].text.includes('persona:source:image'));
  assert.ok(!result.content[0].text.includes(pixel));
  assert.equal(result.structuredContent._image_content, undefined);
});
