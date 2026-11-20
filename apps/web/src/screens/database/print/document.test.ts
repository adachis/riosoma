import { describe, expect, it } from 'vitest';
import { cellValue, EMPTY_STACK, GridConfig } from '@riosoma/contracts';
import type {
  Content,
  ContentColumns,
  ContentStack,
  ContentTable,
  DynamicContent,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import { formatCell, signatureText } from '../../../grid/format';
import { summaryValueText } from '../../../grid/summary/text';
import {
  cardsPerRow,
  contentBox,
  estimateLines,
  kanbanStacks,
  PAGE_MARGINS,
  recordDocument,
  signatureSvg,
  tableWidths,
  valueContent,
  viewDocument,
  type ViewSource,
} from './document';
import {
  ADA,
  allFields,
  APOLLO,
  context,
  type ConfigInput,
  DONE,
  fields,
  format,
  SKYLAB,
  GRACE,
  READY,
  record,
  rows,
  settings,
  SIGNATURE,
  table,
  WAITING,
} from './testing';

function source(type: ViewSource['type'], config: ConfigInput = {}): ViewSource {
  return {
    type,
    config: GridConfig.parse(config),
    primaryFieldId: table.primaryFieldId,
    tableFields: allFields,
  };
}

const contents = (definition: TDocumentDefinitions) => definition.content as Content[];
const text = (value: unknown) => JSON.stringify(value);

it('prints group headers, counts, and column summaries before their records', () => {
  const grid = source('grid', { groups: [{ fieldId: fields.status.id, direction: 'asc' }] });
  grid.groups = [
    {
      key: 'ready',
      level: 1,
      start: 0,
      count: rows.length,
      values: { [fields.status.id]: READY.id },
      summaries: {
        [fields.name.id]: { kind: 'count', value: 3 },
        [fields.budget.id]: { kind: 'sum', value: 123 },
      },
    },
  ];
  const definition = viewDocument(rows, settings({ fields: [fields.name, fields.budget] }), grid, context());
  const body = (contents(definition)[2] as ContentTable).table.body;
  expect(body).toHaveLength(rows.length + 2);
  expect(body[1]?.[0]).toMatchObject({
    stack: [{ text: 'Ready, 3 records' }, { text: '3' }],
    bold: true,
  });
  expect(body[1]?.[1]).toMatchObject({
    text: summaryValueText(fields.budget, { kind: 'sum', value: 123 }, format()),
  });
});

function header(definition: TDocumentDefinitions, page = 1, count = 1) {
  const size = { width: 612, height: 792, orientation: 'portrait' as const };
  return {
    top: (definition.header as DynamicContent)(page, count, size),
    bottom: (definition.footer as DynamicContent)(page, count, size),
  };
}

describe('a grid view as a table', () => {
  const shown = [fields.name, fields.status, fields.due, fields.budget, fields.files, fields.projects];
  const grid = source('grid', { columnWidths: { [fields.status.id]: 120, [fields.budget.id]: 60 } });
  const definition = viewDocument(
    rows,
    settings({ fields: shown, orientation: 'landscape', pageSize: 'A4' }),
    grid,
    context(),
  );

  it('names the view and counts its records above one table with a header row on every page', () => {
    const [title, count, body] = contents(definition);
    expect(title).toMatchObject({ text: 'Launch board', style: 'title' });
    expect(count).toMatchObject({ text: '3 records' });
    const { table: layout } = body as ContentTable;
    expect(layout.headerRows).toBe(1);
    expect(layout.body).toHaveLength(rows.length + 1);
    expect(layout.body[0]!.map((cell) => (cell as { text: string }).text)).toEqual([
      'Name',
      'Status',
      'Due',
      'Budget',
      'Files',
      'Projects',
    ]);
    expect(definition.pageSize).toBe('A4');
    expect(definition.pageOrientation).toBe('landscape');
  });

  it('sizes columns from the view, scaled to fill the page', () => {
    const { table: layout } = contents(definition)[2] as ContentTable;
    const widths = layout.widths as number[];
    const room = contentBox('A4', 'landscape').width - shown.length * 8;
    // The primary field starts wider, and the view's own widths keep their proportions.
    expect(widths[0]! / widths[1]!).toBeCloseTo(240 / 120, 1);
    expect(widths[1]! / widths[3]!).toBeCloseTo(120 / 60, 1);
    expect(widths[2]).toBeCloseTo(widths[4]!, 5);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(room);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeGreaterThan(room - 1);
    // So many fields that the view's widths can't all fit still get readable columns.
    const crowded = tableWidths(Array(60).fill(fields.notes), grid, 500);
    expect(Math.min(...crowded)).toBe(24);
  });

  it('words every value the way the grid does, in the reader’s language and time zone', () => {
    const { table: layout } = contents(definition)[2] as ContentTable;
    const first = text(layout.body[1]);
    const ctx = format();
    for (const item of shown)
      expect(first).toContain(JSON.stringify(formatCell(item, cellValue(rows[0]!, item), ctx)).slice(1, -1));
    expect(first).toContain('Sep 30, 2026');
    expect(first).toContain('$1,234.50');
    expect(first).toContain('Brief.pdf, Photo.png');
    expect(first).toContain('Apollo');
    expect(first).toContain('Ready');
    // Money lines up at the end of its column, as numbers do in the grid.
    expect(layout.body[1]![3]).toMatchObject({ alignment: 'right' });
    expect(layout.body[0]![3]).toMatchObject({ alignment: 'right' });
  });

  it('puts the database, the view, the date, and the page number on every page', () => {
    const { top, bottom } = header(definition, 2, 5);
    expect(text(top)).toContain('Operations – Launch board');
    expect(text(top)).toContain('September 27, 2026');
    expect(text(top)).toContain('2:30');
    expect(text(bottom)).toContain('Page 2 of 5');
    expect(definition.info).toMatchObject({ title: 'Launch board' });
    // The same moment reads in the reader's own zone.
    const tokyo = viewDocument(
      rows,
      settings(),
      grid,
      context({ format: format({ timeZone: 'Asia/Tokyo' }) }),
    );
    expect(text(header(tokyo).top)).toContain('September 28, 2026');
  });

  it('falls back to the view’s name for an empty title, and says when there is nothing to print', () => {
    const empty = viewDocument([], settings({ title: '  ' }), grid, context());
    expect(contents(empty)[0]).toMatchObject({ text: 'Launch board' });
    expect(contents(empty)[1]).toMatchObject({ text: '0 records' });
    expect(contents(empty)[2]).toMatchObject({ text: 'No records' });
    expect(text(empty.content)).not.toContain('"table"');
  });

  it('marks a formula that failed the way the grid does', () => {
    const failed = { ...rows[1]!, errors: { [fields.budget.id]: 'formula.divideByZero' } };
    const { table: layout } = contents(
      viewDocument([failed], settings({ fields: shown }), grid, context()),
    )[2] as ContentTable;
    expect(text(layout.body[1])).toContain('#ERROR');
  });
});

describe('values that need more than words', () => {
  const ctx = context();

  it('draws a signature above who signed and when', () => {
    const drawn = valueContent(fields.approval, rows[0]!, ctx, 'record') as ContentStack;
    const [drawing, caption] = drawn.stack as [{ svg: string; fit: number[] }, { text: string }];
    expect(drawing.svg).toContain('<path d="M10 20l30 40l50 -20"');
    expect(drawing.svg).toContain('viewBox="0 0 400 150"');
    expect(drawing.fit).toEqual([220, 80]);
    expect(caption.text).toBe(signatureText(SIGNATURE, ctx.format));
    // A typed signature is the name itself.
    const typed = record(9, { approval: { ...SIGNATURE, drawing: null } });
    expect(text(valueContent(fields.approval, typed, ctx, 'card'))).toContain('"italics":true');
  });

  it('never puts anything but a pad’s drawing in an SVG', () => {
    expect(signatureSvg({ path: 'M0 0L10 10', width: 20, height: 20 })).toContain('<svg');
    expect(signatureSvg({ path: 'M0 0"/><script>', width: 20, height: 20 })).toBeNull();
    expect(signatureSvg({ path: 'M0 0L10 10', width: 0, height: 20 })).toBeNull();
  });

  it('prints a button as the link it opens, and lists files and links one to a line on a record', () => {
    const button = valueContent(fields.site, rows[0]!, ctx, 'table');
    expect(button).toEqual({
      text: 'https://example.com/tasks/Launch%20plan',
      link: 'https://example.com/tasks/Launch%20plan',
      decoration: 'underline',
    });
    expect(valueContent(fields.files, rows[0]!, ctx, 'record')).toMatchObject({
      ul: ['Brief.pdf', 'Photo.png'],
    });
    expect(valueContent(fields.files, rows[0]!, ctx, 'table')).toEqual({ text: 'Brief.pdf, Photo.png' });
    const linked = record(9, { projects: [APOLLO, SKYLAB] });
    // A linked record whose name hasn't been read shows its ID, as the grid does.
    expect(valueContent(fields.projects, linked, ctx, 'record')).toMatchObject({ ul: ['Apollo', SKYLAB] });
    expect(valueContent(fields.data, rows[0]!, ctx, 'record')).toMatchObject({
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
      preserveLeadingSpaces: true,
    });
  });

  it('cuts long text short on a card, but never in a table or a record', () => {
    const long = record(9, { notes: 'word '.repeat(200) });
    expect((valueContent(fields.notes, long, ctx, 'card') as { text: string }).text.length).toBeLessThan(300);
    expect((valueContent(fields.notes, long, ctx, 'card') as { text: string }).text.endsWith('…')).toBe(true);
    expect((valueContent(fields.notes, long, ctx, 'table') as { text: string }).text).toHaveLength(1000);
    expect((valueContent(fields.notes, long, ctx, 'record') as { text: string }).text).toHaveLength(1000);
  });
});

describe('a gallery as cards', () => {
  const shown = [fields.name, fields.status, fields.owner];

  it('fits more cards to a row for smaller cards and in landscape', () => {
    expect(cardsPerRow(source('gallery', { gallery: { cardSize: 'small' } }), 'portrait')).toBe(3);
    expect(cardsPerRow(source('gallery'), 'portrait')).toBe(2);
    expect(cardsPerRow(source('gallery', { gallery: { cardSize: 'large' } }), 'portrait')).toBe(1);
    expect(cardsPerRow(source('gallery'), 'landscape')).toBe(3);
    expect(cardsPerRow(source('kanban'), 'portrait')).toBe(2);
  });

  it('titles each card with its record and lists each field’s name and value', () => {
    const definition = viewDocument(rows, settings({ fields: shown }), source('gallery'), context());
    const [, , first, second] = contents(definition) as [Content, Content, ContentColumns, ContentColumns];
    expect(first.columns).toHaveLength(2);
    expect(first.unbreakable).toBe(true);
    const card = (first.columns[0] as ContentStack).stack[0] as ContentTable;
    const inside = text(card.table.body);
    expect(inside).toContain('"text":"Launch plan","style":"cardTitle"');
    expect(inside).toContain('"text":"Status","style":"label"');
    expect(inside).toContain('Ready');
    expect(inside).toContain('Ada Lovelace');
    // The primary field is the title, so it isn't listed again.
    expect(inside).not.toContain('"text":"Name"');
    // The last row keeps its one card the same width as the others.
    expect(second.columns).toHaveLength(2);
    expect(second.columns[1]).toEqual({ width: '*', text: '' });
    const untitled = viewDocument([record(9, {})], settings({ fields: shown }), source('gallery'), context());
    expect(text(untitled.content)).toContain('Untitled record');
  });

  it('keeps short cards together on a page, but never a card too tall for one', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      ...fields.notes,
      id: `fld${String(900 + index).padStart(14, '0')}`,
      name: `Note ${index}`,
    }));
    const tall = record(9, { name: 'Tall' });
    for (const item of many) tall.values[item.id] = 'A sentence with words. '.repeat(10);
    const definition = viewDocument(
      [tall],
      settings({ fields: [fields.name, ...many] }),
      source('gallery'),
      context(),
    );
    const row = contents(definition)[2] as ContentColumns;
    expect(row.columns).toHaveLength(2);
    expect(row.unbreakable).toBeUndefined();
    expect(estimateLines('word '.repeat(100), 9, 100)).toBeGreaterThan(20);
    expect(estimateLines('一'.repeat(20), 10, 100)).toBeGreaterThan(estimateLines('a'.repeat(20), 10, 100));
  });
});

