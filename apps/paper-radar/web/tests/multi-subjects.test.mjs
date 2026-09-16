import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixture,
  subject,
  xmlEntry,
  feed,
  subscription,
} from './helpers/daily-fixture.mjs';
import { parseFeed } from '../server/daily/discovery.mjs';
import {
  discoverSubjects,
  mergeSubjectSources,
} from '../server/daily/subject-bundle.mjs';
import { validateSubscription } from '../server/daily/contracts.mjs';
import {
  subscriptionSubjects,
  sameSubjects,
  subjectLabel,
} from '../lib/subscription-subjects.ts';

const catalog = [{ id: subject }, { id: 'quant-ph' }];
function archive(repo, category, specs, date = '2026-09-07') {
  const xml = feed(
    specs
      .map(([id, type = 'new', version = 1]) =>
        xmlEntry(id, type, version, date),
      )
      .join(''),
  ).replaceAll(subject, category);
  return repo.archiveFeed({
    ...parseFeed(xml, category),
    xml,
    url: `https://rss.arxiv.org/atom/${category}`,
  })[0];
}
async function prepare(t, overrides = {}) {
  const f = await fixture(t, { outcome: 'recommended', ...overrides });
  const first = archive(f.repo, subject, [
    ['2501.12903', 'new'],
    ['2501.12904', 'new'],
  ]);
  const second = archive(f.repo, 'quant-ph', [
    ['2501.12903', 'cross'],
    ['2501.12905', 'new'],
  ]);
  const sources = new Map([
    [subject, first],
    ['quant-ph', second],
  ]);
  f.daily.discovery.latest = async (id, signal) => {
    signal.throwIfAborted();
    const source = sources.get(id);
    if (source instanceof Error) throw source;
    return source;
  };
  const saved = await f.daily.saveSubscription(
    { expected_revision: f.sub.revision, subjects: ['quant-ph', subject] },
    f.sub.id,
  );
  Object.assign(f.sub, saved);
  return { ...f, sources, first, second };
}
void test('multiple subjects normalize as a set and legacy inputs still work', () => {
  const saved = validateSubscription(
    { ...subscription, subjects: ['quant-ph', subject, 'quant-ph'] },
    catalog,
  );
  assert.deepEqual(saved.subjects, [subject, 'quant-ph']);
  assert.equal(saved.subject, subject);
  assert.deepEqual(validateSubscription(subscription, catalog).subjects, [
    subject,
  ]);
  assert.deepEqual(subscriptionSubjects({ subject: 'quant-ph' }), ['quant-ph']);
  assert.equal(
    subjectLabel({ subjects: ['quant-ph', subject] }),
    `${subject} + quant-ph`,
  );
  assert(
    sameSubjects(
      { subjects: ['quant-ph', subject] },
      { subjects: [subject, 'quant-ph'] },
    ),
  );
  for (const subjects of [[], ['invalid'], ['quant-ph', 'invalid'], [''], null])
    assert.throws(() =>
      validateSubscription({ ...subscription, subjects }, catalog),
    );
});
void test('subject patches replace the set while unrelated patches preserve it', async (t) => {
  const f = await prepare(t);
  const renamed = await f.daily.saveSubscription(
    { expected_revision: f.sub.revision, name: 'Multi' },
    f.sub.id,
  );
  assert.deepEqual(renamed.subjects, [subject, 'quant-ph']);
  const legacy = await f.daily.saveSubscription(
    { expected_revision: renamed.revision, subject: 'quant-ph' },
    f.sub.id,
  );
  assert.deepEqual(legacy.subjects, ['quant-ph']);
  const newer = await f.daily.saveSubscription(
    { expected_revision: legacy.revision, subjects: [subject] },
    f.sub.id,
  );
  assert.deepEqual(newer.subjects, [subject]);
  assert.equal(newer.subject, subject);
});
void test('union screens each arXiv ID once, keeps provenance, and reuses the same batch', async (t) => {
  const f = await prepare(t);
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.stats.total, 3);
  assert.equal(run.actual_attempts, 3);
  assert.equal(run.discovery.raw_count, 4);
  assert.equal(run.discovery.duplicates, 1);
  assert.equal(run.discovery.cross_subject_duplicates, 1);
  assert.deepEqual(run.discovery.subjects, [subject, 'quant-ph']);
  assert.equal(run.discovery.sources.length, 2);
  const shared = f.daily
    .items(run.id)
    .items.find((i) => i.paper.id === '2501.12903');
  assert.deepEqual(shared.paper.matched_subjects, [subject, 'quant-ph']);
  assert.equal(shared.paper.source_matches.length, 2);
  assert.equal(shared.paper.announce_type, 'new');
  assert.equal(shared.details_status, 'not_requested');
  const repeated = await f.finish(f.create('repeat-multi').run.id);
  assert.equal(repeated.id, run.id);
  assert.equal(repeated.actual_attempts, 3);
  assert.deepEqual(f.daily.getReport(run.report_id).subjects, [
    subject,
    'quant-ph',
  ]);
  // Same source set in another order creates the exact same archived revision.
  const reordered = await discoverSubjects(
    f.daily.discovery,
    f.repo,
    ['quant-ph', subject],
    new AbortController().signal,
  );
  assert.equal(reordered.id, run.discovery.revision_id);
});
void test('replacement in one subject and new cross-list in another is eligible only once', async (t) => {
  const f = await prepare(t);
  f.sources.set(subject, archive(f.repo, subject, [['2501.12903', 'replace']]));
  f.sources.set(
    'quant-ph',
    archive(f.repo, 'quant-ph', [['2501.12903', 'cross']]),
  );
  const run = await f.finish(f.create().run.id);
  assert.equal(run.stats.total, 1);
  assert.equal(run.stats.excluded, 0);
  assert.equal(run.actual_attempts, 1);
});
void test('update-only papers stay excluded after cross-subject deduplication', async (t) => {
  const f = await prepare(t);
  f.sources.set(
    subject,
    archive(f.repo, subject, [['2501.12903', 'replace', 2]]),
  );
  f.sources.set(
    'quant-ph',
    archive(f.repo, 'quant-ph', [['2501.12903', 'replace-cross', 2]]),
  );
  const run = await f.finish(f.create().run.id);
  assert.equal(run.stats.total, 0);
  assert.equal(run.stats.excluded, 1);
  assert.equal(run.actual_attempts, 0);
});
void test('conflicting versions keep the newest once and disclose incomplete coverage', async (t) => {
  const f = await prepare(t);
  f.sources.set(
    'quant-ph',
    archive(f.repo, 'quant-ph', [['2501.12903', 'cross', 2]]),
  );
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'partial');
  const shared = f.daily
    .items(run.id)
    .items.find((i) => i.paper.id === '2501.12903');
  assert.equal(shared.paper.version, 2);
  assert.equal(f.daily.items(run.id).total, 2);
  assert(run.discovery.issues.some((s) => s.includes('版本不一致')));
});
void test('different announcement dates never silently mix old papers into the latest report', async (t) => {
  const f = await prepare(t);
  f.sources.set(
    subject,
    archive(f.repo, subject, [['2501.12906']], '2026-09-06'),
  );
  const run = await f.finish(f.create().run.id);
  assert.equal(run.date, '2026-09-07');
  assert.equal(run.status, 'partial');
  assert.equal(run.stats.total, 2);
  assert(!f.daily.items(run.id).items.some((i) => i.paper.id === '2501.12906'));
  assert.equal(
    run.discovery.sources.find((s) => s.subject === subject).status,
    'different_date',
  );
});
void test('failed category is visible; refreshing recovery creates a complete revision of the same report', async (t) => {
  const f = await prepare(t);
  f.sources.set('quant-ph', new Error('Source unavailable'));
  const partial = await f.finish(f.create().run.id);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.stats.total, 2);
  assert.equal(
    partial.discovery.sources.find((s) => s.subject === 'quant-ph').status,
    'failed',
  );
  f.sources.set('quant-ph', f.second);
  const complete = await f.finish(f.create('recovered-multi').run.id);
  assert.equal(complete.status, 'completed');
  assert.equal(complete.stats.total, 3);
  assert.equal(complete.report_id, partial.report_id);
  assert.notEqual(
    complete.discovery.revision_id,
    partial.discovery.revision_id,
  );
  assert.equal(f.daily.getRun(partial.id).status, 'partial');
});
void test('total source failure is failed discovery, never an empty completed report', async (t) => {
  const f = await prepare(t);
  f.sources.set(subject, new Error('offline'));
  f.sources.set('quant-ph', new Error('offline'));
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.report_id, null);
  assert.equal(run.actual_attempts, 0);
  assert.match(run.error.message, /所有所选分类/);
});
void test('changing subjects cannot reuse a stored batch belonging to the old scope', async (t) => {
  const f = await prepare(t);
  const initial = await f.finish(f.create().run.id);
  const saved = await f.daily.saveSubscription(
    { expected_revision: f.sub.revision, subjects: ['quant-ph'] },
    f.sub.id,
  );
  Object.assign(f.sub, saved);
  const wrong = await f.finish(
    f.create('wrong-stored', {
      source: { kind: 'stored_batch', batch_id: initial.discovery.batch_id },
      force_regenerate: true,
    }).run.id,
  );
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.error.code, 'invalid_source');
  const fresh = await f.finish(f.create('new-single-scope').run.id);
  assert.equal(fresh.stats.total, 2);
  assert.deepEqual(f.daily.getRun(initial.id).subscription.subjects, [
    subject,
    'quant-ph',
  ]);
});
void test('cancelled collection publishes no bundle and never starts screening', async (t) => {
  const f = await prepare(t);
  const controller = new AbortController();
  const discovery = {
    latest: async (id) => {
      controller.abort();
      return f.sources.get(id);
    },
  };
  let archived = false;
  await assert.rejects(
    discoverSubjects(
      discovery,
      {
        archiveSubjectBundle() {
          archived = true;
        },
      },
      [subject, 'quant-ph'],
      controller.signal,
    ),
  );
  assert.equal(archived, false);
});
void test('legacy saved subscriptions without a subjects array still generate and keep history intact', async (t) => {
  const f = await fixture(t);
  const legacy = { ...f.sub };
  delete legacy.subjects;
  f.repo.saveSubscription(legacy);
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.subscription.subject, subject);
  assert.deepEqual(subscriptionSubjects(run.subscription), [subject]);
  assert.equal(run.subscription.subjects, undefined);
});
void test('same-version conflicting abstracts are not declared complete', async (t) => {
  const f = await prepare(t);
  const altered = {
    ...f.second,
    papers: f.second.papers.map((p) =>
      p.id === '2501.12903' ? { ...p, abstract: 'conflicting abstract' } : p,
    ),
  };
  const merged = mergeSubjectSources(
    [subject, 'quant-ph'],
    [
      { subject, revision: f.first },
      { subject: 'quant-ph', revision: altered },
    ],
  );
  assert.equal(merged.completeness, 'incomplete');
  assert(merged.issues.some((s) => s.includes('元数据不一致')));
});
