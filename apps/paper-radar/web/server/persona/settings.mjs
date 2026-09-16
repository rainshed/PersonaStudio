import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { discoverExecutable, discoverWorkspace } from './discovery.mjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AnalysisError, hash } from '../analyses/contracts.mjs';
import { PersonaClient } from './service.mjs';
import { personaConnectionId } from './query-client.mjs';
import { PersonaPathPicker } from './path-picker.mjs';

const draftSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    workspace: z.string().trim().min(1).max(4096),
    executable: z.string().trim().max(4096).default(''),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
const saveSchema = z
  .object({
    test_id: z.uuid(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
const revisionSchema = z
  .object({ expected_revision: z.number().int().nonnegative() })
  .strict();
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AnalysisError(
      'invalid_settings',
      '请检查连接名称、知识库位置和程序位置。',
    );
  return result.data;
};
const absolutePath = (value) => {
  const expanded = value.startsWith('~/')
    ? join(homedir(), value.slice(2))
    : value;
  if (
    !isAbsolute(expanded) ||
    ['\0', '\r', '\n'].some((character) => expanded.includes(character))
  )
    throw new AnalysisError('invalid_path', '请填写这台电脑上的完整本机路径。');
  return resolve(expanded);
};
const workspaceFrom = (config) => {
  const index = Array.isArray(config?.args)
    ? config.args.indexOf('--workspace')
    : -1;
  return index >= 0
    ? (config.args[index + 1] ?? '')
    : (config?.workspace ?? '');
};
const workspaceInfo = (value) => {
  try {
    const workspace = realpathSync(absolutePath(value));
    const data = statSync(join(workspace, 'persona-data'), { bigint: true });
    if (
      !data.isDirectory() ||
      !statSync(join(workspace, 'persona-state')).isDirectory() ||
      !statSync(join(workspace, 'persona-data/config/persona.toml')).isFile()
    )
      throw new Error();
    // Directory identity survives a rename and resolves aliases without writing to Persona.
    return {
      workspace,
      workspace_key: hash({
        device: String(data.dev),
        inode: String(data.ino),
      }),
    };
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    throw new AnalysisError(
      'invalid_workspace',
      '知识库位置无效，请选择包含 persona-data 和 persona-state 的 AI Persona 文件夹。',
    );
  }
};
const executablePath = (value) => {
  const path = absolutePath(value);
  if (basename(path) !== 'ai-persona-mcp')
    throw new AnalysisError(
      'invalid_executable',
      '请选择名为 ai-persona-mcp 的 AI Persona 程序。',
    );
  try {
    if (!statSync(path).isFile()) throw new Error();
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    throw new AnalysisError(
      'invalid_executable',
      '未找到可运行的 AI Persona 程序，请检查程序位置。',
    );
  }
};
const publicConfig = (config) =>
  config
    ? {
        name: config.name || '我的 AI Persona',
        workspace: workspaceFrom(config),
        executable: config.command ?? '',
        connection_id: personaConnectionId(config),
      }
    : null;

/** Local connection settings. Tests use disposable clients; a verified switch
 * commits synchronously only when existing jobs and MCP requests have drained. */
export class PersonaSettings {
  constructor(
    persona,
    {
      busy = () => false,
      affected = () => [],
      reconcile = () => {},
      clientFactory,
      clock = Date.now,
      pollMs = 1500,
      suggestedWorkspace,
      pathPicker = new PersonaPathPicker(),
    } = {},
  ) {
    this.persona = persona;
    this.pathPicker = pathPicker;
    this.path = persona.configPath;
    this.busy = busy;
    this.affected = affected;
    this.reconcile = reconcile;
    this.clock = clock;
    this.makeClient =
      clientFactory ??
      ((configuration) =>
        new PersonaClient(this.path, { configuration, timeoutMs: 20000 }));
    this.tests = new Map();
    this.suggestedWorkspace = suggestedWorkspace;
    this.disk = this.readDisk();
    try {
      this.state = this.disk ? JSON.parse(this.disk) : {};
    } catch {
      this.state = {};
      this.error = '原连接配置无法读取，请重新测试并保存本机连接。';
    }
    this.revision = this.state.settings_revision ?? 0;
    this.current =
      typeof this.state.command === 'string' ? { ...this.state } : null;
    if (this.current) {
      delete this.current.pending_connection;
      if (!this.current.workspace_key) {
        try {
          Object.assign(
            this.current,
            workspaceInfo(workspaceFrom(this.current)),
          );
        } catch {
          /* Keep an unavailable configuration editable. */
        }
      }
      // Pin the startup config, so a pending save cannot change an existing query.
      this.persona.configuration = structuredClone(this.current);
    }
    this.pending = this.state.pending_connection ?? null;
    this.closed = false;
    this.work = null;
    this.timer = setInterval(() => {
      void this.flush();
    }, pollMs);
    this.timer.unref();
  }
  readDisk() {
    try {
      return readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }
  checkRevision(revision) {
    if (this.closed)
      throw new AnalysisError(
        'unavailable',
        '服务正在关闭，请稍后重试。',
        true,
        503,
      );
    if (revision !== this.revision)
      throw new AnalysisError(
        'settings_conflict',
        '连接设置已改变，请刷新后重新测试。',
        false,
        409,
      );
    if (this.readDisk() !== this.disk)
      throw new AnalysisError(
        'settings_file_changed',
        '连接配置文件已在其他位置修改，请重启 Paper Radar 后重试。',
        false,
        409,
      );
  }
  write(current, pending) {
    this.checkRevision(this.revision);
    const next = {
      ...current,
      settings_revision: this.revision + 1,
      pending_connection: pending,
    };
    const text = JSON.stringify(next, null, 2) + '\n';
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch {
      rmSync(temporary, { force: true });
      throw new AnalysisError(
        'settings_write_failed',
        '连接设置未能保存，请检查 Paper Radar 数据目录是否可写。',
      );
    }
    this.disk = text;
    this.revision++;
    this.current = current;
    this.pending = pending;
  }
  settings() {
    let workspace = this.suggestedWorkspace ?? discoverWorkspace();
    try {
      workspace = workspaceInfo(workspace).workspace;
    } catch {
      workspace = '';
    }
    const draft = publicConfig(this.pending ?? this.current) ?? {
      name: '我的 AI Persona',
      workspace,
      executable: discoverExecutable(workspace),
      connection_id: null,
    };
    return {
      revision: this.revision,
      configured: !!this.current,
      path_picker_available: this.pathPicker.available,
      current: publicConfig(this.current),
      draft,
      pending: publicConfig(this.pending),
      connected: !!this.persona.client,
      pending_error: this.error ?? null,
      affected_subscriptions: this.pending
        ? this.affected(personaConnectionId(this.pending))
        : [],
      needs_attention: this.current
        ? this.affected(personaConnectionId(this.current))
        : [],
    };
  }
  candidate(raw) {
    const draft = parse(draftSchema, raw);
    this.checkRevision(draft.expected_revision);
    const info = workspaceInfo(draft.workspace);
    const executable = executablePath(
      draft.executable || discoverExecutable(info.workspace),
    );
    const sameWorkspace = this.current?.workspace_key === info.workspace_key;
    return {
      name: draft.name,
      ...info,
      command: executable,
      args: ['--workspace', info.workspace],
      connection_id: sameWorkspace
        ? personaConnectionId(this.current)
        : 'persona-' + info.workspace_key.slice(0, 24),
      ...(sameWorkspace && this.current.env ? { env: this.current.env } : {}),
    };
  }
  async probe(config) {
    const info = workspaceInfo(config.workspace);
    if (info.workspace_key !== config.workspace_key)
      throw new AnalysisError(
        'workspace_changed',
        '知识库位置的内容已变化，请重新测试连接。',
      );
    executablePath(config.command);
    const client = this.makeClient(config);
    try {
      const tags = await client.tags({}, AbortSignal.timeout(25000));
      if (
        !Array.isArray(tags.tags) ||
        tags.tags.some(
          (tag) => typeof tag.id !== 'string' || typeof tag.label !== 'string',
        )
      )
        throw new AnalysisError(
          'persona_protocol',
          'AI Persona 返回的标签目录无效，请更新后重试。',
        );
      return { client, tags };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  async test(raw) {
    const config = this.candidate(raw);
    const { client, tags } = await this.probe(config);
    try {
      this.checkRevision(raw.expected_revision);
      for (const [id, value] of this.tests)
        if (value.expires <= this.clock()) this.tests.delete(id);
      if (this.tests.size >= 20)
        this.tests.delete(this.tests.keys().next().value);
      const test_id = randomUUID();
      this.tests.set(test_id, {
        config,
        expires: this.clock() + 300000,
        revision: this.revision,
      });
      return {
        test_id,
        revision: this.revision,
        connection: publicConfig(config),
        tag_count: tags.tags.length,
        tags: tags.tags.slice(0, 8).map(({ id, label }) => ({ id, label })),
        persona_revision: tags.persona_revision,
        different_workspace:
          !!this.current &&
          personaConnectionId(config) !== personaConnectionId(this.current),
        affected_subscriptions: this.affected(personaConnectionId(config)),
      };
    } finally {
      await client.close();
    }
  }
  async save(raw) {
    const input = parse(saveSchema, raw);
    this.checkRevision(input.expected_revision);
    const tested = this.tests.get(input.test_id);
    if (
      !tested ||
      tested.expires <= this.clock() ||
      tested.revision !== this.revision
    )
      throw new AnalysisError(
        'test_expired',
        '测试结果已过期或设置已改变，请重新测试连接。',
      );
    this.write(this.current, tested.config);
    this.tests.clear();
    this.error = null;
    await this.flush();
    return this.settings();
  }
  cancel(raw) {
    const input = parse(revisionSchema, raw);
    this.checkRevision(input.expected_revision);
    this.write(this.current, null);
    this.tests.clear();
    this.error = null;
    return this.settings();
  }
  isBusy() {
    return this.busy() || this.persona.inflight > 0 || !!this.persona.pending;
  }
  flush() {
    if (this.work) return this.work;
    if (this.closed || !this.pending || this.error) return Promise.resolve();
    try {
      if (this.isBusy()) return Promise.resolve();
    } catch {
      this.error = '任务状态暂时不可用，连接将在重新测试后切换。';
      return Promise.resolve();
    }
    this.work = this.apply().finally(() => {
      this.work = null;
    });
    return this.work;
  }
  async apply() {
    const target = this.pending;
    const revision = this.revision;
    let candidate;
    try {
      ({ client: candidate } = await this.probe(target));
      if (this.closed || this.revision !== revision || this.isBusy()) return;
      // All operations below are synchronous: no task starts between the idle
      // check, persistent switch, subscription invalidation and client adoption.
      this.write(target, null);
      this.persona.useConfiguration(target, candidate);
      this.reconcile(personaConnectionId(target));
      this.error = null;
    } catch (error) {
      if (this.revision === revision || this.current === target)
        this.error =
          error instanceof AnalysisError
            ? error.message
            : '连接未能生效，请重新测试并保存。';
    } finally {
      await candidate?.close().catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pathPicker.close();
    await this.work;
  }
}

export function configurePersonaSettings(
  analyses,
  daily,
  discussions,
  promptAPI,
) {
  if (!analyses?.persona?.configPath) return null;
  const affected = (identity) =>
    (daily?.repo.subscriptions() ?? [])
      .filter(
        (s) =>
          s.status !== 'archived' &&
          (s.persona_reselection_required ||
            (s.scope.tag_ids.length && s.persona_connection_id !== identity)),
      )
      .map(({ id, name }) => ({ id, name }));
  const settings = new PersonaSettings(analyses.persona, {
    busy: () => {
      const tasks = analyses.taskRuntime.snapshot();
      return (
        tasks.active.length > 0 ||
        tasks.queued.length > 0 ||
        analyses.controllers.size > 0 ||
        (daily?.controllers.size ?? 0) > 0 ||
        (discussions?.controllers.size ?? 0) > 0 ||
        (daily?.scheduler?.work.size ?? 0) > 0 ||
        !!daily?.scheduler?.scanning ||
        (promptAPI?.active?.size ?? 0) > 0
      );
    },
    affected,
    reconcile: (identity) => {
      if (!daily) return;
      analyses.db.transaction(() => {
        for (const { id } of affected(identity)) {
          const subscription = daily.repo.get('subscriptions', id);
          if (
            !subscription.persona_reselection_required ||
            subscription.status !== 'paused'
          )
            daily.repo.saveSubscription({
              ...subscription,
              status: 'paused',
              persona_reselection_required: true,
              persona_connection_id: null,
              scope: { tag_ids: [], tag_match: 'any' },
              tags: [],
              revision: subscription.revision + 1,
              updated_at: new Date().toISOString(),
            });
          const schedule = daily.scheduler?.repo.schedule(id);
          if (schedule?.enabled)
            daily.scheduler.repo.saveSchedule({
              ...schedule,
              enabled: false,
              revision: schedule.revision + 1,
              next_check_at: null,
            });
        }
      });
    },
  });
  if (settings.current?.connection_id)
    settings.reconcile(personaConnectionId(settings.current));
  analyses.personaSettings = settings;
  return settings;
}
