import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentImport, previewFile } from './DocumentImport';
import { csvRows } from './csv';
import type { DocumentImportPreview } from '@riosoma/contracts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const draft: DocumentImportPreview = {
  columns: [
    { name: 'Item', type: 'text' },
    { name: 'Quantity', type: 'number' },
  ],
  rows: [
    [
      { value: 'Pencils', confidence: 0.98 },
      { value: '12', confidence: 0.4 },
    ],
  ],
};
function mount(onChoose = vi.fn()) {
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <DocumentImport initialOpen onChoose={onChoose} />
    </I18nProvider>,
  );
  return onChoose;
}
async function read() {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText('Photo or messy file', { selector: 'input' }),
    new File([new Uint8Array([1, 2, 3])], 'Inventory.png', { type: 'image/png' }),
  );
  await user.click(screen.getByRole('button', { name: 'Read file' }));
  return user;
}

it('hands corrected cells and proposed types to the ordinary importer without writing records', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(draft), { headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetch);
  const chosen = mount();
  const user = await read();
  await screen.findByText('Check reading');
  await user.clear(screen.getByRole('textbox', { name: 'Quantity, row 1' }));
  await user.type(screen.getByRole('textbox', { name: 'Quantity, row 1' }), '15');
  expect(screen.queryByText('Check reading')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Use these rows' }));
  const [file, types] = chosen.mock.calls[0] as [File, string[]];
  expect(types).toEqual(['text', 'number']);
  const rows = [];
  for await (const row of csvRows(file)) rows.push(row);
  expect(rows).toEqual([
    ['Item', 'Quantity'],
    ['Pencils', '15'],
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves quotes, commas, line breaks, and formula-looking text as cell data', async () => {
  const value = '=SUM(A1), "paper"\nsecond line';
  const file = previewFile(
    {
      ...draft,
      rows: [
        [
          { value, confidence: 1 },
          { value: '', confidence: 0 },
        ],
      ],
    },
    'Inventory.png',
  );
  const rows = [];
  for await (const row of csvRows(file)) rows.push(row);
  expect(rows[1]).toEqual([value, '']);
});

it('keeps malformed provider output out of the import path', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ...draft, rows: [[{ value: 'Missing a cell', confidence: 1 }]] }), {
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  const chosen = mount();
  await read();
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('The document could not be read.  Try again.'),
  );
  expect(screen.queryByRole('button', { name: 'Use these rows' })).toBeNull();
  expect(chosen).not.toHaveBeenCalled();
});
