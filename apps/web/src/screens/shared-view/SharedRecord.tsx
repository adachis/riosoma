import { useLingui } from '@lingui/react/macro';
import {
  cellValue,
  idsOf,
  visibleFieldIds,
  type AttachmentMeta,
  type FieldMeta,
  type RowData,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import { Dialog, DialogBody, DialogTitle, Modal } from '@riosoma/ui';
import { formatCell, type FormatContext } from '../../grid/format';
import { CardValue } from '../database/views/CardValue';
import { RichTextView } from '../../fields/richText/lazy';

export interface SharedRecordProps {
  row: RowData;
  table: TableMeta;
  view: ViewMeta;
  fields: readonly FieldMeta[];
  format: FormatContext;
  attachment(id: string): AttachmentMeta | undefined;
  onClose(): void;
}

/** One record of a shared view, read-only: every field the view shows, with nothing to change. */
export function SharedRecord({ row, table, view, fields, format, attachment, onClose }: SharedRecordProps) {
  const { t } = useLingui();
  const shown = visibleFieldIds(view.config, fields, table.primaryFieldId).flatMap(
    (id) => fields.find((field) => field.id === id) ?? [],
  );
  const primary = fields.find((field) => field.id === table.primaryFieldId);
  const title =
    (primary && formatCell(primary, cellValue(row, primary), format)) ||
    t({ id: 'shareView.record.untitled', message: 'Untitled record' });
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{title}</DialogTitle>
        <DialogBody>
          <dl className="rio-shared-view__record">
            {shown.map((field) => (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd>
                  <RecordValue field={field} row={row} format={format} attachment={attachment} />
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

function RecordValue({
  field,
  row,
  format,
  attachment,
}: {
  field: FieldMeta;
  row: RowData;
  format: FormatContext;
  attachment(id: string): AttachmentMeta | undefined;
}) {
  const value = cellValue(row, field);
  if (field.type === 'attachment') {
    const files = idsOf(value).flatMap((id) => attachment(id) ?? []);
    return (
      <ul className="rio-shared-view__files">
        {files.map((file) => (
          <li key={file.id}>
            <a href={file.url} target="_blank" rel="noopener noreferrer">
              {file.type.startsWith('image/') && file.thumbnails.small ? (
                <img src={file.thumbnails.small} alt="" />
              ) : null}
              <span>{file.name}</span>
            </a>
          </li>
        ))}
      </ul>
    );
  }
  if (field.type === 'longText')
    return field.options.richText && typeof value === 'string' ? (
      <RichTextView value={value} />
    ) : (
      <span className="rio-shared-view__long">{formatCell(field, value, format)}</span>
    );
  return <CardValue field={field} value={value} format={format} />;
}
