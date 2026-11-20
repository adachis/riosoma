import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AutomationRun, AutomationSimulation, ErrorBody } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  automate,
  createBase,
  createRecords,
  engine,
  grant,
  records,
  runRows,
  runsPage,
  testRun,
  type Base,
} from './automations.test-helpers.js';
import { scriptLimits } from './script-limits.js';
import {
  SCRIPT_RUN_MS,
  SCRIPT_STEPS,
  SCRIPT_TESTS_PER_PERSON,
  ScriptSlots,
  scriptBudget,
  scriptSlots,
} from './script-step.js';
import type { RunRow, StepResult } from './store.js';

let kit: TestPostgres;
let server: ServerFixture;
let base: Base;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'scriptstep', { automationsPollMs: 0 });
  base = await createBase(server);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  // A place a failed test still holds, or waits for, would keep the next test's scripts waiting.
  for (const place of places.splice(0))
    void place.then(
      (release) => release(),
      () => undefined,
    );
  // An automation a test turned on would start again for the next test's records.
  if (server)
    await query(server.pool, sql`UPDATE ${ident(server.schemas.app, 'automations')} SET enabled = false`);
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** A script that keeps its thread busy for this long, then finishes */
const spin = (ms: number) =>
  `const from = Date.now()\nwhile (Date.now() - from < ${ms}) {}\nawait output('done')`;

/**
 * A script the sandbox can't stop at its time limit by itself: each pass is one long built-in
 * operation, and the sandbox looks at the clock only once in a few thousand passes.  Left alone,
 * it runs for many times longer than the test that uses it allows.
 */
const UNINTERRUPTIBLE = `const list = new Array(1000000).fill('abcdefghij')\nfor (let i = 0; i < 3000; i++) list.join('')`;

const scripted = (source: string, id = 'script01') => ({ id, kind: 'script', input: {}, script: source });

async function withLimits<T>(
  limits: { timeoutMs: number; runMs?: number },
  work: () => Promise<T>,
): Promise<T> {
  const before = { limits: server.config.scriptLimits, runMs: server.config.automationScriptRunMs };
  server.config.scriptLimits = { ...(before.limits ?? scriptLimits()), timeoutMs: limits.timeoutMs };
  server.config.automationScriptRunMs = limits.runMs;
  try {
    return await work();
  } finally {
    server.config.scriptLimits = before.limits;
    server.config.automationScriptRunMs = before.runMs;
  }
}

