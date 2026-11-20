import { newId, type AttachmentMeta, type FieldMeta, type RowsPage } from '@riosoma/contracts';
import { vi } from 'vitest';
import type { Http } from '../data/deps';
import { FakeServer } from '../data/testing';

export function attachment(name = 'Photo.png', type = 'image/png'): AttachmentMeta {
  const id = newId('attachment');
  return {
    id,
    name,
    type,
    size: 1234,
    width: null,
    height: null,
    createdAt: '2026-09-27T12:00:00Z',
    url: `/api/files/${id}/${encodeURIComponent(name)}`,
    thumbnails: {
      small: type.startsWith('image/') ? `/api/files/${id}/thumbnails/small` : null,
      large: type.startsWith('image/') ? `/api/files/${id}/thumbnails/large` : null,
    },
  };
}

export function attachmentFixture(files: AttachmentMeta[] = []) {
  const server = new FakeServer();
  const source = server.createDatabase(3);
  const base = server.database(source.databaseId).schema;
  const field: FieldMeta = {
    ...base.fields[0]!,
    id: newId('field'),
    name: 'Files',
    type: 'attachment',
    options: {},
  };
  const database = server.seed(
    { ...base, fields: [...base.fields, field] },
    new Map([
      [
        source.tableId,
        {
          count: 3,
          values: (index: number) => ({
            [source.textFieldId]: `Record ${index + 1}`,
            [field.id]: index === 0 ? files.map((file) => file.id) : [],
          }),
        },
      ],
    ]),
  );
  const details = new Map(files.map((file) => [file.id, file]));
  const lookups: string[][] = [];
  const http: Http = async <T>(path: string, options?: Parameters<Http>[1]): Promise<T> => {
    if (path.startsWith('/api/files?ids=')) {
      const ids = new URL(path, 'http://localhost').searchParams.get('ids')!.split(',');
      lookups.push(ids);
      return Object.fromEntries(ids.flatMap((id) => (details.has(id) ? [[id, details.get(id)!]] : []))) as T;
    }
    const result = await server.http<T>(path, options);
    if (path.includes('/rows?')) {
      const page = result as RowsPage;
      const used = new Set(page.rows.flatMap((row) => row?.values[field.id] ?? []));
      page.attachments = Object.fromEntries([...details].filter(([id]) => used.has(id)));
    }
    return result;
  };
  return { server, source, database, field, details, lookups, http, deps: server.deps({ http }) };
}

export class MockUpload {
  static requests: MockUpload[] = [];
  upload = {
    onprogress: null as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers = new Map<string, string>();
  body?: File;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers.set(key, value);
  }
  send(file: File) {
    this.body = file;
    MockUpload.requests.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(body: unknown, status = 200) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
  static install() {
    this.requests = [];
    vi.stubGlobal('XMLHttpRequest', MockUpload);
  }
}
