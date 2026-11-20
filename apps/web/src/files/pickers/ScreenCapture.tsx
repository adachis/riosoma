import { useLingui } from '@lingui/react/macro';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { canvasFile, captureName, stopStream } from './capture';

/**
 * Asks the browser to share a screen, a window, or a tab, keeps one frame of it, and ends the
 * share at once.  It must start from the person's own press, which the browser requires.
 */
export async function grabScreen(): Promise<HTMLCanvasElement> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // One more frame, so the picture isn't the blank one some browsers start with.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    video.srcObject = null;
    return canvas;
  } finally {
    stopStream(stream);
  }
}

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Keeps an area inside the picture and at least a pixel in each direction. */
export function fitArea(area: Area, width: number, height: number): Area {
  const w = clamp(Math.round(area.width), 1, width);
  const h = clamp(Math.round(area.height), 1, height);
  return {
    x: clamp(Math.round(area.x), 0, width - w),
    y: clamp(Math.round(area.y), 0, height - h),
    width: w,
    height: h,
  };
}

/**
 * The crop step: the captured frame with an area to keep.  Dragging across the picture draws the
 * area.  With the area focused, the arrow keys move it, and Shift with the arrow keys resizes it,
 * ten pixels at a time or one with Alt.
 */
export function ScreenCrop({
  capture,
  onCapture,
  onClose,
}: {
  capture: HTMLCanvasElement;
  onCapture(file: File): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const helpId = useId();
  const full = useMemo(() => ({ x: 0, y: 0, width: capture.width, height: capture.height }), [capture]);
  const [area, setArea] = useState<Area>(full);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string>();
  const picture = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let url: string | undefined;
    capture.toBlob((blob) => {
      if (!blob) return;
      url = URL.createObjectURL(blob);
      setSource(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [capture]);

  /** Where a pointer is on the picture, in the capture's own pixels. */
  function point(event: PointerEvent): { x: number; y: number } {
    const box = picture.current!.getBoundingClientRect();
    const scale = capture.width / (box.width || capture.width);
    return {
      x: clamp((event.clientX - box.left) * scale, 0, capture.width),
      y: clamp((event.clientY - box.top) * scale, 0, capture.height),
    };
  }

  function keys(event: KeyboardEvent) {
    const step = event.altKey ? 1 : 10;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setArea((current) =>
      fitArea(
        event.shiftKey
          ? { ...current, width: current.width + move[0], height: current.height + move[1] }
          : { ...current, x: current.x + move[0], y: current.y + move[1] },
        capture.width,
        capture.height,
      ),
    );
  }

  async function save() {
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = area.width;
    canvas.height = area.height;
    canvas
      .getContext('2d')
      ?.drawImage(capture, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    try {
      onCapture(
        await canvasFile(
          canvas,
          captureName(t({ id: 'files.screen.name', message: 'Screenshot' }), 'png'),
          'image/png',
        ),
      );
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <Modal isOpen isDismissable size="lg" onOpenChange={(open) => !open && onClose()}>
      <Dialog>
        <DialogTitle>{t({ id: 'files.screen.title', message: 'Crop the capture' })}</DialogTitle>
        <DialogBody>
          <p id={helpId} className="rio-files__hint">
            {t({
              id: 'files.screen.help',
              message:
                'Drag across the picture to choose what to keep.  With the area focused, arrow keys move it, and Shift with an arrow key resizes it.',
            })}
          </p>
          <div
            className="rio-capture__crop"
            onPointerDown={(event) => {
              if (!picture.current) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              start.current = point(event);
            }}
            onPointerMove={(event) => {
              if (!start.current) return;
              const here = point(event);
              setArea(
                fitArea(
                  {
                    x: Math.min(start.current.x, here.x),
                    y: Math.min(start.current.y, here.y),
                    width: Math.abs(here.x - start.current.x),
                    height: Math.abs(here.y - start.current.y),
                  },
                  capture.width,
                  capture.height,
                ),
              );
            }}
            onPointerUp={() => {
              start.current = null;
            }}
          >
            {source && <img ref={picture} src={source} alt="" draggable={false} />}
            <div
              className="rio-capture__area"
              role="group"
              tabIndex={0}
              aria-label={t({
                id: 'files.screen.area',
                message: `Area to keep, ${area.width} by ${area.height} pixels`,
              })}
              aria-describedby={helpId}
              onKeyDown={keys}
              style={{
                insetInlineStart: percent(area.x, capture.width),
                insetBlockStart: percent(area.y, capture.height),
                inlineSize: percent(area.width, capture.width),
                blockSize: percent(area.height, capture.height),
              }}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onPress={() => setArea(full)}>
            {t({ id: 'files.screen.whole', message: 'Keep all of it' })}
          </Button>
          <Button onPress={onClose}>{t({ id: 'files.screen.cancel', message: 'Cancel' })}</Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            {t({ id: 'files.screen.add', message: 'Add' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
