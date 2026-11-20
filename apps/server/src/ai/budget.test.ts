import { expect, it } from 'vitest';
import { budgetReached } from './budget.js';

it('stops at a decimal budget even when its sum rounds above the stored spend', () => {
  expect(0.0004 + 0.0002).toBeGreaterThan(0.0006);
  expect(budgetReached(0.0006, 0.0004 + 0.0002)).toBe(true);
  expect(budgetReached(0.3, 0.1 + 0.2)).toBe(true);
  expect(budgetReached(0.6, 0.3 + 0.3)).toBe(true);
});

it('preserves real remaining allowance at every supported scale', () => {
  for (const budget of [1e-20, 0.0002, 1, 1_000_000]) {
    expect(budgetReached(0, budget)).toBe(false);
    expect(budgetReached(budget * (1 - 1e-12), budget)).toBe(false);
    expect(budgetReached(budget, budget)).toBe(true);
    expect(budgetReached(budget * 1.01, budget)).toBe(true);
  }
  expect(budgetReached(0, 0)).toBe(true);
});