/** Runs `work`, and says how long the server's own thread went at most without taking a turn. */
async function watched<T>(work: () => Promise<T>): Promise<{ value: T; stall: number; ms: number }> {
  const started = performance.now();
  let last = started;
  let stall = 0;
  const beat = () => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  };
  const timer = setInterval(beat, 10);
  try {
    const value = await work();
    beat();
    return { value, stall, ms: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

const post = (url: string, payload: Record<string, unknown> = {}) =>
  server.app.inject({ method: 'POST', url, headers: server.owner.headers, payload });

const places: Array<Promise<() => void>> = [];

/** Takes one of the organization's places for script steps, or waits for one, as a test's script does */
function takePlace(orgId: string): Promise<() => void> {
  const place = scriptSlots.claim(orgId, true);
  places.push(place);
  return place;
}

/** Every place the organization has for script steps, taken until the test gives them back */
const takeEveryPlace = (orgId: string) =>
  Promise.all(Array.from({ length: SCRIPT_STEPS.perOrganization }, () => takePlace(orgId)));

/** Resolves once this many script steps have asked for a place since the watch began */
function watchClaims() {
  const claims = vi.spyOn(scriptSlots, 'claim');
  return (count: number) =>
    vi.waitFor(() => expect(claims).toHaveBeenCalledTimes(count), { timeout: 30_000, interval: 20 });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stored run's steps in short, for a failed expectation to show */
const brief = (run: RunRow | undefined) =>
  JSON.stringify(run?.steps.map((step) => [step.stepId, step.state, step.error?.messageKey ?? null]));

describe('script steps and the server’s thread', () => {
  it('keeps the server answering while a script spins, however the step is run', async () => {
    const id = await automate(
      server,
      base.databaseId,
      { trigger: { kind: 'webhook' }, steps: [scripted(spin(1_500))] },
      { enabled: false },
    );
    const routes: Array<[string, (body: unknown) => unknown]> = [
      [`/api/automations/${id}/test`, (body) => (body as AutomationRun).steps[0]],
      [`/api/automations/${id}/steps/script01/test`, (body) => (body as AutomationRun).steps[0]],
      [`/api/automations/${id}/simulate`, (body) => (body as AutomationSimulation).steps[0]],
    ];
    for (const [url, step] of routes) {
      const { value: response, stall } = await watched(() => post(url));
      expect(response.statusCode, response.body).toBe(200);
      expect(step(response.json()), url).toMatchObject({ state: 'succeeded', output: { value: 'done' } });
      // The script held its own thread for a second and a half, and the server's for none of it.
      expect(stall, url).toBeLessThan(750);
    }
  });

  it('ends a script whose built-in operations outlast its time limit', async () => {
    const id = await automate(
      server,
      base.databaseId,
      { trigger: { kind: 'webhook' }, steps: [scripted(UNINTERRUPTIBLE)] },
      { enabled: false },
    );
    const { value, stall, ms } = await withLimits({ timeoutMs: 300 }, () =>
      watched(() => testRun(server, id)),
    );
    expect(value.run.state, value.body).toBe('failed');
    expect(value.run.steps[0]?.error).toMatchObject({ messageKey: 'automations.script.timeout' });
    // The server ends the thread a second after the limit.  The sandbox alone would let the
    // script go on for many times this long.
    expect(ms).toBeLessThan(5_000);
    expect(stall).toBeLessThan(750);
  });

  it('gives all of a run’s script steps one time limit, so a loop can’t multiply a step’s', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'repeat01',
            kind: 'repeat',
            list: '[1, 2, 3, 4, 5, 6, 7, 8]',
            steps: [scripted(spin(2_000), 'looped01')],
          },
        ],
      },
      { enabled: false },
    );
    // Each pass takes two seconds of the five seconds the run's scripts have in all.  Scaling
    // the pass and both limits together leaves scheduling headroom while preserving their ratios.
    const { run, body } = await withLimits({ timeoutMs: 20_000, runMs: 5_000 }, () => testRun(server, id));
    expect(run.state, body).toBe('failed');
    const looped = run.steps.filter((step) => step.stepId === 'looped01');
    expect(looped.find((step) => step.state === 'failed')?.error).toMatchObject({
      messageKey: 'automations.script.runTimeout',
    });
    const finished = looped.filter((step) => step.state === 'succeeded').length;
    expect(finished).toBeGreaterThanOrEqual(1);
    expect(finished).toBeLessThanOrEqual(3);
  });
});

describe('script steps off the server’s thread', () => {
  it('still map inputs, write records, keep logs, and report where a script failed', async () => {
    const id = await automate(
      server,
      base.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'script01',
            kind: 'script',
            input: { label: 'Entry {{trigger.body.n}}', n: '{{trigger.body.n}}' },
            script: [
              `const made = await records.create('${base.log}', { '${base.f.summary}': input.label })`,
              `const found = await records.find('${base.log}', { limit: 100 })`,
              'await console.warn(typeof input.n, found.length > 0)',
              'await output({ recordId: made.recordId })',
              'throw new Error("after the output")',
            ].join('\n'),
          },
        ],
      },
      { enabled: false },
    );
    const { run, body } = await testRun(server, id);
    expect(run.state, body).toBe('failed');
    const step = run.steps[0]!;
    expect(step.error).toMatchObject({
      messageKey: 'automations.script.thrown',
      detail: 'after the output',
      line: 5,
    });
    // What the script set before it failed is kept, as are its messages and its write.
    const value = step.output?.value as { recordId: string };
    expect(step.logs).toEqual([{ level: 'warn', text: 'object true' }]);
    const rows = await records(server, base.log);
    expect(rows.find((row) => row.__id === value.recordId)?.[base.f.summary]).toBe('Entry ');
  });
});

