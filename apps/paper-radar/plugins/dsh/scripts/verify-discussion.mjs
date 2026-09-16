import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisDatabase } from '../../../web/server/analyses/database.mjs';
import { AnalysisService } from '../../../web/server/analyses/service.mjs';
import { ArxivReader } from '../../../web/server/analyses/arxiv.mjs';
import { DiscussionService } from '../../../web/server/discussions/service.mjs';
import { DshModelService } from '../../../web/server/hosts/dsh/models.mjs';
import { defaultSocket } from '../src/transport.mjs';

if (!process.argv.includes('--run')) throw new Error('此检查会调用真实模型；执行时请明确添加 --run。');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'radar-live-discussion-'));
const db = await new AnalysisDatabase(directory).open();
const models = await new DshModelService({ socketPath: defaultSocket(), directory: join(directory, 'routing') }).open();
const analyses = new AnalysisService(db, models, new ArxivReader(join(homedir(), '.local/share/paper-radar/data/cache/papers')), { async close() {}, async snapshot() { throw new Error('此检查不读取 Persona'); } });
const discussions = new DiscussionService(analyses, null, { executionMs: 180000 });
try {
  const { conversation } = discussions.create({ input: { arxiv_input: '2412.18602v4', scope: { tag_ids: [], tag_match: 'any' }, language: 'zh', summary_length: { min: 800, max: 1200 } } });
  await models.withContext({ explicit: { reasoningEffort: 'low' } }, () => discussions.send(conversation.id, { question: '本文研究哪一种物理模型（transverse-field Ising model）？请用两句话说明，引用论文原文证据。' }, 'live-discussion-smoke'));
  let current;
  do { current = discussions.get(conversation.id); if (['queued', 'running'].includes(current.turns[0].status)) await delay(1000); } while (['queued', 'running'].includes(current.turns[0].status));
  await mkdir(join(root, '../../work/dsh'), { recursive: true });
  await writeFile(join(root, `../../work/dsh/real-discussion-${Date.now()}.json`), JSON.stringify({ date: new Date().toISOString(), conversation: current, calls: models.runs }, null, 2) + '\n');
  console.log(JSON.stringify({ status: current.turns[0].status, answer: current.turns[0].answer, error: current.turns[0].error, calls: models.runs.map((r) => ({ model: r.model_id, effort: r.reasoning_effort, status: r.status, usage: r.usage })) }, null, 2));
  if (current.turns[0].status !== 'succeeded') process.exitCode = 1;
} finally { await discussions.close(); await analyses.close(); await models.close(); await db.close(); await rm(directory, { recursive: true, force: true }); }
