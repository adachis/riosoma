import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { INGEST_WRITE_MESSAGES } from './ingest-write';
import { SERVER_MESSAGES } from './server';

it('registers explicit catalog IDs for every row writer outcome and source location', () => {
  const root = join(import.meta.dirname, '../../../..');
  const keys = new Set(['sheet', 'table', 'page', 'line', 'row'].map((key) => `ingest.write.source.${key}`));
  for (const file of ['check.ts', 'index.ts', 'mutations.ts', 'storage.ts']) {
    const source = readFileSync(join(root, 'apps/server/src/ingest/write', file), 'utf8');
    for (const match of source.matchAll(/'(ingest\.write\.[A-Za-z]+)'/gu)) keys.add(match[1]!);
  }
  expect(keys.size).toBe(18);
  expect(Object.keys(INGEST_WRITE_MESSAGES).sort()).toEqual([...keys].sort());
  for (const id of keys) expect(SERVER_MESSAGES[id]).toMatchObject({ id, message: expect.any(String) });
});