describe('how many script steps run at once', () => {
  /** Lets every claim that can go ahead do so */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('runs a few for one organization and for the server, and the rest wait their turn', async () => {
    const slots = new ScriptSlots({ perOrganization: 2, perServer: 3, waitingPerOrganization: 4 });
    const order: string[] = [];
    const claim = (orgId: string, name: string) => {
      const claimed = slots.claim(orgId, true);
      void claimed.then(() => order.push(name));
      return claimed;
    };
    const first = await claim('one', 'one-1');
    const second = await claim('one', 'one-2');
    // The organization's third waits for one of its own, and the server's fourth for anyone's.
    const third = claim('one', 'one-3');
    const other = await claim('two', 'two-1');
    const fourth = claim('two', 'two-2');
    const late = claim('three', 'three-1');
    await settle();
    expect(order).toEqual(['one-1', 'one-2', 'two-1']);
    // Giving one back twice frees one slot, not two.
    first();
    first();
    await settle();
    expect(order).toEqual(['one-1', 'one-2', 'two-1', 'one-3']);
    // The first in line that fits goes next, so a full organization holds up only itself.
    other();
    await settle();
    expect(order).toEqual(['one-1', 'one-2', 'two-1', 'one-3', 'two-2']);
    second();
    await settle();
    expect(order.at(-1)).toBe('three-1');
    for (const release of [await third, await fourth, await late]) release();
    const again = await claim('one', 'one-4');
    again();
  });

  it('refuses a test whose organization has too many waiting, and no one else', async () => {
    const slots = new ScriptSlots({ perOrganization: 1, perServer: 2, waitingPerOrganization: 2 });
    const running = await slots.claim('one', true);
    const waiting = [slots.claim('one', true), slots.claim('one', true)];
    await expect(slots.claim('one', true)).rejects.toMatchObject({ messageKey: 'scripts.run.busy' });
    const other = await slots.claim('two', true);
    other();
    running();
    (await waiting[0]!)();
    (await waiting[1]!)();
  });

  it('never refuses a published run, which waits behind a full line and then has its turn', async () => {
    const slots = new ScriptSlots({ perOrganization: 1, perServer: 2, waitingPerOrganization: 2 });
    const order: string[] = [];
    const running = await slots.claim('one', true);
    const tests = [slots.claim('one', true), slots.claim('one', true)];
    const published = [slots.claim('one', false), slots.claim('one', false)];
    for (const [index, claim] of [...tests, ...published].entries())
      void claim.then(() => order.push(String(index)));
    // The line is as long as a test may join, and the runs joined it all the same.
    await expect(slots.claim('one', true)).rejects.toMatchObject({ messageKey: 'scripts.run.busy' });
    running();
    for (const claim of [...tests, ...published]) (await claim)();
    await settle();
    expect(order).toEqual(['0', '1', '2', '3']);
  });
});

