import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it.each([
  '../features/signatures/RequestDialog.tsx',
  'database/sql/SqlScreen.tsx',
  'database/interfaces/SitePublisher.tsx',
  'database/views/calendar/CalendarSettings.tsx',
])('keeps compound controls out of native labels in %s', (file) => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const invalid: number[] = [];
  function visit(node: ts.Node, insideLabel = false) {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(tree);
      if (insideLabel && tag === 'Select')
        invalid.push(tree.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      insideLabel ||= tag === 'label';
    }
    ts.forEachChild(node, (child) => visit(child, insideLabel));
  }
  visit(tree);
  expect(invalid).toEqual([]);
});
