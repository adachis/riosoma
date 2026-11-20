import { AttachmentMeta, ErrorBody } from '@riosoma/contracts';
import { ApiError, currentCsrfToken } from '../api';

export interface SavedUpload {
  id: string;
  cell: string;
  file: File;
  location?: string;
  createdAt: number;
  /** Read back from storage after a reload.  This flag itself is never stored. */
  restored?: boolean;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('riosoma-uploads', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('uploads', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function stored<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('uploads', mode);
      const request = work(transaction.objectStore('uploads'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
export async function saveUpload(upload: SavedUpload): Promise<void> {
  const { restored, ...record } = upload;
  const kept = await stored<SavedUpload | undefined>('readwrite', (store) => {
    store.put(record);
    return store.get(record.id);
  });
  // Once an upload is stored again, Firefox can no longer read a file that was read back from
  // storage before, and sending it stalls.  A restored upload carries on with the copy just stored.
  if (restored && kept) upload.file = kept.file;
}
export async function forgetUpload(id: string): Promise<void> {
  await stored('readwrite', (store) => store.delete(id));
}
export async function pendingUploads(cell: string): Promise<SavedUpload[]> {
  const uploads = await stored<SavedUpload[]>('readonly', (store) => store.getAll());
  const current: SavedUpload[] = [];
  for (const upload of uploads) {
    if (Date.now() - upload.createdAt >= 86_400_000) await forgetUpload(upload.id);
    else if (upload.cell === cell) current.push({ ...upload, restored: true });
  }
  return current;
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('tus-resumable', '1.0.0');
  const csrf = currentCsrfToken();
  if (csrf) headers.set('x-csrf-token', csrf);
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = ErrorBody.safeParse(await response.json().catch(() => null));
    throw new ApiError(
      response.status,
      body.success
        ? body.data.error
        : {
            code: 'unavailable',
            messageKey: 'errors.offline',
            userFault: false,
          },
    );
  }
  return response;
}
function offsetOf(response: Response, size: number): number {
  const value = response.headers.get('upload-offset');
  const offset = Number(value);
  if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(offset) || offset > size)
    throw new Error('Invalid upload offset');
  return offset;
}

export async function resumableUpload(
  tableId: string,
  fieldId: string,
  recordId: string,
  saved: SavedUpload,
  progress: (percent: number) => void,
): Promise<AttachmentMeta> {
  // Storing an upload again can swap in a new copy of its file, so each piece reads `saved.file`.
  const { name, size } = saved.file;
  // Persistence can be unavailable in private browsing or when the device has no free space.
  const remember = () => saveUpload(saved).catch(() => undefined);
  // A restored upload is already stored as it is.
  if (!saved.restored) await remember();
  let offset: number;
  let failures = 0;
  for (;;) {
    try {
      if (!saved.location) {
        const bytes = new TextEncoder().encode(name);
        const metadata = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
        const created = await request(
          `/api/tables/${tableId}/fields/${fieldId}/records/${recordId}/uploads`,
          {
            method: 'POST',
            headers: { 'upload-length': String(size), 'upload-metadata': `filename ${metadata}` },
          },
        );
        const location = created.headers.get('location');
        if (!location || !/^\/api\/uploads\/att[0-9A-Za-z]{14}$/.test(location))
          throw new Error('Invalid upload location');
        saved.location = location;
        await remember();
      }
      try {
        offset = offsetOf(await request(saved.location, { method: 'HEAD' }), size);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
          delete saved.location;
          await remember();
        }
        throw error;
      }
      progress((offset / size) * 100);
      while (offset < size) {
        const response = await request(saved.location, {
          method: 'PATCH',
          headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
          body: saved.file.slice(offset, offset + 4 * 1024 * 1024),
        });
        const next = offsetOf(response, size);
        if (next <= offset) throw new Error('Upload made no progress');
        offset = next;
        failures = 0;
        progress((offset / size) * 100);
      }
      const id = saved.location.split('/').at(-1)!;
      const response = await request(`/api/files?ids=${id}`);
      const files = AttachmentMeta.array().parse(await response.json());
      if (!files[0]) throw new Error('Completed upload is unavailable');
      return files[0];
    } catch (error) {
      if (error instanceof ApiError && [400, 401, 403, 413, 415].includes(error.status)) throw error;
      if (++failures > 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(16_000, 500 * 2 ** failures)));
    }
  }
}