describe('a script step among its organization’s others', () => {
  it('waits for a place when a test runs it, and is refused when too many already wait', async () => {
    const id = await automate(
      server,
      base.databaseId,
      { trigger: { kind: 'webhook' }, steps: [scripted(`await output('ran')`)] },
      { enabled: false },
    );
    const orgId = server.owner.info.org.id;
    const taken = await takeEveryPlace(orgId);
    const asked = watchClaims();
    let finished = false;
    const waiting = testRun(server, id).then((result) => {
      finished = true;
      return result;
    });
    await asked(1);
    await pause(500);
    expect(finished).toBe(false);
    // With the line behind it full, the next one is told so instead of waiting.
    const line = Array.from({ length: SCRIPT_STEPS.waitingPerOrganization - 1 }, () => takePlace(orgId));
    const refused = await testRun(server, id);
    expect(refused.run.state, refused.body).toBe('failed');
    expect(refused.run.steps[0]?.error).toMatchObject({ messageKey: 'scripts.run.busy' });
    expect(finished).toBe(false);
    // The first place given back goes to the step that waited longest.
    taken[0]!();
    const { run, body } = await waiting;
    expect(run.state, body).toBe('succeeded');
    expect(run.steps[0]?.output).toEqual({ value: 'ran' });
    for (const release of taken) release();
    for (const claim of line) (await claim)();
  });

  it('waits for a place when a published run runs it, however many already wait', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [scripted(`await output('ran')`)],
    });
    const orgId = server.owner.info.org.id;
    const taken = await takeEveryPlace(orgId);
    // The line is as long as a test may join.
    const line = Array.from({ length: SCRIPT_STEPS.waitingPerOrganization }, () => takePlace(orgId));
    await expect(scriptSlots.claim(orgId, true)).rejects.toMatchObject({ messageKey: 'scripts.run.busy' });
    const asked = watchClaims();
    await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Published' }]);
    const draining = engine(server).drain();
    await asked(1);
    await pause(500);
    expect((await runRows(server, id)).map((run) => run.state)).toEqual(['running']);
    // Everyone ahead of it has a turn, and then it has its own.
    for (const release of taken) release();
    for (const claim of line) (await claim)();
    await draining;
    const [run] = await runRows(server, id);
    expect(run?.state, brief(run)).toBe('succeeded');
    expect(run?.steps[0]?.output).toEqual({ value: 'ran' });
  });
});

describe('one person’s tests and simulations with script steps', () => {
  it('are refused past a few at once, however they’re run, and hold up no one else’s', async () => {
    const webhook = { kind: 'webhook' };
    const id = await automate(
      server,
      base.databaseId,
      { trigger: webhook, steps: [scripted(`await output('ran')`)] },
      { enabled: false },
    );
    const plain = await automate(
      server,
      base.databaseId,
      {
        trigger: webhook,
        steps: [
          { id: 'create01', kind: 'createRecord', tableId: base.log, values: { [base.f.summary]: 'Plain' } },
        ],
      },
      { enabled: false },
    );
    const member = await server.addMember();
    await grant(server, base.databaseId, member, 'creator');
    const taken = await takeEveryPlace(server.owner.info.org.id);
    const asked = watchClaims();
    // As many of the owner's as one person may have under way, each waiting for a place.
    expect(SCRIPT_TESTS_PER_PERSON).toBe(2);
    const testing = testRun(server, id);
    const simulating = post(`/api/automations/${id}/simulate`);
    await asked(2);
    // One more is refused at once, and nothing of it is kept or waits for a place.
    for (const url of ['test', 'steps/script01/test', 'simulate']) {
      const refused = await post(`/api/automations/${id}/${url}`);
      expect(refused.statusCode, url).toBe(429);
      expect(refused.json<ErrorBody>().error.messageKey, url).toBe('scripts.run.busy');
    }
    await pause(200);
    await asked(2);
    expect(await runRows(server, id)).toHaveLength(1);
    // A test with no script step isn't counted, and neither is looking at what a test would use.
    const other = await testRun(server, plain);
    expect(other.run.state, other.body).toBe('succeeded');
    const preview = await post(`/api/automations/${id}/steps/script01/test`, { preview: true });
    expect(preview.statusCode, preview.body).toBe(200);
    // Someone else's test takes its own turn behind them.
    const theirs = testRun(server, id, {}, member);
    await asked(3);
    for (const release of taken) release();
    const [tested, simulated] = await Promise.all([testing, simulating]);
    expect(tested.run.state, tested.body).toBe('succeeded');
    expect(simulated.statusCode, simulated.body).toBe(200);
    expect(simulated.json<AutomationSimulation>().steps[0]).toMatchObject({ state: 'succeeded' });
    const { run, body } = await theirs;
    expect(run.state, body).toBe('succeeded');
    // With those finished, the owner can test again.
    const again = await testRun(server, id);
    expect(again.run.state, again.body).toBe('succeeded');
  });
});

