import { expect, it } from 'vitest';
import { overBudget } from './memory-budget.js';

const MB = 1024 * 1024;

it('counts a touched buffer once, though it shows in both external storage and resident growth', () => {
  expect(overBudget({ heapBytes: 60 * MB, externalBytes: 9 * MB, residentBytes: 94 * MB }, 96 * MB)).toBe(
    false,
  );
});

it('counts an untouched reservation that never becomes resident', () => {
  expect(overBudget({ heapBytes: 10 * MB, externalBytes: 90 * MB, residentBytes: 12 * MB }, 96 * MB)).toBe(
    true,
  );
});

it('counts native allocations that V8 cannot see', () => {
  expect(overBudget({ heapBytes: 10 * MB, externalBytes: 0, residentBytes: 100 * MB }, 96 * MB)).toBe(true);
});

it('allows use that reaches the budget exactly', () => {
  expect(overBudget({ heapBytes: 90 * MB, externalBytes: 6 * MB, residentBytes: 96 * MB }, 96 * MB)).toBe(
    false,
  );
});
