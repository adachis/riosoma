import { expect, test, type Page } from '../accessibility';
import { randomBytes } from 'node:crypto';
import { base } from '../base';
import { asOwner, createDatabase, newId, runCommands, signIn } from '../helpers';
import { captureIce, iceProbe } from '../interface-code-network';
import { invite, share } from '../people';

test.use({
  serviceWorkers: 'block',
  // Full Chromium keeps opaque blob navigations stable on macOS.
  channel: async ({ browserName }, use) => {
    await use(browserName === 'chromium' ? 'chromium' : undefined);
  },
});

async function setup(page: Page) {
  await signIn(page);
  const database = await createDatabase(page, 'Code pages', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Before' }],
    },
  ]);
  const table = database.tables.Tasks!;
  const id = `itf${newId('rec').slice(3)}`;
  const recordsId = 'records01';
  const value = {
    id: 'pageMain01',
    name: 'Tasks',
    blocks: [
      {
        id: recordsId,
        kind: 'records',
        title: 'Queue',
        source: { tableId: table.id, viewId: table.viewId },
        place: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: 'custom01',
        kind: 'code',
        title: 'Custom panel',
        place: { x: 6, y: 0, w: 6, h: 4 },
        html: '<button id="change">Change record</button><button id="open">Open record</button><output id="result"></output>',
        css: '',
        javascript: [
          'document.body.dataset.ready = "true"',
          `const blockId = ${JSON.stringify(recordsId)}`,
          `const recordId = ${JSON.stringify(table.records[0])}`,
          `const values = ${JSON.stringify({ [table.fields.Name!]: 'After' })}`,
          'document.getElementById("change").onclick = async () => {',
          '  try { await rio.change(blockId, recordId, values)',
          '    document.getElementById("result").textContent = "Saved"',
          '  } catch (error) { document.getElementById("result").textContent = error.message }',
          '}',
          'document.getElementById("open").onclick = () => rio.open(blockId, recordId)',
        ].join('\n'),
      },
    ],
  };
  await runCommands(page, database.id, [
    { kind: 'interface.create', interface: { id, name: 'Desk', pages: [value] } },
  ]);
  const href = `${base()}/${database.id}/interfaces/${id}/${value.id}`;
  await page.goto(href);
  await expect(page.frameLocator('iframe[title="Custom panel"]').locator('body')).toHaveAttribute(
    'data-ready',
    'true',
  );
  return { database, table, id, value, href };
}

test('the frame executes under the strict app policy but cannot read ambient authority or fetch', async ({
  page,
}) => {
  await setup(page);
  const pagesBefore = page.context().pages().length;
  const frame = page.frames().find((item) => item.url().includes('/api/interfaces/code-frame'))!;
  const result = await frame.evaluate(async () => {
    const denied = (read: () => unknown) => {
      try {
        read();
        return false;
      } catch {
        return true;
      }
    };
    return {
      cookies: denied(() => document.cookie),
      storage: denied(() => localStorage.length),
      session: denied(() => sessionStorage.length),
      parent: denied(() => parent.document.body),
      fetch: await fetch('/api/auth/session').then(
        () => false,
        () => true,
      ),
      popup: (() => {
        try {
          return window.open('about:blank') === null;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'InvalidAccessError') return true;
          throw error;
        }
      })(),
    };
  });
  expect(result).toEqual({
    cookies: true,
    storage: true,
    session: true,
    parent: true,
    fetch: true,
    popup: true,
  });
  expect(page.context().pages()).toHaveLength(pagesBefore);
  await expect(page.locator('iframe[title="Custom panel"]')).toHaveAttribute('sandbox', 'allow-scripts');
});

test('ignores initialization from another window before accepting its opaque code frame', async ({
  page,
}) => {
  let spoofed = false;
  await page.route('**/api/interfaces/code-frame', async (route) => {
    await page.evaluate(() => {
      // A matching origin string cannot substitute for the expected frame window.
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: 'null',
          data: { type: 'interface-code-ready' },
        }),
      );
    });
    spoofed = true;
    await route.continue();
  });
  const value = await setup(page);
  expect(spoofed).toBe(true);
  const panel = page.frameLocator('iframe[title="Custom panel"]');
  await panel.getByRole('button', { name: 'Open record' }).click();
  await expect(page).toHaveURL(new RegExp(`record=${value.table.records[0]}`));
  await expect(page.getByRole('dialog', { name: 'Record details', exact: true })).toBeVisible();
});

