import { useLingui } from '@lingui/react/macro';
import type { DashboardFilters, FilterGroup, Tile } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { FilterEditor } from '../view/FilterEditor';

/** Personal read conditions stay separate from the dashboard's saved tile definitions. */
export function DashboardFilterDialog({
  session,
  schema,
  tiles,
  filters,
  onChange,
  onClose,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  tiles: readonly Tile[];
  filters: DashboardFilters;
  onChange(filters: DashboardFilters): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const tableIds = new Set(tiles.flatMap((tile) => (tile.kind === 'text' ? [] : [tile.source.tableId])));
  const tables = schema.tables.filter((table) => tableIds.has(table.id));
  const change = (tableId: string, filter: FilterGroup | null) => {
    // Conditions for a table the viewer cannot currently see retain their stored values.
    const others = filters.filter((item) => item.tableId !== tableId);
    onChange(filter ? [...others, { tableId, filter }] : others);
  };
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      className="rio-dashboard-editor"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog hideCloseButton>
        <DialogTitle>{t({ id: 'dashboards.filters', message: 'Dashboard filters' })}</DialogTitle>
        <DialogBody>
          <div className="rio-dashboard-editor__fields">
            <p>
              {t({
                id: 'dashboards.filters.description',
                message:
                  'Conditions apply to every tile using this table.  Date conditions set the dashboard’s date range.',
              })}
            </p>
            {tables.map((table) => (
              <fieldset key={table.id} className="rio-dashboard-editor__filter">
                <legend>{table.name}</legend>
                <FilterEditor
                  session={session}
                  fields={schema.fields.get(table.id) ?? []}
                  primaryFieldId={table.primaryFieldId}
                  collaborators={schema.collaborators}
                  value={filters.find((item) => item.tableId === table.id)?.filter ?? null}
                  onChange={(filter) => change(table.id, filter)}
                />
              </fieldset>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onPress={onClose}>
            {t({ id: 'ui.dialog.close', message: 'Close' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
