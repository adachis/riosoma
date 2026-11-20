import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppError,
  workbookPlace,
  type ExcelOnlineConnection,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
} from '@riosoma/contracts';
import { FileEngine, KEYS as ENGINE_KEYS, type FileColumn, type SpreadsheetReader } from '../files/engine.js';
import { sourceKey } from '../registry.js';
import { positive } from '../sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
} from '../types.js';
import { RowBatcher } from '../warehouses/values.js';
import {
  climb,
  GRAPH_API_URL,
  MicrosoftCall,
  microsoftConfig,
  microsoftFailure,
  MICROSOFT_KEYS,
  type MicrosoftOptions,
} from './client.js';
import { findSite, graphAddress, graphRefusal, type SiteInfo } from './graph.js';

/**
 * Excel workbooks kept in SharePoint or OneDrive for Business, downloaded through Microsoft Graph as
 * an Entra app and read the way uploaded workbooks are.  Graph's own workbook API doesn't take an
 * app's sign-in, so each call downloads the file, reads it in a private temporary directory with
 * the file sources' engine, and removes it before it returns.  A source names its workbooks by the
 * address Excel's Copy path gives, and offers each workbook's sheets by name, with the workbook's
 * ID in its drive as the schema, so moving or renaming the file keeps a synced table reading once
 * the source names its new address.  Each sheet's first row names its columns.  Nothing is ever
 * written to the workbook.
 */

export const EXCEL_KEYS = {
  site: 'sources.excel.site',
  denied: 'sources.excel.denied',
  notFound: 'sources.excel.notFound',
  notWorkbook: 'sources.excel.notWorkbook',
  noSheets: 'sources.excel.noSheets',
  tooLarge: ENGINE_KEYS.tooLarge,
} as const;

export interface ExcelOnlineOptions extends MicrosoftOptions {
  /** Where Graph answers.  Tests point it at a stand-in. */
  graphUrl?: string;
  /** Reads workbooks the way uploads are read.  Without one, no workbook can be read. */
  spreadsheet?: SpreadsheetReader;
  /** The largest workbook, which is read whole into memory: 50 MB unless set */
  spreadsheetMaxBytes?: number;
  /** Where each call's private directory goes: the system's temporary directory unless set */
  tempRoot?: string;
}

const DEFAULT_SPREADSHEET_BYTES = 50 * 1024 * 1024;

/** A workbook the source names, found in its drive. */
interface Workbook {
  address: string;
  driveId: string;
  itemId: string;
  name: string;
}

/** Sites and their libraries, found once for a call however many workbooks share them. */
interface Found {
  sites: Map<string, SiteInfo>;
  drives: Map<string, Array<{ id: string; parts: string[] }>>;
}

/** A library address's path, in parts, lowercased so they compare the way SharePoint does. */
function partsOf(address: string): string[] | null {
  if (!URL.canParse(address)) return null;
  try {
    return new URL(address).pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part).toLowerCase());
  } catch {
    return null;
  }
}

