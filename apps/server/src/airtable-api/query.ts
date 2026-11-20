import { isTimeZone } from '@riosoma/contracts';
import { z } from 'zod';
import { invalidRequest } from './errors.js';

/**
 * The parameters of a list request, from a query string the way Airtable's clients write one
 * (`fields[]=Name`, `sort[0][field]=Name`) or from the JSON body of `POST …/listRecords`.
 */
export interface ListParams {
  fields?: string[];
  filterByFormula?: string;
  maxRecords?: number;
  pageSize: number;
  sort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  view?: string;
  cellFormat: 'json' | 'string';
  timeZone?: string;
  userLocale?: string;
  returnFieldsByFieldId: boolean;
  offset?: string;
}

const Direction = z.enum(['asc', 'desc']).default('asc');

const Body = z.object({
  fields: z.array(z.string()).max(500).optional(),
  filterByFormula: z.string().optional(),
  maxRecords: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).default(100),
  sort: z
    .array(z.object({ field: z.string().min(1), direction: Direction }))
    .max(10)
    .default([]),
  view: z.string().min(1).optional(),
  cellFormat: z.enum(['json', 'string']).default('json'),
  timeZone: z.string().optional(),
  userLocale: z.string().optional(),
  returnFieldsByFieldId: z.boolean().default(false),
  offset: z.string().optional(),
});

function checked(params: ListParams): ListParams {
  if (params.filterByFormula === '') delete params.filterByFormula;
  if (params.timeZone !== undefined && !isTimeZone(params.timeZone))
    throw invalidRequest(`Invalid timeZone: "${params.timeZone}"`);
  if (params.userLocale !== undefined) {
    try {
      new Intl.NumberFormat(params.userLocale);
    } catch {
      throw invalidRequest(`Invalid userLocale: "${params.userLocale}"`);
    }
  }
  return params;
}

/**
 * The body of `POST …/listRecords`.  Airtable's JavaScript client sends `timeZone` and
 * `userLocale` in the query string even then, so they're read from there when the body has none.
 */
export function bodyParams(body: unknown, query: unknown): ListParams {
  const parsed = Body.safeParse(body ?? {});
  if (!parsed.success) throw invalidRequest();
  const raw = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  return checked({
    ...parsed.data,
    timeZone: parsed.data.timeZone ?? single(raw, 'timeZone'),
    userLocale: parsed.data.userLocale ?? single(raw, 'userLocale'),
  });
}

function single(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw invalidRequest(`The parameter "${key}" was given more than once`);
}

function whole(raw: Record<string, unknown>, key: string, max = Infinity): number | undefined {
  const value = single(raw, key);
  if (value === undefined) return undefined;
  const number = /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!(number >= 1 && number <= max)) throw invalidRequest(`Invalid ${key}: "${value}"`);
  return number;
}

function flag(raw: Record<string, unknown>, key: string): boolean {
  const value = single(raw, key);
  if (value === undefined) return false;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw invalidRequest(`Invalid ${key}: "${value}"`);
}

/** A list request's query string, as Fastify reads it: repeated keys come as arrays. */
export function queryParams(query: unknown): ListParams {
  const raw = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const list = (value: unknown) =>
    value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)];
  let fields: string[] | undefined;
  const sorts = new Map<number, { field?: string; direction?: string }>();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'fields' || /^fields\[\d*\]$/.test(key)) fields = [...(fields ?? []), ...list(value)];
    const sort = /^sort\[(\d{1,2})\]\[(field|direction)\]$/.exec(key);
    if (sort) {
      const entry = sorts.get(Number(sort[1])) ?? {};
      entry[sort[2] as 'field' | 'direction'] = single(raw, key);
      sorts.set(Number(sort[1]), entry);
    }
  }
  const sort = [...sorts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entry]) => {
      const direction = Direction.safeParse(entry.direction);
      if (!entry.field || !direction.success) throw invalidRequest('Each sort needs a field and a direction');
      return { field: entry.field, direction: direction.data };
    });
  if (sort.length > 10) throw invalidRequest('A list can sort by at most 10 fields');
  if (fields && fields.length > 500) throw invalidRequest('A list can ask for at most 500 fields');
  const cellFormat = single(raw, 'cellFormat') ?? 'json';
  if (cellFormat !== 'json' && cellFormat !== 'string')
    throw invalidRequest(`Invalid cellFormat: "${cellFormat}"`);
  const pageSize = whole(raw, 'pageSize', 100);
  const maxRecords = whole(raw, 'maxRecords');
  const filterByFormula = single(raw, 'filterByFormula');
  const view = single(raw, 'view');
  const timeZone = single(raw, 'timeZone');
  const userLocale = single(raw, 'userLocale');
  const offset = single(raw, 'offset');
  return checked({
    ...(fields ? { fields } : {}),
    ...(filterByFormula !== undefined && filterByFormula !== '' ? { filterByFormula } : {}),
    ...(maxRecords !== undefined ? { maxRecords } : {}),
    pageSize: pageSize ?? 100,
    sort,
    ...(view ? { view } : {}),
    cellFormat,
    ...(timeZone ? { timeZone } : {}),
    ...(userLocale ? { userLocale } : {}),
    returnFieldsByFieldId: flag(raw, 'returnFieldsByFieldId'),
    ...(offset ? { offset } : {}),
  });
}
