import { resolveSelectOptions } from '../data/select-options.js';
import {
  AppError,
  checkCellValue,
  fieldDefault,
  idsOf,
  ROUTINE_BELL_VALUES,
  ROUTINE_BELL_FIELDS,
  ROUTINE_BELL_RECORDS,
  ROUTINE_NAMED_RECORDS,
  ROUTINE_PLAIN_FIELD_TYPES,
  sameValue,
} from '@riosoma/contracts';
import type {
  Autonomy,
  CellValue,
  Command,
  RoutineChanges,
  RoutineFieldChange,
  RoutineTableChange,
  RoutineRecordChange,
  RoutineValueChange,
  RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { canApply, type Impact } from '../ai/plans.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { formatValue, relationContext } from '../data/format.js';
import { loadFields, loadTables } from '../data/metadata.js';
import { ridsForIds } from '../data/physical/order.js';
import { fetchPageByRid, recordFingerprints } from '../data/physical/records.js';
import type { StoredField, StoredTable } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { ROUTINE_ATTACHMENT_COPY, ROUTINE_CHOICE_COPY, ROUTINE_PERSON_COPY } from '../reports/email.js';
import { formatMessage } from '../reports/messages.js';
import { signatureSnapshots, type SignatureSnapshot } from '../signatures/store.js';
import type { HeldCell } from './store.js';

/**
 * What a plan waiting for approval does, worked out from its commands and the database as it is,
 * through its owner's access, and never from the words the model wrote about it.  The owner reads
 * this first: each table and how many records, which fields go from what to what, every record it
 * deletes, and every signature request it cancels.  Routines change records alone, so a command of
 * any other kind is refused.
 *
 * A change is judged by stored values, never by how they're written out, and a value a record
 * already holds is dropped from the commands, so nothing is written that this doesn't name.  Each
 * cell a plan writes keeps what it held (`held`), for approving to compare with the cell as it is.
 * A short value is shown whole, and a long one as the stretch holding every difference when that
 * fits.  A number shows every stored digit, and a time its seconds, in the routine's own labeled
 * time zone.  Two values that read the same are shown with what's stored, and a character that
 * could pass for another, or can't be seen at all, is shown as its code (`\u0430`), with runs of
 * spaces, tabs, and new lines as marks.  Record rows retain every full value with its identity.
 *
 * Record rows sort by ID, and their fields by position.  Legacy field summaries retain their
 * previous ordering.  The order follows the database, never the order a command's values came in,
 * so the same plan worked out twice reads the same: tables by ID, fields by their place in the
 * table and then ID, and each field's changes by how many records they reach, then by their text.
 *
 * A plan is small, for the bell's one click, only when the autonomy rules would let Rio make it
 * without a preview, it only adds or edits plain values in twenty records or fewer, in fields
 * nothing else reads, matches on, filters or sorts a view an automation watches by, or shows
 * through a link, no automation in the database runs a script, every record it edits is named,
 * and every change it makes is shown here in full and plainly, with no field listing more changes
 * than the bell shows.
 */

/** The most distinct changes listed for one field, and the longest value shown */
const VALUES_PER_FIELD = 10;
const VALUE_LENGTH = 200;
/** The most deleted records named */
const NAMED = 10;
/** The most records a plan the bell approves in one click may change */
const SMALL = 20;

const PLAIN = new Set<string>(ROUTINE_PLAIN_FIELD_TYPES);
/** Only name characters that cannot pose as list or identity delimiters may stay unquoted */
const plainName = (name: string) => !!name && !/[^\p{L}\p{M}\p{Nd} ._'-]/u.test(name);

/**
 * A changed pair as the owner reads it: whole when both are short, and otherwise the same stretch
 * of each, from a little before where they first differ.  `whole` says whether every difference
 * is inside what's shown: false when the differences spread further than one stretch, and always
 * for a long value a new record is given, which has nothing to differ from.
 */
function shown(
  before: string,
  after: string,
  creating: boolean,
): { from: string; to: string; whole: boolean } {
  const was = Array.from(before);
  const now = Array.from(after);
  if (was.length <= VALUE_LENGTH && now.length <= VALUE_LENGTH)
    return { from: before, to: after, whole: true };
  let at = 0;
  while (at < was.length && at < now.length && was[at] === now[at]) at += 1;
  // How much the two share at their ends, which can't reach back past where they first differ.
  let tail = 0;
  while (
    tail < was.length - at &&
    tail < now.length - at &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]
  )
    tail += 1;
  const start = Math.max(0, at - 40);
  const end = start + VALUE_LENGTH - 2;
  const cut = (chars: string[]) =>
    `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${chars.length > end ? '…' : ''}`;
  const last = Math.max(was.length, now.length) - tail;
  return { from: cut(was), to: cut(now), whole: !creating && last <= end };
}

const shorten = (text: string) =>
  Array.from(text).length > VALUE_LENGTH
    ? `${Array.from(text)
        .slice(0, VALUE_LENGTH - 1)
        .join('')}…`
    : text;

/**
 * Characters no one can see, or that can look like another: controls, formats, odd spaces, every
 * default-ignorable code point (joiners, variation selectors, fillers), and the braille blank
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}\u2800]/u;
/** Fields whose values are addresses, where any letter outside ASCII is shown as its code */
const ADDRESSES = new Set(['email', 'url']);
/** The marks spacing is shown with, which a value's own copy of one is shown as a code beside */
const MARKS: Record<string, string> = { '\n': '↵', '\t': '⇥', '\r': '␍' };
const MARKED = new Set(['·', ...Object.values(MARKS)]);
/**
 * Scripts a letter is recognized in.  A letter of any other script counts as foreign to every
 * value, so it's always shown as its code.
 */
const SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Armenian',
  'Georgian',
  'Hebrew',
  'Arabic',
  'Syriac',
  'Thaana',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Thai',
  'Lao',
  'Tibetan',
  'Myanmar',
  'Ethiopic',
  'Cherokee',
  'Canadian_Aboriginal',
  'Khmer',
  'Mongolian',
  'Hiragana',
  'Katakana',
  'Bopomofo',
  'Han',
  'Hangul',
  'Yi',
  'Lisu',
  'Vai',
  'Tifinagh',
  'Coptic',
  'Glagolitic',
  'Nko',
  'Adlam',
  'Javanese',
].map((name) => ({ name, test: new RegExp(`\\p{Script=${name}}`, 'u') }));
const LETTER = /\p{L}/u;

