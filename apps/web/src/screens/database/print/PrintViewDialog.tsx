import { useLingui } from '@lingui/react/macro';
import type { AttachmentMeta, FieldMeta, TableMeta, ViewMeta } from '@riosoma/contracts';
import type { FormatContext } from '../../../grid/format';
import { viewDocument, type ViewSource } from './document';
import { loadViewRecords } from './load';
import { defaultOrientation, isPrintableViewType, pdfFileName, viewFieldChoices } from './options';
import { PrintDialog } from './PrintDialog';

export interface PrintViewDialogProps {
  databaseName: string;
  table: TableMeta;
  /** The view with its current configuration */
  view: ViewMeta;
  /** Every field of the table, in the table's order */
  fields: readonly FieldMeta[];
  format: FormatContext;
  onClose(): void;
}

function merged<T>(
  known: ReadonlyMap<string, T> | undefined,
  loaded: ReadonlyMap<string, T>,
): Map<string, T> {
  return new Map([...(known ?? []), ...loaded]);
}

/** Printing a grid, gallery, or kanban view, or saving it as a PDF. */
export function PrintViewDialog({
  databaseName,
  table,
  view,
  fields,
  format,
  onClose,
}: PrintViewDialogProps) {
  const { i18n } = useLingui();
  if (!isPrintableViewType(view.type)) return null;
  const source: ViewSource = {
    type: view.type,
    config: view.config,
    primaryFieldId: table.primaryFieldId,
    tableFields: fields,
  };
  return (
    <PrintDialog
      kind="view"
      defaultTitle={view.name}
      defaultOrientation={defaultOrientation(view.type)}
      choices={viewFieldChoices(view.config, fields, table.primaryFieldId)}
      primaryFieldId={table.primaryFieldId}
      fileName={(title) => pdfFileName(table.name, title, view.name)}
      make={async (settings, controls) => {
        const loaded = await loadViewRecords({ viewId: view.id, timeZone: format.timeZone, ...controls });
        if (!loaded) return null;
        return viewDocument(
          loaded.rows,
          settings,
          { ...source, groups: loaded.groups },
          {
            i18n,
            // The pages' own names come first, since they were read just now.
            format: {
              ...format,
              linked: merged(format.linked, loaded.linked),
              attachments: merged<AttachmentMeta>(format.attachments, loaded.attachments),
            },
            databaseName,
            sourceName: view.name,
            printedAt: new Date(),
          },
        );
      }}
      onClose={onClose}
    />
  );
}
