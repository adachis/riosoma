import { expect, test } from '../accessibility';
import { createDatabase, openTable, OWNER, signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** An expanded record takes comments that mention people, and its history says who changed what. */
test('a comment mentions someone, and the history shows a change', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Studio Notes', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Paint the stage', Room: 'Hall A' }],
    },
  ]);
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Paint the stage' });
  await expect(card.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
  await expect(card.getByText('No comments yet.')).toBeVisible();

  // Typing @ offers people to mention, and choosing one writes the mention in, with their ID.
  const composer = card.getByRole('textbox', { name: 'Add a comment.  Type @ to mention someone.' });
  await composer.click();
  await composer.pressSequentially('@Ada');
  await card
    .getByRole('listbox', { name: 'People to mention' })
    .getByRole('option', { name: OWNER.name })
    .click();
  await expect(composer).toHaveValue(new RegExp(`^@\\[${OWNER.name}\\]\\(usr[0-9A-Za-z]{14}\\) $`));
  await composer.pressSequentially('can you choose the colors?');
  await card.getByRole('button', { name: 'Send' }).click();
  // The thread shows the mention by name.
  const comment = card.getByRole('listitem').filter({ hasText: 'can you choose the colors?' });
  await expect(comment.getByRole('paragraph')).toHaveText(`@${OWNER.name} can you choose the colors?`);
  await expect(composer).toHaveValue('');

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/databases/${database.id}/commands`) &&
      (response.request().postData() ?? '').includes('record.update'),
  );
  const room = card.getByRole('textbox', { name: 'Room' });
  await room.fill('Hall B');
  await room.press('Enter');
  expect((await saved).ok()).toBe(true);

  await card.getByRole('tab', { name: 'History' }).click();
  const history = card.getByRole('tabpanel', { name: 'History' });
  const change = history.getByRole('listitem').filter({ hasText: `${OWNER.name} changed 1 field` });
  await expect(change).toContainText('Room');
  await expect(change.getByRole('deletion')).toHaveText('Hall A');
  await expect(change.getByRole('insertion')).toHaveText('Hall B');
  await expect(history.getByText(`${OWNER.name} created this record`)).toBeVisible();
});
