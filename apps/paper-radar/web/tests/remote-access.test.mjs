import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelServer } from '../server/index.mjs';
import { parsePublicOrigin } from '../server/public-origin.mjs';

const publicOrigin = 'https://radar.example.ts.net';
const publicHost = 'radar.example.ts.net';

async function fixture(t, origin) {
  const directory = await mkdtemp(join(tmpdir(), 'paper-radar-access-'));
  await writeFile(join(directory, 'index.html'), '<html>Paper Radar</html>');
  const writes = [];
  const server = createModelServer(
    {
      config: () => ({ writes }),
      routing: (input) => {
        writes.push(input);
        return { saved: true };
      },
    },
    {
      publicDirectory: directory,
      publicOrigin: origin,
      daily: {
        saveSubscription: (input, id) => {
          writes.push({ ...input, id });
          return { ...input, id };
        },
      },
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
    await rm(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  const send = ({
    path = '/api/models/config',
    method = 'GET',
    headers = {},
    body = '{}',
  } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        { hostname: '127.0.0.1', port, path, method, headers },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.end(method === 'GET' ? undefined : body);
    });
  return { send, port, writes };
}

void test('remote access is opt-in and forwarded headers cannot enable it', async (t) => {
  const { send, port } = await fixture(t);
  assert.equal((await send()).status, 200);
  assert.equal(
    (await send({ headers: { Host: `localhost:${port}` } })).status,
    200,
  );
  assert.equal((await send({ headers: { Host: publicHost } })).status, 403);
  assert.equal((await send({ headers: { Origin: publicOrigin } })).status, 403);
  assert.equal(
    (
      await send({
        headers: {
          Host: publicHost,
          'X-Forwarded-Host': `localhost:${port}`,
          'X-Forwarded-Proto': 'http',
        },
      })
    ).status,
    403,
  );
});

void test('configured HTTPS entry serves UI, reads, POST and PATCH through either proxy Host form', async (t) => {
  const { send, port, writes } = await fixture(t, publicOrigin);
  for (const host of [publicHost, `127.0.0.1:${port}`]) {
    const headers = {
      Host: host,
      Origin: publicOrigin,
      'Sec-Fetch-Site': 'same-origin',
      'X-Paper-Radar': '1',
      'Content-Type': 'application/json',
    };
    assert.equal((await send({ path: '/', headers })).status, 200);
    assert.equal((await send({ headers })).status, 200);
    const saved = await send({
      path: '/api/models/routing',
      method: 'POST',
      headers,
      body: '{"defaultConnectionId":"test"}',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.text), { saved: true });
    assert.equal(
      (
        await send({
          path: '/api/subscriptions/test',
          method: 'PATCH',
          headers,
          body: '{"name":"mobile"}',
        })
      ).status,
      200,
    );
  }
  assert.equal(writes.length, 4);
  assert.equal(JSON.parse((await send()).text).writes[1].name, 'mobile');
  assert.equal(
    (await send({ headers: { Origin: `http://127.0.0.1:${port}` } })).status,
    200,
  );
});

void test('remote entry rejects foreign hosts, scheme or port mismatches and unsafe writes', async (t) => {
  const { send, writes } = await fixture(t, publicOrigin);
  const headers = {
    Host: publicHost,
    Origin: publicOrigin,
    'Sec-Fetch-Site': 'same-origin',
    'X-Paper-Radar': '1',
    'Content-Type': 'application/json',
  };
  for (const change of [
    { Host: 'evil.example' },
    { Host: `${publicHost}.evil.example` },
    { Host: `${publicHost}:444` },
    { Origin: 'https://evil.example' },
    { Origin: `http://${publicHost}` },
    { Origin: `${publicOrigin}:444` },
    { Origin: 'null' },
    {
      Origin: 'https://evil.example',
      'X-Forwarded-Host': publicHost,
      'X-Forwarded-Proto': 'https',
    },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'X-Paper-Radar': '' },
    { 'Content-Type': 'text/plain' },
  ]) {
    assert.equal(
      (
        await send({
          path: '/api/models/routing',
          method: 'POST',
          headers: { ...headers, ...change },
        })
      ).status,
      403,
      JSON.stringify(change),
    );
  }
  assert.equal(writes.length, 0);
});

void test('an explicitly configured private HTTP port is matched exactly', async (t) => {
  const origin = 'http://100.64.0.1:8080';
  const { send } = await fixture(t, origin);
  assert.equal(
    (await send({ headers: { Host: '100.64.0.1:8080', Origin: origin } }))
      .status,
    200,
  );
  assert.equal(
    (await send({ headers: { Host: '100.64.0.1', Origin: origin } })).status,
    403,
  );
});

void test('invalid external origin fails before serving requests', () => {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(''), null);
  assert.equal(parsePublicOrigin(`${publicOrigin}/`).origin, publicOrigin);
  for (const value of [
    '*',
    'null',
    'radar.example.ts.net',
    'ftp://radar.example.ts.net',
    `${publicOrigin}/radar`,
    `${publicOrigin}?x=1`,
    `${publicOrigin}#x`,
    'https://user:pass@radar.example.ts.net',
  ]) {
    assert.throws(() => parsePublicOrigin(value), /PAPER_RADAR_PUBLIC_ORIGIN/);
  }
});
