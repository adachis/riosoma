import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { base } from '../base';
import { createDatabase, newId, runCommands, signIn, type SeededDatabase, visit } from '../helpers';
import { rows } from '../sql';
import {
  BUDGETS,
  TIMING_SAMPLES,
  EDITS_PER_TRIAL,
  framePeriods,
  measure,
  record,
  summarize,
} from './metrics';

const RECORDS = 1_000_000;
const SAMPLES = EDITS_PER_TRIAL;
const CELL = '[role="gridcell"][data-rio-row="0"][data-rio-col="0"]';
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

let database: SeededDatabase;
let address: string;
let sortedAddress: string;
let sparklineAddress: string;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await signIn(page);
    database = await createDatabase(page, 'Performance budgets', [
      {
        name: 'Records',
        fields: Array.from({ length: 20 }, (_, index) => ({
          name: `Field ${index + 1}`,
          type: index >= 13 ? 'json' : index ? 'number' : 'text',
        })),
      },
    ]);
    const table = database.tables.Records!;
    const schemas = await rows<{ table_schema: string }>(
      'SELECT table_schema FROM information_schema.tables WHERE table_name = $1',
      [table.id],
    );
    expect(schemas).toHaveLength(1);
    const physical = `${quote(schemas[0]!.table_schema)}.${quote(table.id)}`;
    const fields = Object.values(table.fields);
    // Bulk insertion keeps fixture setup out of the measured UI operations.
    await rows(`INSERT INTO ${physical} (__id, ${fields.map(quote).join(', ')})
      SELECT 'rec' || lpad(n::text, 14, '0'), 'Record ' || n, ${fields
        .slice(1)
        .map((_, index) =>
          index >= 12 ? `jsonb_build_array(n, n - 3, n + 5, n - 8, n + 2)` : `n + ${index}`,
        )
        .join(', ')}
      FROM generate_series(1, ${RECORDS}) AS n`);
    await rows(`CREATE INDEX ${quote(`perf_${table.id}`)} ON ${physical} (${quote(fields[1]!)}, __rid)
      WHERE __deleted_at IS NULL`);
    await rows(`ANALYZE ${physical}`);
    const count = await rows<{ count: string }>(`SELECT count(*) FROM ${physical}`);
    expect(Number(count[0]!.count)).toBe(RECORDS);
    const sorted = newId('viw');
    await runCommands(page, database.id, [
      {
        kind: 'view.create',
        view: {
          id: sorted,
          tableId: table.id,
          name: 'Indexed sort',
          type: 'grid',
          config: { sorts: [{ fieldId: fields[1], direction: 'asc' }] },
        },
      },
    ]);
    const sparkline = newId('viw');
    await runCommands(page, database.id, [
      {
        kind: 'view.create',
        view: {
          id: sparkline,
          tableId: table.id,
          name: 'Sparklines',
          type: 'grid',
          config: {
            hiddenFieldIds: fields.slice(1, 13),
            sparklines: fields.slice(13).map((fieldId, index) => ({
              fieldId,
              type: index % 3 === 0 ? 'line' : index % 3 === 1 ? 'column' : 'winLoss',
              first: true,
              last: true,
              min: true,
              max: true,
            })),
          },
        },
      },
    ]);
    sparklineAddress = `${base()}/${database.id}/${table.id}/${sparkline}`;
    address = `${base()}/${database.id}/${table.id}/${table.viewId}`;
    sortedAddress = `${base()}/${database.id}/${table.id}/${sorted}`;
    // Warm the ordinary view's server snapshot and the browser's compiled modules.
    await visit(page, address);
    await expect(page.locator(CELL)).toHaveText('Record 1');
    await page.waitForLoadState('networkidle');
    cookies = await context.cookies();
  } finally {
    await context.close();
  }
});

async function owner(page: Page): Promise<void> {
  await page.context().addCookies(cookies);
}

