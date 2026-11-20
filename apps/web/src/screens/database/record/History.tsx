import { personLabel } from '../../../data/people';
import { useCallback, useEffect, useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { presenceColor, type CellValue, type FieldMeta, type HistoryEntry } from '@riosoma/contracts';
import { Avatar, Banner, Button, Spinner } from '@riosoma/ui';
import { useSchema, type DatabaseSession } from '../../../data';
import { api, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useRelativeTime } from '../../../relative-time';
import { formatCell, type FormatContext } from '../../../grid/format';
import './History.css';

const NO_ENTRIES: readonly HistoryEntry[] = [];
const NO_FIELDS: ReadonlyMap<string, FieldMeta> = new Map();

/** The sentence each kind of change reads as, with the actor's name in it. */
const CREATED = msg({ id: 'history.created', message: '{name} created this record' });
const UPDATED = msg({
  id: 'history.updated',
  message: '{name} changed {count, plural, one {# field} other {# fields}}',
});
const TRASHED = msg({ id: 'history.trashed', message: '{name} deleted this record' });
const RESTORED = msg({ id: 'history.restored', message: '{name} restored this record' });

export interface HistoryPanelProps {
  session: DatabaseSession;
  tableId: string;
  recordId: string;
  format: FormatContext;
}

/**
 * One record's history, newest first, a page at a time.
 *
 * The server says what changed and what each field held before and after, and this only words it:
 * a sentence for who did what, then each field's two values drawn the way the grid draws them, so
 * a reader compares the history with the record without learning a second format.
 */
export function HistoryPanel({ session, tableId, recordId, format }: HistoryPanelProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const schema = useSchema(session);
  const fields = schema?.fieldById ?? format.fieldsById ?? NO_FIELDS;
  const people = schema?.collaborators ?? format.collaborators;
  const [entries, setEntries] = useState<readonly HistoryEntry[]>(NO_ENTRIES);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [retry, setRetry] = useState<{ cursor: string | null; refresh: boolean }>({
    cursor: null,
    refresh: false,
  });
  const request = useRef<AbortController | undefined>(undefined);
  const hasPage = useRef(false);
  const scope = `${tableId}/${recordId}`;
  const [shown, setShown] = useState(scope);
  if (shown !== scope) {
    // Another record: let go of the last one's history before drawing any of it.
    setShown(scope);
    setEntries(NO_ENTRIES);
    setNext(null);
    setLoaded(false);
    setFailure(undefined);
  }

  const load = useCallback(
    (cursor?: string | null, refresh = false) => {
      if (!cursor && !refresh) hasPage.current = false;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      void session
        .history(tableId, recordId, cursor, controller.signal)
        .then((page) => {
          if (controller.signal.aborted) return;
          // History entries are immutable, so a live read can keep every page already loaded.
          setEntries((current) => (cursor || refresh ? merge(current, page.entries) : page.entries));
          if (!refresh || !hasPage.current) setNext(page.next);
          hasPage.current = true;
          setFailure(undefined);
          setLoaded(true);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRetry({ cursor: cursor ?? null, refresh });
          setFailure(error instanceof ApiError ? error.info.messageKey : 'errors.offline');
          setLoaded(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [session, tableId, recordId],
  );

  useEffect(() => {
    load();
    const unsubscribe = session.subscribeRecords(tableId, (ids, change) => {
      // Optimistic edits and metadata refreshes do not add stored history entries.
      if (!ids.has(recordId) || !change) return;
      load(undefined, true);
    });
    const unsubscribeEvents = session.subscribeEvents((event) => {
      if (event.kind !== 'reloading') return;
      // Stored history must be read again through the reader's current access rules.
      request.current?.abort();
      hasPage.current = false;
      setEntries(NO_ENTRIES);
      setNext(null);
      setLoaded(false);
      setFailure(undefined);
      load();
    });
    return () => {
      request.current?.abort();
      unsubscribe();
      unsubscribeEvents();
    };
  }, [load, session, tableId, recordId]);

  return (
    <div className="rio-history">
      {failure && (
        <Banner tone="danger">
          {message(failure)}
          <Button
            size="sm"
            isPending={loading}
            onPress={() => {
              setLoading(true);
              load(retry.cursor, retry.refresh);
            }}
          >
            {t({ id: 'files.retry', message: 'Try again' })}
          </Button>
        </Banner>
      )}
      {/* A read that failed says so; it doesn't claim there is nothing to see. */}
      {loaded && !failure && entries.length === 0 ? (
        <p className="rio-history__empty">{t({ id: 'history.empty', message: 'No changes yet.' })}</p>
      ) : (
        <ol className="rio-history__list" aria-busy={!loaded}>
          {entries.map((entry) => (
            <HistoryItem
              key={entry.seq}
              entry={entry}
              fields={fields}
              people={people}
              format={format}
              canUndo={['owner', 'creator', 'editor'].includes(session.role())}
              onUndone={() => load(undefined, true)}
            />
          ))}
        </ol>
      )}
      {!loaded && entries.length === 0 && !failure ? (
        <Spinner size="sm" className="rio-history__loading" />
      ) : null}
      {next && (
        <Button
          className="rio-history__more"
          size="sm"
          isPending={loading}
          onPress={() => {
            setLoading(true);
            load(next);
          }}
        >
          {t({ id: 'history.more', message: 'Show more' })}
        </Button>
      )}
    </div>
  );
}

/** One page after another, newest first, with each change number once. */
function merge(current: readonly HistoryEntry[], incoming: readonly HistoryEntry[]): HistoryEntry[] {
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((one, other) => other.seq - one.seq);
}

interface HistoryItemProps {
  canUndo: boolean;
  onUndone(): void;
  entry: HistoryEntry;
  fields: ReadonlyMap<string, FieldMeta>;
  people: ReadonlyMap<string, { name: string }>;
  format: FormatContext;
}

function HistoryItem({ entry, fields, people, format, canUndo, onUndone }: HistoryItemProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const [undoing, setUndoing] = useState(false);
  const [undoResult, setUndoResult] = useState<string>();
  const time = useRelativeTime(entry.at);
  const unknown = t({ id: 'comments.unknownPerson', message: 'Someone' });
  const system = t({ id: 'history.system', message: 'Riosoma' });
  const actor = entry.formViewId
    ? t({ id: 'forms.edit.actor', message: 'The submitter’s edit link' })
    : entry.actorId === null
      ? system
      : personLabel(people.get(entry.actorId), unknown);
  const empty = t({ id: 'history.emptyValue', message: 'empty' });
  const value = (fieldId: string, stored: CellValue): string => {
    const field = fields.get(fieldId);
    // A field the reader can't see never arrives; one that was removed still has a value to show.
    const text = field ? formatCell(field, stored, format) : plain(stored);
    // A cell that holds nothing, and one that shows as nothing (an unchecked box), both read empty.
    return stored === null || text === '' ? empty : text;
  };
  // A change that reads the same before and after (an empty list becoming no list) says nothing.
  const changes = entry.changes.filter(
    (change) => value(change.fieldId, change.before) !== value(change.fieldId, change.after),
  );
  const count = changes.length;
  let summary: string;
  switch (entry.kind) {
    case 'created':
      summary = i18n._({ ...CREATED, values: { name: actor } });
      break;
    case 'updated':
      summary = i18n._({ ...UPDATED, values: { name: actor, count } });
      break;
    case 'trashed':
      summary = i18n._({ ...TRASHED, values: { name: actor } });
      break;
    case 'restored':
      summary = i18n._({ ...RESTORED, values: { name: actor } });
      break;
    case 'synced':
      summary = t({ id: 'history.synced', message: 'The source changed this record' });
      break;
  }
  const name = (fieldId: string): string => fields.get(fieldId)?.name ?? fieldId;
  return (
    <li className="rio-history__entry">
      <Avatar
        personId={entry.actorId ?? undefined}
        name={actor}
        color={entry.actorId ? presenceColor(entry.actorId) : 'gray'}
        size="sm"
      />
      <div className="rio-history__body">
        <div className="rio-history__head">
          <span className="rio-history__summary">{summary}</span>
          <time className="rio-history__time" dateTime={entry.at}>
            {time}
          </time>
        </div>
        {changes.length > 0 && (
          <div className="rio-history__changes">
            {changes.map((change) => (
              <div className="rio-history__change" key={change.fieldId}>
                <span className="rio-history__field">{name(change.fieldId)}</span>
                <del className="rio-history__before">{value(change.fieldId, change.before)}</del>
                <ins className="rio-history__after">{value(change.fieldId, change.after)}</ins>
              </div>
            ))}
          </div>
        )}
        {entry.overrides && entry.overrides.length > 0 && (
          <div className="rio-history__overrides">
            {entry.overrides.map((override) => (
              <div className="rio-history__override" key={override.fieldId}>
                <span className="rio-history__field">{name(override.fieldId)}</span>
                <span className="rio-history__note">
                  {override.set
                    ? t({ id: 'history.overrideSet', message: 'Changed here instead of the source' })
                    : t({ id: 'history.overrideCleared', message: 'Back to the source’s value' })}
                </span>
              </div>
            ))}
          </div>
        )}
        {entry.formViewId && canUndo && (
          <Button
            size="sm"
            isPending={undoing}
            onPress={() => {
              setUndoing(true);
              void api<{ restored: number }>(
                `/api/views/${encodeURIComponent(entry.formViewId!)}/public-form/edits/${entry.seq}/undo`,
                { body: {} },
              )
                .then((result) => {
                  setUndoResult(
                    result.restored
                      ? t({ id: 'forms.edit.undone', message: 'Undid the response edit.' })
                      : t({
                          id: 'forms.edit.undoNothing',
                          message: 'No values were restored.  They may have changed again or be protected.',
                        }),
                  );
                  onUndone();
                })
                .catch((error: unknown) =>
                  setUndoResult(
                    message(error instanceof ApiError ? error.info.messageKey : 'errors.internal'),
                  ),
                )
                .finally(() => setUndoing(false));
            }}
          >
            {t({ id: 'forms.edit.undo', message: 'Undo response edit' })}
          </Button>
        )}
        {undoResult && <p role="status">{undoResult}</p>}
      </div>
    </li>
  );
}

/** A value from a field that is gone, shown as text rather than left out. */
function plain(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value))
    return value
      .map((item) => plain(item))
      .filter(Boolean)
      .join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
