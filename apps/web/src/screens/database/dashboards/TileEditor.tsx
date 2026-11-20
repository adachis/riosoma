import { useState, type FormEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  CHART_TYPES,
  DATE_BUCKETS,
  LIMITS,
  PivotSettings,
  type Aggregate,
  type ChartType,
  type FieldMeta,
  type FilterGroup,
  type Tile,
  type TileSource,
  type TileValue,
  type ViewMeta,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  FilterableList,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Modal,
  NumberField,
  SegmentedControl,
  Select,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { PivotTileSettings } from './PivotTileSettings';
import { fieldsFor } from '../views/summary/fields';
import { FilterEditor } from '../view/FilterEditor';
import {
  aggregatesFor,
  groupFields,
  isDateField,
  isNumericField,
  recordFields,
  valueFields,
} from './aggregates';
import {
  AGGREGATE_LABELS,
  BUCKET_LABELS,
  CHART_LABELS,
  KIND_LABELS,
  SORT_LABELS,
  type ChartSort,
  type DateBucket,
  type TileKind,
} from './messages';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A tile's settings without where it sits, which the dashboard decides */
export type TileContent = DistributiveOmit<Tile, 'id' | 'place'>;

const NONE = '__none__';
const KINDS: readonly TileKind[] = ['number', 'chart', 'pivot', 'records', 'text'];
const SORTS: readonly ChartSort[] = ['category', 'valueDescending', 'valueAscending'];
const ROUND: ReadonlySet<ChartType> = new Set(['pie', 'donut']);
const STACKABLE: ReadonlySet<ChartType> = new Set(['bar', 'column', 'line', 'area']);
const MAX_RECORD_FIELDS = 10;

interface Draft {
  kind: TileKind;
  title: string;
  source: TileSource;
  value: TileValue;
  chart: ChartType;
  groupBy: string | null;
  dateBucket: DateBucket;
  seriesBy: string | null;
  sort: ChartSort;
  limit: number;
  stacked: boolean;
  fieldIds: string[];
  recordLimit: number;
  text: string;
  pivot: PivotSettings;
}

/**
 * Fields that sort records into a few groups make the best first axis: a single select, then a
 * date (grouped by month), then a linked record, before anything else.  The primary field names
 * each record, so it never groups.
 */
const GROUP_PREFERENCE: readonly FieldMeta['type'][] = [
  'singleSelect',
  'date',
  'createdTime',
  'lastModifiedTime',
  'link',
  'multipleSelect',
  'user',
  'checkbox',
];

function firstGroup(fields: readonly FieldMeta[], primaryFieldId?: string): string | null {
  const groups = groupFields(fields).filter((field) => field.id !== primaryFieldId);
  const rank = (field: FieldMeta) => {
    const index = GROUP_PREFERENCE.indexOf(field.type);
    return index < 0 ? GROUP_PREFERENCE.length : index;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b))[0]?.id ?? null;
}

/**
 * A chart or pivot view already holds a grouping and values, so a tile drawn from it starts from
 * those, not just the view's filter.  Other view types seed nothing.
 */
function viewSeed(view: ViewMeta | undefined): Partial<Draft> {
  if (view?.type === 'chart') {
    const chart = view.config.chart;
    return {
      kind: 'chart',
      chart: chart.chart,
      value: chart.value,
      seriesBy: chart.seriesBy,
      sort: chart.sort,
      stacked: chart.stacked,
      ...(chart.groupBy
        ? { groupBy: chart.groupBy.fieldId, dateBucket: chart.groupBy.dateBucket ?? 'month' }
        : {}),
    };
  }
  if (view?.type === 'pivot') return { kind: 'pivot', pivot: view.config.pivot };
  return {};
}

