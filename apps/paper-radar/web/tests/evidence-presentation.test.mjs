import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidencePresentation } from '../lib/evidence-presentation.ts';

void test('saved section offsets are displayed as human-readable positions without changing ranges', () => {
  const value = evidencePresentation({
    id: 'paper:1',
    title: 'Results',
    kind: 'excerpt',
    locator: { section: 'Results', offset: 0, end: 320 },
  });
  assert.equal(value.basis, '原文摘录');
  assert.equal(value.section, 'Results');
  assert.equal(value.characters, '1–320');
  assert.deepEqual(value.pages, []);
});

void test('caption, table, and equation citations disclose text-only reading', () => {
  for (const kind of ['caption', 'table', 'equation']) {
    assert.equal(
      evidencePresentation({ id: 'paper:1', title: '', kind }).visualCaution,
      true,
    );
  }
  assert.equal(
    evidencePresentation({ id: 'paper:1', title: '', kind: 'abstract' }).basis,
    '论文摘要',
  );
});

void test('missing and malformed locations are not presented as verified coverage', () => {
  const value = evidencePresentation({
    id: 'source:1',
    title: '',
    kind: 'future-format',
    locator: {
      section: {},
      offset: -1,
      end: 25,
      pages: [0, -3, '2', 3],
      lines: [],
    },
  });
  assert.equal(value.section, '');
  assert.equal(value.characters, '');
  assert.equal(value.basis, '保存的来源文字');
  assert.deepEqual(value.pages, [3]);
});