test('reader records cannot leave through TURN or STUN from the frame or fresh realms', async ({
  page,
  context,
  browserName,
}) => {
  const capture = await captureIce();
  const control = await context.newPage();
  const credential = randomBytes(24).toString('hex');
  const username = randomBytes(24).toString('hex');
  try {
    // Firefox can suppress loopback ICE traffic, so its control proves the API is available.
    // The frame probe below must deny construction and candidate gathering in every browser.
    expect(
      await control.evaluate(async () => {
        const peer = new RTCPeerConnection();
        try {
          peer.createDataChannel('control');
          return (await peer.createOffer()).type;
        } finally {
          peer.close();
        }
      }),
    ).toBe('offer');
    if (browserName !== 'firefox') {
      // The other engines also prove that the listener receives both protocols on this machine.
      await control.evaluate(
        async ({ urls, username, credential }) => {
          const peer = new RTCPeerConnection({ iceServers: [{ urls, username, credential }] });
          peer.createDataChannel(username);
          await peer.setLocalDescription(await peer.createOffer());
        },
        { urls: capture.urls, username, credential },
      );
      await expect.poll(() => capture.usernames).toContain(username);
      await expect.poll(() => capture.packets.some((packet) => packet.readUInt16BE(0) === 0x0001)).toBe(true);
    }
    await control.close();
    capture.packets.length = 0;
    capture.usernames.length = 0;

    const value = await setup(page);
    await page.evaluate(() => {
      window.addEventListener('message', (event) => {
        const frame = document.querySelector('iframe[title="Custom panel"]') as HTMLIFrameElement;
        if (event.source === frame.contentWindow && event.data?.type === 'interface-code-probed') {
          document.body.dataset.codeProbe = event.data.value;
          document.body.dataset.codeActivity = JSON.stringify(event.data.activity);
        }
      });
    });
    const blocks = value.value.blocks.map((block) =>
      block.kind === 'code'
        ? { ...block, javascript: iceProbe(capture.urls, value.table.fields.Name!, credential) }
        : block,
    );
    await runCommands(page, value.database.id, [
      {
        kind: 'interface.update',
        interfaceId: value.id,
        pages: [{ ...value.value, blocks }],
      },
    ]);
    await expect(page.locator('body')).toHaveAttribute('data-code-probe', 'Before');
    expect(JSON.parse((await page.locator('body').getAttribute('data-code-activity'))!)).toEqual({
      attempts: 21,
      connections: 0,
      gathering: 0,
      candidates: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(capture.usernames).toEqual([]);
    expect(capture.packets).toHaveLength(0);
  } finally {
    if (!control.isClosed()) await control.close();
    await capture.close();
  }
});

test('renaming and moving a code block preserves unsaved input and script state', async ({ page }) => {
  const value = await setup(page);
  const frame = page.frames().find((item) => item.url().includes('/api/interfaces/code-frame'))!;
  await frame.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'draft';
    document.body.append(input);
    Object.defineProperty(window, 'draftState', { value: { count: 7 } });
  });
  await frame.locator('#draft').fill('Unsaved draft');
  await page.getByRole('button', { name: 'Edit interface', exact: true }).click();
  const code = value.value.blocks.find((block) => block.kind === 'code')!;
  for (const next of [
    { ...code, title: 'Renamed panel' },
    { ...code, title: 'Renamed panel', place: { ...code.place, y: 4 } },
  ]) {
    await page.getByRole('button', { name: 'Edit page JSON', exact: true }).click();
    await page.getByRole('textbox', { name: 'Page JSON', exact: true }).fill(
      JSON.stringify({
        ...value.value,
        blocks: value.value.blocks.map((block) => (block.id === code.id ? next : block)),
      }),
    );
    await page.getByRole('button', { name: 'Save page', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const current = page.frames().find((item) => item.url().includes('/api/interfaces/code-frame'))!;
    expect(current).toBe(frame);
    await expect(current.locator('#draft')).toHaveValue('Unsaved draft');
    expect(await current.evaluate(() => Reflect.get(window, 'draftState'))).toEqual({ count: 7 });
  }
});

for (const width of [390, 1280]) {
  test(`code editing and page JSON work at width ${width} with deep links and undo`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const setupValue = await setup(page);
    await page.goto(`${setupValue.href}?editor=custom01`);
    const html = page.getByRole('textbox', { name: 'HTML', exact: true });
    await expect(html).toBeVisible();
    await html.fill('<main>Updated preview</main>');
    await expect(page.frameLocator('iframe[title="Live preview"]').getByRole('main')).toHaveText(
      'Updated preview',
    );
    await html.press('Escape');
    await html.press('Tab');
    await expect(html).not.toBeFocused();
    await page.getByRole('button', { name: 'Save block', exact: true }).click();
    await expect(page.frameLocator('iframe[title="Custom panel"]').getByRole('main')).toHaveText(
      'Updated preview',
    );
    await page.goto(`${setupValue.href}?editor=json`);
    const json = page.getByRole('textbox', { name: 'Page JSON', exact: true });
    const before = JSON.parse(await json.inputValue()) as typeof setupValue.value;
    await json.fill('{');
    await expect(page.getByRole('alert').filter({ hasText: 'Check the JSON' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
    await json.fill(JSON.stringify({ ...before, name: 'Updated page' }));
    await page.getByRole('button', { name: 'Save page' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: 'Edit interface', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => {
        const schema = await asOwner<{ interfaces: Array<{ id: string; pages: Array<{ name: string }> }> }>(
          page,
          'GET',
          `/api/databases/${setupValue.database.id}/schema`,
        );
        return schema.interfaces.find((item) => item.id === setupValue.id)?.pages[0]?.name;
      })
      .toBe(before.name);
  });
}

test('record proposals require approval and respect the reader role and field permissions', async ({
  page,
  browser,
}) => {
  const value = await setup(page);
  const panel = page.frameLocator('iframe[title="Custom panel"]');
  await panel.getByRole('button', { name: 'Open record' }).click();
  await expect(page).toHaveURL(new RegExp(`record=${value.table.records[0]}`));
  await expect(page.getByRole('dialog', { name: 'Record details', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close record', exact: true }).click();
  await panel.getByRole('button', { name: 'Change record' }).click();
  const review = page.getByRole('dialog', { name: 'Review record change' });
  await expect(review).toBeVisible();
  const readName = async () =>
    (
      await asOwner<{ values: Record<string, unknown> }>(
        page,
        'GET',
        `/api/tables/${value.table.id}/records/${value.table.records[0]}`,
      )
    ).values[value.table.fields.Name!];
  expect(await readName()).toBe('Before');
  await review.getByRole('button', { name: 'Apply record change' }).click();
  await expect(panel.locator('output')).toHaveText('Saved');
  expect(await readName()).toBe('After');
  const person = await invite(page, browser, 'Robin Wells');
  try {
    await share(page, value.database.id, person, 'reader');
    await person.page.goto(`${value.href}?editor=json`);
    await expect(person.page.getByRole('textbox', { name: 'Page JSON' })).toBeHidden();
    const readerPanel = person.page.frameLocator('iframe[title="Custom panel"]');
    await readerPanel.getByRole('button', { name: 'Change record' }).click();
    await expect(readerPanel.locator('output')).toHaveText('errors.forbidden');
    await expect(person.page.getByRole('dialog')).toBeHidden();
    await share(page, value.database.id, person, 'editor');
    await runCommands(page, value.database.id, [
      {
        kind: 'record.update',
        tableId: value.table.id,
        records: [{ id: value.table.records[0], values: { [value.table.fields.Name!]: 'Before' } }],
      },
    ]);
    await asOwner(page, 'PUT', `/api/fields/${value.table.fields.Name}/permissions`, {
      restricted: null,
      locked: { roles: [], users: [] },
    });
    await person.page.reload();
    await readerPanel.getByRole('button', { name: 'Change record' }).click();
    await person.page.getByRole('button', { name: 'Apply record change' }).click();
    await expect(
      person.page.getByRole('dialog', { name: 'Review record change' }).getByRole('alert'),
    ).toBeVisible();
    expect(await readName()).toBe('Before');
  } finally {
    await person.context.close();
  }
});
