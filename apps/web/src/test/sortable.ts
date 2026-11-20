import { act, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

/** DOM tests supply row geometry because their document has no layout engine */
export async function dragItem(
  handle: HTMLElement,
  target: HTMLElement,
  fraction = 0.95,
  beforeDrop?: () => void | Promise<void>,
) {
  const rows = [...document.querySelectorAll<HTMLElement>('.rio-sortable-item')];
  rows.forEach((row, index) => {
    const horizontal = row.dataset.orientation === 'horizontal';
    const top = horizontal ? 0 : index * 100;
    const left = horizontal ? index * 100 : 0;
    const width = horizontal ? 80 : 500;
    const height = horizontal ? 500 : 80;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    });
  });
  for (const row of rows) {
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (!/auto|scroll|hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`))
        continue;
      if (parent.getBoundingClientRect().width) continue;
      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, window.innerWidth, window.innerHeight),
      );
      vi.spyOn(parent, 'clientWidth', 'get').mockReturnValue(window.innerWidth);
      vi.spyOn(parent, 'clientHeight', 'get').mockReturnValue(window.innerHeight);
    }
  }
  const sourceRect = handle.closest('.rio-sortable-item')!.getBoundingClientRect();
  const targetRect = target.closest('.rio-sortable-item')!.getBoundingClientRect();
  const pointer = {
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
    button: 0,
    clientX: sourceRect.left + 20,
    clientY: sourceRect.top + 20,
  };
  fireEvent.pointerDown(handle, pointer);
  fireEvent.pointerMove(document, { ...pointer, clientX: pointer.clientX + 10 });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  fireEvent.pointerMove(document, {
    ...pointer,
    clientX:
      targetRect.left +
      (target.closest<HTMLElement>('.rio-sortable-item')?.dataset.orientation === 'horizontal'
        ? targetRect.width * fraction
        : 20),
    clientY: targetRect.top + targetRect.height * fraction,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await beforeDrop?.();
  fireEvent.pointerUp(document, pointer);
  // The sensor briefly suppresses the click that follows a pointer drop
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}
