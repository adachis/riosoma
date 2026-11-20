export interface WindowPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}

export function fitWindow(position: WindowPosition, viewport: Viewport): WindowPosition {
  if (viewport.width <= 767) return { x: 0, y: 0, ...viewport };
  const width = Math.min(Math.max(position.width, 360), viewport.width - 16);
  const height = Math.min(Math.max(position.height, 320), viewport.height - 16);
  return {
    x: Math.max(8, Math.min(position.x, viewport.width - width - 8)),
    y: Math.max(8, Math.min(position.y, viewport.height - height - 8)),
    width,
    height,
  };
}

export function readWindowPreference(value: string | null, viewport: Viewport): WindowPosition {
  try {
    const position = JSON.parse(value ?? 'null') as WindowPosition | null;
    if (
      position &&
      [position.x, position.y, position.width, position.height].every(
        (part) => typeof part === 'number' && Number.isFinite(part),
      )
    )
      return position;
  } catch {
    // A damaged preference should not prevent opening documentation.
  }
  return { x: Math.max(8, viewport.width - 648), y: 48, width: 600, height: 640 };
}

export function readWindowPosition(value: string | null, viewport: Viewport): WindowPosition {
  return fitWindow(readWindowPreference(value, viewport), viewport);
}
