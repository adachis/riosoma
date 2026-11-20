import { randomBytes } from 'node:crypto';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, createView, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('a private form respects reader, commenter, guest, and editor access as it changes live', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Form access', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Assignee', type: 'user' },
        ...Array.from({ length: 12 }, (_, index) => ({ name: `Notes ${index + 1}`, type: 'text' as const })),
      ],
    },
  ]);
  const table = database.tables.Requests!;
  const viewId = await createView(page, database, 'Requests', {
    name: 'Form',
    type: 'form',
    config: {
      form: {
        questions: Object.values(table.fields).map((fieldId) => ({
          fieldId,
          required: fieldId === table.fields.Name,
        })),
      },
    },
  });
  const person = await invite(page, browser, 'Form Reader');
  const guest = await invite(page, browser, 'Form Guest', 'guest');
  try {
    for (const viewer of [person, guest]) {
      await viewer.page.route(`**/api/databases/${database.id}/schema`, async (route) => {
        const response = await route.fetch();
        const schema = await response.json();
        schema.collaborators.push(
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `usr${randomBytes(7).toString('hex')}`,
            name: `Form Member ${index + 1}`,
            email: `form.member${index + 1}@example.test`,
          })),
        );
        await route.fulfill({ response, json: schema });
      });
    }
    for (const role of ['reader', 'commenter'] as const) {
      await share(page, database.id, person, role);
      await visit(person.page, `${base()}/${database.id}/${table.id}/${viewId}`);
      await expect(person.page.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
      await expect(person.page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
      const member = person.page.getByRole('option', { name: labelName('Form Member 1'), exact: true });
      await member.dispatchEvent('click');
      await expect(member).toHaveAttribute('aria-selected', 'false');
      await expect(member).toHaveAttribute('aria-disabled', 'true');
      await expect(person.page.getByRole('searchbox', { name: 'Filter items', exact: true })).toBeDisabled();
      const options = person.page.getByRole('listbox', { name: /Assignee/ });
      await options.focus();
      await expect(options).toBeFocused();
      await options.press('PageDown');
      await expect.poll(() => options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const scroller = person.page.locator('.rio-form-view');
      await scroller.focus();
      await expect(scroller).toBeFocused();
      await scroller.press('PageDown');
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }
    await share(page, database.id, guest, 'reader');
    await guest.page.setViewportSize({ width: 390, height: 844 });
    await visit(guest.page, `${base()}/${database.id}/${table.id}/${viewId}`);
    await expect(guest.page.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
    await expect(guest.page.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await expect(
      guest.page.getByRole('option', { name: labelName('Form Member 1'), exact: true }),
    ).toHaveAttribute('aria-disabled', 'true');
    await share(page, database.id, person, 'editor');
    const editor = person.page.getByRole('textbox', { name: 'Name', exact: true });
    await expect(editor).toBeEnabled();
    const assignee = person.page.getByRole('option', { name: labelName('Form Reader'), exact: true });
    await expect(assignee).not.toHaveAttribute('aria-disabled', 'true');
    await assignee.click();
    await expect(assignee).toHaveAttribute('aria-selected', 'true');
    await editor.fill('Authorized 東京 🚢 مرحبا');
    await person.page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(
      person.page.getByRole('status').filter({ hasText: 'Thanks!  Your answer was recorded.' }),
    ).toBeVisible();
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.values[table.fields.Name!]).toBe('Authorized 東京 🚢 مرحبا');
    expect(rows.rows[0]!.values[table.fields.Assignee!]).toEqual([person.id]);
  } finally {
    await person.context.close();
    await guest.context.close();
  }
});
