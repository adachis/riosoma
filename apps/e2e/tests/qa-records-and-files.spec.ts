import { assertAccessible, expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);

for (const kind of ['comments', 'history'] as const) {
  test(`retries a failed ${kind} read inside the record`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Record read recovery', [
      {
        name: 'Tasks',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Review 記録 🧭' }],
      },
    ]);
    const table = database.tables.Tasks!;
    let reads = 0;
    await page.route(`**/api/tables/${table.id}/records/${table.records[0]}/${kind}`, async (route) => {
      if (++reads === 1)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false },
          }),
        });
      else await route.continue();
    });
    const grid = await openTable(page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const card = page.getByRole('dialog', { name: 'Review 記録 🧭', exact: true });
    const tab = kind === 'comments' ? 'Comments' : 'History';
    await card.getByRole('tab', { name: tab, exact: true }).click();
    const panel = card.getByRole('tabpanel', { name: tab, exact: true });
    await expect(panel.getByRole('alert')).toBeVisible();
    await panel.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(
      panel.getByText(kind === 'comments' ? 'No comments yet.' : /created this record/),
    ).toBeVisible();
    expect(reads).toBe(2);
  });
}

test('retrying older history retains the loaded entries and uses the failed cursor', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'History page recovery', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Review', Room: 'Before' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0], values: { [table.fields.Room!]: 'After' } }],
    },
  ]);
  const cursors: Array<string | null> = [];
  await page.route(`**/api/tables/${table.id}/records/${table.records[0]}/history*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    cursors.push(cursor);
    if (cursors.length === 2) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false },
        }),
      });
      return;
    }
    const response = await route.fetch();
    if (!cursor) {
      const body = (await response.json()) as { entries: Array<{ seq: number }>; next: string | null };
      const next = Buffer.from(
        JSON.stringify({ tableId: table.id, recordId: table.records[0], seq: body.entries[0]!.seq }),
      ).toString('base64url');
      await route.fulfill({ response, json: { ...body, entries: body.entries.slice(0, 1), next } });
    } else await route.fulfill({ response });
  });
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Review', exact: true });
  await card.getByRole('tab', { name: 'History', exact: true }).click();
  const history = card.getByRole('tabpanel', { name: 'History', exact: true });
  await expect(history.getByRole('insertion').filter({ hasText: /^After$/ })).toHaveText('After');
  await history.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(history.getByRole('alert')).toBeVisible();
  await expect(history.getByRole('insertion').filter({ hasText: /^After$/ })).toHaveText('After');
  await history.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(history.getByRole('alert')).toHaveCount(0);
  await expect(history.getByText(/created this record/)).toBeVisible();
  await expect(history.getByRole('insertion').filter({ hasText: /^After$/ })).toHaveText('After');
  expect(cursors).toHaveLength(3);
  expect(cursors[1]).not.toBeNull();
  expect(cursors[2]).toBe(cursors[1]);
});

test('pending comments remain readable until their command finishes', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Pending comment readability', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Review' }],
    },
  ]);
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Review', exact: true });
  let releaseWrite!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    const batch = route.request().postDataJSON() as { commands?: Array<{ kind: string }> };
    if (batch.commands?.some((command) => command.kind === 'comment.create')) await held;
    await route.continue();
  });
  const body = 'A pending comment stays readable.';
  try {
    await card.getByRole('textbox', { name: /Add a comment/ }).fill(body);
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    const pending = card.locator('.rio-comments__item[data-pending]');
    await expect(pending.getByText(body, { exact: true })).toBeVisible();
    await assertAccessible(page);
    releaseWrite();
    await expect(pending).toHaveCount(0);
    await page.reload();
    await expect(card.getByText(body, { exact: true })).toBeVisible();
  } finally {
    releaseWrite();
  }
});

test('a demoted comment author can read their comment without mutation controls', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Comment author access', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Review' }],
    },
  ]);
  const person = await invite(page, browser, 'Review Author');
  try {
    await share(page, database.id, person, 'commenter');
    const grid = await openTable(person.page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const card = person.page.getByRole('dialog', { name: 'Review', exact: true });
    await card.getByRole('textbox', { name: /Add a comment/ }).fill('Check 中文 🧭 שלום');
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await card.getByRole('textbox', { name: 'Edit', exact: true }).fill('Unapplied draft');
    await share(page, database.id, person, 'reader');
    await expect(card.getByRole('textbox', { name: 'Edit', exact: true })).toHaveCount(0);
    await share(page, database.id, person, 'commenter');
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await expect(card.getByRole('textbox', { name: 'Edit', exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmation = person.page.getByRole('dialog', { name: 'Delete this comment?', exact: true });
    await expect(confirmation).toBeVisible();
    await share(page, database.id, person, 'reader');
    await expect(confirmation).toHaveCount(0);
    await share(page, database.id, person, 'commenter');
    await expect(card.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
    await expect(confirmation).toHaveCount(0);
    await share(page, database.id, person, 'reader');
    await person.page.reload();
    await expect(card.getByText('Check 中文 🧭 שלום', { exact: true })).toBeVisible();
    await expect(card.getByRole('textbox', { name: /Add a comment/ })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await share(page, database.id, person, 'commenter');
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await card.getByRole('textbox', { name: 'Edit', exact: true }).fill('Updated 中文 🧭 שלום');
    await card.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(card.getByText('Updated 中文 🧭 שלום', { exact: true })).toBeVisible();
    await expect(card.getByText('edited', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    await person.page
      .getByRole('dialog', { name: 'Delete this comment?', exact: true })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(card.getByText('No comments yet.', { exact: true })).toBeVisible();
  } finally {
    await person.context.close();
  }
});

test('lock drafts close after access changes, and locked records enforce each role', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Record lock access', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Approval', Room: 'Before' }],
    },
  ]);
  const table = database.tables.Tasks!;
  const person = await invite(page, browser, 'Lock Reviewer', 'guest');
  try {
    await share(page, database.id, person, 'editor');
    await person.page.setViewportSize({ width: 390, height: 844 });
    const grid = await openTable(person.page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const card = person.page.getByRole('dialog', { name: 'Approval', exact: true });
    await card.getByRole('button', { name: 'Lock record', exact: true }).click();
    await card.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('Unapplied approval');
    await share(page, database.id, person, 'reader');
    await expect(card.getByRole('textbox', { name: 'Lock reason', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Confirm lock', exact: true })).toHaveCount(0);
    await share(page, database.id, person, 'editor');
    await card.getByRole('button', { name: 'Lock record', exact: true }).click();
    await expect(card.getByRole('textbox', { name: 'Lock reason', exact: true })).toHaveValue('');
    await card.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('Reviewed 記録 🧭');
    await card.getByRole('button', { name: 'Confirm lock', exact: true }).click();
    await expect(card.getByText('Locked: Reviewed 記録 🧭', { exact: true })).toBeVisible();
    for (const role of ['editor', 'creator', 'commenter', 'reader'] as const) {
      await share(page, database.id, person, role);
      await expect(card.getByRole('textbox', { name: 'Room', exact: true })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Unlock record', exact: true })).toHaveCount(0);
      const result = await asOwner<{ results: Array<{ status: string }> }>(
        person.page,
        'POST',
        `/api/databases/${database.id}/commands`,
        {
          clientId: newId('cli'),
          commands: [
            {
              id: newId('cmd'),
              groupId: newId('act'),
              kind: 'record.update',
              tableId: table.id,
              records: [{ id: table.records[0], values: { [table.fields.Room!]: 'Blocked' } }],
            },
          ],
        },
      );
      expect(result.results[0]?.status).toBe('rejected');
    }
    await share(page, database.id, person, 'owner');
    await expect(card.getByRole('textbox', { name: 'Room', exact: true })).toHaveValue('Before');
    await card.getByRole('button', { name: 'Unlock record', exact: true }).click();
    await expect(card.getByText('Locked: Reviewed 記録 🧭', { exact: true })).toHaveCount(0);
  } finally {
    await person.context.close();
  }
});

test('history follows edits from another browser context while its tab stays open', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Live record history', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Review', Room: 'Before' }],
    },
  ]);
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Review', exact: true });
  await card.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(card.getByText(/created this record/)).toBeVisible();
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  try {
    const other = await context.newPage();
    await openTable(other, database, 'Tasks');
    const table = database.tables.Tasks!;
    await visit(other, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
    const field = other.getByRole('textbox', { name: 'Room', exact: true });
    await field.fill('After 共有 🧭');
    await field.press('Enter');
    await expect(card.getByRole('textbox', { name: 'Room', exact: true })).toHaveValue('After 共有 🧭');
    await expect(
      card
        .getByRole('tabpanel', { name: 'History', exact: true })
        .getByRole('insertion')
        .filter({ hasText: 'After 共有 🧭' }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const gridFails of [false, true]) {
  test(`open history removes cached values when a field becomes restricted${gridFails ? ' and the grid refresh fails' : ''}`, async ({
    page,
    browser,
  }) => {
    await signIn(page);
    const database = await createDatabase(page, 'History access changes', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Room', type: 'text' },
        ],
        records: [{ Name: 'Review', Room: 'Private before' }],
      },
    ]);
    const table = database.tables.Tasks!;
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: table.records[0], values: { [table.fields.Room!]: 'Private after' } }],
      },
    ]);
    const person = await invite(page, browser, 'History Reader');
    try {
      await share(page, database.id, person, 'reader');
      const grid = await openTable(person.page, database, 'Tasks');
      await grid.getByRole('button', { name: 'Expand row 1' }).click();
      const card = person.page.getByRole('dialog', { name: 'Review', exact: true });
      await card.getByRole('tab', { name: 'History', exact: true }).click();
      const history = card.getByRole('tabpanel', { name: 'History', exact: true });
      await expect(history.getByText('Private after', { exact: true })).toBeVisible();
      let failedRefreshes = 0;
      if (gridFails)
        await person.page.route(`**/api/views/${table.viewId}/rows*`, async (route) => {
          failedRefreshes++;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false },
            }),
          });
        });
      await asOwner(page, 'PUT', `/api/fields/${table.fields.Room}/permissions`, {
        restricted: { roles: ['owner'], users: [] },
        locked: null,
      });
      await expect(history.getByText('Private before', { exact: true })).toHaveCount(0);
      await expect(history.getByText('Private after', { exact: true })).toHaveCount(0);
      await expect(card.getByText('Room', { exact: true })).toHaveCount(0);
      await expect(history.getByText(/created this record/)).toBeVisible();
      if (gridFails) expect(failedRefreshes).toBeGreaterThan(0);
    } finally {
      await person.context.close();
    }
  });
}

for (const mutation of ['update', 'delete'] as const) {
  test(`a slow comments retry preserves a live ${mutation}`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Comment read races', [
      {
        name: 'Tasks',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Review' }],
      },
    ]);
    const table = database.tables.Tasks!;
    const commentId = `cmt${newId('rec').slice(3)}`;
    await runCommands(page, database.id, [
      {
        kind: 'comment.create',
        tableId: table.id,
        recordId: table.records[0],
        comment: { id: commentId, body: 'Original comment' },
      },
    ]);
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let snapshotRead!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    await page.route(`**/api/tables/${table.id}/records/${table.records[0]}/comments`, async (route) => {
      if (++reads === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false },
          }),
        });
        return;
      }
      const response = await route.fetch();
      snapshotRead();
      await held;
      await route.fulfill({ response });
    });
    try {
      const grid = await openTable(page, database, 'Tasks');
      await grid.getByRole('button', { name: 'Expand row 1' }).click();
      const panel = page
        .getByRole('dialog', { name: 'Review', exact: true })
        .getByRole('tabpanel', { name: 'Comments', exact: true });
      await panel.getByRole('button', { name: 'Try again', exact: true }).click();
      await snapshotReady;
      await runCommands(page, database.id, [
        mutation === 'update'
          ? { kind: 'comment.update', commentId, body: 'Live edit' }
          : { kind: 'comment.delete', commentId },
        {
          kind: 'comment.create',
          tableId: table.id,
          recordId: table.records[0],
          comment: { id: `cmt${newId('rec').slice(3)}`, body: 'Live checkpoint' },
        },
      ]);
      await expect(panel.getByText('Live checkpoint', { exact: true })).toBeVisible();
      if (mutation === 'update') await expect(panel.getByText('Live edit', { exact: true })).toBeVisible();
      release();
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel.getByText('Original comment', { exact: true })).toHaveCount(0);
      if (mutation === 'update') await expect(panel.getByText('Live edit', { exact: true })).toBeVisible();
      await expect(panel.getByText('Live checkpoint', { exact: true })).toBeVisible();
    } finally {
      release();
    }
  });
}

test('a live history refresh retains older pages and continues from their cursor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'History read races', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Room', type: 'text' },
      ],
      records: [{ Name: 'Review', Room: 'Original room' }],
    },
  ]);
  const table = database.tables.Tasks!;
  for (const value of ['Older page', 'Current page'])
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: table.records[0], values: { [table.fields.Room!]: value } }],
      },
    ]);
  const cursors: Array<string | null> = [];
  let olderCursor: string | null = null;
  await page.route(`**/api/tables/${table.id}/records/${table.records[0]}/history*`, async (route) => {
    cursors.push(new URL(route.request().url()).searchParams.get('cursor'));
    const response = await route.fetch();
    const body = (await response.json()) as { entries: Array<{ seq: number }>; next: string | null };
    const next =
      body.entries.length > 1
        ? Buffer.from(
            JSON.stringify({
              tableId: table.id,
              recordId: table.records[0],
              seq: body.entries[0]!.seq,
            }),
          ).toString('base64url')
        : null;
    if (cursors.length === 2) olderCursor = next;
    await route.fulfill({ response, json: { ...body, entries: body.entries.slice(0, 1), next } });
  });
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Review', exact: true });
  await card.getByRole('tab', { name: 'History', exact: true }).click();
  const history = card.getByRole('tabpanel', { name: 'History', exact: true });
  await expect(history.getByRole('insertion').filter({ hasText: /^Current page$/ })).toBeVisible();
  await history.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(history.getByRole('insertion').filter({ hasText: /^Older page$/ })).toBeVisible();
  expect(olderCursor).not.toBeNull();
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: table.id,
      records: [{ id: table.records[0], values: { [table.fields.Room!]: 'Live change' } }],
    },
  ]);
  await expect(history.getByRole('insertion').filter({ hasText: /^Live change$/ })).toBeVisible();
  await expect(history.getByRole('insertion').filter({ hasText: /^Older page$/ })).toBeVisible();
  await history.getByRole('button', { name: 'Show more', exact: true }).click();
  await expect(history.getByText(/created this record/)).toBeVisible();
  expect(cursors[3]).toBe(olderCursor);
});

test('invalid and rejected lock changes can be corrected and retried on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Lock validation recovery', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Approval' }],
    },
  ]);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Approval', exact: true });
  await card.getByRole('button', { name: 'Lock record', exact: true }).click();
  const reason = card.getByRole('textbox', { name: 'Lock reason', exact: true });
  await reason.fill('x'.repeat(1001));
  const confirm = card.getByRole('button', { name: 'Confirm lock', exact: true });
  await confirm.click();
  await expect(card.getByRole('alert')).toHaveText('The lock could not be changed.');
  await expect(confirm).toBeEnabled();
  let writes = 0;
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    if (++writes > 1) return route.continue();
    const { commands } = route.request().postDataJSON() as { commands: Array<{ id: string }> };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applied: 0,
        rejected: commands.length,
        results: commands.map(({ id }) => ({
          id,
          status: 'rejected',
          error: { code: 'forbidden', messageKey: 'errors.forbidden', userFault: true },
        })),
      }),
    });
  });
  await reason.fill('Reviewed 記録 🧭');
  await confirm.click();
  await expect(card.getByRole('alert')).toHaveText('The lock could not be changed.');
  await expect(reason).toHaveValue('Reviewed 記録 🧭');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(card.getByText('Locked: Reviewed 記録 🧭', { exact: true })).toBeVisible();
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(writes).toBe(2);
});

test('lock drafts stay with their record during keyboard navigation', async ({ page: owner, browser }) => {
  await signIn(owner);
  const editor = await invite(owner, browser, 'Lock Reviewer');
  const page = editor.page;
  await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
  try {
    const database = await createDatabase(page, 'Lock drafts', [
      {
        name: 'Tasks',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'First' }, { Name: 'Second' }],
      },
    ]);
    const grid = await openTable(page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Expand row 1' }).click();
    const first = page.getByRole('region', { name: 'First', exact: true });
    await first.getByRole('button', { name: 'Lock record', exact: true }).click();
    await first.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('First record approval');
    await first.press('Alt+ArrowDown');
    const second = page.getByRole('region', { name: 'Second', exact: true });
    await expect(second).toBeVisible();
    await expect(second.getByRole('textbox', { name: 'Lock reason', exact: true })).toHaveCount(0);
    await second.getByRole('button', { name: 'Lock record', exact: true }).click();
    await expect(second.getByRole('textbox', { name: 'Lock reason', exact: true })).toHaveValue('');
    await second.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('Second record approval');
    const table = database.tables.Tasks!;
    await second.getByRole('button', { name: 'Confirm lock', exact: true }).click();
    await expect(second.getByText('Locked: Second record approval', { exact: true })).toBeVisible();
    const row = await asOwner<{ lock?: { reason: string } }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[1]}`,
    );
    expect(row.lock?.reason).toBe('Second record approval');
    await runCommands(page, database.id, [
      { kind: 'record.setLock', tableId: table.id, recordIds: [table.records[1]], locked: false, reason: '' },
    ]);
  } finally {
    await editor.context.close();
  }
});
