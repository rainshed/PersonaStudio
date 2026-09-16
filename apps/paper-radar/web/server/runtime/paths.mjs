import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const studioRoot = resolve(appRoot, '../..');
export const personaProject = resolve(appRoot, '../ai-persona');

/** Keep the existing data layout; an explicit home isolates every Radar service. */
export function runtimePaths(env = process.env) {
  const home = resolve(
    env.PAPER_RADAR_HOME || join(homedir(), '.local/share/paper-radar'),
  );
  const data = resolve(env.PAPER_RADAR_STORAGE_DIR || join(home, 'data'));
  const models = resolve(env.PAPER_RADAR_DATA_DIR || join(home, 'models'));
  return {
    home,
    data,
    models,
    hosts: resolve(models, '../hosts'),
    codex: resolve(models, '../codex'),
    dsh: resolve(models, '../dsh'),
    legacyDsh: resolve(models, '../harness'),
    personaConfig: resolve(
      env.PAPER_RADAR_PERSONA_CONFIG || join(data, 'persona.json'),
    ),
    runtime: join(data, '.runtime'),
    publicDirectory: join(appRoot, 'web/dist/client'),
  };
}
