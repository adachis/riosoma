import { AppError, flattenAutomationSteps, type AutomationStep } from '@riosoma/contracts';
import type { RuntimeConfig } from '../config.js';
import { runInSandbox, type SandboxRun } from '../scripts/sandbox.js';
import { ScriptError, type ScriptHost, type ScriptLimits, type ScriptLog } from './script.js';
import { scriptLimits } from './script-limits.js';
import type { StepResult } from './store.js';

/**
 * An automation's script step, kept from holding up the server or anyone else's work.  The script
 * runs in the sandbox on a worker thread of its own, so the server goes on answering while it
 * spins, and the thread is ended soon after the step's time limit whatever the script is doing.
 * Only a few run at once, for one organization and for the server, and all of one run's script
 * steps share a time limit, so a loop can't multiply a step's.  One person's tests and simulations
 * take up only a few of their organization's places, and a published run always gets its turn.
 */

/** Script steps one organization, and one server, may have running at once, and how many more may wait */
export const SCRIPT_STEPS = { perOrganization: 4, perServer: 8, waitingPerOrganization: 16 };

/** How long all of one run's script steps may take together, in milliseconds, unless the configuration says */
export const SCRIPT_RUN_MS = 300_000;

/** Tests and simulations with a script step that one person may have under way at once on one server */
export const SCRIPT_TESTS_PER_PERSON = 2;

const RUN_TIMEOUT = 'automations.script.runTimeout';

/**
 * Who may start a script step now.  Each organization, and the server, runs a few at once, and the
 * rest wait their turn in the order they came.
 */
export class ScriptSlots {
  private readonly running = new Map<string, number>();
  private readonly waiting: Array<{ orgId: string; start(): void }> = [];
  private total = 0;

  constructor(private readonly limits: typeof SCRIPT_STEPS = SCRIPT_STEPS) {}

  private open(orgId: string): boolean {
    return this.total < this.limits.perServer && (this.running.get(orgId) ?? 0) < this.limits.perOrganization;
  }

  private take(orgId: string): void {
    this.running.set(orgId, (this.running.get(orgId) ?? 0) + 1);
    this.total += 1;
  }

  /**
   * Waits for a slot and takes it.  The function it resolves with gives the slot back.  A test or
   * a simulation is refused when its organization has too many waiting already, so no request
   * waits long.  A published run waits however long the line is: the engine has only a few runs
   * under way at once, so they can't fill a line themselves, and a run refused here would fail
   * because of what other people started.
   */
  async claim(orgId: string, test: boolean): Promise<() => void> {
    const ahead = this.waiting.filter((waiter) => waiter.orgId === orgId).length;
    if (!ahead && this.open(orgId)) this.take(orgId);
    else {
      if (test && ahead >= this.limits.waitingPerOrganization) throw new ScriptError('scripts.run.busy');
      // Whoever gives a slot back takes it for the one waiting, so nothing slips in between.
      await new Promise<void>((start) => this.waiting.push({ orgId, start }));
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.running.get(orgId) ?? 1) - 1;
      if (left) this.running.set(orgId, left);
      else this.running.delete(orgId);
      this.total -= 1;
      for (let index = 0; index < this.waiting.length && this.total < this.limits.perServer;) {
        const waiter = this.waiting[index]!;
        if (!this.open(waiter.orgId)) index += 1;
        else {
          this.waiting.splice(index, 1);
          this.take(waiter.orgId);
          waiter.start();
        }
      }
    };
  }
}

/** One for the whole server, since the threads it counts are the server's */
export const scriptSlots = new ScriptSlots();

const testing = new Map<string, number>();

/**
 * Runs a person's test or simulation, counted against them when `steps`, what it runs, has a
 * script step.  Tests and simulations run inside the request that asks for them, so nothing else
 * limits how many one person has under way, and each holds or waits for one of their
 * organization's places for scripts.  Counted here, one person takes up only a few of those
 * places, and the rest stay free for everyone else's tests and for published runs.
 */
