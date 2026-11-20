import { dragItem } from '../test/sortable';
import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { idsOf } from '@riosoma/contracts';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseSession } from '../data';
import { settle } from '../data/testing/relational';
import { mountEditor } from '../grid/editors/mountEditor';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { RecordOverlay } from '../screens/database/screen/RecordOverlay';
import { RecordCard } from '../screens/database/record/RecordCard';
import { AttachmentPanel } from './AttachmentPanel';
import { AttachmentPreview } from './AttachmentPreview';
import { attachment, attachmentFixture, MockUpload } from './testing';

const sessions: DatabaseSession[] = [];
const disposals: Array<() => void> = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  MockUpload.install();
});
afterEach(() => {
  disposals.splice(0).forEach((dispose) => act(dispose));
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup(files = [attachment('First.png'), attachment('Second.pdf', 'application/pdf')]) {
  const f = attachmentFixture(files);
  const session = await openDatabase(f.source.databaseId, f.deps);
  sessions.push(session);
  const view = session.openView(f.source.viewId);
  await settle();
  const row = view.getRow(0)!;
  const format = {
    locale: 'en-US',
    timeZone: 'UTC',
    collaborators: new Map(),
    attachments: session.attachments,
  };
  return { ...f, files, session, view, row, format };
}
async function panel(readOnly = false, record = false) {
  const f = await setup();
  const changed = vi.fn();
  const previous = vi.fn();
  function Harness() {
    const [row, setRow] = useState(f.row);
    useEffect(
      () =>
        f.session.subscribeRecords(f.source.tableId, () => {
          setRow(f.session.cachedRecord(f.source.tableId, f.row.id)!);
        }),
      [],
    );
    const onChange = (ids: string[]) => {
      changed(ids);
      f.session.run([
        {
          kind: 'record.update',
          tableId: f.source.tableId,
          records: [{ id: row.id, values: { [f.field.id]: ids } }],
        },
      ]);
    };
    return record ? (
      <RecordCard
        fields={[f.field]}
        primaryFieldId={f.field.id}
        row={row}
        session={f.session}
        format={f.format}
        readOnly={readOnly}
        canEditOptions={false}
        position={{ index: 1, total: 3 }}
        onChange={(_field, ids) => onChange(idsOf(ids))}
        onAddOption={() => ''}
        onClose={vi.fn()}
        onPrevious={previous}
      />
    ) : (
      <AttachmentPanel
        field={f.field}
        recordId={row.id}
        ids={idsOf(row.values[f.field.id] ?? null)}
        session={f.session}
        locale="en-US"
        readOnly={readOnly}
        onChange={onChange}
      />
    );
  }
  const rendered = renderField(<Harness />);
  return { ...f, changed, previous, ...rendered };
}

describe('attachment editing', () => {
  it('provides uploads and cached previews through the database screen record overlay', async () => {
    const f = await setup();
    renderField(
      <RecordOverlay
        session={f.session}
        rows={f.view}
        recordId={f.row.id}
        tableId={f.source.tableId}
        fields={[f.field]}
        primaryFieldId={f.source.textFieldId}
        format={f.format}
        onNavigate={vi.fn()}
        onClose={vi.fn()}
        onMissing={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add files' }).hasAttribute('disabled')).toBe(false);
    fireEvent.paste(screen.getByRole('group', { name: 'Files' }), {
      clipboardData: { files: [new File(['x'], 'Overlay.txt')] },
    });
    await act(async () => {
      MockUpload.requests[0]!.respond(attachment('Overlay.txt', 'text/plain'));
      await settle();
    });
    expect(screen.getByRole('button', { name: /^Overlay\.txt/ })).toBeTruthy();
  });

  it.each([false, true])(
    'adds from the picker, drops and pastes files with progress (record card: %s)',
    async (record) => {
      await panel(false, record);
      const input = document.querySelector<HTMLInputElement>('.rio-files input[type="file"]')!;
      const click = vi.spyOn(input, 'click');
      await userEvent.click(screen.getByRole('button', { name: 'Add files' }));
      expect(click).toHaveBeenCalledOnce();
      fireEvent.change(input, { target: { files: [new File(['image'], 'Picked.png')] } });
      expect(MockUpload.requests).toHaveLength(1);
      act(() => MockUpload.requests[0]!.progress(25, 100));
      expect(
        screen.getByRole('progressbar', { name: 'Uploading Picked.png' }).getAttribute('aria-valuenow'),
      ).toBe('25');
      await act(async () => {
        MockUpload.requests[0]!.respond(attachment('Picked.png'));
        await settle();
      });
      expect(screen.getByRole('button', { name: /^Picked\.png/ })).toBeTruthy();
      const target = screen.getByRole('group', { name: 'Files' });
      fireEvent.drop(target, { dataTransfer: { files: [new File(['x'], 'Dropped.txt')] } });
      fireEvent.paste(target, { clipboardData: { files: [new File(['x'], 'Pasted.txt')] } });
      expect(MockUpload.requests).toHaveLength(3);
      await act(async () => {
        MockUpload.requests[1]!.respond(attachment('Dropped.txt', 'text/plain'));
        MockUpload.requests[2]!.respond(attachment('Pasted.txt', 'text/plain'));
        await settle();
      });
      expect(screen.getByRole('button', { name: /^Dropped\.txt/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /^Pasted\.txt/ })).toBeTruthy();
    },
  );
  it('shows upload errors, retries them and dismisses oversized files', async () => {
    const f = await panel();
    const big = new File(['x'], 'Big.zip');
    fireEvent.change(f.container.querySelector('input')!, {
      target: { files: [big, new File(['x'], 'Again.txt')] },
    });
    await act(async () => {
      MockUpload.requests[0]!.respond({}, 413);
      MockUpload.requests[1]!.onerror?.();
      await settle();
    });
    expect(screen.getByText(/Big.zip is larger than/)).toBeTruthy();
    expect(screen.getByText(/Again.txt didn’t upload/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {
      MockUpload.requests[2]!.respond(attachment('Again.txt', 'text/plain'));
      await settle();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Again.txt' })).toBeTruthy();
  });
  it.each([false, true])(
    'reorders by keyboard and dragging, then removes (record card: %s)',
    async (record) => {
      const f = await panel(false, record);
      const first = screen.getByRole('button', { name: /^First\.png/ });
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true });
      expect(f.changed).toHaveBeenLastCalledWith([f.files[1]!.id, f.files[0]!.id]);
      expect(document.activeElement).toBe(first);
      expect(f.previous).not.toHaveBeenCalled();
      fireEvent.keyDown(first, { key: 'ArrowUp', altKey: true });
      expect(f.changed).toHaveBeenLastCalledWith(f.files.map((file) => file.id));
      await dragItem(
        screen.getByRole('button', { name: 'Move First.png' }),
        screen.getByRole('button', { name: 'Move Second.pdf' }),
      );
      expect(f.changed).toHaveBeenLastCalledWith([f.files[1]!.id, f.files[0]!.id]);
      await userEvent.click(screen.getByRole('button', { name: 'Remove First.png' }));
      expect(f.changed).toHaveBeenLastCalledWith([f.files[1]!.id]);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Second\.pdf/ }));
      if (record) expect(document.querySelector('.rio-files')?.getAttribute('data-layout')).toBe('grid');
    },
  );
  it('keeps read-only files previewable and hides mutations', async () => {
    const f = await panel(true, true);
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove First.png' })).toBeNull();
    fireEvent.drop(screen.getByRole('group', { name: 'Files' }), {
      dataTransfer: { files: [new File(['x'], 'Blocked')] },
    });
    expect(MockUpload.requests).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: /^First\.png/ }));
    expect(screen.getByRole('dialog', { name: 'Preview of First.png' })).toBeTruthy();
    expect(f.changed).not.toHaveBeenCalled();
  });
  it('mounts the custom editor, navigates its preview without dismissing it, and restores focus', async () => {
    const f = await setup();
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const done = vi.fn();
    await act(async () => {
      disposals.push(
        mountEditor(
          {
            row: f.row,
            cell: { row: 0, col: 0 },
            column: { id: f.field.id, edit: 'custom', width: 200 },
            anchor,
            initialText: null,
            done,
            cancel: vi.fn(),
          },
          {
            field: f.field,
            session: f.session,
            format: f.format,
            canEditOptions: false,
            apply: vi.fn(),
            addOption: () => '',
          },
        ),
      );
    });
    const trigger = screen.getByRole('button', { name: /^First\.png/ });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Preview of First.png' })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Next file' }));
    expect(screen.getByRole('dialog', { name: 'Preview of Second.pdf' })).toBeTruthy();
    expect(done).not.toHaveBeenCalled();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Preview of First.png' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Preview of First.png' })).toBeNull());
    expect(done).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await userEvent.keyboard('{Escape}');
    expect(done).toHaveBeenCalledWith('none');
    anchor.remove();
  });
});

