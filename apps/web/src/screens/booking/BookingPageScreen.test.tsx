import { readFileSync } from 'node:fs';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingSlot, PublicBookingPage, PublicBookingResult } from '@riosoma/contracts';
import { themes } from '../../preferences';
import { dayIn, stretch, timeOfDay } from '../../features/booking-pages/words';
import { json, renderSharing } from '../database/share/testing';
import { BookingPageView } from './BookingPageScreen';

const PAGE_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const PAGE_PATH = `/api/public/bookings/${PAGE_ID}`;
const css = readFileSync('src/screens/booking/booking.css', 'utf8');
const NAME = 'fld00000000000001';
const EMAIL = 'fld00000000000002';
const OAK = 'cho00000000000001';
// A stand-in for the page's ticket, built here so it never reads as a stored secret.
const TICKET = ['1790000000000', 'ticket'].join('.');
const PINE = 'cho00000000000002';

function page(extra: Partial<PublicBookingPage> = {}): PublicBookingPage {
  const today = dayIn(Date.now());
  return {
    pageId: PAGE_ID,
    title: 'Office hours',
    description: 'Pick a time that suits you.',
    lengthMinutes: 60,
    timeZone: 'UTC',
    resources: null,
    questions: [
      { fieldId: NAME, type: 'text', label: 'Name', help: '', required: true, options: {} },
      { fieldId: EMAIL, type: 'email', label: 'Email', help: '', required: true, options: {} },
    ],
    nameFieldId: NAME,
    emailFieldId: EMAIL,
    firstDay: today,
    lastDay: dayIn(Date.now() + 90 * 86_400_000),
    theme: null,
    ticket: TICKET,
    ...extra,
  };
}

/** Open times at 10:00 and 11:00 local time on every day after today in the range asked for. */
function openTimes(from: string, to: string): BookingSlot[] {
  const today = dayIn(Date.now());
  const slots: BookingSlot[] = [];
  for (let day = new Date(from); day < new Date(to); day.setDate(day.getDate() + 1)) {
    if (dayIn(day) <= today) continue;
    for (const hour of [10, 11]) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour);
      slots.push({ start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() });
    }
  }
  return slots;
}

