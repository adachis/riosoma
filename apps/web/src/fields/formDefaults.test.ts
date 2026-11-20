import { describe, expect, it } from 'vitest';
import { FieldSpec, newId, type FieldMeta } from '@riosoma/contracts';
import { startingAnswers } from './formDefaults';

const field = (spec: unknown): FieldMeta => ({
  ...FieldSpec.parse(spec),
  id: newId('field'),
  tableId: newId('table'),
  name: 'Field',
  description: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
});

describe('a form’s first answers', () => {
  it('start a box checked by default checked, and leave every other question empty', () => {
    const checked = field({ type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } });
    const plain = field({ type: 'checkbox' });
    const text = field({ type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } });
    expect(startingAnswers([checked, plain, text, null, undefined])).toEqual({ [checked.id]: true });
  });
});
