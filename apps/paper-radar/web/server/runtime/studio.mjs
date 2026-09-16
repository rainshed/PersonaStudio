import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { studioRoot } from './paths.mjs';

const openings = new Map();
const opened = new Map();
/** Launch only the bundled Persona command; the browser cannot supply a program. */
export async function openPersona(workspace) {
  const key = workspace || 'setup';
  const previous = opened.get(key);
  if (previous) {
    try {
      const response = await fetch(previous, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return { url: previous };
    } catch {
      /* Start a new local service if the old one stopped. */
    }
    opened.delete(key);
  }
  if (openings.has(key)) return openings.get(key);
  const opening = new Promise((done, reject) => {
    const child = spawn(
      join(studioRoot, 'scripts/ai-persona'),
      workspace
        ? ['start', '--workspace', workspace, '--no-open']
        : ['setup', '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    let output = '',
      settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.unref();
      child.stderr.unref();
      child.unref();
      if (error) reject(error);
      else {
        opened.set(key, result.url);
        done(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('AI Persona 启动超时，请检查本机安装。'));
    }, 45000);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-65536);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/?/);
      if (match) finish(null, { url: match[0] });
    });
    // Keep draining output after setup opens; never return local logs to a browser.
    child.stderr.on('data', () => {});
    child.once('error', () =>
      finish(new Error('无法启动 AI Persona，请先完成本机安装。')),
    );
    child.once('exit', () =>
      finish(
        new Error('AI Persona 未能打开。请检查工作区或已运行的 Persona。'),
      ),
    );
  }).finally(() => {
    openings.delete(key);
  });
  openings.set(key, opening);
  return opening;
}