/** The scripts a value's letters are written in, or Latin when it has none. */
function scriptsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const char of text)
    if (LETTER.test(char)) for (const script of SCRIPTS) if (script.test.test(char)) found.add(script.name);
  return found.size ? found : new Set(['Latin']);
}

const code = (char: string) => {
  const point = char.codePointAt(0)!;
  const hex = point.toString(16).toUpperCase();
  // Braces keep an astral code distinct from a shorter code followed by a hex digit.
  return point > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`;
};

/**
 * A value as the owner should read it, beside `reference`, the value it replaces.  Characters that
 * can't be seen, letters from a script `reference` isn't written in, anything NFKC would change,
 * and anything outside ASCII in an address are shown as their codes, setting `odd`.  Runs of
 * spaces, and spaces at either end, show as `·`, and tabs and new lines as `⇥` and `↵`.
 */
export function reveal(
  text: string,
  fieldType: string,
  reference: string = text,
): { text: string; odd: boolean } {
  const allowed = scriptsOf(reference);
  const chars = Array.from(text);
  let odd = false;
  const out = chars.map((char, index) => {
    if (char === ' ') {
      const spaced =
        index === 0 || index === chars.length - 1 || chars[index - 1] === ' ' || chars[index + 1] === ' ';
      return spaced ? '·' : ' ';
    }
    if (MARKS[char]) return MARKS[char]!;
    if (MARKED.has(char)) return code(char);
    const foreign =
      LETTER.test(char) && !SCRIPTS.some((script) => allowed.has(script.name) && script.test.test(char));
    const suspect =
      (char === '\\' && /^u(?:[0-9a-f]{4}|\{)/iu.test(chars.slice(index + 1, index + 6).join(''))) ||
      HIDDEN.test(char) ||
      char.normalize('NFKC') !== char ||
      foreign ||
      (ADDRESSES.has(fieldType) && char.codePointAt(0)! > 0x7e);
    if (!suspect) return char;
    odd = true;
    return code(char);
  });
  return { text: out.join(''), odd };
}

/** Text with its spacing collapsed, for telling whether two values differ only in spacing */
const collapsed = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** Numbers as they're stored, beside how their field writes them when it drops a digit. */
function lossless(field: StoredField, value: CellValue): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return true;
  const options = field.options as { precision?: number | null; format?: string };
  const same = (decimals: number) => Number(value.toFixed(Math.min(100, decimals))) === value;
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'formula':
    case 'rollup':
      return same(options.precision ?? 10);
    case 'percent':
      return same((options.precision ?? 0) + 2);
    case 'duration':
      return options.format === 'h:mm'
        ? value % 60 === 0
        : same(Math.max(0, (options.format ?? 'h:mm:ss').length - 8));
    default:
      return true;
  }
}

/** A time with its seconds, in `timeZone`, with the zone named. */
function timeText(iso: string, locale: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const format = (zone: string) => {
    const text = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'long', timeZone: zone })
      .format(at)
      .replace(/[\u202F\u00A0]/gu, ' ');
    return at.getUTCMilliseconds() ? `${text} [${at.toISOString()}]` : text;
  };
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** A stand-in record holding values a command would write, so they can be worded like stored ones. */
function written(id: string, values: Record<string, CellValue>): RowData {
  return { id, values, createdAt: '', createdBy: null, updatedAt: '', updatedBy: null };
}

/**
 * The changes a plan makes, its commands without any value a record already holds, and what each
 * cell an update writes holds now, complete delete and restore target fingerprints, and exact
 * command effects, including derived assignments
 */
export interface Described {
  changes: RoutineChanges;
  commands: Command[];
  held: HeldCell[];
  targets: Array<{ tableId: string; recordId: string; hash: string }>;
  effects: unknown[];
  signatures: SignatureSnapshot[];
}

/** Whether a configuration anywhere in it has a step that runs a script */
function runsScript(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(runsScript);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'script' || Object.values(record).some(runsScript);
}

/**
 * Fields a change to which the bell never takes in one click: any another field reads (formulas,
 * lookups, rollups, counts, AI prompts, buttons, and a link's `match`), any an automation or a
 * record rule names, any in the filter or sorts of a view an automation's trigger watches, and the
 * primary field of any table a link points at, which that link shows.  An automation with a script
 * step can read any record in its database, so then every field is one.
 */
async function referenced(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  fields: readonly StoredField[],
  tablesHere: readonly StoredTable[],
): Promise<Set<string>> {
  const texts = fields.map((field) => JSON.stringify([field.options ?? null, field.ai ?? null]));
  const automations = await query<{ config: unknown; text: string }>(
    db,
    sql`SELECT config, config::text AS text FROM ${ident(schemas.app, 'automations')}
    WHERE database_id = ${databaseId} AND trashed_at IS NULL`,
  );
  if (automations.rows.some((row) => runsScript(row.config))) return new Set(fields.map((field) => field.id));
  const watched = automations.rows.flatMap((row) => {
    const trigger = (row.config as { trigger?: { viewId?: unknown } } | null)?.trigger;
    return typeof trigger?.viewId === 'string' ? [trigger.viewId] : [];
  });
  const views = watched.length
    ? await query<{ text: string }>(
        db,
        sql`SELECT coalesce(config->'filter', 'null'::jsonb)::text || ' ' || coalesce(config->'sorts', 'null'::jsonb)::text AS text
        FROM ${ident(schemas.app, 'views')} WHERE id = ANY(${watched}::text[])`,
      )
    : { rows: [] };
  const rules = await query<{ text: string }>(
    db,
    sql`SELECT condition::text AS text FROM ${ident(schemas.app, 'record_rules')} WHERE database_id = ${databaseId}`,
  );
  const naming = [
    ...texts,
    ...automations.rows.map((row) => row.text),
    ...views.rows.map((row) => row.text),
    ...rules.rows.map((row) => row.text),
  ].join('\n');
  const found = new Set(fields.filter((field) => naming.includes(field.id)).map((field) => field.id));
  const primaries = new Map(tablesHere.map((table) => [table.id, table.primaryFieldId]));
  for (const field of fields)
    if (field.type === 'link') {
      const target = (field.options as { linkedTableId?: unknown }).linkedTableId;
      const primary = typeof target === 'string' ? primaries.get(target) : undefined;
      if (primary) found.add(primary);
    }
  return found;
}

export async function describeChanges(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  databaseId: string,
  commands: readonly Command[],
  impact: Impact,
  locale: string,
  /** The owner's effective autonomy, so the bell never bypasses their preview requirement. */
  autonomy: Autonomy,
  /** The routine's time zone, which times are shown in */
  timeZone: string,
): Promise<Described> {
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(databaseId, 'read');
  const tablesHere = await loadTables(db, schemas, databaseId, { includeTrashed: true });
  const tableById = new Map(tablesHere.map((table) => [table.id, table]));
  const fields = await loadFields(
    db,
    schemas,
    tablesHere.map((table) => table.id),
    { includeTrashed: true },
  );
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const live = await loadFields(
    db,
    schemas,
    tablesHere.map((table) => table.id),
  );
  const keyed = await referenced(db, schemas, databaseId, live, tablesHere);
  const tableName = (id: string | undefined) => (id ? (tableById.get(id)?.name ?? '') : '');

  const byTable = new Map<string, RoutineTableChange>();
  const pairs = new Map<string, Map<string, Map<string, RoutineValueChange>>>();
  const entry = (tableId: string, name?: string): RoutineTableChange => {
    let found = byTable.get(tableId);
    if (!found) {
      found = {
        tableId,
        tableName: name ?? tableName(tableId),
        created: 0,
        updated: 0,
        trashed: 0,
        restored: 0,
        trashedNames: [],
        fields: [],
        records: [],
        signaturesCanceled: 0,
      };
      byTable.set(tableId, found);
    }
    return found;
  };
  let deletes = impact.deletes;
  /** Set when something the plan changes can't be shown here in full and plainly */
  let unshown = false;
  /** Cleared when the plan writes anything but a plain value nothing else reads */
  let plain = true;
  const kept: Command[] = [];
  const held: HeldCell[] = [];
  const targets: Described['targets'] = [];
  const signatures: SignatureSnapshot[] = [];
  const refuse = () => new AppError('validation_failed', 'routines.changes.incomplete');
  if (!impact.effects) throw refuse();
  // One row cannot disclose intermediate assignments from repeated direct writes.
  const requested = new Set<string>();
  for (const command of commands) {
    if (!('tableId' in command)) throw refuse();
    const ids =
      'records' in command
        ? command.records.map((record) => record.id)
        : 'recordIds' in command
          ? command.recordIds
          : [];
    for (const id of ids) {
      const key = `${command.tableId}:${id}`;
      if (requested.has(key)) throw refuse();
      requested.add(key);
    }
    // Matched lists use physical creation order, which simulated row numbers cannot promise.
    if (
      command.kind === 'record.create' &&
      live.some((field) => field.tableId === command.tableId && field.type === 'link' && field.options.match)
    )
      throw refuse();
  }

  // A new record's fields the plan leaves out take their defaults.  Those values aren't the plan's
  // own, so its description leaves them out, and a default that reads the clock, such as today's
  // date, stays out of the exact comparison as well.
  const given = new Map(
    commands.flatMap((command) =>
      command.kind === 'record.create'
        ? command.records.map((record) => [`${command.tableId}:${record.id}`, record.values] as const)
        : [],
    ),
  );
  const defaulted = (tableId: string, recordId: string, fieldId: string) => {
    const values = given.get(`${tableId}:${recordId}`);
    const field = fieldById.get(fieldId);
    return values && field && !Object.hasOwn(values, fieldId) ? fieldDefault(field) : undefined;
  };
  const clocked = (tableId: string, recordId: string, values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).filter(([fieldId]) => {
        const kind = defaulted(tableId, recordId, fieldId)?.kind;
        return kind !== 'today' && kind !== 'now';
      }),
    );

  // Keep only stored assignments, never validation timestamps, in the exact comparison.
  if (impact.records.size > 200) throw refuse();
  const effects = impact.effects.map((effect) => {
    switch (effect.kind) {
      case 'record.created':
      case 'record.updated':
      case 'record.restored':
        return {
          kind: effect.kind,
          tableId: effect.tableId,
          records: effect.records.map(({ id, values }) => ({
            id,
            values: effect.kind === 'record.created' ? clocked(effect.tableId, id, values) : values,
          })),
        };
      case 'record.trashed':
      case 'record.linksChanged':
        return effect;
      default:
        throw refuse();
    }
  });
  const recordRows = new Map<string, RoutineRecordChange>();
  function recordEntry(table: StoredTable, id: string, name: string, kind: RoutineRecordChange['kind']) {
    const key = `${table.id}:${id}`;
    let row = recordRows.get(key);
    if (!row) {
      row = { recordId: id, name, showId: true, kind, fields: [] };
      recordRows.set(key, row);
      entry(table.id).records!.push(row);
    }
    return row;
  }
  // Link effects are assignments too, including inverse lists and matches through lookups.
  const derived = new Map<string, Map<string, Record<string, CellValue>>>();
  for (const effect of impact.effects) {
    if (effect.kind !== 'record.linksChanged' && effect.kind !== 'record.updated') continue;
    let rows = derived.get(effect.tableId);
    if (!rows) derived.set(effect.tableId, (rows = new Map()));
    for (const record of effect.records) {
      const values = rows.get(record.id) ?? {};
      if (effect.kind === 'record.linksChanged' && 'ids' in record) values[effect.fieldId] = record.ids;
      else if ('values' in record)
        for (const [id, value] of Object.entries(record.values)) {
          if (['lookup', 'rollup', 'count', 'formula'].includes(fieldById.get(id)?.type ?? ''))
            values[id] = value;
        }
      if (Object.keys(values).length) rows.set(record.id, values);
    }
  }
  const creating = new Map(
    commands.flatMap((command) =>
      command.kind === 'record.create'
        ? command.records.map((record) => [`${command.tableId}:${record.id}`, record] as const)
        : [],
    ),
  );
  const returning = new Map(
    impact.effects.flatMap((effect) =>
      effect.kind === 'record.created' || effect.kind === 'record.restored'
        ? effect.records.map((record) => [`${effect.tableId}:${record.id}`, record.values] as const)
        : [],
    ),
  );
  const createdValues = new Map(
    impact.effects.flatMap((effect) =>
      effect.kind === 'record.created'
        ? effect.records.map((record) => [`${effect.tableId}:${record.id}`, record.values] as const)
        : [],
    ),
  );

  /** The records each name stands for, since two records by one name can't be told apart */
  const namesSeen = new Map<string, string>();
  /** Where a field sits in its table, so fields always come in the same order */
  const order = (a: string, b: string) => {
    const [x, y] = [fieldById.get(a), fieldById.get(b)];
    return (x?.position ?? 0) - (y?.position ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  };

  /**
   * Words for a table's cells, whole, through the owner's access.  A number a field would write
   * with fewer digits than it holds shows what's stored beside it, and a time shows its seconds in
   * the routine's labeled time zone.
   */
  async function wording(table: StoredTable, rows: readonly RowData[]) {
    const visible = await resolveSelectOptions(
      db,
      schemas,
      scope,
      scope.visibleFields(
        table.id,
        live.filter((field) => field.tableId === table.id),
      ),
    );
    const names = await relationContext({ db, schemas, table, scope, fields: visible, rows, names: true });
    const context = { locale, timeZone, ...names };
    const labelText = (name: string): string => {
      // Quotes keep a name's delimiters from posing as another entry or its identity.
      if (plainName(name)) return name;
      unshown = true;
      return JSON.stringify(name);
    };
    const word = (field: StoredField, value: CellValue | undefined): string => {
      field = visible.find((item) => item.id === field.id) ?? field;
      if (value === undefined || value === null)
        return value === undefined ? '' : formatValue(field, value, context);
      if (field.type === 'lookup' && field.relation?.target) {
        const target = field.relation.target;
        const list = Array.isArray(value) ? value : [value];
        const multiple = ['multipleSelect', 'link', 'user', 'attachment'].includes(target.type);
        return list
          .map((item) => word(target, multiple ? [item] : item))
          .filter(Boolean)
          .join(', ');
      }
      if (
        ((field.type === 'date' && field.options.includeTime) ||
          ((field.type === 'formula' || field.type === 'rollup') &&
            field.options.resultType === 'datetime')) &&
        typeof value === 'string'
      ) {
        if (new Date(value).getUTCMilliseconds()) unshown = true;
        return timeText(value, locale, timeZone);
      }
      if (field.type === 'link') {
        const ids = idsOf(value);
        if (ids.some((id) => !names.linked.has(id) && !returning.has(`${field.options.linkedTableId}:${id}`)))
          throw refuse();
        return ids
          .map((id) => {
            const pending = returning.get(`${field.options.linkedTableId}:${id}`);
            const primaryId = tableById.get(field.options.linkedTableId)?.primaryFieldId;
            const primary = primaryId ? fieldById.get(primaryId) : undefined;
            if (pending && primary && !scope.visibleFields(primary.tableId, [primary]).length) throw refuse();
            const label =
              names.linked.get(id) ??
              (primary && pending ? formatValue(primary, pending[primary.id] ?? null, context) : '');
            return label ? `${labelText(label)} [${id}]` : id;
          })
          .join(', ');
      }
      if (['user', 'createdBy', 'lastModifiedBy'].includes(field.type)) {
        return idsOf(Array.isArray(value) ? value : [value])
          .map((id) => {
            const person = names.people.get(id);
            // An unresolved account cannot be presented as an empty assignment.
            if (!person?.email) throw refuse();
            return formatMessage(
              ROUTINE_PERSON_COPY.message,
              { id: person.id, email: person.email, name: labelText(person.name) },
              { locale, html: false },
            );
          })
          .join(', ');
      }
      if (field.type === 'attachment') {
        return idsOf(value)
          .map((id) => {
            const file = names.files.get(id);
            // Missing metadata cannot turn a stored file into an empty assignment.
            if (!file) throw refuse();
            return formatMessage(
              ROUTINE_ATTACHMENT_COPY.message,
              {
                name: labelText(file.name),
                size: file.size,
                id: file.id,
              },
              { locale, html: false },
            );
          })
          .join(', ');
      }
      if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
        const choices = [
          ...field.options.choices,
          ...[...(names.selectChoices?.get(field.id) ?? [])].map(([id, name]) => ({ id, name })),
        ];
        // Quotes preserve list boundaries and keep a choice's own brackets from posing as an ID.
        const quoted = choices.some((choice) => !plainName(choice.name));
        if (quoted) unshown = true;
        return idsOf(Array.isArray(value) ? value : [value])
          .map((id) => {
            const choice = choices.find((item) => item.id === id);
            if (!choice) throw refuse();
            const name = labelText(choice.name);
            return choices.some((item) => item.id !== id && item.name === choice.name)
              ? formatMessage(ROUTINE_CHOICE_COPY.message, { name, id }, { locale, html: false })
              : name;
          })
          .join(', ');
      }
      const text = formatValue(field, value, context);
      if (lossless(field, value)) return text;
      unshown = true;
      return `${text} [${String(value)}]`;
    };
    return word;
  }

  async function current(
    table: StoredTable,
    ids: readonly string[],
    trashed = false,
  ): Promise<Map<string, RowData>> {
    if (!ids.length) return new Map();
    const visible = await resolveSelectOptions(
      db,
      schemas,
      scope,
      scope.visibleFields(
        table.id,
        live.filter((field) => field.tableId === table.id),
      ),
    );
    const rids = await ridsForIds(db, schemas.data, table.id, [...ids], trashed);
    const rows = await fetchPageByRid(
      db,
      schemas.data,
      table.id,
      visible,
      ids.flatMap((id) => (rids.has(id) ? [rids.get(id)!] : [])),
      scope.recordPredicate(table.id),
      { now: new Date(), timeZone: 'UTC' },
      trashed,
    );
    return new Map(rows.flatMap((row) => (row ? [[row.id, row] as const] : [])));
  }

  /** Open signature requests edits cancel, by taking away the document each was made from. */
  async function canceling(
    table: StoredTable,
    records: ReadonlyArray<{ id: string; values: Record<string, unknown> }>,
  ): Promise<number> {
    const attachments = new Set(
      live
        .filter((field) => field.tableId === table.id && field.type === 'attachment')
        .map((field) => field.id),
    );
    // Later entries for the same record replace earlier ones, as they do when the edit is made.
    const final = new Map<string, Record<string, unknown>>();
    for (const record of records)
      if (Object.keys(record.values).some((id) => attachments.has(id)))
        final.set(record.id, { ...final.get(record.id), ...record.values });
    if (!final.size) return 0;
    const requests = await signatureSnapshots(
      db,
      schemas,
      scope,
      table.id,
      [...final].map(([id, values]) => ({ id, values })),
    );
    signatures.push(...requests);
    return requests.filter((request) => request.cancels).length;
  }

  /**
   * Counts a change by its whole values, so two that differ only past what's shown never merge,
   * with the name of the record an update makes it in.
   */
  function count(
    tableId: string,
    fieldId: string,
    before: string,
    after: string,
    creating: boolean,
    name: string | null,
  ) {
    let byField = pairs.get(tableId);
    if (!byField) pairs.set(tableId, (byField = new Map()));
    let byPair = byField.get(fieldId);
    if (!byPair) byField.set(fieldId, (byPair = new Map()));
    const key = JSON.stringify([before, after]);
    let found = byPair.get(key);
    if (found) found.records += 1;
    else {
      const { from, to, whole } = shown(before, after, creating);
      if (!whole) unshown = true;
      found = { before: from, after: to, records: 1, ...(creating ? {} : { recordNames: [] }) };
      byPair.set(key, found);
    }
    if (creating) return;
    // An update the bell can't name every record of, by a name no other one here has, is read on the card.
    if (!name || found.recordNames!.length >= ROUTINE_NAMED_RECORDS) unshown = true;
    if (name && found.recordNames!.length < ROUTINE_NAMED_RECORDS) found.recordNames!.push(name);
  }

  const descriptions: Array<{ command: Command; derived: boolean }> = commands.map((command) => ({
    command,
    derived: false,
  }));
  for (const [tableId, rows] of derived) {
    const records = [...rows]
      .filter(([id]) => !creating.has(`${tableId}:${id}`))
      .map(([id, values]) => ({ id, values }));
    if (records.length)
      descriptions.push({
        command: {
          kind: 'record.update',
          tableId,
          records,
          id: commands[0]!.id,
          groupId: commands[0]!.groupId,
        },
        derived: true,
      });
  }
  for (const { command, derived: isDerived } of descriptions) {
    switch (command.kind) {
      case 'record.create':
      case 'record.update': {
        const table = tableById.get(command.tableId);
        if (!table) throw refuse();
        const creating = command.kind === 'record.create';
        const before = creating
          ? new Map<string, RowData>()
          : await current(
              table,
              command.records.map((record) => record.id),
            );
        const visible = new Set(
          scope
            .visibleFields(
              table.id,
              live.filter((field) => field.tableId === table.id),
            )
            .map((field) => field.id),
        );
        const after = command.records.map((record) => {
          const values = creating
            ? {
                ...record.values,
                ...createdValues.get(`${table.id}:${record.id}`),
                ...derived.get(table.id)?.get(record.id),
              }
            : record.values;
          const nonempty = Object.fromEntries(
            Object.entries(values ?? {}).filter(
              ([id, value]) =>
                (!creating || value !== null || Object.hasOwn(record.values ?? {}, id)) &&
                !(creating && defaulted(table.id, record.id, id)),
            ),
          );
          if (Object.keys(nonempty).some((id) => !visible.has(id))) throw refuse();
          return written(record.id, nonempty as Record<string, CellValue>);
        });
        const word = await wording(table, [...before.values(), ...after]);
        const primary = fieldById.get(table.primaryFieldId);
        const records: Array<{ id: string; values: Record<string, unknown> }> = [];
        for (const record of after) {
          const values: Record<string, unknown> = {};
          const row = before.get(record.id);
          // The record's name, as the owner reads it in the table, for an update.
          if (!creating && !row) throw refuse();
          const name =
            !primary || !visible.has(primary.id)
              ? null
              : reveal(word(primary, (creating ? record : row)?.values[primary.id] ?? null), primary.type)
                  .text || null;
          const recordChange = recordEntry(table, record.id, name ?? '', creating ? 'created' : 'updated');
          if (name) {
            const key = `${table.id}:${name}`;
            if ((namesSeen.get(key) ?? record.id) !== record.id) unshown = true;
            namesSeen.set(key, record.id);
          }
          for (const fieldId of Object.keys(record.values).sort(order)) {
            const value = record.values[fieldId];
            const field = fieldById.get(fieldId);
            if (!field) throw refuse();
            const checked = checkCellValue(field, value ?? null);
            const stored = checked.ok ? checked.value : (value ?? null);
            const was0 = row?.values[fieldId] ?? null;
            // Judged by what's stored, and a value the record already holds isn't written at all.
            if (!creating && sameValue(was0, stored)) continue;
            values[fieldId] = value;
            if (!creating) held.push({ tableId: table.id, recordId: record.id, fieldId, value: was0 });
            let was = word(field, was0);
            let now = word(field, stored);
            // Two values that read the same are shown with what's stored, and so are two that differ
            // only in their spacing.
            if (!creating && was === now) {
              was = `${was} [${JSON.stringify(was0)}]`;
              now = `${now} [${JSON.stringify(stored)}]`;
              unshown = true;
            }
            if (!creating && collapsed(was) === collapsed(now)) unshown = true;
            const seenWas = reveal(was, field.type);
            const seenNow = reveal(now, field.type, was);
            if (seenWas.odd || seenNow.odd) unshown = true;
            if (!PLAIN.has(field.type) || field.ai || field.source || field.managed || keyed.has(fieldId))
              plain = false;
            const existing = recordChange.fields.find((cell) => cell.fieldId === fieldId);
            if (existing) existing.after = seenNow.text;
            else
              recordChange.fields.push({
                fieldId,
                fieldName: field.name,
                before: seenWas.text,
                after: seenNow.text,
              });
            count(table.id, fieldId, seenWas.text, seenNow.text, creating, name);
          }
          if (creating || Object.keys(values).length) records.push({ id: record.id, values });
        }
        if (!records.length) break;
        if (!isDerived) {
          // Generated defaults are shown, but only the original writable inputs reach the bus.
          kept.push(creating ? command : ({ ...command, records } as Command));
        }
        const change = entry(table.id);
        if (creating) change.created += records.length;
        else
          change.updated = change.records!.filter(
            (record) => record.kind === 'updated' && record.fields.length,
          ).length;
        if (!creating && !isDerived) change.signaturesCanceled! += await canceling(table, records);
        break;
      }
      case 'record.trash':
      case 'record.restore': {
        kept.push(command);
        const table = tableById.get(command.tableId);
        if (!table) throw refuse();
        const change = entry(table.id);
        const restoring = command.kind === 'record.restore';
        if (restoring) change.restored += command.recordIds.length;
        else {
          deletes = true;
          change.trashed += command.recordIds.length;
        }
        const fingerprints = await recordFingerprints(
          db,
          schemas.data,
          table.id,
          command.recordIds,
          scope.recordPredicate(table.id),
        );
        if (fingerprints.length !== new Set(command.recordIds).size) throw refuse();
        targets.push(...fingerprints.map((target) => ({ tableId: table.id, ...target })));
        const primary = fieldById.get(table.primaryFieldId);
        const named = await current(table, command.recordIds, restoring);
        const word = await wording(table, [...named.values()]);
        for (const id of command.recordIds) {
          const row = named.get(id);
          if (!row) throw refuse();
          const name = primary
            ? reveal(word(primary, row.values[primary.id] ?? null), primary.type).text
            : '';
          const record = recordEntry(table, id, name, restoring ? 'restored' : 'trashed');
          for (const field of scope.visibleFields(
            table.id,
            live.filter((field) => field.tableId === table.id),
          )) {
            const value = reveal(word(field, row.values[field.id] ?? null), field.type).text;
            if (value)
              record.fields.push({
                fieldId: field.id,
                fieldName: field.name,
                before: restoring ? '' : value,
                after: restoring ? value : '',
              });
          }
          if (!restoring && change.trashedNames.length < NAMED) change.trashedNames.push(shorten(name) || id);
        }
        break;
      }
      default:
        // A routine changes records alone, so nothing else ever gets this far.
        throw new AppError('validation_failed', 'routines.changes.recordsOnly');
    }
  }

  for (const [tableId, byField] of pairs) {
    const change = entry(tableId);
    for (const [fieldId, byPair] of [...byField].sort(([a], [b]) => order(a, b))) {
      const all = [...byPair.values()];
      for (const pair of all) pair.recordNames?.sort();
      all.sort(
        (a, b) =>
          b.records - a.records ||
          (a.before < b.before ? -1 : a.before > b.before ? 1 : 0) ||
          (a.after < b.after ? -1 : a.after > b.after ? 1 : 0),
      );

      const values = all.slice(0, VALUES_PER_FIELD);
      const field: RoutineFieldChange = {
        fieldId,
        fieldName: fieldById.get(fieldId)?.name ?? '',
        values,
        more: all.slice(VALUES_PER_FIELD).reduce((sum, item) => sum + item.records, 0),
      };
      // The bell lists a few changes of each field, so a field with more is read on the card.
      if (field.more || field.values.length > ROUTINE_BELL_VALUES) unshown = true;
      change.fields.push(field);
    }
  }
  let recordCount = 0;
  for (const table of byTable.values()) {
    table.records = table.records!.filter((record) => record.kind !== 'updated' || record.fields.length);
    table.records.sort((a, b) => a.recordId.localeCompare(b.recordId));
    for (const record of table.records) {
      record.fields.sort((a, b) => order(a.fieldId, b.fieldId));
      if (record.fields.length > ROUTINE_BELL_FIELDS) unshown = true;
    }
    recordCount += table.records.length;
  }
  if (recordCount > ROUTINE_BELL_RECORDS) unshown = true;
  const addsOrEdits = kept.every(
    (command) => command.kind === 'record.create' || command.kind === 'record.update',
  );
  const cancels = [...byTable.values()].some((change) => change.signaturesCanceled);
  return {
    commands: kept,
    held: [
      ...new Map(held.map((cell) => [`${cell.tableId}:${cell.recordId}:${cell.fieldId}`, cell])).values(),
    ],
    targets: targets.sort((a, b) => `${a.tableId}:${a.recordId}`.localeCompare(`${b.tableId}:${b.recordId}`)),
    effects,
    signatures: signatures.sort((a, b) => a.id.localeCompare(b.id)),
    changes: {
      tables: [...byTable.values()].sort((a, b) =>
        a.tableId < b.tableId ? -1 : a.tableId > b.tableId ? 1 : 0,
      ),
      deletes,
      small:
        kept.length > 0 &&
        addsOrEdits &&
        plain &&
        !deletes &&
        !unshown &&
        !cancels &&
        impact.records.size <= SMALL &&
        canApply([...kept], undefined, autonomy, impact),
    },
  };
}
