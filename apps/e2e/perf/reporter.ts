import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import {
  BUDGETS,
  HISTORY_LIMIT,
  LOAD_LIMIT,
  compare,
  failures,
  passingReports,
  summarize,
  type LoadMeasurement,
  type Metric,
  type Report,
} from './metrics';

export default class PerformanceReporter implements Reporter {
  private readonly directory: string;
  private readonly baseline: string;
  private readonly requireBaseline: boolean;
  private readonly samples = new Map<Metric, number[]>();
  private readonly trialSizes = new Map<Metric, number>();
  private readonly errors: string[] = [];
  private readonly details: Record<string, unknown> = {};
  private readonly load: LoadMeasurement[] = [];

  constructor(options: { directory?: string; baseline?: string; inheritBaseline?: boolean } = {}) {
    this.directory = resolve(options.directory ?? process.env.RIOSOMA_PERF_REPORT_DIR ?? 'perf/results');
    const baseline =
      options.baseline ?? (options.inheritBaseline === false ? undefined : process.env.RIOSOMA_PERF_BASELINE);
    this.baseline = resolve(baseline ?? `${this.directory}/last.json`);
    this.requireBaseline = !!baseline;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    for (const attachment of result.attachments) {
      if (attachment.name === 'performance-load') {
        try {
          const measurement = JSON.parse(
            (attachment.body ?? readFileSync(attachment.path!)).toString(),
          ) as LoadMeasurement;
          if (
            !Array.isArray(measurement.metrics) ||
            !measurement.metrics.length ||
            measurement.metrics.some((metric) => !(metric in BUDGETS)) ||
            ![measurement.start, measurement.end].every((value) => Number.isFinite(value) && value >= 0)
          )
            throw new Error('Invalid machine load measurement');
          this.load.push(measurement);
        } catch (error) {
          this.errors.push(String(error));
        }
        continue;
      }
      if (
        ['shell-assets', 'layout-shifts', 'scrolling-comparison', 'editing-phases'].includes(attachment.name)
      ) {
        try {
          this.details[attachment.name] = JSON.parse(
            (attachment.body ?? readFileSync(attachment.path!)).toString(),
          );
        } catch (error) {
          this.errors.push(String(error));
        }
        continue;
      }
      if (!attachment.name.startsWith('performance:')) continue;
      const metric = attachment.name.slice('performance:'.length) as Metric;
      if (!(metric in BUDGETS)) {
        this.errors.push(`Unknown metric: ${metric}`);
        continue;
      }
      try {
        const body = attachment.body ?? readFileSync(attachment.path!);
        const reading = JSON.parse(body.toString()) as number[] | { samples: number[]; trialSize: number };
        const samples = Array.isArray(reading) ? reading : reading.samples;
        const trialSize = Array.isArray(reading) ? undefined : reading.trialSize;
        summarize(metric, samples, trialSize);
        if (this.samples.has(metric) && this.trialSizes.get(metric) !== trialSize)
          throw new Error('Performance attachments must use the same trial size');
        if (trialSize !== undefined) this.trialSizes.set(metric, trialSize);
        this.samples.set(metric, [...(this.samples.get(metric) ?? []), ...samples]);
      } catch (error) {
        this.errors.push(String(error));
      }
    }
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
    const report: Report = {
      version: 1,
      at: new Date().toISOString(),
      status: result.status,
      fixture: { records: 1_000_000, fields: 20 },
      metrics: Object.fromEntries(
        [...this.samples].map(([metric, values]) => [
          metric,
          summarize(metric, values, this.trialSizes.get(metric)),
        ]),
      ),
      failures: [...this.errors],
      details: this.details,
      load: {
        limit: LOAD_LIMIT,
        underLoad: this.load.some(({ start, end }) => start > LOAD_LIMIT || end > LOAD_LIMIT),
        measurements: this.load,
      },
    };
    let previous: Report | undefined;
    try {
      if (existsSync(this.baseline)) {
        const parsed: unknown = JSON.parse(readFileSync(this.baseline, 'utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid baseline report');
        previous = parsed as Report;
      } else if (this.requireBaseline) report.failures.push('The requested baseline is missing');
    } catch (error) {
      report.failures.push(`Cannot read the baseline: ${String(error)}`);
    }
    let history: Report[] = [];
    try {
      history = passingReports(previous);
    } catch (error) {
      report.failures.push(`Cannot read the baseline history: ${String(error)}`);
    }
    report.failures.push(...failures(report, previous));
    // Invalid baseline samples already fail the run and cannot supply comparison details.
    try {
      report.comparison = compare(report, history);
    } catch {
      report.comparison = {
        status: report.load?.underLoad ? 'skipped-under-load' : 'no-baseline',
        metrics: {},
      };
    }
    if (report.failures.length) report.status = 'failed';
    if (report.status === 'passed') {
      // Loaded runs remain visible but never become regression baselines.
      const snapshot = { ...report };
      delete snapshot.history;
      report.history = (report.load?.underLoad ? history : [snapshot, ...history]).slice(0, HISTORY_LIMIT);
    }
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${this.directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    if (report.status === 'passed') {
      // Failed runs stay reviewable without making the next comparison accept a slower result.
      const last = `${this.directory}/last.json`;
      mkdirSync(dirname(last), { recursive: true });
      writeFileSync(`${last}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
      renameSync(`${last}.tmp`, last);
    }
    for (const failure of report.failures) process.stderr.write(`${failure}\n`);
    if (report.load?.underLoad)
      process.stdout.write(
        `Performance measurements were taken under load above ${LOAD_LIMIT}.  Regression comparison skipped.\n`,
      );
    process.stdout.write(`Performance report: ${this.directory}/report.json\n`);
    return { status: report.status === 'passed' ? 'passed' : 'failed' };
  }
}
