#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [application = 'paper-radar', ...args] = process.argv.slice(2);
if (!['paper-radar', 'ai-persona'].includes(application)) {
  console.error(
    'Usage: personastudio [paper-radar|ai-persona] [start|stop|status|doctor|logs|…]',
  );
  process.exitCode = 1;
} else {
  const child = spawn(
    join(root, 'scripts', application),
    args.length ? args : ['start'],
    { stdio: 'inherit' },
  );
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
