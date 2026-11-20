import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { i18n, setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, type CellValue, type FieldType } from '@riosoma/contracts';
import { renderField } from '../../screens/database/fields/fieldTestUtils';
import { openDatabase, type DatabaseSession } from '../../data';
import { FakeServer } from '../../data/testing';
import { RatingControl } from './RatingEditor';
import { QuestionEditor } from '../../screens/database/views/form/QuestionEditor';
import { UserPicker } from './UserEditor';
import { mountEditor } from './mountEditor';
import type { EditorProps } from './types';
import { RecordCard } from '../../screens/database/record/RecordCard';
import { FilterValueEditor } from '../../screens/database/view/FilterValueEditor';

const ada = 'usr00000000000001';
const grace = 'usr00000000000002';
const collaborators = new Map([
  [ada, { name: 'Ada Lovelace', email: 'ada@example.com' }],
  [grace, { name: 'Grace Hopper', email: 'grace@example.com' }],
]);
const format = { locale: 'en-US', timeZone: 'UTC', collaborators };
const sessions: DatabaseSession[] = [];
const disposals: Array<() => void> = [];

it('anchors cell editor portals to the viewport so focusing Done cannot scroll their empty parent', () => {
  const css = readFileSync('src/grid/editors/editors.css', 'utf8');
  const mount = css.match(/\.rio-cell-editor-mount\s*\{([^}]+)\}/)?.[1];
  expect(mount).toContain('position: fixed');
  expect(mount).toContain('inset-block-start: 0');
  expect(mount).toContain('inset-inline-start: 0');
});
afterEach(() => {
  disposals.splice(0).forEach((dispose) => act(dispose));
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
});
function field(type: FieldType, options: object = {}): FieldMeta {
  return FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: type,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options,
  });
}

describe('rating control', () => {
  function setup(max = 5) {
    const change = vi.fn();
    function Control() {
      const [value, setValue] = useState<number | null>(2);
      return (
        <RatingControl
          options={{ max, icon: 'star', color: 'yellow' }}
          value={value}
          label="Score"
          autoFocus
          onChange={(next) => {
            change(next);
            setValue(next);
          }}
        />
      );
    }
    renderField(<Control />);
    return change;
  }
  it('sets by mouse, clears the current value, and provides a labeled clear button', async () => {
    const change = setup();
    await userEvent.click(screen.getByRole('button', { name: '4 of 5' }));
    expect(change).toHaveBeenLastCalledWith(4);
    await userEvent.click(screen.getByRole('button', { name: '4 of 5' }));
    expect(change).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole('button', { name: 'Clear rating' }));
    expect(change).toHaveBeenLastCalledWith(null);
  });
  it('sets digits, clears with zero, and reaches ten with End and Enter', async () => {
    const change = setup(10);
    await userEvent.keyboard('3');
    expect(change).toHaveBeenLastCalledWith(3);
    await userEvent.keyboard('0');
    expect(change).toHaveBeenLastCalledWith(null);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '10 of 10' }));
    await userEvent.keyboard('{Enter}');
    expect(change).toHaveBeenLastCalledWith(10);
    await userEvent.keyboard('{Home}{ArrowRight} ');
    expect(change).toHaveBeenLastCalledWith(2);
  });
  it('does not accept a value above the maximum', async () => {
    const change = setup(3);
    await userEvent.keyboard('9');
    expect(change).not.toHaveBeenCalled();
  });
});

