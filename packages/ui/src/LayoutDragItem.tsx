import type { HTMLAttributes, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { SortableMovementProvider } from './Sortable';
import './Sortable.css';

/** Spatial designers use the whole item and retain their existing keyboard resize control. */
export function LayoutDragItem({
  enabled,
  label,
  descriptionId,
  onMove,
  onKeys,
  movement,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  enabled: boolean;
  label: string;
  descriptionId: string;
  onMove(event: PointerEvent<HTMLElement>): void;
  onKeys(event: KeyboardEvent<HTMLButtonElement>): void;
  movement?: {
    name: string;
    up?: () => void;
    down?: () => void;
    destinations: ReadonlyArray<{ id: string; name: string; move(): void }>;
  };
  children: ReactNode;
}) {
  const item = (
    <article
      {...props}
      onPointerDown={(event) => {
        if (
          enabled &&
          !(event.target as Element).closest(
            'button, a, input, textarea, select, [contenteditable="true"], [data-sortable-selectable]',
          )
        )
          onMove(event);
      }}
    >
      {children}
      {enabled ? (
        <button
          type="button"
          className="rio-layout-activator"
          aria-label={label}
          title={label}
          aria-describedby={descriptionId}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
          onKeyDown={onKeys}
        />
      ) : null}
    </article>
  );
  // Editing adds controls without replacing the subtree that holds live editors and frames.
  return movement ? <SortableMovementProvider {...movement}>{item}</SortableMovementProvider> : item;
}
