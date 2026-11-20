import type { TestInfo } from '@playwright/test';
import { test } from './accessibility';
import type { StandIn } from './stack';

/** The address of the server started for the browser running this test. */
export function base(): string {
  const url = process.env[`RIOSOMA_E2E_BASE_URL_${test.info().project.name}`];
  if (!url) throw new Error('No test server for this browser; is the global setup running?');
  return url;
}

/** The superuser address of the PostgreSQL database behind that server. */
export function databaseURL(): string {
  const url = process.env[`RIOSOMA_E2E_DATABASE_URL_${test.info().project.name}`];
  if (!url) throw new Error('No test database for this browser; is the global setup running?');
  return url;
}

/** The folder where the mail catcher keeps every message that server sends. */
export function mailDir(): string {
  const dir = process.env[`RIOSOMA_E2E_MAIL_DIR_${test.info().project.name}`];
  if (!dir) throw new Error('No mail catcher for this browser.  Is the global setup running?');
  return dir;
}

/** Where a stand-in for an outside service that server calls listens, and its certificate. */
export function standIn(): StandIn {
  const value = process.env[`RIOSOMA_E2E_STAND_IN_${test.info().project.name}`];
  if (!value) throw new Error('No stand-in port for this browser.  Is the global setup running?');
  return JSON.parse(value) as StandIn;
}

// Large pages may need several full scans as asynchronous rendering replaces their state.
export const accessibilityScanTimeout = 60_000;

/** Scanning shares the test's budget and leaves time to restore instrumentation during teardown. */
export function accessibilityDeadline(info: Pick<TestInfo, 'timeout'>, started: number): number {
  const now = Date.now();
  return Math.min(now + accessibilityScanTimeout, info.timeout ? started + info.timeout - 250 : Infinity);
}

/** Accessibility instrumentation gets bounded time without spending the functional test budget. */
export class AccessibilityBudget {
  private running = 0;
  private scanStarted = 0;
  private timeoutBefore = 0;

  constructor(
    private readonly info: Pick<TestInfo, 'timeout' | 'setTimeout'>,
    private readonly started: number,
  ) {}

  async run<T>(operation: (deadline: number) => Promise<T>, teardownDeadline?: number): Promise<T> {
    // Teardown shares the remaining timeout.  It never receives another allowance.
    if (teardownDeadline !== undefined || !this.info.timeout)
      return operation(teardownDeadline ?? accessibilityDeadline(this.info, this.started));
    if (this.running++ === 0) {
      this.scanStarted = Date.now();
      this.timeoutBefore = this.info.timeout;
    }
    // Overlapping page checks share one allowance and charge their elapsed time only once.
    this.info.setTimeout(this.timeoutBefore + Date.now() - this.scanStarted + accessibilityScanTimeout);
    try {
      return await operation(accessibilityDeadline(this.info, this.started));
    } finally {
      this.running--;
      this.info.setTimeout(
        this.timeoutBefore + Date.now() - this.scanStarted + (this.running ? accessibilityScanTimeout : 0),
      );
    }
  }
}