export function createExcelOnlineConnector(options: ExcelOnlineOptions = {}): Connector {
  const config = microsoftConfig(options);
  const graphUrl = (options.graphUrl ?? GRAPH_API_URL).replace(/\/+$/, '');
  const spreadsheetMaxBytes = options.spreadsheetMaxBytes ?? DEFAULT_SPREADSHEET_BYTES;

  function settingsOf(ctx: ConnectorContext): ExcelOnlineConnection {
    if (ctx.connection.kind !== 'excel-online')
      throw new ConnectorError(
        MICROSOFT_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not excel-online`,
      );
    return ctx.connection;
  }

  function begin(ctx: ConnectorContext, ms: number): MicrosoftCall {
    return new MicrosoftCall(config, ctx, settingsOf(ctx), graphUrl, ms);
  }

  function reader(): SpreadsheetReader {
    if (!options.spreadsheet)
      throw new ConnectorError(EXCEL_KEYS.notWorkbook, 'this server reads no workbooks');
    return options.spreadsheet;
  }

  /** A workbook the reader refused reads as one that isn't a workbook, with the reader's words. */
  function unreadable(error: unknown): unknown {
    if (error instanceof AppError && error.messageKey.startsWith('import.spreadsheet.'))
      return new ConnectorError(EXCEL_KEYS.notWorkbook, error.messageKey.slice('import.spreadsheet.'.length));
    return error;
  }

  /** Finds a workbook's file from its address: its site, the library it's in, and the file. */
  async function workbookOf(call: MicrosoftCall, address: string, found: Found): Promise<Workbook> {
    const place = workbookPlace(address);
    if (!place) throw new ConnectorError(EXCEL_KEYS.notFound, `${address} isn’t a workbook’s address`);
    let site = found.sites.get(place.site);
    if (!site) {
      site = await findSite(call, graphUrl, place.site, EXCEL_KEYS.denied, EXCEL_KEYS.site);
      found.sites.set(place.site, site);
    }
    let drives = found.drives.get(site.id);
    if (!drives) {
      drives = [];
      for await (const page of call.pages(
        graphAddress(graphUrl, `/sites/${encodeURIComponent(site.id)}/drives`, { $select: 'id,name,webUrl' }),
        (answer) =>
          graphRefusal(answer, place.site, EXCEL_KEYS.denied, () => new ConnectorError(EXCEL_KEYS.site)),
      ))
        for (const entry of page)
          if (typeof entry.id === 'string' && typeof entry.webUrl === 'string') {
            const parts = partsOf(entry.webUrl);
            if (parts) drives.push({ id: entry.id, parts });
          }
      found.drives.set(site.id, drives);
    }
    // The library is the one whose address the workbook's address starts with, the longest first.
    const wanted = partsOf(address) ?? [];
    const drive = drives
      .filter(
        (entry) =>
          entry.parts.length < wanted.length && entry.parts.every((part, index) => wanted[index] === part),
      )
      .sort((a, b) => b.parts.length - a.parts.length)[0];
    const missing = () => new ConnectorError(EXCEL_KEYS.notFound, `no workbook is at ${address}`);
    if (!drive) throw missing();
    const inDrive = place.path.slice(place.path.length - (wanted.length - drive.parts.length));
    const answer = await call.get(
      graphAddress(
        graphUrl,
        `/drives/${encodeURIComponent(drive.id)}/root:/${inDrive.map(encodeURIComponent).join('/')}`,
        { $select: 'id,name,file' },
      ),
    );
    if (answer.status < 200 || answer.status >= 300)
      throw graphRefusal(answer, address, EXCEL_KEYS.denied, missing);
    const item = call.json(answer) as { id?: unknown; name?: unknown; file?: unknown };
    if (typeof item.id !== 'string' || typeof item.file !== 'object' || item.file === null) throw missing();
    return {
      address,
      driveId: drive.id,
      itemId: item.id,
      name: typeof item.name === 'string' ? item.name : (place.path.at(-1) ?? address),
    };
  }

  /** The workbook's bytes, from the address Graph sends its content to. */
  async function download(call: MicrosoftCall, workbook: Workbook): Promise<Buffer> {
    const answer = await call.get(
      graphAddress(
        graphUrl,
        `/drives/${encodeURIComponent(workbook.driveId)}/items/${encodeURIComponent(workbook.itemId)}/content`,
      ),
      {},
      { maxBytes: spreadsheetMaxBytes },
    );
    if (answer.status < 200 || answer.status >= 300)
      throw graphRefusal(
        answer,
        workbook.address,
        EXCEL_KEYS.denied,
        () => new ConnectorError(EXCEL_KEYS.notFound, `no workbook is at ${workbook.address}`),
      );
    return answer.body;
  }

  /** A workbook's sheets, in order, by name. */
  async function sheetsOf(call: MicrosoftCall, bytes: Buffer): Promise<string[]> {
    const names: string[] = [];
    try {
      for await (const event of reader()(bytes, { signal: call.signal }))
        if (event.kind === 'sheet') names.push(event.name);
    } catch (error) {
      throw unreadable(error);
    }
    return names;
  }

  /** The workbook and sheet a select names: the workbook by its ID in its drive, the sheet by name. */
  async function placeOf(
    call: MicrosoftCall,
    select: SourceSelect,
  ): Promise<{ workbook: Workbook; sheet: string }> {
    if (select.kind !== 'object')
      throw new ConnectorError(MICROSOFT_KEYS.noQueries, 'Excel workbook sources read sheets, not queries');
    const found: Found = { sites: new Map(), drives: new Map() };
    for (const address of settingsOf(call.ctx).workbooks) {
      const workbook = await workbookOf(call, address, found);
      if (workbook.itemId === select.object.schema) return { workbook, sheet: select.object.name };
    }
    throw new ConnectorError(MICROSOFT_KEYS.objectMissing, 'the source’s workbooks have no such sheet', {
      object: select.object.name,
    });
  }

  /**
   * One sheet of a workbook, read into an engine in a private directory, and how to let it go,
   * which removes the directory with everything in it.
   */
  async function openSheet(
    call: MicrosoftCall,
    select: SourceSelect,
  ): Promise<{ engine: FileEngine; columns: FileColumn[]; close(): Promise<void> }> {
    const { workbook, sheet } = await placeOf(call, select);
    const bytes = await download(call, workbook);
    const dir = await realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'riosoma-source-')));
    let engine: FileEngine | undefined;
    const stop = () => engine?.interrupt();
    call.signal.addEventListener('abort', stop, { once: true });
    const close = async () => {
      call.signal.removeEventListener('abort', stop);
      engine?.close();
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const path = join(dir, 'workbook.xlsx');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      engine = await FileEngine.open(dir);
      try {
        await engine.load([{ name: workbook.name, path, format: 'xlsx' }], {
          sheet,
          spreadsheet: reader(),
          spreadsheetMaxBytes,
          signal: call.signal,
        });
      } catch (error) {
        if (error instanceof ConnectorError && error.messageKey === ENGINE_KEYS.sheetMissing)
          throw new ConnectorError(MICROSOFT_KEYS.objectMissing, `${workbook.name} has no sheet ${sheet}`, {
            object: sheet,
          });
        throw unreadable(error);
      }
      call.signal.throwIfAborted();
      return { engine, columns: await engine.describe(), close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** Runs `action` against one sheet of a workbook, and lets the sheet go before this returns. */
  async function withSheet<T>(
    call: MicrosoftCall,
    select: SourceSelect,
    action: (engine: FileEngine, columns: FileColumn[]) => Promise<T>,
  ): Promise<T> {
    const opened = await openSheet(call, select);
    try {
      return await action(opened.engine, opened.columns);
    } finally {
      await opened.close();
    }
  }

  async function look(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number | null,
  ): Promise<SourcePreviewRows> {
    let call: MicrosoftCall | undefined;
    try {
      const rows = limit === null ? 0 : positive(limit, 50);
      call = begin(ctx, positive(ctx.timeoutMs, 30000));
      return await withSheet(call, select, async (engine, columns) => {
        const shown: unknown[][] = [];
        if (rows > 0)
          for await (const chunk of engine.rows(
            columns.map((entry) => entry.column.name),
            rows,
          ))
            shown.push(...chunk);
        return {
          columns: columns.map((entry) => entry.column),
          rows: shown.map((row) =>
            columns.map((entry, index) =>
              entry.column.suggested ? entry.value(row[index], entry.column.suggested.type) : null,
            ),
          ),
          rowEstimate: await engine.count(),
        };
      });
    } catch (error) {
      throw microsoftFailure(error, ctx, config, call);
    }
  }

  return {
    kind: 'excel-online',
    test(ctx) {
      const settings = settingsOf(ctx);
      let tested: MicrosoftCall | undefined;
      let first: { workbook: Workbook; sheet: string } | undefined;
      return climb(ctx, config, new URL(graphUrl), (ms) => (tested = begin(ctx, ms)), [
        {
          step: 'workbooks',
          async run(within) {
            const found: Found = { sites: new Map(), drives: new Map() };
            for (const address of settings.workbooks) {
              const workbook = await within(() => workbookOf(tested!, address, found));
              const sheets = await within(async () => sheetsOf(tested!, await download(tested!, workbook)));
              if (!sheets.length)
                throw new ConnectorError(EXCEL_KEYS.noSheets, `${workbook.name} has no sheets`);
              first ??= { workbook, sheet: sheets[0]! };
            }
          },
        },
        {
          step: 'rows',
          async run(within) {
            const { workbook, sheet } = first!;
            await within(() =>
              withSheet(
                tested!,
                { kind: 'object', object: { schema: workbook.itemId, name: sheet } },
                async () => undefined,
              ),
            );
          },
        },
      ]);
    },
    async listObjects(ctx): Promise<SourceObject[]> {
      let call: MicrosoftCall | undefined;
      try {
        call = begin(ctx, config.deadlineMs);
        const found: Found = { sites: new Map(), drives: new Map() };
        const objects: SourceObject[] = [];
        for (const address of settingsOf(ctx).workbooks) {
          const workbook = await workbookOf(call, address, found);
          for (const sheet of await sheetsOf(call, await download(call, workbook)))
            objects.push({
              schema: workbook.itemId,
              schemaLabel: workbook.name,
              name: sheet,
              label: sheet,
              type: 'sheet',
              rowEstimate: null,
            });
        }
        return objects;
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
    async describe(ctx, select) {
      return (await look(ctx, select, null)).columns;
    },
    preview: (ctx, select, limit) => look(ctx, select, limit),
    async keyCandidates(ctx, object: SourceObjectRef) {
      let call: MicrosoftCall | undefined;
      try {
        call = begin(ctx, config.deadlineMs);
        return await withSheet(call, { kind: 'object', object }, (engine, columns) =>
          engine.keyCandidates(columns),
        );
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
    async *read(ctx, select, readOptions) {
      let call: MicrosoftCall | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        call = begin(ctx, config.deadlineMs);
        const running = call;
        const { engine, columns, close } = await openSheet(running, select);
        try {
          const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
          // A column that has gone from the sheet fails the sync, rather than emptying its field.
          const columnOf = (name: string): FileColumn => {
            const entry = byName.get(name);
            if (!entry)
              throw new ConnectorError(
                MICROSOFT_KEYS.columnMissing,
                `the sheet has no column named ${name}`,
                {
                  column: name,
                },
              );
            return entry;
          };
          const wanted = readOptions.columns.map(columnOf);
          const keys = readOptions.keyColumns.map(columnOf);
          const names = [...new Set([...wanted, ...keys].map((entry) => entry.column.name))];
          const place = new Map(names.map((name, index) => [name, index]));
          const batcher = new RowBatcher<SourceRow>(size);
          const toRow = (row: unknown[]): SourceRow => ({
            key: sourceKey(keys.map((entry) => entry.key(row[place.get(entry.column.name)!]))),
            values: Object.fromEntries(
              wanted.map((entry) => [
                entry.column.name,
                entry.value(
                  row[place.get(entry.column.name)!],
                  readOptions.types[entry.column.name] ?? entry.column.suggested?.type ?? 'text',
                ),
              ]),
            ),
          });
          for await (const chunk of engine.rows(names))
            for (const batch of batcher.add(chunk.map(toRow))) {
              running.signal.throwIfAborted();
              yield batch;
            }
          const rest = batcher.flush();
          running.signal.throwIfAborted();
          if (rest) yield rest;
        } finally {
          await close();
        }
      } catch (error) {
        throw microsoftFailure(error, ctx, config, call);
      }
    },
  };
}
