import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { AnalysisError } from '../analyses/contracts.mjs';

const helper = fileURLToPath(
  new URL('./macos-path-picker.jxa', import.meta.url),
);
const inputSchema = z
  .object({
    kind: z.enum(['workspace', 'executable']),
    initial_path: z.string().max(4096).default(''),
    language: z.enum(['zh', 'en']).default('zh'),
  })
  .strict();
const outputSchema = z
  .object({ path: z.string().min(1).max(4096).nullable() })
  .strict();
const cleanPath = (value) => !['\0', '\r', '\n'].some((c) => value.includes(c));

function initialDirectory(value) {
  const expanded = value.startsWith('~/')
    ? join(homedir(), value.slice(2))
    : value;
  if (!isAbsolute(expanded) || !cleanPath(expanded)) return homedir();
  let current = resolve(expanded);
  while (true) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      /* Start at the closest existing parent of an edited path. */
    }
    const parent = dirname(current);
    if (parent === current) return homedir();
    current = parent;
  }
}

/** Owns only Paper Radar's native open panel; it does not automate other apps. */
export class PersonaPathPicker {
  constructor({ platform = process.platform, run = promisify(execFile) } = {}) {
    this.available = platform === 'darwin';
    this.run = run;
    this.active = null;
    this.closed = false;
  }
  async pick(raw, signal) {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success)
      throw new AnalysisError(
        'invalid_picker_request',
        '请选择知识库文件夹或 AI Persona 程序。',
      );
    if (!this.available)
      throw new AnalysisError(
        'picker_unavailable',
        '此系统暂不支持选择窗口，请输入完整路径。',
        false,
        501,
      );
    if (this.closed)
      throw new AnalysisError(
        'unavailable',
        '服务正在关闭，请稍后重试。',
        true,
        503,
      );
    if (this.active)
      throw new AnalysisError(
        'picker_busy',
        '已有一个选择窗口，请先完成或取消选择。',
        false,
        409,
      );
    signal?.throwIfAborted();
    const { kind, initial_path, language } = parsed.data;
    const controller = new AbortController();
    /** @type {{ controller: AbortController, work: Promise<{ stdout: string }> | null }} */
    const active = { controller, work: null };
    this.active = active;
    try {
      // Pass values as argv to a fixed helper, never as script or shell source.
      active.work = this.run(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          helper,
          kind,
          initialDirectory(initial_path),
          language,
        ],
        {
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
          timeout: 590000,
          maxBuffer: 32768,
          encoding: 'utf8',
        },
      );
      const { stdout } = await active.work;
      const result = outputSchema.parse(JSON.parse(stdout.trim()));
      if (result.path !== null) {
        if (!isAbsolute(result.path) || !cleanPath(result.path))
          throw new Error('Invalid path');
        const entry = statSync(result.path);
        if (kind === 'workspace' ? !entry.isDirectory() : !entry.isFile())
          throw new Error('Unexpected selection type');
      }
      return result;
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) return { path: null };
      throw new AnalysisError(
        'picker_failed',
        error.killed
          ? '选择窗口已超时，请重新选择或输入完整路径。'
          : '无法完成选择，请重试或输入完整路径。',
        true,
      );
    } finally {
      if (this.active === active) this.active = null;
    }
  }
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    await this.active?.work?.catch(() => {});
  }
}