describe('a kanban as cards in stacks', () => {
  const kanban = (settingsPatch: ConfigInput['kanban'] = {}) =>
    source('kanban', { kanban: { stackFieldId: fields.status.id, ...settingsPatch } });
  const board = [
    record(1, { name: 'One', status: WAITING.id }),
    record(2, { name: 'Two', status: READY.id }),
    record(3, { name: 'Three' }),
    record(4, { name: 'Four', status: WAITING.id }),
    record(5, { name: 'Five', status: 'cho00000000000099' }),
  ];

  it('groups records by stack, in the board’s order, and leaves out hidden stacks', () => {
    const stacks = kanbanStacks(
      board,
      kanban({ stackOrder: [WAITING.id], hiddenStacks: [DONE.id] }),
      context(),
    );
    expect(stacks?.map(({ stack, rows: items }) => [stack.name, items.map((row) => row.id)])).toEqual([
      ['Waiting', [board[0]!.id, board[3]!.id]],
      ['Ready', [board[1]!.id]],
      // A choice that is gone counts as no choice at all.
      ['No Status', [board[2]!.id, board[4]!.id]],
    ]);
    const shown = kanbanStacks(board, kanban({ hideEmptyStacks: true }), context());
    expect(shown?.map(({ stack }) => stack.id)).toEqual([READY.id, WAITING.id, EMPTY_STACK]);
  });

  it('heads each stack with its name and count, and keeps the heading with its first cards', () => {
    const definition = viewDocument(
      board,
      settings({ fields: [fields.name, fields.status] }),
      kanban({ hiddenStacks: [DONE.id] }),
      context(),
    );
    const [, , ready, waiting, none] = contents(definition) as ContentStack[];
    expect(text(ready)).toContain('"text":"Ready","style":"stack"');
    expect(text(ready)).toContain('"text":"1 record"');
    expect(ready!.unbreakable).toBe(true);
    expect(text(waiting)).toContain('"text":"2 records"');
    expect(text(none)).toContain('No Status');
    expect(text(definition.content)).not.toContain('"text":"Done","style":"stack"');
  });

  it('stacks by person for a user field, and prints as a gallery without a stack field', () => {
    const people = source('kanban', { kanban: { stackFieldId: fields.owner.id } });
    const stacks = kanbanStacks(rows, people, context());
    expect(stacks?.map(({ stack, rows: items }) => [stack.name, items.length])).toEqual([
      ['Ada Lovelace', 1],
      ['Grace Hopper', 1],
      ['No Owner', 1],
    ]);
    expect(stacks?.[0]?.stack.id).toBe(ADA);
    expect(stacks?.[1]?.stack.id).toBe(GRACE);
    const loose = viewDocument(rows, settings({ fields: [fields.name] }), source('kanban'), context());
    expect((contents(loose)[2] as ContentColumns).columns).toHaveLength(2);
  });
});

