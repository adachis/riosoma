import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps every production source file free of runtime imports and globals from Node', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter(
    (name) =>
      typeof name === 'string' &&
      /\.[cm]?[jt]sx?$/u.test(name) &&
      !/\.(?:test|spec|test-helpers)\.[cm]?[jt]sx?$/u.test(name),
  ) as string[];
  expect(files.length).toBeGreaterThan(1);
  for (const name of files) {
    const source = ts.createSourceFile(
      name,
      readFileSync(`${root}${name}`, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const violations: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        (node.moduleSpecifier.text.startsWith('node:') || !node.moduleSpecifier.text.startsWith('.'))
      )
        violations.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        !node.arguments[0].text.startsWith('.')
      )
        violations.push(node.arguments[0].text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        !node.argument.literal.text.startsWith('.')
      )
        violations.push(node.argument.literal.text);
      if (ts.isIdentifier(node) && ['Buffer', 'require', 'process'].includes(node.text))
        violations.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(violations, name).toEqual([]);
  }
});
