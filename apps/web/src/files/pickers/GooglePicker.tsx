import { trustedScriptURL } from '../../security/trusted-script-url';
import { useLingui } from '@lingui/react/macro';
import type { DriveExportFormat } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
} from '@riosoma/ui';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { connectionStore, googlePickerConfig, type RemotePick } from './api';
import { ConnectPrompt, useConnection, useProviderNames } from './ConnectPrompt';

/** Google's own file types, which have no bytes of their own, and the Office format each becomes. */
export const GOOGLE_OFFICE: Record<string, DriveExportFormat | null> = {
  'application/vnd.google-apps.document': 'docx',
  'application/vnd.google-apps.spreadsheet': 'xlsx',
  'application/vnd.google-apps.presentation': 'pptx',
  'application/vnd.google-apps.drawing': null,
};

/** A file Google's Picker handed back. */
export interface GoogleDocument {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number | string;
}

const SCRIPT = 'https://apis.google.com/js/api.js';
let scriptLoading: Promise<void> | null = null;

/** Loads Google's script once, and only when someone first opens the Picker. */
function loadScript(): Promise<void> {
  scriptLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = trustedScriptURL(SCRIPT);
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoading = null;
      script.remove();
      reject(new Error('Google’s script didn’t load'));
    };
    document.head.append(script);
  });
  return scriptLoading;
}

interface PickerData {
  action?: string;
  docs?: GoogleDocument[];
}

/* The parts of Google's Picker used here, which Google's script puts on `window`. */
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setLocale(locale: string): PickerBuilder;
  setCallback(callback: (data: PickerData) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void; dispose(): void };
}
interface GooglePickerApi {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new () => {
    setIncludeFolders(on: boolean): unknown;
    setSelectFolderEnabled(on: boolean): unknown;
  };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
}
declare global {
  interface Window {
    gapi?: { load(name: string, options: { callback(): void; onerror(): void }): void };
    google?: { picker?: GooglePickerApi };
  }
}

/** Opens Google's Picker and answers with what the person picked, or null when they canceled. */
async function openGooglePicker(locale: string): Promise<GoogleDocument[] | null> {
  const config = await googlePickerConfig();
  await loadScript();
  await new Promise<void>((resolve, reject) =>
    window.gapi!.load('picker', { callback: resolve, onerror: () => reject(new Error('picker')) }),
  );
  const picker = window.google!.picker!;
  const view = new picker.DocsView();
  view.setIncludeFolders(true);
  view.setSelectFolderEnabled(false);
  return new Promise((resolve) => {
    const built = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(window.location.origin)
      .setLocale(locale)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          built.dispose();
          resolve(data.docs ?? []);
        } else if (data.action === picker.Action.CANCEL) {
          built.dispose();
          resolve(null);
        }
      })
      .build();
    built.setVisible(true);
  });
}

/** Turns the Picker's files into picks, exporting Google's own types as the person chose. */
export function picksFrom(documents: readonly GoogleDocument[], format: 'pdf' | 'office'): RemotePick[] {
  return documents.map((document) => {
    const google = document.mimeType in GOOGLE_OFFICE;
    const office = GOOGLE_OFFICE[document.mimeType];
    const size = Number(document.sizeBytes);
    return {
      provider: 'google',
      fileId: document.id,
      name: document.name,
      size: !google && Number.isFinite(size) ? size : null,
      ...(google ? { exportAs: format === 'office' && office ? office : 'pdf' } : {}),
    };
  });
}

/**
 * Picking from Google Drive: connecting first when needed, then Google's own Picker, which loads
 * only now, and then, when Docs, Sheets, or Slides are among the picks, what to turn them into.
 */
export function GooglePicker({
  locale,
  onPick,
  onClose,
}: {
  locale: string;
  onPick(picks: RemotePick[]): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const name = useProviderNames().google;
  const { loaded, connection } = useConnection('google');
  const account = connection?.account;
  const connected = Boolean(account && !account.needsReconnect);
  // Connecting again gives the account a new date, which opens the Picker again.
  const attempt = connected ? (account?.connectedAt ?? '') : null;
  const [documents, setDocuments] = useState<GoogleDocument[] | null>(null);
  const [format, setFormat] = useState<'pdf' | 'office'>('pdf');
  const [failed, setFailed] = useState<{ attempt: string; key: string } | null>(null);
  const started = useRef<string | null>(null);
  const failure = failed && failed.attempt === attempt ? failed.key : null;

  useEffect(() => {
    if (!loaded || attempt === null || started.current === attempt) return;
    started.current = attempt;
    openGooglePicker(locale).then(
      (picked) => {
        if (!picked?.length) return onClose();
        if (!picked.some((document) => document.mimeType in GOOGLE_OFFICE)) {
          onPick(picksFrom(picked, 'pdf'));
          return onClose();
        }
        setDocuments(picked);
      },
      (error: unknown) => {
        const key = error instanceof ApiError ? error.info.messageKey : 'drives.picker.googleFailed';
        setFailed({ attempt, key });
        // The server marked the account for reconnecting, which the shared store should show too.
        if (key === 'drives.reconnect' || key === 'drives.notConnected') void connectionStore.load(true);
      },
    );
  }, [loaded, attempt, locale, onClose, onPick]);

  const needsAccount =
    loaded && (!connected || failure === 'drives.reconnect' || failure === 'drives.notConnected');
  // While Google's Picker is showing, it's the dialog, so nothing of Riosoma's covers it.
  if (loaded && !needsAccount && !documents && !failure) return null;
  return (
    <Modal isOpen isDismissable size="md" onOpenChange={(open) => !open && onClose()}>
      <Dialog>
        <DialogTitle>{t({ id: 'drives.picker.title', message: `Add from ${name}` })}</DialogTitle>
        <DialogBody>
          {!loaded ? (
            <Spinner aria-label={t({ id: 'drives.picker.loading', message: 'Loading' })} />
          ) : needsAccount ? (
            <ConnectPrompt provider="google" reconnect={Boolean(account)} />
          ) : failure ? (
            <Banner tone="danger">
              {failure === 'drives.picker.googleFailed'
                ? t({
                    id: 'drives.picker.googleFailed',
                    message: 'Google’s file picker didn’t open.  Check your connection and try again.',
                  })
                : message(failure)}
            </Banner>
          ) : (
            <RadioGroup
              label={t({ id: 'drives.format.label', message: 'Add Google Docs, Sheets, and Slides as' })}
              value={format}
              onChange={(value) => setFormat(value === 'office' ? 'office' : 'pdf')}
            >
              <Radio value="pdf">{t({ id: 'drives.format.pdf', message: 'PDF' })}</Radio>
              <Radio value="office">
                {t({ id: 'drives.format.office', message: 'Word, Excel, or PowerPoint file' })}
              </Radio>
            </RadioGroup>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose}>{t({ id: 'drives.picker.cancel', message: 'Cancel' })}</Button>
          {documents && !failure && (
            <Button
              variant="primary"
              onPress={() => {
                onPick(picksFrom(documents, format));
                onClose();
              }}
            >
              {t({ id: 'drives.picker.add', message: 'Add' })}
            </Button>
          )}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
