/**
 * What this browser can capture.  A phone takes photos through the file input's `capture`
 * attribute, which opens its camera app, and a computer shows a live preview with its own shutter.
 * Screen capture needs the browser's screen-sharing prompt, which phones don't have.
 */
export type CameraSupport = 'input' | 'live' | null;

function coarsePointer(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}

export function cameraSupport(): CameraSupport {
  if (typeof navigator === 'undefined') return null;
  if (coarsePointer()) return 'input';
  return typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'live' : null;
}

export function screenSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !coarsePointer() &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

/** A name for a capture, from the moment it was taken, such as `Photo 2026-09-28 14.05.33.jpg`. */
export function captureName(prefix: string, extension: string, at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `${prefix} ${date} ${time}.${extension}`;
}

/** A canvas's picture as a file. */
export function canvasFile(canvas: HTMLCanvasElement, name: string, type: string): Promise<File> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], name, { type })) : reject(new Error('empty capture'))),
      type,
      0.92,
    ),
  );
}

/** Stops every track of a stream, which turns the camera light off or ends the screen share. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
