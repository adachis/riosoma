import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AttachmentMeta,
  newId,
  type CommandBatchResult,
  type FilterGroup,
  type ReportRun,
  type ReportSchedule,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { LightMyRequestResponse } from 'fastify';
import type { Mailer, MailMessage } from '../../mail/index.js';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { insertRecords } from '../physical/records.js';
import { readFixture, saveView } from '../snapshots.test-helpers.js';
import { contrast, readableAccent } from './office/deck.js';
import { describeFilter } from './office/filter-words.js';
import { DOCX_TYPE } from './office/load.js';

/**
 * Word documents and PowerPoint decks, read back.  Every file a test downloads is unzipped here
 * and its XML searched for the words, tables, slides, pictures, and formatting it should hold, so
 * nothing passes on the strength of a file merely existing.
 */

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const sent: MailMessage[] = [];
const memory: Mailer = {
  async send(message) {
    sent.push(message);
  },
};

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'office', {
    baseUrl: 'https://riosoma.example.test/',
    reportsPollMs: 0,
    automationsPollMs: 0,
  });
  server.ctx.mailer = memory;
  member = await server.addMember({ name: 'Mona Member' });
}, 120_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const ZONE = 'America/Los_Angeles';

/* ------------------------------------------------------------------------------------------------
 * Reading files back
 * --------------------------------------------------------------------------------------------- */

