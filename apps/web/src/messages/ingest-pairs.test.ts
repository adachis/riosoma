import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { INGEST_PAIR_MESSAGES } from './ingest-pairs';
import { SERVER_MESSAGES } from './server';

it('registers explicit translated message IDs for every pair outcome and layout failure reason', () => {
  const root = join(import.meta.dirname, '../../../..');
  const files = [
    'packages/ingest/src/pairs/compare.ts',
    'packages/ingest/src/pairs/check.ts',
    'apps/server/src/ingest/pairs/index.ts',
    'packages/ingest/src/interpreter.ts',
  ];
  const keys = new Set(
    files.flatMap((file) =>
      [
        ...readFileSync(join(root, file), 'utf8').matchAll(
          /'(ingest\.(?:pairs\.[A-Za-z]+|layout\.(?:invalid|unsupportedSource|headerNotFound|columnMissing|columnAmbiguous|noRows)))'/gu,
        ),
      ].map((match) => match[1]!),
    ),
  );
  expect(keys.size).toBe(27);
  for (const key of keys) {
    expect(INGEST_PAIR_MESSAGES[key]?.id).toBe(key);
    expect(SERVER_MESSAGES[key]?.message).toBeTruthy();
  }
});
