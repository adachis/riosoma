import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  cellValue,
  type FieldMeta,
  type GroupKey,
  type RowData,
  type TableMeta,
  type ViewAggregate,
} from '@riosoma/contracts';
import { Button, Spinner } from '@riosoma/ui';
import type { DatabaseSession } from '../../../../data/types';
import { formatCell, type FormatContext } from '../../../../grid/format';
import { personTimeZone } from '../../dashboards/data';
import { databaseHref } from '../../screen/routes';
import { navigateOnPlainClick } from '../../shell/navigation';
import './summary.css';

/** The records behind one number: groups of its rows, outermost first, and its column if any. */
export interface RecordsTarget {
  row: GroupKey[];
  /** Left out for every column */
  column?: GroupKey;
  /** What the list shows the records of, such as a category's name */
  title: string;
}

/** The panel's words, which each view supplies in its own voice. */
export interface RecordsCopy {
  count(total: number): string;
  close: string;
  more: string;
  untitled: string;
  none: string;
  failed: string;
  retry: string;
}

/** Where a list of records sits, which names the classes its parts take. */
export type RecordsPrefix = 'rio-chart-view' | 'rio-pivot' | 'rio-dashboard-drill';

export interface RecordsPanelProps {
  prefix: 'rio-chart-view' | 'rio-pivot';
  session: DatabaseSession;
  table: TableMeta;
  viewId: string;
  fields: readonly FieldMeta[];
  /** Values shown beside each record's name */
  shown: readonly FieldMeta[];
  format: FormatContext;
  target: RecordsTarget;
  /** Changes when the view's numbers reload, so the list reloads with them */
  version: number;
  copy: RecordsCopy;
  onOpen(recordId: string): void;
  onClose(): void;
}

const PAGE = 50;

/** A page of records, and how many there are in all. */
export interface RecordsPage {
  rows: RowData[];
  total: number;
}

/** Why a list has no records to show, in words for the person, when it isn't a passing failure. */
export class RecordsRefusal extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

type Page =
  | { request: string; place: string; rows: RowData[]; total: number }
  | { request: string; place: string; failed: true; refusal?: string };

export interface RecordPages {
  /** The page in sight: this request's, or the previous one of the same records while it loads */
  current: Page | null;
  /** True once this request's answer has arrived */
  loaded: boolean;
  adding: boolean;
  more(): void;
  retry(): void;
}

/**
 * Pages of the records behind a part of a chart, a pivot cell, or anything else that lists them.
 * `place` names what's listed, and a new one starts again from the first page.  `version` reloads
 * the same records, which stay in sight until the fresh page arrives.
 */
export function useRecordPages(
  place: string,
  version: number,
  load: (offset: number, limit: number, signal?: AbortSignal) => Promise<RecordsPage>,
): RecordPages {
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [adding, setAdding] = useState(false);
  const latest = useRef(load);
  useEffect(() => {
    latest.current = load;
  });
  const request = JSON.stringify([place, version, attempt]);
  const fresh = page?.request === request ? page : null;
  // When the numbers reload, the list keeps its records in sight until the new page arrives.
  const current = fresh ?? (page && page.place === place && !('failed' in page) ? page : null);

  useEffect(() => {
    const controller = new AbortController();
    const settle = (next: Page) => {
      if (!controller.signal.aborted) setPage(next);
    };
    latest
      .current(0, PAGE, controller.signal)
      .then((answer) => settle({ request, place, rows: answer.rows, total: answer.total }))
      .catch((error: unknown) =>
        settle({
          request,
          place,
          failed: true,
          ...(error instanceof RecordsRefusal ? { refusal: error.text } : {}),
        }),
      );
    return () => controller.abort();
  }, [place, request]);

  return {
    current,
    loaded: Boolean(fresh),
    adding,
    more() {
      if (!fresh || 'failed' in fresh || adding) return;
      setAdding(true);
      latest
        .current(fresh.rows.length, PAGE)
        .then((answer) =>
          setPage((last) =>
            last && last.request === request && !('failed' in last)
              ? { ...last, rows: [...last.rows, ...answer.rows], total: answer.total }
              : last,
          ),
        )
        .catch(() => undefined)
        .finally(() => setAdding(false));
    },
    retry: () => setAttempt(attempt + 1),
  };
}

