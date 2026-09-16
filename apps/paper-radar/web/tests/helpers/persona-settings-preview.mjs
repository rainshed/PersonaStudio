// Isolated UI preview. Connection changes use temporary fixtures, no personal data.
import { fileURLToPath } from 'node:url';
import { fixture } from './daily-fixture.mjs';
import { personaSettingsFixture } from './persona-settings-fixture.mjs';
import { personaConnectionId } from '../../server/persona/query-client.mjs';
import { createModelServer } from '../../server/index.mjs';
const cleanup = [];
const test = { after: (fn) => cleanup.push(fn) };
const f = await fixture(test);
const local = await personaSettingsFixture(test, { configured: !process.argv.includes('--disconnected') });
await local.settings.close();
f.analyses.persona = local.persona;
f.daily.persona = local.persona;
f.repo.saveSubscription({
  ...f.sub,
  persona_connection_id: personaConnectionId(local.config),
});
const server = createModelServer(f.models, {
  analyses: f.analyses,
  daily: f.daily,
  publicDirectory: fileURLToPath(new URL('../../dist/client', import.meta.url)),
});
f.analyses.personaSettings.makeClient = local.makeClient;
const port = Number(process.env.PAPER_RADAR_PREVIEW_PORT ?? 4319);
server.listen(port, '127.0.0.1', () =>
  console.log(`Persona settings preview: http://127.0.0.1:${port}/#models`),
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const fn of cleanup.reverse()) await fn();
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
