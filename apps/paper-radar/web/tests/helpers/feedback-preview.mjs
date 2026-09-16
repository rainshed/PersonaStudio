// Isolated UI check with local fixture models and disposable SQLite data.
import { fileURLToPath } from 'node:url';
import { fixture, context } from './daily-fixture.mjs';
import { createModelServer } from '../../server/index.mjs';
const cleanup = [];
const f = await fixture(
  { after: (fn) => cleanup.push(fn) },
  {
    count: 3,
    outcome: (paper) =>
      paper.id.endsWith('2') ? 'not_recommended' : 'recommended',
  },
);
f.analyses.persona.tags = async () => ({
  tags: context.tags,
  connection_id: context.identity,
  persona_revision: context.revision,
  next_cursor: null,
});
const connection = f.models.store.state.settings.connections[0];
connection.reasoningEffort = 'low';
f.models.config = async () => ({
  connected: true,
  catalog: {
    groups: [
      {
        models: [
          {
            name: '本地测试模型',
            provider: connection.providerId,
            model: connection.modelId,
            reasoning: {
              defaultEffort: 'low',
              efforts: [
                { id: 'low', name: '低' },
                { id: 'high', name: '高' },
              ],
            },
          },
        ],
      },
    ],
  },
  routing: {
    revision: 0,
    tasks: {
      screen: {
        model: { provider: connection.providerId, model: connection.modelId },
        reasoningEffort: 'low',
      },
    },
    fallback: { enabled: false },
  },
});
const run = await f.finish(f.create().run.id);
const items = f.repo.items(run.id);
// Exercise the user's historical-data case: labels exist without old inputs.
const oldVersion = f.repo.get(
  'daily_item_versions',
  items[1].screening_version_id,
);
delete oldVersion.input_snapshot_id;
f.db.db
  .prepare('UPDATE daily_item_versions SET data=? WHERE id=?')
  .run(JSON.stringify(oldVersion), oldVersion.id);
f.daily.feedback(items[1].screening_version_id, 'accuracy', {
  value: 'negative',
});
const detail = await f.detail(items[0].id);
const oldResult = f.db.result(detail.job.result_id);
delete oldResult.input_snapshot_id;
f.db.db
  .prepare('UPDATE results SET data=? WHERE id=?')
  .run(JSON.stringify(oldResult), oldResult.id);
f.analyses.feedback(oldResult.id, 'accuracy', { value: 'positive' });
const server = createModelServer(f.models, {
  daily: f.daily,
  analyses: f.analyses,
  publicDirectory: fileURLToPath(new URL('../../dist/client', import.meta.url)),
});
server.listen(4398, '127.0.0.1', () =>
  console.log('Feedback preview: http://127.0.0.1:4398/'),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const fn of cleanup.reverse()) await fn();
  process.exit(0);
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