/** Starts the clock in the browser, and ends it when the requested row's contents arrive. */
async function observe(page: Page, selector: string, text: string): Promise<void> {
  await page.evaluate(
    ({ selector, text }) => {
      window.perfRow = { start: performance.now(), duration: null };
      const observer = new MutationObserver(() => {
        const cell = document.querySelector(selector);
        if (cell?.textContent === text && !cell.hasAttribute('data-loading')) {
          window.perfRow.duration = performance.now() - window.perfRow.start;
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    },
    { selector, text },
  );
}

async function duration(page: Page): Promise<number> {
  await page.waitForFunction(() => window.perfRow.duration !== null);
  return page.evaluate(() => window.perfRow.duration!);
}

declare global {
  interface Window {
    perfRow: { start: number; duration: number | null };
    perfEdits: {
      started: number;
      echo: number[];
      ack: number[];
      errors: string[];
      peers: Record<string, number>;
      phases: Array<{ sentMs: number; headersMs: number; bodyMs: number; wireMs: number | null }>;
    };
  }
}

test('warm first rows, a distant jump, and a fresh indexed sort', async ({ page }) => {
  await owner(page);
  await page.goto(address);
  await expect(page.locator(CELL)).toHaveText('Record 1');
  await page.waitForLoadState('networkidle');
  // The observer is installed before the reload so no portion of navigation is omitted.
  await page.addInitScript(() => {
    window.perfRow = { start: 0, duration: null };
    const observer = new MutationObserver(() => {
      if (
        document.querySelector('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]')?.textContent ===
        'Record 1'
      ) {
        window.perfRow.duration = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  });
  const first: number[] = [];
  const jumps: number[] = [];
  const sorts: number[] = [];
  // Each operation has its own unreported warmup, followed by five independent trials.
  for (let sample = -1; sample < TIMING_SAMPLES; sample++) {
    const value = await measure(['firstRowsMs'], async () => {
      await page.reload({ waitUntil: 'commit' });
      const value = await duration(page);
      await page.waitForLoadState('networkidle');
      return value;
    });
    if (sample >= 0) first.push(value);
  }
  await record('firstRowsMs', first);
  for (let sample = -1; sample < TIMING_SAMPLES; sample++) {
    // Reset the viewport and browser row cache so every trial requests the distant page.
    await page.reload();
    await expect(page.locator(CELL)).toHaveText('Record 1');
    await page.waitForLoadState('networkidle');
    const value = await measure(['jumpMs'], async () => {
      await observe(page, '[role="gridcell"][data-rio-row="899999"][data-rio-col="0"]', 'Record 900000');
      await page.evaluate(() => {
        const row = document.querySelector('[role="row"][data-rio-row="0"]')!;
        window.perfRow.start = performance.now();
        document.querySelector('.rio-grid__viewport')!.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 899_999 * row.getBoundingClientRect().height,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      return duration(page);
    });
    if (sample >= 0) jumps.push(value);
  }
  await record('jumpMs', jumps);
  for (let sample = -1; sample < TIMING_SAMPLES; sample++) {
    // A reload measures a fresh browser read while the warmup removes server startup effects.
    const value = await measure(['indexedSortMs'], async () => {
      await page.goto(sortedAddress, { waitUntil: 'commit' });
      const value = await duration(page);
      await page.waitForLoadState('networkidle');
      return value;
    });
    if (sample >= 0) sorts.push(value);
  }
  await record('indexedSortMs', sorts);
  await expect(page.getByRole('grid')).toHaveAttribute('aria-colcount', '20');
});

for (const charts of [false, true])
  test(`continuous scrolling sustains the frame budget with real row requests${charts ? ' and sparklines' : ''}`, async ({
    page,
  }) => {
    // The control uses this test's viewport and launch options, before any application code loads.
    const emptyPageIntervals = charts
      ? await measure(['frameP95Ms'], () =>
          page.evaluate(async () => {
            const intervals: number[] = [];
            let start = 0;
            let previous = 0;
            await new Promise<void>((done) => {
              const tick = (time: number) => {
                if (!start) start = time;
                if (previous) intervals.push(time - previous);
                previous = time;
                if (time - start >= 5_000) done();
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            });
            return intervals;
          }),
        )
      : null;
    await owner(page);
    await page.goto(address);
    await expect(page.locator(CELL)).toHaveText('Record 1');
    if (charts) {
      await page.goto(sparklineAddress);
      await expect(page.locator('.rio-sparkline svg').first()).toBeVisible();
    }
    const intervals: number[] = [];
    const periods: number[] = [];
    const frameRates: number[] = [];
    for (let sample = -1; sample < TIMING_SAMPLES; sample++) {
      // Start each five-second trial from the same row rather than reusing a progressively warm viewport.
      await page.goto(charts ? sparklineAddress : address);
      await expect(page.locator(CELL)).toHaveText('Record 1');
      await page.waitForLoadState('networkidle');
      const result = await measure(['frameP95Ms', 'scrollingFps'], () =>
        page.evaluate(async () => {
          const viewport = document.querySelector('.rio-grid__viewport')!;
          const intervals: number[] = [];
          let start = 0;
          let previous = 0;
          await new Promise<void>((done) => {
            const tick = (time: number) => {
              if (!start) start = time;
              if (previous) intervals.push(time - previous);
              previous = time;
              viewport.dispatchEvent(
                new WheelEvent('wheel', { deltaY: 16, bubbles: true, cancelable: true }),
              );
              if (time - start >= 5_000) done();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          return {
            intervals,
            row: Number(document.querySelector('[role="gridcell"]')?.getAttribute('data-rio-row')),
          };
        }),
      );
      expect(result.row).toBeGreaterThan(100);
      if (sample < 0) continue;
      intervals.push(...result.intervals);
      periods.push(...framePeriods(result.intervals));
      frameRates.push(
        (1_000 * result.intervals.length) / result.intervals.reduce((sum, value) => sum + value, 0),
      );
    }
    await record('frameP95Ms', periods);
    await record('scrollingFps', frameRates);
    if (charts) {
      await test.info().attach('scrolling-comparison', {
        body: JSON.stringify({
          emptyPage: {
            p95Ms: summarize('frameP95Ms', framePeriods(emptyPageIntervals!)).value,
            samples: framePeriods(emptyPageIntervals!),
            rawIntervals: emptyPageIntervals,
          },
          sparklines: {
            p95Ms: summarize('frameP95Ms', periods).value,
            samples: periods,
            rawIntervals: intervals,
          },
        }),
        contentType: 'application/json',
      });
      expect(summarize('frameP95Ms', periods).value).toBeLessThanOrEqual(BUDGETS.frameP95Ms.limit);
      expect(Math.min(...frameRates)).toBeGreaterThanOrEqual(BUDGETS.scrollingFps.limit);
    }
  });

test('edits echo locally, are acknowledged, and arrive in a second browser', async ({ browser, page }) => {
  await owner(page);
  await page.goto(address);
  await expect(page.locator(CELL)).toHaveText('Record 1');
  const peerBrowser = await browser.browserType().launch({
    headless: true,
    args: ['--mute-audio', '--disable-speech-synthesis-api'],
  });
  try {
    const peerContext = await peerBrowser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState: await page.context().storageState(),
      serviceWorkers: 'block',
    });
    const peer = await peerContext.newPage();
    await visit(peer, address);
    await expect(peer.locator(CELL)).toHaveText('Record 1');
    await peer.waitForLoadState('networkidle');
    for (const target of [page, peer])
      await target.evaluate((selector) => {
        const epoch = () => performance.timeOrigin + performance.now();
        window.perfEdits = { started: 0, echo: [], ack: [], errors: [], peers: {}, phases: [] };
        performance.setResourceTimingBufferSize(2000);
        document.addEventListener(
          'keydown',
          (event) => {
            if (event.key === 'Enter' && (event.target as Element)?.matches('.rio-grid__input[data-editing]'))
              window.perfEdits.started = epoch();
          },
          true,
        );
        new MutationObserver(() => {
          const value = document.querySelector(selector)?.textContent ?? '';
          if (!value.startsWith('Edit ')) return;
          if (!(value in window.perfEdits.peers)) {
            window.perfEdits.peers[value] = epoch();
            if (window.perfEdits.started) window.perfEdits.echo.push(epoch() - window.perfEdits.started);
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
        const original = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const sentAt = epoch();
          const response = await original(...args);
          const headersAt = epoch();
          const url = String(args[0]);
          if (url.endsWith('/commands')) {
            const started = window.perfEdits.started;
            void response
              .clone()
              .json()
              .then((body: { results?: Array<{ status: string }> }) => {
                if (
                  !response.ok ||
                  !body.results?.length ||
                  body.results.some((result) => result.status !== 'applied')
                )
                  window.perfEdits.errors.push('Edit rejected');
                if (started) {
                  const bodyMs = epoch() - started;
                  window.perfEdits.ack.push(bodyMs);
                  const resource = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as
                    PerformanceResourceTiming | undefined;
                  window.perfEdits.phases.push({
                    sentMs: sentAt - started,
                    headersMs: headersAt - started,
                    bodyMs,
                    wireMs: resource?.responseEnd
                      ? performance.timeOrigin + resource.responseEnd - started
                      : null,
                  });
                }
              })
              .catch((error: unknown) => window.perfEdits.errors.push(String(error)));
          }
          return response;
        };
      }, CELL);
    const remote: number[] = [];
    // Each independent trial has thirty measured edits after its own warmup.
    const total = TIMING_SAMPLES * (SAMPLES + 1);
    for (let sample = 0; sample < total; sample++) {
      const value = `Edit ${sample}`;
      const latency = await measure(['localEchoMs', 'acknowledgmentP95Ms', 'peerP95Ms'], async () => {
        await page.locator(CELL).dblclick();
        await page.locator('.rio-grid__input').fill(value);
        await page.locator('.rio-grid__input').press('Enter');
        await page.waitForFunction((count) => window.perfEdits.ack.length === count, sample + 1);
        await peer.waitForFunction((value) => value in window.perfEdits.peers, value);
        return (
          (await peer.evaluate((value) => window.perfEdits.peers[value]!, value)) -
          (await page.evaluate(() => window.perfEdits.started))
        );
      });
      if (sample % (SAMPLES + 1) > 0) remote.push(latency);
    }
    const edits = await page.evaluate(() => window.perfEdits);
    expect(edits.errors).toEqual([]);
    expect(edits.echo).toHaveLength(total);
    expect(edits.ack).toHaveLength(total);
    const measured = (_value: number, index: number) => index % (SAMPLES + 1) > 0;
    await record('localEchoMs', edits.echo.filter(measured), SAMPLES);
    await record('acknowledgmentP95Ms', edits.ack.filter(measured));
    await record('peerP95Ms', remote);
    await test
      .info()
      .attach('editing-phases', { body: JSON.stringify(edits.phases), contentType: 'application/json' });
  } finally {
    await peerBrowser.close();
  }
});
