import { createServer, type Server } from 'node:https';
import { expect, test } from '../accessibility';
import { standIn } from '../base';
import { createDatabase, flip, openTable, runCommands, signIn, newId } from '../helpers';

/**
 * A Slack step in an automation.  The owner builds an automation in the editor that posts to a
 * Slack incoming webhook when a record is created, with a record's name in the message.  The test
 * stands in for Slack: the test server resolves Slack's webhook host to this machine and trusts the
 * stand-in's certificate (see `outside-hosts.ts`), so the step runs as it would against Slack.  The
 * stand-in gets the message, with the record's values escaped the way Slack reads them, and the
 * webhook address is kept as a secret the editor never shows again.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** An incoming webhook address, as Slack gives one out */
const WEBHOOK = 'https://hooks.slack.com/services/T0E2E0000/B0E2E0000/standin0webhook0secret';

interface Posted {
  path: string;
  contentType: string;
  body: string;
}

let posted: Posted[] = [];
let server: Server;

test.beforeAll(async () => {
  const { port, certificate, privateKey } = standIn();
  server = createServer({ key: privateKey, cert: certificate }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      posted.push({
        path: request.url ?? '',
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      // Slack answers a message it took with a plain "ok".
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
});

test.afterAll(async () => {
  await new Promise((done) => server.close(done));
});

test('a Slack step posts the record’s name to the webhook when a record is created', async ({ page }) => {
  test.setTimeout(90_000);
  posted = [];
  await signIn(page);
  const database = await createDatabase(page, 'Harbor Watch', [
    {
      name: 'Sightings',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Vessel', type: 'text' },
      ],
    },
  ]);
  const sightings = database.tables.Sightings!;
  await openTable(page, database, 'Sightings');

  // The owner builds the automation: when a sighting is created, post it to Slack.
  await page.getByRole('button', { name: 'Add an automation' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toHaveValue('Untitled automation');
  await name.fill('Post new sightings');
  await name.press('Enter');
  await expect(page.getByRole('link', { name: 'Post new sightings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('region', { name: 'When' })).toContainText('A record is created');
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Post to Slack' }).click();
  const step = page.getByRole('region', { name: 'Post to Slack' });
  await step.getByLabel('Incoming webhook address').fill(WEBHOOK);
  const message = step.getByRole('textbox', { name: 'Message' });
  await message.click();
  await page.keyboard.type('New sighting: ');
  await step.getByRole('button', { name: 'Insert a value' }).click();
  await page.getByRole('menuitem', { name: 'Name', exact: true }).click();
  await message.press('End');
  await page.keyboard.type(' from ');
  await step.getByRole('button', { name: 'Insert a value' }).click();
  await page.getByRole('menuitem', { name: 'Vessel', exact: true }).click();
  await expect(message).toContainText('New sighting: Name from Vessel');
  // Changes save to a draft, which runs only once it's published.
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();

  // Turned on, the step's address is stored as a secret: it shows as saved, and never comes back.
  const turnedOn = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/databases/${database.id}/commands`) &&
      (response.request().postData() ?? '').includes('"enabled":true'),
  );
  await flip(page.getByRole('switch', { name: 'Off' }));
  await expect(page.getByRole('switch', { name: 'On' })).toBeChecked();
  expect((await turnedOn).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('switch', { name: 'On' })).toBeChecked();
  const saved = page.getByRole('region', { name: 'Post to Slack' });
  await expect(saved).toContainText('Incoming webhook address: Saved');
  await expect(saved.getByRole('textbox', { name: 'Message' })).toContainText(
    'New sighting: Name from Vessel',
  );
  expect(await page.content()).not.toContain('standin0webhook0secret');

  // A sighting is created, and Slack's stand-in gets the message, with the values escaped for Slack.
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: sightings.id,
      records: [
        {
          id: newId('rec'),
          values: { [sightings.fields.Name!]: 'Orca & calf <pod>', [sightings.fields.Vessel!]: 'Kestrel' },
        },
      ],
    },
  ]);
  await expect.poll(() => posted.length, { message: 'the stand-in got a message', timeout: 30_000 }).toBe(1);
  expect(posted[0]!.path).toBe('/services/T0E2E0000/B0E2E0000/standin0webhook0secret');
  expect(posted[0]!.contentType).toBe('application/json');
  expect(JSON.parse(posted[0]!.body)).toEqual({
    text: 'New sighting: Orca &amp; calf &lt;pod&gt; from Kestrel',
  });

  // The run shows as done in the automation's history.
  await page.getByRole('tab', { name: 'Runs' }).click();
  const run = page.getByRole('tabpanel', { name: 'Runs' }).getByRole('button').first();
  await expect(run).toContainText('Done');
  await expect(run).toContainText('A record is created');
});

test('an agent flow step keeps its secret and deep link across desktop and phone layouts', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Message routing', [
    { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation' }).click();
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Post through Copilot Studio' }).click();
  const step = page.getByRole('region', { name: 'Post through Copilot Studio' });
  const secret = await page.evaluate(() => crypto.randomUUID());
  const address = new URL('/workflows/test', 'https://test.logic.azure.com');
  address.searchParams.set('sig', secret);
  await step.getByLabel('Incoming webhook address').fill(address.href);
  await step
    .getByRole('textbox', { name: 'Recipient email or channel reference' })
    .fill('person@example.invalid');
  await step.getByRole('textbox', { name: 'Title (optional)', exact: true }).fill('Review requested');
  await step.getByRole('textbox', { name: 'Message', exact: true }).fill('Ready to review');
  await expect(step.getByRole('textbox', { name: 'Record link', exact: true })).toContainText(
    'Link to the record',
  );
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet')).toBeHidden();
  const deepLink = page.url();
  await page.reload();
  await expect(page).toHaveURL(deepLink);
  await expect(step).toContainText('Incoming webhook address: Saved');
  expect(await page.content()).not.toContain(secret);
  await expect(step.getByRole('textbox', { name: 'Title (optional)', exact: true })).toContainText(
    'Review requested',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const recipient = step.getByRole('textbox', { name: 'Recipient email or channel reference' });
  await recipient.scrollIntoViewIfNeeded();
  await recipient.focus();
  await expect(recipient).toBeFocused();
  await recipient.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const help = new URL(deepLink);
  help.searchParams.set('help', 'power-platform');
  await page.goto(help.href);
  await expect(page.getByRole('heading', { name: 'Microsoft Copilot Studio and Teams' })).toBeVisible();
  await expect(page.getByText('{{ui:', { exact: false })).toHaveCount(0);
});
