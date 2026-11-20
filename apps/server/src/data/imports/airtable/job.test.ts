import { describe, expect, it } from 'vitest';
import { AppError } from '@riosoma/contracts';
import { detail } from './job.js';

describe('why the import report says a command was refused', () => {
  it('gives the first per-field reason in place of a general validation failure', () => {
    const refusal = new AppError('validation_failed', 'errors.validationFailed', {
      fields: { 'to.options.precision': 'validation.too_big', 'to.name': 'validation.too_small' },
    });
    expect(detail(refusal)).toEqual({ messageKey: 'validation.too_big', params: {} });
  });

  it('keeps a specific reason, and its parameters, as they are', () => {
    const formula = new AppError('validation_failed', 'formula.type.argument', {
      params: { expected: 'number', actual: 'text', start: 0, end: 7, strict: true },
      fields: { expression: 'formula.type.argument' },
    });
    expect(detail(formula)).toEqual({
      messageKey: 'formula.type.argument',
      params: { expected: 'number', actual: 'text', start: 0, end: 7 },
    });
    expect(detail(new AppError('validation_failed', 'errors.validationFailed'))).toEqual({
      messageKey: 'errors.validationFailed',
      params: {},
    });
  });
});
