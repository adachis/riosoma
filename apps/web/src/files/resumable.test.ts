import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Api from '../api';
import { newId } from '@riosoma/contracts';
import { pendingUploads, resumableUpload, type SavedUpload } from './resumable';

vi.mock('../api', async (original) => {
  const actual = await original<typeof Api>();
  return { ...actual, currentCsrfToken: () => ['csrf', 'value'].join('-') };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(location?: string) {
  const file = new File([new Uint8Array(9 * 1024 * 1024)], 'resume.bin');
  const tableId = newId('table');
  const fieldId = newId('field');
  const recordId = newId('record');
  const id = newId('attachment');
  const saved: SavedUpload = {
    id: crypto.randomUUID(),
    cell: `${tableId}:${fieldId}:${recordId}`,
    file,
    createdAt: Date.now(),
    ...(location ? { location } : {}),
  };
  const meta = {
    id,
    name: file.name,
    size: file.size,
    type: 'application/octet-stream',
    width: null,
    height: null,
    createdAt: new Date().toISOString(),
    url: `/api/files/${id}/resume.bin`,
    thumbnails: { small: null, large: null },
    scanState: 'quarantined',
  };
  return { tableId, fieldId, recordId, saved, meta };
}

/**
 * A stand-in for the browser's storage, which keeps a copy of each upload by its ID.  Like Firefox,
 * it can no longer read a file it handed back once that file's upload is stored again, and it
 * counts each piece of such a file taken to send, since that browser stalls sending it.
 */
function storage(...kept: SavedUpload[]) {
  const records = new Map(kept.map((upload) => [upload.id, { ...upload }]));
  const memory = { puts: [] as object[], unreadable: 0 };
  const handedOut = new Map<string, Array<{ stale: boolean }>>();
  class StoredFile extends File {
    stale = false;
    override slice(start?: number, end?: number, contentType?: string): Blob {
      if (this.stale) memory.unreadable++;
      return super.slice(start, end, contentType);
    }
  }
  const handOut = (record?: SavedUpload) => {
    if (!record) return undefined;
    const file = new StoredFile([record.file], record.file.name, { type: record.file.type });
    handedOut.set(record.id, [...(handedOut.get(record.id) ?? []), file]);
    return { ...record, file };
  };
  const request = (result?: unknown) => ({ result });
  const database = {
    transaction() {
      const transaction = {
        oncomplete: null as null | (() => void),
        onabort: null,
        onerror: null,
        objectStore: () => ({
          put: (value: SavedUpload) => {
            memory.puts.push({ ...value });
            for (const file of handedOut.get(value.id) ?? []) file.stale = true;
            handedOut.delete(value.id);
            records.set(value.id, { ...value });
            return request(value.id);
          },
          get: (id: string) => request(handOut(records.get(id))),
          delete: (id: string) => request(records.delete(id)),
          getAll: () => request([...records.values()].map(handOut)),
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
    close() {},
  };
  vi.stubGlobal('indexedDB', {
    open() {
      const opening = { result: database, onsuccess: null as null | (() => void), onerror: null };
      queueMicrotask(() => opening.onsuccess?.());
      return opening;
    },
  });
  return memory;
}

/** A server that has the first `from` bytes of an upload, and takes the rest. */
function resumingServer(meta: object, from: number) {
  let offset = from;
  return vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'HEAD') return new Response(null, { headers: { 'upload-offset': String(offset) } });
    if (init.method === 'PATCH') {
      offset += (init.body as Blob).size;
      return new Response(null, { status: 204, headers: { 'upload-offset': String(offset) } });
    }
    return Response.json([meta]);
  });
}

describe('resumable file transport', () => {
  it('creates an upload for the record and reports progress for bounded chunks', async () => {
    const f = fixture();
    let offset = 0;
    const sizes: number[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get('x-csrf-token')).toBe(['csrf', 'value'].join('-'));
      if (init.method === 'POST') {
        expect(url).toBe(`/api/tables/${f.tableId}/fields/${f.fieldId}/records/${f.recordId}/uploads`);
        return new Response(null, { status: 201, headers: { location: `/api/uploads/${f.meta.id}` } });
      }
      if (init.method === 'HEAD') return new Response(null, { headers: { 'upload-offset': String(offset) } });
      if (init.method === 'PATCH') {
        expect(Number(headers.get('upload-offset'))).toBe(offset);
        const size = (init.body as Blob).size;
        sizes.push(size);
        offset += size;
        return new Response(null, { status: 204, headers: { 'upload-offset': String(offset) } });
      }
      return Response.json([f.meta]);
    });
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    expect(await resumableUpload(f.tableId, f.fieldId, f.recordId, f.saved, progress)).toMatchObject(f.meta);
    expect(sizes).toEqual([4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024]);
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it('resumes a saved upload and asks the server again after a lost chunk response', async () => {
    vi.useFakeTimers();
    const f = fixture(`/api/uploads/${newId('attachment')}`);
    let offset = 4 * 1024 * 1024;
    let interrupted = false;
    const positions: number[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).not.toBe('POST');
      if (init.method === 'HEAD') return new Response(null, { headers: { 'upload-offset': String(offset) } });
      if (init.method === 'PATCH') {
        positions.push(Number(new Headers(init.headers).get('upload-offset')));
        offset += (init.body as Blob).size;
        if (!interrupted) {
          interrupted = true;
          throw new TypeError('Connection lost');
        }
        return new Response(null, { status: 204, headers: { 'upload-offset': String(offset) } });
      }
      return Response.json([f.meta]);
    });
    vi.stubGlobal('fetch', fetcher);
    const result = resumableUpload(f.tableId, f.fieldId, f.recordId, f.saved, () => undefined);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject(f.meta);
    expect(positions).toEqual([4 * 1024 * 1024, 8 * 1024 * 1024]);
  });

  it('stops immediately when edit permission is revoked', async () => {
    const f = fixture(`/api/uploads/${newId('attachment')}`);
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true } },
        { status: 403 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      resumableUpload(f.tableId, f.fieldId, f.recordId, f.saved, () => undefined),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a new upload, with its address once the server gives one', async () => {
    const memory = storage();
    const f = fixture();
    const server = resumingServer(f.meta, 0);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
      init.method === 'POST'
        ? new Response(null, { status: 201, headers: { location: `/api/uploads/${f.meta.id}` } })
        : server(url, init),
    );
    await resumableUpload(f.tableId, f.fieldId, f.recordId, f.saved, () => undefined);
    expect(memory.puts.at(-1)).toMatchObject({ id: f.saved.id, location: `/api/uploads/${f.meta.id}` });
  });

  it('resumes a restored upload the server still has, without storing it again', async () => {
    const f = fixture(`/api/uploads/${newId('attachment')}`);
    const memory = storage(f.saved);
    const [restored] = await pendingUploads(f.saved.cell);
    expect(restored).toMatchObject({ id: f.saved.id, location: f.saved.location });
    vi.stubGlobal('fetch', resumingServer(f.meta, 4 * 1024 * 1024));
    expect(await resumableUpload(f.tableId, f.fieldId, f.recordId, restored!, () => undefined)).toMatchObject(
      f.meta,
    );
    expect(memory.puts).toHaveLength(0);
    expect(memory.unreadable).toBe(0);
  });

  it('stores the new address of a restored upload the server lost, so a second reload resumes there', async () => {
    vi.useFakeTimers();
    const MB = 1024 * 1024;
    const f = fixture(`/api/uploads/${newId('attachment')}`);
    const lost = f.saved.location!;
    const address = `/api/uploads/${f.meta.id}`;
    const memory = storage(f.saved);
    let calls: string[] = [];
    let offset = 0;
    let reloaded = false;
    // The server no longer has the first address, so the upload starts again at a new one.  The
    // first page stops as its second piece goes out, the way a reload stops it.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST') return new Response(null, { status: 201, headers: { location: address } });
      if (url === lost) return new Response(null, { status: 404 });
      if (method === 'HEAD') return new Response(null, { headers: { 'upload-offset': String(offset) } });
      if (method === 'PATCH') {
        if (!reloaded && offset > 0) return new Promise<Response>(() => undefined);
        expect(Number(new Headers(init.headers).get('upload-offset'))).toBe(offset);
        offset += (init.body as Blob).size;
        return new Response(null, { status: 204, headers: { 'upload-offset': String(offset) } });
      }
      return Response.json([f.meta]);
    });

    const [first] = await pendingUploads(f.saved.cell);
    void resumableUpload(f.tableId, f.fieldId, f.recordId, first!, () => undefined);
    await vi.runAllTimersAsync();
    expect(calls).toEqual([
      `HEAD ${lost}`,
      `POST /api/tables/${f.tableId}/fields/${f.fieldId}/records/${f.recordId}/uploads`,
      `HEAD ${address}`,
      `PATCH ${address}`,
      `PATCH ${address}`,
    ]);
    expect(offset).toBe(4 * MB);

    reloaded = true;
    calls = [];
    const [second] = await pendingUploads(f.saved.cell);
    expect(second?.location).toBe(address);
    const result = resumableUpload(f.tableId, f.fieldId, f.recordId, second!, () => undefined);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject(f.meta);
    expect(calls).toEqual([
      `HEAD ${address}`,
      `PATCH ${address}`,
      `PATCH ${address}`,
      `GET /api/files?ids=${f.meta.id}`,
    ]);
    expect(offset).toBe(f.saved.file.size);
    expect(memory.puts.length).toBeGreaterThan(0);
    expect(memory.puts.filter((upload) => 'restored' in upload)).toEqual([]);
    expect(memory.unreadable).toBe(0);
  });
});
