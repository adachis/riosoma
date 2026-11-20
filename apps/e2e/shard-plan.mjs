import { join, resolve } from 'node:path';

export function shardPlan(directory, browser, env = process.env) {
  const count = Number(env.RIOSOMA_E2E_SHARDS ?? 4);
  if (!['chromium', 'firefox', 'webkit'].includes(browser) || !Number.isInteger(count) || count < 1)
    throw new Error('Expected chromium, firefox, or webkit and a positive RIOSOMA_E2E_SHARDS count');

  const selected =
    env.RIOSOMA_E2E_SHARD_INDEX === undefined ? undefined : Number(env.RIOSOMA_E2E_SHARD_INDEX);
  if (selected !== undefined && (!Number.isInteger(selected) || selected < 1 || selected > count))
    throw new Error('Expected RIOSOMA_E2E_SHARD_INDEX to be an integer from 1 to RIOSOMA_E2E_SHARDS');

  const output = resolve(directory, 'test-results', `shards-${browser}`);
  const report = resolve(directory, 'playwright-report');
  return {
    count,
    indices: selected === undefined ? Array.from({ length: count }, (_, index) => index + 1) : [selected],
    output: selected === undefined ? output : join(output, String(selected)),
    report: selected === undefined ? report : join(report, browser, String(selected)),
    testOutput: (index) => join(output, String(index), ...(selected === undefined ? [] : ['output'])),
  };
}
