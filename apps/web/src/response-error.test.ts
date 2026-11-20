import { ERROR_CODES, ErrorBody } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { parseError } from './response-error';

const info = { code: 'forbidden', messageKey: 'errors.adminOnly', userFault: true };

it('preserves error metadata and strips unknown properties like the contract schema', () => {
  for (const code of ERROR_CODES) {
    const data = {
      error: {
        ...info,
        code,
        params: { count: 2, name: 'Name', enabled: false },
        reference: 'reference',
        fields: { name: 'errors.required' },
        issues: [
          {
            recordId: 'record',
            fieldId: 'field',
            messageKey: 'errors.required',
            message: 'details',
            extra: true,
          },
        ],
        extra: true,
      },
      extra: true,
    };
    expect(parseError(data)).toEqual(ErrorBody.parse(data).error);
  }
});

it.each([
  null,
  [],
  {},
  { error: null },
  { error: [] },
  { error: { ...info, code: 'unknown' } },
  { error: { ...info, messageKey: 1 } },
  { error: { ...info, userFault: 'true' } },
  ...['params', 'fields', 'reference', 'issues'].flatMap((key) =>
    [null, 1, true].map((value) => ({ error: { ...info, [key]: value } })),
  ),
  { error: { ...info, params: { nested: {} } } },
  { error: { ...info, params: { count: Infinity } } },
  { error: { ...info, fields: { name: false } } },
  { error: { ...info, issues: [{}] } },
  {
    error: {
      ...info,
      issues: [{ recordId: 'record', fieldId: 'field', messageKey: 'errors.required', message: 1 }],
    },
  },
])('rejects malformed error metadata %#', (data) => {
  expect(ErrorBody.safeParse(data).success).toBe(false);
  expect(parseError(data)).toBeNull();
});
