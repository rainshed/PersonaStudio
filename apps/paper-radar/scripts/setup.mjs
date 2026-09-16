import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'components.json'), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('Paper Radar requires Node.js 22.19 or newer.');
for (const [name, component] of Object.entries(manifest.components)) {
  const installed = JSON.parse(await readFile(resolve(root, component.path, 'package.json'), 'utf8'));
  if (installed.version !== component.version) throw new Error(`${name} version ${installed.version} does not match component manifest ${component.version}.`);
}
async function run(args, path) {
  const child = spawn('npm', args, { cwd: resolve(root, path), stdio: 'inherit' });
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? done() : reject(new Error(`npm ${args.join(' ')} failed (${code}).`)));
  });
}
const args = new Set(process.argv.slice(2));
const allowed = new Set(['--verify', '--check-only']);
if ([...args].some((arg) => !allowed.has(arg))) throw new Error('Usage: node scripts/setup.mjs [--verify] [--check-only]');
if (!args.has('--check-only')) {
  await run(['ci', '--no-audit', '--no-fund'], manifest.components.dshPlugin.path);
  await run(['ci', '--no-audit', '--no-fund'], manifest.components.web.path);
}
if (args.has('--verify') || args.has('--check-only')) {
  await run(['test'], manifest.components.dshPlugin.path);
  await run(['run', 'check'], manifest.components.web.path);
  await run(['run', 'build'], manifest.components.web.path);
}
console.log(`Paper Radar: component versions verified; ${args.has('--check-only') ? 'checks complete' : 'dependencies installed from lockfiles'}.`);
