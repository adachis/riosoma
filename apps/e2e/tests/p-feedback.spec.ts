import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, OWNER, signIn } from '../helpers';
import { invite, mailTo, share, waitForMail } from '../people';

/**
 * Feedback from the Help menu, with two people signed in at once.  A member sends feedback from a
 * grid with a screenshot of the page.  What their browser sends holds none of the grid's text, and
 * the screenshot the server keeps is the one it sent.  The owner reads it in the feedback inbox and
 * replies, and the member finds the reply under the bell and in their email.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** What the grid shows, none of which may leave the member's browser with their feedback */
const CELLS = ['Brass porthole 8841', 'Teak grating 3317', 'Bronze cleat 5570', 'Aft locker'];

const MESSAGE = 'The grid jumps back to the top after I change a cell.';
const REPLY = 'Thanks, we can see it too and are on it.';

test('feedback sent with a screenshot carries no grid text, and the reply reaches the sender', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Chandlery Ledger', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Shelf', type: 'text' },
      ],
      records: [
        { Name: CELLS[0], Shelf: CELLS[3] },
        { Name: CELLS[1], Shelf: CELLS[3] },
        { Name: CELLS[2], Shelf: CELLS[3] },
      ],
    },
  ]);
  const oona = await invite(page, browser, 'Oona Reyes');
  await share(page, database.id, oona, 'editor');

  // The member has the grid open when something goes wrong, and sends feedback from the personal menu.
  const grid = await openTable(oona.page, database, 'Items');
  for (const name of CELLS.slice(0, 3)) await expect(grid.getByRole('gridcell', { name })).toBeVisible();
  await oona.page.getByRole('button', { name: /: Personal menu$/ }).click();
  await oona.page.getByRole('menuitem', { name: 'Send feedback' }).click();
  const dialog = oona.page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog.getByRole('radio', { name: 'Something’s broken' })).toBeChecked();
  await dialog.getByRole('textbox', { name: 'Your message' }).fill(MESSAGE);
  await dialog.getByRole('button', { name: 'Add a screenshot of this page' }).click();
  await expect(dialog.getByRole('img', { name: 'This page, with every value blurred out' })).toBeVisible();

  const request = oona.page.waitForRequest(
    (sent) => sent.url() === `${base()}/api/feedback` && sent.method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Send feedback' }).click();
  await expect(oona.page.getByText('Thanks.  Your feedback is on its way to your admins.')).toBeVisible();
  await expect(dialog).toBeHidden();

  // What went holds the message and a picture, and none of the grid's text, in the picture or out.
  const body = (await request).postData() ?? '';
  const sent = JSON.parse(body) as { message: string; screenshot?: string };
  expect(sent.message).toBe(MESSAGE);
  expect(sent.screenshot).toMatch(/^data:image\/(png|jpeg);base64,/);
  const picture = Buffer.from(sent.screenshot!.replace(/^data:[^,]+,/, ''), 'base64');
  expect(CELLS.filter((text) => body.includes(text))).toEqual([]);
  expect(CELLS.filter((text) => picture.toString('latin1').includes(text))).toEqual([]);

  // The owner reads it in the feedback inbox, with the screenshot the server kept, which is the one
  // the member's browser sent.
  await page.goto(`${base()}/settings/feedback`);
  await expect(page.getByRole('heading', { name: 'Feedback', level: 1 })).toBeVisible();
  const item = page.getByRole('listitem').filter({ hasText: MESSAGE });
  await expect(item).toContainText('From Oona Reyes');
  await expect(item.getByRole('img', { name: 'The screenshot sent with this feedback' })).toBeVisible();
  const inbox = await asOwner<{ items: Array<{ id: string; message: string }> }>(
    page,
    'GET',
    '/api/admin/feedback',
  );
  const feedback = inbox.items.find((entry) => entry.message === MESSAGE)!;
  const stored = await page.request.get(`${base()}/api/admin/feedback/${feedback.id}/screenshot`);
  expect(stored.ok()).toBe(true);
  expect((await stored.body()).equals(picture)).toBe(true);

  // The owner replies.
  await item.getByRole('textbox', { name: 'Reply' }).fill(REPLY);
  await item.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByText('Reply sent')).toBeVisible();
  await expect(item.getByRole('list', { name: 'Replies' })).toContainText(REPLY);

  // The member finds it under the bell, and in their email.
  const bell = oona.page.getByRole('button', { name: /^Notifications, 1 unread$/ });
  await bell.click();
  const notifications = oona.page.getByRole('dialog', { name: 'Notifications' });
  await expect(notifications).toContainText(`${OWNER.name} replied to your feedback`);
  await expect(notifications).toContainText(`“${REPLY}”`);
  const mail = await waitForMail(
    (message) => message.to.includes(oona.email) && message.text.includes(REPLY),
    'the reply by email',
  );
  expect(mail.text).toContain(REPLY);
  expect(mailTo(oona.email).filter((message) => message.text.includes(REPLY))).toHaveLength(1);
  await oona.context.close();
});
