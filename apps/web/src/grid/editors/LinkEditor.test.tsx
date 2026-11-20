import { i18n } from '@lingui/core';
import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { idsOf } from '@riosoma/contracts';
import { openDatabase, type DatabaseSession } from '../../data';
import { FakeServer } from '../../data/testing';
import { relationalFixture, settle } from '../../data/testing/relational';
import { renderField } from '../../screens/database/fields/fieldTestUtils';
import { LinkEditor, LinkPicker, createLinkedRecord } from './LinkEditor';
import { mountEditor } from './mountEditor';
import { dragItem } from '../../test/sortable';
import type { EditorProps } from './types';

const sessions: DatabaseSession[] = [];
const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => act(dispose));
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.useRealTimers();
});
async function setup(single = false) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const view = session.openView(f.source.viewId);
  await settle();
  if (f.link.type !== 'link') throw new Error('Expected link');
  const field = { ...f.link, options: { ...f.link.options, prefersSingle: single } };
  const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map(), linked: session.linked };
  return { ...f, field, format, server, session, view };
}

describe('link editing', () => {
  it('gives records with a blank primary field an accessible name', async () => {
    const f = await setup();
    await act(async () => {
      await f.session.run([
        {
          kind: 'record.update',
          tableId: f.tableId,
          records: [{ id: f.recordIds[0]!, values: { [f.title.id]: '' } }],
        },
      ]).done;
    });
    const changed = vi.fn();
    renderField(
      <LinkPicker field={f.field} selected={[]} session={f.session} format={f.format} onChange={changed} />,
    );
    await userEvent.click(await screen.findByRole('option', { name: /^Untitled record(?: |$)/ }));
    expect(changed).toHaveBeenCalledWith([f.recordIds[0]]);
  });

  it('searches a chosen extra field and previews a result when reached with the arrow keys', async () => {
    const f = await setup();
    const options = { ...f.field.options, displayFieldIds: [f.price.id] };
    await act(async () => {
      await f.session.run([{ kind: 'field.update', fieldId: f.field.id, options }]).done;
    });
    const changed = vi.fn();
    renderField(
      <LinkPicker
        field={{ ...f.field, options }}
        selected={[]}
        session={f.session}
        format={f.format}
        onChange={changed}
      />,
    );
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: '2' } });
    const option = await screen.findByRole('option', { name: /^Beta(?: |$)/ });
    expect(option.textContent).toContain('Price');
    await userEvent.click(search);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(option);
    expect(screen.getByRole('complementary', { name: 'Record preview' }).textContent).toContain('Price');
    await userEvent.keyboard('{Enter}');
    expect(changed).toHaveBeenCalledWith([f.recordIds[1]]);
  });

  it('tabs into the grid preview, returns to the result, and leaves for the next cell', async () => {
    const f = await setup();
    const finished = vi.fn();
    renderField(
      <LinkPicker
        field={f.field}
        selected={[]}
        session={f.session}
        format={f.format}
        onChange={vi.fn()}
        onFinish={finished}
      />,
    );
    const option = await screen.findByRole('option', { name: /^Alpha(?: |$)/ });
    await userEvent.click(screen.getByRole('searchbox'));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(option);
    const preview = screen.getByRole('complementary', { name: 'Record preview' });
    await userEvent.tab();
    expect(document.activeElement).toBe(preview);
    expect(finished).not.toHaveBeenCalled();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(preview);
    expect(preview.scrollTop).toBeGreaterThan(0);
    await userEvent.keyboard('{ArrowUp}');
    expect(preview.scrollTop).toBe(0);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(option);
    expect(finished).not.toHaveBeenCalled();
    await userEvent.tab();
    await userEvent.tab();
    expect(finished).toHaveBeenCalledExactlyOnceWith('next');
  });
  it('leaves for the previous cell when Shift+Tab exits the first control', async () => {
    const f = await setup();
    const finished = vi.fn();
    renderField(
      <LinkPicker
        field={f.field}
        selected={[]}
        session={f.session}
        format={f.format}
        onChange={vi.fn()}
        onFinish={finished}
      />,
    );
    await screen.findByRole('option', { name: /^Alpha(?: |$)/ });
    await userEvent.click(screen.getByRole('searchbox'));
    await userEvent.tab({ shift: true });
    expect(finished).toHaveBeenCalledExactlyOnceWith('previous');
  });
  it('preserves every selected identifier while dropping a linked record into a new position', async () => {
    const f = await setup();
    const changed = vi.fn();
    renderField(
      <LinkPicker
        field={f.field}
        selected={f.recordIds.slice(0, 3)}
        format={f.format}
        session={f.session}
        onChange={changed}
      />,
    );
    await dragItem(
      await screen.findByRole('button', { name: 'Move Alpha' }),
      await screen.findByRole('button', { name: 'Move Gamma' }),
      0.95,
      () => expect(changed).not.toHaveBeenCalled(),
    );
    expect(changed).toHaveBeenCalledExactlyOnceWith([f.recordIds[1], f.recordIds[2], f.recordIds[0]]);
  });

  it('debounces search, adds, removes, and reorders pills by keyboard', async () => {
    const f = await setup();
    const changed = vi.fn();
    function Picker() {
      const [selected, setSelected] = useState(f.recordIds.slice(0, 2));
      return (
        <LinkPicker
          field={f.field}
          selected={selected}
          format={f.format}
          session={f.session}
          onChange={(ids) => {
            changed(ids);
            setSelected(ids);
          }}
        />
      );
    }
    renderField(<Picker />);
    const removeBeta = screen.getByRole('button', { name: 'Remove Beta' });
    removeBeta.focus();
    fireEvent.keyDown(removeBeta, { key: 'ArrowLeft', altKey: true });
    expect(changed).toHaveBeenLastCalledWith([f.recordIds[1], f.recordIds[0]]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(changed).toHaveBeenLastCalledWith([f.recordIds[1]]);
    vi.useFakeTimers();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'G' } });
    fireEvent.change(search, { target: { value: 'Ga' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    // Only searches for what was typed count: one for the empty query may already be under way.
    const typed = () =>
      f.server.requests
        .filter((request) => /\/link-options\?q=G/.test(request.path))
        .map((request) => request.path);
    expect(typed()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(typed()).toEqual([`/api/fields/${f.field.id}/link-options?q=Ga`]);
    vi.useRealTimers();
    await userEvent.click(screen.getByRole('option', { name: /^Gamma(?: |$)/ }));
    expect(changed).toHaveBeenLastCalledWith([f.recordIds[1], f.recordIds[2]]);
    expect(screen.getByRole('button', { name: 'Remove Gamma' })).toBeTruthy();
  });

  it('replaces a single link and ignores stale search responses', async () => {
    const f = await setup(true);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.server.beforeRequest = (request) => (request.path.endsWith('q=Beta') ? blocked : Promise.resolve());
    const changed = vi.fn();
    renderField(
      <LinkPicker
        field={f.field}
        selected={[f.recordIds[0]!]}
        format={f.format}
        session={f.session}
        onChange={changed}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Beta' } });
    await waitFor(() =>
      expect(f.server.requests.some((request) => request.path.endsWith('q=Beta'))).toBe(true),
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Gamma' } });
    await userEvent.click(await screen.findByRole('option', { name: /^Gamma(?: |$)/ }));
    expect(changed).toHaveBeenCalledWith([f.recordIds[2]]);
    await act(async () => {
      release();
      await settle();
    });
    expect(screen.queryByRole('option', { name: /^Beta(?: |$)/ })).toBeNull();
  });

  it('creates and links a new record in one action and undoes both', async () => {
    const f = await setup();
    const row = f.view.getRow(0)!;
    const create = vi.fn((name: string) =>
      createLinkedRecord(f.session, f.field, row.id, name, idsOf(row.values[f.field.id] ?? null), f.format),
    );
    renderField(
      <LinkPicker
        field={f.field}
        selected={f.recordIds.slice(0, 2)}
        format={f.format}
        session={f.session}
        onChange={() => {}}
        onCreate={create}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Delta' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Add new record “Delta”' }));
    await waitFor(() => expect(f.session.saveState().pending).toBe(0));
    const created = create.mock.results[0]?.value;
    expect(created).toBeTruthy();
    expect(f.database.rows(f.tableId).get(created!)?.values[f.title.id]).toBe('Delta');
    expect(f.database.rows(f.source.tableId).get(row.id)?.values[f.field.id]).toEqual([
      ...f.recordIds.slice(0, 2),
      created,
    ]);
    const batch = f.server.requests.find((request) => request.path.endsWith('/commands'))?.options.body as {
      commands: Array<{ kind: string; groupId: string }>;
    };
    expect(batch.commands.map((command) => command.kind)).toEqual(['record.create', 'record.update']);
    expect(new Set(batch.commands.map((command) => command.groupId)).size).toBe(1);
    await act(async () => {
      await f.session.undo();
      await settle();
    });
    expect(f.database.rows(f.tableId).get(created!)).toBeUndefined();
    expect(f.database.rows(f.source.tableId).get(row.id)?.values[f.field.id]).toEqual(
      f.recordIds.slice(0, 2),
    );
  });

  it('opens link cells through mountEditor and dismisses with Escape', async () => {
    const f = await setup();
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const props: EditorProps = {
      request: {
        row: f.view.getRow(0)!,
        cell: { row: 0, col: 0 },
        column: { id: f.field.id, edit: 'custom', width: 180 },
        anchor,
        initialText: null,
        done: vi.fn(),
        cancel: vi.fn(),
      },
      context: {
        field: f.field,
        session: f.session,
        format: f.format,
        canEditOptions: false,
        apply: vi.fn(),
        addOption: () => '',
      },
    };
    await act(async () => {
      disposals.push(mountEditor(props.request, props.context));
    });
    expect(screen.getByRole('searchbox')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(props.request.done).toHaveBeenCalledWith('none');
    act(disposals.pop()!);
    renderField(<LinkEditor {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(props.context.apply).toHaveBeenCalledWith([f.recordIds[1]]);
    anchor.remove();
  });
});
