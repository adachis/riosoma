import { availableParallelism, loadavg } from 'node:os';

export const BUDGETS = {
  firstRowsMs: { limit: 800, direction: 'lower', statistic: 'max' },
  jumpMs: { limit: 300, direction: 'lower', statistic: 'max' },
  indexedSortMs: { limit: 650, direction: 'lower', statistic: 'max' },
  scrollingFps: { limit: 55, direction: 'higher', statistic: 'min' },
  frameP95Ms: { limit: 16.7, direction: 'lower', statistic: 'p95' },
  localEchoMs: { limit: 16, direction: 'lower', statistic: 'max' },
  acknowledgmentP95Ms: { limit: 150, direction: 'lower', statistic: 'p95' },
  peerP95Ms: { limit: 250, direction: 'lower', statistic: 'p95' },
  shellGzipBytes: { limit: 250_000, direction: 'lower', statistic: 'max' },
  cls: { limit: 0, direction: 'lower', statistic: 'max' },
} as const;

export type Metric = keyof typeof BUDGETS;
export const HISTORY_LIMIT = 5;
export const TIMING_SAMPLES = 5;
export const EDITS_PER_TRIAL = 30;
// Leave headroom for the browser and server instead of treating a fully occupied host as quiet.
export const LOAD_LIMIT = availableParallelism() * 0.75;

// 2026-10-10, build 2b112430, development machine with 18 logical processors and other work running.
// Ten-run medians: metric, minimum, maximum, spread %.
// firstRowsMs: 116.400000, 131.500000, 12.9725
// jumpMs: 82.500000, 97.600000, 18.3030
// indexedSortMs: 111.100000, 161.100000, 45.0045
// scrollingFps: 59.803843, 60.002591, 0.3323
// frameP95Ms: 16.700000, 16.700000, 0.0000
// localEchoMs: 5.1001, 6.8000, 33.3317
// acknowledgmentP95Ms: 34.5000, 50.5498, 46.5212
// peerP95Ms: 32.1998, 51.2001, 59.0073
// shellGzipBytes: 234060.000000, 234060.000000, 0.0000
// cls: 0.000000, 0.000000, 0.0000
// Spread is (maximum / minimum - 1), or zero for an all-zero metric.
// This busy-machine spread explains skipping comparisons under load, rather than setting tolerances.
// Latency tolerances are 25%, and frame tolerances are 5%.  Repeated samples and quiet history
// supply stability without accepting large regressions.  Absolute budgets remain independent.
export const TOLERANCES: Record<Metric, number> = {
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
};

export interface LoadMeasurement {
  metrics: Metric[];
  start: number;
  end: number;
}
export interface MachineLoad {
  limit: number;
  underLoad: boolean;
  measurements: LoadMeasurement[];
}
export interface Comparison {
  status: 'compared' | 'no-baseline' | 'skipped-under-load';
  metrics: Partial<
    Record<
      Metric,
      {
        currentMedian: number;
        historicalMedian: number;
        passingMedians: number[];
        tolerance: number;
      }
    >
  >;
}
export interface Measurement {
  value: number;
  samples: number[];
  median?: number;
  budgetValue?: number;
  /** Independent groups retain their maximum while one noisy group cannot decide the run. */
  trialSize?: number;
}
export interface Report {
  version: 1;
  at: string;
  status: string;
  fixture: { records: number; fields: number };
  metrics: Partial<Record<Metric, Measurement>>;
  failures: string[];
  details?: Record<string, unknown>;
  load?: MachineLoad;
  comparison?: Comparison;
  // Embedded history survives runners that persist only last.json between checkouts.
  history?: Report[];
}

export function percentile(samples: readonly number[], fraction = 0.95): number {
  if (!samples.length || samples.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Measurements must contain finite, nonnegative samples');
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1]!;
}

/** Measure a frame period across five frames so timestamp rounding cannot invent a slow frame.
 * A missed frame still increases the elapsed time in every span that contains it.
 */
