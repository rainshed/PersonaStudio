// Local-only browser regression fixture. No real models, credentials or Persona data.
// Run: node --experimental-strip-types tests/helpers/ui-preview.mjs
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fixture,
  context,
  subscription,
  subject,
  feed,
  xmlEntry,
} from './daily-fixture.mjs';
import { parseFeed } from '../../server/daily/discovery.mjs';
import { createModelServer } from '../../server/index.mjs';
import { AnalysisError } from '../../server/analyses/contracts.mjs';
import { DailyScheduler } from '../../server/daily/scheduler/service.mjs';
const cleanup = [];
const f = await fixture(
  { after: (fn) => cleanup.push(fn) },
  {
    count: 3,
    finalDecision: process.argv.includes('--negative-opinion')
      ? 'not_recommended'
      : 'recommended',
    outcome: (paper) =>
      paper.id.endsWith('2') ? 'needs_fulltext' : 'recommended',
    modelDelay: 100,
  },
);
const scheduler = new DailyScheduler(f.daily);
cleanup.push(() => scheduler.close());
f.analyses.persona.tags = async () => ({
  tags: context.tags,
  connection_id: context.identity,
  persona_revision: context.revision,
  next_cursor: null,
});
const created = f.create();
await f.finish(created.run.id);
const paperA = f.daily.items(created.run.id).items[0];
await f.detail(paperA.id);
const paperB = f.repo.items(created.run.id)[1];
f.repo.saveItem({
  ...paperB,
  details_status: 'failed',
  details_error: {
    code: 'fixture_failure',
    message: '测试：详细分析连接暂时失败，请重试。',
    retryable: true,
  },
  paper: { ...paperB.paper, authors: [String.raw`Milo\v{s} Milovanovi\'c`] },
});
await f.daily.saveSubscription({
  ...subscription,
  name: 'Quantum test',
  subject: 'quant-ph',
  status: 'paused',
});
// Cover operation errors independently from refresh and a successful second attempt.
const originalAnalyze = f.daily.analyzeItem.bind(f.daily);
let failedOnce = false;
f.daily.analyzeItem = (id, key, body) => {
  if (id === paperB.id && !failedOnce) {
    failedOnce = true;
    throw new AnalysisError(
      'fixture_submit',
      '测试：提交失败。页面刷新不应清除此错误。',
      true,
    );
  }
  return originalAnalyze(id, key, body);
};
if (process.argv.includes('--cancelled')) {
  const current = f.repo.get('daily_runs', created.run.id);
  f.repo.saveRun({
    ...current,
    status: 'cancelled',
    message: '日报已取消，已完成内容保留。',
  });
}
const quantXml = feed(
  xmlEntry('2501.10000', 'cross') + xmlEntry('2501.10003', 'new'),
).replaceAll(subject, 'quant-ph');
const quantRevision = f.repo.archiveFeed({
  ...parseFeed(quantXml, 'quant-ph'),
  xml: quantXml,
  url: 'https://rss.arxiv.org/atom/quant-ph',
})[0];
f.daily.discovery.latest = async (category, signal) => {
  signal.throwIfAborted();
  if (category === subject) return f.revision;
  if (category === 'quant-ph') return quantRevision;
  throw new AnalysisError(
    'fixture_source',
    '测试环境仅提供 cond-mat.stat-mech 和 quant-ph 来源。',
    true,
  );
};
// Optional delay applies only after fixture seeding, for deterministic UI
// cancellation checks without contacting a model provider.
const previewDelay = Number(
  process.env.PAPER_RADAR_PREVIEW_MODEL_DELAY_MS ?? 0,
);
if (previewDelay > 0) {
  const originalRun = f.models.run.bind(f.models);
  f.models.run = async (request, options) => {
    await delay(previewDelay, undefined, { signal: options.signal });
    return originalRun(request, options);
  };
}
const server = createModelServer(f.models, {
  daily: f.daily,
  analyses: f.analyses,
  publicDirectory: fileURLToPath(new URL('../../dist/client', import.meta.url)),
});
const previewPort = Number(process.env.PAPER_RADAR_PREVIEW_PORT ?? 4318);
server.listen(previewPort, '127.0.0.1', () =>
  console.log(
    `Isolated UI regression preview: http://127.0.0.1:${previewPort}/`,
  ),
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const fn of cleanup.reverse()) await fn();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
