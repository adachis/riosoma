import { ARCHETYPE_IDS, generateArchetype, interpretLayout, rowsEqual } from '@riosoma/ingest';
import { expect, it } from 'vitest';
import { runReader, type ReaderFacts } from './index.js';
import { REFERENCE_READERS } from './reference.test-helpers.js';

const lookups = {
  sender: { 'Willow Lantern Supply': 'WL', 'Birch Harbor Goods': 'BH', 'Cedar Pebble Trading': 'CP' },
};
for (const id of ARCHETYPE_IDS)
  for (const seed of [20, 31])
    for (const size of [2, 27])
      it(`reads archetype ${id}, seed ${seed}, and size ${size} through the sandbox`, async () => {
        const example = generateArchetype(id, { seed, size });
        const before = JSON.stringify(example.source);
        const facts: ReaderFacts = {};
        if (id === 14) {
          // Scans contain no recoverable text.  These transcriptions represent answers about each page.
          const orders = generateArchetype(1, { seed, size }).expected;
          orders.forEach((item, index) => {
            (facts as Record<string, unknown>)[`page:${index + 1}`] = {
              id: item.values.id,
              product: item.values.product,
              amount: item.values.amount,
            };
          });
        }
        const result = await runReader(example.source, REFERENCE_READERS[id], lookups, facts);
        expect(result.status, JSON.stringify(result)).toBe('read');
        if (result.status !== 'read') throw new Error(result.messageKey);
        expect(
          rowsEqual(result.rows, example.expected, {
            numberFields: ['amount', 'quantity', 'units', 'hold', 'hours'],
            dateFields: ['date', 'period'],
          }),
        ).toBe(true);
        expect(result.rows.map((row) => row.values)).toEqual(example.expected.map((row) => row.values));
        expect(result.rows.map((row) => row.at)).toEqual(example.expected.map((row) => row.at));
        if (example.layout) {
          const layout = interpretLayout(example.source, example.layout);
          expect(layout.ok).toBe(true);
          if (!layout.ok) throw new Error(layout.failure.key);
          expect(result.rows).toEqual(layout.rows);
        }
        expect(JSON.stringify(example.source)).toBe(before);
      });

it('requires transcription facts for unreadable scans', async () => {
  expect(await runReader(generateArchetype(14, { size: 2 }).source, REFERENCE_READERS[14])).toMatchObject({
    status: 'failed',
    code: 'script-error',
    detail: 'ingest.cleaner.missingInput',
  });
});
