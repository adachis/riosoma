import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { root } from './version.mjs';

test('the English-only release accepts current catalogs with deferred translations', () => {
  const result = spawnSync(process.execPath, [join(root, 'tools/i18n_check.mjs'), '--allow-missing'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /en-US:/);
});

test('catalog validation still rejects invalid syntax, placeholders, and unknown keys', async () => {
  const { checkCatalog } = await import('../i18n_check.mjs');
  const source = new Map([
    ['greeting', 'Hello to you, {name}'],
    ['missing', 'Not translated yet'],
    ['brand', 'Open Riosoma with Rio'],
  ]);
  const partial = new Map([['greeting', source.get('greeting')]]);
  assert.deepEqual(checkCatalog(source, partial, { allowMissing: true }).problems, []);
  assert.ok(checkCatalog(source, partial).problems.some((problem) => problem.includes('missing: missing')));
  assert.ok(checkCatalog(source, partial).problems.some((problem) => problem.includes('still in English')));
  for (const [id, text, expected] of [
    ['greeting', 'Hello {other}', /placeholders/],
    ['greeting', 'Hello {name, plural, one {one}', /not valid ICU/],
    ['brand', 'Open the product', /keep "Riosoma"/],
    ['unknown', 'Unknown message', /not in the source catalog/],
  ]) {
    const result = checkCatalog(source, new Map([[id, text]]), { allowMissing: true });
    assert.ok(
      result.problems.some((problem) => expected.test(problem)),
      result.problems.join('\n'),
    );
  }
  const invalid = new Map([['invalid', 'Broken {name, plural, one {one}']]);
  assert.ok(
    checkCatalog(invalid, new Map(), { allowMissing: true }).problems.some((problem) =>
      problem.includes("English source isn't valid ICU"),
    ),
  );
});