describe('the time a run’s script steps have left', () => {
  const steps = [
    { id: 'script01', kind: 'script', input: {}, script: '' },
    {
      id: 'repeat01',
      kind: 'repeat',
      list: '[]',
      steps: [
        { id: 'looped01', kind: 'script', input: {}, script: '' },
        { id: 'webhook1', kind: 'callWebhook', url: '', method: 'POST', headers: {}, body: '' },
      ],
    },
  ] as unknown as Parameters<typeof scriptBudget>[1];
  const result = (stepId: string, ms: number | null, extra: Partial<StepResult> = {}): StepResult => ({
    stepId,
    state: 'succeeded',
    ms,
    output: null,
    error: null,
    ...extra,
  });

  it('starts at five minutes, or what the configuration says', () => {
    expect(scriptBudget({}, steps, []).leftMs).toBe(SCRIPT_RUN_MS);
    expect(SCRIPT_RUN_MS).toBe(300_000);
    expect(scriptBudget({ automationScriptRunMs: 900 }, steps, []).leftMs).toBe(900);
  });

  it('counts what a run picked up again already spent on scripts, and nothing else', () => {
    const results = [
      // The script's own time counts, not the time the whole step took around it.
      result('script01', 4_000, { scriptMs: 200 }),
      result('looped01', 900, { scriptMs: 300, executionId: 'repeat01/0/looped01', path: ['repeat01', '0'] }),
      result('looped01', 700, { scriptMs: 0, executionId: 'repeat01/1/looped01', path: ['repeat01', '1'] }),
      // A result saved before the script's own time was kept has only the whole step's.
      result('looped01', 100, { executionId: 'repeat01/2/looped01', path: ['repeat01', '2'] }),
      // Other steps' time, steps that didn't run, and steps another run ran don't count.
      result('webhook1', 5_000),
      result('looped01', null, { state: 'skipped' }),
      result('script01', 4_000, { scriptMs: 4_000, reused: true }),
    ];
    expect(scriptBudget({ automationScriptRunMs: 1_000 }, steps, results).leftMs).toBe(400);
  });

  it('is the same after a wait as before it, however long a script waited for its place', async () => {
    const id = await automate(server, base.databaseId, {
      trigger: { kind: 'recordCreated', tableId: base.tasks },
      steps: [
        scripted(`await output('before')`, 'script01'),
        {
          id: 'waiting1',
          kind: 'wait',
          mode: 'duration',
          seconds: 3600,
          date: '',
          conditions: null,
          timeoutSeconds: 3600,
        },
        scripted(`await output('after')`, 'script02'),
      ],
    });
    await withLimits({ timeoutMs: 2_000, runMs: 1_000 }, async () => {
      // The first script waits for a place for longer than all of the run's scripts may take.
      const taken = await takeEveryPlace(server.owner.info.org.id);
      const asked = watchClaims();
      await createRecords(server, base.databaseId, base.tasks, [{ [base.f.name]: 'Waits' }]);
      const draining = engine(server).drain();
      await asked(1);
      await pause(1_200);
      for (const release of taken) release();
      await draining;
      const [waiting] = await runRows(server, id);
      expect(waiting?.state, brief(waiting)).toBe('waiting');
      const first = waiting!.steps[0]!;
      expect(first.ms).toBeGreaterThan(1_000);
      expect(first.scriptMs).toBeLessThan(1_000);
      // The run goes on once its wait is over, with the second script still to run.
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'automation_runs')}
        SET wake_at = clock_timestamp() WHERE id = ${waiting!.id}`,
      );
      const deadline = Date.parse(String(waiting!.steps[1]?.output?.deadline));
      const later = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      await engine(server)
        .drain()
        .finally(() => later.mockRestore());
      const [finished] = await runRows(server, id);
      expect(finished?.state, brief(finished)).toBe('succeeded');
      expect(finished?.steps[2]?.output).toEqual({ value: 'after' });
    });
    // People see how long each step took, and the figure the limit counts stays with the run.
    const shown = (await runsPage(server, id)).page.runs[0]!;
    expect(shown.steps[0]).toMatchObject({ stepId: 'script01', state: 'succeeded' });
    expect(shown.steps[0]).not.toHaveProperty('scriptMs');
  });
});
