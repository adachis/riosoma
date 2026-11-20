import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { compactPath } from './brand_paths.mjs';

test('preserves curve controls, lines, decimals, and closed subpath origins', () => {
  assert.equal(
    compactPath('M10.5 20C11 21 12 22 13 23L14 25ZM30 40C31 42 32 43 33 44Z'),
    'm10.5 20c0.5 1 1.5 2 2.5 3l1 2zm19.5 20c1 2 2 3 3 4z',
  );
  assert.equal(compactPath('M0 0L-5 -3C-6 -3 -7 -4 -8 -5Z'), 'm0 0l-5 -3c-1 0 -2 -1 -3 -2z');
  assert.equal(compactPath('M0 0Q1 2 3 4'), 'M0 0Q1 2 3 4');
});

for (const variant of ['wordmark', 'lockup', 'mascot']) {
test(`preserves every ${variant} control point while reducing transferred artwork`, () => {
  const source = readFileSync(fileURLToPath(new URL(`../apps/web/public/brand/riosoma-${variant}.svg`, import.meta.url)), 'utf8');
  const optimized = source.replace(/\sd="([^"]+)"/g, (_, path) => {
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    const restored = [...compactPath(path).matchAll(/([a-z])([^a-z]*)/g)].map(([, command, points]) => {
      if (command === 'z') {
        x = startX;
        y = startY;
        return ['Z'];
      }
      const absolute = points.trim().split(/\s+/).map((value, index) =>
        Number((Number(value) + (index % 2 === 0 ? x : y)).toFixed(6)),
      );
      x = absolute.at(-2);
      y = absolute.at(-1);
      if (command === 'm') {
        startX = x;
        startY = y;
      }
      return [command.toUpperCase(), ...absolute];
    });
    const original = [...path.matchAll(/([A-Z])([^A-Z]*)/g)].map(([, command, points]) =>
      [command, ...(points.match(/-?\d*\.?\d+/g)?.map(Number) ?? [])],
    );
    assert.deepEqual(restored, original);
    return ` d="${compactPath(path)}"`;
  });
  assert.ok(gzipSync(optimized).length < gzipSync(source).length);
});
}
