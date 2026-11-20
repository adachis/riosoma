import { useId, useRef, useState } from 'react';
import { useLayoutDrag } from '@riosoma/ui';
import { useLingui } from '@lingui/react/macro';
import type { Tile } from '@riosoma/contracts';
import { DashboardTile, type TileContext } from './DashboardTile';
import { COLUMNS, MAX_ROW, nudgeTile, placeTile, readingOrder, resizeTile } from './layout';
import { KIND_LABELS } from './messages';

/** Row height in pixels.  The stylesheet's grid rows match it. */
export const ROW_HEIGHT = 80;

export interface DashboardGridProps {
  tiles: readonly Tile[];
  context: TileContext;
  /** Laying out: tiles move and resize by pointer and by keyboard */
  editing: boolean;
  /** A finished move or resize, with every tile's new place */
  onLayout(tiles: readonly Tile[], options?: { immediate: boolean }): void;
}

/**
 * The 12-column grid of tiles, in reading order so the keyboard and phones follow the rows.  While
 * editing, dragging a tile shows where it lands, and nothing is saved
 * until the pointer lets go.  Outside editing nothing on the grid moves.
 */
export function DashboardGrid({ tiles, context, editing, onLayout }: DashboardGridProps) {
  const { t, i18n } = useLingui();
  const grid = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [announcement, setAnnouncement] = useState('');
  const { preview, startDrag, handleKeyDown, movement } = useLayoutDrag({
    items: tiles,
    enabled: editing,
    grid,
    columns: COLUMNS,
    rowHeight: ROW_HEIGHT,
    maxRow: MAX_ROW,
    place: placeTile,
    nudge: nudgeTile,
    resize: resizeTile,
    onCommit: (next, immediate) => onLayout(next, { immediate }),
    onAnnounce: (place) => {
      const column = place.x + 1;
      const row = place.y + 1;
      const width = place.w;
      const height = place.h;
      setAnnouncement(
        t({
          id: 'dashboards.tile.placed',
          message: `Column ${column}, row ${row}, ${width} wide and ${height} tall`,
        }),
      );
    },
  });
  const shown = readingOrder(tiles).map((item) => (item.id === preview?.id ? preview : item));
  const dragged = preview?.id;

  return (
    <div className="rio-dashboard-grid" ref={grid} data-editing={editing || undefined}>
      {shown.map((tile) => (
        <DashboardTile
          key={tile.id}
          tile={tile}
          context={context}
          editing={editing}
          dragging={dragged === tile.id}
          helpId={helpId}
          onHandleKeyDown={handleKeyDown}
          onDragStart={startDrag}
          movement={movement(tile, (entry) => entry.title.trim() || i18n._(KIND_LABELS[entry.kind]))}
        />
      ))}
      <p id={helpId} className="rio-dashboard-visually-hidden">
        {t({
          id: 'dashboards.tile.handleHelp',
          message: 'Arrow keys move the tile.  Shift and the arrow keys resize it.',
        })}
      </p>
      <p className="rio-dashboard-visually-hidden" aria-live="polite">
        {editing ? announcement : ''}
      </p>
    </div>
  );
}
