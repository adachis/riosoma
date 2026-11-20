import { columnDestination, logicalPoint } from './layout.js';
import type { GridColumn } from './types.js';

interface Metrics {
  columns: readonly GridColumn[];
  prefix: readonly number[];
  frozen: number;
  rowHeader: number;
  scrollX: number;
  direction: 'ltr' | 'rtl';
}

export interface InteractionHooks {
  metrics(): Metrics;
  resize(index: number, width: number, final: boolean): void;
  move(from: number, to: number): void;
  indicator(slot: number | null): void;
  activate(index: number, anchor: HTMLElement): void;
  add(): void;
  addColumn?(): void;
}

interface Gesture {
  pointer: number;
  index: number;
  anchor: HTMLElement;
  startX: number;
  startY: number;
  left: number;
  width: number;
  originalWidth: number;
  currentWidth: number;
  resize: boolean;
  moved: boolean;
  destination: number;
}

export function createInteraction(container: HTMLElement, hooks: InteractionHooks) {
  const events = new AbortController();
  const listenerOptions = { signal: events.signal };
  let gesture: Gesture | null = null;

  container.addEventListener(
    'pointerdown',
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
      const header = event.target.closest<HTMLElement>('[data-rio-column]');
      if (!header) return;
      const resize = !!event.target.closest('[data-rio-resize]');
      if (!resize) return;
      const index = Number(header.dataset.rioColumn);
      const column = hooks.metrics().columns[index];
      if (!column) return;
      const rect = container.getBoundingClientRect();
      gesture = {
        pointer: event.pointerId,
        index,
        anchor: header,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        width: rect.width,
        originalWidth: column.width,
        currentWidth: column.width,
        resize,
        moved: false,
        destination: index,
      };
      container.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    listenerOptions,
  );

  container.addEventListener(
    'pointermove',
    (event) => {
      if (!gesture || event.pointerId !== gesture.pointer) return;
      const metrics = hooks.metrics();
      const delta = (event.clientX - gesture.startX) * (metrics.direction === 'rtl' ? -1 : 1);
      gesture.moved ||= Math.abs(delta) + Math.abs(event.clientY - gesture.startY) >= 4;
      if (gesture.resize) {
        gesture.currentWidth = Math.max(
          metrics.columns[gesture.index]?.minWidth ?? 60,
          gesture.originalWidth + delta,
        );
        hooks.resize(gesture.index, gesture.currentWidth, false);
      } else if (gesture.moved) {
        let point =
          logicalPoint(event.clientX, gesture.left, gesture.width, metrics.direction) - metrics.rowHeader;
        if (gesture.index >= metrics.frozen) point += metrics.scrollX;
        let slot = metrics.columns.findIndex(
          (column, index) => point < metrics.prefix[index]! + column.width / 2,
        );
        if (slot === -1) slot = metrics.columns.length;
        gesture.destination = columnDestination(gesture.index, slot, metrics.columns.length, metrics.frozen);
        hooks.indicator(gesture.destination > gesture.index ? gesture.destination + 1 : gesture.destination);
      }
    },
    listenerOptions,
  );

  function finish(event: PointerEvent, canceled: boolean) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const finished = gesture;
    gesture = null;
    hooks.indicator(null);
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    if (finished.resize)
      hooks.resize(finished.index, canceled ? finished.originalWidth : finished.currentWidth, true);
    else if (!canceled && finished.moved && finished.destination !== finished.index)
      hooks.move(finished.index, finished.destination);
    else if (!canceled && !finished.moved) hooks.activate(finished.index, finished.anchor);
  }

  container.addEventListener('pointerup', (event) => finish(event, false), listenerOptions);
  container.addEventListener('pointercancel', (event) => finish(event, true), listenerOptions);
  container.addEventListener('lostpointercapture', (event) => finish(event, true), listenerOptions);
  container.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('[data-rio-add]')) hooks.add();
      if (event.target instanceof Element && event.target.closest('[data-rio-add-column]'))
        hooks.addColumn?.();
    },
    listenerOptions,
  );

  return { destroy: () => events.abort() };
}
