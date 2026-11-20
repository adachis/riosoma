import { createServer } from 'node:http';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
test('knowledge supports upload, search, replacement, undo, stopping, and phone deep links', async ({
  page,
}) => {
  test.setTimeout(180000);
  // Embedding requests for the slow document wait here until the test lets them go or they close.
  let holding = true;
  const held: Array<{ closed: boolean }> = [];
  const service = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const input = JSON.parse(Buffer.concat(parts).toString()) as { input: string[] };
    if (holding && input.input.some((text) => text.includes('Slow pears'))) {
      const waiting = { closed: false };
      held.push(waiting);
      await new Promise<void>((resolve) =>
        response.once('close', () => {
          waiting.closed = true;
          resolve();
        }),
      );
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ embeddings: input.input.map(() => [1, 0]), prompt_eval_count: 5 }));
  });
  await new Promise<void>((resolve) => service.listen(0, resolve));
  const bound = service.address();
  if (!bound || typeof bound === 'string') throw new Error('Missing fixture address');
  await signIn(page);
  /** Waits for every document in view to finish indexing after a change the page already shows. */
  const indexed = async () => {
    await expect(page.getByText('Indexing…')).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText('Ready to search').first()).toBeVisible();
  };
  const view = await asOwner<{
    settings: Record<string, unknown>;
    providers: { providerId: string; local: boolean }[];
  }>(page, 'GET', '/api/ai/settings');
  // Gateway configuration uses its own form and cannot be written through page settings.
  const { gateways: _gateways, ...settings } = view.settings;
  const original = await asOwner<Record<string, unknown>>(page, 'GET', '/api/knowledge/settings');
  const originalLibraries = await asOwner<Array<{ id: string }>>(page, 'GET', '/api/knowledge/libraries');
  const originalDocuments = new Map<string, Set<string>>();
  for (const library of originalLibraries) {
    const documents = await asOwner<Array<{ id: string }>>(
      page,
      'GET',
      `/api/knowledge/libraries/${library.id}/documents`,
    );
    originalDocuments.set(library.id, new Set(documents.map(({ id }) => id)));
  }
  const libraryChanges: Array<{ libraryId: string; actionId: string }> = [];
  let unitId: string | undefined;
  const saveLibrary = async (save: () => Promise<void>) => {
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/knowledge/library-commands' &&
        response.request().postDataJSON().kind === 'library.save',
    );
    await save();
    const response = await saved;
    expect(response.ok()).toBe(true);
    const result = (await response.json()) as { status: string; actionId: string };
    expect(result.status).toBe('applied');
    libraryChanges.push({
      libraryId: response.request().postDataJSON().libraryId,
      actionId: result.actionId,
    });
  };
  const provider = view.providers.find((entry) => entry.local)!;
  try {
    await asOwner(page, 'PUT', '/api/ai/settings', {
      ...settings,
      enabled: true,
      providers: [{ providerId: provider.providerId }],
      models: { everyday: { providerId: provider.providerId, model: 'small' }, power: null },
    });
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: crypto.randomUUID(),
      kind: 'knowledge.settings',
      settings: {
        ...original,
        embedding: {
          providerId: provider.providerId,
          model: 'small',
          address: `http://${[127, 0, 0, 1].join('.')}:${bound.port}`,
          protocol: 'local',
        },
      },
    });
    await page.goto(`${base()}/settings/knowledge`);
    await page.getByRole('textbox', { name: 'Library name' }).fill('My reference');
    await page.getByRole('textbox', { name: 'Short description' }).fill('Orchard facts');
    await page.getByRole('textbox', { name: 'Short guidance', exact: true }).fill('Call customers members');
    await saveLibrary(() =>
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click(),
    );
    await expect(page.getByText('No documents yet.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Document name' }).fill('Harvest notes');
    await page
      .getByRole('textbox', { name: 'Paste document text' })
      .fill('# Harvest\nApples ripen in October');
    await page.getByRole('button', { name: 'Add document' }).click();
    // The upload answers first, and the list follows the background indexing until it's done.
    await expect(page.getByText('Ready to search')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: 'Re-index', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Re-index', exact: true })).toBeEnabled({ timeout: 20000 });
    await page.getByRole('textbox', { name: 'Search documents for' }).fill('When do apples ripen?');
    await page.getByRole('button', { name: 'Search documents', exact: true }).click();
    await expect(page.getByText('Apples ripen in October', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Harvest notes—Harvest', exact: true }).click();
    await expect(page).toHaveURL(/\/knowledge\//);
    await page.getByRole('textbox', { name: 'Search documents for' }).fill('When do apples ripen?');
    await page.getByRole('link', { name: 'Link to this search' }).click();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Search documents for' })).toHaveValue(
      'When do apples ripen?',
    );
    await page.getByLabel('Replace file', { exact: true }).setInputFiles({
      name: 'harvest.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Harvest\nApples ripen in September'),
    });
    await page.getByRole('button', { name: 'Replace document' }).click();
    await expect(page.getByRole('link', { name: 'harvest.md', exact: true })).toBeVisible();
    await indexed();
    await page.getByRole('button', { name: 'Search documents', exact: true }).click();
    await expect(page.getByText('Apples ripen in September', { exact: true })).toBeVisible();
    await expect(page.getByText('Apples ripen in October', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Replace file', { exact: true })).toHaveValue('');
    await page.getByLabel('Replace file', { exact: true }).setInputFiles({
      name: 'harvest.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Harvest\nApples ripen in August'),
    });
    await page.getByRole('button', { name: 'Replace document' }).click();
    await expect(page.getByLabel('Replace file', { exact: true })).toHaveValue('');
    await indexed();
    await page.getByRole('button', { name: 'Search documents', exact: true }).click();
    await expect(page.getByText('Apples ripen in August', { exact: true })).toBeVisible();
    await expect(page.getByText('Apples ripen in September', { exact: true })).toHaveCount(0);
    const replacement = page
      .getByRole('group', { name: 'Drop a document here, or choose a file.', exact: true })
      .filter({ has: page.getByLabel('Replace file', { exact: true }) });
    await expect(replacement.getByText('Drop a document here, or choose a file.')).toBeVisible();
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(['# Harvest\nApples ripen in July'], 'harvest.md', { type: 'text/markdown' }));
      return data;
    });
    try {
      await replacement.dispatchEvent('dragenter', { dataTransfer: transfer });
      await expect(replacement).toHaveAttribute('data-drag-over', 'true');
      await replacement.dispatchEvent('drop', { dataTransfer: transfer });
      await expect(replacement.getByRole('status')).toHaveText('harvest.md');
      await page.getByRole('button', { name: 'Replace document' }).click();
      await expect(replacement.getByRole('status')).toBeEmpty();
      await indexed();
      await page.getByRole('button', { name: 'Search documents', exact: true }).click();
      await expect(page.getByText('Apples ripen in July', { exact: true })).toBeVisible();
      await expect(page.getByText('Apples ripen in August', { exact: true })).toHaveCount(0);
    } finally {
      await transfer.dispose();
    }
    await page.getByRole('button', { name: 'Delete document' }).click();
    await expect(page.getByText('No documents yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Undo last knowledge change' }).click();
    await expect(page.getByRole('link', { name: 'harvest.md', exact: true }).first()).toBeVisible();
    await indexed();
    // A document can be stopped while it indexes, keeps the text already read, and indexes again.
    await page.getByRole('textbox', { name: 'Document name' }).fill('Slow notes');
    await page.getByRole('textbox', { name: 'Paste document text' }).fill('# Slow\nSlow pears ripen late');
    await page.getByRole('button', { name: 'Add document' }).click();
    const slow = page.getByRole('article').filter({ hasText: 'Slow notes' });
    await expect(slow.getByText('Indexing…')).toBeVisible();
    await expect.poll(() => held.length, { timeout: 20000 }).toBe(1);
    await slow.getByRole('button', { name: 'Stop indexing' }).focus();
    await page.keyboard.press('Enter');
    await expect(slow.getByText('Indexing was stopped.', { exact: false })).toBeVisible();
    await expect.poll(() => held[0]!.closed).toBe(true);
    holding = false;
    await slow.getByRole('button', { name: 'Re-index', exact: true }).click();
    await expect(slow.getByText('Ready to search')).toBeVisible({ timeout: 20000 });
    await page.getByRole('textbox', { name: 'Search documents for' }).fill('pears');
    await page.getByRole('button', { name: 'Search documents', exact: true }).click();
    await expect(page.getByText('Slow pears ripen late', { exact: true })).toBeVisible();
    await slow.getByRole('button', { name: 'Delete document' }).click();
    await expect(slow).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Help with knowledge' }).click();
    await expect(page).toHaveURL(/help=knowledge-libraries/);
    const database = await createDatabase(page, 'Knowledge garden', [
      { name: 'Plants', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await page.goto(`${base()}/${database.id}/settings/knowledge`);
    await page.getByRole('textbox', { name: 'Library name' }).fill('Plant facts');
    await page.getByRole('button', { name: 'Save library' }).focus();
    await saveLibrary(() => page.keyboard.press('Enter'));
    await expect(page.getByText('No documents yet.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Short guidance', exact: true })).toHaveCount(0);
    await page.goto(`${base()}/settings/ai#knowledge`);
    const section = page.locator('#knowledge');
    await section.getByRole('textbox', { name: 'Library name' }).fill('Organization facts');
    await saveLibrary(() =>
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click(),
    );
    await expect(section.getByText('No documents yet.')).toBeVisible();
    await section.getByRole('spinbutton', { name: 'Documents per library' }).fill('25');
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await page.reload();
    await expect(section.getByRole('spinbutton', { name: 'Documents per library' })).toHaveValue('25');
    const unit = await asOwner<{ id: string }>(page, 'POST', '/api/org/units', {
      name: 'Orchard unit',
      parentId: null,
    });
    unitId = unit.id;
    await page.reload();
    await section.getByRole('button', { name: /Library scope/ }).click();
    await page.getByRole('option', { name: 'Orchard unit', exact: true }).click();
    await section.getByRole('textbox', { name: 'Library name' }).fill('Unit facts');
    await saveLibrary(() =>
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true })
        .click(),
    );
    await expect(section.getByText('No documents yet.')).toBeVisible();
    await section.getByRole('link', { name: 'Link to this library' }).click();
    await expect(page).toHaveURL(new RegExp(`unit=${unit.id}`));
    await page.reload();
    await expect(section.getByRole('textbox', { name: 'Library name' })).toHaveValue('Unit facts');
  } finally {
    // Library descriptions and guidance enter every later conversation and require review.
    for (const libraryId of new Set(libraryChanges.map((change) => change.libraryId))) {
      const documents = await asOwner<Array<{ id: string }>>(
        page,
        'GET',
        `/api/knowledge/libraries/${libraryId}/documents`,
      );
      for (const document of documents) {
        if (originalDocuments.get(libraryId)?.has(document.id)) continue;
        expect(
          await asOwner(page, 'POST', '/api/knowledge/library-commands', {
            id: crypto.randomUUID(),
            kind: 'library.deleteDocument',
            libraryId,
            documentId: document.id,
          }),
        ).toMatchObject({ status: 'applied' });
      }
    }
    for (const { actionId } of libraryChanges.reverse()) {
      expect(
        await asOwner(page, 'POST', '/api/knowledge/library-commands', {
          id: crypto.randomUUID(),
          kind: 'library.undo',
          actionId,
        }),
      ).toMatchObject({ status: 'applied' });
    }
    if (unitId) await asOwner(page, 'DELETE', `/api/org/units/${unitId}`);
    await asOwner(page, 'PUT', '/api/ai/settings', settings);
    await asOwner(page, 'POST', '/api/knowledge/commands', {
      id: crypto.randomUUID(),
      kind: 'knowledge.settings',
      settings: original,
    });
    await new Promise<void>((resolve) => service.close(() => resolve()));
  }
});

