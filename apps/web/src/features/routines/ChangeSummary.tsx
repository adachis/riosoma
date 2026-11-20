import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import {
  ROUTINE_BELL_VALUES,
  ROUTINE_BELL_FIELDS,
  ROUTINE_BELL_RECORDS,
  type RoutineChanges,
} from '@riosoma/contracts';

/**
 * What a plan waiting for approval does, as the server worked it out from its commands: each
 * table and how many records, which fields go from what to what, and every deletion and canceled
 * signature request called out, and each change of an update with the records it's made in, by
 * name.  Routines change records only, so there's nothing else to show.  A long value shows around
 * where it changes.  The owner reads this before the model's own words.
 */
export function ChangeSummary({ changes, compact = false }: { changes: RoutineChanges; compact?: boolean }) {
  const { t, i18n } = useLingui();
  const empty = t({ id: 'routines.changes.empty', message: 'empty' });
  const quoted = (text: string) => {
    // Text nodes preserve revealed codes through translation without decoding their escapes.
    const value = <>{text}</>;
    return text === '' ? empty : <Trans id="routines.changes.quoted">“{value}”</Trans>;
  };

  const actions = {
    created: t({ id: 'routines.changes.recordCreated', message: 'Will be added' }),
    updated: t({ id: 'routines.changes.recordUpdated', message: 'Will be changed' }),
    trashed: t({ id: 'routines.changes.recordTrashed', message: 'Will be deleted' }),
    restored: t({ id: 'routines.changes.recordRestored', message: 'Will be restored' }),
  };
  const lines: Array<{
    key: string;
    text: ReactNode;
    deletes: boolean;
    detail?: ReactNode[];
    record?: boolean;
    action?: string;
  }> = [];
  for (const table of changes.tables) {
    const name = table.tableName;
    if (table.trashed) {
      const count = table.trashed;
      lines.push({
        key: `${table.tableId}-trashed`,
        text: t({
          id: 'routines.changes.trashed',
          message: plural(count, {
            one: `Deletes # record from ${name}`,
            other: `Deletes # records from ${name}`,
          }),
        }),
        deletes: true,
        detail: table.trashedNames.length ? [words(table.trashedNames, count)] : [],
      });
    }
    if (table.signaturesCanceled) {
      const count = table.signaturesCanceled;
      lines.push({
        key: `${table.tableId}-signatures`,
        text: t({
          id: 'routines.changes.signaturesCanceled',
          message: plural(count, {
            one: `Cancels # signature request in ${name}, by removing the document it was made from`,
            other: `Cancels # signature requests in ${name}, by removing the documents they were made from`,
          }),
        }),
        deletes: true,
      });
    }
    if (table.created) {
      const count = table.created;
      lines.push({
        key: `${table.tableId}-created`,
        text: t({
          id: 'routines.changes.created',
          message: plural(count, { one: `Adds # record to ${name}`, other: `Adds # records to ${name}` }),
        }),
        deletes: false,
      });
    }
    if (table.updated) {
      const count = table.updated;
      lines.push({
        key: `${table.tableId}-updated`,
        text: t({
          id: 'routines.changes.updated',
          message: plural(count, {
            one: `Changes # record in ${name}`,
            other: `Changes # records in ${name}`,
          }),
        }),
        deletes: false,
      });
    }
    if (table.restored) {
      const count = table.restored;
      lines.push({
        key: `${table.tableId}-restored`,
        text: t({
          id: 'routines.changes.restored',
          message: plural(count, {
            one: `Restores # record in ${name}`,
            other: `Restores # records in ${name}`,
          }),
        }),
        deletes: false,
      });
    }
    if (table.records) {
      const records = compact ? table.records.slice(0, ROUTINE_BELL_RECORDS) : table.records;
      for (const record of records) {
        const name = <>{record.name}</>;
        const id = record.recordId;
        lines.push({
          key: `${table.tableId}-${id}`,
          text:
            record.showId && record.name ? (
              <Trans id="routines.changes.identity">
                {name} [{id}]
              </Trans>
            ) : (
              record.name || id
            ),
          deletes: record.kind === 'trashed',
          record: true,
          action: actions[record.kind],
          detail: record.fields.map((field) => {
            const fieldName = <>{field.fieldName}</>;
            const before = quoted(field.before);
            const after = quoted(field.after);
            return (
              <Trans id="routines.changes.recordField">
                {fieldName}: {before} to {after}
              </Trans>
            );
          }),
        });
      }
      if (records.length < table.records.length)
        lines.push({
          key: `${table.tableId}-more`,
          text: hidden(table.records.length - records.length),
          deletes: false,
        });
      continue;
    }
    // Older approvals remain readable, and the server refreshes them before accepting a click.
    for (const field of table.fields) {
      const fieldName = field.fieldName;
      const detail: ReactNode[] = field.values.map((value) => {
        const before = quoted(value.before);
        const after = quoted(value.after);
        const count = value.records;
        // An update names the records it changes, as the server read their names.
        if (value.recordNames?.length) {
          const names = (
            <>{new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(value.recordNames)}</>
          );
          return (
            <Plural
              id="routines.changes.valueNamed"
              value={count}
              one={`${before} to ${after} in # record: ${names}`}
              other={`${before} to ${after} in # records: ${names}`}
            />
          );
        }
        return (
          <Plural
            id="routines.changes.value"
            value={count}
            one={`${before} to ${after} in # record`}
            other={`${before} to ${after} in # records`}
          />
        );
      });
      if (field.more) {
        const more = field.more;
        detail.push(
          t({
            id: 'routines.changes.more',
            message: plural(more, {
              one: 'and # more record changed some other way',
              other: 'and # more records changed other ways',
            }),
          }),
        );
      }
      lines.push({
        key: `${table.tableId}-${field.fieldId}`,
        text: t({ id: 'routines.changes.field', message: `${fieldName} in ${name}:` }),
        deletes: false,
        detail,
      });
    }
  }

  /** Says that the bell leaves some of a field's changes for the card. */
  function hidden(count: number): string {
    return t({
      id: 'routines.changes.notShown',
      message: plural(count, {
        one: 'and # more change, shown when you review it',
        other: 'and # more changes, shown when you review it',
      }),
    });
  }

  function words(names: readonly string[], total: number): string {
    const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' }).format(names);
    const rest = total - names.length;
    return rest > 0
      ? t({
          id: 'routines.changes.namesMore',
          message: plural(rest, { one: `${list}, and # more`, other: `${list}, and # more` }),
        })
      : list;
  }

  return (
    <div className="rio-routines__changes" data-compact={compact || undefined}>
      {changes.deletes ? (
        <p className="rio-routines__status" data-tone="danger">
          <strong>{t({ id: 'routines.changes.deletes', message: 'This deletes things.' })}</strong>
        </p>
      ) : null}
      <ul>
        {lines.map((line) => (
          <li key={line.key} data-deletes={line.deletes || undefined}>
            {line.deletes || line.record ? <strong>{line.text}</strong> : line.text}
            {line.action ? <div>{line.action}</div> : null}
            {line.detail?.length ? (
              <ul>
                {(compact
                  ? line.detail.slice(0, line.record ? ROUTINE_BELL_FIELDS : ROUTINE_BELL_VALUES)
                  : line.detail
                ).map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
                {compact && line.detail.length > (line.record ? ROUTINE_BELL_FIELDS : ROUTINE_BELL_VALUES) ? (
                  <li>
                    {hidden(line.detail.length - (line.record ? ROUTINE_BELL_FIELDS : ROUTINE_BELL_VALUES))}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
