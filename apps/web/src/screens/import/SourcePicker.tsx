import { useLingui } from '@lingui/react/macro';
import { Banner, ListBoxItem, Select } from '@riosoma/ui';
import type { SheetSource } from './spreadsheet';
import { anchor } from '../../demos/anchors';
import { DocumentImport, type DocumentImportProps } from './DocumentImport';

/**
 * What the file picker offers: CSV and tab-separated files, and Excel workbooks.  Older `.xls`
 * workbooks are offered too, so choosing one explains how to save it as `.xlsx` instead of
 * leaving it grayed out.
 */
export const ACCEPTED_FILES = [
  '.csv',
  '.tsv',
  '.xlsx',
  '.xls',
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
].join(',');

export function FileChooser({ onChoose, databaseId, tableId, initialOpen }: DocumentImportProps) {
  const { t } = useLingui();
  const choose = t({ id: 'import.chooseFile', message: 'Choose a CSV or Excel file' });
  return (
    <>
      <DocumentImport
        initialOpen={initialOpen}
        onChoose={onChoose}
        databaseId={databaseId}
        tableId={tableId}
      />
      <div
        className="rio-import__drop"
        {...anchor('import.file')}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onChoose(event.dataTransfer.files[0]);
        }}
      >
        <p>{t({ id: 'import.dropFile', message: 'Drop a CSV or Excel file here' })}</p>
        <label>
          {choose}
          <input
            type="file"
            accept={ACCEPTED_FILES}
            onChange={(event) => onChoose(event.target.files?.[0])}
          />
        </label>
      </div>
    </>
  );
}

export interface SheetPickerProps {
  sheets: readonly SheetSource[];
  sheet: number;
  onSheet: (index: number) => void;
  disabled?: boolean;
}

/** Which sheet of a workbook to import, when it has more than one with rows. */
export function SheetPicker({ sheets, sheet, onSheet, disabled }: SheetPickerProps) {
  const { t } = useLingui();
  if (sheets.length < 2) return null;
  return (
    <Select
      label={t({ id: 'import.sheet', message: 'Sheet' })}
      selectedKey={String(sheet)}
      isDisabled={disabled}
      onSelectionChange={(key) => onSheet(Number(key))}
    >
      {sheets.map((item, index) => (
        <ListBoxItem key={index} id={String(index)}>
          {item.name}
        </ListBoxItem>
      ))}
    </Select>
  );
}

/** Says so when a sheet has more rows than can be imported. */
export function SheetLimits({ sheets }: { sheets: readonly SheetSource[] }) {
  const { t, i18n } = useLingui();
  const long = sheets.filter((item) => item.total > item.sent);
  if (!long.length) return null;
  return (
    <Banner tone="warning">
      {long.map((item) => {
        const name = item.name;
        const total = i18n.number(item.total);
        const sent = i18n.number(item.sent);
        return (
          <p key={item.name}>
            {t({
              id: 'import.sheet.capped',
              message: `${name} has ${total} rows.  Only the first ${sent} can be imported.`,
            })}
          </p>
        );
      })}
    </Banner>
  );
}
