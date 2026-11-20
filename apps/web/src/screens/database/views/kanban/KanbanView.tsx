import { personLabel } from '../../../../data/people';
import { shortcutKeys } from '../../../../shortcuts/registry';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { EMPTY_STACK, newId, type FieldMeta, type RowData, type StackCounts } from '@riosoma/contracts';
import {
  Avatar,
  Button,
  ChoicePill,
  Menu,
  MenuItem,
  MenuTrigger,
  SortableMovementProvider,
} from '@riosoma/ui';
import { faChevronLeft, faChevronRight, faEllipsis, faPlus } from '@fortawesome/free-solid-svg-icons';
import { api } from '../../../../api';
import { useSchema } from '../../../../data/hooks';
import type { CommandInput, ViewRows } from '../../../../data/types';
import { usePhone } from '../../../../shell/useMediaQuery';
import type { ViewComponentProps } from '../types';
import { StackPicker } from './KanbanSettings';
import { CardStack } from './CardStack';
import { editable, isStackField, orderStacks, rowStack, stackValue, type Stack } from './model';
import { useCelebrations } from '../../../../features/celebrations/useCelebrations';
import { boardFinished, doneStack, showsWholeTable } from '../../../../features/celebrations/triggers';
import { arrangementRefusal, dropRefusal, orderCommand } from '../drag/rules';
import { PRESS_MS, useHeld, useViewDrag, type DragPoint } from '../drag/useViewDrag';
import './kanban.css';

export interface Arrival {
  row: RowData;
  stack: string;
  focus: boolean;
  place?: { id: string; side: 'before' | 'after' };
}
export type DragItem = { kind: 'card'; row: RowData } | { kind: 'stack'; id: string };

/** How long a finger rests on a card or a stack's header before it picks it up */
export const LONG_PRESS_MS = PRESS_MS;
/** A clock for telling the person's own last move from someone else's, read only in handlers */
const moment = () => performance.now();

export function KanbanView(props: ViewComponentProps) {
  const { t } = useLingui();
  useSchema(props.session);
  const field = props.fields.find(
    (field) => field.id === props.view.config.kanban.stackFieldId && isStackField(field),
  );
  if (!field)
    return (
      <div className="rio-kanban-empty">
        <h2>{t({ id: 'kanban.chooseField', message: 'Choose a field to stack cards by' })}</h2>
        <p>
          {t({
            id: 'kanban.chooseFieldHelp',
            message: 'Stacks come from a single select field’s options, or from the people in a user field.',
          })}
        </p>
        <StackPicker {...props} />
      </div>
    );
  return <Board key={`${props.view.id}:${field.id}`} {...props} field={field} />;
}