export interface RecordsListProps {
  prefix: RecordsPrefix;
  pages: RecordPages;
  table: TableMeta;
  fields: readonly FieldMeta[];
  /** Values shown beside each record's name */
  shown: readonly FieldMeta[];
  format: FormatContext;
  copy: RecordsCopy;
  /** Leaves out the line that counts the records, for a list whose heading counts them */
  count?: boolean;
  hrefFor(recordId: string): string;
  onOpen(recordId: string): void;
}

/** The list itself: each record's name, which opens it, with a few of its values. */
export function RecordsList({
  prefix,
  pages,
  table,
  fields,
  shown,
  format,
  copy,
  count = true,
  hrefFor,
  onOpen,
}: RecordsListProps) {
  const { current } = pages;
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  if (!current)
    return (
      <div className={`${prefix}-records__status`}>
        <Spinner size="sm" />
      </div>
    );
  if ('failed' in current)
    return (
      <div className={`${prefix}-records__status`} role="alert">
        {current.refusal ? (
          <p>{current.refusal}</p>
        ) : (
          <>
            <p>{copy.failed}</p>
            <Button size="sm" onPress={pages.retry}>
              {copy.retry}
            </Button>
          </>
        )}
      </div>
    );
  return (
    <>
      {count || !current.total ? (
        <p className={`${prefix}-records__count`} role="status">
          {current.total ? copy.count(current.total) : copy.none}
        </p>
      ) : null}
      <ul className={`${prefix}-records__list`}>
        {current.rows.map((row) => {
          const name = (primary ? formatCell(primary, cellValue(row, primary), format) : '') || copy.untitled;
          return (
            <li key={row.id} className={`${prefix}-records__item`}>
              <a
                className={`${prefix}-records__name`}
                href={hrefFor(row.id)}
                onClick={(event: MouseEvent<HTMLAnchorElement>) =>
                  navigateOnPlainClick(event, () => onOpen(row.id))
                }
              >
                {name}
              </a>
              {shown.length ? (
                <dl className={`${prefix}-records__fields`}>
                  {shown.map((field) => (
                    <div key={field.id}>
                      <dt>{field.name}</dt>
                      <dd>{formatCell(field, cellValue(row, field), format)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
      {current.rows.length < current.total ? (
        <Button size="sm" isPending={pages.adding} isDisabled={!pages.loaded} onPress={pages.more}>
          {copy.more}
        </Button>
      ) : null}
    </>
  );
}

/**
 * A list of the records behind a bar, slice, point, or cell, a page at a time in the view's order.
 * Each opens the record.  It sits beside the view rather than over it, so the numbers stay in sight.
 */
export function RecordsPanel({
  prefix,
  session,
  table,
  viewId,
  fields,
  shown,
  format,
  target,
  version,
  copy,
  onOpen,
  onClose,
}: RecordsPanelProps) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const where = {
    row: target.row,
    ...(target.column === undefined ? {} : { column: target.column }),
  };
  const place = JSON.stringify(where);
  const pages = useRecordPages(place, version, async (offset, limit, signal) => {
    const answer: ViewAggregate = await session.viewAggregate(
      viewId,
      { timeZone: personTimeZone(), records: { ...where, offset, limit } },
      signal,
    );
    if (answer.kind !== 'records') throw new Error(answer.kind);
    return answer;
  });

  useEffect(() => {
    heading.current?.focus();
  }, [place]);

  function close(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  }

  return (
    <section
      className={`${prefix}-records`}
      aria-labelledby={headingId}
      aria-busy={!pages.loaded || undefined}
      onKeyDown={close}
    >
      <header className={`${prefix}-records__header`}>
        <h3 id={headingId} ref={heading} tabIndex={-1} className={`${prefix}-records__title`}>
          {target.title}
        </h3>
        <Button variant="quiet" size="sm" icon={faXmark} aria-label={copy.close} onPress={onClose} />
      </header>
      <RecordsList
        prefix={prefix}
        pages={pages}
        table={table}
        fields={fields}
        shown={shown}
        format={format}
        copy={copy}
        hrefFor={(recordId) => databaseHref(session.databaseId, table.id, viewId, recordId)}
        onOpen={onOpen}
      />
    </section>
  );
}
