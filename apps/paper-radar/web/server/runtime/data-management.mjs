import { promisify } from 'node:util';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  copyFileSync,
  rmSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { appRoot, personaProject } from './paths.mjs';
import { start } from '../../../scripts/launcher.mjs';
import { AnalysisError } from '../analyses/contracts.mjs';

export const backupName = /^radar-[0-9a-f-]{36}\.tar\.gz$/;
function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error('Backup inputs must be regular files and directories.');
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const item of readdirSync(source))
      copyTree(join(source, item), join(destination, item));
  } else copyFileSync(source, destination);
}

export function archiveCommand(action, source, destination) {
  const python = join(personaProject, '.venv/bin/python');
  if (!existsSync(python))
    throw new Error(
      'Prepare AI Persona with npm run setup:radar before using backups.',
    );
  try {
    return execFileSync(
      python,
      [join(appRoot, 'scripts/archive.py'), action, source, destination],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 1000000 },
    );
  } catch {
    throw new Error(
      'The backup could not be verified. Check the file and available disk space. Existing data was not changed.',
    );
  }
}

async function archiveInBackground(action, source, destination) {
  const python = join(personaProject, '.venv/bin/python');
  if (!existsSync(python))
    throw new Error('Prepare AI Persona before using backups.');
  try {
    const { stdout } = await promisify(execFile)(
      python,
      [join(appRoot, 'scripts/archive.py'), action, source, destination],
      { encoding: 'utf8', timeout: 300000, maxBuffer: 1000000 },
    );
    return stdout;
  } catch {
    throw new Error(
      'The backup could not be verified. Existing data was not changed.',
    );
  }
}

export class DataManagement {
  constructor(analyses, daily, { busy = () => false } = {}) {
    this.analyses = analyses;
    this.daily = daily;
    this.database = analyses.db;
    this.busy = busy;
    this.backups = join(this.database.directory, 'backups');
  }
  list() {
    const backups = existsSync(this.backups)
      ? readdirSync(this.backups)
          .filter((name) => backupName.test(name))
          .map((name) => {
            const path = join(this.backups, name);
            if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
              return null;
            const stat = statSync(path);
            return {
              id: name,
              size: stat.size,
              created_at: stat.mtime.toISOString(),
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
      : [];
    return {
      directory: this.database.directory,
      backups,
      counts: Object.fromEntries(
        ['subscriptions', 'jobs', 'results', 'daily_runs'].map((table) => [
          table,
          this.database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()
            .n,
        ]),
      ),
      busy: this.busy() || !!this.working,
      folder_picker_available: ['darwin', 'linux'].includes(process.platform),
    };
  }
  async createBackup() {
    if (this.busy() || this.working)
      throw new AnalysisError(
        'workspace_busy',
        '请等待运行中的任务完成后再备份。',
        true,
        409,
      );
    const stage = mkdtempSync(join(tmpdir(), 'paper-radar-backup-'));
    const id = `radar-${randomUUID()}.tar.gz`;
    mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    const temporary = join(this.backups, `.${id}.tmp`);
    this.working = true;
    try {
      const data = join(stage, 'data');
      mkdirSync(data, { mode: 0o700 });
      // Synchronous snapshot: no service callbacks can change files during this copy.
      this.database.db.prepare('VACUUM INTO ?').run(join(data, 'radar.sqlite'));
      mkdirSync(join(data, 'prompts'), { mode: 0o700 });
      this.analyses.prompts.db
        .prepare('VACUUM INTO ?')
        .run(join(data, 'prompts/prompts.sqlite3'));
      for (const name of ['cache', 'onboarding.json']) {
        const source = join(this.database.directory, name);
        if (existsSync(source)) copyTree(source, join(data, name));
      }
      if (
        this.analyses.persona?.configPath &&
        existsSync(this.analyses.persona.configPath)
      )
        copyTree(this.analyses.persona.configPath, join(data, 'persona.json'));
      await archiveInBackground('create', stage, temporary);
      renameSync(temporary, join(this.backups, id));
      this.working = false;
      return { id, ...this.list() };
    } finally {
      this.working = false;
      rmSync(stage, { recursive: true, force: true });
      rmSync(temporary, { force: true });
    }
  }
  backupPath(id) {
    if (!backupName.test(id) || basename(id) !== id)
      throw new AnalysisError('invalid_backup', '请选择有效的备份文件。');
    const path = join(this.backups, id);
    if (
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink()
    )
      throw new AnalysisError('invalid_backup', '请选择有效的备份文件。');
    return path;
  }
  async restore(id) {
    const path = this.backupPath(id);
    const target = join(
      dirname(this.database.directory),
      `restored-${randomUUID()}`,
    );
    return {
      ...JSON.parse(await archiveInBackground('restore', path, target)),
      id: basename(target),
    };
  }
  async openRestored(id) {
    if (typeof id !== 'string' || !/^restored-[0-9a-f-]{36}$/.test(id))
      throw new AnalysisError('invalid_backup', '请选择有效的备份文件。');
    const directory = join(dirname(this.database.directory), id);
    if (
      !existsSync(directory) ||
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      throw new AnalysisError('invalid_backup', '请选择有效的备份文件。');
    const home = join(directory, '.app');
    return start({
      open: false,
      port: 0,
      env: {
        ...process.env,
        PAPER_RADAR_HOME: home,
        PAPER_RADAR_STORAGE_DIR: directory,
        PAPER_RADAR_DATA_DIR: join(home, 'models'),
        PAPER_RADAR_PERSONA_CONFIG: join(directory, 'persona.json'),
        PAPER_RADAR_PUBLIC_ORIGIN: '',
        PAPER_RADAR_DSH_SOCKET: join(home, 'harness.sock'),
        PAPER_RADAR_HARNESS_SOCKET: join(home, 'harness.sock'),
      },
    }).catch((error) => {
      console.error('Recovered workspace startup:', error.message);
      throw new AnalysisError(
        'restore_start_failed',
        '恢复副本未能启动，请查看本机日志。',
        true,
        503,
      );
    });
  }
  download(id, response) {
    const path = this.backupPath(id);
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': statSync(path).size,
      'Content-Disposition': `attachment; filename="${id}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = createReadStream(path);
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
  openDirectory() {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [this.database.directory], {
      stdio: 'ignore',
    });
    return new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? done({ opened: true })
          : reject(
              new Error('The folder could not be opened on this computer.'),
            ),
      );
    });
  }
}
