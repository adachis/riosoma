import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackCreate, newId } from '@riosoma/contracts';
import { failure, json, renderSharing } from '../../screens/database/share/testing';
import type * as Capture from './capture';
import { clearClientErrors, recordClientError } from './errors';
import { FeedbackDialog } from './FeedbackDialog';

const shots = vi.hoisted(() => ({ next: 'data:image/png;base64,iVBORw0KGgo=' as string | null }));
vi.mock('./capture', async (original) => ({
  ...(await original<typeof Capture>()),
  captureScreenshot: vi.fn(async () => shots.next),
}));

const databaseId = newId('database');
const tableId = newId('table');
const viewId = newId('view');
const recordId = newId('record');

function start(options: { refuse?: Response } = {}) {
  const sent: FeedbackCreate[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/config') return json({ map: { styleUrl: null }, version: '9.9.9' });
    if (url === '/api/feedback' && init?.method === 'POST') {
      sent.push(FeedbackCreate.parse(JSON.parse(String(init.body))));
      return options.refuse ?? json({ id: newId('feedback') });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  renderSharing(<FeedbackDialog isOpen onClose={onClose} />);
  return { sent, onClose };
}

/** The context exactly as the dialog shows it: each row's label and its value. */
function shownContext(): Record<string, string> {
  const rows = document.querySelectorAll('.rio-feedback-context__row');
  return Object.fromEntries(
    Array.from(rows).map((row) => [row.getAttribute('data-field')!, row.querySelector('dd')!.textContent!]),
  );
}

beforeEach(() => {
  window.history.pushState({}, '', `/${databaseId}/${tableId}/${viewId}/${recordId}?q=Ada`);
  shots.next = 'data:image/png;base64,iVBORw0KGgo=';
});

afterEach(() => {
  cleanup();
  clearClientErrors();
  window.history.pushState({}, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FeedbackDialog', () => {
  it('shows the sender the context it sends, word for word, without the record', async () => {
    recordClientError(new TypeError('cannot read the grid'));
    const { sent, onClose } = start();
    const dialog = await screen.findByRole('dialog', { name: 'Send feedback' });
    await waitFor(() => expect(shownContext().appVersion).toBe('9.9.9'));
    const shown = shownContext();
    expect(shown.path).toBe(`/${databaseId}/${tableId}/${viewId}/:record`);
    expect(dialog.textContent).not.toContain(recordId);
    expect(dialog.textContent).not.toContain('Ada');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Show the errors' }));
    const errors = within(dialog).getByRole('list').textContent;

    await userEvent.click(within(dialog).getByRole('radio', { name: 'An idea' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Your message/ }), 'Let me pin a view');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(sent).toHaveLength(1);
    const [body] = sent;
    expect(body!.kind).toBe('idea');
    expect(body!.message).toBe('Let me pin a view');
    expect(body!.screenshot).toBeUndefined();
    const { errors: sentErrors, ...fields } = body!.context;
    const unknown = 'Not known';
    expect(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value || unknown]))).toEqual(
      Object.fromEntries(Object.entries(shown).filter(([key]) => key !== 'errors')),
    );
    expect(shown.errors).toBe('1 error on this page');
    expect(sentErrors).toHaveLength(1);
    expect(errors).toBe(`${sentErrors[0]!.message}\n${sentErrors[0]!.stack ?? ''}`.trimEnd());
  });

  it('shows the masked screenshot before it goes, and lets it be removed or sent', async () => {
    const { sent } = start();
    const dialog = await screen.findByRole('dialog', { name: 'Send feedback' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add a screenshot of this page' }));
    const shot = await within(dialog).findByRole('img', { name: 'This page, with every value blurred out' });
    expect(shot.getAttribute('src')).toBe(shots.next);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove the screenshot' }));
    expect(within(dialog).queryByRole('img', { name: /blurred out/ })).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Add a screenshot of this page' }));
    await within(dialog).findByRole('img', { name: /blurred out/ });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Your message/ }), 'The grid froze');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.screenshot).toBe(shots.next);
    expect(sent[0]!.kind).toBe('broken');
  });

  it('offers an image of the person’s own when the browser can’t take one', async () => {
    shots.next = null;
    start();
    const dialog = await screen.findByRole('dialog', { name: 'Send feedback' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add a screenshot of this page' }));
    expect(await within(dialog).findByText(/This browser couldn’t take the screenshot/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Choose an image instead' })).toBeDefined();
  });

  it('asks for a message first, and says when the hourly limit is reached', async () => {
    const { sent } = start({
      refuse: failure('feedback.rateLimited', 429),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Send feedback' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    expect(await within(dialog).findByText('Write a few words first.')).toBeDefined();
    expect(sent).toHaveLength(0);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Your message/ }), 'Hello');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send feedback' }));
    expect(await within(dialog).findByText(/You’ve sent a lot of feedback this hour/)).toBeDefined();
  });
});
