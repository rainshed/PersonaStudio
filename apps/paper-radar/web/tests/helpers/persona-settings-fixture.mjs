import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaClient } from '../../server/persona/service.mjs';
import { PersonaSettings } from '../../server/persona/settings.mjs';
import {
  QUERY_TOOLS,
  QUERY_VERSION,
} from '../../server/persona/query-client.mjs';

export async function personaSettingsFixture(
  t,
  { configured = true, tagCount = 2 } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-persona-settings-'));
  const workspace = join(directory, '研究资料 A'),
    other = join(directory, '知识库 B');
  for (const path of [workspace, other]) {
    await mkdir(join(path, 'persona-data/config'), { recursive: true });
    await mkdir(join(path, 'persona-state'));
    await mkdir(join(path, '.venv/bin'), { recursive: true });
    await writeFile(
      join(path, 'persona-data/config/persona.toml'),
      '# fixture\n',
    );
    await writeFile(
      join(path, '.venv/bin/ai-persona-mcp'),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o700 },
    );
  }
  const path = join(directory, 'persona.json');
  const config = {
    command: join(workspace, '.venv/bin/ai-persona-mcp'),
    args: ['--workspace', workspace],
    env: { FIXTURE_SECRET: 'never-return-this' },
  };
  if (configured) await writeFile(path, JSON.stringify(config));
  const calls = [],
    connections = [];
  const state = {
    busy: false,
    fail: false,
    tagCount,
    oldTools: false,
    beforeRead: null,
  };
  const factory = async (configuration) => {
    const connection = {
      closed: false,
      async listTools() {
        return {
          tools: (state.oldTools ? [] : QUERY_TOOLS).map((name) => ({
            name,
            inputSchema: {
              properties: { scope: {}, expected_persona_revision: {} },
            },
          })),
        };
      },
      async callTool({ name, arguments: args }) {
        calls.push({ name, args, config: configuration });
        await state.beforeRead?.();
        if (state.fail) throw new Error('fixture failure');
        return {
          structuredContent: {
            schema_version: QUERY_VERSION,
            tool: name,
            ok: true,
            persona_revision: 7,
            scope: args.scope ?? null,
            data: {
              domains: Array.from({ length: state.tagCount }, (_, i) => ({
                id: 'tag-' + i,
                label: i ? 'Quantum dynamics' : '物理',
                aliases: [],
              })),
              nodes: [],
              edges: [],
              frontier: [],
            },
            coverage: { truncated: false },
            warnings: [],
            next_cursor: null,
            error: null,
          },
        };
      },
      async close() {
        this.closed = true;
        this.onclose?.();
      },
    };
    connections.push(connection);
    return connection;
  };
  const persona = new PersonaClient(path, { clientFactory: factory });
  const makeClient = (configuration) =>
    new PersonaClient(path, { configuration, clientFactory: factory });
  const settings = new PersonaSettings(persona, {
    clientFactory: makeClient,
    busy: () => state.busy,
    pollMs: 100000,
    suggestedWorkspace: workspace,
  });
  const draft = (extra = {}) => ({
    name: '我的资料',
    workspace,
    executable: config.command,
    expected_revision: settings.revision,
    ...extra,
  });
  t.after(async () => {
    await settings.close();
    await persona.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    config,
    workspace,
    other,
    persona,
    settings,
    state,
    calls,
    connections,
    factory,
    makeClient,
    draft,
  };
}
