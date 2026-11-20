export const MAX_NATIVE_SIZE = 8_000_000;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function createScrollMap(contentSize: number, viewportSize: number, cap = MAX_NATIVE_SIZE) {
  const nativeSize = Math.max(viewportSize, Math.min(contentSize, cap));
  const contentRange = Math.max(0, contentSize - viewportSize);
  const nativeRange = Math.max(0, nativeSize - viewportSize);
  const scale = nativeRange > 0 ? contentRange / nativeRange : 1;
  return {
    nativeSize,
    contentRange,
    nativeRange,
    scale,
    toNative: (position: number) => clamp(position, 0, contentRange) / scale,
    toContent: (position: number) => clamp(position, 0, nativeRange) * scale,
  };
}

export function alignScroll(
  position: number,
  start: number,
  size: number,
  viewport: number,
  align: 'nearest' | 'center' | 'start',
): number {
  if (align === 'start') return start;
  if (align === 'center') return start - (viewport - size) / 2;
  if (start < position) return start;
  if (start + size > position + viewport) return size > viewport ? start : start + size - viewport;
  return position;
}
