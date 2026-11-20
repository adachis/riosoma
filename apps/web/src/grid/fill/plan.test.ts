import { describe, expect, it } from 'vitest';
import { FieldSpec, newId, type FieldMeta, type RowData } from '@riosoma/contracts';
import { planFill } from './plan';

function field(name: string, spec: unknown): FieldMeta {
  return {
    id: newId('field'),
    tableId: 'tbl00000000000001',
    name,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    ...FieldSpec.parse(spec),
  } as FieldMeta;
}

describe('planning a fill', () => {
  it('leaves signatures alone, as pasting does, and counts them as skipped', () => {
    const signature = field('Signed', { type: 'signature' });
    const signed: RowData = {
      id: 'rec00000000000001',
      values: {
        [signature.id]: {
          drawing: { path: 'M0 0L10 10', width: 100, height: 40 },
          name: 'Ada Lovelace',
          signedBy: 'usr00000000000001',
          signedAt: '2026-09-27T12:00:00.000Z',
        },
      },
      createdAt: '',
      updatedAt: '',
      createdBy: null,
      updatedBy: null,
    } as unknown as RowData;
    const empty = (index: number) =>
      ({ ...signed, id: `rec0000000000000${index + 1}`, values: {} }) as unknown as RowData;
    const plan = planFill({
      request: {
        source: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
        target: { start: { row: 1, col: 0 }, end: { row: 2, col: 0 } },
        direction: 'down',
        copy: true,
      },
      fields: [signature],
      rowAt: (index) => (index === 0 ? signed : empty(index)),
      readOnly: () => false,
      context: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
    });
    expect(plan.records).toEqual([]);
    expect(plan.skipped).toBe(2);
  });
});

it('refuses a fill outside field bounds and skips a locked destination', () => {
  const amount = field('Amount', { type: 'number', options: { validation: { max: { value: 5 } } } });
  const row = (index: number) =>
    ({
      id: `rec0000000000000${index}`,
      values: { [amount.id]: index + 4 },
      createdAt: '',
      updatedAt: '',
      createdBy: null,
      updatedBy: null,
      ...(index === 3 ? { lock: { manual: true, canEdit: false, reason: 'Reviewed' } } : {}),
    }) as RowData;
  const plan = planFill({
    request: {
      source: { start: { row: 0, col: 0 }, end: { row: 1, col: 0 } },
      target: { start: { row: 2, col: 0 }, end: { row: 3, col: 0 } },
      direction: 'down',
      copy: false,
    },
    fields: [amount],
    rowAt: row,
    readOnly: () => false,
    context: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
  });
  expect(plan.records).toEqual([]);
  expect(plan.unfit).toBe(1);
  expect(plan.skipped).toBe(1);
});
