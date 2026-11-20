import { Popover } from '@riosoma/ui';
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { EditorProps } from './types';
import './editors.css';

interface Props extends EditorProps {
  children: ReactNode;
  /** Returning false holds focus and selection while an asynchronous save is unresolved. */
  onDismiss(): boolean | void;
  /** Escape, when it means something other than a click elsewhere */
  onEscape?(): void;
  onTab?(event: KeyboardEvent): void;
}

/** Grid navigation must run before the popover's document-level focus restoration. */
export function useEditorTab(ref: RefObject<HTMLElement | null>, onTab?: (event: KeyboardEvent) => void) {
  useEffect(() => {
    const ownerWindow = ref.current?.ownerDocument.defaultView;
    if (!ownerWindow || !onTab) return;
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key === 'Tab' &&
        !event.isComposing &&
        event.target instanceof Node &&
        ref.current?.contains(event.target)
      )
        onTab(event);
    };
    ownerWindow.addEventListener('keydown', keyboard, true);
    return () => ownerWindow.removeEventListener('keydown', keyboard, true);
  }, [ref, onTab]);
}

export function EditorPopover({
  request,
  context,
  portalContainer,
  children,
  onDismiss,
  onEscape,
  onTab,
}: Props) {
  const triggerRef = useMemo(() => ({ current: request.anchor }), [request.anchor]);
  const content = useRef<HTMLDivElement>(null);
  useEditorTab(content, onTab);
  useEffect(() => {
    // A nonmodal popover leaves page scrolling alone, but needs explicit outside dismissal.
    const document = request.anchor.ownerDocument;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element) {
        // Portaled file controls and the calendar belong to the editor's dismissal boundary, and so
        // does the file picker Google draws on the page itself.
        if (
          event.target.closest(
            '.rio-file-preview-overlay, .rio-date-picker__popover, .rio-files__source-menu, .rio-url-picker, .rio-text-conflict, .picker-dialog, .picker-dialog-bg',
          )
        )
          return;
        // A dialog that opened over the editor, such as a drive picker, belongs to it too: a press
        // in the dialog isn't a press on the page.  A dialog the grid itself sits in is the page.
        const overlay = event.target.closest('.rio-modal-overlay');
        if (overlay && !overlay.contains(request.anchor)) return;
      }
      const popover = content.current?.closest('.rio-cell-editor');
      if (popover && !event.composedPath().includes(popover) && onDismiss() === false) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [request.anchor, onDismiss]);
  return (
    <Popover
      isOpen
      isNonModal
      triggerRef={triggerRef}
      placement="bottom start"
      UNSTABLE_portalContainer={portalContainer}
      aria-label={context.field.name}
      className="rio-cell-editor"
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <div
        ref={content}
        role="dialog"
        // Saving makes the fields inert, but the named frame must still support keyboard scrolling.
        tabIndex={0}
        aria-label={context.field.name}
        className="rio-cell-editor__content"
        onKeyDownCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.rio-file-preview-overlay, .rio-text-conflict')
          )
            return;
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            (onEscape ?? onDismiss)();
          }
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </Popover>
  );
}
