import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { translateUi } from '../lib/ui-messages.ts';

const root = new URL('../', import.meta.url);
const han = /\p{Script=Han}/u;
function files(directory) {
  return readdirSync(new URL(directory, root), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? files(`${directory}/${entry.name}`)
        : /\.(tsx?|mjs)$/.test(entry.name)
          ? [`${directory}/${entry.name}`]
          : [],
  );
}
function literals(node) {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [
      node.head.text +
        node.templateSpans
          .map((span, i) => `{${i}}${span.literal.text}`)
          .join(''),
    ];
  if (ts.isConditionalExpression(node))
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  return [];
}
function untranslated(paths, select) {
  const missing = [];
  for (const path of paths) {
    const tree = ts.createSourceFile(
      path,
      readFileSync(new URL(path, root), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      for (const argument of select(node, tree)) {
        for (const value of literals(argument)) {
          if (han.test(value) && han.test(translateUi(value, 'en')))
            missing.push(
              `${path}:${tree.getLineAndCharacterOfPosition(argument.getStart()).line + 1}: ${value}`,
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return missing;
}

void test('all literal UI messages and evidence/evaluation status labels have English translations', () => {
  const missing = untranslated(files('components/radar'), (node, tree) =>
    ts.isCallExpression(node) && node.expression.getText(tree) === 'ui'
      ? node.arguments.slice(0, 1)
      : [],
  );
  missing.push(
    ...untranslated(
      ['lib/evaluation-display.ts', 'lib/evidence-presentation.ts'],
      (node) => (ts.isStringLiteralLike(node) ? [node] : []),
    ),
  );
  assert.deepEqual(
    missing,
    [],
    'Add interface translations without changing paper or user content.',
  );
});

void test('application error constructors and validation failures have English translations', () => {
  const missing = untranslated(files('server'), (node, tree) => {
    if (
      (ts.isNewExpression(node) &&
        node.expression.getText(tree).endsWith('Error')) ||
      (ts.isCallExpression(node) &&
        ['fail', 'hostError', 'error'].includes(node.expression.getText(tree)))
    )
      return [...(node.arguments ?? [])];
    return [];
  });
  assert.deepEqual(
    missing,
    [],
    'Translate application failures at display time, including saved failures.',
  );
});
