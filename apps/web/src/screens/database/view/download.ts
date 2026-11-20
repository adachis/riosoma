import { useCallback, useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { DeckLayout, ExportFormat } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { ApiError, apiFile } from '../../../api';
import { serverMessage } from '../../../messages/useServerMessage';

/**
 * Downloading a view as a file.  The server builds the file and names it, so all the app does is
 * ask in the reader's own language and time zone, then hand the bytes to the browser under the
 * name the reply carries.  A Word document or a deck asks for a title first, and a deck for its
 * layout, so choosing one opens a dialog rather than downloading straight away.
 */

export const downloadLabels = {
  csv: msg({ id: 'export.csv', message: 'Download CSV' }),
  xlsx: msg({ id: 'export.xlsx', message: 'Download Excel' }),
  docx: msg({ id: 'export.docx', message: 'Word document' }),
  pptx: msg({ id: 'export.pptx', message: 'PowerPoint deck' }),
} satisfies Record<ExportFormat, MessageDescriptor>;

const pendingLabel = msg({ id: 'export.pending', message: 'Preparing the file…' });
const failedLabel = msg({ id: 'export.failed', message: 'The download didn’t work.  Try again.' });

/** The formats made for reading, which take a title and, for a deck, a layout */
export type OfficeFormat = Extract<ExportFormat, 'docx' | 'pptx'>;

export function isOfficeFormat(format: ExportFormat): format is OfficeFormat {
  return format === 'docx' || format === 'pptx';
}

/** What a Word document or deck is made with, from its dialog. */
export interface OfficeChoices {
  title: string;
  layout?: DeckLayout;
}

/** What a download is doing, so every menu that offers one can show it and refuse a second. */
export interface DownloadState {
  viewId: string;
  format: ExportFormat;
}

export interface ViewDownload {
  pending: DownloadState | null;
  /** A Word document or deck waiting on its dialog */
  choosing: { viewId: string; format: OfficeFormat } | null;
  /** Downloads a CSV or Excel file, or opens the dialog for a Word document or deck. */
  download(viewId: string, format: ExportFormat): void;
  /** Downloads the Word document or deck the dialog asked for. */
  start(viewId: string, format: OfficeFormat, choices: OfficeChoices): void;
  /** Closes the dialog without downloading anything. */
  cancel(): void;
  labels: { csv: string; xlsx: string; docx: string; pptx: string };
}

export interface ExportExtras {
  where?: string;
  title?: string;
  layout?: DeckLayout;
  accent?: string;
}

/** The download URL, carrying the reader's time zone and language so values read as they do here. */
export function exportUrl(
  viewId: string,
  format: ExportFormat,
  timeZone: string,
  locale: string,
  extras: ExportExtras = {},
): string {
  const query = new URLSearchParams({ format, timeZone, locale });
  if (extras.title) query.set('title', extras.title);
  if (extras.layout) query.set('layout', extras.layout);
  if (extras.accent) query.set('accent', extras.accent);
  if (extras.where !== undefined) query.set('where', extras.where);
  return `/api/views/${encodeURIComponent(viewId)}/export?${query.toString()}`;
}

/** Two hexadecimal digits for a color channel */
const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

/**
 * The theme's accent as six hexadecimal digits, for a deck's titles, or undefined when the page
 * can't say.  A theme may write it in any color syntax, so anything but hex is drawn on a canvas
 * and read back as the red, green, and blue it came to.
 */
export function themeAccent(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--rio-accent').trim();
  if (!value) return undefined;
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) return long[1]!.toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short)
    return short
      .slice(1, 4)
      .map((digit) => `${digit}${digit}`)
      .join('')
      .toLowerCase();
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return `${hex(red ?? 0)}${hex(green ?? 0)}${hex(blue ?? 0)}`;
  } catch {
    return undefined;
  }
}

/** Hands a file to the browser under its own name; nothing is uploaded and no page navigates. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // A browser can still be reading the file when the click returns, so the address outlives it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Downloads a view and saves it.  One download at a time: a second one would race the first for
 * the same notice, and a long export is worth waiting for rather than starting twice.
 */
export function useViewDownload(scope?: { viewId: string; where: string }): ViewDownload {
  const { i18n } = useLingui();
  const [pending, setPending] = useState<DownloadState | null>(null);
  const [choosing, setChoosing] = useState<ViewDownload['choosing']>(null);
  const busy = useRef(false);
  const notice = useRef<string | null>(null);
  const scopedViewId = scope?.viewId;
  const where = scope?.where;

  // A download outlives the menu that started it, so its notice goes when the screen does.
  useEffect(
    () => () => {
      if (notice.current === null) return;
      toast.dismiss(notice.current);
      notice.current = null;
    },
    [],
  );

  const fetchFile = useCallback(
    (viewId: string, format: ExportFormat, extras: ExportExtras = {}) => {
      if (busy.current) return;
      busy.current = true;
      setPending({ viewId, format });
      notice.current = toast.show({ title: i18n._(pendingLabel), tone: 'info', timeout: 0 });
      const locale = i18n.locale || 'en-US';
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      void apiFile(
        exportUrl(viewId, format, timeZone, locale, {
          ...extras,
          ...(viewId === scopedViewId && where !== undefined ? { where } : {}),
        }),
      )
        .then((file) => {
          // A reply without a name is a proxy's doing; the view and format still name a file.
          saveFile(file.blob, file.filename ?? `${viewId}.${format}`);
        })
        .catch((error: unknown) => {
          const info = error instanceof ApiError ? error.info : undefined;
          toast.show({
            tone: 'danger',
            title: i18n._(failedLabel),
            description: serverMessage(i18n, info?.messageKey ?? 'errors.internal', info?.params),
          });
        })
        .finally(() => {
          if (notice.current !== null) toast.dismiss(notice.current);
          notice.current = null;
          busy.current = false;
          setPending(null);
        });
    },
    [i18n, scopedViewId, where],
  );

  const download = useCallback(
    (viewId: string, format: ExportFormat) => {
      if (busy.current) return;
      if (isOfficeFormat(format)) setChoosing({ viewId, format });
      else fetchFile(viewId, format);
    },
    [fetchFile],
  );

  const start = useCallback(
    (viewId: string, format: OfficeFormat, choices: OfficeChoices) => {
      setChoosing(null);
      const accent = format === 'pptx' ? themeAccent() : undefined;
      const title = choices.title.trim();
      fetchFile(viewId, format, {
        ...(title ? { title } : {}),
        ...(format === 'pptx' && choices.layout ? { layout: choices.layout } : {}),
        ...(accent ? { accent } : {}),
      });
    },
    [fetchFile],
  );

  const cancel = useCallback(() => setChoosing(null), []);

  return {
    pending,
    choosing,
    download,
    start,
    cancel,
    labels: {
      csv: i18n._(downloadLabels.csv),
      xlsx: i18n._(downloadLabels.xlsx),
      docx: i18n._(downloadLabels.docx),
      pptx: i18n._(downloadLabels.pptx),
    },
  };
}
