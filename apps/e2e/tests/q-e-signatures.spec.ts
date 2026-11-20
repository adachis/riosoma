import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { readPdf, type PdfPage } from '../files';
import {
  labelName,
  asOwner,
  createDatabase,
  openTable,
  OWNER,
  signIn,
  type SeededDatabase,
} from '../helpers';
import type { Mail } from '../mail';
import { mailTo, waitForMail } from '../people';
import { rows } from '../sql';

/**
 * Signature requests, as people use them.  The owner attaches a two-page lease to a record, opens
 * the request dialog from the record's menu, and places fields with the mouse in the real placer:
 * a text box, a signature, and a date for the first signer, and a signature on page 2 for the
 * second.  The placements are read back from where the server stored them.  The signers go one
 * after another, each opening the link from their email in a browser with no account, stepping
 * through their own fields, seeing the other signer's outlined box on the document, and drawing a
 * signature with the mouse.  The stamped PDF lands on the record and in everyone's email, and is
 * read back page by page.  Then one signer gets two requests: she declines the first, opens the
 * second in the same tab, and its link stops working once the owner cancels it.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const LEASE = 'harbor-lease.pdf';
const SIGNED = 'harbor-lease - signed.pdf';
const PAGE_TEXT = ['Harbor lease, page one', 'Harbor lease, page two'];
const CONSENT =
  'I agree to sign this document electronically.  I intend my electronic signature to have the same effect as my handwritten signature, and I consent to receive the signed document electronically.';
const UNAVAILABLE =
  'This signing request is unavailable.  It may have been signed, declined, canceled, or expired.';

interface Signer {
  name: string;
  email: string;
  /** Where the signer's browser is, which the date signed is stamped in */
  zone: string;
}

