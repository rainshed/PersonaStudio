// Explicit smoke check: uses real host inference, an isolated database, and no Persona records.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisDatabase } from '../../../web/server/analyses/database.mjs';
import { AnalysisService } from '../../../web/server/analyses/service.mjs';
import { ArxivReader } from '../../../web/server/analyses/arxiv.mjs';
import { DshModelService } from '../../../web/server/hosts/dsh/models.mjs';
import { defaultSocket } from '../src/transport.mjs';

if (!process.argv.includes('--run')) throw new Error('此检查会调用真实模型；执行时请明确添加 --run。');
const paper = process.argv.find((arg) => /^\d{4}\.\d{4,5}v\d+$/.test(arg)) ?? '2412.18602v4';
const language = process.argv.includes('--english') ? 'en' : 'zh';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'radar-live-analysis-'));
const db = await new AnalysisDatabase(directory).open();
const models = await new DshModelService({ socketPath: defaultSocket(), directory: join(directory, 'routing') }).open();
const analyses = new AnalysisService(db, models, new ArxivReader(join(homedir(), '.local/share/paper-radar/data/cache/papers')), { async close() {}, async snapshot() { throw new Error('此检查不允许读取 Persona'); } }, { maxAttempts: 4, executionMs: 6 * 60000 });
try {
  const admitted = await models.withContext({ parent: 'single', explicit: { reasoningEffort: 'low' } }, () => analyses.create({ arxiv_input: paper, scope: { tag_ids: [], tag_match: 'any' }, language, summary_length: language === 'en' ? { min: 200, max: 400 } : { min: 800, max: 1200 } }, 'real-host-analysis-smoke'));
  let job, previous;
  do {
    job = analyses.getJob(admitted.job.id);
    if (job.step !== previous) { console.log(JSON.stringify({ step: job.step, status: job.status })); previous = job.step; }
    if (['queued', 'running'].includes(job.status)) await delay(1000);
  } while (['queued', 'running'].includes(job.status));
  const result = job.result_id ? analyses.getResult(job.result_id) : null;
  const evidence = { date: new Date().toISOString(), paper, status: job.status, error: job.error, summaryStatus: result?.summary.status, attempts: result?.attempts, model: db.job(job.id).model_settings.dsh.selections.summary, result };
  await mkdir(join(root, '../../work/dsh'), { recursive: true });
  await writeFile(join(root, `../../work/dsh/real-analysis-${Date.now()}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error, summaryStatus: evidence.summaryStatus, calls: evidence.attempts?.length, providers: evidence.attempts?.map((a) => ({ provider: a.provider_id, model: a.model_id, effort: a.reasoning_effort, status: a.status, usage: a.usage })) }, null, 2));
  if (job.status !== 'succeeded') process.exitCode = 1;
} finally { await analyses.close(); await models.close(); await db.close(); await rm(directory, { recursive: true, force: true }); }
