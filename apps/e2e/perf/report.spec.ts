import { expect, test } from '@playwright/test';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  BUDGETS,
  EDITS_PER_TRIAL,
  TOLERANCES,
  failures,
  framePeriods,
  percentile,
  summarize,
  type Metric,
  type Report,
} from './metrics';
import PerformanceReporter from './reporter';

function report(): Report {
  return {
    version: 1,
    at: '',
    status: 'passed',
    fixture: { records: 1_000_000, fields: 20 },
    failures: [],
    metrics: Object.fromEntries(
      Object.entries(BUDGETS).map(([name, budget]) => [name, summarize(name as Metric, [budget.limit])]),
    ),
  };
}

test('checks budgets, percentile tails, missing samples, and regressions in both directions', () => {
  expect(percentile(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
  expect(() => percentile([])).toThrow();
  expect(() => percentile([NaN])).toThrow();
  expect(summarize('frameP95Ms', [16.700000000000728]).value).toBe(16.7);
  expect(summarize('frameP95Ms', [16.701]).value).toBe(16.701);
  const previous = report();
  const current = report();
  previous.metrics.firstRowsMs = summarize('firstRowsMs', [100]);
  current.metrics.firstRowsMs = summarize('firstRowsMs', [100 * (1 + TOLERANCES.firstRowsMs)]);
  expect(failures(current, previous)).toEqual([]);
  current.metrics.firstRowsMs = summarize('firstRowsMs', [100 * (1 + TOLERANCES.firstRowsMs) + 0.01]);
  expect(failures(current, previous).join('\n')).toContain(
    'from historical median 100 and every passing median [100]',
  );
  current.metrics.scrollingFps = summarize('scrollingFps', [49]);
  current.metrics.cls = summarize('cls', [0.01]);
  delete current.metrics.jumpMs;
  const errors = failures(current, previous).join('\n');
  expect(errors).toContain('scrollingFps');
  expect(errors).toContain('from historical median 55 and every passing median [55]');
  expect(errors).toContain('cls');
  expect(errors).toContain('Missing measurement: jumpMs');
});

test('writes failed reports without replacing the last passing report', async () => {
  const directory = test.info().outputPath('reports');
  const previous = report();
  previous.metrics.firstRowsMs = summarize('firstRowsMs', [100]);
  const send = async (value: Report) => {
    const reporter = new PerformanceReporter({ directory, inheritBaseline: false });
    reporter.onTestEnd(
      {} as TestCase,
      {
        attachments: Object.entries(value.metrics).map(([key, metric]) => ({
          name: `performance:${key}`,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(metric.samples)),
        })),
      } as TestResult,
    );
    return reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 0 });
  };
  expect(await send(previous)).toEqual({ status: 'passed' });
  const baseline = readFileSync(`${directory}/last.json`, 'utf8');
  const current = report();
  current.metrics.firstRowsMs = summarize('firstRowsMs', [100 * (1 + TOLERANCES.firstRowsMs) + 1]);
  expect(await send(current)).toEqual({ status: 'failed' });
  expect(readFileSync(`${directory}/last.json`, 'utf8')).toBe(baseline);
  expect(JSON.parse(readFileSync(`${directory}/report.json`, 'utf8')).failures.join('\n')).toContain(
    'regressed over',
  );
  writeFileSync(`${directory}/last.json`, '{');
  expect(await send(previous)).toEqual({ status: 'failed' });
  expect(readFileSync(`${directory}/last.json`, 'utf8')).toBe('{');
});

test('frame periods reject sustained slowness and missed frames without timestamp rounding failures', () => {
  const rounded = Array.from({ length: 600 }, (_, index) => [16.8, 16.5, 16.8, 16.8, 16.5][index % 5]!);
  expect(summarize('frameP95Ms', rounded).value).toBeGreaterThan(BUDGETS.frameP95Ms.limit);
  expect(summarize('frameP95Ms', framePeriods(rounded)).value).toBeLessThanOrEqual(BUDGETS.frameP95Ms.limit);
  expect(summarize('frameP95Ms', framePeriods(Array(600).fill(17))).value).toBeGreaterThan(
    BUDGETS.frameP95Ms.limit,
  );
  // Just over one percent missed frames is enough to fail, even though raw P95 overlooks them.
  const missed = Array.from({ length: 600 }, (_, index) => (1000 / 60) * (index % 80 === 40 ? 2 : 1));
  expect(summarize('frameP95Ms', missed).value).toBeLessThanOrEqual(BUDGETS.frameP95Ms.limit);
  expect(summarize('frameP95Ms', framePeriods(missed)).value).toBeGreaterThan(BUDGETS.frameP95Ms.limit);
});

test('repeated local echo trials reject consistent misses and tolerate one noisy trial', () => {
  const samples = (maxima: number[]) =>
    maxima.flatMap((maximum) => [...Array(EDITS_PER_TRIAL - 1).fill(10), maximum]);
  expect(summarize('localEchoMs', samples([15, 15, 100, 15, 15]), EDITS_PER_TRIAL).budgetValue).toBe(15);
  const current = report();
  current.metrics.localEchoMs = summarize('localEchoMs', samples([17, 17, 15, 15, 17]), EDITS_PER_TRIAL);
  expect(failures(current)).toContain('localEchoMs: 17 exceeds the budget 16');
  expect(summarize('localEchoMs', samples([22, 22, 22, 22, 22]), EDITS_PER_TRIAL).budgetValue).toBe(22);
  expect(() => summarize('localEchoMs', samples([15, 15, 15, 15]), EDITS_PER_TRIAL)).toThrow();
  expect(() => summarize('localEchoMs', samples([15, 15, 15, 15, 15]).slice(1), EDITS_PER_TRIAL)).toThrow();
  expect(() => summarize('cls', samples([0, 0, 0, 0, 0]), EDITS_PER_TRIAL)).toThrow();
});