function signer(name: string, zone: string): Signer {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randomBytes(4).toString('hex')}@example.test`;
  return { name, email, zone };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A two-page, letter-size PDF with a line of text on each page, written out by hand. */
function twoPagePdf(): Buffer {
  const content = (line: string) => `BT /F1 18 Tf 72 720 Td (${line}) Tj ET`;
  const stream = (body: string) =>
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page(6),
    page(7),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    stream(content(PAGE_TEXT[0]!)),
    stream(content(PAGE_TEXT[1]!)),
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A table of leases with one record, and the fields the request sets when it's complete. */
async function leases(page: Page): Promise<SeededDatabase> {
  // The walk-through uses the card regardless of a layout saved by an earlier spec.
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
  return createDatabase(page, 'Harbor Leases', [
    {
      name: 'Leases',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Contract', type: 'attachment' },
        { name: 'Status', type: 'singleSelect', choices: ['Out for signature', 'Signed'] },
        { name: 'Signed on', type: 'date' },
      ],
      records: [{ Name: 'Slip 14', Status: 'Out for signature' }],
    },
  ]);
}

/** Opens the record's card, trying again when the first press lands before the grid takes input. */
async function openCard(page: Page, grid: Locator): Promise<Locator> {
  const card = page.getByRole('dialog', { name: 'Slip 14' });
  await expect(async () => {
    if (!(await card.isVisible())) await grid.getByRole('button', { name: 'Expand row 1' }).click();
    await expect(card.getByRole('group', { name: 'Contract' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return card;
}

/** Attaches the lease to the record from its card, and returns the attachment's ID. */
async function attachLease(page: Page, database: SeededDatabase, card: Locator, bytes: Buffer) {
  await card
    .locator('input[type="file"]')
    .setInputFiles({ name: LEASE, mimeType: 'application/pdf', buffer: bytes });
  await expect(card.getByRole('button', { name: labelName(LEASE) })).toBeVisible();
  const table = database.tables.Leases!;
  let ids: string[] = [];
  await expect
    .poll(async () => {
      const record = await asOwner<{ values: Record<string, unknown> }>(
        page,
        'GET',
        `/api/tables/${table.id}/records/${table.records[0]}`,
      );
      ids = (record.values[table.fields.Contract!] as string[] | null) ?? [];
      return ids.length;
    })
    .toBe(1);
  return ids[0]!;
}

interface Placement {
  signer: number;
  kind: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The fields a request was stored with, read from the server's own table. */
async function storedFields(recordId: string): Promise<Placement[]> {
  const [schema] = await rows<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'signature_requests'`,
  );
  const stored = await rows<{ input: { fields: Placement[] } }>(
    `SELECT input FROM "${schema!.table_schema}".signature_requests WHERE record_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [recordId],
  );
  return stored[0]!.input.fields;
}

/**
 * Clicks the placer's page at a point, given as a fraction of its width and height, with the mouse.
 * The page is taller than the window, so its top is scrolled into view first, and the point is
 * worked out from where the page then sits.
 */
async function placeAt(page: Page, dialog: Locator, x: number, y: number): Promise<void> {
  const preview = dialog.getByTitle('Document preview');
  await preview.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const box = (await preview.boundingBox())!;
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

/** Draws a signature on the pad with the mouse, in one zigzag stroke, as a hand might. */
async function drawSignature(page: Page, pad: Locator): Promise<void> {
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
  await page.mouse.move(...at(0.1, 0.6));
  await page.mouse.down();
  for (const [x, y] of [
    [0.2, 0.25],
    [0.3, 0.7],
    [0.38, 0.35],
    [0.5, 0.65],
    [0.62, 0.3],
    [0.75, 0.6],
    [0.9, 0.45],
  ] as const)
    await page.mouse.move(...at(x, y), { steps: 6 });
  await page.mouse.up();
}

/** How many pixels of a picture on the page have any ink in them. */
async function inked(image: Locator): Promise<number> {
  return image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count += 1;
    return count;
  });
}

const invitation = (person: Signer) => (message: Mail) =>
  message.to.includes(person.email) && message.subject === `Please sign ${LEASE}`;

/** The signing link in an invitation. */
function linkIn(mail: Mail): string {
  const link = new RegExp(`${base().replace(/[.]/g, '\\.')}/signatures#[\\w.-]+`).exec(mail.text)?.[0];
  expect(link, 'the invitation has a signing link').toBeTruthy();
  return link!;
}

/** The signing link in the first invitation to this address. */
async function signingLink(person: Signer): Promise<string> {
  return linkIn(await waitForMail(invitation(person), `the invitation to ${person.name}`));
}

/** The signing links in every invitation to this address, once this many have arrived. */
async function signingLinks(person: Signer, count: number): Promise<string[]> {
  await expect
    .poll(() => mailTo(person.email).filter(invitation(person)).length, {
      message: `${count} invitations to ${person.name}`,
    })
    .toBe(count);
  return mailTo(person.email).filter(invitation(person)).map(linkIn);
}

/** What a spent, declined, or canceled link shows: that it's unavailable, and nothing of the request. */
async function expectUnavailable(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Signing request', level: 1 })).toBeVisible();
  await expect(page.getByText(UNAVAILABLE)).toBeVisible();
  await expect(page.getByTitle('Document to sign')).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(0);
}

interface Visit {
  context: BrowserContext;
  page: Page;
  /** Everything the signer's browser received, once it has all arrived */
  received(): Promise<string>;
}

/**
 * Everything a signer's browser receives but the document in the page's frame, which the test reads
 * for itself: WebKit hands a framed PDF to its own viewer and never gives its body back.
 */
function receivedByPage(page: Page): () => Promise<string> {
  const received: Array<Promise<string>> = [];
  page.on('response', (response) => {
    if (response.headers()['content-type']?.startsWith('application/pdf')) return;
    received.push(
      response.body().then(
        (body) => body.toString('utf8'),
        // A redirect has no body of its own.
        () => '',
      ),
    );
  });
  return async () => (await Promise.all(received)).join('\n');
}

