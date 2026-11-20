import { i18n } from '@lingui/core';
import { idsOf, newId } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../api';
import { openDatabase, type DatabaseSession } from '../data';
import { settle } from '../data/testing/relational';
import { createCellRenderer } from '../grid/cells/renderers';
import { FIELD_TYPE_INFO } from '../screens/database/fields/fieldTypes';
import { createGridController } from '../grid/view/controller';
import type { GridSelection } from '../../../../packages/grid-core/src/types';
import { copyCells } from '../grid/clipboard/copy';
import { planPaste } from '../grid/clipboard/plan';
import { readClipboard } from '../grid/clipboard/read';
import { writeClipboard } from '../grid/clipboard/write';
import { readAttachmentClipboard, writeAttachmentClipboard } from './clipboard';
import { fileKind, fileSize } from './fileKind';
import { attachment, attachmentFixture, MockUpload } from './testing';
import { AttachmentUploads, FileTooLarge, uploadFile } from './upload';

const sessions: DatabaseSession[] = [];
async function setup(files = [attachment()]) {
  const f = attachmentFixture(files);
  const session = await openDatabase(f.source.databaseId, f.deps);
  sessions.push(session);
  const view = session.openView(f.source.viewId);
  await settle();
  return { ...f, session, view, row: () => view.getRow(0)! };
}
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('attachment details', () => {
  it('keeps page details for the session, isolated from other sessions', async () => {
    const file = attachment();
    const f = await setup([file]);
    expect(f.session.attachments.get(file.id)).toEqual(file);
    f.view.close();
    expect(f.session.attachments.get(file.id)).toEqual(file);
    const second = await openDatabase(f.source.databaseId, f.deps);
    sessions.push(second);
    expect(second.attachments.size).toBe(0);
    expect(f.lookups).toEqual([]);
  });
  it('debounces remote unknown IDs for 50 ms, batches 200, and redraws after details arrive', async () => {
    vi.useFakeTimers();
    const f = await setup([]);
    const files = Array.from({ length: 405 }, () => attachment());
    files.forEach((file) => f.details.set(file.id, file));
    const listener = vi.fn();
    f.view.subscribe(listener);
    f.server.remote(f.source.databaseId, [
      {
        kind: 'record.update',
        tableId: f.source.tableId,
        records: [{ id: f.row().id, values: { [f.field.id]: files.map((file) => file.id) } }],
      },
    ]);
    await settle();
    f.session.ensureAttachments(files.map((file) => file.id));
    await vi.advanceTimersByTimeAsync(49);
    expect(f.lookups).toEqual([]);
    const before = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(f.lookups.map((ids) => ids.length)).toEqual([200, 200, 5]);
    expect(f.session.attachments.size).toBe(405);
    expect(listener.mock.calls.length).toBeGreaterThan(before);
    f.session.ensureAttachments(files.map((file) => file.id));
    await vi.advanceTimersByTimeAsync(50);
    expect(f.lookups).toHaveLength(3);
  });
  it('does not fetch after the session closes', async () => {
    vi.useFakeTimers();
    const f = await setup([]);
    f.session.ensureAttachments([newId('attachment')]);
    f.session.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.lookups).toEqual([]);
  });
});

