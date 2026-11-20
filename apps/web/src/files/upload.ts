import { AttachmentMeta, ErrorBody, idsOf } from '@riosoma/contracts';
import { ApiError, currentCsrfToken } from '../api';
import type { DatabaseSession } from '../data';
import { importPick, type RemotePick } from './pickers/api';
import { forgetUpload, pendingUploads, resumableUpload, type SavedUpload } from './resumable';

export class FileTooLarge extends Error {}

// A shared queue also bounds uploads when two record panels are open.
let active = 0;
const waiting: Array<() => void> = [];
function schedule<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active++;
      void work()
        .then(resolve, reject)
        .finally(() => {
          active--;
          waiting.shift()?.();
        });
    };
    if (active < 2) start();
    else waiting.push(start);
  });
}

export function uploadFile(
  tableId: string,
  fieldId: string,
  file: File,
  progress: (percent: number) => void,
  recordId?: string,
  saved?: SavedUpload,
): Promise<AttachmentMeta> {
  if (file.size > 8 * 1024 * 1024 && recordId) {
    const upload = saved ?? {
      id: crypto.randomUUID(),
      cell: `${tableId}:${fieldId}:${recordId}`,
      file,
      createdAt: Date.now(),
    };
    return schedule(() => resumableUpload(tableId, fieldId, recordId, upload, progress));
  }
  return schedule(
    () =>
      new Promise<AttachmentMeta>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/tables/${tableId}/fields/${fieldId}/files`);
        if (recordId) xhr.setRequestHeader('x-record-id', recordId);
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        const csrf = currentCsrfToken();
        if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) progress(Math.min(100, (event.loaded / event.total) * 100));
        };
        const offline = () =>
          reject(new ApiError(0, { code: 'unavailable', messageKey: 'errors.offline', userFault: false }));
        xhr.onerror = offline;
        xhr.onabort = offline;
        xhr.ontimeout = offline;
        xhr.onload = () => {
          if (xhr.status === 413) {
            reject(new FileTooLarge());
            return;
          }
          let body: unknown;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            body = null;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            const parsed = AttachmentMeta.safeParse(body);
            if (parsed.success) {
              resolve(parsed.data);
              return;
            }
          }
          const parsed = ErrorBody.safeParse(body);
          reject(
            new ApiError(
              xhr.status,
              parsed.success
                ? parsed.data.error
                : {
                    code: 'internal',
                    messageKey: 'errors.internal',
                    userFault: false,
                  },
            ),
          );
        };
        xhr.send(file);
      }),
  );
}

export interface UploadEntry {
  id: number;
  /** The file's name, for either kind */
  name: string;
  /** A file from this device */
  file?: File;
  /** A file picked in a cloud drive, which the server copies */
  remote?: RemotePick;
  progress: number;
  /** A copy from a drive whose size isn't known yet */
  indeterminate?: boolean;
  status: 'uploading' | 'failed';
  error?: unknown;
  uploaded?: AttachmentMeta;
  saved?: SavedUpload;
}

/** A completed picker/drop/paste batch appends once, using the cell's latest value. */
export class AttachmentUploads {
  private entries: readonly UploadEntry[] = [];
  private nextId = 0;
  private listeners = new Set<() => void>();
  /** Copies from drives that are still going, which Cancel stops */
  private copies = new Map<number, AbortController>();
  constructor(
    private session: DatabaseSession,
    private tableId: string,
    private fieldId: string,
    private recordId: string,
  ) {
    void pendingUploads(`${tableId}:${fieldId}:${recordId}`)
      .then((saved) => {
        const entries = saved.map((upload): UploadEntry => ({
          id: ++this.nextId,
          name: upload.file.name,
          file: upload.file,
          saved: upload,
          progress: 0,
          status: 'uploading',
        }));
        this.entries = [...this.entries, ...entries];
        this.listeners.forEach((listener) => listener());
        void this.batch(entries);
      })
      .catch(() => undefined);
  }
  snapshot = (): readonly UploadEntry[] => this.entries;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(id: number, patch: Partial<UploadEntry>) {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    this.listeners.forEach((listener) => listener());
  }
  dismiss(id: number): void {
    const entry = this.entries.find((entry) => entry.id === id);
    if (entry?.saved) void forgetUpload(entry.saved.id).catch(() => undefined);
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.listeners.forEach((listener) => listener());
  }
  add(files: readonly File[]): void {
    this.start(
      files.map((file): UploadEntry => ({
        id: ++this.nextId,
        name: file.name,
        file,
        progress: 0,
        status: 'uploading',
        ...(file.size > 8 * 1024 * 1024
          ? {
              saved: {
                id: crypto.randomUUID(),
                cell: `${this.tableId}:${this.fieldId}:${this.recordId}`,
                file,
                createdAt: Date.now(),
              },
            }
          : {}),
      })),
    );
  }
  /** Files picked in a cloud drive: the server copies each one, and the batch appends them. */
  addRemote(picks: readonly RemotePick[]): void {
    this.start(
      picks.map((remote): UploadEntry => ({
        id: ++this.nextId,
        name: remote.name,
        remote,
        progress: 0,
        indeterminate: true,
        status: 'uploading',
      })),
    );
  }
  /** Stops a copy from a drive.  The server keeps nothing of it, and it leaves the list. */
  cancel(id: number): void {
    this.copies.get(id)?.abort();
    this.copies.delete(id);
    this.dismiss(id);
  }
  private start(entries: UploadEntry[]): void {
    this.entries = [...this.entries, ...entries];
    this.listeners.forEach((listener) => listener());
    void this.batch(entries);
  }
  private transfer(entry: UploadEntry): Promise<AttachmentMeta> {
    if (entry.file)
      return uploadFile(
        this.tableId,
        this.fieldId,
        entry.file,
        (progress) => this.update(entry.id, { progress }),
        this.recordId,
        entry.saved,
      );
    const controller = new AbortController();
    this.copies.set(entry.id, controller);
    return importPick(
      { tableId: this.tableId, fieldId: this.fieldId, recordId: this.recordId },
      entry.remote!,
      (fraction) =>
        this.update(entry.id, {
          progress: fraction === null ? 0 : fraction * 100,
          indeterminate: fraction === null,
        }),
      controller.signal,
    ).finally(() => {
      if (this.copies.get(entry.id) === controller) this.copies.delete(entry.id);
    });
  }
  retry(id: number): void {
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry || entry.status !== 'failed') return;
    this.update(id, {
      status: 'uploading',
      progress: 0,
      indeterminate: Boolean(entry.remote),
      error: undefined,
    });
    void this.batch([entry]);
  }
  private async batch(entries: readonly UploadEntry[]): Promise<void> {
    const results = await Promise.all(
      entries.map(async (entry) => {
        try {
          const file = entry.uploaded ?? (await this.transfer(entry));
          this.session.rememberAttachments({ [file.id]: file });
          this.update(entry.id, { uploaded: file, progress: 100, indeterminate: false });
          return { entry, file };
        } catch (error) {
          // A canceled copy already left the list.
          if (this.entries.some((current) => current.id === entry.id))
            this.update(entry.id, { status: 'failed', error });
          return null;
        }
      }),
    );
    const completed = results.filter((result) => result !== null);
    if (!completed.length) return;
    try {
      const row = await this.session.getRecord(this.tableId, this.recordId);
      if (!row)
        throw new ApiError(404, { code: 'not_found', messageKey: 'errors.notFound', userFault: true });
      const latest = this.session.cachedRecord(this.tableId, this.recordId) ?? row;
      const action = this.session.run([
        {
          kind: 'record.update',
          tableId: this.tableId,
          records: [
            {
              id: this.recordId,
              values: {
                [this.fieldId]: [
                  ...new Set([
                    ...idsOf(latest.values[this.fieldId] ?? null),
                    ...completed.map(({ file }) => file.id),
                  ]),
                ],
              },
            },
          ],
        },
      ]);
      const result = await action.done;
      if (result.rejected)
        throw new ApiError(403, { code: 'forbidden', messageKey: 'data.access.denied', userFault: true });
      completed.forEach(({ entry }) => this.dismiss(entry.id));
    } catch (error) {
      completed.forEach(({ entry }) => this.update(entry.id, { status: 'failed', error }));
    }
  }
}

const panels = new WeakMap<DatabaseSession, Map<string, AttachmentUploads>>();

/** Keep progress and retryable failures available if the cell editor is reopened. */
export function attachmentUploads(
  session: DatabaseSession,
  tableId: string,
  fieldId: string,
  recordId: string,
): AttachmentUploads {
  let cells = panels.get(session);
  if (!cells) {
    cells = new Map();
    panels.set(session, cells);
  }
  const key = `${tableId}:${fieldId}:${recordId}`;
  let uploads = cells.get(key);
  if (!uploads) {
    uploads = new AttachmentUploads(session, tableId, fieldId, recordId);
    cells.set(key, uploads);
  }
  return uploads;
}
