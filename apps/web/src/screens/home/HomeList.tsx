import {
  cloneElement,
  Component,
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import './HomeList.css';

type Position = {
  'aria-posinset': number;
  'aria-setsize': number;
  'data-home-key': string;
  style?: CSSProperties;
};
const ItemPosition = createContext<Position | undefined>(undefined);
export const useHomeItemPosition = () => useContext(ItemPosition);
const collections = new Set<(id: string) => boolean>();

type WindowProps = HTMLAttributes<HTMLUListElement> & {
  elementRef: RefObject<HTMLUListElement | null>;
  preserve: boolean;
  windowKey: string;
};

// WebKit can clamp scrolling while old spacer rows leave the DOM.  Snapshot before that
// mutation and restore before the parent's layout effects measure the replacement window.
class HomeListWindow extends Component<WindowProps> {
  override getSnapshotBeforeUpdate(previous: WindowProps): number | null {
    return this.props.preserve && previous.preserve && this.props.windowKey === previous.windowKey
      ? (this.props.elementRef.current?.scrollTop ?? null)
      : null;
  }

  override componentDidUpdate(_previous: WindowProps, _state: unknown, top: number | null) {
    const element = this.props.elementRef.current;
    if (element && top !== null && element.scrollTop !== top) element.scrollTop = top;
  }

  override render() {
    const { elementRef, preserve: _preserve, windowKey: _windowKey, ...attributes } = this.props;
    return <ul {...attributes} ref={elementRef} />;
  }
}

/** Movement can reveal a destination before the shared arrangement restores focus. */
export function revealHomeItem(id: string): void {
  for (const reveal of [...collections].reverse()) if (reveal(id)) return;
}

/** Bound mounted controls while retaining the list's full scroll range and keyboard order. */
export function HomeList<T extends { id: string }>({
  items,
  children,
  className,
  label,
  revealId,
}: {
  items: readonly T[];
  children(item: T): ReactElement;
  className: string;
  label?: string;
  revealId?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const revealed = useRef<string | undefined>(undefined);
  const restored = useRef<string | undefined>(undefined);
  const storageKey = `rio.home.scroll:${location.pathname}:${className}:${label ?? ''}`;
  const virtual = items.length > 20;
  const [layout, setLayout] = useState({
    columns: 1,
    height: 64,
    gap: 0,
    top: 0,
    viewport: 0,
    measured: false,
  });
  const [pinned, setPinned] = useState<string>();
  const [contact, setContact] = useState<string>();
  const [retained, setRetained] = useState<ReadonlySet<string>>(new Set());
  const stride = layout.height + layout.gap;
  const rows = Math.ceil(items.length / layout.columns);
  const first = Math.max(0, Math.floor(layout.top / stride));
  const last = Math.min(rows, Math.max(first + 1, Math.ceil((layout.top + layout.viewport) / stride)));
  const pinnedIndex = items.findIndex((item) => item.id === pinned);
  const pinnedRow = pinnedIndex < 0 ? -1 : Math.floor(pinnedIndex / layout.columns);
  const contactIndex = items.findIndex((item) => item.id === contact);
  const contactRow = contactIndex < 0 ? -1 : Math.floor(contactIndex / layout.columns);
  const retainedRows = new Set(
    items.flatMap((item, index) => (retained.has(item.id) ? [Math.floor(index / layout.columns)] : [])),
  );

  const retainInteractions = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const next = new Set<string>();
    // Drafts, active drag targets, and menu anchors outlive focus moving to another row.
    for (const control of element.querySelectorAll(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [aria-haspopup][aria-expanded="true"], [data-dragging="true"], [data-drop-target="true"], [data-drop-before="true"]',
    )) {
      const id = control.closest('[data-home-key]')?.getAttribute('data-home-key');
      if (id) next.add(id);
    }
    setRetained((previous) =>
      previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next,
    );
  }, []);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    retainInteractions();
    const observer = new MutationObserver(retainInteractions);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'data-dragging', 'data-drop-target', 'data-drop-before'],
    });
    const releaseContact = () => {
      retainInteractions();
      setContact(undefined);
    };
    for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'])
      window.addEventListener(event, releaseContact, true);
    return () => {
      observer.disconnect();
      for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'])
        window.removeEventListener(event, releaseContact, true);
    };
  }, [retainInteractions]);

  useLayoutEffect(() => {
    if (!virtual || !layout.measured || !list.current || restored.current === storageKey) return;
    restored.current = storageKey;
    try {
      const anchor = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as {
        index: number;
        offset: number;
      } | null;
      if (anchor && Number.isFinite(anchor.index) && Number.isFinite(anchor.offset)) {
        // Restore an item after the grid is measured, so initial spacer estimates cannot clamp it.
        const top = Math.floor(anchor.index / layout.columns) * stride + Math.min(anchor.offset, stride - 1);
        retainInteractions();
        list.current.scrollTop = top;
        setLayout((previous) => ({
          ...previous,
          top: list.current!.scrollTop,
          viewport: list.current!.clientHeight || 512,
        }));
      }
    } catch {
      // Lists still scroll when the browser disallows session storage.
    }
  }, [virtual, storageKey, layout.measured, layout.columns, stride, retainInteractions]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !virtual) return;
    const viewport = () =>
      Math.max(0, Math.min(element.clientHeight || 512, innerHeight - element.getBoundingClientRect().top));
    const updateViewport = () => {
      const height = viewport();
      setLayout((previous) => (previous.viewport >= height ? previous : { ...previous, viewport: height }));
    };
    const measure = () => {
      const style = getComputedStyle(element);
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
      const height = Math.max(
        1,
        ...Array.from(element.children)
          .filter((child) => child.hasAttribute('data-home-key'))
          .map((child) => child.getBoundingClientRect().height),
      );
      setLayout((previous) => {
        const next = {
          columns,
          height: Math.max(height, previous.height),
          gap: Number.parseFloat(style.rowGap) || 0,
          top: element.scrollTop,
          viewport: Math.max(previous.viewport, viewport()),
          measured: true,
        };
        return Object.keys(next).every(
          (key) => next[key as keyof typeof next] === previous[key as keyof typeof next],
        )
          ? previous
          : next;
      });
    };
    measure();
    // Grow page windows as they enter view; scrolling away must not evict controls in use.
    window.addEventListener('scroll', updateViewport, true);
    window.addEventListener('resize', updateViewport);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) if (child.hasAttribute('data-home-key')) observer.observe(child);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', updateViewport, true);
      window.removeEventListener('resize', updateViewport);
    };
  }, [virtual, first, last, pinnedRow, contactRow, retained, items]);

  useLayoutEffect(() => {
    if (!virtual) return;
    const reveal = (id: string) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0 || !list.current) return false;
      const top = Math.floor(index / layout.columns) * stride;
      retainInteractions();
      list.current.scrollTop = top;
      flushSync(() =>
        setLayout((previous) => ({
          ...previous,
          top: list.current!.scrollTop,
          viewport: list.current!.clientHeight || 512,
        })),
      );
      return true;
    };
    collections.add(reveal);
    return () => {
      collections.delete(reveal);
    };
  }, [items, virtual, layout.columns, stride, retainInteractions]);

  useLayoutEffect(() => {
    if (!virtual || !layout.measured || !revealId || revealId === revealed.current || !list.current) return;
    const index = items.findIndex((item) => item.id === revealId);
    if (index < 0) return;
    revealed.current = revealId;
    const top = Math.floor(index / layout.columns) * stride;
    retainInteractions();
    list.current.scrollTop = top;
    setLayout((previous) => ({
      ...previous,
      top: list.current!.scrollTop,
      viewport: list.current!.clientHeight || 512,
    }));
  }, [revealId, items, virtual, layout.measured, layout.columns, stride, retainInteractions]);

  const focusItem = (index: number, backwards = false) => {
    const item = items[index];
    if (!item || !list.current) return;
    const top = Math.floor(index / layout.columns) * stride;
    retainInteractions();
    list.current.scrollTop = top;
    flushSync(() =>
      setLayout((previous) => ({
        ...previous,
        top: list.current!.scrollTop,
        viewport: list.current!.clientHeight || 512,
      })),
    );
    const row = Array.from(list.current.children).find(
      (child) => child.getAttribute('data-home-key') === item.id,
    );
    const controls = row?.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    );
    const control = backwards ? controls?.item(controls.length - 1) : controls?.item(0);
    control?.focus();
  };
  const content: ReactElement[] = [];
  let skipped = 0;
  const spacer = () => {
    if (!skipped) return;
    content.push(
      <li
        key={`space-${content.length}`}
        aria-hidden="true"
        role="presentation"
        className="rio-home-list__space"
        style={{ blockSize: skipped * stride - layout.gap }}
      />,
    );
    skipped = 0;
  };
  for (let row = 0; row < rows; row++) {
    if (
      virtual &&
      (row < first || row >= last) &&
      row !== pinnedRow &&
      row !== contactRow &&
      !retainedRows.has(row)
    ) {
      skipped++;
      continue;
    }
    spacer();
    for (
      let index = row * layout.columns;
      index < Math.min(items.length, (row + 1) * layout.columns);
      index++
    ) {
      const item = items[index]!;
      const position: Position = {
        'aria-posinset': index + 1,
        'aria-setsize': items.length,
        'data-home-key': item.id,
        style: virtual ? { minBlockSize: layout.height, boxSizing: 'border-box' } : undefined,
      };
      const child = children(item);
      content.push(
        <ItemPosition.Provider key={item.id} value={position}>
          {typeof child.type === 'string' ? cloneElement(child as ReactElement<Position>, position) : child}
        </ItemPosition.Provider>,
      );
    }
  }
  spacer();
  return (
    <HomeListWindow
      elementRef={list}
      preserve={virtual}
      windowKey={storageKey}
      className={className}
      aria-label={label}
      data-home-virtual={virtual || undefined}
      tabIndex={virtual ? 0 : undefined}
      onScroll={(event) => {
        retainInteractions();
        const top = event.currentTarget.scrollTop;
        const viewport = event.currentTarget.clientHeight;
        setLayout((previous) =>
          previous.top === top && previous.viewport >= viewport
            ? previous
            : { ...previous, top, viewport: Math.max(previous.viewport, viewport) },
        );
        try {
          sessionStorage.setItem(
            storageKey,
            JSON.stringify({ index: Math.floor(top / stride) * layout.columns, offset: top % stride }),
          );
        } catch {
          // Storage is optional, and a blocked write must not interrupt scrolling.
        }
      }}
      onPointerDownCapture={(event) => {
        retainInteractions();
        const row = (event.target as Element).closest('[data-home-key]');
        if (row) setContact(row.getAttribute('data-home-key')!);
      }}
      onTouchStartCapture={(event) => {
        retainInteractions();
        const row = (event.target as Element).closest('[data-home-key]');
        if (row) setContact(row.getAttribute('data-home-key')!);
      }}
      onFocusCapture={(event) => {
        retainInteractions();
        const row = (event.target as Element).closest('[data-home-key]');
        if (row) setPinned(row.getAttribute('data-home-key')!);
      }}
      onKeyDownCapture={(event) => {
        if (!virtual || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target as HTMLElement;
        if (target.closest('[role="menu"]')) return;
        if (event.target === event.currentTarget && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault();
          focusItem(event.key === 'Home' ? 0 : items.length - 1);
        } else if (event.key === 'Tab') {
          const row = target.closest('[data-home-key]');
          const index = items.findIndex((item) => item.id === row?.getAttribute('data-home-key'));
          const controls = row?.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
          );
          if (index < 0 || !controls?.length) return;
          const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
          const next = index + (event.shiftKey ? -1 : 1);
          if (target === edge && items[next]) {
            event.preventDefault();
            focusItem(next, event.shiftKey);
          }
        }
      }}
    >
      {content}
    </HomeListWindow>
  );
}
