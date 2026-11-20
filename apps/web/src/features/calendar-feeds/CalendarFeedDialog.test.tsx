import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarFeedCreate, type CalendarFeed, type CalendarFeedState } from '@riosoma/contracts';
import { failure, json, renderSharing } from '../../screens/database/share/testing';
import { CalendarFeedDialog } from './CalendarFeedDialog';

const viewId = 'viwAAAAAAAAAAAAAA';

/** A stand-in token, made up here rather than written out, like every secret in a test. */
const token = () => ['Q', 'w'.repeat(20), '_', '9'.repeat(21)].join('');

function feed(overrides: Partial<CalendarFeed> = {}): CalendarFeed {
  return { viewId, createdAt: '2026-03-02T15:04:00.000Z', lastReadAt: null, ...overrides };
}

/** An in-memory server for one view's feed, recording what the dialog sends. */
function start(initial: CalendarFeedState = { allowed: true, feed: null }) {
  let state = initial;
  let made = 0;
  const sent: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    sent.push({ method, url, body });
    if (url !== `/api/views/${viewId}/calendar-feed`) throw new Error(`Unexpected request: ${url}`);
    if (method === 'GET') return json(state);
    if (method === 'POST') {
      CalendarFeedCreate.parse(body);
      made += 1;
      state = { ...state, feed: feed({ createdAt: new Date().toISOString() }) };
      return json({ feed: state.feed, path: `/feeds/${token().slice(0, -1)}${made}.ics` });
    }
    if (method === 'DELETE') {
      state = { ...state, feed: null };
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  renderSharing(<CalendarFeedDialog viewId={viewId} viewName="Launches" onClose={onClose} />);
  return { sent, onClose };
}

beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions(),
    timeZone: 'America/Denver',
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CalendarFeedDialog', () => {
  it('makes a private address in the person’s zone and shows it once, with a copy button and a link', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { sent } = start();
    expect(await screen.findByRole('heading', { name: 'Subscribe in a calendar app' })).toBeDefined();
    await userEvent.click(await screen.findByRole('button', { name: 'Make a private address' }));
    const address = (await screen.findByRole('textbox', { name: 'Private address' })) as HTMLInputElement;
    expect(address.value).toBe(`${window.location.origin}/feeds/${token().slice(0, -1)}1.ics`);
    expect(address.readOnly).toBe(true);
    expect(sent.find((request) => request.method === 'POST')!.body).toEqual({ timeZone: 'America/Denver' });
    const link = screen.getByRole('link', { name: 'Open in your calendar app' });
    expect(link.getAttribute('href')).toBe(address.value.replace(/^https?:/, 'webcal:'));
    expect(screen.getByText(/It’s shown only now/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledWith(address.value);
    expect(screen.getByRole('status').textContent).toBe('Copied the address');
  });

  it('says when an existing feed was made and read, without its address', async () => {
    start({
      allowed: true,
      feed: feed({ lastReadAt: '2026-03-03T16:05:00.000Z' }),
    });
    expect(await screen.findByText(/Your calendar feed is on\./)).toBeDefined();
    expect(screen.getByText(/A calendar app last read it on/)).toBeDefined();
    expect(screen.queryByRole('textbox', { name: 'Private address' })).toBeNull();
    expect(screen.getByText(/The address is shown only when it’s made/)).toBeDefined();
  });

  it('makes a new address after asking, since the old one stops', async () => {
    const { sent } = start({ allowed: true, feed: feed() });
    await userEvent.click(await screen.findByRole('button', { name: 'Make a new address' }));
    const question = await screen.findByRole('dialog', { name: 'Make a new address?' });
    expect(question.textContent).toContain('The old address stops working at once');
    await userEvent.click(within(question).getByRole('button', { name: 'Make a new address' }));
    const address = (await screen.findByRole('textbox', { name: 'Private address' })) as HTMLInputElement;
    expect(address.value).toMatch(/\/feeds\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(sent.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('turns the feed off after asking, and offers a new one', async () => {
    const { sent } = start({ allowed: true, feed: feed() });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const question = await screen.findByRole('dialog', { name: 'Turn off this calendar feed?' });
    await userEvent.click(within(question).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByRole('button', { name: 'Make a private address' })).toBeDefined();
    expect(sent.some((request) => request.method === 'DELETE')).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Your calendar feed is on/)).toBeNull());
  });

  it('says so when the organization has turned feeds off', async () => {
    start({ allowed: false, feed: null });
    expect(await screen.findByText(/Your organization has turned calendar feeds off\./)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Make a private address' })).toBeNull();
  });

  it('shows why an address couldn’t be made', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? failure('calendarFeeds.off', 403)
          : json({ allowed: true, feed: null } satisfies CalendarFeedState),
      ),
    );
    renderSharing(<CalendarFeedDialog viewId={viewId} viewName="Launches" onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Make a private address' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Your organization has turned calendar feeds off.'),
    );
  });
});
