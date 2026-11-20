import { memo, useCallback, type MutableRefObject, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { cellValue, type FieldMeta } from '@riosoma/contracts';
import { formatCell } from '../../../../grid/format';
import type { ViewComponentProps } from '../types';
import { CARD_WIDTH, type ChartNode } from './layout';

export interface CardActions {
  focus(node: ChartNode): void;
  select(node: ChartNode): void;
  open(node: ChartNode): void;
  toggle(node: ChartNode): void;
  drag(event: PointerEvent, node: ChartNode): void;
}

export const Card = memo(function Card({
  node,
  primary,
  shown,
  format,
  height,
  overview,
  selected,
  drop,
  refusal,
  elements,
  actions,
}: {
  node: ChartNode;
  primary: FieldMeta | undefined;
  shown: FieldMeta[];
  format: ViewComponentProps['format'];
  height: number;
  overview: boolean;
  selected: boolean;
  drop: boolean;
  refusal: string | undefined;
  elements: Map<string, SVGGElement>;
  actions: MutableRefObject<CardActions>;
}) {
  const { t } = useLingui();
  const ref = useCallback(
    (element: SVGGElement | null) => {
      if (element) elements.set(node.key, element);
      else elements.delete(node.key);
    },
    [elements, node.key],
  );
  if (!node.row) return null;
  const name =
    (primary ? formatCell(primary, cellValue(node.row, primary), format) : '') ||
    t({ id: 'views.orgChart.untitled', message: 'Untitled record' });
  const values = overview
    ? []
    : shown.map((field) => `${field.name}: ${formatCell(field, cellValue(node.row!, field), format)}`);
  return (
    <g
      ref={ref}
      role="treeitem"
      aria-label={[name, ...values].join(' ')}
      aria-description={refusal}
      aria-level={node.level}
      aria-posinset={node.position}
      aria-setsize={node.size}
      aria-expanded={node.children ? node.expanded : undefined}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-org-record={node.key}
      data-drop={drop || undefined}
      className="rio-org-chart__card"
      transform={`translate(${node.x} ${node.y})`}
      onFocus={() => actions.current.focus(node)}
      onPointerDown={(event) => actions.current.drag(event, node)}
      onClick={() => actions.current.select(node)}
      onDoubleClick={() => actions.current.open(node)}
    >
      <rect width={CARD_WIDTH} height={height} rx="8" />
      {!overview && (
        <>
          <svg x="12" y="0" width={CARD_WIDTH - 24} height={height} aria-hidden="true">
            <text className="rio-org-chart__title" x="0" y="28">
              {name}{' '}
            </text>
            {values.map((value, index) => (
              <text key={shown[index]!.id} x="0" y={54 + index * 24}>
                {value}{' '}
              </text>
            ))}
          </svg>
          {node.children > 0 && (
            <g
              className="rio-org-chart__toggle"
              role="button"
              tabIndex={-1}
              aria-label={
                node.expanded
                  ? t({ id: 'views.orgChart.collapseRecord', message: `Collapse ${name}` })
                  : t({ id: 'views.orgChart.expandRecord', message: `Expand ${name}` })
              }
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                actions.current.toggle(node);
              }}
            >
              <circle cx={CARD_WIDTH - 18} cy={height - 14} r="12" />
              <path
                d={`M${CARD_WIDTH - 24},${height - 14} h12${node.expanded ? '' : ` M${CARD_WIDTH - 18},${height - 20} v12`}`}
              />
            </g>
          )}
        </>
      )}
    </g>
  );
});
