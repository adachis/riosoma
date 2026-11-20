import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { FieldMeta } from '@riosoma/contracts';
import { Banner, Radio, RadioGroup } from '@riosoma/ui';
import { serverMessage } from '../../messages/useServerMessage';
import type { Column } from './columns';
import type { CellProblem, PlannedRow, RepeatChoice, SkippedRow, Summary } from './upsert';

/** How many of each kind of row the summary names before saying how many more there are. */
export const FIRST_FEW = 5;

export interface ImportSummaryProps {
  summary: Summary;
  columns: readonly Column[];
  fields: ReadonlyMap<string, FieldMeta>;
  keyName: string | null;
  repeat: RepeatChoice;
  onRepeat: (repeat: RepeatChoice) => void;
  disabled?: boolean;
}

/**
 * What the import will do, before anything is written: how many records it adds, updates, and
 * leaves as they are, and which rows it skips and why, with the first few of each.
 */
export function ImportSummary({
  summary,
  columns,
  fields,
  keyName,
  repeat,
  onRepeat,
  disabled,
}: ImportSummaryProps) {
  const { t, i18n } = useLingui();
  const list = new Intl.ListFormat(i18n.locale, { type: 'conjunction' });
  function rowText({ row, label }: { row: number; label: string }) {
    const number = i18n.number(row);
    return label
      ? t({ id: 'import.summary.row', message: `Row ${number}: ${label}` })
      : t({ id: 'import.summary.rowNumber', message: `Row ${number}` });
  }
  function problemText(row: number, problem: CellProblem) {
    const number = i18n.number(row);
    const column = columns[problem.column]?.name ?? '';
    const text = problem.text;
    switch (problem.reason) {
      case 'validation': {
        const reason = problem.message || serverMessage(i18n, problem.messageKey ?? 'data.validation.failed');
        return t({ id: 'import.problem.validation', message: `Row ${number}: ${column}: ${reason}` });
      }
      case 'number':
        return t({
          id: 'import.problem.number',
          message: `Row ${number}: ${column} “${text}” isn’t a number.`,
        });
      case 'date':
        return t({ id: 'import.problem.date', message: `Row ${number}: ${column} “${text}” isn’t a date.` });
      case 'choice':
        return t({
          id: 'import.problem.choice',
          message: `Row ${number}: ${column} “${text}” isn’t one of the field’s options.`,
        });
      case 'person':
        return t({
          id: 'import.problem.person',
          message: `Row ${number}: ${column} “${text}” doesn’t match anyone in this database.`,
        });
      case 'error':
        return t({
          id: 'import.problem.error',
          message: `Row ${number}: ${column} holds an error from the spreadsheet.`,
        });
      default:
        return t({
          id: 'import.problem.other',
          message: `Row ${number}: ${column} “${text}” doesn’t fit the field.`,
        });
    }
  }
  function skippedText(row: SkippedRow) {
    const number = i18n.number(row.row);
    if (row.repeats !== undefined) {
      const first = i18n.number(row.repeats);
      return t({ id: 'import.skipped.repeat', message: `Row ${number} repeats the key on row ${first}.` });
    }
    if (row.noKey) {
      const key = keyName ?? '';
      return t({ id: 'import.skipped.noKey', message: `Row ${number} has no ${key}.` });
    }
    return row.problems[0] ? problemText(row.row, row.problems[0]) : rowText(row);
  }
  function changedText(row: PlannedRow & { changed: string[] }) {
    const number = i18n.number(row.row);
    const label = row.label;
    const changes = list.format(row.changed.map((id) => fields.get(id)?.name ?? ''));
    return label
      ? t({ id: 'import.summary.changes', message: `Row ${number}: ${label}, changing ${changes}` })
      : t({ id: 'import.summary.changesOnly', message: `Row ${number}, changing ${changes}` });
  }
  function moreText(count: number) {
    const more = i18n.number(count);
    return t({ id: 'import.summary.more', message: `and ${more} more` });
  }
  const groups = [
    {
      id: 'added',
      title: t({
        id: 'import.summary.added',
        message: plural(summary.added.length, { one: '# record to add', other: '# records to add' }),
      }),
      items: summary.added.slice(0, FIRST_FEW).map(rowText),
      total: summary.added.length,
    },
    {
      id: 'updated',
      title: t({
        id: 'import.summary.updated',
        message: plural(summary.updated.length, { one: '# record to update', other: '# records to update' }),
      }),
      items: summary.updated.slice(0, FIRST_FEW).map(changedText),
      total: summary.updated.length,
    },
    {
      id: 'unchanged',
      title: t({
        id: 'import.summary.unchanged',
        message: plural(summary.unchanged.length, {
          one: '# record already up to date',
          other: '# records already up to date',
        }),
      }),
      items: summary.unchanged.slice(0, FIRST_FEW).map(rowText),
      total: summary.unchanged.length,
    },
    {
      id: 'skipped',
      title: t({
        id: 'import.summary.skipped',
        message: plural(summary.skipped.length, { one: '# row skipped', other: '# rows skipped' }),
      }),
      // Every cell that doesn't convert in the rows shown is listed, not only a row's first.
      items: summary.skipped
        .slice(0, FIRST_FEW)
        .flatMap((row) =>
          row.problems.length > 1
            ? row.problems.map((problem) => problemText(row.row, problem))
            : [skippedText(row)],
        ),
      shown: Math.min(FIRST_FEW, summary.skipped.length),
      total: summary.skipped.length,
    },
  ];
  const repeats = summary.repeated.length;
  const ambiguous = summary.ambiguous.length;
  return (
    <section
      className="rio-import__summary"
      aria-label={t({ id: 'import.summary.label', message: 'What the import will do' })}
    >
      <div className="rio-import__groups">
        {groups.map((group) => {
          const more = group.total - (group.shown ?? group.items.length);
          return (
            <div key={group.id} className="rio-import__group" data-kind={group.id}>
              <h3>{group.title}</h3>
              {group.items.length > 0 && (
                <ul>
                  {group.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                  {more > 0 && <li>{moreText(more)}</li>}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {keyName && (
        <p className="rio-import__note">
          {t({ id: 'import.summary.emptyCells', message: 'Empty cells leave a record’s value as it is.' })}
        </p>
      )}
      {(repeats > 0 || ambiguous > 0) && (
        <RadioGroup
          label={t({ id: 'import.repeat.label', message: 'When a key repeats' })}
          description={[
            repeats
              ? t({
                  id: 'import.repeat.rows',
                  message: plural(repeats, {
                    one: '# row repeats an earlier row’s key.',
                    other: '# rows repeat an earlier row’s key.',
                  }),
                })
              : '',
            ambiguous
              ? t({
                  id: 'import.repeat.records',
                  message: plural(ambiguous, {
                    one: '# row matches more than one record.',
                    other: '# rows match more than one record.',
                  }),
                })
              : '',
          ]
            .filter(Boolean)
            .join('  ')}
          value={repeat}
          isDisabled={disabled}
          onChange={(value) => onRepeat(value === 'stop' ? 'stop' : 'first')}
        >
          <Radio
            value="first"
            description={t({
              id: 'import.repeat.firstHelp',
              message:
                'Later rows with the same key are skipped, and a key several records share updates the oldest.',
            })}
          >
            {t({ id: 'import.repeat.first', message: 'The first one wins' })}
          </Radio>
          <Radio value="stop">{t({ id: 'import.repeat.stop', message: 'Stop, and import nothing' })}</Radio>
        </RadioGroup>
      )}
      {ambiguous > 0 && (
        <ul className="rio-import__examples">
          {summary.ambiguous.slice(0, FIRST_FEW).map((row) => {
            const number = i18n.number(row.row);
            const label = row.label;
            const records = i18n.number(row.recordIds.length);
            return (
              <li key={row.row}>
                {t({
                  id: 'import.repeat.example',
                  message: `Row ${number}: ${label} matches ${records} records.`,
                })}
              </li>
            );
          })}
        </ul>
      )}
      {summary.blocked && (
        <Banner tone="warning">
          {t({
            id: 'import.repeat.blocked',
            message:
              'Nothing will be imported while keys repeat.  Fix them in the file, or let the first one win.',
          })}
        </Banner>
      )}
    </section>
  );
}