describe('one record', () => {
  const chosen = [fields.name, fields.status, fields.files, fields.projects, fields.approval, fields.site];
  const definition = recordDocument(
    rows[0]!,
    settings({ title: 'Launch plan', fields: chosen }),
    context({ sourceName: 'Tasks' }),
  );

  it('prints each field as a label and a value under the record’s name', () => {
    const [title, list] = contents(definition) as [Content, ContentTable];
    expect(title).toMatchObject({ text: 'Launch plan', style: 'title' });
    expect(list.table.body.map((row) => (row[0] as { text: string }).text)).toEqual(
      chosen.map((item) => item.name),
    );
    expect(list.table.widths).toEqual([Math.round(contentBox('LETTER', 'portrait').width * 0.3), '*']);
    const values = text(list.table.body);
    expect(values).toContain('Brief.pdf');
    expect(values).toContain('Apollo');
    expect(values).toContain('<svg');
    expect(values).toContain('https://example.com/tasks/Launch%20plan');
    // A record's printout doesn't count records.
    expect(text(definition.content)).not.toContain('1 record');
  });

  it('names the database and table on every page', () => {
    const { top, bottom } = header(definition, 1, 1);
    expect(text(top)).toContain('Operations – Tasks');
    expect(text(bottom)).toContain('Page 1 of 1');
    expect(definition.pageMargins).toEqual(PAGE_MARGINS);
  });
});

describe('page geometry', () => {
  it('leaves the margins out of the room for content', () => {
    expect(contentBox('LETTER', 'portrait')).toEqual({ width: 532, height: 688 });
    expect(contentBox('LETTER', 'landscape')).toEqual({ width: 712, height: 508 });
    expect(contentBox('A4', 'portrait').width).toBeCloseTo(515.28, 2);
  });
});

it('prints one spanning label for each contiguous column group run', () => {
  const grid = source('grid', {
    columnGroups: [
      {
        id: 'details',
        name: 'Details',
        fieldIds: [fields.status.id, fields.due.id, fields.files.id],
        color: 'green',
      },
    ],
  });
  const definition = viewDocument(
    rows,
    settings({ fields: [fields.name, fields.status, fields.due, fields.budget, fields.files] }),
    grid,
    context(),
  );
  const band = (contents(definition)[2] as ContentTable).table.body[0]!;
  expect(band[1]).toMatchObject({ text: 'Details', colSpan: 2, fillColor: '#DDEFE1' });
  expect(band[2]).toEqual({});
  expect(band[4]).toMatchObject({ text: 'Details', colSpan: 1 });
});