export function framePeriods(intervals: readonly number[]): number[] {
  const span = 5;
  if (intervals.length < span || intervals.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('Frame measurements need at least five finite, positive intervals');
  const periods: number[] = [];
  let elapsed = 0;
  for (const [index, interval] of intervals.entries()) {
    elapsed += interval;
    if (index >= span) elapsed -= intervals[index - span]!;
    if (index >= span - 1) periods.push(elapsed / span);
  }
  return periods;
}

export function median(samples: readonly number[]): number {
  percentile(samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarize(metric: Metric, samples: number[], trialSize?: number): Measurement {
  percentile(samples);
  const statistic = BUDGETS[metric].statistic;
  let rawBudgetValue =
    statistic === 'p95'
      ? percentile(samples)
      : statistic === 'max'
        ? Math.max(...samples)
        : Math.min(...samples);
  if (trialSize !== undefined) {
    if (
      metric !== 'localEchoMs' ||
      !Number.isInteger(trialSize) ||
      trialSize < EDITS_PER_TRIAL ||
      samples.length % trialSize !== 0 ||
      samples.length / trialSize < TIMING_SAMPLES
    )
      throw new Error('Local echo needs five complete trials of at least thirty edits');
    const maxima: number[] = [];
    for (let start = 0; start < samples.length; start += trialSize)
      maxima.push(Math.max(...samples.slice(start, start + trialSize)));
    rawBudgetValue = median(maxima);
  }
  // Subtracting decimal frame timestamps can leave floating-point noise at the budget boundary.
  const budgetValue = metric === 'frameP95Ms' ? Number(rawBudgetValue.toFixed(6)) : rawBudgetValue;
  const middle = median(samples);
  const value = ['firstRowsMs', 'jumpMs', 'indexedSortMs', 'scrollingFps'].includes(metric)
    ? middle
    : budgetValue;
  return { value, samples, median: middle, budgetValue, ...(trialSize === undefined ? {} : { trialSize }) };
}

export function passingReports(previous?: Report): Report[] {
  if (!previous) return [];
  // Older reports contain one baseline and no history.  Their raw samples still supply the median.
  if (previous.history !== undefined && !Array.isArray(previous.history))
    throw new Error('Invalid passing report history');
  return (previous.history ?? [previous])
    .filter((report) => !report?.load?.underLoad)
    .slice(0, HISTORY_LIMIT);
}

export function compare(current: Report, previous: readonly Report[]): Comparison {
  const comparison: Comparison = {
    status: current.load?.underLoad ? 'skipped-under-load' : previous.length ? 'compared' : 'no-baseline',
    metrics: {},
  };
  if (comparison.status !== 'compared') return comparison;
  for (const metric of Object.keys(BUDGETS) as Metric[]) {
    const measured = current.metrics[metric];
    if (!measured) continue;
    const passingMedians = previous.map((report) => median(report.metrics[metric]!.samples));
    comparison.metrics[metric] = {
      currentMedian: median(measured.samples),
      historicalMedian: median(passingMedians),
      passingMedians,
      tolerance: TOLERANCES[metric],
    };
  }
  return comparison;
}

export function failures(current: Report, previous?: Report | readonly Report[]): string[] {
  const errors: string[] = [];
  let reports: readonly Report[] = [];
  try {
    reports = previous
      ? Array.isArray(previous)
        ? previous.filter((report) => !report?.load?.underLoad).slice(0, HISTORY_LIMIT)
        : passingReports(previous as Report)
      : [];
  } catch (error) {
    errors.push(String(error));
  }
  const source = previous && !Array.isArray(previous) ? [previous as Report, ...reports] : reports;
  for (const report of source) {
    if (
      report?.version !== 1 ||
      report.status !== 'passed' ||
      report.fixture?.records !== 1_000_000 ||
      report.fixture?.fields !== 20
    )
      if (
        !errors.includes('The previous report must be a passing run with the same fixture and report version')
      )
        errors.push('The previous report must be a passing run with the same fixture and report version');
  }
  for (const metric of Object.keys(BUDGETS) as Metric[]) {
    const measured = current.metrics[metric];
    if (!measured) {
      errors.push(`Missing measurement: ${metric}`);
      continue;
    }
    const { limit, direction } = BUDGETS[metric];
    let summary: Measurement;
    try {
      summary = summarize(metric, measured.samples, measured.trialSize);
      if (!Number.isFinite(measured.value) || measured.value < 0) throw new Error('Invalid summary');
    } catch {
      errors.push(`Invalid measurement: ${metric}`);
      continue;
    }
    // Budget statistics remain unchanged, even when navigation and frame-rate values are medians.
    if (direction === 'lower' ? summary.budgetValue! > limit : summary.budgetValue! < limit)
      errors.push(`${metric}: ${summary.budgetValue} exceeds the budget ${limit}`);
    if (current.load?.underLoad || !reports.length) continue;
    const before: number[] = [];
    for (const report of reports) {
      try {
        before.push(median(report.metrics[metric]!.samples));
      } catch {
        errors.push(`Invalid previous measurement: ${metric}`);
      }
    }
    if (before.length !== reports.length) continue;
    const tolerance = TOLERANCES[metric];
    const middle = summary.median!;
    const regressed = before.every((value) =>
      direction === 'lower' ? middle > value * (1 + tolerance) : middle < value * (1 - tolerance),
    );
    if (regressed)
      errors.push(
        `${metric}: median ${middle} regressed over ${Number((tolerance * 100).toFixed(6))}% ` +
          `from historical median ${median(before)} and every passing median [${before.join(', ')}]`,
      );
  }
  return errors;
}

/** Capture load around the actual operation, including its browser waits, rather than attachment time. */
export async function measure<T>(metrics: Metric[], operation: () => Promise<T>): Promise<T> {
  const start = loadavg()[0];
  try {
    return await operation();
  } finally {
    const end = loadavg()[0];
    const { test } = await import('@playwright/test');
    await test.info().attach('performance-load', {
      body: JSON.stringify({ metrics, start, end }),
      contentType: 'application/json',
    });
  }
}

export async function record(metric: Metric, samples: number[], trialSize?: number): Promise<void> {
  const { test } = await import('@playwright/test');
  await test.info().attach(`performance:${metric}`, {
    body: JSON.stringify(trialSize === undefined ? samples : { samples, trialSize }),
    contentType: 'application/json',
  });
}
