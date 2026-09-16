#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const checkOnly = process.argv.includes('--check-only');
if (
  process.argv
    .slice(2)
    .some((arg) => !['--check', '--check-only'].includes(arg))
)
  throw new Error('Usage: setup-paper-radar.mjs [--check|--check-only]');
async function run(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, PAPER_RADAR_REQUIRE_PERSONA_TESTS: '1' },
  });
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`${command} failed (${code})`)),
    );
  });
}
try {
  if (!checkOnly) {
    await run('uv', [
      'sync',
      '--locked',
      '--project',
      'apps/ai-persona',
      '--extra',
      'dev',
    ]);
    await run(
      process.execPath,
      ['scripts/setup.mjs', ...(check ? ['--verify'] : [])],
      join(root, 'apps/paper-radar'),
    );
    if (!check)
      await run('npm', ['run', 'build'], join(root, 'apps/paper-radar/web'));
  } else {
    await run(
      process.execPath,
      ['scripts/setup.mjs', '--check-only'],
      join(root, 'apps/paper-radar'),
    );
  }
  if (check || checkOnly)
    await run(process.execPath, ['scripts/check-radar-runtime.mjs']);
  console.log(
    check || checkOnly
      ? 'Paper Radar checks complete; no release was created.'
      : 'Paper Radar is ready. Run npm start to open it.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