/** A signer opens the link from their email in a browser of their own, with no account. */
async function openLink(browser: Browser, person: Signer, link: string): Promise<Visit> {
  const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: person.zone });
  const page = await context.newPage();
  const received = receivedByPage(page);
  // Firefox under test saves a PDF in a frame as a download instead of showing it, and a download
  // that starts before the browser reports the page's own navigation fails the visit, though the
  // page loads all the same.  On a busy machine that report can come after the page has drawn its
  // frame, even for a visit that waits for nothing past it.  So in Firefox that one failure is let
  // through, and the checks after it wait for the page itself.
  await page.goto(link, { waitUntil: 'domcontentloaded' }).catch((error: unknown) => {
    if (browser.browserType().name() !== 'firefox' || !String(error).includes('Download is starting'))
      throw error;
  });
  await expect(page).toHaveURL(link);
  return { context, page, received };
}

/** The document as the signing page shows it, read from the frame's own address. */
async function shownDocument(visit: Visit): Promise<PdfPage[]> {
  const frame = visit.page.getByTitle('Document to sign');
  await expect(frame).toBeVisible();
  const source = await frame.getAttribute('src');
  const response = await visit.page.request.get(new URL(source!, base()).href);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('application/pdf');
  return readPdf(await response.body());
}

/** Ticks the agreement to sign electronically, whose wording is the checkbox's label. */
async function agree(page: Page): Promise<void> {
  // The box sits beside the wording, on its first line, as every checkbox's does.
  const control = page.locator('.rio-checkbox__control').filter({ hasText: /^I agree/ });
  const box = (await control.locator('.rio-checkbox__box').boundingBox())!;
  const words = (await control.locator('.rio-checkbox__label').boundingBox())!;
  expect(words.x, 'the wording starts after the box').toBeGreaterThanOrEqual(box.x + box.width);
  expect(words.y, 'the wording starts on the box’s line').toBeLessThan(box.y + box.height);
  await page.getByText(/^I agree to sign this document electronically\./).click();
  await expect(
    page.getByRole('checkbox', { name: /^I agree to sign this document electronically\./ }),
  ).toBeChecked();
}

/** Draws on the pad for the field on screen, signs with it, and checks the preview has ink. */
async function signField(page: Page, kind: string): Promise<void> {
  const fields = page.getByRole('region', { name: 'Your signing fields' });
  await expect(fields.getByRole('heading', { name: kind, level: 3 })).toBeVisible();
  // The name field's shell draws its border, so the input inside it has none of its own.
  const typed = fields.getByRole('textbox', { name: 'Your name' });
  expect(await typed.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  await drawSignature(page, fields.getByRole('img', { name: new RegExp(`^Signature pad for ${kind}\\.`) }));
  await fields.getByRole('button', { name: 'Sign', exact: true }).click();
  const preview = fields.getByRole('img', { name: 'Your signature preview' });
  await expect(preview).toBeVisible();
  expect(await inked(preview), 'the drawn signature has ink in it').toBeGreaterThan(200);
}

/** The date a moment falls on in a zone, with the zone's short name, as the stamp writes it. */
function dateIn(instant: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('timeZoneName')}`;
}

/** The record's signature requests, as the requester's card lists them. */
interface Summary {
  id: string;
  status: string;
  originalHash: string;
  finalHash: string | null;
  signedAttachmentId: string | null;
  signers: Array<{
    name: string;
    email: string;
    status: string;
    signedAt: string | null;
    reason: string | null;
  }>;
  history: Array<{ action: string }>;
}

async function requests(page: Page, database: SeededDatabase): Promise<Summary[]> {
  const table = database.tables.Leases!;
  return (
    await asOwner<{ requests: Summary[] }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}/signature-requests`,
    )
  ).requests;
}

