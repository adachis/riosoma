import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebhookCreate,
  WebhookUpdate,
  newId,
  type TableMeta,
  type WebhookCreated,
  type WebhookDelivery,
  type WebhookMeta,
} from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { failure, json, renderSharing } from '../share/testing';
import { webhooksKey } from './api';
import { DatabaseSettingsMenu, WebhooksDialog } from './WebhooksDialog';

const DATABASE = newId('database');
const BASE = `/api/databases/${DATABASE}/webhooks`;
// Placeholders, not real secrets.
const SHOWN_ONCE = 'rio_whsec_example_only';
const REPLACED = 'rio_whsec_replacement_only';

function table(name: string): TableMeta {
  return {
    id: newId('table'),
    databaseId: DATABASE,
    name,
    description: '',
    primaryFieldId: newId('field'),
    position: 0,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
  };
}
const tasks = table('Tasks');
const log = table('Log');

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
// Always in the future, since the dialog shows a next try only while it's still to come.
const nextTry = new Date(Date.now() + 2 * 3_600_000).toISOString();

function hook(overrides: Partial<WebhookMeta> = {}): WebhookMeta {
  return {
    id: newId('webhook'),
    databaseId: DATABASE,
    url: 'https://hooks.example.test/crm',
    events: ['record.created', 'record.updated'],
    tableIds: null,
    enabled: true,
    disabledReason: null,
    failingSince: null,
    lastSuccessAt: null,
    createdBy: 'usr_ada',
    createdAt: '2026-09-01T09:30:00.000Z',
    updatedAt: '2026-09-01T09:30:00.000Z',
    ...overrides,
  };
}

function delivery(webhookId: string, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: newId('delivery'),
    webhookId,
    state: 'succeeded',
    eventCount: 3,
    eventTypes: ['record.created', 'record.updated'],
    createdAt: ago(2),
    nextAttemptAt: null,
    attempts: [{ at: ago(2), status: 200, ms: 142, error: null, manual: false }],
    ...overrides,
  };
}

type Pages = Record<string, { deliveries: WebhookDelivery[]; next: string | null }>;

/** A server that keeps its webhooks in memory and answers the dialog's requests. */
function start(listed: WebhookMeta[] = [], pages: Pages = {}) {
  let webhooks = [...listed];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === BASE && method === 'GET') return json({ webhooks });
    if (url === BASE && method === 'POST') {
      const input = WebhookCreate.parse(body);
      const created: WebhookCreated = { ...hook({ ...input, id: newId('webhook') }), secret: SHOWN_ONCE };
      const { secret: _secret, ...meta } = created;
      webhooks = [...webhooks, meta];
      return json(created);
    }
    const match = /^\/api\/databases\/[^/]+\/webhooks\/([^/?]+)(.*)$/.exec(url);
    if (!match) throw new Error(`Unexpected request: ${method} ${url}`);
    const [, id, rest = ''] = match;
    if (rest === '' && method === 'PATCH') {
      const update = WebhookUpdate.parse(body);
      webhooks = webhooks.map((item) =>
        item.id === id
          ? {
              ...item,
              ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
              ...(update.enabled ? { disabledReason: null, failingSince: null } : {}),
            }
          : item,
      );
      return json(webhooks.find((item) => item.id === id));
    }
    if (rest === '' && method === 'DELETE') {
      webhooks = webhooks.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }
    if (rest === '/secret' && method === 'POST')
      return json({ secret: REPLACED, previousExpiresAt: '2026-09-29T09:00:00.000Z' });
    if (rest.startsWith('/deliveries') && method === 'GET') {
      const cursor = new URL(url, 'http://localhost').searchParams.get('cursor') ?? '';
      return json(pages[cursor] ?? { deliveries: [], next: null });
    }
    const again = /^\/deliveries\/([^/]+)\/redeliver$/.exec(rest);
    if (again && method === 'POST') {
      const found = Object.values(pages)
        .flatMap((page) => page.deliveries)
        .find((item) => item.id === again[1]);
      return json({ ...found, state: 'pending', nextAttemptAt: new Date().toISOString() });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  const rendered = renderSharing(
    <>
      <WebhooksDialog databaseId={DATABASE} tables={[tasks, log]} onClose={onClose} />
      <ToastRegion />
    </>,
  );
  return { fetcher, onClose, client: rendered.client };
}

type Fetcher = ReturnType<typeof start>['fetcher'];

