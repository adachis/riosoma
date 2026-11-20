import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BookingPageInput,
  FieldSpec,
  type BookingPage,
  type FieldMeta,
  type TableBookingPages,
} from '@riosoma/contracts';
import { json, renderSharing } from '../../screens/database/share/testing';
import { celebrations, type Celebration } from '../celebrations/engine';
import { bookingPagesKey } from './api';
import { BookingPagesDialog } from './BookingPagesDialog';
import { startingSettings } from './BookingPageForm';
import { themes } from '../../preferences';

const tableId = 'tblAAAAAAAAAAAAAA';
const LIST = `/api/tables/${tableId}/booking-pages`;

let made = 0;
function field(name: string, spec: Record<string, unknown>): FieldMeta {
  made += 1;
  return {
    ...FieldSpec.parse(spec),
    id: `fld${String(made).padStart(14, '0')}`,
    tableId,
    name,
    description: '',
    position: made,
    createdAt: '',
    updatedAt: '',
  };
}

const name = field('Name', { type: 'text' });
const email = field('Email', { type: 'email' });
const when = field('When', { type: 'date', options: { includeTime: true } });
const notes = field('Notes', { type: 'longText' });
const fields = [name, email, when, notes];

function bookingPage(overrides: Partial<BookingPage> = {}): BookingPage {
  return {
    pageId: 'AbCdEfGhIjKlMnOpQrStUv',
    tableId,
    path: '/b/AbCdEfGhIjKlMnOpQrStUv',
    enabled: true,
    settings: { ...startingSettings(fields, 'Office hours'), timeZone: 'America/Denver' },
    owner: { id: 'usrADAADAADAADAAD', name: 'Ada' },
    upcoming: 3,
    problem: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function serve(list: TableBookingPages) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, url, body });
      if (url === LIST && method === 'GET') return json(list);
      // A page just made has no bookings yet.
      if (url === LIST && method === 'POST')
        return json(
          bookingPage({
            pageId: 'ZyXwVuTsRqPoNmLkJiHgFe',
            settings: (body as BookingPageInput).settings,
            upcoming: 0,
          }),
        );
      if (url.startsWith('/api/booking-pages/') && method === 'PUT')
        return json(bookingPage({ ...(body as BookingPageInput) }));
      if (url.startsWith('/api/booking-pages/') && method === 'DELETE')
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(list: TableBookingPages, tableFields = fields) {
  const requests = serve(list);
  const { client } = renderSharing(
    <BookingPagesDialog tableId={tableId} tableName="Appointments" fields={tableFields} onClose={() => {}} />,
  );
  return {
    requests,
    user: userEvent.setup(),
    /** Lists these pages from now on, as the server does once people book, and reads them again. */
    refetch: async (pages: BookingPage[]) => {
      list.pages = pages;
      await act(() => client.invalidateQueries({ queryKey: bookingPagesKey(tableId) }));
    },
  };
}

