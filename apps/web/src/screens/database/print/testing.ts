import { setupI18n } from '@lingui/core';
import {
  FieldMeta,
  GridConfig,
  type AttachmentMeta,
  type CellValue,
  type FieldType,
  type RowData,
  type RowsPage,
  type SignatureValue,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import type { FormatContext } from '../../../grid/format';
import type { PrintContext, PrintSettings } from './document';

/** Records, fields, and a reader for the printing tests: a small project tracker. */

export const TABLE_ID = 'tbl00000000000001';
export const PROJECTS_ID = 'tbl00000000000002';
export const VIEW_ID = 'viw00000000000001';

export function field(
  name: string,
  type: FieldType,
  position: number,
  options: Record<string, unknown> = {},
): FieldMeta {
  return FieldMeta.parse({
    id: `fld${String(position).padStart(14, '0')}`,
    tableId: TABLE_ID,
    name,
    type,
    options,
    description: '',
    position,
    createdAt: '',
    updatedAt: '',
  });
}

export const READY = { id: 'cho00000000000001', name: 'Ready', color: 'green' } as const;
export const WAITING = { id: 'cho00000000000002', name: 'Waiting', color: 'yellow' } as const;
export const DONE = { id: 'cho00000000000003', name: 'Done', color: 'blue' } as const;

export const ADA = 'usr00000000000001';
export const GRACE = 'usr00000000000002';

const name = field('Name', 'text', 1);
export const fields = {
  name,
  status: field('Status', 'singleSelect', 2, { choices: [READY, WAITING, DONE] }),
  due: field('Due', 'date', 3),
  budget: field('Budget', 'currency', 4),
  owner: field('Owner', 'user', 5),
  files: field('Files', 'attachment', 6),
  projects: field('Projects', 'link', 7, { linkedTableId: PROJECTS_ID }),
  approval: field('Approval', 'signature', 8),
  notes: field('Notes', 'longText', 9),
  done: field('Done', 'checkbox', 10),
  site: field('Site', 'button', 11, {
    label: 'Open',
    action: { kind: 'openUrl', urlTemplate: `https://example.com/tasks/{${name.id}}` },
  }),
  data: field('Data', 'json', 12),
};
export const allFields: FieldMeta[] = Object.values(fields);

export const table: TableMeta = {
  id: TABLE_ID,
  databaseId: 'db00000000000001',
  name: 'Tasks',
  primaryFieldId: fields.name.id,
  position: 0,
  description: '',
  createdAt: '',
  updatedAt: '',
};

/** A view's settings as a test writes them, with every default left out. */
export type ConfigInput = (typeof GridConfig)['_input'];

export function view(type: ViewMeta['type'] = 'grid', config: ConfigInput = {}): ViewMeta {
  return {
    id: VIEW_ID,
    tableId: TABLE_ID,
    name: 'Launch board',
    type,
    config: GridConfig.parse(config),
    position: 0,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
  };
}

export const SIGNATURE: SignatureValue = {
  drawing: { path: 'M10 20l30 40l50 -20', width: 400, height: 150 },
  name: 'Ada Lovelace',
  signedBy: ADA,
  signedAt: '2026-09-27T15:05:00.000Z',
};

export function record(index: number, values: Partial<Record<keyof typeof fields, CellValue>>): RowData {
  return {
    id: `rec${String(index).padStart(14, '0')}`,
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [fields[key as keyof typeof fields].id, value]),
    ),
    createdAt: '2026-09-01T12:00:00.000Z',
    createdBy: ADA,
    updatedAt: '2026-09-02T12:00:00.000Z',
    updatedBy: ADA,
  };
}

export function attachment(id: string, fileName: string): AttachmentMeta {
  return {
    id,
    name: fileName,
    size: 1_024,
    type: 'application/pdf',
    width: null,
    height: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    url: `/api/files/${id}`,
    thumbnails: { small: null, large: null },
  };
}

export const BRIEF = 'att00000000000001';
export const PHOTO = 'att00000000000002';
export const APOLLO = 'rec00000000000090';
export const SKYLAB = 'rec00000000000091';

export const rows: RowData[] = [
  record(1, {
    name: 'Launch plan',
    status: READY.id,
    due: '2026-09-30',
    budget: 1234.5,
    owner: [ADA],
    files: [BRIEF, PHOTO],
    projects: [APOLLO],
    approval: SIGNATURE,
    notes: 'Line one\nLine two',
    done: true,
    data: '{"a":1,"b":[1,2]}',
  }),
  record(2, { name: 'Budget review', status: WAITING.id, owner: [GRACE], budget: 99 }),
  record(3, { name: 'Retro' }),
];

export function format(overrides: Partial<FormatContext> = {}): FormatContext {
  return {
    locale: 'en-US',
    timeZone: 'America/New_York',
    collaborators: new Map([
      [ADA, { name: 'Ada Lovelace' }],
      [GRACE, { name: 'Grace Hopper' }],
    ]),
    linked: new Map([[APOLLO, 'Apollo']]),
    attachments: new Map([
      [BRIEF, attachment(BRIEF, 'Brief.pdf')],
      [PHOTO, attachment(PHOTO, 'Photo.png')],
    ]),
    fieldsById: new Map(allFields.map((item) => [item.id, item])),
    ...overrides,
  };
}

export const PRINTED_AT = new Date('2026-09-27T18:30:00.000Z');

export function context(overrides: Partial<PrintContext> = {}): PrintContext {
  return {
    i18n: setupI18n({ locale: 'en-US', messages: { 'en-US': {} } }),
    format: format(),
    databaseName: 'Operations',
    sourceName: 'Launch board',
    printedAt: PRINTED_AT,
    ...overrides,
  };
}

export function settings(overrides: Partial<PrintSettings> = {}): PrintSettings {
  return {
    title: 'Launch board',
    pageSize: 'LETTER',
    orientation: 'portrait',
    fields: allFields,
    ...overrides,
  };
}

/** One page of the rows API. */
export function page(
  offset: number,
  items: ReadonlyArray<RowData | null>,
  total: number,
  extra: Partial<RowsPage> = {},
): RowsPage {
  return { snapshot: 'snap1', total, offset, rows: [...items], rebuilt: false, ...extra };
}

/** `count` plain records starting at `first`, numbered from one. */
export function manyRecords(first: number, count: number): RowData[] {
  return Array.from({ length: count }, (_, index) =>
    record(first + index, { name: `Task ${first + index}` }),
  );
}