describe('attachment quarantine', () => {
  it.each(['quarantined', 'unavailable', 'infected', 'too_large'] as const)(
    'shows %s files without opening their bytes',
    async (scanState) => {
      const file = {
        ...attachment('Checked.png'),
        scanState,
        scanSignature: scanState === 'infected' ? 'Test-Signature' : null,
        url: '',
        thumbnails: { small: null, large: null },
      };
      const f = await setup([file]);
      renderField(
        <AttachmentPanel
          field={f.field}
          recordId={f.row.id}
          ids={[file.id]}
          details={new Map([[file.id, file]])}
          locale="en-US"
          readOnly
          onChange={() => undefined}
        />,
      );
      expect(screen.getByRole('button', { name: /^Checked\.png/ }).hasAttribute('disabled')).toBe(true);
      expect(
        screen.getByText(
          scanState === 'infected'
            ? 'Removed: this file contained a virus (Test-Signature)'
            : scanState === 'too_large'
              ? 'Too large to scan—kept in quarantine'
              : 'Checking for viruses',
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('offers an explicitly unscanned download without opening media for an allowed oversized file', () => {
    const file = {
      ...attachment('Large.png'),
      scanState: 'too_large_allowed' as const,
      url: '/api/files/large/Large.png',
      thumbnails: { small: null, large: null },
    };
    renderField(
      <AttachmentPreview
        ids={[file.id]}
        selected={file.id}
        details={new Map([[file.id, file]])}
        onSelect={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Too large to scan—download allowed, unscanned')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(file.url);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open original' })).toBeNull();
  });
});

describe('attachment previews', () => {
  it('navigates every file kind by keyboard and provides the appropriate media or link', async () => {
    const files = [
      attachment('Image.png'),
      attachment('Audio.mp3', 'audio/mpeg'),
      attachment('Video.mp4', 'video/mp4'),
      attachment('Paper.pdf', 'application/pdf'),
      attachment('Notes.txt', 'text/plain'),
      attachment('Bundle.zip', 'application/zip'),
    ];
    const close = vi.fn();
    function Preview() {
      const [selected, setSelected] = useState(files[0]!.id);
      return (
        <AttachmentPreview
          ids={files.map((file) => file.id)}
          selected={selected}
          details={new Map(files.map((file) => [file.id, file]))}
          onSelect={setSelected}
          onClose={close}
        />
      );
    }
    renderField(<Preview />);
    expect(screen.getByRole('img', { name: 'Image.png' }).getAttribute('src')).toBe(
      files[0]!.thumbnails.large,
    );
    expect(screen.getByRole('link', { name: /Open original/ }).getAttribute('href')).toBe(files[0]!.url);
    expect(screen.getByRole('button', { name: 'Previous file' }).hasAttribute('disabled')).toBe(true);
    screen.getByRole('button', { name: 'Next file' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.querySelector('audio[controls]')?.getAttribute('src')).toBe(files[1]!.url);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.querySelector('video[controls]')?.getAttribute('src')).toBe(files[2]!.url);
    // Seeking inside a video must not change the selected file.
    fireEvent.keyDown(document.querySelector('video')!, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'Preview of Video.mp4' })).toBeTruthy();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('link', { name: /Open in a new tab/ }).getAttribute('href')).toBe(files[3]!.url);
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('link', { name: /Open in a new tab/ }).getAttribute('target')).toBe('_blank');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('download')).toBe('Bundle.zip');
    expect(screen.getByRole('button', { name: 'Next file' }).hasAttribute('disabled')).toBe(true);
    const dialog = screen.getByRole('dialog');
    within(dialog).getByRole('button', { name: 'Close' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Preview of Notes.txt' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalled();
  });
});

it('includes the file name and visible size in the preview button name', async () => {
  await panel();
  const trigger = screen.getByRole('button', { name: /^First\.png.*B/ });
  expect(trigger.textContent).toContain('First.png');
  expect(trigger.textContent).toContain('B');
});
