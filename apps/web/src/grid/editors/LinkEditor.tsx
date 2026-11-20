import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useId, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  checkCellValue,
  idsOf,
  isComputedType,
  LIMITS,
  newId,
  type FieldMeta,
  type LinkTarget,
  type CellValues,
  type CellValue,
  type Choice,
  type LinkChoice,
  type LinkChoicesPage,
} from '@riosoma/contracts';
import {
  Button,
  ChoicePill,
  ListBox,
  ListBoxItem,
  SearchField,
  SortableItem,
  SortableList,
  moveList,
} from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { isDemoSession } from '../../demo';
import type { DatabaseSession } from '../../data';
import { useServerMessage } from '../../messages/useServerMessage';
import { hiddenRecordLabel } from '../../screens/database/permissions/restricted';
import '../../screens/database/permissions/permissions.css';
import { parseText } from '../parse';
import { formatCell, type FormatContext } from '../format';
import { ListLayout, Virtualizer } from 'react-aria-components';
import { EditorPopover, useEditorTab } from './EditorPopover';
import type { EditorProps } from './types';
import './editors.css';
import { databaseHref } from '../../screens/database/screen/routes';

type LinkField = Extract<FieldMeta, { type: 'link' }>;

export function linkCreation(
  session: DatabaseSession | undefined,
  field: LinkField,
  name: string,
  format: FormatContext,
) {
  const schema = session?.getSchema();
  const table = schema?.tableById.get(field.options.linkedTableId);
  const primary = table && schema?.fieldById.get(table.primaryFieldId);
  if (table?.source || !primary || isComputedType(primary.type) || !name.trim()) return null;
  const parsed = parseText(primary, name.trim(), format);
  if (parsed.ok !== true) return null;
  const checked = checkCellValue(primary, parsed.value);
  return checked.ok ? { [primary.id]: checked.value } : null;
}

/** Creating the target and linking it share one action, including undo and offline replay. */
export function createLinkedRecord(
  session: DatabaseSession,
  field: LinkField,
  recordId: string | undefined,
  name: string,
  selected: readonly string[],
  format: FormatContext,
): string | undefined {
  const values = linkCreation(session, field, name, format);
  if (!values) return;
  const id = newId('record');
  session.run([
    { kind: 'record.create', tableId: field.options.linkedTableId, records: [{ id, values }] },
    ...(recordId
      ? [
          {
            kind: 'record.update' as const,
            tableId: field.tableId,
            records: [
              {
                id: recordId,
                values: { [field.id]: field.options.prefersSingle ? [id] : [...selected, id] },
              },
            ],
          },
        ]
      : []),
  ]);
  session.rememberLinked({ [id]: name.trim() });
  return id;
}

export interface LinkPickerProps {
  field: LinkField;
  selected: readonly string[];
  recordId?: string;
  currentValues?: CellValues;
  format: FormatContext;
  session?: DatabaseSession;
  onChange: (ids: string[]) => void;
  onCreate?: (name: string) => string | undefined;
  onOpen?: (id: string) => void;
  onFinish?: (move: 'next' | 'previous' | 'none') => void;
  readOnly?: boolean;
  initialText?: string;
  expanded?: boolean;
  /** Linked records a record rule hides from the person, shown only as "Hidden record" */
  hidden?: number;
}