function initialDraft(tile: Tile | null, schema: SchemaState, defaultSource: TileSource | null): Draft {
  const start =
    tile && tile.kind !== 'text'
      ? tile.source
      : (defaultSource ?? { tableId: schema.tables[0]?.id ?? '', viewId: null, filter: null });
  const tableId = start.tableId;
  const fields = schema.fields.get(tableId) ?? [];
  const primaryFieldId = schema.tableById.get(tableId)?.primaryFieldId;
  const group = firstGroup(fields, primaryFieldId);
  const draft: Draft = {
    kind: tile?.kind ?? 'number',
    title: tile?.title ?? '',
    source: start,
    value:
      tile && (tile.kind === 'number' || tile.kind === 'chart') ? tile.value : { fn: 'count', fieldId: null },
    chart: 'column',
    groupBy: group,
    dateBucket: 'month',
    seriesBy: null,
    sort: 'category',
    limit: 20,
    stacked: false,
    fieldIds: [],
    recordLimit: 10,
    text: '',
    pivot:
      tile?.kind === 'pivot' ? tile.pivot : PivotSettings.parse({ rows: group ? [{ fieldId: group }] : [] }),
  };
  switch (tile?.kind) {
    case 'chart':
      return {
        ...draft,
        chart: tile.chart,
        groupBy: tile.groupBy.fieldId,
        dateBucket: tile.groupBy.dateBucket ?? 'day',
        seriesBy: tile.seriesBy,
        sort: tile.sort,
        limit: tile.limit,
        stacked: tile.stacked,
      };
    case 'records':
      return { ...draft, fieldIds: tile.fieldIds, recordLimit: tile.limit };
    case 'text':
      return { ...draft, text: tile.text };
    default:
      // A new tile that comes from a chart or pivot view carries over that view's own settings.
      return tile
        ? draft
        : { ...draft, ...viewSeed(start.viewId ? schema.viewById.get(start.viewId) : undefined) };
  }
}

/** The tile the draft describes, or null while a required choice is missing. */
function contentOf(draft: Draft, schema: SchemaState): TileContent | null {
  const title = draft.title.trim();
  if (draft.kind === 'text') return { kind: 'text', title, text: draft.text };
  const table = schema.tableById.get(draft.source.tableId);
  const view = draft.source.viewId ? schema.viewById.get(draft.source.viewId) : null;
  if (!table || (draft.source.viewId && view?.tableId !== table.id)) return null;
  const fields = schema.fields.get(table.id) ?? [];
  const field = (id: string | null) => (id ? fields.find((item) => item.id === id) : undefined);
  const valueFits =
    draft.value.fn === 'count' || aggregatesFor(field(draft.value.fieldId)).includes(draft.value.fn);
  const value: TileValue =
    draft.value.fn === 'count'
      ? { fn: 'count', fieldId: null }
      : { fn: draft.value.fn, fieldId: draft.value.fieldId };
  const source: TileSource = { tableId: table.id, viewId: draft.source.viewId, filter: draft.source.filter };
  switch (draft.kind) {
    case 'number':
      return valueFits ? { kind: 'number', title, source, value } : null;
    case 'pivot': {
      const pivot = draft.pivot;
      if (
        !pivot.rows.length ||
        pivot.rows.some((group) => !groupFields(fields).some((field) => field.id === group.fieldId)) ||
        (pivot.column && !groupFields(fields).some((field) => field.id === pivot.column?.fieldId)) ||
        pivot.values.some(
          (value) =>
            value.fn !== 'count' && !fieldsFor(value.fn, fields).some((field) => field.id === value.fieldId),
        )
      )
        return null;
      const ids = [
        ...pivot.rows.map((group) => group.fieldId),
        ...(pivot.column ? [pivot.column.fieldId] : []),
      ];
      if (new Set(ids).size !== ids.length) return null;
      return { kind: 'pivot', title, source, pivot };
    }
    case 'records':
      return {
        kind: 'records',
        title,
        source,
        fieldIds: draft.fieldIds.filter((id) => field(id)).slice(0, MAX_RECORD_FIELDS),
        limit: draft.recordLimit,
      };
    case 'chart': {
      const group = field(draft.groupBy);
      if (!group || !valueFits) return null;
      const round = ROUND.has(draft.chart);
      const seriesBy = round || !field(draft.seriesBy) || draft.seriesBy === group.id ? null : draft.seriesBy;
      return {
        kind: 'chart',
        title,
        source,
        chart: draft.chart,
        groupBy: { fieldId: group.id, dateBucket: isDateField(group) ? draft.dateBucket : null },
        value,
        seriesBy,
        sort: draft.sort,
        limit: draft.limit,
        stacked: Boolean(seriesBy) && STACKABLE.has(draft.chart) && draft.stacked,
      };
    }
  }
}