describe('person picker', () => {
  function setup(multiple = true) {
    const change = vi.fn();
    function Picker() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <UserPicker
          collaborators={collaborators}
          selected={selected}
          multiple={multiple}
          label="People"
          locale="en-US"
          autoFocus
          onChange={(ids) => {
            change(ids);
            setSelected(ids);
          }}
        />
      );
    }
    renderField(<Picker />);
    return change;
  }
  it('searches names and email, adds avatar pills, removes by button and Backspace', async () => {
    const change = setup();
    const search = screen.getByRole('searchbox', { name: 'Find a person' });
    await userEvent.type(search, 'ADA@');
    expect(screen.queryByRole('option', { name: /Grace Hopper/ })).toBeNull();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(change).toHaveBeenLastCalledWith([ada]);
    expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeDefined();
    await userEvent.clear(search);
    await userEvent.type(search, 'Grace');
    await userEvent.keyboard('{Enter}');
    expect(change).toHaveBeenLastCalledWith([ada, grace]);
    await userEvent.clear(search);
    await userEvent.keyboard('{Backspace}');
    expect(change).toHaveBeenLastCalledWith([ada]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    expect(change).toHaveBeenLastCalledWith([]);
    await userEvent.type(search, 'missing');
    expect(screen.getByText('No matching people')).toBeDefined();
  });
  it('replaces the existing person when only one is allowed', async () => {
    const change = setup(false);
    await userEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));
    await userEvent.click(screen.getByRole('option', { name: /Grace Hopper/ }));
    expect(change).toHaveBeenLastCalledWith([grace]);
    expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull();
  });
});

async function fixture(type: FieldType, options: object = {}, value: CellValue = null) {
  const server = new FakeServer();
  const f = server.createDatabase(1);
  const database = server.database(f.databaseId);
  const item = { ...field(type, options), tableId: f.tableId };
  database.schema.fields.push(item);
  database.schema.collaborators = [...collaborators].map(([id, person]) => ({ id, ...person }));
  const row = { ...database.rows(f.tableId).get(f.recordId(0))!, values: { [item.id]: value } };
  database.rows(f.tableId).set(row);
  const session = await openDatabase(f.databaseId, server.deps());
  sessions.push(session);
  function save(next: CellValue) {
    session.run([
      { kind: 'record.update', tableId: f.tableId, records: [{ id: row.id, values: { [item.id]: next } }] },
    ]);
  }
  return {
    field: item,
    row,
    session,
    save,
    saved: () => database.rows(f.tableId).get(row.id)?.values[item.id],
  };
}

describe('grid custom editor mounting', () => {
  async function mount(type: 'rating' | 'user', initialText: string | null = null) {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const f = await fixture(type);
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const request: EditorProps['request'] = {
      anchor,
      initialText,
      row: f.row,
      cell: { row: 0, col: 0 },
      column: { id: f.field.id, width: 180, edit: 'custom' },
      done: vi.fn(),
      cancel: vi.fn(),
    };
    act(() => {
      const dispose = mountEditor(request, {
        field: f.field,
        session: f.session,
        format,
        canEditOptions: false,
        apply: f.save,
        addOption: () => '',
      });
      disposals.push(() => {
        dispose();
        anchor.remove();
      });
    });
    return { ...f, request };
  }
  it('mounts rating, writes a click, and finishes', async () => {
    const f = await mount('rating');
    await userEvent.click(await screen.findByRole('button', { name: '3 of 5' }));
    await waitFor(() => expect(f.saved()).toBe(3));
    expect(f.request.done).toHaveBeenCalledWith('down');
  });
  it('uses the digit that started a rating edit', async () => {
    const f = await mount('rating', '4');
    await waitFor(() => expect(f.saved()).toBe(4));
    expect(f.request.done).toHaveBeenCalledTimes(1);
  });
  it('mounts the person picker with initial search text and writes one person', async () => {
    const f = await mount('user', 'grace@');
    await userEvent.click(await screen.findByRole('option', { name: /Grace Hopper/ }));
    await waitFor(() => expect(f.saved()).toEqual([grace]));
    expect(f.request.done).toHaveBeenCalledWith('down');
  });
  it('dismisses using Escape', async () => {
    const f = await mount('user');
    const search = await screen.findByRole('searchbox');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(f.request.done).toHaveBeenCalledWith('none');
  });
  it('finishes a rating edit with Tab', async () => {
    const f = await mount('rating');
    await screen.findByRole('button', { name: '1 of 5' });
    await userEvent.tab();
    expect(f.request.done).toHaveBeenCalledWith('next');
  });
  it.each(['rating', 'user'] as const)('moves backward from a %s editor with Shift+Tab', async (type) => {
    const f = await mount(type);
    if (type === 'rating') await screen.findByRole('button', { name: '1 of 5' });
    else await screen.findByRole('searchbox');
    await userEvent.tab({ shift: true });
    expect(f.request.done).toHaveBeenCalledExactlyOnceWith('previous');
  });
  it.each(['rating', 'user'] as const)('does not finish a %s editor during composition', async (type) => {
    const f = await mount(type);
    const control =
      type === 'rating'
        ? await screen.findByRole('button', { name: '1 of 5' })
        : await screen.findByRole('searchbox');
    fireEvent.keyDown(control, { key: 'Tab', isComposing: true });
    expect(f.request.done).not.toHaveBeenCalled();
  });
});

