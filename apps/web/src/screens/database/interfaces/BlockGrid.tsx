import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LayoutDragItem, useLayoutDrag } from '@riosoma/ui';
import { useLingui } from '@lingui/react/macro';
import { faEllipsis, faPen, faCopy, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { blockBands, type Block } from '@riosoma/contracts';
import { Button, Menu, MenuItem, MenuTrigger } from '@riosoma/ui';
import { COLUMNS, MAX_ROW, nudgeTile, placeTile, readingOrder, resizeTile } from '../dashboards/layout';

/** Row height in pixels.  The stylesheet's grid rows match it. */
export const ROW_HEIGHT = 80;

export interface BlockGridProps {
  blocks: readonly Block[];
  /** Laying out: blocks move and resize by pointer and by keyboard, and show their menus */
  editing: boolean;
  /** The name each block goes by, for its heading and its controls */
  nameOf(block: Block): string;
  /** Whether the block shows its name above its contents outside editing */
  showsHeading(block: Block): boolean;
  renderBody(block: Block): ReactNode;
  /** False once the page holds as many blocks as it can */
  canAdd: boolean;
  onEdit(block: Block): void;
  onDuplicate(block: Block): void;
  onDelete(block: Block): void;
  /** A finished move or resize, with every block's new place */
  onLayout(blocks: readonly Block[], options?: { immediate: boolean }): void;
}

/**
 * A page's blocks on the 12-column grid, in reading order so the keyboard and phones follow the
 * rows.  While editing, dragging a block shows where it lands, nothing
 * saves until the pointer lets go, and each block's handle moves it with the arrow keys.
 */
export function BlockGrid({
  blocks,
  editing,
  nameOf,
  showsHeading,
  renderBody,
  canAdd,
  onEdit,
  onDuplicate,
  onDelete,
  onLayout,
}: BlockGridProps) {
  const { t } = useLingui();
  const grid = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const [announcement, setAnnouncement] = useState('');
  const { preview, startDrag, handleKeyDown, movement } = useLayoutDrag({
    items: blocks,
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
          id: 'interfaces.block.placed',
          message: `Column ${column}, row ${row}, ${width} wide and ${height} tall`,
        }),
      );
    },
  });
  const shown = readingOrder(blocks).map((item) => (item.id === preview?.id ? preview : item));
  const dragged = preview?.id;
  const bands = blockBands(shown);
  const bandOf = new Map(bands.flatMap((group) => group.blocks.map((block) => [block.id, group.band])));

  return (
    <div className="rio-interface-grid" ref={grid} data-editing={editing || undefined}>
      {bands
        .filter((group) => group.band !== 'none')
        .map((group) => {
          const start = group.blocks[0]!.place.y;
          const end = Math.max(...group.blocks.map((block) => block.place.y + block.place.h));
          return (
            <div
              key={group.blocks[0]!.id}
              className="rio-interface-band"
              data-band={group.band}
              aria-hidden="true"
              style={{ '--rio-interface-y': start + 1, '--rio-interface-h': end - start } as CSSProperties}
            />
          );
        })}
      {shown.map((block) => {
        const name = nameOf(block);
        const { x, y, w, h } = block.place;
        const style = {
          '--rio-interface-x': x + 1,
          '--rio-interface-y': y + 1,
          '--rio-interface-w': w,
          '--rio-interface-h': h,
        } as CSSProperties;
        const heading = editing || showsHeading(block);
        return (
          <LayoutDragItem
            enabled={editing}
            label={t({ id: 'interfaces.block.handle', message: `Move or resize ${name}` })}
            descriptionId={helpId}
            onKeys={(event) => handleKeyDown(event, block)}
            onMove={(event) => startDrag(event, block, 'move')}
            movement={movement(block, nameOf)}
            key={block.id}
            className="rio-interface-block"
            style={style}
            aria-label={name}
            data-band={bandOf.get(block.id) !== 'none' ? bandOf.get(block.id) : undefined}
            data-block={block.id}
            data-kind={block.kind}
            data-editing={editing || undefined}
            data-dragging={dragged === block.id || undefined}
          >
            {heading ? (
              <header className="rio-interface-block__header">
                <h3 className="rio-interface-block__title" title={name}>
                  {name}
                </h3>
                {editing ? (
                  <>
                    <MenuTrigger>
                      <Button
                        className="rio-interface-block__menu"
                        variant="quiet"
                        size="sm"
                        icon={faEllipsis}
                        aria-label={t({ id: 'database.sidebar.menu', message: `More for ${name}` })}
                      />
                      <Menu aria-label={t({ id: 'database.sidebar.menu', message: `More for ${name}` })}>
                        <MenuItem icon={faPen} onAction={() => onEdit(block)}>
                          {t({ id: 'interfaces.block.edit', message: 'Edit' })}
                        </MenuItem>
                        <MenuItem icon={faCopy} isDisabled={!canAdd} onAction={() => onDuplicate(block)}>
                          {t({ id: 'interfaces.block.duplicate', message: 'Duplicate' })}
                        </MenuItem>
                        <MenuItem icon={faTrashCan} tone="danger" onAction={() => onDelete(block)}>
                          {t({ id: 'interfaces.block.delete', message: 'Delete' })}
                        </MenuItem>
                      </Menu>
                    </MenuTrigger>
                  </>
                ) : null}
              </header>
            ) : null}
            {/* While editing, contents take neither the pointer nor the keyboard: the block moves as a whole. */}
            <div
              className="rio-interface-block__body"
              inert={editing || undefined}
              tabIndex={editing ? undefined : 0}
            >
              {renderBody(block)}
            </div>
            {editing ? (
              <>
                <div className="rio-interface-block__shield" aria-hidden="true" />
                <div
                  className="rio-interface-block__resize"
                  aria-hidden="true"
                  onPointerDown={(event) => startDrag(event, block, 'resize')}
                />
              </>
            ) : null}
          </LayoutDragItem>
        );
      })}
      <p id={helpId} className="rio-interface-visually-hidden">
        {t({
          id: 'interfaces.block.handleHelp',
          message: 'Arrow keys move the block.  Shift and the arrow keys resize it.',
        })}
      </p>
      <p className="rio-interface-visually-hidden" aria-live="polite">
        {editing ? announcement : ''}
      </p>
    </div>
  );
}
