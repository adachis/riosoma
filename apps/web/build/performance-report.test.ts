import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import { expect, it } from 'vitest';
import PerformanceReporter from '../../e2e/perf/reporter';
import {
  BUDGETS,
  HISTORY_LIMIT,
  LOAD_LIMIT,
  TOLERANCES,
  compare,
  failures,
  median,
  passingReports,
  summarize,
  type Metric,
  type Report,
} from '../../e2e/perf/metrics';

it('describes calibration hardware and other work without identifying the machine', () => {
  const metrics = readFileSync(resolve(import.meta.dirname, '../../e2e/perf/metrics.ts'), 'utf8');
  const documentation = readFileSync(
    resolve(import.meta.dirname, '../../../docs/architecture/performance-accessibility.md'),
    'utf8',
  );
  for (const source of [metrics, documentation]) {
    expect(source).toContain('development machine with 18 logical processors');
    expect(source).toContain('other work running');
    expect(source).not.toMatch(/\/(?:Users|home)\//);
  }
});

it('uses the decided latency and frame tolerances independently of the busy-machine spread', () => {
  expect(TOLERANCES).toEqual({
    firstRowsMs: 0.25,
    jumpMs: 0.25,
    indexedSortMs: 0.25,
    scrollingFps: 0.05,
    frameP95Ms: 0.05,
    localEchoMs: 0.25,
    acknowledgmentP95Ms: 0.25,
    peerP95Ms: 0.25,
    shellGzipBytes: 0.05,
    cls: 0.05,
  });
});

it('reports the empty-page baseline beside the sparkline intervals without using it for the budget', async () => {
  const results = resolve(import.meta.dirname, '../../e2e/perf/results');
  mkdirSync(results, { recursive: true });
  const directory = mkdtempSync(join(results, 'report-details-'));
  try {
    const reporter = new PerformanceReporter({ directory, inheritBaseline: false });
    const comparison = {
      emptyPage: { p95Ms: 16.8, samples: [16.8] },
      sparklines: { p95Ms: 16.8, samples: [16.8] },
    };
    reporter.onTestEnd(
      {} as TestCase,
      {
        attachments: [
          {
            name: 'scrolling-comparison',
            body: Buffer.from(JSON.stringify(comparison)),
            contentType: 'application/json',
          },
          ...Object.entries(BUDGETS).map(([metric, budget]) => ({
            name: `performance:${metric}`,
            body: Buffer.from(JSON.stringify([metric === 'frameP95Ms' ? 16.8 : budget.limit])),
            contentType: 'application/json',
          })),
        ],
      } as TestResult,
    );
    await reporter.onEnd({ status: 'passed' } as FullResult);
    const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    expect(report.details['scrolling-comparison']).toEqual(comparison);
    expect(report.metrics.frameP95Ms.value).toBe(16.8);
    expect(report.status).toBe('failed');
    expect(report.failures).toContain('frameP95Ms: 16.8 exceeds the budget 16.7');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function passing(): Report {
  return {
    version: 1,
    at: '',
    status: 'passed',
    fixture: { records: 1_000_000, fields: 20 },
    failures: [],
    metrics: Object.fromEntries(
      Object.entries(BUDGETS).map(([metric, budget]) => [
        metric,
        summarize(metric as Metric, [budget.limit]),
      ]),
    ),
    load: { limit: LOAD_LIMIT, underLoad: false, measurements: [] },
  } satisfies Report;
}

function measurements(firstRowsMs = 100, scrollingFps = 60): Report {
  const report = passing();
  report.metrics.firstRowsMs = summarize('firstRowsMs', [firstRowsMs]);
  report.metrics.scrollingFps = summarize('scrollingFps', [scrollingFps]);
  return report;
}

it.each<Metric>([
  'firstRowsMs',
  'jumpMs',
  'indexedSortMs',
  'localEchoMs',
  'acknowledgmentP95Ms',
  'peerP95Ms',
])('fails when quiet %s latency is 30 percent slower than all five passing reports', (metric) => {
  const baseline = BUDGETS[metric].limit / 2;
  const history = Array.from({ length: HISTORY_LIMIT }, () => {
    const report = measurements();
    report.metrics[metric] = summarize(metric, Array(5).fill(baseline));
    return report;
  });
  const current = measurements();
  current.metrics[metric] = summarize(metric, Array(5).fill(baseline * 1.3));
  expect(current.load!.underLoad).toBe(false);
  const errors = failures(current, history);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBe(
    `${metric}: median ${baseline * 1.3} regressed over 25% ` +
      `from historical median ${baseline} and every passing median [${Array(5).fill(baseline).join(', ')}]`,
  );
});

it('compares medians with every passing median, including shorter histories and both directions', () => {
  const history = [100, 110, 120, 130, 140].map((value) => measurements(value));
  expect(failures(measurements(90), history)).toEqual([]);
  const worseThanAll = 140 * (1 + TOLERANCES.firstRowsMs) + 1;
  const error = failures(measurements(worseThanAll), history).join('\n');
  expect(error).toContain(`firstRowsMs: median ${worseThanAll} regressed over`);
  expect(error).toContain('historical median 120 and every passing median [100, 110, 120, 130, 140]');
  expect(failures(measurements(100 * (1 + TOLERANCES.firstRowsMs) + 1), history)).toEqual([]);
  expect(failures(measurements(140 * (1 + TOLERANCES.firstRowsMs)), history)).toEqual([]);
  expect(failures(measurements(worseThanAll), history.slice(0, 2)).join('\n')).toContain('regressed over');
  expect(failures(measurements(worseThanAll), [])).toEqual([]);
  const details = compare(measurements(90), history).metrics.firstRowsMs!;
  expect(details.historicalMedian).toBe(120);
  expect(details.passingMedians).toEqual([100, 110, 120, 130, 140]);

  const fpsHistory = [56, 58, 60, 62, 64].map((fps) => measurements(100, fps));
  expect(failures(measurements(100, 70), fpsHistory)).toEqual([]);
  expect(failures(measurements(100, 55), fpsHistory)).toEqual([]);
  const slowFps = 56 * (1 - TOLERANCES.scrollingFps) - 0.01;
  expect(failures(measurements(100, slowFps), fpsHistory).join('\n')).toContain('scrollingFps: median');
  expect(failures(measurements(100, 64 * (1 - TOLERANCES.scrollingFps)), fpsHistory)).toEqual([]);
});

it('uses raw sample medians for legacy reports while retaining maximum and tail budgets', () => {
  expect(median([1, 8, 2, 3, 100])).toBe(3);
  expect(median([1, 8, 2, 3])).toBe(2.5);
  const legacy = measurements();
  legacy.metrics.firstRowsMs = { value: 700, samples: [100, 100, 100, 100, 700] };
  const current = measurements(100 * (1 + TOLERANCES.firstRowsMs) + 1);
  expect(failures(current, legacy).join('\n')).toContain('historical median 100');
  current.metrics.firstRowsMs = summarize('firstRowsMs', [100, 100, 100, 100, 801]);
  expect(current.metrics.firstRowsMs.value).toBe(100);
  expect(failures(current)).toContain('firstRowsMs: 801 exceeds the budget 800');
  current.metrics.scrollingFps = summarize('scrollingFps', [60, 60, 60, 60, 54]);
  expect(failures(current)).toContain('scrollingFps: 54 exceeds the budget 55');
});

it('skips regressions under load while still failing absolute budgets and missing measurements', () => {
  const current = measurements(700);
  current.load!.underLoad = true;
  expect(failures(current, measurements())).toEqual([]);
  expect(compare(current, [measurements()])).toEqual({ status: 'skipped-under-load', metrics: {} });
  current.metrics.jumpMs = summarize('jumpMs', [301]);
  delete current.metrics.cls;
  expect(failures(current, measurements())).toEqual([
    'jumpMs: 301 exceeds the budget 300',
    'Missing measurement: cls',
  ]);
});

it('keeps five quiet passing reports in last.json, excludes loaded runs, and preserves failed baselines', async () => {
  const results = resolve(import.meta.dirname, '../../e2e/perf/results');
  mkdirSync(results, { recursive: true });
  const directory = mkdtempSync(join(results, 'report-history-'));
  const send = async (value: number, load = 0, status: FullResult['status'] = 'passed') => {
    const report = measurements(value);
    const reporter = new PerformanceReporter({ directory, inheritBaseline: false });
    reporter.onTestEnd(
      {} as TestCase,
      {
        attachments: [
          {
            name: 'performance-load',
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify({ metrics: ['firstRowsMs'], start: load, end: 0 })),
          },
          ...Object.entries(report.metrics).map(([metric, measurement]) => ({
            name: `performance:${metric}`,
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(measurement.samples)),
          })),
        ],
      } as TestResult,
    );
    return reporter.onEnd({ status } as FullResult);
  };
  try {
    for (const value of [100, 99, 98, 97, 96, 95]) expect(await send(value)).toEqual({ status: 'passed' });
    let baseline = JSON.parse(readFileSync(join(directory, 'last.json'), 'utf8')) as Report;
    expect(baseline.history).toHaveLength(HISTORY_LIMIT);
    expect(passingReports(baseline).map((report) => report.metrics.firstRowsMs!.median)).toEqual([
      95, 96, 97, 98, 99,
    ]);
    expect(baseline.history!.every((report) => !report.history)).toBe(true);
    expect(await send(700, LOAD_LIMIT + 1)).toEqual({ status: 'passed' });
    baseline = JSON.parse(readFileSync(join(directory, 'last.json'), 'utf8')) as Report;
    expect(baseline.load!.underLoad).toBe(true);
    expect(baseline.load!.measurements).toEqual([
      { metrics: ['firstRowsMs'], start: LOAD_LIMIT + 1, end: 0 },
    ]);
    expect(baseline.comparison!.status).toBe('skipped-under-load');
    expect(passingReports(baseline).map((report) => report.metrics.firstRowsMs!.median)).toEqual([
      95, 96, 97, 98, 99,
    ]);
    const stored = readFileSync(join(directory, 'last.json'), 'utf8');
    expect(await send(801, LOAD_LIMIT + 1)).toEqual({ status: 'failed' });
    expect(await send(700)).toEqual({ status: 'failed' });
    expect(await send(90, 0, 'failed')).toEqual({ status: 'failed' });
    expect(readFileSync(join(directory, 'last.json'), 'utf8')).toBe(stored);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('isolates fixture history from an external baseline while honoring explicitly requested baselines', async () => {
  const results = resolve(import.meta.dirname, '../../e2e/perf/results');
  mkdirSync(results, { recursive: true });
  const directory = mkdtempSync(join(results, 'report-environment-'));
  const previous = process.env.RIOSOMA_PERF_BASELINE;
  const missing = join(directory, 'missing.json');
  process.env.RIOSOMA_PERF_BASELINE = missing;
  const result = {
    attachments: Object.entries(measurements().metrics).map(([metric, measurement]) => ({
      name: `performance:${metric}`,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(measurement.samples)),
    })),
  } as TestResult;
  try {
    const isolated = new PerformanceReporter({ directory, inheritBaseline: false });
    isolated.onTestEnd({} as TestCase, result);
    expect(await isolated.onEnd({ status: 'passed' } as FullResult)).toEqual({ status: 'passed' });
    const baseline = readFileSync(join(directory, 'last.json'), 'utf8');
    const explicit = new PerformanceReporter({ directory, baseline: missing, inheritBaseline: false });
    explicit.onTestEnd({} as TestCase, result);
    expect(await explicit.onEnd({ status: 'passed' } as FullResult)).toEqual({ status: 'failed' });
    expect(JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')).failures).toContain(
      'The requested baseline is missing',
    );
    expect(readFileSync(join(directory, 'last.json'), 'utf8')).toBe(baseline);
  } finally {
    if (previous === undefined) delete process.env.RIOSOMA_PERF_BASELINE;
    else process.env.RIOSOMA_PERF_BASELINE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
