import {
  faCamera,
  faCloud,
  faDesktop,
  faLink,
  faMagnifyingGlass,
  faFilePdf,
  faEllipsis,
} from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { CLOUD_PROVIDERS, type CloudProvider, type ProviderConnection } from '@riosoma/contracts';
import { Banner, Button, Menu, MenuItem, MenuTrigger } from '@riosoma/ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { connectionStore, type RemotePick } from './api';
import { CameraCapture } from './CameraCapture';
import { cameraSupport, screenSupport } from './capture';
import { useProviderNames } from './ConnectPrompt';
import { DrivePicker } from './DrivePicker';
import { GooglePicker } from './GooglePicker';
import { grabScreen, ScreenCrop } from './ScreenCapture';
import { UrlPicker } from './UrlPicker';
import { ImageSearchPicker } from './ImageSearchPicker';
import { DocumentScanner } from './DocumentScanner';
import './pickers.css';

type Source = CloudProvider | 'camera' | 'screen' | 'url' | 'images' | 'scan';

/**
 * Drives and direct capture depend on the configured services and browser capabilities.
 * Scanning always offers a photo input, and image search explains organization restrictions.
 */
export function AddFromMenu({
  locale,
  isDisabled,
  onFiles,
  onPicks,
  onUrl,
  fieldId,
  tableId,
  recordId,
  onSourceNavigate,
}: {
  locale: string;
  isDisabled?: boolean;
  onFiles(files: File[]): void;
  onPicks(picks: RemotePick[]): void;
  onUrl?(url: string, filename?: string, imageSearchToken?: string): Promise<void>;
  tableId?: string;
  fieldId?: string;
  recordId?: string;
  onSourceNavigate?(): void;
}) {
  const { t } = useLingui();
  const names = useProviderNames();
  const view = useSyncExternalStore(connectionStore.subscribe, connectionStore.snapshot);
  useEffect(() => {
    void connectionStore.load();
  }, []);
  const [open, setOpen] = useState<Source | null>(null);
  const [capture, setCapture] = useState<HTMLCanvasElement | null>(null);
  const [screenFailed, setScreenFailed] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const [support] = useState(() => ({ camera: cameraSupport(), screen: screenSupport() }));
  const router = useRouter({ warn: false });
  const linkedSource = useSyncExternalStore(
    (listen) => router?.subscribe('onResolved', listen) ?? (() => {}),
    () =>
      fieldId &&
      recordId &&
      router?.state.location.search.fileSource === fieldId &&
      router.state.location.search.fileRecord === recordId
        ? (router?.state.location.search.filePicker ?? 'url')
        : null,
  );
  const linked = linkedSource !== null;
  const [linkedOpen, setLinkedOpen] = useState(false);
  useEffect(() => {
    // A linked picker mounts after its record modal so focus and Escape reach the top dialog.
    const frame = requestAnimationFrame(() => setLinkedOpen(linked));
    return () => cancelAnimationFrame(frame);
  }, [linked]);

  const drives = (view?.providers ?? [])
    .filter(
      (entry): entry is ProviderConnection & { provider: CloudProvider } =>
        entry.available && (CLOUD_PROVIDERS as readonly string[]).includes(entry.provider),
    )
    .map((entry) => entry.provider);
  const items: Array<{ id: Source; label: string; icon: typeof faCloud }> = [
    ...(onUrl
      ? [
          {
            id: 'url' as const,
            label: t({ id: 'files.url.title', message: 'From a web address' }),
            icon: faLink,
          },
        ]
      : []),
    ...(onUrl && tableId && fieldId && recordId
      ? [
          {
            id: 'images' as const,
            label: t({ id: 'files.search.title', message: 'Image search' }),
            icon: faMagnifyingGlass,
          },
        ]
      : []),
    ...(tableId && fieldId && recordId
      ? [
          {
            id: 'scan' as const,
            label: t({ id: 'files.scan.title', message: 'Scan documents' }),
            icon: faFilePdf,
          },
        ]
      : []),
    ...drives.map((provider) => ({
      id: provider,
      label: t({ id: 'files.addFrom.drive', message: `From ${names[provider]}` }),
      icon: faCloud,
    })),
    ...(support.camera
      ? [
          {
            id: 'camera' as const,
            label: t({ id: 'files.addFrom.camera', message: 'Take photo' }),
            icon: faCamera,
          },
        ]
      : []),
    ...(support.screen
      ? [
          {
            id: 'screen' as const,
            label: t({ id: 'files.addFrom.screen', message: 'Capture screen' }),
            icon: faDesktop,
          },
        ]
      : []),
  ];
  if (!items.length) return null;

  function choose(source: Source) {
    setScreenFailed(false);
    if (['url', 'images', 'scan'].includes(source) && router && fieldId && recordId) {
      const path = router.state.location.pathname;
      const view = /^\/db[0-9A-Za-z]{14}\/tbl[0-9A-Za-z]{14}\/viw[0-9A-Za-z]{14}/.exec(path)?.[0];
      // The record panel owns linked pickers after a grid editor transfers its destination.
      onSourceNavigate?.();
      void router.navigate({
        to: view && (onSourceNavigate || path === view) ? `${view}/${recordId}` : path,
        search: (previous) => ({
          ...previous,
          fileSource: fieldId,
          fileRecord: recordId,
          filePicker: source as 'url' | 'images' | 'scan',
        }),
      });
      return;
    }
    if (source === 'camera' && support.camera === 'input') return camera.current?.click();
    if (source === 'screen') {
      // The browser asks which screen to share, and only from the person's own press.
      grabScreen().then(setCapture, (error: unknown) => {
        // Declining the browser's prompt isn't a failure worth a message.
        if (!(error instanceof DOMException && error.name === 'NotAllowedError')) setScreenFailed(true);
      });
      return;
    }
    setOpen(source);
  }

  const close = () => {
    setOpen(null);
    if (linked)
      void router.navigate({
        to: '.',
        replace: true,
        search: (previous) => ({
          ...previous,
          fileSource: undefined,
          fileRecord: undefined,
          filePicker: undefined,
        }),
      });
  };
  return (
    <>
      <MenuTrigger>
        <Button
          className="rio-files__add-from"
          icon={faEllipsis}
          isDisabled={isDisabled}
          aria-label={t({ id: 'files.addFrom', message: 'More ways to add' })}
        />
        <Menu
          className="rio-files__source-menu"
          aria-label={t({ id: 'files.addFrom.label', message: 'Ways to add files' })}
          onAction={(key) => choose(key as Source)}
        >
          {items.map((item) => (
            <MenuItem key={item.id} id={item.id} icon={item.icon}>
              {item.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      {support.camera === 'input' && (
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          aria-label={t({ id: 'files.addFrom.camera', message: 'Take photo' })}
          onChange={(event) => {
            if (event.target.files?.length) onFiles(Array.from(event.target.files));
            event.target.value = '';
          }}
        />
      )}
      {screenFailed && (
        <Banner tone="danger" onDismiss={() => setScreenFailed(false)}>
          {t({ id: 'files.screen.failed', message: 'The screen capture didn’t work.  Try again.' })}
        </Banner>
      )}
      {(open === 'dropbox' || open === 'box') && (
        <DrivePicker provider={open} locale={locale} onPick={onPicks} onClose={close} />
      )}
      {open === 'google' && <GooglePicker locale={locale} onPick={onPicks} onClose={close} />}
      {open === 'camera' && <CameraCapture onCapture={(file) => onFiles([file])} onClose={close} />}
      {(open === 'url' || (linked && linkedOpen && linkedSource === 'url')) && onUrl && (
        <UrlPicker onAdd={onUrl} onClose={close} />
      )}
      {(open === 'images' || (linked && linkedOpen && linkedSource === 'images')) &&
        onUrl &&
        tableId &&
        fieldId &&
        recordId && (
          <ImageSearchPicker target={{ tableId, fieldId, recordId }} onAdd={onUrl} onClose={close} />
        )}
      {(open === 'scan' || (linked && linkedOpen && linkedSource === 'scan')) && (
        <DocumentScanner onFiles={onFiles} onClose={close} />
      )}
      {capture && (
        <ScreenCrop
          capture={capture}
          onCapture={(file) => onFiles([file])}
          onClose={() => setCapture(null)}
        />
      )}
    </>
  );
}