test('import review labels knowledge and supports keyboard approval on a phone', async ({ page }) => {
  await signIn(page);
  const items = ['knowledgeLibrary', 'knowledgeDocument', 'knowledgeDocument'].map((kind, index) => ({
    id: crypto.randomUUID(),
    kind,
    name: index === 2 ? 'Discarded notes' : index ? 'Harvest notes' : 'Orchard library',
    databaseId: null,
    destinations: [{ kind: 'inside', value: '' }],
    needsSecret: false,
    ...(index ? {} : { pendingDocuments: 2 }),
    done: false,
    createdAt: new Date().toISOString(),
  }));
  const dismissals: string[] = [];
  await page.route('**/api/organization-archives/review', (route) => route.fulfill({ json: items }));
  await page.route('**/api/organization-archives/review/*/enable', (route) => {
    const item = items.find((item) => route.request().url().includes(item.id))!;
    item.done = true;
    return route.fulfill({ json: { item } });
  });
  await page.route('**/api/organization-archives/review/*/dismiss', (route) => {
    const item = items.find((item) => route.request().url().includes(item.id))!;
    dismissals.push(item.name);
    item.done = true;
    return route.fulfill({ json: { item } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/settings/export-and-import`);
  await expect(page.getByText('Knowledge library', { exact: true })).toBeVisible();
  await expect(page.getByText('Knowledge document', { exact: true }).first()).toBeVisible();
  const library = page.getByRole('listitem').filter({ hasText: 'Orchard library' });
  await library.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('2 pending documents');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await library.getByRole('button', { name: 'Turn on', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(library.getByText('Reviewed', { exact: true })).toBeVisible();
  const documentRow = page.getByRole('listitem').filter({ hasText: 'Harvest notes' });
  await documentRow.getByRole('button', { name: 'Turn on', exact: true }).click();
  await expect(documentRow.getByText('Reviewed', { exact: true })).toBeVisible();
  const dismissed = page.getByRole('listitem').filter({ hasText: 'Discarded notes' });
  await dismissed.getByRole('button', { name: 'Dismiss', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Erasing pending knowledge asks first, and Escape backs out without erasing anything.
  const question = page.getByRole('dialog');
  await expect(question).toContainText('Dismiss Discarded notes?');
  await expect(question).toContainText('permanently erases this pending document');
  await page.keyboard.press('Escape');
  await expect(question).toHaveCount(0);
  expect(dismissals).toEqual([]);
  await dismissed.getByRole('button', { name: 'Dismiss', exact: true }).focus();
  await page.keyboard.press('Enter');
  await question.getByRole('button', { name: 'Dismiss and erase' }).focus();
  await page.keyboard.press('Enter');
  await expect(dismissed.getByText('Reviewed', { exact: true })).toBeVisible();
  expect(dismissals).toEqual(['Discarded notes']);
  await expect(dismissed.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
