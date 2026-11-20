import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Only overflowing values need a tab stop for the browser's keyboard scrolling. */
export function RecordValue({ labelId, children }: { labelId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const hidden = element.closest('[aria-hidden="true"], [inert]');
      element.tabIndex =
        !hidden && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
          ? 0
          : -1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    // Pickers temporarily hide sibling content while keeping it mounted.
    const visibility = new MutationObserver(measure);
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement)
      visibility.observe(ancestor, { attributes: true, attributeFilter: ['aria-hidden', 'inert'] });
    return () => {
      observer.disconnect();
      visibility.disconnect();
    };
  }, [children]);
  return (
    <div ref={ref} className="rio-record-card__value" role="group" aria-labelledby={labelId} tabIndex={-1}>
      {children}
    </div>
  );
}