function Board(props: ViewComponentProps & { field: FieldMeta }) {
  const { t } = useLingui();
  const moveLeft = shortcutKeys('views.moveLeft');
  const moveRight = shortcutKeys('views.moveRight');
  const moveUp = shortcutKeys('views.moveUp');
  const moveDown = shortcutKeys('views.moveDown');
  const { session, view, table, field } = props;
  const schema = useSchema(session);
  const config = view.config.kanban;
  const canEdit = editable(props);
  const canArrange = !arrangementRefusal(props);
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  // Whether the counts were read with no filter on the server, so they're the whole table's.
  const [countsWhole, setCountsWhole] = useState(false);
  const [arrivals, setArrivals] = useState<ReadonlyMap<string, Arrival>>(new Map());
  const [error, setError] = useState(false);
  const gesture = useViewDrag();
  const { active: dragging, holding, suppressClick } = gesture;
  const [dropStack, setDropStack] = useState<string | null>(null);
  const phone = usePhone();
  /** On a phone, the stack filling the screen */
  const [current, setCurrent] = useState(0);
  const board = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const rowsByStack = useRef(new Map<string, ViewRows>());
  const retiring = useRef(new Set<Arrival>());
  const countRefresh = useRef<() => Promise<boolean>>(() => Promise.resolve(false));

  useEffect(() => {
    let disposed = false;
    let version = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (disposed) return Promise.resolve(false);
      clearTimeout(timer);
      const request = ++version;
      controller?.abort();
      controller = new AbortController();
      const query = new URLSearchParams({ tz: props.format.timeZone });
      // A filter still on its way to the server leaves these counts under the one before it.
      const settled = session.settledView?.(view.id);
      const whole = settled !== undefined && showsWholeTable({ config: settled });
      const counting = session.stackCounts
        ? session.stackCounts(view.id, props.format.timeZone, controller.signal)
        : api<StackCounts>(`/api/views/${view.id}/stacks?${query}`, { signal: controller.signal });
      return counting
        .then((result) => {
          if (!disposed && request === version) {
            setCounts(new Map(result.stacks.map((stack) => [stack.id, stack.count])));
            setCountsWhole(whole);
            setError(false);
            const finished = retiring.current;
            retiring.current = new Set();
            setArrivals((current) => {
              if (!finished.size) return current;
              return new Map([...current].filter(([, arrival]) => !finished.has(arrival)));
            });
            return true;
          }
          return false;
        })
        .catch(() => {
          if (!disposed && request === version) setError(true);
          return false;
        });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    };
    countRefresh.current = refresh;
    refresh();
    const unsubscribe = session.subscribeRecords(table.id, schedule);
    // Saving can complete after the optimistic record notification's count request.
    const unsubscribeSave = session.subscribeSaveState(schedule);
    window.addEventListener('online', schedule);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      unsubscribe();
      unsubscribeSave();
      window.removeEventListener('online', schedule);
    };
  }, [
    session,
    table.id,
    view.id,
    view.config.filter,
    view.config.kanban.stackFieldId,
    props.format.timeZone,
  ]);

  useEffect(
    () =>
      session.subscribeRecords(table.id, (ids) => {
        setArrivals((current) => {
          const next = new Map(current);
          for (const id of ids) {
            const arrival = current.get(id);
            const row = session.cachedRecord(table.id, id);
            if (arrival && (!row || rowStack(row, field) !== arrival.stack)) next.delete(id);
          }
          return next.size === current.size ? current : next;
        });
      }),
    [session, table.id, field],
  );

  const base: Stack[] =
    field.type === 'singleSelect'
      ? field.options.choices.map((choice) => ({ ...choice }))
      : [...(schema?.collaborators.values() ?? [])].map((person) => ({
          id: person.id,
          name: personLabel(person),
          person: true,
        }));
  const emptyName = (field: string) => t({ id: 'kanban.empty', message: `No ${field}` });
  base.push({ id: EMPTY_STACK, name: emptyName(field.name) });
  const ordered = orderStacks(base, config.stackOrder);
  const hidden = ordered.filter((stack) => config.hiddenStacks.includes(stack.id));
  const visible = ordered.filter(
    (stack) =>
      !config.hiddenStacks.includes(stack.id) &&
      (!config.hideEmptyStacks ||
        counts.get(stack.id) !== 0 ||
        [...arrivals.values()].some((arrival) => arrival.stack === stack.id)),
  );
  // Stack targets stay in place throughout a pointer gesture, even if counts arrive meanwhile.
  const heldStacks = useHeld(visible, holding);
  const stacks = heldStacks;
  // Every record in the table, at least five, in the field's last choice finishes the board.  The
  // counts only say so for a board with no filter or record rule narrowing it.
  const { celebrate } = useCelebrations();
  const finishedBefore = useRef<boolean | null>(null);
  const lastMove = useRef(Number.NEGATIVE_INFINITY);
  const done = doneStack(field);
  const whole = showsWholeTable(view) && !schema?.access.limitedTables.has(table.id);
  const settled = session.settledView?.(view.id);
  const serverWhole = settled !== undefined && showsWholeTable({ config: settled });
  // Counts read while a cleared filter was on its way are read again once it lands.
  const counted = counts.size > 0;
  useEffect(() => {
    if (counted && whole && serverWhole && !countsWhole) void countRefresh.current();
  }, [counted, whole, serverWhole, countsWhole]);
  useEffect(() => {
    if (!whole || done === null) {
      finishedBefore.current = null;
      return;
    }
    if (!counts.size || !countsWhole) return;
    const finished = boardFinished(counts, done);
    const before = finishedBefore.current;
    finishedBefore.current = finished;
    if (!finished || before !== false) return;
    const column = [...(board.current?.querySelectorAll<HTMLElement>('[data-stack]') ?? [])].find(
      (element) => element.dataset.stack === done,
    );
    celebrate('kanbanDone', view.id, {
      anchor: column?.querySelector('.rio-kanban-stack__header') ?? column ?? board.current,
      cause: moment() - lastMove.current < 10_000 ? 'you' : 'others',
    });
  }, [counts, countsWhole, whole, done, celebrate, view.id]);
  const hiddenLabel = (count: number) =>
    t({ id: 'kanban.hidden', message: plural(count, { one: '# hidden stack', other: '# hidden stacks' }) });
  const save = (patch: Partial<typeof config>) => {
    const reason = arrangementRefusal(props);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    const current = session.getSchema().viewById.get(view.id)?.config.kanban ?? config;
    props.onConfig({ kanban: { ...current, ...patch } });
  };
  const reorder = (id: string, target: string) => {
    const reason = arrangementRefusal(props);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    if (id === target) return;
    const order = ordered.map((stack) => stack.id);
    const from = order.indexOf(id),
      to = order.indexOf(target);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
    save({ stackOrder: order });
    gesture.setStatus(t({ id: 'kanban.stacksReordered', message: 'Stack order saved.' }));
  };
  const register = useCallback((id: string, rows: ViewRows | null) => {
    if (rows) rowsByStack.current.set(id, rows);
    else rowsByStack.current.delete(id);
  }, []);

  function move(
    row: RowData,
    target: string,
    focus = true,
    place?: { id: string; side: 'before' | 'after' },
  ) {
    row = session.cachedRecord(table.id, row.id) ?? row;
    const changesStack = rowStack(row, field) !== target;
    const reason = dropRefusal(props, row, changesStack ? [field] : [], !changesStack);
    if (reason) {
      gesture.setStatus(gesture.reasons[reason]);
      return;
    }
    const commands: CommandInput[] = [];
    if (changesStack)
      commands.push({
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: row.id, values: { [field.id]: stackValue(field, target) } }],
      });
    const canOrder = !dropRefusal(props, row, [], true);
    if (place && !canOrder) place = undefined;
    if (changesStack && !place && canOrder) {
      const rows = rowsByStack.current.get(target);
      for (let index = (rows?.rowCount() ?? 0) - 1; index >= 0; index--) {
        const last = rows?.getRow(index);
        if (last && last.id !== row.id && rowStack(last, field) === target) {
          place = { id: last.id, side: 'after' };
          break;
        }
      }
    }
    if (place) {
      const command = orderCommand(props, row, place.id, place.side);
      if (command) commands.push(command);
    }
    if (!commands.length) return;
    lastMove.current = moment();
    const source = rowStack(row, field);
    const moved: RowData = { ...row, values: { ...row.values, [field.id]: stackValue(field, target) } };
    const arrival: Arrival = { row: moved, stack: target, focus, place };
    try {
      const action = session.run(commands);
      if (changesStack) setArrivals((current) => new Map(current).set(row.id, arrival));
      const stack = ordered.find((stack) => stack.id === target)?.name ?? target;
      gesture.setStatus(t({ id: 'kanban.moved', message: `Moved to ${stack}` }));
      void action.done
        .then(async (result) => {
          if (result.rejected) return true;
          await Promise.all([
            rowsByStack.current.get(source)?.refresh(),
            rowsByStack.current.get(target)?.refresh(),
          ]);
          retiring.current.add(arrival);
          return countRefresh.current();
        })
        .then((refreshed) => {
          if (!refreshed) return;
          setArrivals((current) => {
            if (current.get(row.id) !== arrival) return current;
            const next = new Map(current);
            next.delete(row.id);
            return next;
          });
        })
        .catch(() => {
          setError(true);
        });
    } catch {
      setError(true);
    }
  }

  function create(stack: string) {
    if (!editable(props) || table.source || table.joined) return;
    const id = newId('record');
    try {
      session.run([
        {
          kind: 'record.create',
          tableId: table.id,
          records: [{ id, values: { [field.id]: stackValue(field, stack) } }],
        },
      ]);
      props.onExpand(id);
    } catch {
      setError(true);
    }
  }

  function startDrag(event: ReactPointerEvent, item: DragItem) {
    if (props.readOnly) return;
    if (event.target instanceof Element && event.target.closest('[data-kanban-menu]')) return;
    const locate = (point: DragPoint) => {
      const element = document.elementFromPoint(point.clientX, point.clientY);
      const column = element?.closest<HTMLElement>('[data-stack]');
      if (!column || !board.current?.contains(column)) return null;
      const target = column.dataset.stack!;
      const card = element?.closest<HTMLElement>('[data-record]');
      const cross = item.kind === 'card' && rowStack(item.row, field) !== target;
      const place =
        item.kind === 'card' &&
        !dropRefusal(props, item.row, [], true) &&
        card &&
        card.dataset.record !== item.row.id
          ? {
              id: card.dataset.record!,
              side:
                point.clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2
                  ? ('before' as const)
                  : ('after' as const),
            }
          : undefined;
      const reason =
        item.kind === 'stack'
          ? arrangementRefusal(props)
          : dropRefusal(props, item.row, cross ? [field] : [], !cross);
      return { column: item.kind === 'stack' || !place ? column : (card ?? column), target, place, reason };
    };
    gesture.start(event, {
      scroll: track.current,
      move(point) {
        const target = locate(point);
        setDropStack(target?.target ?? null);
        if (!target) {
          gesture.mark(null, '');
          return;
        }
        const name = ordered.find((stack) => stack.id === target.target)?.name ?? '';
        const message = target.reason
          ? gesture.reasons[target.reason]
          : item.kind === 'stack'
            ? ordered.findIndex((stack) => stack.id === item.id) <
              ordered.findIndex((stack) => stack.id === target.target)
              ? t({ id: 'kanban.placeAfter', message: `Place after ${name}` })
              : t({ id: 'kanban.placeBefore', message: `Place before ${name}` })
            : t({ id: 'kanban.dropTarget', message: `Drop in ${name}` });
        gesture.mark(target.column, message, !!target.reason);
      },
      drop(point) {
        const target = locate(point);
        if (!target || target.reason) return;
        if (item.kind === 'card') move(item.row, target.target, false, target.place);
        else reorder(item.id, target.target);
      },
      finish() {
        setDropStack(null);
      },
    });
  }

  function orderCard(row: RowData, stack: string, direction: -1 | 1) {
    const rows = rowsByStack.current.get(stack);
    const index = rows?.indexOf(row.id) ?? -1;
    const target = index < 0 ? undefined : rows?.getRow(index + direction);
    if (target) move(row, stack, true, { id: target.id, side: direction < 0 ? 'before' : 'after' });
  }

  // A phone shows one stack at a time.  Swiping scrolls the row of stacks and the arrows page it,
  // and either way the stack that settles in view becomes the current one.
  const pages = stacks.length;
  const page = Math.min(current, Math.max(0, pages - 1));
  const position = page + 1;
  const settle = () => {
    const element = track.current;
    if (!element || !phone || !element.clientWidth) return;
    const next = Math.round(Math.abs(element.scrollLeft) / element.clientWidth);
    if (next === page || next >= pages) return;
    setCurrent(next);
    const stack = stacks[next];
    if (stack) gesture.setStatus(stackSummary(stack));
  };
  const turn = (next: number) => {
    const target = track.current?.querySelectorAll<HTMLElement>(':scope > .rio-kanban-stack')[next];
    if (!target) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'nearest', inline: 'start', behavior: still ? 'auto' : 'smooth' });
  };
  const stackSummary = (stack: Stack) => {
    const count = counts.get(stack.id);
    const name = stack.name;
    return count === undefined
      ? t({ id: 'kanban.showing', message: `Showing ${name}` })
      : t({
          id: 'kanban.showingCount',
          message: plural(count, { one: `Showing ${name}, # record`, other: `Showing ${name}, # records` }),
        });
  };
  const hiddenMenu = (
    <MenuTrigger>
      <Button isDisabled={!hidden.length}>{hiddenLabel(hidden.length)}</Button>
      <Menu aria-label={hiddenLabel(hidden.length)}>
        {hidden.map(({ id, name }) => (
          <MenuItem
            key={id}
            id={id || 'empty'}
            isDisabled={!canArrange}
            onAction={() => save({ hiddenStacks: config.hiddenStacks.filter((stack) => stack !== id) })}
          >
            {t({ id: 'kanban.show', message: `Show ${name}` })}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );

  return (
    <div
      className="rio-kanban"
      ref={board}
      data-dragging={dragging || undefined}
      data-phone={phone || undefined}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {gesture.feedback}
      <div className="rio-kanban__status" role="status">
        {gesture.announcement}
      </div>
      {!props.readOnly && (
        <>
          <p className="rio-view-drag-status">
            {t({
              id: 'kanban.card.dragKeys',
              message: `${moveLeft} or ${moveRight} moves to another stack.  ${moveUp} or ${moveDown} changes the order when there is no sort.`,
            })}
          </p>
          {view.config.sorts.length > 0 && <p className="rio-view-drag-status">{gesture.reasons.sorted}</p>}
        </>
      )}
      {error && (
        <div role="alert">{t({ id: 'errors.internal', message: 'Something went wrong on the server.' })}</div>
      )}
      {phone && (
        <div
          className="rio-kanban__pager"
          role="group"
          aria-label={t({ id: 'kanban.stacks', message: 'Stacks' })}
        >
          <Button
            variant="quiet"
            primaryAction
            icon={faChevronLeft}
            className="rio-kanban__turn"
            aria-label={t({ id: 'kanban.previous', message: 'Previous stack' })}
            isDisabled={page === 0}
            onPress={() => turn(page - 1)}
          />
          <span className="rio-kanban__position">
            {pages ? t({ id: 'kanban.position', message: `Stack ${position} of ${pages}` }) : ''}
          </span>
          <Button
            variant="quiet"
            primaryAction
            icon={faChevronRight}
            className="rio-kanban__turn"
            aria-label={t({ id: 'kanban.next', message: 'Next stack' })}
            isDisabled={page >= pages - 1}
            onPress={() => turn(page + 1)}
          />
          {hidden.length > 0 && <div className="rio-kanban__hidden">{hiddenMenu}</div>}
        </div>
      )}
      <div className="rio-kanban__board" ref={track} onScroll={phone ? settle : undefined}>
        {stacks.map((stack, index) => {
          const name = stack.name,
            count = counts.get(stack.id);
          const label = t({ id: 'kanban.stack.menu', message: `More for ${name}` });
          return (
            <section
              className="rio-kanban-stack"
              key={stack.id}
              aria-label={name}
              data-stack={stack.id}
              data-drop-target={dropStack === stack.id || undefined}
            >
              <SortableMovementProvider
                name={name}
                up={canArrange && index > 0 ? () => reorder(stack.id, stacks[index - 1]!.id) : undefined}
                down={
                  canArrange && index < stacks.length - 1
                    ? () => reorder(stack.id, stacks[index + 1]!.id)
                    : undefined
                }
                destinations={
                  canArrange
                    ? stacks
                        .filter((target) => target.id !== stack.id)
                        .map((target) => ({
                          id: target.id,
                          name: target.name,
                          move: () => reorder(stack.id, target.id),
                        }))
                    : []
                }
              >
                <header
                  className="rio-kanban-stack__header"
                  onPointerDown={(event) => startDrag(event, { kind: 'stack', id: stack.id })}
                  data-draggable={canArrange || undefined}
                >
                  <h2>
                    {stack.color ? (
                      <ChoicePill name={name} color={stack.color} />
                    ) : stack.person ? (
                      <>
                        <Avatar personId={stack.id} name={name} color="blue" />
                        {name}
                      </>
                    ) : (
                      name
                    )}
                  </h2>
                  <span className="rio-kanban-stack__count">
                    {count === undefined
                      ? ''
                      : t({
                          id: 'kanban.count',
                          message: plural(count, { one: '# record', other: '# records' }),
                        })}
                  </span>
                  <div data-kanban-menu>
                    <MenuTrigger>
                      <Button icon={faEllipsis} variant="quiet" aria-label={label} isDisabled={!canArrange} />
                      <Menu aria-label={label}>
                        <MenuItem onAction={() => save({ hiddenStacks: [...config.hiddenStacks, stack.id] })}>
                          {t({ id: 'kanban.stack.hide', message: 'Hide stack' })}
                        </MenuItem>
                        <MenuItem
                          icon={faChevronLeft}
                          isDisabled={index === 0}
                          onAction={() => {
                            const target = stacks[index - 1];
                            if (target) reorder(stack.id, target.id);
                          }}
                        >
                          {t({ id: 'kanban.stack.left', message: 'Move left' })}
                        </MenuItem>
                        <MenuItem
                          icon={faChevronRight}
                          isDisabled={index === stacks.length - 1}
                          onAction={() => {
                            const target = stacks[index + 1];
                            if (target) reorder(stack.id, target.id);
                          }}
                        >
                          {t({ id: 'kanban.stack.right', message: 'Move right' })}
                        </MenuItem>
                      </Menu>
                    </MenuTrigger>
                  </div>
                </header>
              </SortableMovementProvider>
              <CardStack
                {...props}
                stack={stack}
                stacks={stacks}
                moveTargets={ordered.filter((stack) => !config.hiddenStacks.includes(stack.id))}
                arrivals={arrivals}
                dragging={dragging || holding}
                register={register}
                move={move}
                orderCard={orderCard}
                startDrag={startDrag}
              />
              {canEdit && !(table.source || table.joined) && (
                <Button
                  className="rio-kanban-stack__new"
                  variant="quiet"
                  primaryAction
                  onPress={() => create(stack.id)}
                  aria-label={t({ id: 'kanban.newCard', message: 'New card' })}
                  icon={faPlus}
                />
              )}
            </section>
          );
        })}
        {!phone && <div className="rio-kanban__hidden">{hiddenMenu}</div>}
      </div>
      {phone && dragging && heldStacks ? (
        // Only one stack shows on a phone, so while a finger carries something the others wait here
        // to be dropped on.  It's for pointers alone, and the keyboard moves cards with their menus.
        <div className="rio-kanban__drop" aria-hidden="true">
          <span className="rio-kanban__drop-label">
            {t({ id: 'kanban.dropHere', message: 'Drop on a stack' })}
          </span>
          <div className="rio-kanban__drop-targets">
            {heldStacks.map((stack) => (
              <div
                key={stack.id}
                className="rio-kanban__drop-target"
                data-stack={stack.id}
                data-drop-target={dropStack === stack.id || undefined}
              >
                {stack.name}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