test('two signers sign a placed lease one after another, and the stamped PDF lands on the record', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const wren = signer('Wren Castillo', 'America/Denver');
  const bea = signer('Bea Ortiz', 'Europe/Lisbon');
  await signIn(page);
  const database = await leases(page);
  const table = database.tables.Leases!;
  const grid = await openTable(page, database, 'Leases');
  const lease = twoPagePdf();
  const card = await openCard(page, grid);
  await attachLease(page, database, card, lease);

  // The owner opens the request from the record's menu.
  await card.getByRole('button', { name: 'More for this record' }).click();
  await page.getByRole('menuitem', { name: 'Request signatures' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request signatures' });
  await expect(dialog.getByLabel('PDF attachment')).toHaveValue(/^att/);
  const first = dialog.getByRole('group', { name: 'Signer 1' });
  await first.getByLabel('Full name').fill(wren.name);
  await first.getByLabel('Email address').fill(wren.email);
  await dialog.getByRole('button', { name: 'Add signer' }).click();
  const second = dialog.getByRole('group', { name: 'Signer 2' });
  await second.getByLabel('Full name').fill(bea.name);
  await second.getByLabel('Email address').fill(bea.email);
  await dialog.getByLabel('Signing order').selectOption({ label: 'One after another, in the order above' });
  await dialog.getByLabel('Message for signers').fill('Here is the lease for slip 14.  Sign where marked.');
  await dialog.getByLabel('Set a status field when completed').selectOption({ label: 'Status' });
  await dialog.getByLabel('Completed status').selectOption({ label: 'Signed' });
  await dialog.getByLabel('Set a completion date field').selectOption({ label: 'Signed on' });

  // Every control and the page itself sit inside the dialog's panel, however wide the window.
  await expect(dialog.getByRole('heading', { name: 'Place signing fields' })).toBeVisible();
  await expect(dialog.getByTitle('Document preview')).toBeVisible();
  const overflow = await dialog.evaluate((element) => {
    const panel = element.closest('.rio-modal')!.getBoundingClientRect();
    return [...element.querySelectorAll('input, select, textarea, iframe, button')]
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.width > 0 && (box.left < panel.left - 0.5 || box.right > panel.right + 0.5);
      })
      .map(
        (control) =>
          control.getAttribute('title') ?? control.closest('label')?.textContent ?? control.tagName,
      );
  });
  expect(overflow, 'controls outside the dialog').toEqual([]);

  // Each field lands with its top left corner where the page is clicked.
  const clicks: Array<Omit<Placement, 'width' | 'height'> & { label: string }> = [
    { signer: 0, kind: 'text', label: 'Text box', page: 0, x: 0.1, y: 0.12 },
    { signer: 0, kind: 'signature', label: 'Signature', page: 0, x: 0.1, y: 0.25 },
    { signer: 0, kind: 'date', label: 'Date signed', page: 0, x: 0.55, y: 0.25 },
    { signer: 1, kind: 'signature', label: 'Signature', page: 1, x: 0.4, y: 0.3 },
  ];
  for (const click of clicks) {
    await dialog
      .getByRole('combobox', { name: 'Page', exact: true })
      .selectOption({ label: String(click.page + 1) });
    await dialog.getByLabel('Assigned signer').selectOption({ label: [wren, bea][click.signer]!.name });
    await dialog.getByLabel('Field type').selectOption({ label: click.label });
    await placeAt(page, dialog, click.x, click.y);
    await expect(
      dialog.getByRole('button', {
        name: `${click.label} ${[wren, bea][click.signer]!.name}`,
        pressed: true,
      }),
    ).toBeVisible();
  }
  // Page 1 lists its three fields, and page 2 its one.
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Page', exact: true }).selectOption({ label: '1' });
  await expect(dialog.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Send signature request' }).click();
  await expect(dialog).toBeHidden();

  const stored = await storedFields(table.records[0]!);
  expect(stored).toHaveLength(clicks.length);
  for (const [index, click] of clicks.entries()) {
    const field = stored[index]!;
    expect({ signer: field.signer, kind: field.kind, page: field.page }).toEqual({
      signer: click.signer,
      kind: click.kind,
      page: click.page,
    });
    // Within half a percent of the page, a few pixels either way.
    expect(field.x).toBeCloseTo(click.x, 2);
    expect(field.y).toBeCloseTo(click.y, 2);
    expect({ width: field.width, height: field.height }).toEqual({ width: 0.28, height: 0.07 });
  }

  // One after another: only Wren is invited at first.
  const wrenLink = await signingLink(wren);
  expect(mailTo(bea.email)).toHaveLength(0);
  const wrenVisit = await openLink(browser, wren, wrenLink);
  const wrenPage = wrenVisit.page;
  await expect(wrenPage.getByRole('heading', { name: `Sign ${LEASE}`, level: 1 })).toBeVisible();
  await expect(wrenPage.getByText('Here is the lease for slip 14.  Sign where marked.')).toBeVisible();
  await expect(wrenPage.getByRole('listitem')).toHaveText([`${wren.name}—Pending`, `${bea.name}—Pending`]);
  await expect(
    wrenPage.getByText(/^Outlined fields marked “For” another name belong to the other signers\./),
  ).toBeVisible();
  // The document shows Wren's fields numbered, and Bea's box on page 2 outlined with her name.
  const wrenDocument = await shownDocument(wrenVisit);
  expect(wrenDocument).toHaveLength(2);
  expect(wrenDocument[0]!.text).toEqual(expect.arrayContaining([PAGE_TEXT[0], '1', '2', '3']));
  expect(wrenDocument[0]!.text.join('\n')).not.toContain('For ');
  expect(wrenDocument[1]!.text).toEqual(expect.arrayContaining([PAGE_TEXT[1], `For ${bea.name}`]));
  expect(wrenDocument.flatMap((each) => each.text).join('\n')).not.toContain(bea.email);

  // Wren goes through her fields in order down the page: the text box, the signature, the date.
  const fields = wrenPage.getByRole('region', { name: 'Your signing fields' });
  await expect(fields.getByRole('heading', { name: 'Field 1 of 3 on page 1', level: 2 })).toBeVisible();
  await expect(fields.getByRole('heading', { name: 'Text box', level: 3 })).toBeVisible();
  const next = fields.getByRole('button', { name: 'Next field' });
  await expect(next).toBeDisabled();
  await fields.getByLabel('Text box').fill('Slip 14, north dock');
  await next.click();
  await expect(fields.getByRole('heading', { name: 'Field 2 of 3 on page 1', level: 2 })).toBeVisible();
  await signField(wrenPage, 'Signature');
  await next.click();
  await expect(fields.getByRole('heading', { name: 'Field 3 of 3 on page 1', level: 2 })).toBeVisible();
  await expect(fields.getByRole('heading', { name: 'Date signed', level: 3 })).toBeVisible();
  await expect(
    fields.getByText('The date you finish signing is recorded, in your own time zone.'),
  ).toBeVisible();
  const finish = wrenPage.getByRole('button', { name: 'Agree and finish signing' });
  await expect(finish).toBeDisabled();
  await agree(wrenPage);
  await finish.click();
  await expect(wrenPage.getByRole('status')).toHaveText(
    'Your signature has been recorded.  You will receive the signed PDF after everyone signs and the file passes its scan.',
  );

  // Then Bea is invited, and sees that Wren has signed.
  const beaVisit = await openLink(browser, bea, await signingLink(bea));
  const beaPage = beaVisit.page;
  await expect(beaPage.getByRole('heading', { name: `Sign ${LEASE}`, level: 1 })).toBeVisible();
  await expect(beaPage.getByRole('listitem')).toHaveText([`${wren.name}—Signed`, `${bea.name}—Pending`]);
  const beaDocument = await shownDocument(beaVisit);
  expect(beaDocument[0]!.text.filter((line) => line === `For ${wren.name}`)).toHaveLength(3);
  expect(beaDocument[1]!.text).toEqual(expect.arrayContaining([PAGE_TEXT[1], '1']));
  expect(beaDocument.flatMap((each) => each.text).join('\n')).not.toContain(wren.email);
  // Her one field is on page 2, and it's the last, so there's nothing after it.
  const beaFields = beaPage.getByRole('region', { name: 'Your signing fields' });
  await expect(beaFields.getByRole('heading', { name: 'Field 1 of 1 on page 2', level: 2 })).toBeVisible();
  await signField(beaPage, 'Signature');
  await expect(beaFields.getByRole('button', { name: 'Next field' })).toBeDisabled();
  await agree(beaPage);
  await beaPage.getByRole('button', { name: 'Agree and finish signing' }).click();
  await expect(beaPage.getByRole('status')).toContainText('Your signature has been recorded.');

  // Neither signer's browser ever received the other's address, in the page or in the document.
  expect(await wrenVisit.received()).not.toContain(bea.email);
  expect(await beaVisit.received()).not.toContain(wren.email);

  // Everyone gets the signed PDF by email, the owner included, with its hash in the message.
  const completed = await Promise.all(
    [wren.email, bea.email, OWNER.email].map((address) =>
      waitForMail(
        (message) => message.to.includes(address) && message.subject === `Signed document: ${LEASE}`,
        `the signed PDF for ${address}`,
      ),
    ),
  );
  const emailed = completed[0]!.attachments.find((file) => file.filename === SIGNED);
  expect(emailed, 'the email carries the signed PDF').toBeTruthy();
  expect(emailed!.contentType).toBe('application/pdf');
  for (const mail of completed) {
    expect(mail.attachments.map((file) => file.filename)).toEqual([SIGNED]);
    expect(mail.text).toContain(`The signed PDF’s SHA-256 is ${sha256(emailed!.content)}.`);
  }

  // The signed PDF lands on the record beside the original, and the status and date are set.
  await expect(card.getByRole('button', { name: labelName(SIGNED) })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button', { name: labelName(LEASE) })).toBeVisible();
  const [summary] = await requests(page, database);
  expect(summary!.status).toBe('completed');
  expect(summary!.originalHash).toBe(sha256(lease));
  expect(summary!.finalHash).toBe(sha256(emailed!.content));
  const record = await asOwner<{ values: Record<string, unknown> }>(
    page,
    'GET',
    `/api/tables/${table.id}/records/${table.records[0]}`,
  );
  expect(record.values[table.fields.Status!]).toBe(database.tables.Leases!.choices.Status!.Signed);
  expect(record.values[table.fields.Contract!]).toEqual([expect.any(String), summary!.signedAttachmentId]);
  // The date field has no time, so it holds the day Bea signed where she is, as her date signed reads.
  const latest = summary!.signers
    .map((person) => person.signedAt!)
    .sort()
    .at(-1)!;
  expect(record.values[table.fields['Signed on']!]).toBe(dateIn(latest, bea.zone).slice(0, 10));
  await expect(card.getByRole('combobox', { name: 'Status' })).toHaveValue('Signed');
  const [file] = await asOwner<Array<{ name: string; url: string }>>(
    page,
    'GET',
    `/api/files?ids=${summary!.signedAttachmentId}`,
  );
  expect(file!.name).toBe(SIGNED);
  const download = await page.request.get(`${base()}${file!.url}`);
  expect(download.ok()).toBe(true);
  const signed = await download.body();
  expect(sha256(signed)).toBe(summary!.finalHash);

  // The original two pages, stamped, and a certificate page after them.
  const pages = readPdf(signed);
  expect(pages).toHaveLength(3);
  for (const each of pages)
    expect({ width: each.width, height: each.height }).toEqual({ width: 612, height: 792 });
  const wrenSigned = summary!.signers.find((person) => person.name === wren.name)!;
  const beaSigned = summary!.signers.find((person) => person.name === bea.name)!;
  expect(pages[0]!.text).toEqual(
    expect.arrayContaining([PAGE_TEXT[0], 'Slip 14, north dock', dateIn(wrenSigned.signedAt!, wren.zone)]),
  );
  expect(pages[0]!.images).toBe(1);
  expect(pages[1]!.text).toEqual([PAGE_TEXT[1]]);
  expect(pages[1]!.images).toBe(1);
  // Nothing from the signing page's preview, such as a field's number or another's label, remains.
  expect(pages[0]!.text).not.toContain('1');
  expect(pages.flatMap((each) => each.text).join('\n')).not.toContain('For ');
  const certificate = pages[2]!.text.join(' ');
  expect(pages[2]!.text[0]).toBe('Electronic signature certificate');
  expect(certificate).toContain(
    'Simple electronic signatures with an audit trail, not qualified or certificate-based signatures.',
  );
  expect(certificate).toContain(`Original document SHA-256 ${sha256(lease)}`);
  const consent = CONSENT.replace(/\s+/g, ' ');
  for (const [person, visit, stamped] of [
    [wren, wrenVisit, wrenSigned],
    [bea, beaVisit, beaSigned],
  ] as const) {
    const agent = (await visit.page.evaluate(() => navigator.userAgent)).replace(/\s+/g, ' ').slice(0, 200);
    for (const row of [
      `Signer ${person.name}`,
      `Email ${person.email}`,
      `Signed at ${stamped.signedAt!.slice(0, 10)} ${stamped.signedAt!.slice(11, 19)} UTC`,
      `Signer’s time zone ${person.zone}`,
      'IP address 127.0.0.1',
      `User agent ${agent}`,
      `Electronic consent ${consent}`,
    ])
      expect(certificate).toContain(row);
  }

  // The card's signature history shows the request complete, with each step and both hashes.
  await card.getByRole('tab', { name: 'Signatures' }).click();
  const history = card.getByRole('article').filter({ hasText: LEASE });
  await expect(history.getByText('Completed', { exact: true })).toBeVisible();
  await history.getByText('Request history and document hashes').click();
  await expect(history.getByText(`Original SHA-256: ${sha256(lease)}`)).toBeVisible();
  await expect(history.getByText(`Complete signed PDF SHA-256: ${summary!.finalHash}`)).toBeVisible();
  const steps = history.getByRole('listitem').filter({ has: page.locator('time') });
  await expect(steps).toHaveText([
    new RegExp(`^Sent ${wren.name}`),
    new RegExp(`^Opened ${wren.name}`),
    new RegExp(`^Signed ${wren.name}`),
    new RegExp(`^Sent ${bea.name}`),
    new RegExp(`^Opened ${bea.name}`),
    new RegExp(`^Signed ${bea.name}`),
    /^Completed/,
  ]);

  // A used link is spent.
  await wrenPage.reload();
  await expectUnavailable(wrenPage);
  await wrenVisit.context.close();
  await beaVisit.context.close();
});

test('a signer declines one request, opens another in the same tab, and its link stops working once canceled', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const juno = signer('Juno Park', 'America/Chicago');
  await signIn(page);
  const database = await leases(page);
  const table = database.tables.Leases!;
  const grid = await openTable(page, database, 'Leases');
  const card = await openCard(page, grid);
  const attachmentId = await attachLease(page, database, card, twoPagePdf());
  // Two requests for the same lease, both to Juno, sent through the API: the placer has its own
  // walk-through above.
  const sent: Record<string, string> = {};
  for (const message of ['Please sign the lease for slip 14.', 'Please sign the renewal for slip 14.']) {
    const { id } = await asOwner<{ id: string }>(
      page,
      'POST',
      `/api/tables/${table.id}/records/${table.records[0]}/signature-requests`,
      {
        attachmentId,
        signers: [{ name: juno.name, email: juno.email }],
        order: 'parallel',
        fields: [
          { id: 'sign', signer: 0, kind: 'signature', page: 1, x: 0.1, y: 0.5, width: 0.3, height: 0.08 },
        ],
        message,
        dueAt: null,
      },
    );
    sent[message] = id;
  }
  const links = await signingLinks(juno, 2);
  const linkFor = (message: string) => links.find((link) => link.includes(`#${sent[message]}.`))!;

  // Juno declines the first, and says why.
  const visit = await openLink(browser, juno, linkFor('Please sign the lease for slip 14.'));
  const junoPage = visit.page;
  await expect(junoPage.getByRole('heading', { name: `Sign ${LEASE}`, level: 1 })).toBeVisible();
  await expect(junoPage.getByText('Please sign the lease for slip 14.')).toBeVisible();
  await junoPage.getByRole('button', { name: 'Decline to sign' }).click();
  const confirm = junoPage.getByRole('button', { name: 'Confirm decline' });
  await expect(confirm).toBeDisabled();
  await junoPage.getByLabel('Reason for declining').fill('The slip number is wrong.');
  await confirm.click();
  await expect(junoPage.getByRole('status')).toHaveText('You declined this request.');

  // She opens the second link in the same tab.  Only what follows the # differs, so the browser
  // doesn't load the page again, and the page follows the new link on its own.
  await junoPage.goto(linkFor('Please sign the renewal for slip 14.'));
  await expect(junoPage.getByText('Please sign the renewal for slip 14.')).toBeVisible();
  await expect(junoPage.getByRole('status')).toHaveCount(0);
  await expect(junoPage.getByRole('button', { name: 'Agree and finish signing' })).toBeDisabled();

  // The owner sees the decline and its reason in the card, and cancels the renewal.
  await card.getByRole('tab', { name: 'Signatures' }).click();
  const articles = card.getByRole('article');
  await expect(articles).toHaveCount(2);
  // The newest request comes first.
  const [renewalCard, leaseCard] = [articles.nth(0), articles.nth(1)];
  // The request reads declined, and so does Juno.
  await expect(leaseCard.getByText('Declined', { exact: true })).toHaveCount(2);
  await expect(
    leaseCard.getByRole('listitem').filter({ hasText: juno.email }).getByText('The slip number is wrong.'),
  ).toBeVisible();
  await expect(leaseCard.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
  await expect(renewalCard.getByText('Awaiting signatures', { exact: true })).toBeVisible();
  await renewalCard.getByRole('button', { name: 'Cancel request' }).click();
  await expect(renewalCard.getByText('Cancel this request and void every signing link?')).toBeVisible();
  await renewalCard.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(renewalCard.getByText('Canceled', { exact: true })).toBeVisible();
  await expect(renewalCard.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);

  // Now both of her links show only that the request is unavailable.
  await junoPage.reload();
  await expectUnavailable(junoPage);
  await junoPage.goto(linkFor('Please sign the lease for slip 14.'));
  await expectUnavailable(junoPage);

  // Both steps are in the history the server keeps.
  const [renewalRequest, leaseRequest] = await requests(page, database);
  expect(renewalRequest!.id).toBe(sent['Please sign the renewal for slip 14.']);
  expect(renewalRequest!.status).toBe('canceled');
  expect(renewalRequest!.history.map((step) => step.action)).toEqual(['sent', 'opened', 'canceled']);
  expect(leaseRequest!.status).toBe('declined');
  expect(leaseRequest!.signers[0]!.reason).toBe('The slip number is wrong.');
  expect(leaseRequest!.history.map((step) => step.action)).toEqual(['sent', 'opened', 'declined']);
  await visit.context.close();
});
