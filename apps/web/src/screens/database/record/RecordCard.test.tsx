import { useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkCellValue,
  FieldMeta,
  roleAllows,
  type CellValue,
  type DatabaseRole,
  type FieldType,
  type HistoryPage,
  type RowData,
} from '@riosoma/contracts';
import { openDatabase } from '../../../data';
import type { DatabaseSession, Http } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { relationalFixture, settle } from '../../../data/testing/relational';
import { RecordCard, type RecordCardProps } from './RecordCard';
import { RecordLockControl } from './RecordLockControl';
import { RecordValue } from './RecordValue';

afterEach(cleanup);
afterAll(() => vi.restoreAllMocks());
const choices = [
  { id: 'cho00000000000001', name: 'Ready', color: 'green' },
  { id: 'cho00000000000002', name: 'Waiting', color: 'yellow' },
];

function field(type: FieldType, options: object = {}): FieldMeta {
  return FieldMeta.parse({
    id: `fld${String(type.length).padStart(14, '0')}`,
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

const row: RowData = {
  id: 'rec00000000000001',
  values: {},
  createdAt: '2026-09-27T22:05:00.000Z',
  updatedAt: '2026-09-28T22:05:00.000Z',
  createdBy: 'person',
  updatedBy: 'person',
};
const format = {
  locale: 'en-US',
  timeZone: 'America/Los_Angeles',
  collaborators: new Map([['person', { name: 'Alex Rivera' }]]),
};

function mount(
  fields: FieldMeta[],
  values: Record<string, CellValue> = {},
  overrides: Partial<RecordCardProps> = {},
) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const onAddOption = vi.fn(() => 'cho00000000000003');
  const props: RecordCardProps = {
    fields,
    primaryFieldId: fields[0]?.id ?? '',
    row: { ...row, values },
    format,
    readOnly: false,
    canEditOptions: true,
    position: { index: 1, total: 3 },
    onChange,
    onClose,
    onAddOption,
    ...overrides,
  };
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const result = render(
    <I18nProvider i18n={i18n}>
      <RecordCard {...props} />
    </I18nProvider>,
  );
  return { ...result, onChange, onClose, onAddOption, props, i18n };
}

describe('RecordCard', () => {
  it.each(['card', 'panel', 'page'] as const)(
    'keeps the loading %s body reachable by keyboard',
    async (layout) => {
      mount([field('text')], {}, { row: null, layout });
      const body = document.querySelector('.rio-record-card__body')!;
      screen.getByRole('button', { name: 'Close' }).focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(body);
    },
  );

  it('removes a scrolling value from the tab order while an ancestor is hidden', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    const viewport = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    try {
      const { container } = render(
        <div>
          <RecordValue labelId="value-label">Long value</RecordValue>
        </div>,
      );
      const parent = container.firstElementChild!;
      const value = parent.firstElementChild as HTMLElement;
      expect(value.tabIndex).toBe(0);
      parent.setAttribute('aria-hidden', 'true');
      await waitFor(() => expect(value.tabIndex).toBe(-1));
      parent.removeAttribute('aria-hidden');
      await waitFor(() => expect(value.tabIndex).toBe(0));
    } finally {
      height.mockRestore();
      viewport.mockRestore();
    }
  });

  it.each(['panel', 'page'] as const)(
    'dismisses an open select picker before closing the %s',
    async (layout) => {
      const item = field('singleSelect', { choices });
      const { onClose } = mount([item], { [item.id]: choices[0]!.id }, { layout });
      const input = screen.getByRole('combobox', { name: 'singleSelect' });
      await userEvent.click(input);
      await userEvent.keyboard('{ArrowDown}');
      expect(input.getAttribute('aria-expanded')).toBe('true');
      await userEvent.keyboard('{Escape}');
      expect(input.getAttribute('aria-expanded')).toBe('false');
      expect(onClose).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the reason available to retry after a rejected lock command', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(1);
    const deps = server.deps();
    const http = deps.http!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.http = async (path, options) => {
      if (path.endsWith('/commands')) await gate;
      return http(path, options);
    };
    const session = await openDatabase(fixture.databaseId, deps);
    try {
      await settle();
      const row = await session.getRecord(fixture.tableId, fixture.recordId(0));
      const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
      function Host() {
        const current = useSyncExternalStore(
          (listener) => session.subscribeRecords(fixture.tableId, listener),
          () => session.cachedRecord(fixture.tableId, fixture.recordId(0)),
        );
        return (
          <I18nProvider i18n={i18n}>
            <RecordLockControl session={session} tableId={fixture.tableId} row={current ?? row!} />
          </I18nProvider>
        );
      }
      render(<Host />);
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Lock reason' }), 'Reviewed');
      server.rejectNext();
      await userEvent.click(screen.getByRole('button', { name: 'Confirm lock' }));
      await act(async () => {
        await settle();
      });
      release();
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Lock reason' }) as HTMLInputElement).value).toBe(
        'Reviewed',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Confirm lock' }));
      expect(await screen.findByText('Locked: Reviewed')).toBeTruthy();
    } finally {
      release();
      session.close();
    }
  });

  it('makes an overflowing read-only value focusable for keyboard scrolling', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300);
    const viewport = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    try {
      const item = field('longText');
      mount([item], { [item.id]: 'Long record value\n'.repeat(30) }, { readOnly: true });
      const value = screen.getByRole('group', { name: 'longText' });
      expect(value.tabIndex).toBe(0);
      value.focus();
      expect(document.activeElement).toBe(value);
    } finally {
      height.mockRestore();
      viewport.mockRestore();
    }
  });

  it('recovers from an invalid lock reason without leaving confirmation pending', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(1);
    const session = await openDatabase(fixture.databaseId, server.deps());
    try {
      await settle();
      const fields = session.getSchema().fields.get(fixture.tableId)!;
      const record = await session.getRecord(fixture.tableId, fixture.recordId(0));
      mount([...fields], {}, { session, row: record });
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Lock reason' }), {
        target: { value: 'x'.repeat(1001) },
      });
      await userEvent.click(screen.getByRole('button', { name: 'Confirm lock' }));
      expect((await screen.findByRole('alert')).textContent).toContain('The lock could not be changed.');
      expect(screen.getByRole('button', { name: 'Confirm lock' }).hasAttribute('disabled')).toBe(false);
      fireEvent.change(screen.getByRole('textbox', { name: 'Lock reason' }), {
        target: { value: 'Reviewed' },
      });
      await userEvent.click(screen.getByRole('button', { name: 'Confirm lock' }));
      await waitFor(() =>
        expect(session.cachedRecord(fixture.tableId, fixture.recordId(0))?.lock?.reason).toBe('Reviewed'),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      session.close();
    }
  });

  it('closes a lock draft after losing edit access and keeps it closed when access returns', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(1);
    const session = await openDatabase(fixture.databaseId, server.deps());
    try {
      await settle();
      const fields = session.getSchema().fields.get(fixture.tableId)!;
      const record = await session.getRecord(fixture.tableId, fixture.recordId(0));
      mount([...fields], {}, { session, row: record });
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Lock reason' }), 'Approval draft');
      for (const access of ['reader', 'editor'] as const) {
        await act(async () => {
          server.database(fixture.databaseId).schema.database.role = access;
          server.dropSubscriptions(fixture.databaseId, 'accessChanged');
          await settle();
        });
        await waitFor(() => expect(session.role()).toBe(access));
        expect(screen.queryByRole('textbox', { name: 'Lock reason' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Confirm lock' })).toBeNull();
      }
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      expect((screen.getByRole('textbox', { name: 'Lock reason' }) as HTMLInputElement).value).toBe('');
    } finally {
      session.close();
    }
  });

  it('discards a lock reason draft when navigating to a different record', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(2);
    const session = await openDatabase(fixture.databaseId, server.deps());
    try {
      await settle();
      const fields = session.getSchema().fields.get(fixture.tableId)!;
      const first = await session.getRecord(fixture.tableId, fixture.recordId(0));
      const second = await session.getRecord(fixture.tableId, fixture.recordId(1));
      const { props, i18n, rerender } = mount([...fields], {}, { session, row: first });
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Lock reason' }), 'First record approval');
      rerender(
        <I18nProvider i18n={i18n}>
          <RecordCard {...props} row={second} />
        </I18nProvider>,
      );
      expect(screen.queryByRole('textbox', { name: 'Lock reason' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Lock record' }));
      expect((screen.getByRole('textbox', { name: 'Lock reason' }) as HTMLInputElement).value).toBe('');
    } finally {
      session.close();
    }
  });

  it.each(['Close', 'Next record', 'Previous record', 'Escape', 'Close without blur'])(
    'keeps a pending or conflicting text draft when leaving through %s',
    async (action) => {
      const server = new FakeServer();
      const fixture = server.createDatabase(1);
      const database = server.database(fixture.databaseId);
      const item = FieldMeta.parse({ ...database.field(fixture.textFieldId), type: 'longText', options: {} });
      database.schema.fields[0] = item;
      const recordId = fixture.recordId(0);
      database.rows(fixture.tableId).get(recordId)!.values[item.id] = 'red green blue';
      const session = await openDatabase(fixture.databaseId, server.deps());
      try {
        type CommandAnswer = Awaited<ReturnType<DatabaseSession['run']>['done']>;
        let answer!: (result: CommandAnswer) => void;
        const done = new Promise<CommandAnswer>((resolve) => {
          answer = resolve;
        });
        const run = vi.spyOn(session, 'run').mockReturnValue({ groupId: 'act00000000000001', done });
        const leave = vi.fn();
        const record = await session.getRecord(fixture.tableId, recordId);
        mount([item], record!.values, {
          session,
          row: record,
          layout: 'panel',
          onClose: leave,
          onPrevious: leave,
          onNext: leave,
        });
        const input = screen.getByRole('textbox', { name: item.name });
        if (action === 'Close without blur')
          fireEvent.change(input, { target: { value: 'red purple blue' } });
        else {
          await userEvent.clear(input);
          await userEvent.type(input, 'red purple blue');
        }
        if (action === 'Escape') {
          await userEvent.keyboard('{Control>}{Enter}{/Control}');
          await userEvent.keyboard('{Escape}');
        } else if (action === 'Close without blur')
          fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        else await userEvent.click(screen.getByRole('button', { name: action }));
        expect(run).toHaveBeenCalledOnce();
        expect(leave).not.toHaveBeenCalled();
        const collision = {
          tableId: fixture.tableId,
          recordId,
          fieldId: item.id,
          base: 'red green blue',
          ours: 'red purple blue',
          theirs: 'red yellow blue',
          updatedBy: server.userId,
          name: 'Sam',
          updatedAt: '2026-10-02T12:00:00Z',
          proposal: '<<<<<<<\npurple\n=======\nyellow\n>>>>>>>',
        };
        answer({
          applied: 0,
          rejected: 1,
          results: [
            {
              id: 'cmd00000000000001',
              status: 'rejected',
              error: {
                code: 'conflict',
                messageKey: 'data.textEdit.conflict',
                userFault: true,
                conflicts: [collision],
              },
            },
          ],
        });
        await screen.findByRole('dialog', { name: 'Resolve text conflict' });
        expect(leave).not.toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Back to editing' }));
        expect((screen.getByRole('textbox', { name: item.name }) as HTMLTextAreaElement).value).toBe(
          collision.ours,
        );
        expect(leave).not.toHaveBeenCalled();
        run.mockReturnValueOnce({
          groupId: 'act00000000000002',
          done: Promise.resolve({
            applied: 1,
            rejected: 0,
            results: [{ id: 'cmd00000000000002', status: 'applied' }],
          }),
        });
        await userEvent.click(screen.getByRole('textbox', { name: item.name }));
        await userEvent.keyboard('{Control>}{Enter}{/Control}');
        await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(leave).toHaveBeenCalledOnce();
      } finally {
        session.close();
      }
    },
  );
  it('does not clear an unavailable source selection when the card loses focus', async () => {
    const item = field('singleSelect', { source: { tableId: 'tbl00000000000002' } });
    const { onChange } = mount([item], { [item.id]: choices[0]!.id });
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute('placeholder')).toBe('Unavailable option');
  });

  it.each([
    ['text', 'A record'],
    ['email', 'person@example.com'],
    ['url', 'https://example.com'],
    ['phone', '+1 555 0100'],
  ] as const)('edits %s on Enter and blur with checked values', async (type, text) => {
    const item = field(type);
    const { onChange } = mount([item]);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: type });
    await user.type(input, text);
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, text);
    expect(checkCellValue(item, onChange.mock.lastCall?.[1]).ok).toBe(true);
    await user.tab();
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.clear(input);
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(item.id, null);
  });

  it('saves long text on modifier+Enter and blur, preserving newlines', async () => {
    const item = field('longText');
    const { onChange } = mount([item]);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'longText' });
    expect(input.tagName).toBe('TEXTAREA');
    await user.type(input, 'First{Enter}Second');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, 'First\nSecond');
    await user.type(input, ' line');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(item.id, 'First\nSecond line');
  });

  it('saves numbers on Enter and blur with precision and negative bounds', async () => {
    const item = field('number', { precision: 2, allowNegative: false });
    const { onChange } = mount([item], { [item.id]: 1.2 });
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'number' });
    expect((input as HTMLInputElement).value).toBe('1.20');
    expect(screen.getByRole('button', { name: /Increase/ })).toBeDefined();
    await user.clear(input);
    await user.type(input, '42.25');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, 42.25);
    await user.clear(input);
    await user.type(input, '5');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(item.id, 5);
  });

  it('saves a number entered into an empty field', async () => {
    const item = field('number');
    const { onChange } = mount([item]);
    const input = screen.getByRole('textbox', { name: 'number' });
    await userEvent.type(input, '42');
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, 42);
    expect((input as HTMLInputElement).value).toBe('42');
  });

  it('retains a native number input before its change event is delivered', async () => {
    const item = field('number');
    const { onChange } = mount([item]);
    const input = screen.getByRole('textbox', { name: 'number' }) as HTMLInputElement;
    // Browser events can flush capture updates before the numeric control reads the input.
    input.addEventListener('input', () => flushSync(() => {}), { capture: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '42');
    fireEvent.input(input);
    await waitFor(() => expect(input.value).toBe('42'));
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, 42);
  });

  it('retains invalid number text, shows an error, and reverts with Escape before closing', async () => {
    const item = field('number');
    const { onChange, onClose } = mount([item], { [item.id]: 12 });
    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox', { name: 'number' }));
    await user.keyboard('oops{Enter}');
    expect((screen.getByRole('textbox', { name: 'number' }) as HTMLInputElement).value).toBe('oops');
    expect(screen.getByText('Enter a number.')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'number' }) as HTMLInputElement).value).toBe('12');
    expect(screen.queryByText('Enter a number.')).toBeNull();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects negative values when the field disallows them', async () => {
    const item = field('number', { allowNegative: false });
    const { onChange } = mount([item]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'number' }));
    await user.paste('-2');
    await user.keyboard('{Enter}');
    expect(screen.getByText('This field doesn’t allow negative numbers.')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('saves a checkbox immediately', async () => {
    const item = field('checkbox');
    const { onChange } = mount([item]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    expect(onChange).toHaveBeenCalledWith(item.id, true);
  });

  it.each([false, true])('saves calendar selections with includeTime=%s', async (includeTime) => {
    const item = field('date', { includeTime, timeFormat: '24h', timeZone: 'America/Los_Angeles' });
    const { onChange } = mount([item], {
      [item.id]: includeTime ? '2026-09-27T22:05:00.000Z' : '2026-09-27',
    });
    const user = userEvent.setup();
    expect(screen.getAllByRole('spinbutton').length).toBe(includeTime ? 5 : 3);
    await user.click(screen.getByRole('button', { name: /Choose a date/ }));
    await user.click(screen.getByRole('button', { name: /Monday, September 28, 2026/ }));
    const expected = includeTime ? '2026-09-28T22:05:00.000Z' : '2026-09-28';
    expect(onChange).toHaveBeenLastCalledWith(item.id, expected);
    expect(checkCellValue(item, expected).ok).toBe(true);
  });

  it('retains an invalid pasted date until corrected or reverted', async () => {
    const item = field('date');
    const { onChange, onClose } = mount([item], { [item.id]: '2026-09-27' });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('spinbutton')[0]!);
    await user.paste('not a date');
    expect(screen.getByText('Enter a date.')).toBeDefined();
    expect((screen.getByRole('textbox', { name: 'date' }) as HTMLInputElement).value).toBe('not a date');
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByRole('spinbutton')).toHaveLength(3);
    await user.paste('2026-10-01');
    expect(onChange).toHaveBeenLastCalledWith(item.id, '2026-10-01');
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'picks %s options and creates an allowed option',
    async (type) => {
      const item = field(type, { choices });
      const { onChange, onAddOption } = mount([item]);
      const user = userEvent.setup();
      const input = screen.getByRole('combobox', { name: type });
      await user.type(input, 'Ready');
      expect(
        screen.getByRole('option', { name: /^Ready(?: |$)/ }).querySelector('.rio-choice-pill'),
      ).not.toBeNull();
      await user.keyboard('{ArrowDown}{Enter}');
      expect(onChange).toHaveBeenLastCalledWith(
        item.id,
        type === 'multipleSelect' ? [choices[0]!.id] : choices[0]!.id,
      );
      await user.clear(input);
      await user.type(input, 'New');
      await user.click(screen.getByRole('option', { name: /^Add option “New”(?: |$)/ }));
      expect(onAddOption).toHaveBeenCalledWith(item.id, 'New');
      expect(onChange).toHaveBeenLastCalledWith(
        item.id,
        type === 'multipleSelect' ? [choices[0]!.id, 'cho00000000000003'] : 'cho00000000000003',
      );
      if (type === 'multipleSelect') {
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Remove Ready' }));
        expect(onChange).toHaveBeenLastCalledWith(item.id, ['cho00000000000003']);
      }
    },
  );

  it.each([true, false])('only offers creation with no match and permission=%s', async (canEditOptions) => {
    mount([field('singleSelect', { choices })], {}, { canEditOptions });
    const user = userEvent.setup();
    const input = screen.getByRole('combobox');
    await user.type(input, 'Rea');
    expect(screen.queryByRole('option', { name: /Add option/ })).toBeNull();
    await user.clear(input);
    await user.type(input, 'New');
    expect(screen.queryByRole('option', { name: /Add option/ }) !== null).toBe(canEditOptions);
  });

  it('renders computed fields as text and people as avatars', () => {
    const fields = (
      ['createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy', 'recordId'] as const
    ).map((type, index) => ({ ...field(type), id: `fld${String(index).padStart(14, '0')}` }));
    mount(fields);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('img', { name: 'AR: Alex Rivera' })).toHaveLength(2);
    expect(screen.getAllByText('Alex Rivera')).toHaveLength(2);
    expect(screen.getByText(row.id)).toBeDefined();
    expect(screen.getByRole('group', { name: 'createdTime' }).textContent).toContain('Sep 27');
    expect(screen.getByRole('group', { name: 'lastModifiedTime' }).textContent).toContain('Sep 28');
  });

  it('shows every field read-only in the supplied order', () => {
    const fields = (
      [
        'text',
        'number',
        'longText',
        'checkbox',
        'date',
        'singleSelect',
        'multipleSelect',
        'email',
        'url',
        'phone',
      ] as const
    ).map((type, index) => ({ ...field(type), id: `fld${String(index).padStart(14, '0')}` }));
    const { onChange } = mount(fields, {}, { readOnly: true });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(
      screen
        .getAllByRole('group')
        .map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent),
    ).toEqual(fields.map((item) => item.name));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows loading placeholders, then focuses the first editable field', async () => {
    const item = field('text');
    const { rerender, props, i18n } = mount([field('recordId'), item], {}, { row: null });
    expect(screen.getByRole('dialog', { name: 'Loading record' })).toBeDefined();
    expect(document.querySelectorAll('.rio-record-card__placeholder')).toHaveLength(2);
    expect(screen.queryByRole('textbox')).toBeNull();
    rerender(
      <I18nProvider i18n={i18n}>
        <RecordCard {...props} row={row} />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'text' })));
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///private/file',
    '//example.com',
    'java\nscript:alert(1)',
  ])('does not offer an Open link for %s', (url) => {
    const item = field('url');
    mount([item], { [item.id]: url });
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
  });

  it.each([
    ['url', 'https://example.com', 'https://example.com'],
    ['url', 'example.org/plans', 'https://example.org/plans'],
    ['email', 'person@example.com', 'mailto:person@example.com'],
    ['phone', '+15550100', 'tel:+15550100'],
  ] as const)('offers a safe link for %s', (type, value, href) => {
    const item = field(type);
    mount([item], { [item.id]: value });
    const link = screen.getByRole('link', { name: /Open/ });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('steps by button and Alt+arrow, and closes by Escape', async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { onClose } = mount([field('text')], {}, { onPrevious, onNext });
    const user = userEvent.setup();
    expect(screen.getByText('2 of 3')).toBeDefined();
    await user.keyboard('{Alt>}{ArrowUp}{ArrowDown}{/Alt}');
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Previous record' }));
    await user.click(screen.getByRole('button', { name: 'Next record' }));
    expect(onPrevious).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables navigation at the ends', async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    mount([field('text')], {}, { position: { index: 0, total: 1 }, onPrevious, onNext });
    expect(screen.getByRole('button', { name: 'Previous record' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next record' }).hasAttribute('disabled')).toBe(true);
    await userEvent.keyboard('{Alt>}{ArrowUp}{ArrowDown}{/Alt}');
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('focuses the first editable field and returns focus to the opener', async () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <I18nProvider i18n={i18n}>
          <button onClick={() => setOpen(true)}>Record</button>
          {open && (
            <RecordCard
              fields={[field('recordId'), field('text')]}
              primaryFieldId={field('text').id}
              row={row}
              format={format}
              readOnly={false}
              canEditOptions={false}
              position={null}
              onChange={vi.fn()}
              onAddOption={() => ''}
              onClose={() => setOpen(false)}
            />
          )}
        </I18nProvider>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    const opener = screen.getByRole('button', { name: 'Record' });
    await user.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'text' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('shows the primary field title and rejects an invalid email', async () => {
    const item = field('email');
    const { onChange } = mount([item], { [item.id]: 'person@example.com' });
    expect(screen.getByRole('dialog', { name: 'person@example.com' })).toBeDefined();
    const input = screen.getByRole('textbox', { name: 'email' });
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.blur(input);
    expect(within(screen.getByRole('dialog')).getByText('That isn’t a valid email address.')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps focus and the input mounted when the parent accepts an edit', async () => {
    const first = field('text');
    const second = field('email');
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const onChange = vi.fn();
    function Host() {
      const [record, setRecord] = useState(row);
      return (
        <I18nProvider i18n={i18n}>
          <RecordCard
            fields={[first, second]}
            primaryFieldId={first.id}
            row={record}
            format={format}
            readOnly={false}
            canEditOptions={false}
            position={null}
            onChange={(id, value) => {
              onChange(id, value);
              setRecord((current) => ({ ...current, values: { ...current.values, [id]: value } }));
            }}
            onAddOption={() => ''}
            onClose={vi.fn()}
          />
        </I18nProvider>
      );
    }
    render(<Host />);
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'email' });
    await user.type(input, 'person@example.com{Enter}');
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('textbox', { name: 'email' })).toBe(input);
    await user.tab();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(second.id, 'person@example.com');
  });

  it('discards an invalid draft when navigating to a different record', async () => {
    const item = field('number');
    const { rerender, props, i18n, onChange } = mount([item]);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'number' }), 'invalid{Enter}');
    expect(screen.getByText('Enter a number.')).toBeDefined();
    rerender(
      <I18nProvider i18n={i18n}>
        <RecordCard {...props} row={{ ...row, id: 'rec00000000000002', values: { [item.id]: 7 } }} />
      </I18nProvider>,
    );
    expect((screen.getByRole('textbox', { name: 'number' }) as HTMLInputElement).value).toBe('7');
    expect(screen.queryByText('Enter a number.')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('corrects invalid numbers and closes with Escape after saving', async () => {
    const item = field('number', { precision: 2 });
    const { onChange, onClose } = mount([item]);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'number' }), 'invalid{Enter}');
    await user.clear(screen.getByRole('textbox', { name: 'number' }));
    await user.keyboard('12.5{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(item.id, 12.5);
    expect(screen.queryByText('Enter a number.')).toBeNull();
    expect(screen.getByRole('button', { name: /Increase/ })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('validates an unfinished date on blur without saving', async () => {
    const item = field('date');
    const { onChange } = mount([item]);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('spinbutton')[0]!);
    await user.keyboard('9');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Enter a date.')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a disallowed draft choice removable after the parent changes', async () => {
    const parent = 'fld00000000000009';
    const item = field('multipleSelect', {
      choices,
      cascade: { fieldId: parent, mapping: { [choices[1]!.id]: [choices[1]!.id] } },
    });
    const { onChange } = mount([item], { [parent]: choices[1]!.id, [item.id]: [choices[0]!.id] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove Ready' }));
    expect(onChange).toHaveBeenLastCalledWith(item.id, null);
    await user.type(screen.getByRole('combobox'), 'Wait');
    expect(screen.getByRole('option', { name: /^Waiting(?: |$)/ })).toBeDefined();
    expect(screen.queryByRole('option', { name: /^Ready(?: |$)/ })).toBeNull();
  });

  it('clears a single select on blur', async () => {
    const item = field('singleSelect', { choices });
    const { onChange } = mount([item], { [item.id]: choices[0]!.id });
    const user = userEvent.setup();
    await user.clear(screen.getByRole('combobox'));
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(item.id, null);
  });

  it('does not round a stored number merely by focusing and blurring it', async () => {
    const item = field('number', { precision: 2 });
    const { onChange } = mount([item], { [item.id]: 1.2345 });
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'number' }));
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reverts a valid unsaved number with Escape before closing', async () => {
    const item = field('number');
    const { onChange, onClose } = mount([item], { [item.id]: 12 });
    const user = userEvent.setup();
    await user.clear(screen.getByRole('textbox', { name: 'number' }));
    await user.keyboard('34{Escape}');
    expect((screen.getByRole('textbox', { name: 'number' }) as HTMLInputElement).value).toBe('12');
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('linked and computed record fields', () => {
  it('adds and removes links, opens the linked card, and keeps computed values read-only', async () => {
    const server = new FakeServer();
    const f = relationalFixture(server);
    const session = await openDatabase(f.source.databaseId, server.deps());
    try {
      const view = session.openView(f.source.viewId);
      await settle();
      const fields = session.getSchema().fields.get(f.source.tableId)!;
      const row = view.getRow(0)!;
      const { onChange } = mount([...fields], row.values, {
        session,
        primaryFieldId: f.source.textFieldId,
        row,
      });
      expect(screen.getByRole('group', { name: 'Prices' }).textContent).toBe('1.00, 2.00');
      expect(screen.getByRole('group', { name: 'Total' }).textContent).toBe('3.00');
      expect(screen.getByRole('group', { name: 'Double' }).textContent).toBe('2');
      expect(screen.queryByRole('textbox', { name: 'Double' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Remove Beta' }));
      expect(onChange).toHaveBeenCalledWith(f.link.id, [f.recordIds[0]]);
      await userEvent.click(screen.getByRole('button', { name: 'Link a record' }));
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Gamma' } });
      await userEvent.click(await screen.findByRole('option', { name: /^Gamma(?: |$)/ }));
      expect(onChange).toHaveBeenCalledWith(f.link.id, f.recordIds);
      await userEvent.click(screen.getByRole('button', { name: 'Alpha' }));
      expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeTruthy();
      expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Alpha');
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('heading', { name: 'Record 1' })).toBeTruthy();
    } finally {
      session.close();
    }
  });
});

describe('the side of the record card', () => {
  const SAM = 'usr00000000000002';

  async function mountCard(options: { role?: DatabaseRole; history?: HistoryPage } = {}) {
    const server = new FakeServer();
    const fixture = server.createDatabase(2);
    const database = server.database(fixture.databaseId);
    database.schema.database.role = options.role ?? 'owner';
    database.schema.collaborators = [
      { id: server.userId, name: 'Alex Rivera', email: 'alex@example.test' },
      { id: SAM, name: 'Sam Lee', email: 'sam@example.test' },
    ];
    const recordId = fixture.recordId(0);
    database.comments = [
      {
        id: 'cmt00000000000001',
        tableId: fixture.tableId,
        recordId,
        authorId: SAM,
        body: 'On the record',
        mentions: [],
        createdAt: new Date().toISOString(),
        editedAt: null,
      },
    ];
    const history = options.history;
    const http: Http = async <T,>(path: string, rest?: Parameters<Http>[1]): Promise<T> => {
      if (history && path.includes('/history')) return history as T;
      return server.http<T>(path, rest);
    };
    const session = await openDatabase(fixture.databaseId, server.deps({ http }));
    await settle();
    const fields = session.getSchema().fields.get(fixture.tableId)!;
    const record = await session.getRecord(fixture.tableId, recordId);
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <RecordCard
          session={session}
          fields={[...fields]}
          primaryFieldId={fixture.textFieldId}
          row={record}
          format={format}
          readOnly={!roleAllows(session.role(), 'editRecords')}
          canEditOptions={false}
          position={null}
          onChange={vi.fn()}
          onAddOption={() => ''}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    return { server, session, fixture, recordId };
  }

  it('shows the thread beside the fields, and below them when the card is narrow', async () => {
    await mountCard();
    const columns = document.querySelector('.rio-record-card__columns')!;
    expect([...columns.children].map((child) => child.className)).toEqual([
      'rio-record-card__fields',
      'rio-record-card__side',
    ]);
    expect(screen.getByRole('tab', { name: 'Comments' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel')).toBeTruthy();
    expect(await screen.findByText('On the record')).toBeTruthy();
    // The narrow card drops to one column, so the thread follows the fields instead of squeezing
    // beside them.
    const css = readFileSync(join(import.meta.dirname, 'RecordCard.css'), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 860px)'));
    expect(narrow).toContain('.rio-record-card__columns');
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(narrow).toContain('position: static');
  });

  it('switches tabs with the arrow keys and reads the history', async () => {
    await mountCard({
      history: {
        entries: [
          {
            seq: 2,
            at: new Date().toISOString(),
            actorId: SAM,
            kind: 'updated',
            changes: [{ fieldId: '', before: null, after: 'Later' }],
          },
        ],
        next: null,
      },
    });
    const user = userEvent.setup();
    screen.getByRole('tab', { name: 'Comments' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('Sam Lee changed 1 field')).toBeTruthy();
    expect(screen.getByText('Later')).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByText('On the record')).toBeTruthy();
  });

  it('says when a record has no changes yet', async () => {
    await mountCard();
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No changes yet.')).toBeTruthy();
  });

  it('shows a reader the thread without a composer', async () => {
    await mountCard({ role: 'reader' });
    expect(await screen.findByText('On the record')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Add a comment/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'History' })).not.toBeNull();
  });

  it('shows signature requests only to people who can edit the record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ requests: [] }))),
    );
    try {
      await mountCard({ role: 'reader' });
      expect(await screen.findByText('On the record')).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Signatures' })).toBeNull();
      cleanup();
      await mountCard({ role: 'editor' });
      expect(await screen.findByRole('tab', { name: 'Signatures' })).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows no side at all without a session', () => {
    mount([field('text')]);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('No comments yet.')).toBeNull();
  });

  it('downloads the record as a Word document from its menu, with comments when asked', async () => {
    const { fixture, recordId } = await mountCard({ role: 'reader' });
    const saved: string[] = [];
    const asked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:record');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let answer: Response = new Response(
      JSON.stringify({ error: { code: 'not_found', messageKey: 'errors.notFound', userFault: true } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        asked.push(path);
        return answer;
      }),
    );
    try {
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'More for this record' }));
      await user.click(screen.getByRole('menuitem', { name: /^Download as Word(?: |$)/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Download as Word' });
      const comments = within(dialog).getByRole('checkbox', { name: 'Include comments' });
      expect(comments).toHaveProperty('checked', false);
      await user.click(comments);
      // A refusal says why and leaves the dialog open to try again.
      await user.click(within(dialog).getByRole('button', { name: 'Download' }));
      expect(await within(dialog).findByText('That page or item doesn’t exist.')).toBeTruthy();
      answer = new Response('PK', {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'content-disposition': `attachment; filename="Tasks - First.docx"`,
        },
      });
      await user.click(within(dialog).getByRole('button', { name: 'Download' }));
      await waitFor(() => expect(saved).toEqual(['Tasks - First.docx']));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Download as Word' })).toBeNull());
      const url = new URL(asked.at(-1)!, 'http://localhost');
      expect(url.pathname).toBe(`/api/tables/${fixture.tableId}/records/${recordId}/export`);
      expect(url.searchParams.get('format')).toBe('docx');
      expect(url.searchParams.get('comments')).toBe('true');
      expect(url.searchParams.get('locale')).toBe('en-US');
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('offers no Word document on a card read without a session', async () => {
    mount([field('text')]);
    await userEvent.click(screen.getByRole('button', { name: 'More for this record' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Print or save as PDF']);
  });
});

describe('record layouts', () => {
  it.each(['panel', 'page'] as const)('preserves grid focus when the %s unmounts', (layout) => {
    const opener = document.createElement('button');
    const grid = document.createElement('textarea');
    document.body.append(opener, grid);
    try {
      opener.focus();
      const app = mount([field('text')], {}, { layout });
      expect(document.activeElement).toBe(screen.getByRole('region'));
      grid.focus();
      app.unmount();
      expect(document.activeElement).toBe(grid);
    } finally {
      opener.remove();
      grid.remove();
    }
  });

  it.each(['panel', 'page'] as const)(
    'edits in the %s region and leaves grid focus in place when the record changes',
    async (layout) => {
      const item = field('text');
      const app = mount([item], { [item.id]: 'First' }, { layout, fullPageHref: '/records/first/page' });
      const region = screen.getByRole('region', { name: 'First' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(region.getAttribute('aria-modal')).toBeNull();
      expect(document.activeElement).toBe(region);
      const link = within(region).getByRole('link', { name: 'Open in new window' });
      expect(link.getAttribute('href')).toBe('/records/first/page');
      expect(link.getAttribute('target')).toBe('_blank');
      const user = userEvent.setup();
      const input = within(region).getByRole('textbox', { name: 'text' });
      await user.clear(input);
      await user.type(input, 'Changed{Enter}');
      expect(app.onChange).toHaveBeenLastCalledWith(item.id, 'Changed');
      const grid = document.createElement('textarea');
      document.body.append(grid);
      try {
        grid.focus();
        app.rerender(
          <I18nProvider i18n={app.i18n}>
            <RecordCard
              {...app.props}
              row={{ ...row, id: 'rec00000000000002', values: { [item.id]: 'Second' } }}
            />
          </I18nProvider>,
        );
        await waitFor(() => expect(screen.getByRole('region', { name: 'Second' })).toBeTruthy());
        expect(document.activeElement).toBe(grid);
        expect((screen.getByRole('textbox', { name: 'text' }) as HTMLInputElement).value).toBe('Second');
        screen.getByRole('region', { name: 'Second' }).focus();
        await user.keyboard('{Escape}');
        expect(app.onClose).toHaveBeenCalledOnce();
      } finally {
        grid.remove();
      }
    },
  );

  it('offers both saved layouts and resizes the panel within its limits with the keyboard', async () => {
    const onLayoutChange = vi.fn();
    mount([field('text')], {}, { layout: 'panel', onLayoutChange });
    const user = userEvent.setup();
    const resize = screen.getByRole('separator', { name: 'Resize record panel' });
    resize.focus();
    const minimum = Number(resize.getAttribute('aria-valuemin'));
    const maximum = Number(resize.getAttribute('aria-valuemax'));
    await user.keyboard('{ArrowLeft}');
    expect(Number(resize.getAttribute('aria-valuenow'))).toBe(Math.min(minimum + 4, maximum));
    await user.keyboard('{End}{ArrowLeft}');
    expect(Number(resize.getAttribute('aria-valuenow'))).toBe(maximum);
    await user.keyboard('{Home}{ArrowRight}');
    expect(Number(resize.getAttribute('aria-valuenow'))).toBe(minimum);
    await user.click(screen.getByRole('button', { name: 'Record layout' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Card' }));
    expect(onLayoutChange).toHaveBeenCalledWith('card');
  });

  it('fits the panel into a narrow workspace and restores its minimum when space returns', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
    mount([field('text')], {}, { layout: 'panel' });
    const resize = screen.getByRole('separator', { name: 'Resize record panel' });
    const minimum = Number(resize.getAttribute('aria-valuemin'));
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: minimum / 2 });
      fireEvent(window, new Event('resize'));
      expect(Number(resize.getAttribute('aria-valuemin'))).toBe(minimum / 2);
      expect(Number(resize.getAttribute('aria-valuenow'))).toBe(minimum / 2);
      Object.defineProperty(window, 'innerWidth', original);
      fireEvent(window, new Event('resize'));
      expect(Number(resize.getAttribute('aria-valuemin'))).toBe(minimum);
      expect(Number(resize.getAttribute('aria-valuenow'))).toBe(minimum);
    } finally {
      Object.defineProperty(window, 'innerWidth', original);
    }
  });

  it.each(['panel', 'page'] as const)('keeps read-only fields read-only in the %s', (layout) => {
    const item = field('text');
    mount([item], { [item.id]: 'Restricted' }, { layout, readOnly: true });
    expect(screen.getByRole('region', { name: 'Restricted' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