describe('upload batches', () => {
  it('sends raw files with progress and CSRF, runs two at a time, and appends once with one undo', async () => {
    MockUpload.install();
    setCsrfToken('csrf-value');
    const existing = attachment('Existing.txt', 'text/plain');
    const f = await setup([existing]);
    const uploads = new AttachmentUploads(f.session, f.source.tableId, f.field.id, f.row().id);
    const files = ['First space.png', 'Second.png', 'Third.png'].map((name) => new File(['image'], name));
    const metas = files.map((file) => attachment(file.name));
    uploads.add(files);
    expect(MockUpload.requests).toHaveLength(2);
    const first = MockUpload.requests[0]!;
    expect(first.method).toBe('POST');
    expect(first.url).toBe(`/api/tables/${f.source.tableId}/fields/${f.field.id}/files`);
    expect(first.headers.get('x-file-name')).toBe('First%20space.png');
    expect(first.headers.get('x-csrf-token')).toBe('csrf-value');
    expect(first.body).toBe(files[0]);
    first.progress(5, 10);
    expect(uploads.snapshot()[0]?.progress).toBe(50);
    MockUpload.requests[1]!.respond(metas[1]);
    await settle();
    expect(MockUpload.requests).toHaveLength(3);
    expect(f.session.canUndo()).toBe(false);
    // Another edit while uploading must be retained by the final append.
    const remote = attachment('Remote.txt', 'text/plain');
    f.server.remote(f.source.databaseId, [
      {
        kind: 'record.update',
        tableId: f.source.tableId,
        records: [{ id: f.row().id, values: { [f.field.id]: [existing.id, remote.id] } }],
      },
    ]);
    await settle();
    MockUpload.requests[2]!.respond(metas[2]);
    first.respond(metas[0]);
    await settle();
    expect(f.row().values[f.field.id]).toEqual([existing.id, remote.id, ...metas.map((file) => file.id)]);
    expect(uploads.snapshot()).toEqual([]);
    const batches = f.server.requests.filter((request) => request.path.endsWith('/commands'));
    expect(batches).toHaveLength(1);
    expect(batches[0]?.options.body).toMatchObject({ commands: [{ kind: 'record.update' }] });
    await f.session.undo();
    await settle();
    expect(f.row().values[f.field.id]).toEqual([existing.id, remote.id]);
    expect(f.session.canUndo()).toBe(false);
  });
  it('passes multi-gigabyte uploads to the server without a fixed browser cap', async () => {
    MockUpload.install();
    const file = new File(['x'], 'Large.zip');
    Object.defineProperty(file, 'size', { value: 3 * 1024 ** 3 });
    const pending = uploadFile(newId('table'), newId('field'), file, vi.fn());
    expect(MockUpload.requests).toHaveLength(1);
    MockUpload.requests[0]!.respond(attachment('Large.zip'));
    await expect(pending).resolves.toMatchObject({ name: 'Large.zip' });
  });
  it('uses the server upload cap, exposes failure reasons, retries and dismisses', async () => {
    MockUpload.install();
    const f = await setup([]);
    const uploads = new AttachmentUploads(f.session, f.source.tableId, f.field.id, f.row().id);
    const big = new File(['x'], 'Large.zip');
    const refused = uploadFile(f.source.tableId, f.field.id, big, vi.fn());
    expect(MockUpload.requests).toHaveLength(1);
    MockUpload.requests[0]!.respond({}, 413);
    await expect(refused).rejects.toBeInstanceOf(FileTooLarge);
    uploads.add([big, new File(['x'], 'Retry.txt')]);
    MockUpload.requests[1]!.respond({}, 413);
    MockUpload.requests[2]!.respond(
      { error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false } },
      503,
    );
    await settle();
    expect(uploads.snapshot().map((entry) => entry.status)).toEqual(['failed', 'failed']);
    expect(uploads.snapshot()[1]?.error).toMatchObject({ info: { messageKey: 'errors.offline' } });
    uploads.dismiss(uploads.snapshot()[0]!.id);
    uploads.retry(uploads.snapshot()[0]!.id);
    expect(MockUpload.requests).toHaveLength(4);
    const file = attachment('Retry.txt', 'text/plain');
    MockUpload.requests[3]!.respond(file);
    await settle();
    expect(f.row().values[f.field.id]).toEqual([file.id]);
    expect(uploads.snapshot()).toEqual([]);
  });
});