describe('expanded record editors', () => {
  async function mount(type: FieldType, options: object = {}, value: CellValue = null) {
    const f = await fixture(type, options, value);
    function Card() {
      const [row, setRow] = useState(f.row);
      return (
        <RecordCard
          fields={[f.field]}
          primaryFieldId={f.field.id}
          row={row}
          format={format}
          readOnly={false}
          canEditOptions={false}
          position={null}
          onClose={() => {}}
          onAddOption={() => ''}
          onChange={(id, value) => {
            f.save(value);
            setRow({ ...row, values: { [id]: value } });
          }}
        />
      );
    }
    renderField(<Card />);
    return f;
  }
  it.each([
    ['currency', '$1,234.50', 1234.5, '$1,234.50'],
    ['percent', '25', 0.25, '25%'],
    ['duration', '1:30', 5400, '1:30'],
  ] as const)('parses and formats %s on blur', async (type, text, expected, formatted) => {
    const f = await mount(type);
    const input = screen.getByRole('textbox', { name: type });
    await userEvent.clear(input);
    await userEvent.type(input, text);
    await userEvent.tab();
    await waitFor(() => expect(f.saved()).toBe(expected));
    expect((input as HTMLInputElement).value).toBe(formatted);
    await userEvent.click(input);
    await userEvent.keyboard('{Control>}a{/Control}7{Enter}');
    await waitFor(() => expect(f.saved()).toBe(type === 'percent' ? 0.07 : type === 'duration' ? 420 : 7));
  });
  it('retains invalid text for correction and leaves the stored value alone', async () => {
    const f = await mount('currency', { allowNegative: false }, 5);
    const input = screen.getByRole('textbox', { name: 'currency' });
    await userEvent.clear(input);
    await userEvent.type(input, '-1');
    await userEvent.tab();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(f.saved()).toBe(5);
    await userEvent.click(input);
    await userEvent.keyboard('{Escape}');
    expect((input as HTMLInputElement).value).toBe('5');
  });
  it('edits rating and person fields and keeps autonumber read-only', async () => {
    const rating = await mount('rating');
    await userEvent.click(screen.getByRole('button', { name: '2 of 5' }));
    await waitFor(() => expect(rating.saved()).toBe(2));
    cleanup();
    const person = await mount('user');
    await userEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));
    await waitFor(() => expect(person.saved()).toEqual([ada]));
    cleanup();
    await mount('autoNumber', {}, 42);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('group', { name: 'autoNumber' }).textContent).toBe('42');
  });
});

describe('additional filter value inputs', () => {
  it.each([
    ['currency', 'de', '1.234,50 €', { code: 'EUR' }, 1234.5],
    ['percent', 'en-US', '25', {}, 0.25],
    ['duration', 'en-US', '1:30', {}, 5400],
    ['rating', 'en-US', '3', {}, 3],
    ['autoNumber', 'en-US', '42', {}, 42],
  ] as const)('reads %s filters through the cell parser', async (type, locale, text, options, expected) => {
    const item = field(type, options);
    const change = vi.fn();
    function Filter() {
      const [value, setValue] = useState<unknown>();
      return (
        <FilterValueEditor
          field={item}
          condition={{ id: 'one', fieldId: item.id, operator: 'eq', value }}
          collaborators={collaborators}
          readOnly={false}
          onChange={(value) => {
            change(value);
            setValue(value);
          }}
        />
      );
    }
    const catalog = setupI18n({ locale, messages: { [locale]: {} } });
    render(
      <I18nProvider i18n={catalog}>
        <Filter />
      </I18nProvider>,
    );
    const input = screen.getByRole('textbox', { name: 'Value' });
    await userEvent.type(input, text);
    await userEvent.tab();
    expect(change).toHaveBeenLastCalledWith(expected);
    await userEvent.clear(input);
    expect(change).toHaveBeenLastCalledWith(undefined);
  });
  it('selects multiple people in filters even for a single-person field', async () => {
    const item = field('user');
    const change = vi.fn();
    function Filter() {
      const [value, setValue] = useState<unknown>();
      return (
        <FilterValueEditor
          field={item}
          condition={{ id: 'one', fieldId: item.id, operator: 'hasAnyOf', value }}
          collaborators={collaborators}
          readOnly={false}
          onChange={(value) => {
            change(value);
            setValue(value);
          }}
        />
      );
    }
    renderField(<Filter />);
    await userEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));
    await userEvent.click(screen.getByRole('option', { name: /Grace Hopper/ }));
    expect(change).toHaveBeenLastCalledWith([ada, grace]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));
    expect(change).toHaveBeenLastCalledWith([grace]);
  });
});

