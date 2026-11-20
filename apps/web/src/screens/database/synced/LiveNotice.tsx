import { useCallback, useSyncExternalStore } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { FieldMeta, LiveSkipReason, ViewType } from '@riosoma/contracts';
import { Banner, Button } from '@riosoma/ui';
import type { LiveState, ViewRows } from '../../../data';
import { serverMessage } from '../../../messages/useServerMessage';
import './synced.css';

const EMPTY: LiveState = {};
/** Views that page through records, which a live table's source can answer. */
const LIVE_VIEW_TYPES: readonly ViewType[] = ['grid', 'gallery', 'list', 'form'];

/**
 * What a view of a live table needs people to know: that its source couldn't be read, with the
 * source's own reason and a way to try again, or which of the view's filters and sorts the source
 * couldn't apply exactly and so were left out.  It shows nothing for a table that keeps a copy.
 */
export function LiveNotice({
  rows,
  fields,
  viewType,
}: {
  rows: ViewRows;
  fields: readonly FieldMeta[];
  /** The view's type, when the table reads live, so views that need every record say they can't */
  viewType?: ViewType;
}) {
  const { t, i18n } = useLingui();
  const subscribe = useCallback(
    (listener: () => void) =>
      rows.subscribe((change) => {
        if (change.live) listener();
      }),
    [rows],
  );
  const state = useSyncExternalStore(subscribe, () => rows.live?.() ?? EMPTY);
  if (viewType && !LIVE_VIEW_TYPES.includes(viewType))
    return (
      <div className="rio-live-notice">
        <Banner tone="warning">
          <p>
            {t({
              id: 'synced.live.viewType',
              message:
                'This kind of view needs every record at hand, so a live table can’t show it.  Grid, gallery, and list views work.',
            })}
          </p>
        </Banner>
      </div>
    );
  if (state.error)
    return (
      <div className="rio-live-notice">
        <Banner tone="danger" title={t({ id: 'synced.live.failed', message: 'The source couldn’t be read' })}>
          <p>{serverMessage(i18n, state.error.messageKey, state.error.params)}</p>
          <div className="rio-live-notice__actions">
            <Button size="sm" onPress={() => rows.retryLive?.()}>
              <Trans id="synced.tryAgain">Try again</Trans>
            </Button>
          </div>
        </Banner>
      </div>
    );
  const note = state.note;
  if (!note || (!note.skipped.length && note.truncatedAt === null && !note.sourceOrder)) return null;
  const names = new Map(fields.map((field) => [field.id, field.name]));
  const reason = (value: LiveSkipReason) =>
    value === 'localField'
      ? t({
          id: 'synced.live.reason.local',
          message: 'a field of this table’s own, which the source doesn’t have',
        })
      : value === 'overridden'
        ? t({ id: 'synced.live.reason.overridden', message: 'some records override it here' })
        : t({ id: 'synced.live.reason.unsupported', message: 'the source can’t apply it exactly' });
  const skipped = note.skipped.filter((skip) => names.has(skip.fieldId));
  return (
    <div className="rio-live-notice">
      <Banner tone={skipped.length || note.truncatedAt !== null ? 'warning' : 'info'}>
        {skipped.length > 0 && (
          <>
            <p>
              <Trans id="synced.live.skipped">
                This table reads its source live, and the source can’t apply these exactly, so the view leaves
                them out and may show more records than it would otherwise:
              </Trans>
            </p>
            <ul>
              {skipped.map((skip) => {
                const name = names.get(skip.fieldId)!;
                const why = reason(skip.reason);
                return (
                  <li key={`${skip.part}:${skip.fieldId}:${skip.reason}`}>
                    {skip.part === 'filter'
                      ? t({ id: 'synced.live.skippedFilter', message: `The filter on ${name}: ${why}` })
                      : t({ id: 'synced.live.skippedSort', message: `The sort by ${name}: ${why}` })}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {note.truncatedAt !== null && (
          <p>
            {t({
              id: 'synced.live.truncated',
              message: `Showing the first ${i18n.number(note.truncatedAt)} records.  Add a filter to reach the rest.`,
            })}
          </p>
        )}
        {note.sourceOrder && (
          <p>
            <Trans id="synced.live.sourceOrder">Text sorts follow the source’s own alphabetical order.</Trans>
          </p>
        )}
      </Banner>
    </div>
  );
}
