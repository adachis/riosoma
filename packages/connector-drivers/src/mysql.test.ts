import { expect, it } from 'vitest';
import { enumLabels } from './mysql.js';

it('reads the labels of a MySQL enum, quotes and escapes included', () => {
  expect(enumLabels("enum('one','it''s','back\\\\slash','line\\nend')")).toEqual([
    'one',
    "it's",
    'back\\slash',
    'line\nend',
  ]);
});
