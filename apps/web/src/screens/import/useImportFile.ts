import { useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { DocumentColumnType } from '@riosoma/contracts';
import { ApiError } from '../../api';
import { serverMessage } from '../../messages/useServerMessage';
import type { ImportSource } from './source';
import { isSpreadsheet, uploadSpreadsheet, type SheetSource, type Workbook } from './spreadsheet';

export interface ImportFile {
  file?: File;
  /** A spreadsheet's sheets that have rows, in tab order, or none for a CSV file */
  sheets: SheetSource[];
  /** The chosen sheet's place in `sheets` */
  sheet: number;
  setSheet(index: number): void;
  /** Where the rows come from once the file has been read: the CSV file, or the chosen sheet */
  source?: ImportSource;
  /** The server is reading a spreadsheet */
  loading: boolean;
  error?: string;
  choose(file?: File, types?: DocumentColumnType[]): void;
  suggestedTypes?: DocumentColumnType[];
}

class EmptyWorkbook extends Error {}

/**
 * The file someone picked.  A CSV file is read here in the browser, and a spreadsheet goes to
 * the server, which answers its sheets.
 */
export function useImportFile(): ImportFile {
  const { t, i18n } = useLingui();
  const [file, setFile] = useState<File>();
  const [suggestedTypes, setSuggestedTypes] = useState<DocumentColumnType[]>();
  const [workbook, setWorkbook] = useState<Workbook>();
  const [csv, setCsv] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  function choose(next?: File, types?: DocumentColumnType[]) {
    if (!next) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setFile(next);
    setSuggestedTypes(types);
    setWorkbook(undefined);
    setCsv(false);
    setSheet(0);
    setError(undefined);
    setLoading(true);
    void (async () => {
      try {
        if (!(await isSpreadsheet(next))) {
          if (!controller.signal.aborted) setCsv(true);
          return;
        }
        const book = await uploadSpreadsheet(next, controller.signal);
        if (controller.signal.aborted) return;
        if (!book.sheets.some((item) => item.sent > 0)) throw new EmptyWorkbook();
        setWorkbook(book);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof ApiError
            ? serverMessage(i18n, reason.info.messageKey, reason.info.params)
            : reason instanceof EmptyWorkbook
              ? t({ id: 'import.spreadsheet.empty', message: 'This spreadsheet has no rows to import.' })
              : t({ id: 'import.fileUnreadable', message: 'This file couldn’t be read.' }),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
  }

  const sheets = useMemo(() => workbook?.sheets.filter((item) => item.sent > 0) ?? [], [workbook]);
  const source = useMemo<ImportSource | undefined>(
    () => (csv && file ? { kind: 'csv', file } : sheets[sheet]),
    [csv, file, sheets, sheet],
  );
  return { file, sheets, sheet, setSheet, source, loading, error, choose, suggestedTypes };
}
