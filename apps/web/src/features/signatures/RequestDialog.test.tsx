import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { FieldMeta, type AttachmentMeta, type RowData } from '@riosoma/contracts';
import { json, renderSharing } from '../../screens/database/share/testing';
import { RequestDialog } from './RequestDialog';

const frameSource = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src')!;
const createObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
afterEach(() => {
  cleanup();
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', frameSource);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [name, descriptor] of [
    ['createObjectURL', createObjectURL],
    ['revokeObjectURL', revokeObjectURL],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

const files = FieldMeta.parse({
  id: 'fld00000000000001',
  tableId: 'tbl00000000000001',
  name: 'Files',
  description: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
  type: 'attachment',
  options: {},
});
const agreement: AttachmentMeta = {
  id: 'att00000000000001',
  name: 'agreement.pdf',
  size: 1000,
  type: 'application/pdf',
  width: null,
  height: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  scanState: 'clean',
  url: '/api/files/att00000000000001/agreement.pdf',
  thumbnails: { small: null, large: null },
};
const row: RowData = {
  id: 'rec00000000000001',
  values: { [files.id]: [agreement.id] },
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

/** Answers the dialog's requests with a one-page letter-size document, and records each one. */
function stubDocument(): Array<{ url: string; method: string }> {
  // The emulated DOM can't load a PDF into a frame, so setting the preview's address does nothing here.
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true,
    get: () => '',
    set: () => undefined,
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/signature-document')) return json({ pages: [{ width: 612, height: 792 }] });
      return new Response(new Blob(['%PDF-1.7']), { headers: { 'content-type': 'application/pdf' } });
    }),
  );
  return requests;
}

function renderDialog() {
  renderSharing(
    <RequestDialog
      tableId="tbl00000000000001"
      row={row}
      fields={[files]}
      attachments={new Map([[agreement.id, agreement]])}
      onClose={vi.fn()}
    />,
  );
}

it('widens its own panel for the placer, so the form and the page stay inside it', async () => {
  stubDocument();
  renderDialog();
  const dialog = await screen.findByRole('dialog', { name: 'Request signatures' });
  await screen.findByRole('heading', { name: 'Place signing fields' });
  // The panel sets the width and the dialog fills it.  A width on the dialog alone overflowed a
  // standard panel, and the page preview ran past its edge.
  expect(dialog.closest('.rio-modal')?.classList.contains('rio-signatures__modal')).toBe(true);
});

it('refuses to place or move a field over another one', async () => {
  const requests = stubDocument();
  renderDialog();
  const add = await screen.findByRole('button', { name: 'Add field' });
  await userEvent.click(add);
  expect(screen.queryByText(/Fields can’t overlap/)).toBeNull();
  await userEvent.click(add);
  expect(
    await screen.findByText(/Fields can’t overlap\.\s+Place this one where no other field is\./),
  ).toBeTruthy();
  const placed = within(screen.getByRole('list')).getAllByRole('button');
  expect(placed).toHaveLength(1);

  // Moved clear of the first field, a second one fits, and it can't then be moved back on top of it.
  const top = screen.getByRole('spinbutton', { name: 'Top (%)' });
  await userEvent.clear(top);
  await userEvent.type(top, '50');
  await userEvent.click(add);
  expect(within(screen.getByRole('list')).getAllByRole('button')).toHaveLength(2);
  expect(screen.queryByText(/Fields can’t overlap/)).toBeNull();
  const second = screen.getByRole('spinbutton', { name: 'Top (%)' });
  await userEvent.clear(second);
  await userEvent.type(second, '50');
  expect(await screen.findByText(/Fields can’t overlap/)).toBeTruthy();
  expect((screen.getByRole('spinbutton', { name: 'Top (%)' }) as HTMLInputElement).value).toBe('5');
  expect(
    requests.some((request) => request.url.includes('/signature-preview') && request.method === 'POST'),
  ).toBe(true);
});
