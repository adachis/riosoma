import { expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { OrganizationIds } from './import.js';

it('remaps both IDs in structured formulas when restoring an organization', () => {
  const ids = new OrganizationIds();
  const table = newId('table'),
    amount = newId('field'),
    key = newId('field'),
    current = newId('field');
  const expression = `SUMIFS(${table}[${amount}], ${table}[${key}], {${current}})`;
  expect(ids.references(expression)).toBe(
    `SUMIFS(${ids.get(table)}[${ids.get(amount)}], ${ids.get(table)}[${ids.get(key)}], {${ids.get(current)}})`,
  );
  expect(ids.references('Contacts[Email]')).toBe('Contacts[Email]');
});
