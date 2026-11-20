import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { shardPlan } from './shard-plan.mjs';

const directory = import.meta.dirname;

it('keeps the default shard count and paths when no index is supplied', () => {
  const plan = shardPlan(directory, 'chromium', {});
  expect(plan.count).toBe(4);
  expect(plan.indices).toEqual([1, 2, 3, 4]);
  expect(plan.output).toBe(resolve(directory, 'test-results/shards-chromium'));
  expect(plan.report).toBe(resolve(directory, 'playwright-report'));
  expect(plan.testOutput(2)).toBe(resolve(directory, 'test-results/shards-chromium/2'));
});

it('selects exactly the requested 1-based shard and isolates all its output', () => {
  const plan = shardPlan(directory, 'webkit', {
    RIOSOMA_E2E_SHARDS: '60',
    RIOSOMA_E2E_SHARD_INDEX: '7',
  });
  expect(plan.count).toBe(60);
  expect(plan.indices).toEqual([7]);
  expect(plan.output).toBe(resolve(directory, 'test-results/shards-webkit/7'));
  expect(plan.report).toBe(resolve(directory, 'playwright-report/webkit/7'));
  expect(plan.testOutput(7)).toBe(resolve(directory, 'test-results/shards-webkit/7/output'));
  const other = shardPlan(directory, 'webkit', {
    RIOSOMA_E2E_SHARDS: '60',
    RIOSOMA_E2E_SHARD_INDEX: '8',
  });
  expect(other.output).not.toBe(plan.output);
  expect(other.report).not.toBe(plan.report);
});

it.each(['1', '4'])('accepts boundary shard index %s with the default total', (index) => {
  expect(shardPlan(directory, 'firefox', { RIOSOMA_E2E_SHARD_INDEX: index }).indices).toEqual([
    Number(index),
  ]);
});

it.each(['', '0', '-1', '1.5', '5', 'NaN', 'Infinity', 'seven'])(
  'rejects invalid shard index %j before starting any work',
  (index) => {
    expect(() => shardPlan(directory, 'chromium', { RIOSOMA_E2E_SHARD_INDEX: index })).toThrow(
      'RIOSOMA_E2E_SHARD_INDEX',
    );
  },
);

it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity'])(
  'preserves rejection of invalid shard totals %j',
  (count) => {
    expect(() => shardPlan(directory, 'chromium', { RIOSOMA_E2E_SHARDS: count })).toThrow(
      'positive RIOSOMA_E2E_SHARDS',
    );
  },
);

it('preserves browser validation', () => {
  expect(() => shardPlan(directory, 'unknown', {})).toThrow('Expected chromium, firefox, or webkit');
});