/** The best value for a newly chosen field: sums for numbers, unique counts for the rest. */
function valueForField(current: TileValue, field: FieldMeta | undefined): TileValue {
  if (!field) return { fn: 'count', fieldId: null };
  const fitting = aggregatesFor(field);
  if (current.fn !== 'count' && fitting.includes(current.fn)) return { fn: current.fn, fieldId: field.id };
  return { fn: isNumericField(field) ? 'sum' : 'countUnique', fieldId: field.id };
}

export interface TileEditorProps {
  session: DatabaseSession;
  schema: SchemaState;
  /** The tile to change, or null to add one */
  tile: Tile | null;
  /** Where a new tile starts: the table or view the person came from, or the last tile's table */
  defaultSource?: TileSource | null;
  onSave(content: TileContent): void;
  onCancel(): void;
}

/** Adds or changes a tile: its kind, title, where its records come from, and what it shows. */
export function TileEditor({
  session,
  schema,
  tile,
  defaultSource = null,
  onSave,
  onCancel,
}: TileEditorProps) {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState(() => initialDraft(tile, schema, defaultSource));
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const table = schema.tableById.get(draft.source.tableId);
  const fields = table ? (schema.fields.get(table.id) ?? []) : [];
  const views = table ? (schema.views.get(table.id) ?? []) : [];
  const content = contentOf(draft, schema);
  const valueField =
    draft.value.fn === 'count' ? undefined : fields.find((field) => field.id === draft.value.fieldId);
  const groupField = fields.find((field) => field.id === draft.groupBy);
  const round = ROUND.has(draft.chart);
  const chooseTable = (tableId: string) => {
    const next = schema.fields.get(tableId) ?? [];
    const group = firstGroup(next, schema.tableById.get(tableId)?.primaryFieldId);
    update({
      source: { tableId, viewId: null, filter: null },
      value: { fn: 'count', fieldId: null },
      groupBy: group,
      pivot: PivotSettings.parse({ rows: group ? [{ fieldId: group }] : [] }),
      seriesBy: null,
      fieldIds: [],
    });
  };
  const chooseView = (viewId: string | null) => {
    const view = viewId ? schema.viewById.get(viewId) : undefined;
    update({ source: { ...draft.source, viewId }, ...viewSeed(view) });
  };
  const fieldOption = (field: FieldMeta) => {
    const info = fieldTypeInfo(field.type);
    return (
      <ListBoxItem
        key={field.id}
        id={field.id}
        textValue={field.name}
        icon={info.icon}
        description={i18n._(info.name)}
      >
        {field.name}
      </ListBoxItem>
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (content) onSave(content);
  };
  const valueControls = (
    <>
      <Select
        label={t({ id: 'dashboards.tile.field', message: 'Field' })}
        selectedKey={valueField?.id ?? NONE}
        onSelectionChange={(key) =>
          update({
            value: valueForField(
              draft.value,
              fields.find((field) => field.id === key),
            ),
          })
        }
      >
        <ListBoxItem id={NONE}>
          {t({ id: 'dashboards.tile.noField', message: 'Just count records' })}
        </ListBoxItem>
        {valueFields(fields).map(fieldOption)}
      </Select>
      <Select
        label={t({ id: 'dashboards.tile.value', message: 'Value' })}
        selectedKey={draft.value.fn}
        onSelectionChange={(key) => {
          const fn = aggregatesFor(valueField).find((item) => item === key);
          if (fn) update({ value: { fn, fieldId: fn === 'count' ? null : (valueField?.id ?? null) } });
        }}
      >
        {aggregatesFor(valueField).map((fn: Aggregate) => (
          <ListBoxItem key={fn} id={fn}>
            {i18n._(AGGREGATE_LABELS[fn])}
          </ListBoxItem>
        ))}
      </Select>
    </>
  );
  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="rio-dashboard-editor"
    >
      <Dialog hideCloseButton>
        <DialogTitle>
          {tile
            ? t({ id: 'dashboards.editTile', message: 'Edit tile' })
            : t({ id: 'dashboards.addTile', message: 'Add a tile' })}
        </DialogTitle>
        <form className="rio-dashboard-editor__form" noValidate onSubmit={submit}>
          <DialogBody>
            <div className="rio-dashboard-editor__fields">
              <SegmentedControl
                label={t({ id: 'dashboards.tile.kind', message: 'Type' })}
                items={KINDS.map((kind) => ({ id: kind, label: i18n._(KIND_LABELS[kind]) }))}
                selectedId={draft.kind}
                onChange={(kind) => {
                  const next = KINDS.find((item) => item === kind);
                  if (next) update({ kind: next });
                }}
              />
              <TextField
                label={t({ id: 'dashboards.tile.title', message: 'Title' })}
                value={draft.title}
                maxLength={LIMITS.nameLength}
                onChange={(title) => update({ title })}
              />
              {draft.kind === 'text' ? (
                <TextArea
                  label={t({ id: 'dashboards.tile.note', message: 'Note' })}
                  value={draft.text}
                  rows={8}
                  maxLength={LIMITS.descriptionLength}
                  onChange={(text) => update({ text })}
                />
              ) : (
                <>
                  <div className="rio-dashboard-editor__row">
                    <Select
                      label={t({ id: 'dashboards.tile.table', message: 'Table' })}
                      selectedKey={table?.id ?? null}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string' && key !== draft.source.tableId) chooseTable(key);
                      }}
                    >
                      {schema.tables.map((item) => (
                        <ListBoxItem key={item.id} id={item.id}>
                          {item.name}
                        </ListBoxItem>
                      ))}
                    </Select>
                    <Select
                      label={t({ id: 'dashboards.tile.view', message: 'View' })}
                      selectedKey={draft.source.viewId ?? NONE}
                      isDisabled={!table}
                      onSelectionChange={(key) =>
                        chooseView(typeof key === 'string' && key !== NONE ? key : null)
                      }
                    >
                      <ListBoxItem id={NONE}>
                        {t({ id: 'dashboards.tile.allRecords', message: 'All records' })}
                      </ListBoxItem>
                      {views.map((view) => (
                        <ListBoxItem key={view.id} id={view.id}>
                          {view.name}
                        </ListBoxItem>
                      ))}
                    </Select>
                  </div>
                  {table ? (
                    <fieldset className="rio-dashboard-editor__filter">
                      <legend>{t({ id: 'view.toolbar.filter', message: 'Filter' })}</legend>
                      <FilterEditor
                        fields={fields}
                        session={session}
                        primaryFieldId={table.primaryFieldId}
                        collaborators={schema.collaborators}
                        value={draft.source.filter}
                        onChange={(filter: FilterGroup | null) =>
                          update({ source: { ...draft.source, filter } })
                        }
                      />
                    </fieldset>
                  ) : null}
                  {draft.kind === 'pivot' ? (
                    <PivotTileSettings
                      settings={draft.pivot}
                      fields={fields}
                      onChange={(pivot) => update({ pivot })}
                    />
                  ) : null}
                  {draft.kind === 'number' ? (
                    <div className="rio-dashboard-editor__row">{valueControls}</div>
                  ) : null}
                  {draft.kind === 'chart' ? (
                    <>
                      <div className="rio-dashboard-editor__row">
                        <Select
                          label={t({ id: 'dashboards.tile.chartType', message: 'Chart type' })}
                          selectedKey={draft.chart}
                          onSelectionChange={(key) => {
                            const chart = CHART_TYPES.find((item) => item === key);
                            if (chart) update({ chart });
                          }}
                        >
                          {CHART_TYPES.map((chart) => (
                            <ListBoxItem key={chart} id={chart}>
                              {i18n._(CHART_LABELS[chart])}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <Select
                          label={t({ id: 'dashboards.tile.groupBy', message: 'Group by' })}
                          selectedKey={groupField?.id ?? null}
                          onSelectionChange={(key) => {
                            if (typeof key === 'string')
                              update({
                                groupBy: key,
                                seriesBy: draft.seriesBy === key ? null : draft.seriesBy,
                              });
                          }}
                        >
                          {groupFields(fields).map(fieldOption)}
                        </Select>
                        {groupField && isDateField(groupField) ? (
                          <Select
                            label={t({ id: 'dashboards.tile.dateBucket', message: 'Group dates by' })}
                            selectedKey={draft.dateBucket}
                            onSelectionChange={(key) => {
                              const dateBucket = DATE_BUCKETS.find((item) => item === key);
                              if (dateBucket) update({ dateBucket });
                            }}
                          >
                            {DATE_BUCKETS.map((bucket) => (
                              <ListBoxItem key={bucket} id={bucket}>
                                {i18n._(BUCKET_LABELS[bucket])}
                              </ListBoxItem>
                            ))}
                          </Select>
                        ) : null}
                      </div>
                      <div className="rio-dashboard-editor__row">{valueControls}</div>
                      <div className="rio-dashboard-editor__row">
                        {round ? null : (
                          <Select
                            label={t({ id: 'dashboards.tile.seriesBy', message: 'Split by' })}
                            selectedKey={draft.seriesBy ?? NONE}
                            onSelectionChange={(key) =>
                              update({ seriesBy: typeof key === 'string' && key !== NONE ? key : null })
                            }
                          >
                            <ListBoxItem id={NONE}>
                              {t({ id: 'dashboards.tile.noSplit', message: 'Don’t split' })}
                            </ListBoxItem>
                            {groupFields(fields)
                              .filter((field) => field.id !== draft.groupBy)
                              .map(fieldOption)}
                          </Select>
                        )}
                        <Select
                          label={t({ id: 'dashboards.tile.sort', message: 'Sort' })}
                          selectedKey={draft.sort}
                          onSelectionChange={(key) => {
                            const sort = SORTS.find((item) => item === key);
                            if (sort) update({ sort });
                          }}
                        >
                          {SORTS.map((sort) => (
                            <ListBoxItem key={sort} id={sort}>
                              {i18n._(SORT_LABELS[sort])}
                            </ListBoxItem>
                          ))}
                        </Select>
                        <NumberField
                          label={t({ id: 'dashboards.tile.limit', message: 'Show at most' })}
                          value={draft.limit}
                          minValue={1}
                          maxValue={100}
                          step={1}
                          onChange={(limit) => {
                            if (Number.isFinite(limit)) update({ limit: Math.round(limit) });
                          }}
                        />
                      </div>
                      {!round && draft.chart !== 'scatter' && draft.seriesBy ? (
                        <Switch isSelected={draft.stacked} onChange={(stacked) => update({ stacked })}>
                          {t({ id: 'dashboards.tile.stacked', message: 'Stack the series' })}
                        </Switch>
                      ) : null}
                    </>
                  ) : null}
                  {draft.kind === 'records' && table ? (
                    <>
                      {recordFields(fields, table.primaryFieldId).length > 10 ? (
                        <FilterableList
                          listId="dashboard.fields"
                          label={t({ id: 'dashboards.tile.fields', message: 'Fields to show' })}
                          items={recordFields(fields, table.primaryFieldId).map((field) => ({
                            id: field.id,
                            name: field.name,
                            isDisabled:
                              draft.fieldIds.length >= MAX_RECORD_FIELDS &&
                              !draft.fieldIds.includes(field.id),
                          }))}
                          selectedKeys={draft.fieldIds}
                          selectionMode="multiple"
                          onSelectionChange={(keys) =>
                            update({ fieldIds: [...keys].map(String).slice(0, MAX_RECORD_FIELDS) })
                          }
                        />
                      ) : (
                        <CheckboxGroup
                          label={t({ id: 'dashboards.tile.fields', message: 'Fields to show' })}
                          value={draft.fieldIds}
                          onChange={(fieldIds) => update({ fieldIds: fieldIds.slice(0, MAX_RECORD_FIELDS) })}
                          className="rio-dashboard-editor__checkboxes"
                        >
                          {recordFields(fields, table.primaryFieldId).map((field) => (
                            <Checkbox
                              key={field.id}
                              value={field.id}
                              isDisabled={
                                draft.fieldIds.length >= MAX_RECORD_FIELDS &&
                                !draft.fieldIds.includes(field.id)
                              }
                            >
                              {field.name}
                            </Checkbox>
                          ))}
                        </CheckboxGroup>
                      )}
                      <NumberField
                        label={t({ id: 'dashboards.tile.limit', message: 'Show at most' })}
                        value={draft.recordLimit}
                        minValue={1}
                        maxValue={50}
                        step={1}
                        onChange={(recordLimit) => {
                          if (Number.isFinite(recordLimit)) update({ recordLimit: Math.round(recordLimit) });
                        }}
                      />
                    </>
                  ) : null}
                </>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onPress={onCancel}>
              {t({ id: 'field.dialog.cancel', message: 'Cancel' })}
            </Button>
            <Button type="submit" variant="primary" isDisabled={!content}>
              {t({ id: 'dashboards.tile.save', message: 'Save tile' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