/** The files in a zip archive, which is what a .docx or .pptx file is. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  expect(end, 'a zip archive').toBeGreaterThanOrEqual(0);
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function xml(files: Map<string, Buffer>, name: string): string {
  const file = files.get(name);
  expect(file, name).toBeDefined();
  return file!.toString('utf8');
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/** Every run of text, in order: `w:t` in Word, `a:t` in PowerPoint. */
function texts(source: string, tag: 'w:t' | 'a:t'): string[] {
  return [...source.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((match) =>
    unescapeXml(match[1]!),
  );
}

/** The paragraphs of a Word part, each as its runs' text joined. */
function paragraphs(source: string): string[] {
  return [...source.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => texts(match[0], 'w:t').join(''));
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/** A Word document's group headings. */
function headings(document: string): string[] {
  return [...document.matchAll(/<w:pStyle w:val="Heading2"\/>[\s\S]*?<\/w:p>/g)].map((match) =>
    texts(match[0], 'w:t').join(''),
  );
}

/** Slide parts in order, title slide first. */
function slides(files: Map<string, Buffer>): string[] {
  return [...files.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
    .map((name) => xml(files, name));
}

/* ------------------------------------------------------------------------------------------------
 * A database to download from
 * --------------------------------------------------------------------------------------------- */

async function call(
  who: SignedIn,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function run(databaseId: string, input: Record<string, unknown>): Promise<void> {
  const response = await call(server.owner, 'POST', `/api/databases/${databaseId}/commands`, {
    clientId: newId('client'),
    commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
}

function download(
  who: SignedIn,
  viewId: string,
  format: 'docx' | 'pptx',
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const search = new URLSearchParams({ format, timeZone: ZONE, locale: 'en-US', ...extra });
  return call(who, 'GET', `/api/views/${viewId}/export?${search.toString()}`);
}

async function file(response: LightMyRequestResponse): Promise<Map<string, Buffer>> {
  expect(response.statusCode, response.body).toBe(200);
  return unzip(response.rawPayload);
}

async function png(width: number, height: number, color = '#cc3300'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

const RICH = [
  '**Bold move** and *careful* steps',
  '',
  '- first point',
  '- second point',
  '',
  '1. one',
  '2. two',
  '',
  'See [the plan](https://example.com/plan)',
].join('\n');

const CHOICES = {
  done: { id: newId('choice'), name: 'Done', color: 'green' as const },
  waiting: { id: newId('choice'), name: 'Waiting', color: 'blue' as const },
  blocked: { id: newId('choice'), name: 'Blocked', color: 'red' as const },
};

/**
 * Projects, with one field of most kinds.  Apollo has two pictures and a text file, a checked box,
 * rich notes, and a person.  Secret holds values only its field's audience may see, and Region
 * decides which records an editor's rule lets them see.
 */
async function projects() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const gridId = newId('view');
  const f = {
    name: newId('field'),
    status: newId('field'),
    amount: newId('field'),
    due: newId('field'),
    done: newId('field'),
    notes: newId('field'),
    owner: newId('field'),
    files: newId('field'),
    region: newId('field'),
    secret: newId('field'),
  };
  const created = await call(server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Portfolio',
    table: {
      id: tableId,
      name: 'Projects',
      fields: [{ id: f.name, name: 'Name', type: 'text' }],
      view: { id: gridId, name: 'Everything' },
      records: [],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const field = (id: string, name: string, type: string, options: unknown = {}) =>
    run(databaseId, { kind: 'field.create', tableId, field: { id, name, type, description: '', options } });
  await field(f.status, 'Status', 'singleSelect', { choices: Object.values(CHOICES) });
  await field(f.amount, 'Amount', 'currency', { code: 'USD', precision: 2 });
  await field(f.due, 'Due', 'date', { dateFormat: 'iso' });
  await field(f.done, 'Done', 'checkbox');
  await field(f.notes, 'Notes', 'longText', { richText: true });
  await field(f.owner, 'Owner', 'user');
  await field(f.files, 'Files', 'attachment');
  await field(f.region, 'Region', 'text');
  await field(f.secret, 'Secret', 'number');
  const upload = async (bytes: Buffer, name: string, type: string) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/fields/${f.files}/files`,
      headers: { ...server.owner.headers, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
      payload: bytes,
    });
    expect(response.statusCode, response.body).toBe(200);
    return AttachmentMeta.parse(response.json()).id;
  };
  const photo = await upload(await png(800, 400), 'photo.png', 'image/png');
  const chart = await upload(
    await sharp(await png(300, 600, '#0055aa'))
      .jpeg()
      .toBuffer(),
    'chart.jpg',
    'image/jpeg',
  );
  const text = await upload(Buffer.from('plain words'), 'readme.txt', 'text/plain');
  const ids = { apollo: newId('record'), borealis: newId('record'), cassini: newId('record') };
  await run(databaseId, {
    kind: 'record.create',
    tableId,
    records: [
      {
        id: ids.apollo,
        values: {
          [f.name]: 'Apollo',
          [f.status]: CHOICES.done.id,
          [f.amount]: 1234.5,
          [f.due]: '2026-09-01',
          [f.done]: true,
          [f.notes]: RICH,
          [f.owner]: [server.owner.userId],
          [f.files]: [photo, text, chart],
          [f.region]: 'West',
          [f.secret]: 987654,
        },
      },
      {
        id: ids.borealis,
        values: {
          [f.name]: 'Borealis',
          [f.status]: CHOICES.waiting.id,
          [f.amount]: 20,
          [f.region]: 'East',
          [f.secret]: 555111,
        },
      },
      {
        id: ids.cassini,
        values: {
          [f.name]: 'Cassini',
          [f.status]: CHOICES.done.id,
          [f.amount]: 5,
          [f.region]: 'West',
          [f.secret]: 444222,
        },
      },
    ],
  });
  return { databaseId, tableId, gridId, f, ids };
}

type Projects = Awaited<ReturnType<typeof projects>>;
let portfolio: Projects;
beforeAll(async () => {
  portfolio = await projects();
}, 120_000);

/* ------------------------------------------------------------------------------------------------
 * Word, for a view
 * --------------------------------------------------------------------------------------------- */

describe('a view as a Word document', () => {
  it('gives a grouped view a heading per group, its filter in words, and a table that keeps formatting', async () => {
    const { databaseId, tableId, f } = portfolio;
    const boardId = newId('view');
    const filter: FilterGroup = {
      conjunction: 'and',
      conditions: [{ id: 'big', fieldId: f.amount, operator: 'gte', value: 10 }],
    };
    await run(databaseId, {
      kind: 'view.create',
      view: {
        id: boardId,
        tableId,
        name: 'Board',
        type: 'kanban',
        config: {
          filter,
          hiddenFieldIds: [f.secret, f.region],
          kanban: {
            stackFieldId: f.status,
            stackOrder: [CHOICES.waiting.id],
            hiddenStacks: [CHOICES.blocked.id],
          },
        },
      },
    });
    const response = await download(server.owner, boardId, 'docx', { title: 'Quarterly review' });
    expect(response.headers['content-type']).toBe(DOCX_TYPE);
    expect(response.headers['content-disposition']).toContain('Projects - Board.docx');
    const files = await file(response);
    const document = xml(files, 'word/document.xml');
    const lines = paragraphs(document);
    expect(lines[0]).toBe('Quarterly review');
    expect(lines[1]).toMatch(
      /^From the Board view of Projects, as of [A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s?[AP]M\.$/,
    );
    expect(lines[2]).toBe('2 records');
    expect(lines[3]).toBe('Filter: Amount is at least $10.00');
    // The board's own order: the stack it puts first, then the rest, and none it hides.
    expect(headings(document)).toEqual(['Waiting (1)', 'Done (1)', 'No Status (0)']);
    expect(lines).toContain('No records');
    expect(document).not.toContain('Blocked (');
    // A table per group with records, each with a header row that repeats on every page.
    expect(count(document, /<w:tbl>/g)).toBe(2);
    expect(count(document, /<w:tblHeader\/>/g)).toBe(2);
    const header = texts(/<w:tr>[\s\S]*?<\/w:tr>/.exec(document)![0], 'w:t');
    expect(header).toEqual(['Name', 'Status', 'Amount', 'Due', 'Done', 'Notes', 'Owner', 'Files']);
    const words = texts(document, 'w:t');
    for (const value of ['Apollo', 'Borealis', '$1,234.50', '$20.00', '2026-09-01', '✓', 'Owner'])
      expect(words, value).toContain(value);
    expect(words).toContain('photo.png, readme.txt, chart.jpg');
    // Cassini is filtered out, and the hidden fields never appear.
    expect(document).not.toContain('Cassini');
    expect(document).not.toContain('987654');
    expect(document).not.toContain('Region');
    // Rich text keeps its bold, italics, lists, and link.
    expect(document).toMatch(
      /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>Bold move<\/w:t>/,
    );
    expect(document).toMatch(
      /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:i\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>careful<\/w:t>/,
    );
    expect(lines).toEqual(expect.arrayContaining(['first point', 'second point', 'one', 'two']));
    expect(count(document, /<w:numPr>/g)).toBe(4);
    const numbering = xml(files, 'word/numbering.xml');
    expect(numbering).toContain('w:val="bullet"');
    expect(numbering).toContain('w:val="decimal"');
    const link = /<w:hyperlink [^>]*r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/.exec(document)!;
    expect(texts(link[2]!, 'w:t')).toEqual(['the plan']);
    const relations = xml(files, 'word/_rels/document.xml.rels');
    expect(relations).toMatch(
      new RegExp(`Id="${link[1]}"[^>]*Target="https://example.com/plan"[^>]*TargetMode="External"`),
    );
    // Every page says which it is, with Word's own fields counting them.
    const footer = [...files.keys()].find((name) => /^word\/footer\d+\.xml$/.test(name))!;
    const bottom = xml(files, footer);
    expect(texts(bottom, 'w:t').join('')).toBe('Page  of ');
    expect(bottom).toMatch(/PAGE/);
    expect(bottom).toMatch(/NUMPAGES/);
    // Eight columns is too many for a portrait page.
    expect(document).toMatch(/<w:pgSz [^>]*w:orient="landscape"/);
  });

  it('gives a list grouped by a person a heading for each, with the empty group last', async () => {
    const { databaseId, tableId, f } = portfolio;
    const listId = newId('view');
    await run(databaseId, {
      kind: 'view.create',
      view: {
        id: listId,
        tableId,
        name: 'People',
        type: 'list',
        config: { list: { groupFieldId: f.owner } },
      },
    });
    const document = xml(await file(await download(server.owner, listId, 'docx')), 'word/document.xml');
    expect(headings(document)).toEqual(['Owner (1)', 'No Owner (2)']);
    expect(count(document, /<w:tbl>/g)).toBe(2);
  });

  it('lays a narrow view out upright, and turns a view of 40 columns sideways with fewer records', async () => {
    const narrow = await readFixture(server, [{ type: 'text' }, { type: 'number' }, { type: 'checkbox' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      narrow.table.id,
      narrow.fields,
      [{ id: newId('record'), values: { [narrow.fields[0]!.id]: 'Only', [narrow.fields[1]!.id]: 4 } }],
      server.owner.userId,
    );
    const upright = xml(
      await file(await download(server.owner, narrow.view.id, 'docx')),
      'word/document.xml',
    );
    expect(upright).toMatch(/<w:pgSz [^>]*w:orient="portrait"/);
    expect(count(upright, /<w:gridCol /g)).toBe(3);
    // No title typed, so the view's name leads, and a view without a filter says so.
    expect(paragraphs(upright).slice(0, 4)).toEqual([
      'Grid',
      expect.stringMatching(/^From the Grid view of Records, as of /),
      '1 record',
      'No filter, so every record you can see in the table is here.',
    ]);

    // Forty fields to a record is 1,250 records before the table holds 50,000 values.
    const wide = await readFixture(
      server,
      Array.from({ length: 40 }, () => ({ type: 'text' as const })),
    );
    await insertRecords(
      server.pool,
      server.schemas.data,
      wide.table.id,
      wide.fields,
      Array.from({ length: 1_251 }, (_, row) => ({
        id: newId('record'),
        values: Object.fromEntries(wide.fields.map((field, index) => [field.id, `cell ${row}.${index}`])),
      })),
      server.owner.userId,
    );
    const sideways = xml(await file(await download(server.owner, wide.view.id, 'docx')), 'word/document.xml');
    expect(sideways).toMatch(/<w:pgSz [^>]*w:orient="landscape"/);
    expect(count(sideways, /<w:gridCol /g)).toBe(40);
    expect(texts(sideways, 'w:t')).toEqual(expect.arrayContaining(['Field 39', 'cell 0.39']));
    expect(count(sideways, /<w:tr>/g)).toBe(1_251);
    expect(paragraphs(sideways)).toContain(
      'This file holds the first 1,250 of the view’s 1,251 records.  Download the view as CSV or Excel for every one of them.',
    );
  });

  it('stops a large view at its limit and says so in the file', async () => {
    const big = await readFixture(server, [{ type: 'text' }]);
    const total = 5_001;
    await insertRecords(
      server.pool,
      server.schemas.data,
      big.table.id,
      big.fields,
      Array.from({ length: total }, (_, index) => ({
        id: newId('record'),
        values: { [big.fields[0]!.id]: `Row ${String(index).padStart(5, '0')}` },
      })),
      server.owner.userId,
    );
    big.view.config.sorts = [{ fieldId: big.fields[0]!.id, direction: 'asc' }];
    await saveView(server, big);
    const document = xml(await file(await download(server.owner, big.view.id, 'docx')), 'word/document.xml');
    expect(paragraphs(document)).toContain(
      'This file holds the first 5,000 of the view’s 5,001 records.  Download the view as CSV or Excel for every one of them.',
    );
    expect(paragraphs(document)).toContain('5,001 records');
    // The header row and 5,000 records, the last of them the 5,000th in the view's order.
    expect(count(document, /<w:tr>/g)).toBe(5_001);
    expect(document).toContain('Row 04999');
    expect(document).not.toContain('Row 05000');
  }, 120_000);
});

/* ------------------------------------------------------------------------------------------------
 * PowerPoint
 * --------------------------------------------------------------------------------------------- */

describe('a view as a PowerPoint deck', () => {
  it('makes a title slide and a slide per record, with eight fields, a picture, and accent titles', async () => {
    const response = await download(server.owner, portfolio.gridId, 'pptx', {
      title: 'Portfolio update',
      accent: 'ffcc00',
    });
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    expect(response.headers['content-disposition']).toContain('Projects - Everything.pptx');
    const files = await file(response);
    const deck = slides(files);
    expect(deck).toHaveLength(4);
    expect(texts(deck[0]!, 'a:t')).toEqual([
      'Portfolio update',
      expect.stringMatching(/^From the Everything view of Projects, as of /),
      '3 records',
      'No filter, so every record you can see in the table is here.',
    ]);
    // Yellow is too light to read on white, so titles are the same hue, darker.
    const accent = readableAccent('ffcc00');
    expect(accent).not.toBe('FFCC00');
    expect(contrast(accent, 'FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(deck[0]).toContain(`<a:srgbClr val="${accent}"/>`);
    const apollo = texts(deck[1]!, 'a:t');
    expect(apollo[0]).toBe('Apollo');
    expect(deck[1]).toContain(`<a:srgbClr val="${accent}"/>`);
    // Eight fields after the title, as labels and values in two columns: Secret is the ninth.
    expect(count(deck[1]!, /<a:tr /g)).toBe(8);
    expect(apollo).toEqual(
      expect.arrayContaining(['Status', 'Done', 'Amount', '$1,234.50', 'Done', '✓', 'Region', 'West']),
    );
    expect(apollo).not.toContain('Secret');
    expect(apollo.join(' ')).toContain(
      'Bold move and careful steps first point second point one two See the plan',
    );
    // Apollo's first picture, and no picture for records without one.
    const media = [...files.keys()].filter((name) => name.startsWith('ppt/media/') && !name.endsWith('/'));
    expect(media).toHaveLength(1);
    expect(count(deck[1]!, /<p:pic>/g)).toBe(1);
    expect(xml(files, 'ppt/slides/_rels/slide2.xml.rels')).toContain(
      `Target="../media/${media[0]!.slice(10)}"`,
    );
    expect(count(deck[2]!, /<p:pic>/g)).toBe(0);
    expect(texts(deck[2]!, 'a:t')[0]).toBe('Borealis');
  });

  it('lays the view out as a table deck, twelve records to a slide', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      Array.from({ length: 30 }, (_, index) => ({
        id: newId('record'),
        values: {
          [read.fields[0]!.id]: `Item ${String(index + 1).padStart(2, '0')}`,
          [read.fields[1]!.id]: index,
        },
      })),
      server.owner.userId,
    );
    read.view.config.sorts = [{ fieldId: read.fields[0]!.id, direction: 'asc' }];
    await saveView(server, read);
    const deck = slides(await file(await download(server.owner, read.view.id, 'pptx', { layout: 'table' })));
    expect(deck).toHaveLength(4);
    expect(deck.slice(1).map((slide) => count(slide, /<a:tr /g))).toEqual([13, 13, 7]);
    expect(texts(deck[1]!, 'a:t').slice(0, 4)).toEqual([
      'Grid',
      'Records 1 to 12 of 30',
      'Field 0',
      'Field 1',
    ]);
    expect(texts(deck[3]!, 'a:t')).toEqual(expect.arrayContaining(['Records 25 to 30 of 30', 'Item 30']));
  });

  it('stops at 200 record slides and says so on the title slide', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      Array.from({ length: 201 }, (_, index) => ({
        id: newId('record'),
        values: { [read.fields[0]!.id]: `Slide ${index}` },
      })),
      server.owner.userId,
    );
    const deck = slides(await file(await download(server.owner, read.view.id, 'pptx')));
    expect(deck).toHaveLength(201);
    expect(texts(deck[0]!, 'a:t')).toContain(
      'This file holds the first 200 of the view’s 201 records.  Download the view as CSV or Excel for every one of them.',
    );
  }, 120_000);

  it('refuses a layout or an accent it cannot use', async () => {
    const refused: Array<Record<string, string>> = [
      { layout: 'cards' },
      { accent: '#ffcc00' },
      { accent: 'red' },
    ];
    for (const extra of refused) {
      const response = await download(server.owner, portfolio.gridId, 'pptx', extra);
      expect(response.statusCode, JSON.stringify(extra)).toBe(422);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Access
 * --------------------------------------------------------------------------------------------- */

describe('what someone limited by rules downloads', () => {
  it('leaves out a restricted field and the records a rule hides, in every document', async () => {
    const { databaseId, tableId, gridId, f } = portfolio;
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${member.userId}, 'editor')`,
    );
    const restricted = await call(server.owner, 'PUT', `/api/fields/${f.secret}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    const rules = await call(server.owner, 'PUT', `/api/tables/${tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'west', fieldId: f.region, operator: 'is', value: 'West' }],
          },
        },
      ],
    });
    expect(rules.statusCode, rules.body).toBe(200);
    try {
      const word = xml(await file(await download(member, gridId, 'docx')), 'word/document.xml');
      const table = xml(
        await file(await download(member, gridId, 'pptx', { layout: 'table' })),
        'ppt/slides/slide2.xml',
      );
      const deck = slides(await file(await download(member, gridId, 'pptx'))).join('');
      for (const [name, text] of [
        ['Word', word],
        ['table deck', table],
        ['record deck', deck],
      ] as const) {
        expect(text, name).toContain('Apollo');
        expect(text, name).toContain('Cassini');
        expect(text, name).not.toContain('Borealis');
        for (const secret of ['Secret', '987654', '987,654', '444222', '444,222', '555111'])
          expect(text, `${name}: ${secret}`).not.toContain(secret);
      }
      expect(paragraphs(word)).toContain('2 records');
      // The owner, whom no rule limits, still gets everything.
      const whole = xml(await file(await download(server.owner, gridId, 'docx')), 'word/document.xml');
      expect(whole).toContain('Borealis');
      expect(whole).toContain('987,654');
      // Someone who can't open the database gets nothing at all.
      const stranger = await server.addMember({ name: 'Sam Stranger' });
      expect((await download(stranger, gridId, 'docx')).statusCode).toBe(404);
    } finally {
      await call(server.owner, 'PUT', `/api/tables/${tableId}/record-rules`, { rules: [] });
      await call(server.owner, 'PUT', `/api/fields/${f.secret}/permissions`, {
        restricted: null,
        locked: null,
      });
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Word, for a record
 * --------------------------------------------------------------------------------------------- */

function recordUrl(tableId: string, recordId: string, extra: Record<string, string> = {}): string {
  const search = new URLSearchParams({ format: 'docx', timeZone: ZONE, locale: 'en-US', ...extra });
  return `/api/tables/${tableId}/records/${recordId}/export?${search.toString()}`;
}

describe('a record as a Word document', () => {
  it('titles it with the primary field, lists every field in the card’s order, and draws its pictures', async () => {
    const { databaseId, tableId, ids } = portfolio;
    await run(databaseId, {
      kind: 'comment.create',
      tableId,
      recordId: ids.apollo,
      comment: { id: newId('comment'), body: `Ready for review, @[Old name](${server.owner.userId})` },
    });
    const response = await call(server.owner, 'GET', recordUrl(tableId, ids.apollo));
    expect(response.headers['content-disposition']).toContain('Projects - Apollo.docx');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
    expect(response.headers['content-type']).toBe(DOCX_TYPE);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const files = await file(response);
    const document = xml(files, 'word/document.xml');
    const lines = paragraphs(document).filter(Boolean);
    expect(lines[0]).toBe('Apollo');
    expect(lines[1]).toMatch(/^A record in Projects, as of /);
    // Each label comes after the last one's value, in the card's order.
    const labels = ['Name', 'Status', 'Amount', 'Due', 'Done', 'Notes', 'Owner', 'Files', 'Region', 'Secret'];
    let at = 1;
    const places = labels.map((label) => (at = lines.indexOf(label, at + 1)));
    expect(
      places.every((place) => place > 1),
      JSON.stringify(lines),
    ).toBe(true);
    const after = (label: string) => lines[places[labels.indexOf(label)]! + 1];
    expect(after('Name')).toBe('Apollo');
    expect(after('Status')).toBe('Done');
    expect(after('Amount')).toBe('$1,234.50');
    expect(after('Done')).toBe('✓');
    expect(after('Files')).toBe('photo.png, readme.txt, chart.jpg');
    expect(after('Secret')).toBe('987,654');
    // Both pictures, each scaled to the page's width or less, and the text file only by name.
    const media = [...files.keys()].filter((name) => name.startsWith('word/media/') && !name.endsWith('/'));
    expect(media).toHaveLength(2);
    expect(count(document, /<w:drawing>/g)).toBe(2);
    const widths = [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    // 6.5 inches of Letter paper between the margins, in English Metric Units.
    const page = (12_240 - 2 * 1_080) * 635;
    for (const [width, height] of widths) {
      expect(width).toBeLessThanOrEqual(page);
      expect(width! > 0 && height! > 0).toBe(true);
    }
    expect(widths[0]![0]! / widths[0]![1]!).toBeCloseTo(2, 1);
    expect(widths[1]![0]! / widths[1]![1]!).toBeCloseTo(0.5, 1);
    expect(document).toMatch(
      /<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>(?:(?!<\/w:rPr>).)*<\/w:rPr><w:t[^>]*>Bold move<\/w:t>/,
    );
    // Comments only when asked for.
    expect(lines).not.toContain('Comments');
    const withComments = paragraphs(
      xml(
        await file(await call(server.owner, 'GET', recordUrl(tableId, ids.apollo, { comments: 'true' }))),
        'word/document.xml',
      ),
    ).filter(Boolean);
    const heading = withComments.indexOf('Comments');
    expect(heading).toBeGreaterThan(0);
    expect(withComments[heading + 1]).toMatch(/^Owner {2}[A-Z][a-z]+ \d{1,2}, \d{4}/);
    // A mention reads as the person's name now, not as it was typed.
    expect(withComments[heading + 2]).toBe('Ready for review, @Owner');
    const quiet = paragraphs(
      xml(
        await file(await call(server.owner, 'GET', recordUrl(tableId, ids.borealis, { comments: 'true' }))),
        'word/document.xml',
      ),
    ).filter(Boolean);
    expect(quiet.slice(quiet.indexOf('Comments'))).toEqual(['Comments', 'No comments yet.']);
  });

  it('draws at most 20 pictures and says how many it left out', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const name = newId('field');
    const pictures = newId('field');
    const created = await call(server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Gallery',
      table: {
        id: tableId,
        name: 'Albums',
        fields: [
          { id: name, name: 'Name', type: 'text' },
          { id: pictures, name: 'Pictures', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const bytes = await png(24, 24);
    const uploaded: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/tables/${tableId}/fields/${pictures}/files`,
        headers: {
          ...server.owner.headers,
          'content-type': 'image/png',
          'x-file-name': encodeURIComponent(`picture-${index}.png`),
        },
        payload: bytes,
      });
      expect(response.statusCode, response.body).toBe(200);
      uploaded.push(AttachmentMeta.parse(response.json()).id);
    }
    const recordId = newId('record');
    await run(databaseId, {
      kind: 'record.create',
      tableId,
      records: [{ id: recordId, values: { [name]: 'Summer', [pictures]: uploaded } }],
    });
    const files = await file(await call(server.owner, 'GET', recordUrl(tableId, recordId)));
    const document = xml(files, 'word/document.xml');
    expect(count(document, /<w:drawing>/g)).toBe(20);
    expect(paragraphs(document)).toContain('The first 20 of the record’s 21 images are shown.');
  });

  it('draws only pictures the virus scanner has cleared, in a document and in a deck', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const viewId = newId('view');
    const name = newId('field');
    const pictures = newId('field');
    const created = await call(server.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Intake',
      table: {
        id: tableId,
        name: 'Arrivals',
        fields: [
          { id: name, name: 'Name', type: 'text' },
          { id: pictures, name: 'Pictures', type: 'attachment' },
        ],
        view: { id: viewId, name: 'Grid' },
        records: [],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const upload = async (bytes: Buffer, file: string) => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/tables/${tableId}/fields/${pictures}/files`,
        headers: {
          ...server.owner.headers,
          'content-type': 'image/png',
          'x-file-name': encodeURIComponent(file),
        },
        payload: bytes,
      });
      expect(response.statusCode, response.body).toBe(200);
      return AttachmentMeta.parse(response.json()).id;
    };
    const wide = await png(800, 400);
    const held = await upload(wide, 'held.png');
    const waiting = await upload(wide, 'waiting.png');
    const cleared = await upload(await png(300, 600, '#0055aa'), 'cleared.png');
    // A file the scanner hasn't approved has no previews yet, only its original bytes.
    for (const [id, state] of [
      [held, 'quarantined'],
      [waiting, 'unavailable'],
    ] as const)
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'files')} SET scan_state = ${state}, thumbnails = NULL
          WHERE id = ${id}`,
      );
    const mixed = newId('record');
    const unscanned = newId('record');
    await run(databaseId, {
      kind: 'record.create',
      tableId,
      records: [
        { id: mixed, values: { [name]: 'Mixed', [pictures]: [held, waiting, cleared] } },
        { id: unscanned, values: { [name]: 'Unscanned', [pictures]: [held] } },
      ],
    });
    const drawn = async (recordId: string) => {
      const files = await file(await call(server.owner, 'GET', recordUrl(tableId, recordId)));
      const document = xml(files, 'word/document.xml');
      expect(
        [...files.keys()].filter((entry) => entry.startsWith('word/media/') && !entry.endsWith('/')),
      ).toHaveLength(count(document, /<w:drawing>/g));
      return [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(
        (match) => Number(match[1]) / Number(match[2]),
      );
    };
    // Only the cleared picture, which is the tall one, is drawn.
    const shapes = await drawn(mixed);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toBeCloseTo(0.5, 1);
    expect(await drawn(unscanned)).toEqual([]);
    const files = await file(await download(server.owner, viewId, 'pptx'));
    const deck = slides(files);
    const slide = (title: string) => deck.find((item) => texts(item, 'a:t')[0] === title)!;
    // The slide skips past the held files to the first cleared picture.
    expect(count(slide('Mixed'), /<p:pic>/g)).toBe(1);
    expect(count(slide('Unscanned'), /<p:pic>/g)).toBe(0);
    expect(
      [...files.keys()].filter((entry) => entry.startsWith('ppt/media/') && !entry.endsWith('/')),
    ).toHaveLength(1);
  });

  it('refuses a record the person can’t see and a format it doesn’t make', async () => {
    const { tableId, ids } = portfolio;
    const stranger = await server.addMember({ name: 'Rae Stranger' });
    expect((await call(stranger, 'GET', recordUrl(tableId, ids.apollo))).statusCode).toBe(404);
    expect(
      (await call(server.owner, 'GET', recordUrl(tableId, ids.apollo, { format: 'pptx' }))).statusCode,
    ).toBe(422);
    expect((await call(server.owner, 'GET', recordUrl(tableId, newId('record')))).statusCode).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Audit, and scheduled reports
 * --------------------------------------------------------------------------------------------- */

describe('the record of downloads, and reports that attach documents', () => {
  it('audits each download with what it was and how many records, and never a value', async () => {
    const { tableId, gridId, ids } = portfolio;
    await file(await download(server.owner, gridId, 'docx'));
    await file(await call(server.owner, 'GET', recordUrl(tableId, ids.cassini, { comments: 'true' })));
    const events = await query<{ action: string; actor_id: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, actor_id, metadata FROM ${ident(server.schemas.audit, 'events')}
        WHERE action IN ('databases.view.downloaded', 'databases.record.downloaded') ORDER BY id DESC LIMIT 2`,
    );
    expect(events.rows).toEqual([
      {
        action: 'databases.record.downloaded',
        actor_id: server.owner.userId,
        metadata: {
          databaseId: portfolio.databaseId,
          tableId,
          recordId: ids.cassini,
          format: 'docx',
          comments: true,
        },
      },
      {
        action: 'databases.view.downloaded',
        actor_id: server.owner.userId,
        metadata: { databaseId: portfolio.databaseId, tableId, viewId: gridId, format: 'docx', records: 3 },
      },
    ]);
  });

  it('attaches a Word document or a deck to a scheduled report', async () => {
    for (const format of ['docx', 'pptx'] as const) {
      sent.length = 0;
      const created = await call(server.owner, 'POST', `/api/views/${portfolio.gridId}/reports`, {
        name: `Weekly ${format}`,
        format,
        recipients: [{ kind: 'member', userId: server.owner.userId }],
        frequency: { kind: 'weekly', days: [1], at: '09:00' },
        timeZone: 'America/Chicago',
        enabled: true,
      });
      expect(created.statusCode, created.body).toBe(200);
      const report = created.json<ReportSchedule>();
      expect(report.format).toBe(format);
      const now = await call(server.owner, 'POST', `/api/reports/${report.id}/send`);
      expect(now.statusCode, now.body).toBe(200);
      expect(now.json<ReportRun>().state).toBe('sent');
      const attachment = sent[0]?.attachments?.[0];
      expect(attachment?.filename).toBe(`Projects - Everything.${format}`);
      expect(sent[0]!.text).toContain(`The view is in the attached file, Projects - Everything.${format}.`);
      const files = unzip(attachment!.content as Buffer);
      const words =
        format === 'docx'
          ? texts(xml(files, 'word/document.xml'), 'w:t')
          : slides(files).flatMap((slide) => texts(slide, 'a:t'));
      expect(words).toEqual(expect.arrayContaining(['Everything', 'Apollo', 'Borealis', 'Cassini']));
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * Filters in words
 * --------------------------------------------------------------------------------------------- */

describe('a filter in words', () => {
  it('words every kind of condition, nests groups, and skips what doesn’t apply', async () => {
    const read = await readFixture(server, [
      { type: 'text' },
      { type: 'singleSelect', options: { choices: Object.values(CHOICES) } },
      { type: 'date' },
      { type: 'checkbox' },
      { type: 'number', options: { precision: 1 } },
      { type: 'user' },
    ]);
    const [text, select, date, box, number, person] = read.fields;
    const fields = new Map(read.fields.map((field) => [field.id, field]));
    const names = {
      locale: 'en-US',
      timeZone: ZONE,
      people: new Map([[server.owner.userId, { id: server.owner.userId, name: 'Owner', email: '' }]]),
      files: new Map(),
      linked: new Map(),
      records: new Map(),
    };
    const filter: FilterGroup = {
      conjunction: 'and',
      conditions: [
        { id: 'a', fieldId: text!.id, operator: 'contains', value: 'moon' },
        { id: 'b', fieldId: select!.id, operator: 'isAnyOf', value: [CHOICES.done.id, CHOICES.waiting.id] },
        {
          conjunction: 'or',
          conditions: [
            { id: 'c', fieldId: date!.id, operator: 'isBefore', value: { mode: 'today' } },
            { id: 'd', fieldId: date!.id, operator: 'isWithin', value: { mode: 'pastDays', days: 3 } },
            { id: 'e', fieldId: date!.id, operator: 'isEmpty' },
          ],
        },
        { id: 'f', fieldId: box!.id, operator: 'is', value: true },
        { id: 'g', fieldId: number!.id, operator: 'lt', value: 2.5 },
        { id: 'h', fieldId: person!.id, operator: 'hasAnyOf', value: [server.owner.userId] },
        // Still missing a value, and on a field that's gone: both left out, as the query leaves them.
        { id: 'i', fieldId: text!.id, operator: 'is' },
        { id: 'j', fieldId: newId('field'), operator: 'is', value: 'x' },
      ],
    };
    expect(describeFilter(filter, fields, names)).toBe(
      'Field 0 contains “moon” and Field 1 is any of Done or Waiting and (Field 2 is before today or Field 2 is within the past 3 days or Field 2 is empty) and Field 3 is checked and Field 4 is less than 2.5 and Field 5 has any of Owner',
    );
    expect(describeFilter({ conjunction: 'and', conditions: [] }, fields, names)).toBeNull();
    expect(describeFilter(null, fields, names)).toBeNull();
  });
});