/** The body of the one request made with a method to a path. */
function sent(fetcher: Fetcher, method: string, path: string): unknown {
  const calls = fetcher.mock.calls.filter(([url, options]) => url === path && options?.method === method);
  expect(calls, `${method} ${path}`).toHaveLength(1);
  const body = calls[0]?.[1]?.body;
  return body === undefined ? undefined : JSON.parse(String(body));
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, url: string) {
  await user.click(await screen.findByRole('button', { name: `More for ${url}` }));
  return screen.findByRole('menu', { name: `More for ${url}` });
}

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the webhooks page', () => {
  it('opens from the database settings menu', async () => {
    const onWebhooks = vi.fn();
    const user = userEvent.setup();
    renderSharing(<DatabaseSettingsMenu databaseId={DATABASE} onWebhooks={onWebhooks} />);
    await user.click(screen.getByRole('button', { name: 'Database settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Webhooks' }));
    expect(onWebhooks).toHaveBeenCalledOnce();
  });

  it('lists each webhook with its events, tables, and health', async () => {
    start([
      hook({ lastSuccessAt: ago(3) }),
      hook({
        url: 'https://hooks.example.test/billing',
        events: ['field.changed', 'table.changed'],
        tableIds: [tasks.id, log.id],
        enabled: false,
        disabledReason: 'webhooks.disabled.failing',
        failingSince: ago(30),
      }),
      hook({ url: 'https://hooks.example.test/audit', events: ['record.deleted'], failingSince: ago(2) }),
    ]);
    const dialog = await screen.findByRole('dialog', { name: 'Webhooks' });
    expect(dialog.textContent).toContain(
      'Webhooks tell other apps when something changes in this database.  Each call names what changed, not the values, so the app reads what it needs through the API.',
    );
    const [crm, billing, audit] = (await within(dialog).findAllByRole('listitem')) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    const toggle = (item: HTMLElement, name: string) =>
      within(item).getByRole('switch', { name }) as HTMLInputElement;

    expect(toggle(crm, 'https://hooks.example.test/crm').checked).toBe(true);
    expect(within(crm).getByText('Records created and Records updated')).toBeDefined();
    expect(within(crm).getByText('All tables')).toBeDefined();
    expect(within(crm).getByText('Last delivered 3 hours ago')).toBeDefined();

    expect(toggle(billing, 'https://hooks.example.test/billing').checked).toBe(false);
    expect(within(billing).getByText('Fields changed and Tables changed')).toBeDefined();
    expect(within(billing).getByText('Tasks and Log')).toBeDefined();
    expect(billing.textContent).toContain(
      'Turned off after 24 hours of failed deliveries.  Turn it back on once the receiver works.',
    );

    expect(within(audit).getByText('Records deleted')).toBeDefined();
    expect(within(audit).getByText('Deliveries started failing 2 hours ago')).toBeDefined();
  });

  it('adds a webhook and shows its secret once', async () => {
    const { fetcher, client } = start();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    await screen.findByText('No webhooks yet.');
    expect(screen.getAllByRole('button', { name: 'Add webhook' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add webhook' }));

    const form = await screen.findByRole('dialog', { name: 'Add a webhook' });
    await user.type(within(form).getByRole('textbox', { name: 'Address' }), 'https://hooks.example.test/new');
    // Record events start out chosen, and this one adds field changes and drops deletions.
    await user.click(within(form).getByRole('checkbox', { name: 'Fields changed' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Records deleted' }));
    await user.click(within(form).getByRole('radio', { name: 'Only these tables' }));
    const picker = within(form).getByRole('group', { name: 'Only these tables' });
    await user.click(within(picker).getByRole('checkbox', { name: 'Log' }));
    await user.click(within(form).getByRole('button', { name: 'Add webhook' }));

    const revealed = await screen.findByRole('dialog', { name: 'Copy the signing secret' });
    expect(sent(fetcher, 'POST', BASE)).toEqual({
      url: 'https://hooks.example.test/new',
      events: ['record.created', 'record.updated', 'field.changed'],
      tableIds: [log.id],
      enabled: true,
    });
    expect(revealed.textContent).toContain('Copy this secret now.  You won’t be able to see it again.');
    const field = within(revealed).getByRole('textbox', { name: 'Signing secret' }) as HTMLInputElement;
    expect(field.value).toBe(SHOWN_ONCE);
    expect(field.hasAttribute('readonly')).toBe(true);
    await user.click(within(revealed).getByRole('button', { name: 'Copy' }));
    await screen.findByText('Copied the secret');
    expect(writeText).toHaveBeenCalledWith(SHOWN_ONCE);

    await user.click(within(revealed).getByRole('button', { name: 'Done' }));
    const list = await screen.findByRole('dialog', { name: 'Webhooks' });
    expect(within(list).getByRole('switch', { name: 'https://hooks.example.test/new' })).toBeDefined();
    expect(within(list).queryByText(SHOWN_ONCE)).toBeNull();
    expect(JSON.stringify(client.getQueryData(webhooksKey(DATABASE)))).not.toContain(SHOWN_ONCE);
  });

  it('names what’s missing instead of posting it, and shows what the server refuses', async () => {
    const { fetcher } = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add webhook' }));
    const form = await screen.findByRole('dialog', { name: 'Add a webhook' });
    const address = within(form).getByRole('textbox', { name: 'Address' });
    await user.type(address, 'hooks.example.test');
    for (const name of ['Records created', 'Records updated', 'Records deleted'])
      await user.click(within(form).getByRole('checkbox', { name }));
    await user.click(within(form).getByRole('radio', { name: 'Only these tables' }));
    await user.click(within(form).getByRole('button', { name: 'Add webhook' }));
    expect(within(form).getByText('Enter a full web address, like https://example.com/hooks.')).toBeDefined();
    expect(within(form).getByText('Choose at least one event.')).toBeDefined();
    expect(within(form).getByText('Choose at least one table.')).toBeDefined();

    await user.clear(address);
    await user.type(address, 'https://user:pass@hooks.example.test/in');
    await user.click(within(form).getByRole('button', { name: 'Add webhook' }));
    expect(within(form).getByText('Leave the user name and password out of the address.')).toBeDefined();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);

    await user.clear(address);
    await user.type(address, 'http://hooks.example.test/in');
    await user.click(within(form).getByRole('checkbox', { name: 'Records deleted' }));
    await user.click(within(form).getByRole('radio', { name: 'All tables, including new ones' }));
    fetcher.mockResolvedValueOnce(failure('webhooks.url.https', 422));
    await user.click(within(form).getByRole('button', { name: 'Add webhook' }));
    expect((await within(form).findByRole('alert')).textContent).toContain(
      'Use an address that starts with https://.',
    );
    expect((address as HTMLInputElement).value).toBe('http://hooks.example.test/in');
  });

  it('turns a webhook off and on', async () => {
    const webhook = hook({ enabled: false, disabledReason: 'webhooks.disabled.failing' });
    const { fetcher } = start([webhook]);
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: webhook.url });
    await user.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    expect(sent(fetcher, 'PATCH', `${BASE}/${webhook.id}`)).toEqual({ enabled: true });
    expect(screen.queryByText(/Turned off after 24 hours/)).toBeNull();
  });

  it('changes a webhook’s address, events, and tables', async () => {
    const webhook = hook({ tableIds: [tasks.id] });
    const { fetcher } = start([webhook]);
    const user = userEvent.setup();
    const menu = await openMenu(user, webhook.url);
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    const form = await screen.findByRole('dialog', { name: 'Edit webhook' });
    const address = within(form).getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
    expect(address.value).toBe(webhook.url);
    expect(
      (within(form).getByRole('checkbox', { name: 'Records updated' }) as HTMLInputElement).checked,
    ).toBe(true);
    const picker = within(form).getByRole('group', { name: 'Only these tables' });
    expect((within(picker).getByRole('checkbox', { name: 'Tasks' }) as HTMLInputElement).checked).toBe(true);
    await user.clear(address);
    await user.type(address, 'https://hooks.example.test/crm-v2');
    await user.click(within(form).getByRole('checkbox', { name: 'Tables changed' }));
    await user.click(within(form).getByRole('radio', { name: 'All tables, including new ones' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByRole('dialog', { name: 'Webhooks' });
    expect(sent(fetcher, 'PATCH', `${BASE}/${webhook.id}`)).toEqual({
      url: 'https://hooks.example.test/crm-v2',
      events: ['record.created', 'record.updated', 'table.changed'],
      tableIds: null,
    });
    expect(screen.getByRole('switch', { name: 'https://hooks.example.test/crm-v2' })).toBeDefined();
  });

  it('makes a new secret only after asking', async () => {
    const webhook = hook();
    const { fetcher } = start([webhook]);
    const user = userEvent.setup();
    let menu = await openMenu(user, webhook.url);
    await user.click(within(menu).getByRole('menuitem', { name: 'New secret' }));
    let ask = await screen.findByRole('dialog', { name: 'Make a new secret?' });
    expect(ask.textContent).toContain(
      'The current secret keeps working for 24 hours, so you have time to update the receiver.',
    );
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Make a new secret?' })).toBeNull());
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/secret'))).toBe(false);

    menu = await openMenu(user, webhook.url);
    await user.click(within(menu).getByRole('menuitem', { name: 'New secret' }));
    ask = await screen.findByRole('dialog', { name: 'Make a new secret?' });
    await user.click(within(ask).getByRole('button', { name: 'Make new secret' }));
    const revealed = await screen.findByRole('dialog', { name: 'Copy the signing secret' });
    expect(
      (within(revealed).getByRole('textbox', { name: 'Signing secret' }) as HTMLInputElement).value,
    ).toBe(REPLACED);
    const until = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-09-29T09:00:00.000Z'),
    );
    expect(revealed.textContent).toContain(
      `Calls are signed with the old secret too until ${until}, so you can update the receiver first.`,
    );
    expect(sent(fetcher, 'POST', `${BASE}/${webhook.id}/secret`)).toBeUndefined();
  });

  it('deletes only after confirming', async () => {
    const webhook = hook();
    const { fetcher } = start([webhook]);
    const user = userEvent.setup();
    const menu = await openMenu(user, webhook.url);
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete this webhook?' });
    expect(ask.textContent).toContain(`Riosoma stops sending to ${webhook.url} at once.`);
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    await user.click(within(ask).getByRole('button', { name: 'Delete' }));
    await screen.findByText('No webhooks yet.');
    expect(sent(fetcher, 'DELETE', `${BASE}/${webhook.id}`)).toBeUndefined();
  });

  it('shows recent deliveries with status and timing, and sends one again', async () => {
    const webhook = hook();
    const delivered = delivery(webhook.id);
    const retrying = delivery(webhook.id, {
      state: 'pending',
      eventCount: 1,
      eventTypes: ['record.updated'],
      createdAt: ago(1),
      nextAttemptAt: nextTry,
      attempts: [
        { at: ago(0.5), status: 503, ms: 88, error: null, manual: false },
        { at: ago(1), status: null, ms: 10_000, error: 'webhooks.delivery.timeout', manual: false },
      ],
    });
    const failed = delivery(webhook.id, {
      state: 'failed',
      eventCount: 1,
      createdAt: ago(5),
      attempts: [{ at: ago(5), status: 410, ms: 51, error: null, manual: true }],
    });
    const older = delivery(webhook.id, {
      state: 'pending',
      createdAt: ago(30),
      nextAttemptAt: null,
      attempts: [{ at: ago(30), status: 500, ms: 12, error: null, manual: false }],
    });
    const { fetcher } = start([webhook], {
      '': { deliveries: [retrying, delivered, failed], next: 'page-2' },
      'page-2': { deliveries: [older], next: null },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deliveries' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deliveries' });
    expect(within(dialog).getByText(webhook.url)).toBeDefined();
    // Each delivery is an item of the outer list, and its attempts are a list of their own.
    const deliveries = () => [...dialog.querySelectorAll<HTMLElement>('li.rio-webhooks__delivery')];
    expect(deliveries()).toHaveLength(3);
    const [first, second, third] = deliveries() as [HTMLElement, HTMLElement, HTMLElement];

    expect(first.textContent).toContain('Retrying');
    expect(first.textContent).toContain('1 event');
    expect(first.textContent).toContain('Records updated');
    expect(first.textContent).toContain('HTTP 503');
    expect(first.textContent).toContain('88 ms');
    const next = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(nextTry),
    );
    expect(first.textContent).toContain(`Next try at ${next}`);
    await user.click(within(first).getByRole('button', { name: '2 attempts' }));
    expect(await within(first).findByText('No answer within 10 seconds')).toBeDefined();

    expect(second.textContent).toContain('Delivered');
    expect(second.textContent).toContain('3 events');
    expect(second.textContent).toContain('Records created and Records updated');
    expect(second.textContent).toContain('HTTP 200');
    expect(second.textContent).toContain('142 ms');
    expect(second.textContent).toContain('2 hours ago');

    expect(third.textContent).toContain('Failed');
    expect(third.textContent).toContain('HTTP 410');

    await user.click(within(third).getByRole('button', { name: 'Redeliver' }));
    await screen.findByText('Sending it again');
    expect(sent(fetcher, 'POST', `${BASE}/${webhook.id}/deliveries/${failed.id}/redeliver`)).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(deliveries()).toHaveLength(4));
    const held = deliveries()[3]!;
    expect(held.textContent).toContain('On hold');
    expect(held.textContent).toContain('Goes out once the webhook is back on');
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/deliveries?cursor=page-2'))).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'All webhooks' }));
    expect(await screen.findByRole('dialog', { name: 'Webhooks' })).toBeDefined();
  });

  it('says so when there are no deliveries yet', async () => {
    const webhook = hook();
    start([webhook]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Deliveries' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deliveries' });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        'No deliveries in the last 7 days.  Changes go out within a second or two.',
      ),
    );
  });

  it('shows a failed list in a banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failure('data.access.denied', 403)),
    );
    renderSharing(<WebhooksDialog databaseId={DATABASE} tables={[tasks]} onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'You don’t have access to do that in this database.',
    );
    expect(screen.queryByRole('button', { name: 'Add webhook' })).toBeNull();
  });
});
