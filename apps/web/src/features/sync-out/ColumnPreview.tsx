import { faArrowRight } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import type { SyncOutPreview } from '@riosoma/contracts';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSyncOutWords } from './words';

/**
 * How the view's fields line up with the outside columns: one row for each field, the key column
 * Riosoma adds, and quiet lines for the fields held back, the columns left alone, and the row count.
 */
export function ColumnPreview({ preview }: { preview: SyncOutPreview }) {
  const { t } = useLingui();
  const words = useSyncOutWords();
  const message = useServerMessage();
  const names = (list: readonly { fieldName: string }[]) =>
    new Intl.ListFormat(words.locale, { type: 'conjunction' }).format(list.map((item) => item.fieldName));
  return (
    <div className="rio-sync-out__preview">
      <ul className="rio-sync-out__columns">
        {preview.columns.map((column) => {
          const status =
            column.action === 'create'
              ? t({ id: 'syncOut.columns.create', message: 'New column' })
              : column.action === 'match'
                ? t({ id: 'syncOut.columns.match', message: 'Matches a column' })
                : t({ id: 'syncOut.columns.skip', message: 'Not sent' });
          const skipped = column.action === 'skip';
          return (
            <li key={column.fieldId} className="rio-sync-out__column" data-skipped={skipped || undefined}>
              <span className="rio-sync-out__field">{column.fieldName}</span>
              <Icon icon={faArrowRight} className="rio-sync-out__arrow" aria-hidden="true" />
              <span className="rio-sync-out__target">
                {skipped ? (
                  <span className="rio-sync-out__col-name">
                    {column.reason ? message(column.reason) : status}
                  </span>
                ) : (
                  <>
                    <span className="rio-sync-out__col-name">{column.columnName}</span>
                    <span className="rio-sync-out__col-type">
                      {words.columnTypeLine(column.columnType ?? '', column.write)}
                    </span>
                  </>
                )}
              </span>
              <span className="rio-sync-out__col-action">{status}</span>
            </li>
          );
        })}
        <li className="rio-sync-out__column rio-sync-out__column--key">
          <span className="rio-sync-out__key-note">
            {t({
              id: 'syncOut.columns.key',
              message:
                'Riosoma adds a column named Riosoma record ID.  It tells the rows apart, so leave it as it is.',
            })}
          </span>
        </li>
      </ul>
      {preview.withheld.length > 0 ? (
        <p className="rio-sync-out__note">
          {t({
            id: 'syncOut.columns.withheld',
            message: plural(preview.withheld.length, {
              one: `# field stays in Riosoma because of its classification: ${names(preview.withheld)}`,
              other: `# fields stay in Riosoma because of their classification: ${names(preview.withheld)}`,
            }),
          })}
        </p>
      ) : null}
      {preview.untouched.length > 0 ? (
        <p className="rio-sync-out__note">
          {t({
            id: 'syncOut.columns.untouched',
            message: plural(preview.untouched.length, {
              one: '# other column there is left alone',
              other: '# other columns there are left alone',
            }),
          })}
        </p>
      ) : null}
      <p className="rio-sync-out__note">
        {t({
          id: 'syncOut.columns.rows',
          message: plural(preview.rows, {
            one: 'The view shows # row now',
            other: 'The view shows # rows now',
          }),
        })}
      </p>
    </div>
  );
}
