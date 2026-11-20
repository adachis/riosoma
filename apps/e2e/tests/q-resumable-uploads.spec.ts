import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Request } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, signIn, type SeededDatabase } from '../helpers';

/**
 * Large uploads that survive interruptions.  A file over 8 MB goes up in 4 MB pieces, and the
 * browser remembers it, so when the network drops halfway it carries on from where the server
 * stopped once the network is back, and when the page is reloaded halfway, the record card comes
 * back, asks the server how far it got, and sends only the rest.  The server's copy is read back
 * and matched against the file that was chosen, byte for byte.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const MB = 1024 * 1024;
const SIZE = 20 * MB;
/** Where an upload is cut short: after its first two pieces, 40 percent of the way */
const CUT = 8 * MB;

/** An upload's own address, which each of its pieces is sent to */
const UPLOAD = /\/api\/uploads\/att[0-9A-Za-z]{14}$/;

interface Sent {
  request: Request;
  method: string;
  /** Where a piece starts, in megabytes */
  offset: number | null;
  /** What the test was doing to the network when the request went out */
  phase: string;
  answered: boolean;
  /** It never got an answer, since Chromium reports some answered requests as failed too */
  failed: boolean;
}

/** Every request an upload makes, in the order the browser sends it, and whether it failed. */
function watchUploads(page: Page, phase: () => string): Sent[] {
  const sent: Sent[] = [];
  page.on('request', (request) => {
    if (!UPLOAD.test(request.url())) return;
    const header = request.headers()['upload-offset'];
    sent.push({
      request,
      method: request.method(),
      offset: header === undefined ? null : Number(header) / MB,
      phase: phase(),
      answered: false,
      failed: false,
    });
  });
  page.on('response', (response) => {
    const entry = sent.find((item) => item.request === response.request());
    if (entry) entry.answered = true;
  });
  page.on('requestfailed', (request) => {
    const entry = sent.find((item) => item.request === request);
    if (entry && !entry.answered) entry.failed = true;
  });
  return sent;
}

/** Where each of the upload's pieces started, for the pieces that failed or the ones that didn't. */
function pieces(sent: readonly Sent[], failed: boolean): Array<number | null> {
  return sent
    .filter((entry) => entry.method === 'PATCH' && entry.failed === failed)
    .map((entry) => entry.offset);
}

/** A table of surveys with a record to attach a file to. */
async function surveys(page: Page): Promise<SeededDatabase> {
  // The upload controls are exercised in the card, independent of the saved layout.
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  return createDatabase(page, 'Reef Watch', [
    {
      name: 'Surveys',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'North reef' }],
    },
  ]);
}

/** Opens the record's card and chooses a file for its attachments. */
async function attach(page: Page, grid: Locator, name: string, bytes: Buffer): Promise<Locator> {
  const card = await openCard(page, grid);
  await card
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  return card;
}