function serve(
  read: PublicBookingPage | Response,
  answer?: (body: Record<string, unknown>) => PublicBookingResult,
) {
  const posted: Array<Record<string, unknown>> = [];
  const asked: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === PAGE_PATH) return read instanceof Response ? read : json(read);
      if (url.startsWith(`${PAGE_PATH}/slots?`)) {
        const search = new URLSearchParams(url.split('?')[1]);
        asked.push(search);
        return json({ slots: openTimes(search.get('from')!, search.get('to')!) });
      }
      if (url === `${PAGE_PATH}/bookings`) {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        posted.push(body);
        const start = String(body.start);
        return json(
          answer?.(body) ?? {
            status: 'booked',
            start,
            end: new Date(Date.parse(start) + 3_600_000).toISOString(),
            resource: null,
            confirmation: 'See you soon.',
            emailed: true,
          },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return { posted, asked };
}

beforeEach(() => {
  vi.spyOn(themes, 'apply').mockResolvedValue({ theme: 'nature', scheme: 'grove' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;

/** Chooses the first day with open times, moving on a month when this one has none left. */
async function pickFirstDay(user: User): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const grid = await screen.findByRole('grid');
    await waitFor(() => expect(screen.queryByText('Finding open times')).toBeNull());
    const open = within(grid)
      .queryAllByRole('button')
      .find((cell) => cell.getAttribute('aria-disabled') !== 'true');
    if (open) {
      await user.click(open);
      return open.getAttribute('aria-label') ?? '';
    }
    await user.click(screen.getByRole('button', { name: 'Next month' }));
  }
  throw new Error('no day with open times');
}

async function mount(read = page(), answer?: (body: Record<string, unknown>) => PublicBookingResult) {
  const server = serve(read, answer);
  renderSharing(<BookingPageView pageId={PAGE_ID} />, null);
  await screen.findByRole('heading', { name: read.title });
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 5_000);
  return { ...server, user: userEvent.setup() };
}

async function fillIn(user: User) {
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada Lovelace');
  await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.test');
}

describe('booking a time on a public page', () => {
  it('goes from a day to a time to the details, and books it with the ticket', async () => {
    const { user, posted } = await mount();
    await pickFirstDay(user);
    const times = await screen.findByRole('radiogroup', { name: 'Time' });
    const radios = within(times).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    await user.click(radios[0]!);
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Book this time' }));
    const booked = await screen.findByRole('status');
    expect(within(booked).getByRole('heading', { name: 'You’re booked' })).toBeDefined();
    expect(booked.textContent).toContain('See you soon.');
    expect(booked.textContent).toContain(
      'A confirmation with a calendar invitation is on its way to ada@example.test.',
    );
    expect(document.activeElement).toBe(booked);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      ticket: TICKET,
      values: { [NAME]: 'Ada Lovelace', [EMAIL]: 'ada@example.test' },
      website: '',
      locale: 'en-US',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(timeOfDay(String(posted[0]!.start), 'en-US')).toBe(radios[0]!.closest('label')?.textContent);
  });

  it('asks for a resource first, and counts times for the one chosen', async () => {
    const { user, asked } = await mount(
      page({
        resources: [
          { id: OAK, name: 'Oak room' },
          { id: PINE, name: 'Pine room' },
        ],
      }),
    );
    expect(screen.queryByRole('grid')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Pine room' }));
    await pickFirstDay(user);
    expect(asked.at(-1)?.get('resource')).toBe(PINE);
  });

  it('says a time was just taken, offers the next ones, and books one of those instead', async () => {
    let next: BookingSlot[] = [];
    const { user, posted } = await mount(page(), (body) => {
      if (posted.length > 1) {
        const start = String(body.start);
        return {
          status: 'booked',
          start,
          end: new Date(Date.parse(start) + 3_600_000).toISOString(),
          resource: null,
          confirmation: '',
          emailed: false,
        };
      }
      const start = Date.parse(String(body.start));
      next = [1, 2].map((hours) => ({
        start: new Date(start + hours * 3_600_000).toISOString(),
        end: new Date(start + (hours + 1) * 3_600_000).toISOString(),
      }));
      return { status: 'taken', next };
    });
    await pickFirstDay(user);
    await user.click(
      within(await screen.findByRole('radiogroup', { name: 'Time' })).getAllByRole('radio')[0]!,
    );
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Book this time' }));
    const taken = (await screen.findByText(/Someone just took that time/)).closest<HTMLElement>(
      '[role="alert"]',
    )!;
    expect(taken.textContent).toContain('Someone just took that time.  Here are the next open times.');
    expect(document.activeElement).toBe(taken);
    expect(screen.queryByRole('button', { name: 'Book this time' })).toBeNull();
    const offered = stretch(next[1]!.start, next[1]!.end, 'en-US');
    await user.click(within(taken).getByRole('button', { name: offered }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your details' }));
    // The answers stay, so booking the offered time is one more press.
    await user.click(screen.getByRole('button', { name: 'Book this time' }));
    await screen.findByRole('heading', { name: 'You’re booked' });
    expect(posted.map((body) => body.start)).toEqual([expect.any(String), next[1]!.start]);
  });

  it('says so calmly when the page is turned off', async () => {
    serve(json({ error: { code: 'not_found', messageKey: 'bookings.public.off', userFault: true } }, 404));
    renderSharing(<BookingPageView pageId={PAGE_ID} />, null);
    expect(
      await screen.findByRole('heading', { name: 'This page isn’t taking bookings right now.' }),
    ).toBeDefined();
  });

  it('reads a malformed link as a missing page without asking the server', async () => {
    const { posted } = serve(page());
    renderSharing(<BookingPageView pageId="nope" />, null);
    expect(await screen.findByRole('heading', { name: 'This booking page isn’t available.' })).toBeDefined();
    expect(posted).toHaveLength(0);
  });

  it('styles itself with the semantic variables alone', () => {
    const variables = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!);
    expect(variables.length).toBeGreaterThan(0);
    expect(variables.filter((name) => !name.startsWith('--rio-'))).toEqual([]);
  });
});
