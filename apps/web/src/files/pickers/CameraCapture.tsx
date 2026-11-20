import { useLingui } from '@lingui/react/macro';
import { Banner, Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { canvasFile, captureName, stopStream } from './capture';

/**
 * A computer's camera with a live preview and a shutter button.  The camera turns off as soon as
 * the photo is taken or the dialog closes.  Phones use their own camera app instead, through the
 * file input's `capture` attribute.
 */
export function CameraCapture({ onCapture, onClose }: { onCapture(file: File): void; onClose(): void }) {
  const { t } = useLingui();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((media) => {
        if (!live) return stopStream(media);
        stream.current = media;
        if (video.current) {
          video.current.srcObject = media;
          void video.current.play().catch(() => undefined);
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      stopStream(stream.current);
      stream.current = null;
    };
  }, []);

  async function shoot() {
    const element = video.current;
    if (!element?.videoWidth) return;
    setBusy(true);
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext('2d')?.drawImage(element, 0, 0);
    try {
      onCapture(
        await canvasFile(
          canvas,
          captureName(t({ id: 'files.camera.name', message: 'Photo' }), 'jpg'),
          'image/jpeg',
        ),
      );
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal isOpen isDismissable size="lg" onOpenChange={(open) => !open && onClose()}>
      <Dialog>
        <DialogTitle>{t({ id: 'files.camera.title', message: 'Take a photo' })}</DialogTitle>
        <DialogBody>
          {failed ? (
            <Banner tone="danger">
              {t({
                id: 'files.camera.failed',
                message: 'The camera didn’t start.  Check that this site may use it, then try again.',
              })}
            </Banner>
          ) : (
            <video
              ref={video}
              className="rio-capture__preview"
              aria-label={t({ id: 'files.camera.preview', message: 'Camera preview' })}
              playsInline
              muted
              onLoadedData={() => setReady(true)}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose}>{t({ id: 'files.camera.cancel', message: 'Cancel' })}</Button>
          <Button
            variant="primary"
            isDisabled={!ready || failed}
            isPending={busy}
            onPress={() => void shoot()}
          >
            {t({ id: 'files.camera.shutter', message: 'Take photo' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
