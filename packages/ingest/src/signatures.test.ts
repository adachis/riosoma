import { describe, expect, it } from 'vitest';
import { cell } from './source.js';
import type { ExtractedSource } from './source.js';
import { findSignatureMismatches, matchSignature, matchSignatures } from './signatures.js';
import type { Signature } from './signatures.js';

const source: ExtractedSource = {
  kind: 'workbook',
  name: 'misleading-filename.xlsx',
  warnings: [],
  sheets: [
    {
      name: 'Orders',
      hidden: false,
      rows: [['Cedar  Comet:'], [' id: ', 'Item', 'Amount']].map((row) => row.map(cell)),
    },
  ],
};
const signature: Signature = {
  id: 'orders',
  kind: 'workbook',
  headerGroups: [['ID'], ['Product', 'Item'], ['Amount']],
  markers: ['cedar comet'],
  markerRows: 3,
};
describe('signature matching', () => {
  it('normalizes case, repeated spaces, and trailing colons, and ignores file names', () => {
    expect(matchSignature(source, signature)).not.toBeNull();
    expect(matchSignature({ ...source, name: 'unrelated.bin' }, signature)).toEqual(
      matchSignature(source, signature),
    );
    expect(matchSignature({ ...source, kind: 'pdf' }, signature)).toBeNull();
    expect(matchSignature(source, { ...signature, markers: ['wrong'] })).toBeNull();
  });
  it('requires every header group within the first 60 rows of the same sheet', () => {
    const late = {
      ...source,
      sheets: [
        {
          name: 'Orders',
          hidden: false,
          rows: [...Array.from({ length: 59 }, () => []), [cell('ID'), cell('Item'), cell('Amount')]],
        },
      ],
    };
    expect(matchSignature(late, { ...signature, markers: [] })).not.toBeNull();
    late.sheets[0]!.rows.unshift([]);
    expect(matchSignature(late, { ...signature, markers: [] })).toBeNull();
    expect(
      matchSignature(
        {
          ...source,
          sheets: [
            { name: 'A', hidden: false, rows: [[cell('ID')]] },
            { name: 'B', hidden: false, rows: [[cell('Item'), cell('Amount')]] },
          ],
        },
        { ...signature, markers: [] },
      ),
    ).toBeNull();
  });
  it('matches first-page marker text only when the text layer is usable', () => {
    const pdf: ExtractedSource = {
      kind: 'pdf',
      name: 'letter.pdf',
      warnings: [],
      pages: [{ number: 1, textQuality: 'clean', text: ' Cedar  Comet: \nDear Mira' }],
    };
    const markerOnly = { ...signature, kind: 'pdf' as const, headerGroups: [] };
    expect(matchSignature(pdf, markerOnly)).not.toBeNull();
    expect(
      matchSignature(
        {
          ...pdf,
          pages: [{ number: 1, textQuality: 'clean', text: 'Report from Cedar\nComet: for Mira Vale' }],
        },
        markerOnly,
      ),
    ).not.toBeNull();
    expect(
      matchSignature(
        { ...pdf, pages: [{ number: 1, textQuality: 'garbled', text: 'Cedar Comet' }] },
        markerOnly,
      ),
    ).toBeNull();
    expect(
      matchSignature(
        {
          ...pdf,
          pages: [
            { number: 1, textQuality: 'clean', text: 'Other' },
            { number: 2, textQuality: 'clean', text: 'Cedar Comet' },
          ],
        },
        markerOnly,
      ),
    ).toBeNull();
  });
  it('ranks specificity and reports a tie without selecting a winner', () => {
    const broad = { ...signature, id: 'broad', headerGroups: [['ID']], markers: [] };
    const exact = { ...signature, id: 'exact', headerGroups: [['ID'], ['Item'], ['Amount']] };
    expect(matchSignatures(source, [broad, signature, exact])).toMatchObject({
      status: 'matched',
      match: { signature: { id: 'exact' } },
    });
    const tied = matchSignatures(source, [signature, { ...signature, id: 'other' }]);
    expect(tied).toMatchObject({ status: 'tie' });
    expect(tied).not.toHaveProperty('match');
    if (tied.status === 'tie') expect(tied.tied).toHaveLength(2);
    expect(matchSignatures(source, [])).toEqual({ status: 'none', matches: [] });
    const reordered = {
      ...signature,
      id: 'reordered',
      headerGroups: [...signature.headerGroups].reverse(),
      markers: [...signature.markers, ...signature.markers],
    };
    expect(matchSignatures(source, [signature, reordered]).status).toBe('tie');
    expect(
      matchSignature(source, { id: 'kind-only', kind: 'workbook', headerGroups: [], markers: [] })?.score,
    ).toBe(1);
  });
  it('reports every foreign signature match even when it loses the ranking', () => {
    const broad = { ...signature, id: 'foreign', headerGroups: [['ID']], markers: [] };
    const results = findSignatureMismatches(
      [signature, broad],
      [{ id: 'example', signatureId: signature.id, source }],
    );
    expect(results).toEqual([
      {
        exampleId: 'example',
        ownSignatureId: 'orders',
        matchedSignatureId: 'foreign',
        score: matchSignature(source, broad)!.score,
      },
    ]);
  });
});
