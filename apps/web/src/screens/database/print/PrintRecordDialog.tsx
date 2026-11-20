import type { ViewColors } from '../colors/paint';
import { useLingui } from '@lingui/react/macro';
import { cellValue, type FieldMeta, type RowData } from '@riosoma/contracts';
import { formatCell, type FormatContext } from '../../../grid/format';
import { recordDocument } from './document';
import { recordNames } from './load';
import { defaultOrientation, pdfFileName, recordFieldChoices } from './options';
import { PrintDialog } from './PrintDialog';

export interface PrintRecordDialogProps {
  databaseName: string;
  tableName: string;
  row: RowData;
  /** The fields the record card shows, in its order */
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  format: FormatContext;
  colors?: ViewColors;
  onClose(): void;
}

/** Printing one record, or saving it as a PDF: its fields as labels and values. */
export function PrintRecordDialog({
  databaseName,
  tableName,
  row,
  fields,
  primaryFieldId,
  format,
  colors,
  onClose,
}: PrintRecordDialogProps) {
  const { t, i18n } = useLingui();
  const primary = fields.find((field) => field.id === primaryFieldId);
  const name =
    (primary ? formatCell(primary, cellValue(row, primary), format).trim() : '') ||
    t({ id: 'record.untitled', message: 'Untitled record' });
  return (
    <PrintDialog
      kind="record"
      defaultTitle={name}
      defaultOrientation={defaultOrientation('record')}
      choices={recordFieldChoices(fields, primaryFieldId)}
      primaryFieldId={primaryFieldId}
      fileName={(title) => pdfFileName(tableName, title, name)}
      make={async (settings, { signal }) => {
        const names = await recordNames(row, settings.fields, format, signal);
        if (signal.aborted) return null;
        return recordDocument(row, settings, {
          i18n,
          colors,
          format: {
            ...format,
            linked: new Map([...(format.linked ?? []), ...names.linked]),
            attachments: new Map([...(format.attachments ?? []), ...names.attachments]),
          },
          databaseName,
          sourceName: tableName,
          printedAt: new Date(),
        });
      }}
      onClose={onClose}
    />
  );
}
