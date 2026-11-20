import { AppError, ROUTINE_COMMAND_KINDS } from '@riosoma/contracts';

/**
 * The exact shape of the commands a routine may carry, key by key.  A command is rebuilt from
 * what's listed here, and one carrying anything else is refused rather than trimmed, so nothing
 * the owner doesn't see, such as a form a new record would count as answering, ever rides along:
 *
 * - `record.create`: `kind`, `tableId`, and `records`, each with only `values`
 * - `record.update`: `kind`, `tableId`, and `records`, each with only `id` and `values`
 * - `record.trash` and `record.restore`: `kind`, `tableId`, and `recordIds`
 *
 * Commands as stored, once a proposal is filled in, also carry their own `id` and `groupId`, and
 * each new record its `id`.
 */

type Shape = 'proposed' | 'stored';

const COMMAND_KEYS: Record<(typeof ROUTINE_COMMAND_KINDS)[number], readonly string[]> = {
  'record.create': ['kind', 'tableId', 'records'],
  'record.update': ['kind', 'tableId', 'records'],
  'record.trash': ['kind', 'tableId', 'recordIds'],
  'record.restore': ['kind', 'tableId', 'recordIds'],
};
const RECORD_KEYS: Record<'record.create' | 'record.update', readonly string[]> = {
  'record.create': ['values'],
  'record.update': ['id', 'values'],
};
/** What filling a proposal in adds */
const FILLED_COMMAND = ['id', 'groupId'];
const FILLED_CREATE = ['id'];

function refuse(): never {
  throw new AppError('validation_failed', 'routines.changes.shape');
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Refuses an object with any key outside `allowed`, or without every key in `required`. */
function only(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!plain(value)) refuse();
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) refuse();
  return value;
}

/**
 * Rebuilds a routine's commands from their allowed keys, or refuses them all with
 * `routines.changes.shape` when any carries another, or lacks one it needs.  A kind other than a
 * record command is refused with `routines.changes.recordsOnly`.
 */
export function strictCommands(raw: unknown, shape: Shape): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || !raw.length) refuse();
  return raw.map((command) => {
    if (!plain(command)) refuse();
    const kind = command.kind;
    if (!(ROUTINE_COMMAND_KINDS as readonly unknown[]).includes(kind))
      throw new AppError('validation_failed', 'routines.changes.recordsOnly');
    const known = kind as (typeof ROUTINE_COMMAND_KINDS)[number];
    const keys = COMMAND_KEYS[known];
    const fields = only(command, shape === 'stored' ? [...keys, ...FILLED_COMMAND] : keys, keys);
    const rebuilt: Record<string, unknown> = { kind: known, tableId: fields.tableId };
    if (shape === 'stored') {
      rebuilt.id = fields.id;
      rebuilt.groupId = fields.groupId;
    }
    if (known === 'record.create' || known === 'record.update') {
      if (!Array.isArray(fields.records)) refuse();
      const recordKeys = RECORD_KEYS[known];
      const allowed =
        shape === 'stored' && known === 'record.create' ? [...recordKeys, ...FILLED_CREATE] : recordKeys;
      rebuilt.records = fields.records.map((record) => {
        const entry = only(record, allowed, recordKeys);
        if (!plain(entry.values)) refuse();
        return {
          ...(entry.id === undefined ? {} : { id: entry.id }),
          values: { ...entry.values },
        };
      });
    } else {
      if (!Array.isArray(fields.recordIds)) refuse();
      rebuilt.recordIds = [...fields.recordIds];
    }
    return rebuilt;
  });
}