export function LinkPicker({
  field,
  selected,
  recordId,
  currentValues,
  format,
  session,
  onChange,
  onCreate,
  onOpen,
  onFinish,
  readOnly = false,
  initialText = '',
  expanded = true,
  hidden = 0,
}: LinkPickerProps) {
  const { t, i18n } = useLingui();
  const untitled = t({ id: 'record.untitled', message: 'Untitled record' });
  const message = useServerMessage();
  const [query, setQuery] = useState(initialText);
  const [open, setOpen] = useState(expanded);
  const [result, setResult] = useState<{
    query: string;
    tableId: string;
    matches: LinkChoice[];
    fields: FieldMeta[];
    canCreate: boolean;
    hasMore: boolean;
    key: string;
    error?: string;
  }>();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [destination, setDestination] = useState<LinkTarget>();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const name = query.trim();
  const tableId = field.options.linkedTableId;
  const previewId = useId();
  const [activeId, setActiveId] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const paging = useRef<AbortController | null>(null);
  const key = JSON.stringify({
    fieldId: field.id,
    options: field.options,
    recordId,
    values: currentValues ?? {},
  });
  const current =
    result?.query === name && result.tableId === tableId && result.key === key ? result : undefined;
  const matches = current?.matches.filter((match) => !selected.includes(match.id)) ?? [];
  const active = matches.find((match) => match.id === activeId);
  useEditorTab(
    root,
    open && !readOnly
      ? (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const option = target.closest('[role="option"]');
          const focusedOption = Array.from(
            list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
          ).find((item) => item.dataset.key === activeId);
          if (!event.shiftKey && option && active && preview.current) {
            event.preventDefault();
            event.stopPropagation();
            preview.current.focus();
          } else if (event.shiftKey && target === preview.current && focusedOption) {
            event.preventDefault();
            event.stopPropagation();
            focusedOption.focus();
          } else if (onFinish) {
            const focusable = Array.from(
              root.current?.querySelectorAll<HTMLElement>('input, button, a[href], [tabindex="0"]') ?? [],
            ).filter(
              (item) =>
                item.tabIndex >= 0 &&
                !item.matches(':disabled') &&
                !item.closest('[hidden], [aria-hidden="true"]'),
            );
            const index = focusable.indexOf(target);
            if (event.shiftKey ? index === 0 : index === focusable.length - 1) {
              event.preventDefault();
              event.stopPropagation();
              onFinish(event.shiftKey ? 'previous' : 'next');
            }
          }
        }
      : undefined,
  );
  const remember = (records: LinkChoice[]) =>
    setNames(
      (previous) => new Map([...previous, ...records.map((match) => [match.id, match.name] as const)]),
    );
  useEffect(() => {
    // Public forms and demo records cannot read private link-target metadata.
    if (!session || isDemoSession() || session.getSchema().tableById.has(tableId)) return;
    const controller = new AbortController();
    void api<LinkTarget>(`/api/tables/${tableId}/link-target`, { signal: controller.signal })
      .then((target) => {
        if (!controller.signal.aborted) setDestination(target);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDestination(undefined);
      });
    return () => controller.abort();
  }, [session, tableId]);
  useEffect(() => {
    if (!open || readOnly) return;
    const controller = new AbortController();
    const context = JSON.parse(key) as { fieldId: string; recordId?: string; values: CellValues };
    const timer = setTimeout(() => {
      const input = { query: name, recordId: context.recordId, values: context.values };
      const request = session
        ? session.searchLinkChoices(context.fieldId, input, controller.signal)
        : api<LinkChoicesPage>(`/api/fields/${context.fieldId}/link-options`, {
            method: 'POST',
            body: input,
            signal: controller.signal,
          });
      void request
        .then((page) => {
          if (controller.signal.aborted) return;
          setLoadingMore(false);
          setResult({
            query: name,
            tableId,
            matches: page.records,
            fields: page.fields,
            canCreate: page.canCreate,
            hasMore: page.hasMore,
            key,
          });
          setNames(
            (previous) =>
              new Map([...previous, ...page.records.map((match) => [match.id, match.name] as const)]),
          );
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setResult({
              query: name,
              tableId,
              matches: [],
              fields: [],
              canCreate: false,
              hasMore: false,
              key,
              error: error instanceof ApiError ? error.info.messageKey : 'errors.offline',
            });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
      paging.current?.abort();
      paging.current = null;
    };
  }, [open, readOnly, tableId, name, session, key]);
  function loadMore() {
    if (!current?.hasMore || paging.current) return;
    const controller = new AbortController();
    paging.current = controller;
    setLoadingMore(true);
    const input = { query: name, recordId, values: currentValues ?? {}, offset: current.matches.length };
    const request = session
      ? session.searchLinkChoices(field.id, input, controller.signal)
      : api<LinkChoicesPage>(`/api/fields/${field.id}/link-options`, {
          method: 'POST',
          body: input,
          signal: controller.signal,
        });
    void request
      .then((page) => {
        if (controller.signal.aborted) return;
        setResult((previous) =>
          previous?.key === key && previous.query === name
            ? {
                ...previous,
                matches: [
                  ...previous.matches,
                  ...page.records.filter(
                    (record) => !previous.matches.some((match) => match.id === record.id),
                  ),
                ],
                hasMore: page.hasMore,
              }
            : previous,
        );
        remember(page.records);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult((previous) =>
            previous?.key === key && previous.query === name
              ? { ...previous, error: error instanceof ApiError ? error.info.messageKey : 'errors.offline' }
              : previous,
          );
      })
      .finally(() => {
        if (paging.current === controller) {
          paging.current = null;
          setLoadingMore(false);
        }
      });
  }
  const full = !field.options.prefersSingle && selected.length >= LIMITS.linksPerCell;
  const canCreate = Boolean(
    onCreate &&
    name &&
    current?.canCreate &&
    !current.error &&
    current.matches.length === 0 &&
    !full &&
    linkCreation(session, field, name, format),
  );
  const label = (id: string) =>
    (session?.linked.get(id) ?? names.get(id) ?? format.linked?.get(id) ?? id).trim() || untitled;

  function pick(id: string) {
    if (readOnly || full || selected.includes(id)) return;
    onChange(field.options.prefersSingle ? [id] : [...selected, id]);
    setQuery('');
    search.current?.querySelector('input')?.focus();
  }
  function create() {
    if (!canCreate) return;
    const id = onCreate?.(name);
    if (!id) return;
    setNames((previous) => new Map([...previous, [id, name]]));
    setQuery('');
  }
  const choiceList = (
    <ListBox
      aria-label={field.name}
      className={matches.length >= 100 ? 'rio-link-picker__virtual' : undefined}
      items={matches}
      selectionMode="none"
      onAction={(id) => pick(String(id))}
      aria-busy={!current || loadingMore}
      disabledKeys={full ? matches.map((match) => match.id) : []}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (element.scrollHeight - element.scrollTop - element.clientHeight < 100) loadMore();
      }}
      renderEmptyState={() =>
        current
          ? t({ id: 'grid.link.none', message: 'No matching records' })
          : t({ id: 'ui.spinner.loading', message: 'Loading' })
      }
    >
      {(match) => (
        <ListBoxItem
          id={match.id}
          textValue={match.name.trim() || untitled}
          onHoverStart={() => setActiveId(match.id)}
          onFocus={() => {
            setActiveId(match.id);
            if (matches.at(-1)?.id === match.id) loadMore();
          }}
          description={
            <span className="rio-link-picker__details">
              {(field.options.displayFieldIds ?? []).map((id) => {
                const item = current?.fields.find((item) => item.id === id);
                return item ? (
                  <span key={id}>
                    <span className="rio-link-picker__detail-name">{item.name}</span>
                    <LinkValue
                      field={item}
                      value={match.values[id] ?? null}
                      choices={match.selectChoices?.[id]}
                      format={format}
                    />
                  </span>
                ) : null;
              })}
            </span>
          }
        >
          {match.name.trim() || untitled}
        </ListBoxItem>
      )}
    </ListBox>
  );
  return (
    <div
      ref={root}
      className="rio-link-picker"
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target === preview.current && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const positions: Record<string, number> = {
            ArrowDown: target.scrollTop + 40,
            ArrowUp: target.scrollTop - 40,
            PageDown: target.scrollTop + target.clientHeight,
            PageUp: target.scrollTop - target.clientHeight,
            Home: 0,
            End: target.scrollHeight,
          };
          const position = positions[event.key];
          if (position !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            target.scrollTop = Math.max(0, position);
          }
        }
        if (!target.matches('input')) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const options = list.current?.querySelectorAll<HTMLElement>('[role="option"]');
          (event.key === 'ArrowDown' ? options?.[0] : options?.[(options?.length ?? 0) - 1])?.focus();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (matches[0]) pick(matches[0].id);
          else create();
        } else if (event.key === 'Backspace' && query === '' && selected.length) {
          event.preventDefault();
          onChange(selected.slice(0, -1));
        }
      }}
    >
      {destination?.table.id === tableId && (
        <p className="rio-link-picker__database">
          {t({ id: 'grid.link.database', message: `Records from ${destination.database.name}` })}
        </p>
      )}
      <SortableList
        items={selected.map((id) => ({ id, name: label(id) }))}
        orientation="horizontal"
        keyMap={{ ArrowUp: 'up', ArrowDown: 'down' }}
        disabledReason={
          readOnly ? t({ id: 'grid.link.readOnly', message: 'You can only view these links.' }) : undefined
        }
        onMove={(from, to) => onChange([...moveList(selected, from, to)])}
      >
        <div className="rio-cell-editor__selected" role="group" aria-label={field.name}>
          {selected.map((id) => {
            const name = label(id);
            return (
              <SortableItem id={id} as="span" className="rio-link-picker__pill" key={id} altMoveScope="row">
                <>
                  {onOpen ? (
                    <Button variant="quiet" data-sortable-surface onPress={() => onOpen(id)}>
                      <ChoicePill name={name} color="gray" />
                    </Button>
                  ) : (
                    <ChoicePill name={name} color="gray" />
                  )}
                  {!readOnly && (
                    <Button
                      icon={faXmark}
                      variant="quiet"
                      aria-label={t({ id: 'grid.link.remove', message: `Remove ${name}` })}
                      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                      onPress={() => onChange(selected.filter((chosen) => chosen !== id))}
                    />
                  )}
                </>
              </SortableItem>
            );
          })}
          {Array.from({ length: hidden }, (_, index) => (
            // Kept as they are when the list changes, since the person can't see them to keep them.
            <span className="rio-link-picker__pill rio-hidden-link" key={`hidden:${index}`}>
              <ChoicePill name={i18n._(hiddenRecordLabel)} color="gray" />
            </span>
          ))}
        </div>
      </SortableList>
      {!readOnly && !open && (
        <Button onPress={() => setOpen(true)}>
          {t({ id: 'record.link.add', message: 'Link a record' })}
        </Button>
      )}
      {!readOnly && open && (
        <>
          <div ref={search}>
            <SearchField
              autoFocus
              value={query}
              onChange={setQuery}
              aria-label={t({ id: 'grid.link.find', message: 'Find a record' })}
              placeholder={t({ id: 'grid.link.find', message: 'Find a record' })}
            />
          </div>
          <div className="rio-link-picker__browser">
            <div ref={list} className="rio-link-picker__choices">
              {matches.length >= 100 ? (
                <Virtualizer layout={ListLayout} layoutOptions={{ estimatedRowHeight: 64 }}>
                  {choiceList}
                </Virtualizer>
              ) : (
                choiceList
              )}
              {current?.hasMore && (
                <Button isDisabled={loadingMore} onPress={loadMore}>
                  {t({ id: 'grid.link.more', message: 'Load more records' })}
                </Button>
              )}
            </div>
            <aside
              ref={preview}
              id={previewId}
              tabIndex={active ? 0 : -1}
              aria-hidden={active ? undefined : true}
              className="rio-link-picker__preview"
              aria-label={t({ id: 'grid.link.preview', message: 'Record preview' })}
            >
              {active && (
                <>
                  <strong>{active.name.trim() || untitled}</strong>
                  <dl>
                    {current?.fields
                      .filter(
                        (item) => item.id !== session?.getSchema().tableById.get(tableId)?.primaryFieldId,
                      )
                      .map((item) => (
                        <div key={item.id}>
                          <dt>{item.name}</dt>
                          <dd>
                            <LinkValue
                              field={item}
                              value={active.values[item.id] ?? null}
                              choices={active.selectChoices?.[item.id]}
                              format={format}
                            />
                          </dd>
                        </div>
                      ))}
                  </dl>
                </>
              )}
            </aside>
          </div>
          {canCreate && (
            <Button
              onPress={create}
              aria-label={t({ id: 'grid.link.add', message: `Add new record “${name}”` })}
              icon={faPlus}
            />
          )}
          {current?.error && <p role="alert">{message(current.error)}</p>}
        </>
      )}
    </div>
  );
}

