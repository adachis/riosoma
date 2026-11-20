import type {
  BookingCancelPreview,
  BookingPage,
  BookingPageInput,
  PublicBookingPage,
  PublicBookingRequest,
  PublicBookingResult,
  PublicSlots,
  TableBookingPages,
} from '@riosoma/contracts';
import { api } from '../../api';

/** Booking pages: setting them up from a table, and what a visitor's page asks of the server. */

const tablePages = (tableId: string) => `/api/tables/${encodeURIComponent(tableId)}/booking-pages`;
const page = (pageId: string) => `/api/booking-pages/${encodeURIComponent(pageId)}`;
const publicPage = (pageId: string) => `/api/public/bookings/${encodeURIComponent(pageId)}`;

export const bookingPagesKey = (tableId: string) => ['tables', tableId, 'bookingPages'] as const;

export const listBookingPages = (tableId: string, signal?: AbortSignal) =>
  api<TableBookingPages>(tablePages(tableId), signal ? { signal } : {});

export const createBookingPage = (tableId: string, body: BookingPageInput) =>
  api<BookingPage>(tablePages(tableId), { method: 'POST', body });

export const saveBookingPage = (pageId: string, body: BookingPageInput) =>
  api<BookingPage>(page(pageId), { method: 'PUT', body });

export const deleteBookingPage = (pageId: string) => api<void>(page(pageId), { method: 'DELETE' });

export const readPublicBookingPage = (pageId: string, signal?: AbortSignal) =>
  api<PublicBookingPage>(publicPage(pageId), signal ? { signal } : {});

export function readOpenTimes(
  pageId: string,
  range: { from: string; to: string; resource?: string | null },
  signal?: AbortSignal,
) {
  const search = new URLSearchParams({
    from: range.from,
    to: range.to,
    ...(range.resource ? { resource: range.resource } : {}),
  });
  return api<PublicSlots>(`${publicPage(pageId)}/slots?${search.toString()}`, signal ? { signal } : {});
}

export const bookTime = (pageId: string, body: PublicBookingRequest) =>
  api<PublicBookingResult>(`${publicPage(pageId)}/bookings`, { method: 'POST', body });

export const previewCancel = (token: string, signal?: AbortSignal) =>
  api<BookingCancelPreview>(
    `/api/public/bookings/cancel?${new URLSearchParams({ token }).toString()}`,
    signal ? { signal } : {},
  );

export const confirmCancel = (token: string) =>
  api<BookingCancelPreview>('/api/public/bookings/cancel', { method: 'POST', body: { token } });

/** The address people book at, from the path the server gave. */
export function pageAddress(path: string, origin = window.location.origin): string {
  return new URL(path, origin).href;
}
