#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appRoot, runtimePaths } from '../web/server/runtime/paths.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function read(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export async function status(options = {}) {
  const paths = runtimePaths(options.env);
  const saved = read(join(paths.runtime, 'server.json'));
  if (
    !saved ||
    !Number.isInteger(saved.pid) ||
    saved.pid < 1 ||
    !alive(saved.pid)
  )
    return { running: false, data_directory: paths.data };
  try {
    const url = new URL(saved.url);
    if (
      url.hostname !== '127.0.0.1' ||
      url.protocol !== 'http:' ||
      url.pathname !== '/' ||
      url.username ||
      url.password
    )
      throw new Error('Invalid local service address');
    const response = await fetch(new URL('/api/capabilities', url), {
      signal: AbortSignal.timeout(2000),
    });
    const capabilities = await response.json();
    if (
      capabilities.instance_id !== saved.instance_id ||
      capabilities.service !== 'paper-radar'
    )
      throw new Error('Service identity changed');
    return {
      ...saved,
      running: true,
      data_directory: paths.data,
      version: capabilities.app_version,
    };
  } catch {
    return {
      running: false,
      process_alive: true,
      data_directory: paths.data,
      error:
        'The recorded process is not responding as Paper Radar. Check its logs before restarting.',
    };
  }
}

export function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export async function start(options = {}) {
  const env = { ...process.env, ...options.env };
  const paths = runtimePaths(env);
  if (!existsSync(join(paths.publicDirectory, 'index.html')))
    throw new Error(
      'Paper Radar needs a local build. Run npm run setup:radar from PersonaStudio.',
    );
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const lockPath = join(paths.runtime, 'launcher.lock');
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = read(lockPath);
    if (!previous?.pid || alive(previous.pid))
      throw new Error(
        'Paper Radar is already starting. Try status in a moment.',
      );
    rmSync(lockPath);
    lock = openSync(lockPath, 'wx', 0o600);
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    const current = await status({ env });
    if (current.running) {
      if (
        options.port !== undefined &&
        options.port !== 0 &&
        current.port !== options.port
      )
        throw new Error(
          'This workspace is already running on a different port. Stop it before choosing another port.',
        );
      if (options.open !== false) openBrowser(current.url);
      return current;
    }
    if (current.process_alive) throw new Error(current.error);
    const dataLock = join(paths.data, 'analysis.lock');
    if (existsSync(dataLock)) {
      const pid = Number(readFileSync(dataLock, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid))
        throw new Error(
          'Another Paper Radar service is using this data directory. Stop it first, or choose a separate --home for testing.',
        );
    }

    const log = openSync(join(paths.runtime, 'server.log'), 'a', 0o600);
    const instance = randomUUID();
    let child;
    try {
      child = spawn(
        process.execPath,
        ['--experimental-strip-types', join(appRoot, 'web/server/index.mjs')],
        {
          cwd: join(appRoot, 'web'),
          detached: true,
          stdio: ['ignore', log, log],
          env: {
            ...env,
            PAPER_RADAR_INSTANCE_ID: instance,
            PAPER_RADAR_PORT: String(
              options.port ?? env.PAPER_RADAR_PORT ?? 4317,
            ),
            PAPER_RADAR_ALLOW_PORT_FALLBACK:
              options.port === undefined && !env.PAPER_RADAR_PORT ? '1' : '0',
          },
        },
      );
    } finally {
      closeSync(log);
    }
    let launchError;
    child.once('error', (error) => {
      launchError = error;
    });
    child.unref();
    for (let attempt = 0; attempt < 150; attempt++) {
      if (launchError) throw launchError;
      const state = await status({ env });
      if (state.running && state.instance_id === instance) {
        if (options.open !== false) openBrowser(state.url);
        return state;
      }
      if (child.exitCode !== null || (child.pid && !alive(child.pid))) break;
      await sleep(150);
    }
    if (child.pid && alive(child.pid)) child.kill('SIGTERM');
    throw new Error(
      `Paper Radar could not start. Read the local log: ${join(paths.runtime, 'server.log')}`,
    );
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

export async function stop(options = {}) {
  const current = await status(options);
  if (!current.running) {
    if (current.process_alive) throw new Error(current.error);
    return current;
  }
  if (options.forUpdate) {
    const response = await fetch(new URL('/api/data', current.url), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).busy)
      throw new Error('Paper Radar is busy. Finish or cancel research tasks before updating or removing it.');
  }
  process.kill(current.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!alive(current.pid))
      return { running: false, data_directory: current.data_directory };
    await sleep(100);
  }
  throw new Error(
    'Paper Radar is still finishing work. Try status again before restarting.',
  );
}

export async function main(args = process.argv.slice(2)) {
  const action = args.shift() || 'start';
  const env = { ...process.env };
  const archive = action === 'restore' ? args.shift() : null;
  let port,
    open = true,
    forUpdate = false,
    selectedData = false;
  const take = () => {
    const value = args.shift();
    if (!value || value.startsWith('--'))
      throw new Error('An option is missing its value.');
    return value;
  };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--home') env.PAPER_RADAR_HOME = resolve(take());
    else if (flag === '--data-dir') {
      env.PAPER_RADAR_STORAGE_DIR = resolve(take());
      selectedData = true;
    } else if (flag === '--port') {
      port = Number(take());
      if (
        !Number.isInteger(port) ||
        (port !== 0 && (port < 1024 || port > 65535))
      )
        throw new Error(
          'Choose a port from 1024 to 65535, or 0 for an available port.',
        );
    } else if (flag === '--no-open') open = false;
    else if (flag === '--for-update' && action === 'stop') forUpdate = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  const paths = runtimePaths(env);
  if (action === 'restore') {
    if (!archive || !selectedData)
      throw new Error(
        'Usage: paper-radar restore BACKUP.tar.gz --data-dir NEW_DIRECTORY',
      );
    const { archiveCommand } =
      await import('../web/server/runtime/data-management.mjs');
    return JSON.parse(archiveCommand('restore', resolve(archive), paths.data));
  }
  if (action === 'start') return start({ env, port, open });
  if (action === 'stop') return stop({ env, forUpdate });
  if (action === 'status') return status({ env });
  if (action === 'logs') {
    console.log(
      existsSync(join(paths.runtime, 'server.log'))
        ? readFileSync(join(paths.runtime, 'server.log'), 'utf8')
            .split('\n')
            .slice(-60)
            .join('\n')
        : 'No log yet.',
    );
    return;
  }
  if (action === 'doctor')
    return {
      node: process.version,
      platform: process.platform,
      built: existsSync(join(paths.publicDirectory, 'index.html')),
      dependencies_installed: existsSync(join(appRoot, 'web/node_modules/zod')),
      ...(await status({ env })),
    };
  throw new Error(
    'Usage: paper-radar [start|stop|status|doctor|logs] [--home DIR] [--data-dir DIR] [--port PORT] [--no-open]',
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((result) => {
      if (result) console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
