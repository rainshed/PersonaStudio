// Adapted from paper-radar's Pi model service; independent AI Persona configuration.
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  open,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { emptyModelSettings, hydrateModelSettings } from './model-config.ts';

// One local server owns the vault. Its key stays on this machine, outside the repo.
export class ModelStore {
  constructor(directory) {
    this.directory = directory;
    this.tail = Promise.resolve();
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.lockPath = join(this.directory, 'server.lock');
    try {
      this.lock = await open(this.lockPath, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(
        await readFile(this.lockPath, 'utf8').catch(() => '0'),
      );
      if (!pid) throw new Error('模型存储已锁定；请检查 server.lock');
      try {
        process.kill(pid, 0);
        throw new Error('另一个模型服务正在使用此存储');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await unlink(this.lockPath);
      this.lock = await open(this.lockPath, 'wx', 0o600);
    }
    await this.lock.writeFile(String(process.pid));
    try {
      const keyPath = join(this.directory, 'vault.key');
      try {
        this.key = await readFile(keyPath);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        this.key = randomBytes(32);
        await writeFile(keyPath, this.key, { mode: 0o600, flag: 'wx' });
      }
      if (this.key.length !== 32) throw new Error('模型凭据密钥无效');
      await chmod(keyPath, 0o600);
      try {
        const file = JSON.parse(
          await readFile(join(this.directory, 'vault.enc'), 'utf8'),
        );
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.key,
          Buffer.from(file.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
        this.state = JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(file.data, 'base64')),
            decipher.final(),
          ]).toString(),
        );
        if (
          this.state.version !== 1 ||
          !this.state.settings ||
          !this.state.credentials
        )
          throw new Error('模型存储版本不支持');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        this.state = {
          version: 1,
          settings: emptyModelSettings(),
          credentials: {},
          runs: [],
        };
      }
      // Add model routing to legacy vaults without moving credentials or losing revisions.
      // Null model choices keep each existing connection's original model.
      const settings = hydrateModelSettings(this.state.settings);
      if (!settings) throw new Error('模型配置无效');
      this.state.settings = { ...settings, connections: this.state.settings.connections };
      return this;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async transaction(fn) {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = await fn(next);
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', this.key, iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify(next)),
        cipher.final(),
      ]);
      const payload = JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      });
      const target = join(this.directory, 'vault.enc'),
        temp = target + '.tmp';
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, target);
      this.state = next;
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  credentialStore(connectionId, revision) {
    const check = (state) => {
      const current = state.settings.connections.find(
        (c) => c.id === connectionId,
      );
      if (!current || (revision !== undefined && current.revision !== revision))
        throw new Error('Connection changed; retry task');
    };
    return {
      read: async () => {
        check(this.state);
        return structuredClone(this.state.credentials[connectionId]);
      },
      list: async () => {
        const c = this.state.credentials[connectionId];
        return c ? [{ providerId: connectionId, type: c.type }] : [];
      },
      modify: async (_id, fn, options) =>
        this.transaction(async (s) => {
          options?.signal?.throwIfAborted();
          check(s);
          const current = s.credentials[connectionId],
            next = await fn(current);
          options?.signal?.throwIfAborted();
          if (next !== undefined) s.credentials[connectionId] = next;
          return structuredClone(s.credentials[connectionId]);
        }),
      delete: async () =>
        this.transaction((s) => {
          delete s.credentials[connectionId];
        }),
    };
  }
  async close() {
    await this.tail;
    await this.lock?.close();
    if (this.lock) {
      await unlink(this.lockPath).catch(() => {});
      this.lock = null;
    }
  }
}