async function openCard(page: Page, grid: Locator): Promise<Locator> {
  const card = page.getByRole('dialog', { name: 'North reef' });
  // On a busy machine the first click can land before the grid takes input, so try again until the
  // card opens.
  await expect(async () => {
    if (!(await card.isVisible())) await grid.getByRole('button', { name: 'Expand row 1' }).click();
    await expect(card.getByRole('group', { name: 'Files' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return card;
}

/** Reads the finished file back from the server and checks it's the one that was chosen. */
async function matchesServer(
  page: Page,
  database: SeededDatabase,
  name: string,
  bytes: Buffer,
): Promise<void> {
  const table = database.tables.Surveys!;
  // The card shows the file as soon as it's attached, a moment before the server has saved that.
  let ids: string[] = [];
  await expect
    .poll(async () => {
      const record = await asOwner<{ values: Record<string, unknown> }>(
        page,
        'GET',
        `/api/tables/${table.id}/records/${table.records[0]}`,
      );
      ids = (record.values[table.fields.Files!] as string[] | null) ?? [];
      return ids.length;
    })
    .toBe(1);
  const [file] = await asOwner<Array<{ name: string; size: number; url: string }>>(
    page,
    'GET',
    `/api/files?ids=${ids[0]}`,
  );
  expect(file!.name).toBe(name);
  expect(file!.size).toBe(bytes.length);
  const download = await page.request.get(`${base()}${file!.url}`);
  expect(download.ok()).toBe(true);
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  expect(digest(await download.body())).toBe(digest(bytes));
}

test('a large upload carries on from where it stopped when the network comes back', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await surveys(page);
  const grid = await openTable(page, database, 'Surveys');
  const bytes = randomBytes(SIZE);
  let phase = 'online';
  const sent = watchUploads(page, () => phase);
  // The network drops as the third piece goes out, and stays down until the test brings it back.
  await page.route(UPLOAD, async (route) => {
    const request = route.request();
    if (request.method() !== 'PATCH' || Number(request.headers()['upload-offset']) < CUT)
      return route.continue();
    phase = 'offline';
    await page.context().setOffline(true);
    await route.abort('internetdisconnected');
    await page.unroute(UPLOAD);
  });

  const card = await attach(page, grid, 'north-reef-survey.bin', bytes);
  const progress = card.getByRole('progressbar', { name: 'Uploading north-reef-survey.bin' });
  await expect(progress).toHaveAttribute('aria-valuenow', '40');
  // It tries again while the network is down, and keeps what it has.
  await expect
    .poll(() => sent.some((entry) => entry.phase === 'offline' && entry.method === 'HEAD' && entry.failed))
    .toBe(true);
  await expect(progress).toHaveAttribute('aria-valuenow', '40');
  await expect(card.getByRole('alert')).toHaveCount(0);

  phase = 'back';
  await page.context().setOffline(false);
  await expect(card.getByRole('button', { name: /^north-reef-survey\.bin(?: |$)/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(progress).toBeHidden();
  // The piece the network dropped went again from the same place, and every piece arrived once.
  expect(pieces(sent, true)).toEqual([8]);
  expect(pieces(sent, false)).toEqual([0, 4, 8, 12, 16]);
  await matchesServer(page, database, 'north-reef-survey.bin', bytes);
});

test('reloading halfway through a large upload resumes it from where the server says it stopped', async ({
  playwright,
  browserName,
  accessibilityChecks,
}) => {
  test.setTimeout(120_000);
  // The browser keeps the file it's uploading, which a private window can't: WebKit's test windows
  // are private ones, so this runs in a browser with a profile of its own, as a person's is.
  const profile = mkdtempSync(join(tmpdir(), 'rio-e2e-profile-'));
  const context = await playwright[browserName].launchPersistentContext(profile, { serviceWorkers: 'block' });
  accessibilityChecks(context);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await signIn(page);
    const database = await surveys(page);
    let grid = await openTable(page, database, 'Surveys');
    const bytes = randomBytes(SIZE);
    let phase = 'first';
    const sent = watchUploads(page, () => phase);
    // The phase each request was handled under, recorded right where the handler decides to pass
    // or abort it, so the record of a request can never disagree with what happened to it.
    const acted = new Map<Request, string>();
    let halfway: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      halfway = resolve;
    });
    // The third piece never arrives, and nothing else does either until the page has reloaded.
    // The route stays installed for the whole test and passes requests again once the phase is
    // 'reloaded', so no request can slip through unrecorded.
    await page.route(UPLOAD, async (route) => {
      const request = route.request();
      if (
        phase === 'first' &&
        request.method() === 'PATCH' &&
        Number(request.headers()['upload-offset']) >= CUT
      ) {
        phase = 'held';
        halfway();
      }
      acted.set(request, phase);
      if (phase === 'held') return route.abort('aborted');
      return route.continue();
    });
    const created: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/records\/rec\w+\/uploads$/.test(request.url()))
        created.push(request.url());
    });

    let card = await attach(page, grid, 'north-reef-photos.bin', bytes);
    await stopped;
    await expect(card.getByRole('progressbar', { name: 'Uploading north-reef-photos.bin' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );

    // The open record card comes back with the reload, since the address carries the record, and
    // the panel starts the resume as soon as it mounts.  Watch for the HEAD's answer before the
    // reload so an early response can't be missed.  Every HEAD sent while held is aborted, so only
    // an answered HEAD from the resumed upload can resolve this.
    const checked = page.waitForResponse(
      (response) => UPLOAD.test(response.url()) && response.request().method() === 'HEAD',
    );
    await page.reload();
    phase = 'reloaded';
    grid = page.getByRole('grid', { name: 'Grid' });
    await expect(grid).toBeVisible();
    card = await openCard(page, grid);
    // The card comes back with the upload the browser kept, and the resume asks the server how
    // far it got.
    const answer = await checked;
    expect(answer.status()).toBe(200);
    expect(answer.headers()['upload-offset']).toBe(String(CUT));
    await expect(card.getByRole('button', { name: /^north-reef-photos\.bin(?: |$)/ })).toBeVisible({
      timeout: 30_000,
    });
    // It sent the rest from there, as the same upload.  These are the requests the handler let
    // through under 'reloaded', in the order they were sent.
    const resumed = sent.filter((entry) => acted.get(entry.request) === 'reloaded');
    expect(resumed[0]?.method).toBe('HEAD');
    expect(pieces(resumed, false)).toEqual([8, 12, 16]);
    expect(pieces(resumed, true)).toEqual([]);
    expect(created).toHaveLength(1);
    await matchesServer(page, database, 'north-reef-photos.bin', bytes);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
