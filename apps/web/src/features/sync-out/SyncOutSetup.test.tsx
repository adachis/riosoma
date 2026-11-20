import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncOutAction } from '@riosoma/contracts';
import { renderSharing } from '../../screens/database/share/testing';
import { SyncOutDialog } from './SyncOutDialog';
import { DATABASE_ID, VIEW_ID, mockSyncOut, previewFixture, type MockOptions } from './testing';

function start(options: MockOptions = {}) {
  const server = mockSyncOut(options);
  vi.stubGlobal('fetch', vi.fn(server.handle));
  const onClose = vi.fn();
  renderSharing(
    <SyncOutDialog viewId={VIEW_ID} viewName="Launches" databaseId={DATABASE_ID} onClose={onClose} />,
  );
  return { ...server, onClose };
}

async function openSetup(options: MockOptions = {}) {
  const server = start(options);
  await userEvent.click(await screen.findByRole('button', { name: 'Set up a sync' }));
  return server;
}

const token = () => screen.getByLabelText('Airtable personal access token');
const continueButton = () => screen.getByRole('button', { name: 'Continue' });

/** Step 1 to a base chosen on step 2, the shared start of most setup paths. */
async function toTablePicked() {
  await userEvent.click(continueButton());
  await userEvent.type(token(), 'patTESTTESTTEST');
  await userEvent.click(screen.getByRole('button', { name: 'Find bases' }));
  await userEvent.click(await screen.findByRole('option', { name: /Product/ }));
}

function actions(sent: { url: string; body: unknown }[]): SyncOutAction[] {
  return sent
    .filter((request) => request.url.endsWith('/sync-out/commands'))
    .map((request) => (request.body as { action: SyncOutAction }).action);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SyncOutSetup', () => {
  it('walks the four steps and creates a sync', async () => {
    const { sent } = await openSetup();
    expect(screen.getByText('Step 1 of 4')).toBeDefined();
    expect(screen.getByRole('radio', { name: /Airtable/ })).toHaveProperty('checked', true);

    await toTablePicked();
    expect((screen.getByRole('textbox', { name: 'Table name' }) as HTMLInputElement).value).toBe('Launches');
    await userEvent.click(continueButton());

    // Step 3 checks the columns, with a skipped field showing why it isn't sent.
    expect(await screen.findByText('Riosoma will create these columns, in the view’s order.')).toBeDefined();
    const columns = screen.getByRole('list');
    expect(columns.textContent).toContain('Name');
    expect(columns.textContent).toContain('Single select');
    expect(columns.textContent).toContain('That column can’t be written');
    await userEvent.click(continueButton());

    // Step 4 starts the sync with the default name.
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
      'Launches to Airtable',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Start syncing' }));

    await waitFor(() => expect(actions(sent).some((action) => action.kind === 'create')).toBe(true));
    const create = actions(sent).find((action) => action.kind === 'create')!;
    expect(create.kind === 'create' && create.input.name).toBe('Launches to Airtable');
    expect(create.kind === 'create' && create.input.destination.table).toMatchObject({
      mode: 'new',
      name: 'Launches',
    });
    expect(await screen.findByText('Waiting to start…')).toBeDefined();
  });

  it('asks for a token, a lookup, a base, and a name before it continues', async () => {
    await openSetup();
    await userEvent.click(continueButton());
    // No token.
    await userEvent.click(continueButton());
    expect(screen.getByText('Paste a token.')).toBeDefined();
    // A token, but Find bases hasn't run.
    await userEvent.type(token(), 'patTESTTESTTEST');
    await userEvent.click(continueButton());
    expect(screen.getByText('Choose Find bases first.')).toBeDefined();
    // Bases found, none chosen.
    await userEvent.click(screen.getByRole('button', { name: 'Find bases' }));
    await screen.findByRole('option', { name: /Product/ });
    await userEvent.click(continueButton());
    expect(screen.getByText('Choose a base.')).toBeDefined();
    // A base chosen, but the name is cleared.
    await userEvent.click(screen.getByRole('option', { name: /Product/ }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Table name' }));
    await userEvent.click(continueButton());
    expect(screen.getByText('Name the new table.')).toBeDefined();
  });

  it('shows the token field’s own error when Airtable refuses it', async () => {
    await openSetup({
      placesError: {
        status: 400,
        messageKey: 'syncOut.airtable.tokenRefused',
        fields: { token: 'syncOut.airtable.tokenRefused' },
      },
    });
    await userEvent.click(continueButton());
    await userEvent.type(token(), 'patBADTOKENBADTO');
    await userEvent.click(screen.getByRole('button', { name: 'Find bases' }));
    expect(await screen.findByText(/Airtable didn.t accept this token/)).toBeDefined();
  });

  it('shows a Try again banner when finding bases fails another way', async () => {
    await openSetup({
      placesError: { status: 503, code: 'unavailable', messageKey: 'syncOut.destination.unavailable' },
    });
    await userEvent.click(continueButton());
    await userEvent.type(token(), 'patTESTTESTTEST');
    await userEvent.click(screen.getByRole('button', { name: 'Find bases' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The destination isn’t answering right now.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('shows a Try again banner and blocks Continue when the preview fails', async () => {
    await openSetup({ previewError: { status: 500, code: 'internal', messageKey: 'errors.internal' } });
    await toTablePicked();
    await userEvent.click(continueButton());
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(continueButton()).toHaveProperty('disabled', true);
  });

  it('blocks Continue and lists a preview problem', async () => {
    await openSetup({
      preview: previewFixture({
        problems: [{ messageKey: 'syncOut.airtable.rows', params: { count: 90000, limit: 50000 } }],
      }),
    });
    await toTablePicked();
    await userEvent.click(continueButton());
    expect(await screen.findByText(/This view shows 90,?000 rows\./)).toBeDefined();
    expect(continueButton()).toHaveProperty('disabled', true);
  });

  it('keeps setup open on an outside press, so a pasted token is never lost', async () => {
    const { onClose } = await openSetup();
    await userEvent.click(continueButton());
    await userEvent.type(token(), 'patTESTTESTTEST');
    const overlay = document.querySelector('.rio-modal-overlay');
    if (overlay) await userEvent.click(overlay);
    expect(screen.getByText('Step 2 of 4')).toBeDefined();
    expect((token() as HTMLInputElement).value).toBe('patTESTTESTTEST');
    expect(onClose).not.toHaveBeenCalled();
  });
});
