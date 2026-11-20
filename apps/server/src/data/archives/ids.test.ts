import { describe, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { IdMap } from './ids.js';

describe('IdMap', () => {
  it('replaces the IDs an archive holds wherever they appear, and nothing else', () => {
    const ids = new IdMap();
    const field = newId('field');
    const choice = newId('choice');
    const outside = newId('field');
    const fresh = ids.add(field);
    const freshChoice = ids.add(choice);
    expect(fresh).toMatch(/^fld/);
    expect(fresh).not.toBe(field);
    expect(ids.add(field)).toBe(fresh);
    const config = {
      fieldOrder: [field, outside],
      columnWidths: { [field]: 200 },
      filter: { conditions: [{ fieldId: field, value: [choice] }] },
      expression: `{${field}} & " reconceptualizing"`,
      template: `{{trigger.record.${field}}}`,
    };
    expect(ids.json(config)).toEqual({
      fieldOrder: [fresh, outside],
      columnWidths: { [fresh]: 200 },
      filter: { conditions: [{ fieldId: fresh, value: [freshChoice] }] },
      // A word shaped like an ID stays, and so does a reference to something the archive left out.
      expression: `{${fresh}} & " reconceptualizing"`,
      template: `{{trigger.record.${fresh}}}`,
    });
    expect(ids.find(outside)).toBeNull();
    expect(() => ids.get(outside)).toThrow();
  });
});
