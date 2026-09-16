import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  matchedFollowedAuthors,
  uniqueAuthorNames,
} from '../lib/author-following.ts';
import {
  fixture,
  subject,
  xmlEntry,
  feed,
  subscription,
} from './helpers/daily-fixture.mjs';
import { parseFeed } from '../server/daily/discovery.mjs';
import { createModelServer } from '../server/index.mjs';
import {
  readRadarLocation,
  radarHash,
  defaultLocation,
} from '../lib/radar-location.ts';

function archive(repo, category, specs, date = '2026-09-08') {
  const xml = feed(
    specs
      .map(({ id, name = 'Wei Wang', version = 1, type = 'new' }) =>
        xmlEntry(id, type, version, date).replace('Example Author', name),
      )
      .join(''),
  ).replaceAll(subject, category);
  return repo.archiveFeed({
    ...parseFeed(xml, category),
    xml,
    url: `https://rss.arxiv.org/atom/${category}`,
  })[0];
}
function follow(f, names) {
  const current = f.repo.get('subscriptions', f.sub.id);
  const saved = f.daily.saveFollowedAuthors(f.sub.id, {
    expected_revision: current.revision,
    followed_authors: names,
  });
  Object.assign(f.sub, saved);
  return saved;
}

void test('full author names and any selected subject are both required', () => {
  const scope = {
    subjects: [subject, 'quant-ph'],
    followed_authors: [' Wei  Wang ', 'Wei Wang', 'Éva Test'],
  };
  assert.deepEqual(uniqueAuthorNames(scope.followed_authors), [
    'Wei Wang',
    'Éva Test',
  ]);
  assert.deepEqual(
    matchedFollowedAuthors(
      { authors: ['WEI\tWANG', 'E\u0301va Test'], categories: ['quant-ph'] },
      scope,
    ),
    ['Wei Wang', 'Éva Test'],
  );
  for (const name of ['W. Wang', 'Wang Wei', 'Wei Wang Jr.', 'Eva Test'])
    assert.deepEqual(
      matchedFollowedAuthors({ authors: [name], categories: [subject] }, scope),
      [],
    );
  assert.deepEqual(
    matchedFollowedAuthors(
      { authors: ['Wei Wang'], categories: ['cs.AI'] },
      scope,
    ),
    [],
  );
  assert.deepEqual(
    matchedFollowedAuthors(
      { authors: ['Wei Wang'], categories: [subject] },
      { subject },
    ),
    [],
  );
});

void test('following persists per subscription without Persona, validates input and prevents stale writes', async (t) => {
  const f = await fixture(t);
  const other = await f.daily.saveSubscription({
    ...subscription,
    name: 'Other',
  });
  f.daily.persona.scopeReader = async () => {
    throw new Error('Persona offline');
  };
  const previous = f.sub.revision;
  follow(f, [' Example   Author ', 'example author']);
  assert.deepEqual(f.repo.get('subscriptions', f.sub.id).followed_authors, [
    'Example Author',
  ]);
  assert.equal(f.daily.followedAuthorFeed(f.sub.id).total, 3);
  assert.equal(f.daily.followedAuthorFeed(other.id).total, 0);
  assert.equal(f.calls, 0);
  assert.throws(
    () =>
      f.daily.saveFollowedAuthors(f.sub.id, {
        expected_revision: previous,
        followed_authors: [],
      }),
    { code: 'conflict' },
  );
  for (const names of [
    null,
    [''],
    ['   '],
    ['x'.repeat(151)],
    Array(201).fill('name'),
  ])
    assert.throws(
      () =>
        f.daily.saveFollowedAuthors(f.sub.id, {
          expected_revision: f.sub.revision,
          followed_authors: names,
        }),
      { code: 'invalid_settings' },
    );
  assert.throws(
    () =>
      f.daily.saveFollowedAuthors(f.sub.id, {
        expected_revision: f.sub.revision,
        followed_authors: [],
        subjects: ['cs.AI'],
      }),
    { code: 'invalid_request' },
  );
  follow(f, []);
  assert.equal(f.daily.followedAuthorFeed(f.sub.id).total, 0);
  assert.equal(
    f.repo.announcementForDate(subject, '2026-09-07').papers.length,
    3,
  );
});

