import { describe, expect, it } from 'vitest';
import { displayFormula, translateFormula } from './formulas.js';

const ids: Record<string, string> = {
  fldName0000000000: 'fldRioName000000',
  fldStatus00000000: 'fldRioStatus0000',
  fldDue00000000000: 'fldRioDue0000000',
};
const lookup = (reference: string) => ids[reference];
const names: Record<string, string> = { fldName0000000000: 'Name', fldStatus00000000: 'Status {now}' };

describe('translating formulas', () => {
  it('swaps Airtable field IDs for the fields here, keeping what the formula does', () => {
    const translated = translateFormula(
      `IF({fldStatus00000000} = "Done", {fldName0000000000} & '!', "")`,
      lookup,
    );
    expect(translated).toEqual({
      ok: true,
      expression: 'IF(({fldRioStatus0000} = "Done"), ({fldRioName000000} & "!"), "")',
      references: ['fldStatus00000000', 'fldName0000000000'],
    });
  });

  it('reads function names in any case, the way Airtable does', () => {
    const translated = translateFormula('datetime_diff({fldDue00000000000}, today(), "days")', lookup);
    expect(translated.ok && translated.expression).toBe('DATETIME_DIFF({fldRioDue0000000}, TODAY(), "days")');
  });

  it('says which functions Riosoma doesn’t have', () => {
    expect(
      translateFormula('FROMNOW({fldDue00000000000}) & TONOW({fldDue00000000000})', lookup),
    ).toMatchObject({
      ok: false,
      problem: 'functions',
      functions: ['FROMNOW', 'TONOW'],
    });
  });

  it('refuses formulas that read fields that didn’t come across', () => {
    expect(translateFormula('{fldGone000000000} + 1', lookup)).toMatchObject({
      ok: false,
      problem: 'fields',
    });
  });

  it('keeps formulas that don’t parse, or were broken in Airtable, as they are', () => {
    expect(translateFormula('IF(', lookup)).toMatchObject({ ok: false, problem: 'syntax' });
    expect(translateFormula('{fldName0000000000}', lookup, false)).toMatchObject({
      ok: false,
      problem: 'invalid',
    });
  });

  it('shows formulas with field names, escaping braces in them', () => {
    expect(
      displayFormula(`{fldName0000000000} & {fldStatus00000000} & {fldOther000000000}`, (id) => names[id]),
    ).toBe('{Name} & {Status {now\\}} & {fldOther000000000}');
    expect(displayFormula('x'.repeat(3_000), () => undefined)).toHaveLength(2_000);
  });
});
