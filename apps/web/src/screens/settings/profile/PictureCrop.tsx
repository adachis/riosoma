import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';

/** Keyboard-operable position and zoom controls avoid making a pointer drag the only crop path. */
export function PictureCrop({
  file,
  onClose,
  onCrop,
}: {
  file: File;
  onClose(): void;
  onCrop(value: string): void;
}) {
  const { t } = useLingui();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement>();
  const [x, setX] = useState(50);
  const [y, setY] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const source = new Image();
    let active = true;
    source.onload = () => {
      if (active) setImage(source);
    };
    source.onerror = () => {
      if (active) setError(true);
    };
    source.src = url;
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!image || !context) return;
    const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
    context.clearRect(0, 0, 256, 256);
    context.drawImage(
      image,
      ((image.naturalWidth - side) * x) / 100,
      ((image.naturalHeight - side) * y) / 100,
      side,
      side,
      0,
      0,
      256,
      256,
    );
  }, [image, x, y, zoom]);
  return (
    <Modal
      isOpen
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'profile.crop.title', message: 'Crop your picture' })}</DialogTitle>
        <DialogBody>
          <canvas
            ref={canvas}
            width={256}
            height={256}
            className="rio-profile__crop"
            role="img"
            aria-label={t({ id: 'profile.crop.preview', message: 'Square picture preview' })}
          />
          <label>
            {t({ id: 'profile.crop.horizontal', message: 'Horizontal position' })}
            <input
              type="range"
              min={0}
              max={100}
              value={x}
              onChange={(event) => setX(Number(event.target.value))}
            />
          </label>
          <label>
            {t({ id: 'profile.crop.vertical', message: 'Vertical position' })}
            <input
              type="range"
              min={0}
              max={100}
              value={y}
              onChange={(event) => setY(Number(event.target.value))}
            />
          </label>
          <label>
            {t({ id: 'profile.crop.zoom', message: 'Zoom' })}
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
          {error ? (
            <p role="alert">
              {t({
                id: 'profile.picture.invalid',
                message:
                  'Choose a square PNG, JPEG, or WebP picture under 2 MB that your installation accepts.',
              })}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose}>{t({ id: 'ui.confirm.cancel', message: 'Cancel' })}</Button>
          <Button
            variant="primary"
            isDisabled={!image || error}
            onPress={() => {
              if (canvas.current) onCrop(canvas.current.toDataURL('image/png'));
            }}
          >
            {t({ id: 'profile.crop.use', message: 'Use picture' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
