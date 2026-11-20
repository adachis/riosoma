import { useState } from 'react';
import { cleanup, fireEvent, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { FieldMeta, type LineItemValue } from '@riosoma/contracts';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { LineItemsInput } from './LineItemsInput';
import { openDatabase, type DatabaseSession } from '../data';
import { FakeServer } from '../data/testing';
import { relationalFixture } from '../data/testing/relational';

afterEach(cleanup);
const label = 'fld00000000000001';
const amount = 'fld00000000000002';
const status = 'fld00000000000003';
const choice = 'cho00000000000001';
const field = FieldMeta.parse({
  id: 'fld00000000000004',
  tableId: 'tbl00000000000001',
  name: 'Rows',
  description: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
  type: 'lineItems',
  options: {
    columns: [
      { id: label, name: 'Description', type: 'text' },
      { id: amount, name: 'Amount', type: 'currency' },
      {
        id: status,
        name: 'Status',
        type: 'singleSelect',
        options: { choices: [{ id: choice, name: 'Ready', color: 'green' }] },
      },
    ],
  },
});
if (field.type !== 'lineItems') throw new Error('Missing line field');
const lines = field;

function Host({ field = lines, session }: { field?: typeof lines; session?: DatabaseSession }) {
  const [rows, setRows] = useState<LineItemValue[]>([]);
  return (
    <LineItemsInput
      field={field}
      session={session}
      rows={rows}
      format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
      onChange={setRows}
    />
  );
}
function paste(text: string) {
  fireEvent.paste(screen.getByRole('group', { name: 'Rows' }), { clipboardData: { getData: () => text } });
}

it('keeps an empty line table available to keyboard scrolling', async () => {
  renderField(<Host />);
  const region = screen.getByRole('region', { name: 'Rows' });
  await userEvent.tab();
  expect(document.activeElement).toBe(region);
});

it('pastes quoted spreadsheet rows atomically, preserves choice IDs, and totals numbers', async () => {
  renderField(<Host />);
  paste('Labor\t12.50\tReady\n"Parts\tquoted"\t7.50\tReady');
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Description, line 2' }).value).toBe(
    'Parts\tquoted',
  );
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Status, line 1' }).value).toBe(choice);
  expect(screen.getByRole('table').querySelector('tfoot')?.textContent).toContain('$20.00');
  paste('Shipping\t3\tReady\nInvalid\tnot a number\tReady');
  expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(2);
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status, line 1' }), '');
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Status, line 1' }).value).toBe('');
});

it('pastes rows with an optional blank link column', async () => {
  const field = FieldMeta.parse({
    ...lines,
    options: {
      ...lines.options,
      columns: [
        ...lines.options.columns.slice(0, 2),
        { id: status, name: 'Product', type: 'link', options: { linkedTableId: 'tbl00000000000002' } },
      ],
    },
  });
  if (field.type !== 'lineItems') throw new Error('Missing line field');
  renderField(<Host field={field} />);
  paste('Parts\t12.50\t');
  await waitFor(() => expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(1));
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Description, line 1' }).value).toBe('Parts');
  expect(screen.getByRole('table').querySelector('tfoot')?.textContent).toContain('$12.50');
});

it('resolves populated pasted links through the scoped record search', async () => {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  const field = FieldMeta.parse({
    ...lines,
    options: {
      ...lines.options,
      columns: [...lines.options.columns.slice(0, 2), { ...f.link, id: status, name: 'Product' }],
    },
  });
  if (field.type !== 'lineItems') throw new Error('Missing line field');
  try {
    renderField(<Host field={field} session={session} />);
    paste('Parts\t12.50\tAlpha');
    await waitFor(() => expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(1));
    expect(session.linked.get(f.recordIds[0]!)).toBe('Alpha');
    expect(await screen.findByText('Alpha')).not.toBeNull();
    paste('Other\t3\tUnknown product');
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((status) => status.textContent)).toBe(true),
    );
    expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(1);
  } finally {
    session.close();
  }
});

it('retains text and numeric cell focus when Enter commits their values', async () => {
  renderField(<Host />);
  await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
  for (const [name, value] of [
    ['Description', 'Labor'],
    ['Amount', '12.50'],
  ]) {
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: `${name}, line 1` });
    await userEvent.click(input);
    await userEvent.type(input, value!);
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(input);
  }
});

it('keeps invalid cells marked when another cell is saved and announces each error', async () => {
  renderField(<Host />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Add line' }));
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Amount, line 1' });
  await user.type(input, 'invalid');
  await user.tab();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const errorId = input.getAttribute('aria-describedby');
  expect(errorId).toBeTruthy();
  expect(document.getElementById(errorId!)?.textContent).toBeTruthy();
  await user.type(screen.getByRole('textbox', { name: 'Description, line 1' }), 'Parts');
  await user.tab();
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.value).toBe('invalid');
  await user.clear(input);
  await user.type(input, '12');
  await user.tab();
  expect(input.getAttribute('aria-invalid')).toBe('false');
  expect(screen.getByRole('table').querySelector('tfoot')?.textContent).toContain('$12.00');
});

it('synchronizes external cell values while retaining the mounted input', async () => {
  const rows = [{ id: 'rec00000000000001', values: { [label]: 'Before' } }];
  const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };
  function Input({ text }: { text: string }) {
    return (
      <LineItemsInput
        field={lines}
        rows={[{ ...rows[0]!, values: { [label]: text } }]}
        format={format}
        onChange={() => undefined}
      />
    );
  }
  const view = renderField(<Input text="Before" />);
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Description, line 1' });
  input.focus();
  const { I18nProvider } = await import('@lingui/react');
  const { setupI18n } = await import('@lingui/core');
  view.rerender(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <Input text="After" />
    </I18nProvider>,
  );
  expect(screen.getByRole('textbox', { name: 'Description, line 1' })).toBe(input);
  expect(input.value).toBe('After');
  expect(document.activeElement).toBe(input);
});

it('reorders from the keyboard and removes a line while preserving the other values', async () => {
  renderField(<Host />);
  paste('Labor\t12.50\tReady\nParts\t7.50\tReady');
  screen.getByRole('button', { name: 'Reorder line 2' }).focus();
  await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Description, line 1' }).value).toBe('Parts');
  await userEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Description, line 1' }).value).toBe('Labor');
  expect(within(screen.getByRole('table')).getByText('$12.50')).not.toBeNull();
});
