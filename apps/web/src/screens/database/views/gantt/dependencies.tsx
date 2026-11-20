import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, idsOf, type FieldMeta } from '@riosoma/contracts';
import { Button, Modal } from '@riosoma/ui';
import { Dialog } from 'react-aria-components';
import { reportError } from '../../../../grid/view/actions';
import { dropRefusal } from '../drag/rules';
import type { DragPoint, useViewDrag } from '../drag/useViewDrag';
import type { Bar } from '../timeline/layout';
import { recordLabel } from '../timeline/model';
import type { ViewComponentProps } from '../types';

/** A dependency points from a prerequisite to its dependent, which stores the link. */
export function useDependencies(
  view: ViewComponentProps,
  field: FieldMeta | undefined,
  bars: readonly Bar[],
  gesture: ReturnType<typeof useViewDrag>,
) {
  const { t } = useLingui();
  const [localSource, setLocalSource] = useState<Bar | null>(null);
  const source = view.onDependencySource
    ? (bars.find((bar) => bar.row.id === view.dependencySource) ?? null)
    : localSource;
  function setSource(bar: Bar | null) {
    setLocalSource(bar);
    view.onDependencySource?.(bar?.row.id ?? null);
  }
  const [destination, setDestination] = useState('');
  const title = t({ id: 'views.gantt.dependencies', message: 'Dependencies' });
  const current = (bar: Bar) => view.session.cachedRecord(view.table.id, bar.row.id) ?? bar.row;
  const label = (bar: Bar) =>
    recordLabel(
      bar.row,
      view.fields.find((candidate) => candidate.id === view.table.primaryFieldId),
      view.format,
    ) || t({ id: 'views.gantt.untitled', message: 'Untitled record' });
  const linked = (from: Bar, to: Bar) =>
    !!field && idsOf(cellValue(current(to), field)).includes(from.row.id);

  function refusal(from: Bar, to: Bar): string | null {
    if (!field) return null;
    const reason = dropRefusal(view, current(to), [field]);
    if (reason) return gesture.reasons[reason];
    if (linked(from, to)) return null;
    const visited = new Set<string>();
    const reaches = (id: string): boolean => {
      if (id === to.row.id) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      const bar = bars.find((candidate) => candidate.row.id === id);
      return !!bar && idsOf(cellValue(current(bar), field!)).some(reaches);
    };
    return reaches(from.row.id)
      ? t({ id: 'views.gantt.dependencyCycle', message: 'A dependency cannot lead back to the same record.' })
      : null;
  }

  function apply(from: Bar, to: Bar) {
    if (!field) return;
    const reason = refusal(from, to);
    if (reason) {
      gesture.setStatus(reason);
      return;
    }
    const previous = idsOf(cellValue(current(to), field));
    const removing = previous.includes(from.row.id);
    const values = removing ? previous.filter((id) => id !== from.row.id) : [...previous, from.row.id];
    try {
      view.session.run([
        {
          kind: 'record.update',
          tableId: view.table.id,
          records: [{ id: to.row.id, values: { [field.id]: values } }],
        },
      ]);
      gesture.setStatus(
        removing
          ? t({ id: 'views.gantt.dependencyRemoved', message: 'Dependency removed.' })
          : t({ id: 'views.gantt.dependencyAdded', message: 'Dependency added.' }),
      );
    } catch (error) {
      reportError(error);
    }
  }

  function start(
    event: PointerEvent,
    from: Bar,
    scrollInsets?: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>>,
  ) {
    if (view.readOnly) return;
    const chart = event.currentTarget.closest('.rio-timeline-chart');
    const locate = (point: DragPoint) => {
      const node = document
        .elementFromPoint(point.clientX, point.clientY)
        ?.closest<HTMLElement>('[data-bar-key]');
      const bar =
        node && chart?.contains(node)
          ? bars.find((candidate) => candidate.key === node.dataset.barKey)
          : undefined;
      return node && bar ? { node, bar } : null;
    };
    gesture.start(event, {
      scroll: chart?.querySelector<HTMLElement>('.rio-timeline-chart__scroller'),
      scrollInsets,
      move(point) {
        const target = locate(point);
        if (!target) {
          gesture.mark(null, '');
          return;
        }
        const reason = refusal(from, target.bar);
        gesture.mark(
          target.node,
          reason ??
            (linked(from, target.bar)
              ? t({ id: 'views.gantt.dropRemoveDependency', message: 'Release to remove this dependency.' })
              : t({ id: 'views.gantt.dropAddDependency', message: 'Release to add this dependency.' })),
          !!reason,
        );
      },
      drop(point) {
        const target = locate(point);
        if (target) apply(from, target.bar);
      },
    });
  }
  const target =
    bars.find((bar) => bar.row.id === destination) ?? bars.find((bar) => bar.row.id !== source?.row.id);
  const reason = source && target ? refusal(source, target) : null;
  /** Chooses the prerequisite, keeping a dependent that isn't the same record. */
  function choose(bar: Bar) {
    setSource(bar);
    setDestination((chosen) =>
      chosen && chosen !== bar.row.id
        ? chosen
        : (bars.find((candidate) => candidate.row.id !== bar.row.id)?.row.id ?? ''),
    );
  }
  return {
    start,
    open: choose,
    dialog: (
      <Modal
        isOpen={!!source}
        onOpenChange={(open) => {
          if (!open) setSource(null);
        }}
        isDismissable
        size="sm"
      >
        <Dialog aria-label={title} className="rio-calendar-view__move">
          <h2>{title}</h2>
          {/* Both ends are chosen here, so the dialog is a whole way to manage a dependency for
              anyone who can't drag the diamond, on a touch screen or with a screen reader. */}
          <label>
            {t({ id: 'views.gantt.prerequisite', message: 'Prerequisite record' })}
            <select
              value={source?.row.id ?? ''}
              onChange={(event) => {
                const bar = bars.find((candidate) => candidate.row.id === event.target.value);
                if (bar) choose(bar);
              }}
            >
              {bars.map((bar) => (
                <option key={bar.key} value={bar.row.id}>
                  {label(bar)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t({ id: 'views.gantt.dependent', message: 'Dependent record' })}
            <select value={target?.row.id ?? ''} onChange={(event) => setDestination(event.target.value)}>
              {source &&
                bars
                  .filter((bar) => bar.row.id !== source.row.id)
                  .map((bar) => (
                    <option key={bar.key} value={bar.row.id}>
                      {label(bar)}
                    </option>
                  ))}
            </select>
          </label>
          {reason && <p role="status">{reason}</p>}
          <Button
            isDisabled={!target || !!reason}
            onPress={() => {
              if (source && target) apply(source, target);
              setSource(null);
            }}
            aria-label={
              source && target && linked(source, target)
                ? t({ id: 'views.gantt.removeDependency', message: 'Remove dependency' })
                : t({ id: 'views.gantt.addDependency', message: 'Add dependency' })
            }
            icon={faXmark}
          />
          <Button variant="quiet" onPress={() => setSource(null)}>
            {t({ id: 'views.gantt.cancelDependency', message: 'Cancel' })}
          </Button>
        </Dialog>
      </Modal>
    ),
  };
}
