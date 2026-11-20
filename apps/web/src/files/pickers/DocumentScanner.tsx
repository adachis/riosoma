import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Banner, Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { cameraSupport, captureName, stopStream } from './capture';
import { detectEdges, perspective, scanPdf, validCorners, type Corners, type Raster } from './scan';

interface Capture {
  image: Raster;
  preview: string;
}
interface Page {
  id: number;
  image: string;
}

export function DocumentScanner({ onFiles, onClose }: { onFiles(files: File[]): void; onClose(): void }) {
  const { t } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const media = useRef<MediaStream | null>(null);
  const crop = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const next = useRef(0);
  const hint = useId();
  const modeId = useId();
  const [live, setLive] = useState(() => cameraSupport() === 'live');
  const [ready, setReady] = useState(false);
  const [capture, setCapture] = useState<Capture>();
  const [corners, setCorners] = useState<Corners>();
  const [pages, setPages] = useState<Page[]>([]);
  const [mode, setMode] = useState<'color' | 'bw'>('color');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const cornerNames = [
    t({ id: 'files.scan.topLeft', message: 'Top left corner' }),
    t({ id: 'files.scan.topRight', message: 'Top right corner' }),
    t({ id: 'files.scan.bottomRight', message: 'Bottom right corner' }),
    t({ id: 'files.scan.bottomLeft', message: 'Bottom left corner' }),
  ];

  useEffect(() => {
    if (!live || capture) return;
    let active = true;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(
      (stream) => {
        if (!active) return stopStream(stream);
        media.current = stream;
        if (video.current) {
          video.current.srcObject = stream;
          void video.current.play().catch(() => undefined);
        }
      },
      () => {
        if (active) {
          setLive(false);
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
      stopStream(media.current);
      media.current = null;
    };
  }, [live, capture]);

  function take(source: CanvasImageSource, width: number, height: number) {
    const canvas = document.createElement('canvas');
    // Bound decoded page size so several phone photos fit in browser memory.
    const scale = Math.min(1, 1800 / Math.max(width, height));
    canvas.width = Math.max(2, Math.round(width * scale));
    canvas.height = Math.max(2, Math.round(height * scale));
    const context = canvas.getContext('2d')!;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const small = document.createElement('canvas');
    const ratio = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    small.width = Math.round(canvas.width * ratio);
    small.height = Math.round(canvas.height * ratio);
    const smallContext = small.getContext('2d')!;
    smallContext.drawImage(canvas, 0, 0, small.width, small.height);
    const detected = detectEdges(smallContext.getImageData(0, 0, small.width, small.height));
    setCorners(
      detected.map((point) => ({
        x: (point.x * (canvas.width - 1)) / (small.width - 1),
        y: (point.y * (canvas.height - 1)) / (small.height - 1),
      })) as Corners,
    );
    setCapture({ image, preview: canvas.toDataURL('image/jpeg', 0.9) });
    setReady(false);
    setFailed(false);
  }

  async function read(file: File) {
    setBusy(true);
    setFailed(false);
    const address = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = address;
      await image.decode();
      take(image, image.naturalWidth, image.naturalHeight);
    } catch {
      setFailed(true);
    } finally {
      URL.revokeObjectURL(address);
      setBusy(false);
    }
  }

  function move(index: number, x: number, y: number) {
    if (!capture) return;
    setCorners((previous) => {
      if (!previous) return previous;
      const changed = previous.map((point, i) =>
        i === index
          ? {
              x: Math.max(0, Math.min(capture.image.width - 1, x)),
              y: Math.max(0, Math.min(capture.image.height - 1, y)),
            }
          : point,
      ) as Corners;
      return validCorners(changed) ? changed : previous;
    });
  }

  function addPage() {
    if (!capture || !corners) return;
    try {
      const image = perspective(capture.image, corners, mode === 'bw');
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      canvas
        .getContext('2d')!
        .putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      setPages((previous) => [
        ...previous,
        { id: ++next.current, image: canvas.toDataURL('image/jpeg', 0.92) },
      ]);
      setCapture(undefined);
      setCorners(undefined);
    } catch {
      setFailed(true);
    }
  }

  function reorder(index: number, delta: number) {
    setPages((previous) => {
      const changed = [...previous];
      [changed[index], changed[index + delta]] = [changed[index + delta]!, changed[index]!];
      return changed;
    });
  }

  async function save() {
    setBusy(true);
    setFailed(false);
    try {
      const name = captureName(t({ id: 'files.scan.name', message: 'Scan' }), 'pdf');
      onFiles([
        await scanPdf(
          pages.map((page) => page.image),
          name,
        ),
      ]);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      size="lg"
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog className="rio-scan-picker" hideCloseButton={busy}>
        <DialogTitle>{t({ id: 'files.scan.title', message: 'Scan documents' })}</DialogTitle>
        <DialogBody>
          {failed && (
            <Banner tone="danger">
              {t({
                id: 'files.scan.failed',
                message: 'The scan didn’t work.  Try a photo from your device or capture the page again.',
              })}
            </Banner>
          )}
          {!capture && (
            <>
              {live && (
                <video
                  ref={video}
                  playsInline
                  muted
                  className="rio-capture__preview"
                  aria-label={t({ id: 'files.camera.preview', message: 'Camera preview' })}
                  onLoadedData={() => setReady(true)}
                />
              )}
              <div className="rio-scan-picker__actions">
                {live && (
                  <Button
                    isDisabled={!ready || busy || pages.length >= 30}
                    onPress={() => {
                      if (video.current?.videoWidth)
                        take(video.current, video.current.videoWidth, video.current.videoHeight);
                    }}
                  >
                    {t({ id: 'files.scan.capture', message: 'Capture page' })}
                  </Button>
                )}
                <Button isDisabled={busy || pages.length >= 30} onPress={() => input.current?.click()}>
                  {t({ id: 'files.scan.choose', message: 'Use a photo' })}
                </Button>
                <input
                  ref={input}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  hidden
                  aria-label={t({ id: 'files.scan.choose', message: 'Use a photo' })}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void read(file);
                  }}
                />
              </div>
            </>
          )}
          {capture && corners && (
            <>
              <p id={hint}>
                {t({
                  id: 'files.scan.adjust',
                  message:
                    'Drag each corner to the page edge.  Use arrow keys for small adjustments, or Shift with an arrow key for larger adjustments.',
                })}
              </p>
              <div ref={crop} className="rio-scan-picker__crop">
                <img src={capture.preview} alt={t({ id: 'files.scan.page', message: 'Captured page' })} />
                <svg
                  viewBox={`0 0 ${capture.image.width - 1} ${capture.image.height - 1}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon points={corners.map((p) => `${p.x},${p.y}`).join(' ')} />
                </svg>
                {corners.map((point, index) => (
                  <button
                    key={index}
                    type="button"
                    className="rio-scan-picker__corner"
                    aria-label={cornerNames[index]}
                    title={cornerNames[index]}
                    aria-describedby={hint}
                    style={{
                      left: `${(point.x / (capture.image.width - 1)) * 100}%`,
                      top: `${(point.y / (capture.image.height - 1)) * 100}%`,
                    }}
                    onPointerDown={(event) => {
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.currentTarget.focus();
                    }}
                    onPointerMove={(event) => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const bounds = crop.current!.getBoundingClientRect();
                      move(
                        index,
                        ((event.clientX - bounds.left) / bounds.width) * (capture.image.width - 1),
                        ((event.clientY - bounds.top) / bounds.height) * (capture.image.height - 1),
                      );
                    }}
                    onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
                    onKeyDown={(event) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                      event.preventDefault();
                      const step = event.shiftKey ? 20 : 2;
                      move(
                        index,
                        point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
                        point.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
                      );
                    }}
                  />
                ))}
              </div>
              <div className="rio-scan-picker__actions">
                <div>
                  <label htmlFor={modeId}>{t({ id: 'files.scan.mode', message: 'Scan mode' })}</label>
                  <select
                    id={modeId}
                    value={mode}
                    onChange={(event) => setMode(event.target.value as 'color' | 'bw')}
                  >
                    <option value="color">{t({ id: 'files.scan.color', message: 'Color' })}</option>
                    <option value="bw">{t({ id: 'files.scan.bw', message: 'Black and white' })}</option>
                  </select>
                </div>
                <Button
                  onPress={() => {
                    setCapture(undefined);
                    setCorners(undefined);
                  }}
                >
                  {t({ id: 'files.scan.retake', message: 'Retake page' })}
                </Button>
                <Button variant="primary" onPress={addPage}>
                  {t({ id: 'files.scan.addPage', message: 'Keep page' })}
                </Button>
              </div>
            </>
          )}
          {pages.length > 0 && (
            <ol
              className="rio-scan-picker__pages"
              aria-label={t({ id: 'files.scan.pages', message: 'Scanned pages' })}
            >
              {pages.map((page, index) => {
                const number = index + 1;
                return (
                  <li key={page.id}>
                    <img
                      src={page.image}
                      alt={t({ id: 'files.scan.pageNumber', message: `Page ${number}` })}
                    />
                    <div className="rio-scan-picker__actions">
                      <Button
                        isDisabled={!index || busy}
                        onPress={() => reorder(index, -1)}
                        aria-label={t({ id: 'files.scan.moveUp', message: `Move page ${number} earlier` })}
                      >
                        {t({ id: 'files.scan.earlier', message: 'Earlier' })}
                      </Button>
                      <Button
                        isDisabled={index === pages.length - 1 || busy}
                        onPress={() => reorder(index, 1)}
                        aria-label={t({ id: 'files.scan.moveDown', message: `Move page ${number} later` })}
                      >
                        {t({ id: 'files.scan.later', message: 'Later' })}
                      </Button>
                      <Button
                        isDisabled={busy}
                        onPress={() =>
                          setPages((previous) => previous.filter((entry) => entry.id !== page.id))
                        }
                        aria-label={t({ id: 'files.scan.deletePage', message: `Delete page ${number}` })}
                        icon={faTrashCan}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p role="status">{t({ id: 'files.scan.limit', message: 'Keep up to 30 pages in one PDF.' })}</p>
        </DialogBody>
        <DialogFooter>
          <Button isDisabled={busy} onPress={onClose}>
            {t({ id: 'files.cancel', message: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            isDisabled={!pages.length || !!capture || busy}
            isPending={busy}
            onPress={() => void save()}
          >
            {t({ id: 'files.scan.save', message: 'Save PDF' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