void test('archived author papers merge categories and versions, and follow the current subject selection', async (t) => {
  const f = await fixture(t);
  follow(f, ['Wei Wang']);
  archive(f.repo, subject, [
    { id: '2501.12001' },
    { id: '2501.12002', name: 'W. Wang' },
  ]);
  archive(f.repo, 'quant-ph', [
    { id: '2501.12001', type: 'cross' },
    { id: '2501.12003' },
  ]);
  archive(f.repo, 'cs.AI', [{ id: '2501.12004' }]);
  Object.assign(
    f.sub,
    await f.daily.saveSubscription(
      { expected_revision: f.sub.revision, subjects: [subject, 'quant-ph'] },
      f.sub.id,
    ),
  );
  let result = f.daily.followedAuthorFeed(f.sub.id);
  assert.deepEqual(
    result.papers.map((p) => p.id),
    ['2501.12001', '2501.12003'],
  );
  assert.deepEqual(result.papers[0].matched_subjects, [subject, 'quant-ph']);
  archive(
    f.repo,
    subject,
    [{ id: '2501.12001', version: 2, type: 'replace' }],
    '2026-09-09',
  );
  result = f.daily.followedAuthorFeed(f.sub.id);
  assert.equal(result.total, 2);
  assert.equal(result.papers[0].version, 2);
  assert.equal(result.papers[0].date, '2026-09-09');
  Object.assign(
    f.sub,
    await f.daily.saveSubscription(
      { expected_revision: f.sub.revision, subjects: ['cs.AI'] },
      f.sub.id,
    ),
  );
  assert.deepEqual(
    f.daily.followedAuthorFeed(f.sub.id).papers.map((p) => p.id),
    ['2501.12004'],
  );
  assert.equal(f.calls, 0);
});

void test('corrected same-day revisions replace earlier matches rather than resurrecting removed authors', async (t) => {
  const f = await fixture(t);
  follow(f, ['Wei Wang']);
  archive(f.repo, subject, [{ id: '2501.12001' }]);
  assert.equal(f.daily.followedAuthorFeed(f.sub.id).total, 1);
  archive(f.repo, subject, [{ id: '2501.12001', name: 'Other Author' }]);
  assert.equal(f.daily.followedAuthorFeed(f.sub.id).total, 0);
});

void test('refresh reads only selected subjects, retains available papers on failure and spends no model calls', async (t) => {
  const f = await fixture(t);
  Object.assign(
    f.sub,
    await f.daily.saveSubscription(
      { expected_revision: f.sub.revision, subjects: [subject, 'quant-ph'] },
      f.sub.id,
    ),
  );
  follow(f, ['Example Author']);
  const requested = [];
  f.daily.discovery.latest = async (id) => {
    requested.push(id);
    if (id === 'quant-ph') throw new Error('Source offline');
    return archive(f.repo, subject, [
      { id: '2501.12001', name: 'Example Author' },
    ]);
  };
  const result = await f.daily.refreshFollowedAuthors(f.sub.id);
  assert.deepEqual(requested, [subject, 'quant-ph']);
  assert.equal(result.total, 4);
  assert.equal(
    result.sources.find((s) => s.subject === 'quant-ph').completeness,
    'failed',
  );
  assert.equal(
    result.sources.find((s) => s.subject === subject).date,
    '2026-09-08',
  );
  assert.equal(f.calls, 0);
  assert.equal(f.db.listJobs().length, 0);
  follow(f, []);
  requested.length = 0;
  await f.daily.refreshFollowedAuthors(f.sub.id);
  assert.deepEqual(requested, []);
});

void test('daily author filter includes non-recommended papers and uses the current follow list', async (t) => {
  const f = await fixture(t, { outcome: 'not_recommended' });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.stats.not_recommended, 3);
  follow(f, ['Example Author']);
  assert.equal(
    f.daily.items(run.id, { decision: 'followed_authors' }).total,
    3,
  );
  assert.equal(f.daily.getRun(run.id).stats.followed_authors, 3);
  assert.equal(f.daily.items(run.id, { decision: 'recommended' }).total, 0);
  assert.equal(
    f.repo.get('daily_runs', run.id).subscription.followed_authors.length,
    0,
  );
  follow(f, []);
  assert.equal(
    f.daily.items(run.id, { decision: 'followed_authors' }).total,
    0,
  );
  assert.equal(f.calls, 3);
  const route = { ...defaultLocation, filter: 'followed_authors' };
  assert.equal(readRadarLocation(radarHash(route)).filter, route.filter);
});

void test('HTTP author management and paginated feed preserve revision and subject boundaries', async (t) => {
  const f = await fixture(t, { count: 28 });
  const server = createModelServer(f.models, {
    daily: f.daily,
    analyses: f.analyses,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/subscriptions/${f.sub.id}`;
  const saved = await fetch(base + '/followed-authors', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' },
    body: JSON.stringify({
      expected_revision: f.sub.revision,
      followed_authors: ['Example Author'],
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).followed_authors, ['Example Author']);
  const first = await (await fetch(base + '/author-papers?limit=25')).json();
  assert.equal(first.total, 28);
  assert.equal(first.papers.length, 25);
  assert.equal(first.next_offset, 25);
  const last = await (
    await fetch(base + '/author-papers?offset=25&author=example%20author')
  ).json();
  assert.equal(last.papers.length, 3);
  assert.equal(last.next_offset, null);
  assert.equal(
    (await (await fetch(base + '/author-papers?author=Other')).json()).total,
    0,
  );
  assert.equal((await fetch(base + '/author-papers?limit=0')).status, 400);
  assert.equal(f.calls, 0);
});