it('keeps email search, Enter, selected chips, and Backspace with many collaborators', async () => {
  const many = new Map(collaborators);
  for (let index = 0; index < 12; index++)
    many.set(`extra-${index}`, { name: `Person ${index}`, email: `person${index}@example.test` });
  const submit = vi.fn((event) => event.preventDefault());
  function Picker() {
    const [selected, setSelected] = useState<string[]>([]);
    return (
      <form onSubmit={submit}>
        <UserPicker
          collaborators={many}
          selected={selected}
          multiple
          label="People"
          locale="en-US"
          onChange={setSelected}
        />
        <button type="submit">Save</button>
      </form>
    );
  }
  renderField(<Picker />);
  const search = screen.getByRole('searchbox', { name: 'Find a person' });
  await userEvent.type(search, 'ada@{Enter}');
  expect(screen.getByRole('button', { name: 'Remove Ada Lovelace' })).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  await userEvent.clear(search);
  await userEvent.type(search, '{Backspace}');
  expect(screen.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull();
  await userEvent.type(search, 'grace@{Enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Remove Grace Hopper' }));
  expect(screen.queryByRole('button', { name: 'Remove Grace Hopper' })).toBeNull();
  expect(document.activeElement).toBe(search);
});

it.each([2, 12])('selects the searched address among %s people who share a name', async (count) => {
  const many = new Map(
    Array.from(
      { length: count },
      (_, index) =>
        [`reviewer-${index}`, { name: 'Field Reviewer', email: `reviewer${index}@example.test` }] as const,
    ),
  );
  const change = vi.fn();
  renderField(
    <UserPicker
      collaborators={many}
      selected={[]}
      multiple
      label="People"
      locale="en-US"
      onChange={change}
    />,
  );
  const index = count - 1;
  await userEvent.type(screen.getByRole('searchbox', { name: 'Find a person' }), `reviewer${index}@`);
  const option = screen.getByRole('option', { name: /Field Reviewer/ });
  expect(option.textContent).toContain(`reviewer${index}@example.test`);
  await userEvent.click(option);
  expect(change).toHaveBeenLastCalledWith([`reviewer-${index}`]);
});

it('keeps long user questions labeled and searchable by email', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const many = new Map(collaborators);
  for (let index = 0; index < 12; index++)
    many.set(`extra-${index}`, { name: `Person ${index}`, email: `person${index}@example.test` });
  const change = vi.fn();
  renderField(
    <>
      <span id="question-label">Assigned people</span>
      <QuestionEditor
        field={field('user', { allowMultiple: true })}
        value={[]}
        format={{ ...format, collaborators: many }}
        session={session}
        labelId="question-label"
        onChange={change}
        onUploading={vi.fn()}
      />
    </>,
  );
  const list = screen.getByRole('listbox', { name: /Assigned people/ });
  expect(list.getAttribute('aria-labelledby')?.split(' ')).toContain('question-label');
  await userEvent.type(screen.getByRole('searchbox'), 'ada@{Enter}');
  expect(change).toHaveBeenCalledWith('fld00000000000001', [ada]);
});