describe('BookingPagesDialog', () => {
  it('lists each page with its link, its upcoming bookings, who it books as, and what stops it', async () => {
    open({
      pages: [
        bookingPage(),
        bookingPage({
          pageId: 'QqQqQqQqQqQqQqQqQqQqQq',
          settings: { ...bookingPage().settings, title: 'Classes' },
          problem: 'bookings.problem.owner',
          upcoming: 0,
          enabled: false,
        }),
      ],
      emailAvailable: false,
    });
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('switch', { name: 'Office hours' })).toBeDefined();
    expect(within(items[0]!).getByRole('textbox', { name: 'Public link' })).toHaveProperty(
      'value',
      `${window.location.origin}/b/AbCdEfGhIjKlMnOpQrStUv`,
    );
    expect(items[0]!.textContent).toContain('3 upcoming bookings');
    expect(items[0]!.textContent).toContain('Bookings are added as Ada');
    expect(items[1]!.textContent).toContain('No upcoming bookings');
    expect(items[1]!.textContent).toContain('Whoever last saved it can’t add records to this table anymore.');
    expect(screen.getByText(/isn’t set up to send email yet/)).toBeDefined();
  });

  it('makes a page with the table’s fields already chosen', async () => {
    const { requests, user } = open({ pages: [], emailAvailable: true });
    await user.click(await screen.findByRole('button', { name: 'Make a booking page' }));
    await user.click(screen.getByRole('checkbox', { name: 'Ask for Notes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Require Notes' }));
    await user.click(screen.getByRole('button', { name: 'Make booking page' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'POST')).toBe(true));
    const sent = BookingPageInput.parse(requests.find((request) => request.method === 'POST')!.body);
    expect(sent).toMatchObject({
      enabled: true,
      settings: {
        title: 'Appointments',
        timeFieldId: when.id,
        nameFieldId: name.id,
        emailFieldId: email.id,
        resourceFieldId: null,
        questions: [{ fieldId: notes.id, required: true }],
      },
    });
    expect(sent.settings.hours.map((day) => day.length)).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(await screen.findByRole('switch', { name: 'Appointments' })).toBeDefined();
  });

  it('makes a page in a theme of its own, which shows over the database’s', async () => {
    const list = vi.spyOn(themes, 'list').mockResolvedValue([
      {
        id: 'kawaii',
        name: 'Kawaii',
        css: '',
        manifest: '',
        defaultScheme: 'peachy',
        schemeCount: 1,
        modes: [],
      },
    ]);
    const manifest = vi.spyOn(themes, 'manifest').mockResolvedValue({
      id: 'kawaii',
      name: 'Kawaii',
      css: '',
      defaultScheme: 'peachy',
      schemes: [{ id: 'peachy', name: 'Peachy', appearance: 'light' }],
      modes: [],
      defaultMode: null,
      surfaces: [],
    });
    const { requests, user } = open({ pages: [], emailAvailable: true });
    await user.click(await screen.findByRole('button', { name: 'Make a booking page' }));
    const theme = screen.getByRole('button', { name: /Page theme/ });
    expect(theme.textContent).toContain('Same as the database');
    await waitFor(() => expect(theme.hasAttribute('disabled')).toBe(false));
    await user.click(theme);
    await user.click(await screen.findByRole('option', { name: 'Kawaii' }));
    // Picking only changes the form, which saves with everything else.
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Make booking page' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'POST')).toBe(true));
    const sent = BookingPageInput.parse(requests.find((request) => request.method === 'POST')!.body);
    expect(sent.settings.theme).toEqual({ id: 'kawaii', scheme: 'peachy' });
    list.mockRestore();
    manifest.mockRestore();
  });

  it('says which fields a table needs before it can take bookings', async () => {
    const { user } = open({ pages: [], emailAvailable: true }, [name, when]);
    await user.click(await screen.findByRole('button', { name: 'Make a booking page' }));
    expect(
      screen.getByText(/needs a date field that includes a time, a text field for names, and an email field/),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Make booking page' })).toHaveProperty('disabled', true);
  });

  it('turns a page off, and deletes one after asking', async () => {
    const { requests, user } = open({ pages: [bookingPage()], emailAvailable: true });
    await user.click(await screen.findByRole('switch', { name: 'Office hours' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT')).toBe(true));
    expect(requests.find((request) => request.method === 'PUT')!.body).toMatchObject({ enabled: false });
    await user.click(screen.getByRole('button', { name: 'More for Office hours' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this booking page?' });
    expect(confirm.textContent).toContain('the cancel links it sent stop working');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE')).toBe(true));
  });

  it('gives the focus to the saved page’s link, since the form that had it is gone', async () => {
    const { user } = open({ pages: [], emailAvailable: true });
    await user.click(await screen.findByRole('button', { name: 'Make a booking page' }));
    await user.click(screen.getByRole('button', { name: 'Make booking page' }));
    const item = (await screen.findByRole('switch', { name: 'Appointments' })).closest('li')!;
    await waitFor(() =>
      expect(document.activeElement).toBe(within(item).getByRole('button', { name: 'Copy link' })),
    );
  });

  it('gives the focus back to where the form was opened from when it’s canceled', async () => {
    const { user } = open({ pages: [bookingPage()], emailAvailable: true });
    await user.click(await screen.findByRole('button', { name: 'More for Office hours' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More for Office hours' })),
    );
    await user.click(screen.getByRole('button', { name: 'Make a booking page' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Make a booking page' })),
    );
  });
});

describe('a booking page’s first booking', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    localStorage.clear();
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });

  const made = (upcoming: number) =>
    bookingPage({
      pageId: 'ZyXwVuTsRqPoNmLkJiHgFe',
      settings: { ...bookingPage().settings, title: 'Appointments' },
      upcoming,
    });

  it('celebrates once, from its count, when a page made here gets its first booking', async () => {
    const { user, refetch } = open({ pages: [], emailAvailable: true });
    await user.click(await screen.findByRole('button', { name: 'Make a booking page' }));
    await user.click(screen.getByRole('button', { name: 'Make booking page' }));
    await screen.findByRole('switch', { name: 'Appointments' });
    const item = screen.getByRole('listitem');
    expect(item.textContent).toContain('No upcoming bookings');
    expect(shown).toEqual([]);

    await refetch([made(1)]);
    await waitFor(() => expect(item.textContent).toContain('1 upcoming booking'));
    expect(shown.map((celebration) => [celebration.name, celebration.key, celebration.cause])).toEqual([
      ['bookingFirst', 'ZyXwVuTsRqPoNmLkJiHgFe', 'others'],
    ]);
    expect(shown[0]!.anchor).toBe(item.querySelector('.rio-booking-pages__facts'));

    await refetch([made(2)]);
    await waitFor(() => expect(item.textContent).toContain('2 upcoming bookings'));
    expect(shown).toHaveLength(1);
  });

  it('never celebrates a page that already had bookings when first listed', async () => {
    const { refetch } = open({ pages: [made(1)], emailAvailable: true });
    const item = await screen.findByRole('listitem');
    expect(item.textContent).toContain('1 upcoming booking');
    await refetch([made(2)]);
    await waitFor(() => expect(item.textContent).toContain('2 upcoming bookings'));
    expect(shown).toEqual([]);
  });

  it('never celebrates a page made elsewhere, even one first listed with none', async () => {
    const { refetch } = open({ pages: [made(0)], emailAvailable: true });
    const item = await screen.findByRole('listitem');
    expect(item.textContent).toContain('No upcoming bookings');
    await refetch([made(1)]);
    await waitFor(() => expect(item.textContent).toContain('1 upcoming booking'));
    expect(shown).toEqual([]);
  });
});