export function LinkEditor(props: EditorProps) {
  const { context, request } = props;
  const field = context.field;
  const [selected, setSelected] = useState(() => idsOf(cellValue(request.row, field)));
  const ended = useRef(false);
  const [openError, setOpenError] = useState<string>();
  const message = useServerMessage();
  const session = context.session;
  useEffect(
    () =>
      session?.subscribeRecords(field.tableId, (ids) => {
        if (!ids.has(request.row.id)) return;
        const row = session.cachedRecord(field.tableId, request.row.id);
        if (row) setSelected(idsOf(cellValue(row, field)));
      }),
    [session, field, request.row.id],
  );
  if (field.type !== 'link') return null;
  function finish(move: 'next' | 'previous' | 'none') {
    if (!ended.current) {
      ended.current = true;
      request.done(move);
    }
  }
  return (
    <EditorPopover {...props} onDismiss={() => finish('none')}>
      {openError && <p role="alert">{message(openError)}</p>}
      <LinkPicker
        field={field}
        selected={selected}
        recordId={request.row.id}
        currentValues={request.row.values}
        format={context.format}
        session={session}
        initialText={request.initialText ?? undefined}
        onFinish={finish}
        onOpen={
          context.router
            ? (id) => {
                void api<LinkTarget>(`/api/tables/${field.options.linkedTableId}/link-target`)
                  .then(async (target) => {
                    if (!target.viewId) return;
                    finish('none');
                    await context.router!.navigate({
                      to: databaseHref(target.database.id, target.table.id, target.viewId, id),
                    });
                  })
                  .catch((error: unknown) =>
                    setOpenError(error instanceof ApiError ? error.info.messageKey : 'errors.offline'),
                  );
              }
            : undefined
        }
        onChange={(ids) => {
          const checked = checkCellValue(field, ids);
          if (checked.ok) {
            context.apply(checked.value);
            setSelected(ids);
          }
        }}
        onCreate={
          session
            ? (name) => {
                const id = createLinkedRecord(session, field, request.row.id, name, selected, context.format);
                if (id) setSelected(field.options.prefersSingle ? [id] : [...selected, id]);
                return id;
              }
            : undefined
        }
      />
    </EditorPopover>
  );
}

function LinkValue({
  field,
  value,
  format,
  choices,
}: {
  field: FieldMeta;
  value: CellValue;
  format: FormatContext;
  choices?: readonly Choice[];
}) {
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const ids = typeof value === 'string' ? [value] : idsOf(value);
    return (
      <span className="rio-link-picker__chips">
        {ids.map((id) => {
          const choice =
            choices?.find((choice) => choice.id === id) ??
            field.options.choices.find((choice) => choice.id === id);
          return choice ? <ChoicePill key={id} name={choice.name} color={choice.color} /> : null;
        })}
      </span>
    );
  }
  return <>{formatCell(field, value, format)}</>;
}
