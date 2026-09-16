import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { personaProject, studioRoot } from '../runtime/paths.mjs';

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function discoverExecutable(workspace = '', env = process.env) {
  const candidates = [
    join(personaProject, '.venv/bin/ai-persona-mcp'),
    join(homedir(), '.local/bin/ai-persona-mcp'),
    ...(env.PATH || '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((dir) => join(dir, 'ai-persona-mcp')),
    ...(workspace ? [join(workspace, '.venv/bin/ai-persona-mcp')] : []),
    join(studioRoot, 'scripts/ai-persona-mcp'),
  ];
  return candidates.find(executable) || '';
}

/** Read AI Persona's public workspace setting, never infer data from source layout. */
export function discoverWorkspace(env = process.env) {
  if (env.AI_PERSONA_WORKSPACE) {
    const value = env.AI_PERSONA_WORKSPACE;
    return resolve(
      value.startsWith('~/') ? join(homedir(), value.slice(2)) : value,
    );
  }
  const path =
    env.AI_PERSONA_CONFIG ||
    join(
      env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      'ai-persona/config.toml',
    );
  if (!existsSync(path)) return '';
  // tomllib follows exactly the config syntax accepted by AI Persona.
  const python = [
    join(personaProject, '.venv/bin/python'),
    ...(env.PATH || '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((dir) => join(dir, 'python3')),
  ].find(executable);
  if (!python) return '';
  const result = spawnSync(
    python,
    [
      '-c',
      'import pathlib,sys,tomllib; p=pathlib.Path(sys.argv[1]); v=tomllib.loads(p.read_text()).get("defaults",{}).get("workspace",""); print(pathlib.Path(v).expanduser().resolve() if isinstance(v,str) and v.strip() else "")',
      path,
    ],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 32768 },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}
