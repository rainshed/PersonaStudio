import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readBackendResponse,
  isStandaloneDemo,
  browserRequestId,
} from '../lib/backend-response.ts';
import { analysisApi } from '../lib/analysis-api.ts';

void test('valid backend JSON survives missing or rewritten content-type during remote forwarding', async () => {
  for (const type of [
    undefined,
    'text/plain',
    'Application/JSON',
    'application/json; charset=utf-8',
  ]) {
    const response = new Response('{"mode":"local","single_analysis":true}', {
      headers: type ? { 'Content-Type': type } : {},
    });
    if (!type) response.headers.delete('Content-Type');
    assert.equal((await readBackendResponse(response)).single_analysis, true);
  }
});

void test('HTML and invalid payloads do not become successful backend responses', async () => {
  await assert.rejects(
    readBackendResponse(new Response('<html>private gateway details</html>')),
    (error) => {
      assert.match(error.message, /HTTP 200/);
      assert.ok(!error.message.includes('private gateway details'));
      return true;
    },
  );
  for (const payload of ['null', '[]', '"text"'])
    await assert.rejects(
      readBackendResponse(new Response(payload)),
      /格式无法识别/,
    );
  await assert.rejects(
    readBackendResponse(new Response('upstream unavailable', { status: 502 })),
    /HTTP 502/,
  );
});

void test('authorization and API failures remain errors even with parseable JSON', async () => {
  await assert.rejects(
    readBackendResponse(
      new Response('{"error":"仅允许本机访问"}', { status: 403 }),
    ),
    /仅允许本机访问/,
  );
  await assert.rejects(
    readBackendResponse(
      new Response('{"ok":false,"error":{"message":"不允许跨站请求"}}'),
    ),
    /不允许跨站请求/,
  );
});

void test('remote entry points are never silently classified as standalone demos', () => {
  for (const hostname of [
    '100.64.0.7',
    'computer.example.ts.net',
    'localhost',
    '127.0.0.1',
  ])
    assert.equal(isStandaloneDemo({ hostname, port: '4317' }), false);
  assert.equal(
    isStandaloneDemo({
      hostname: 'legacy-demo.example.org',
      port: '',
    }),
    false,
  );
  assert.equal(
    isStandaloneDemo({ hostname: '127.0.0.1', port: '3000' }),
    false,
  );
});

void test('demo requires an explicit mode and works independently of a developer hostname', () => {
  assert.equal(
    isStandaloneDemo({ hostname: 'example.org', port: '' }, 'demo'),
    true,
  );
  assert.equal(
    isStandaloneDemo({ hostname: 'example.org', port: '' }, 'local'),
    false,
  );
});

void test('request identifiers work when randomUUID is unavailable on a private HTTP origin', () => {
  let calls = 0;
  const id = browserRequestId({
    getRandomValues(bytes) {
      calls++;
      bytes.fill(0xff);
      return bytes;
    },
  });
  assert.equal(calls, 1);
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

void test('analysis client uses its current entry point and retains mutation request protection', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('{"saved":true}', {
      headers: { 'Content-Type': 'text/plain' },
    });
  });
  const result = await analysisApi('analyses', {
    method: 'POST',
    body: { fixture: true },
    key: 'request-fixture-id',
  });
  assert.equal(result.saved, true);
  assert.equal(calls[0].url, '/api/analyses');
  assert.equal(calls[0].options.headers['X-Paper-Radar'], '1');
  assert.equal(
    calls[0].options.headers['Idempotency-Key'],
    'request-fixture-id',
  );
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});