describe('attachment cells and clipboard', () => {
  it('offers attachment immediately after Long text', () => {
    const types = FIELD_TYPE_INFO.map((info) => info.type);
    expect(types[types.indexOf('longText') + 1]).toBe('attachment');
  });
  it('wires grid clipboard text and same-field ID pasting through the data session', async () => {
    const file = attachment();
    const f = await setup([file]);
    const schema = f.session.getSchema();
    const controller = createGridController(
      {
        session: f.session,
        rows: f.view,
        table: schema.tableById.get(f.source.tableId)!,
        view: schema.viewById.get(f.source.viewId)!,
        fields: schema.fields.get(f.source.tableId)!,
        format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
        peers: [],
        onConfig: vi.fn(),
        onExpand: vi.fn(),
        onField: vi.fn(),
        onMenu: vi.fn(),
        onPreview: vi.fn(),
      },
      new AbortController().signal,
    );
    const col = controller.columns().findIndex((column) => column.id === f.field.id);
    const selection = (row: number): GridSelection => ({
      active: { row, col },
      range: { start: { row, col }, end: { row, col } },
      rows: { kind: 'none' },
    });
    const copied = controller.host.copy?.(selection(0));
    expect(copied?.text).toContain(file.name);
    expect(copied?.text).not.toContain(file.id);
    controller.host.paste?.(selection(1), { text: copied!.text, html: copied!.html ?? null });
    await settle();
    expect(f.view.getRow(1)?.values[f.field.id]).toEqual([file.id]);
    await f.session.undo();
    await settle();
    expect(idsOf(f.view.getRow(1)?.values[f.field.id] ?? null)).toEqual([]);
  });

  it('draws thumbnails, typed icons, placeholders, overflow and resolved details', async () => {
    const files = [
      attachment(),
      attachment('Guide.pdf', 'application/pdf'),
      attachment('Song.mp3', 'audio/mpeg'),
    ];
    const f = await setup(files);
    const unknown = newId('attachment');
    const row = { ...f.row(), values: { [f.field.id]: [...files.map((file) => file.id), unknown] } };
    const el = document.createElement('div');
    const renderer = createCellRenderer({
      fieldsById: new Map([[f.field.id, f.field]]),
      session: f.session,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
      rowHeight: 'short',
    });
    const draw = (width: number) =>
      renderer(el, {
        row,
        rowIndex: 0,
        colIndex: 0,
        column: { id: f.field.id, edit: 'custom', width },
        active: false,
        selected: false,
      });
    draw(200);
    expect(el.querySelector('img')?.getAttribute('src')).toBe(files[0]!.thumbnails.small);
    expect(el.querySelector('[data-kind="pdf"]')).toBeTruthy();
    expect(el.querySelector('[data-kind="audio"]')).toBeTruthy();
    expect(el.querySelector('[data-placeholder]')).toBeTruthy();
    f.session.rememberAttachments({ [unknown]: { ...attachment('Known.txt', 'text/plain'), id: unknown } });
    draw(200);
    expect(el.querySelector('[data-placeholder]')).toBeNull();
    expect(el.querySelector('[aria-label="Known.txt"]')).toBeTruthy();
    draw(100);
    expect(el.querySelectorAll('.rio-cell-file')).toHaveLength(1);
    expect(el.textContent).toBe('+3');
  });
  it.each([
    ['Book.docx', 'application/octet-stream', 'document'],
    ['Sheet.xlsx', 'application/octet-stream', 'spreadsheet'],
    ['Slides.pptx', 'application/octet-stream', 'presentation'],
    ['Archive.zip', 'application/zip', 'archive'],
    ['Movie.mp4', 'video/mp4', 'video'],
    ['Unknown.bin', 'application/octet-stream', 'file'],
  ])('classifies %s', (name, type, kind) => expect(fileKind({ name, type })).toBe(kind));
  it('uses localized byte units', () => {
    expect(fileSize(1500, 'en-US')).toBe(
      new Intl.NumberFormat('en-US', {
        style: 'unit',
        unit: 'kilobyte',
        unitDisplay: 'short',
        maximumFractionDigits: 1,
      }).format(1.5),
    );
    expect(fileSize(1500, 'de')).toContain('1,5');
  });
  it('copies names and preserves IDs only for the same attachment field', async () => {
    const files = [attachment('One.png'), attachment('Two.png')];
    const f = await setup(files);
    const fields = [f.field];
    const format = {
      locale: 'en-US',
      timeZone: 'UTC',
      collaborators: new Map(),
      attachments: f.session.attachments,
    };
    const cells = copyCells({ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, fields, f.row, format);
    expect(cells).toEqual([['One.png, Two.png']]);
    const data = writeAttachmentClipboard(writeClipboard(cells), fields, [f.row()]);
    const input = {
      cells: readClipboard(data),
      attachments: readAttachmentClipboard(data.html),
      start: { row: 0, col: 0 },
      selection: { rows: 1, cols: 1 },
      fields,
      rowCount: 3,
      rowIdAt: () => f.row().id,
      context: format,
    };
    expect(planPaste(input).updates[0]?.values[f.field.id]).toEqual(files.map((file) => file.id));
    const other = { ...f.field, id: newId('field') };
    expect(planPaste({ ...input, fields: [other] }).updates).toEqual([]);
    expect(
      readAttachmentClipboard(
        '<table><tr><td data-rio-file-field="x" data-rio-file-ids="[1]">bad</td></tr></table>',
      ),
    ).toEqual([[null]]);
  });
});