export async function testingScripts<T>(
  userId: string,
  steps: readonly AutomationStep[],
  work: () => Promise<T>,
): Promise<T> {
  if (!flattenAutomationSteps(steps).some((step) => step.kind === 'script')) return work();
  const mine = testing.get(userId) ?? 0;
  if (mine >= SCRIPT_TESTS_PER_PERSON) throw new AppError('rate_limited', 'scripts.run.busy');
  testing.set(userId, mine + 1);
  try {
    return await work();
  } finally {
    const left = (testing.get(userId) ?? 1) - 1;
    if (left) testing.set(userId, left);
    else testing.delete(userId);
  }
}

/** The time a run's script steps have left together */
export interface ScriptBudget {
  leftMs: number;
  /** The script's own time in the script step that ran last, which its result keeps as `scriptMs` */
  stepMs: number;
}

/**
 * What a run's script steps have left together when it starts, or starts again after a wait or
 * on another server: the limit, less the scripts' own time in the script steps it already ran,
 * which is what the run was charged as it went.  Steps carried over from another run, as a
 * resumed run's are, were that run's.
 */
export function scriptBudget(
  config: Pick<RuntimeConfig, 'automationScriptRunMs'>,
  steps: readonly AutomationStep[],
  results: readonly StepResult[],
): ScriptBudget {
  const scripts = new Set(
    flattenAutomationSteps(steps)
      .filter((step) => step.kind === 'script')
      .map((step) => step.id),
  );
  const spent = results.reduce(
    (sum, result) =>
      // A result saved before results kept the script's own time has only the whole step's.
      sum + (scripts.has(result.stepId) && !result.reused ? (result.scriptMs ?? result.ms ?? 0) : 0),
    0,
  );
  return { leftMs: (config.automationScriptRunMs ?? SCRIPT_RUN_MS) - spent, stepMs: 0 };
}

/**
 * Runs a script step's script and resolves with the output it set, or rejects with the
 * `ScriptError` it failed with.  `host` answers the script's calls on the server's thread.
 */
export async function runScriptStep(
  source: string,
  input: Record<string, unknown>,
  host: ScriptHost,
  logs: ScriptLog[],
  options: {
    limits?: ScriptLimits;
    orgId: string;
    budget: ScriptBudget;
    /** Whether a person's test or simulation runs it, which is refused where a published run waits */
    test: boolean;
  },
): Promise<unknown> {
  const { budget } = options;
  budget.stepMs = 0;
  if (budget.leftMs <= 0) throw new ScriptError(RUN_TIMEOUT);
  const limits = { ...(options.limits ?? scriptLimits()) };
  // Checked here as the sandbox checks them, before a thread is started or anything is copied to it.
  if (Buffer.byteLength(source) > 65536 || Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024)
    throw new ScriptError('automations.script.bridgeLimit');
  const release = await scriptSlots.claim(options.orgId, options.test);
  // The step's own limit, or what the run's script steps have left when that's less.
  const last = budget.leftMs < limits.timeoutMs;
  if (last) limits.timeoutMs = Math.max(1, Math.floor(budget.leftMs));
  // Calls still under way when the script stops, such as a write, finish before the step reports.
  const inFlight = new Set<Promise<unknown>>();
  let sandbox: SandboxRun | undefined;
  try {
    sandbox = runInSandbox(
      source,
      limits,
      {
        call: (method, args, remainingMs) => {
          const call = host.call(method, args, remainingMs);
          inFlight.add(call);
          const settled = () => inFlight.delete(call);
          void call.then(settled, settled);
          return call;
        },
      },
      { log: (entry) => logs.push(entry), output: () => {} },
      new AbortController().signal,
      { surface: 'automation', input },
    );
    return (await sandbox.done).value;
  } catch (error) {
    if (!last || !(error instanceof ScriptError) || error.messageKey !== 'automations.script.timeout')
      throw error;
    const spent = new ScriptError(RUN_TIMEOUT);
    spent.output = error.output;
    throw spent;
  } finally {
    release();
    // The run is charged the script's own time, from when its sandbox was ready, and not the wait
    // for a place or the thread's start.  The step's result keeps the same figure, so a run that
    // starts again has what it had left.
    budget.stepMs = Math.ceil(sandbox?.used() ?? 0);
    budget.leftMs -= budget.stepMs;
    await Promise.allSettled([...inFlight]);
  }
}
