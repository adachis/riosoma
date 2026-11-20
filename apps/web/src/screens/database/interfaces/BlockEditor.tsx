import { useState, type FormEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faArrowDown, faArrowUp, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  BLOCK_KINDS,
  BLOCK_BANDS,
  type BlockBand,
  CHART_TYPES,
  DATE_BUCKETS,
  FILTER_CONTROLS,
  INTERFACE_LIMITS,
  InterfaceCode,
  HeroButton,
  LIMITS,
  RECORDS_DISPLAYS,
  TEXT_STYLES,
  filterControls,
  safeLink,
  type Aggregate,
  type Block,
  type BlockKind,
  type ChartSort,
  type ChartType,
  type DateBucket,
  type FieldMeta,
  type FilterControl,
  type FilterGroup,
  type InterfacePage,
  type RecordAttachment,
  type RecordsDisplay,
  type TextStyle,
  type TileValue,
} from '@riosoma/contracts';
import {
  Button,
  SortableItem,
  SortableList,
  moveList,
  Checkbox,
  CheckboxGroup,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  NumberField,
  SegmentedControl,
  Select,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import {
  aggregatesFor,
  groupFields,
  isDateField,
  isNumericField,
  valueFields,
} from '../dashboards/aggregates';
import { AGGREGATE_LABELS, BUCKET_LABELS, CHART_LABELS, SORT_LABELS } from '../dashboards/messages';
import { fieldTypeInfo } from '../fields/fieldTypes';
import { FilterEditor } from '../view/FilterEditor';
import {
  BAND_LABELS,
  CONTROL_LABELS,
  DISPLAY_LABELS,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  STYLE_LABELS,
} from './messages';
import { AttachmentPicker } from './AttachmentPicker';
import { CodeFields } from './CodeFields';
import type { BlockContext } from './context';
import { followed, KIND_ICONS, recordsBlocks, type BlockContent } from './model';

const NONE = '__none__';
const SORTS: readonly ChartSort[] = ['category', 'valueDescending', 'valueAscending'];
const ROUND: ReadonlySet<ChartType> = new Set(['pie', 'donut']);
const STACKABLE: ReadonlySet<ChartType> = new Set(['bar', 'column', 'line', 'area']);
/** Fields that sort records into a few groups make the best first axis. */
const GROUP_PREFERENCE: readonly FieldMeta['type'][] = [
  'singleSelect',
  'multipleSelect',
  'user',
  'checkbox',
  'date',
  'createdTime',
];

interface Draft {
  kind: BlockKind;
  band: BlockBand;
  playback: 'controls' | 'loop';
  enlarge: boolean;
  altFieldId: string | null;
  linkFieldId: string | null;
  linkLabelFieldId: string | null;
  title: string;
  /** The table records, number, chart, filter, and form blocks read */
  tableId: string;
  viewId: string | null;
  filter: FilterGroup | null;
  listFieldIds: string[];
  display: RecordsDisplay;
  pageSize: number;
  showFieldNames: boolean;
  recordsBlockId: string | null;
  recordFieldIds: string[];
  value: TileValue;
  chart: ChartType;
  groupBy: string | null;
  dateBucket: DateBucket;
  seriesBy: string | null;
  sort: ChartSort;
  limit: number;
  stacked: boolean;
  style: TextStyle;
  text: string;
  control: FilterControl;
  fieldId: string | null;
  blockIds: string[];
  label: string;
  action: 'form' | 'url' | 'page';
  pageId: string;
  heading: string;
  image: RecordAttachment | null;
  alt: string;
  caption: string;
  mediaType: 'image' | 'video';
  heroButtons: HeroButton[];
  coverFieldId: string | null;
  url: string;
  html: string;
  css: string;
  javascript: string;
}

function firstGroup(fields: readonly FieldMeta[]): string | null {
  const rank = (field: FieldMeta) => {
    const index = GROUP_PREFERENCE.indexOf(field.type);
    return index < 0 ? GROUP_PREFERENCE.length : index;
  };
  return [...groupFields(fields)].sort((a, b) => rank(a) - rank(b))[0]?.id ?? null;
}

/**
 * The view a kind of block reads from a table: a form for a button, any view for a records block,
 * and every record, or a view that isn't a form, for numbers and charts.
 */
function viewFor(
  schema: SchemaState,
  kind: BlockKind,
  tableId: string,
  current: string | null,
): string | null {
  const views = schema.views.get(tableId) ?? [];
  const kept = views.find((view) => view.id === current);
  if (kind === 'button')
    return kept?.type === 'form' ? kept.id : (views.find((view) => view.type === 'form')?.id ?? null);
  if (kind === 'records') return kept?.id ?? views[0]?.id ?? null;
  return kept && kept.type !== 'form' ? kept.id : null;
}

function tableOf(block: Block | null, page: InterfacePage): string | null {
  switch (block?.kind) {
    case 'records':
    case 'number':
    case 'chart':
      return block.source.tableId;
    case 'filter':
      return block.tableId;
    case 'hero':
      return block.image?.tableId ?? null;
    case 'media':
      return block.attachment?.tableId ?? null;
    case 'button':
      return block.action.kind === 'form' ? block.action.tableId : null;
    case 'record':
      return followed(page, block.recordsBlockId)?.source.tableId ?? null;
    default:
      return null;
  }
}

function initialDraft(block: Block | null, page: InterfacePage, schema: SchemaState): Draft {
  const tableId = tableOf(block, page) ?? schema.tables[0]?.id ?? '';
  const fields = schema.fields.get(tableId) ?? [];
  const draft: Draft = {
    kind: block?.kind ?? 'records',
    title: block?.title ?? '',
    tableId,
    viewId: schema.views.get(tableId)?.[0]?.id ?? null,
    filter: null,
    listFieldIds: [],
    display: 'list',
    pageSize: 25,
    showFieldNames: true,
    recordsBlockId: recordsBlocks(page)[0]?.id ?? null,
    recordFieldIds: [],
    value: { fn: 'count', fieldId: null },
    chart: 'column',
    groupBy: firstGroup(fields),
    dateBucket: 'month',
    seriesBy: null,
    sort: 'category',
    limit: 20,
    stacked: false,
    style: 'paragraph',
    text: '',
    control: 'choice',
    fieldId: null,
    blockIds: [],
    label: '',
    action: 'form',
    pageId: page.id,
    heading: '',
    image: null,
    alt: '',
    caption: '',
    mediaType: 'image',
    band: block && 'band' in block ? (block.band ?? 'none') : 'none',
    playback: block && 'playback' in block ? (block.playback ?? 'controls') : 'controls',
    enlarge: block?.kind === 'media' || block?.kind === 'records' ? (block.enlarge ?? false) : false,
    altFieldId: block?.kind === 'records' ? (block.altFieldId ?? null) : null,
    linkFieldId: block?.kind === 'records' ? (block.linkFieldId ?? null) : null,
    linkLabelFieldId: block?.kind === 'records' ? (block.linkLabelFieldId ?? null) : null,
    heroButtons: [],
    coverFieldId: null,
    url: '',
    html: '',
    css: '',
    javascript: '',
  };
  switch (block?.kind) {
    case 'records':
      return {
        ...draft,
        viewId: block.source.viewId,
        filter: block.source.filter,
        listFieldIds: block.fieldIds,
        display: block.display,
        pageSize: block.pageSize ?? 25,
        showFieldNames: block.showFieldNames,
        coverFieldId: block.coverFieldId ?? null,
      };
    case 'record':
      return { ...draft, recordsBlockId: block.recordsBlockId, recordFieldIds: block.fieldIds };
    case 'number':
      return { ...draft, viewId: block.source.viewId, filter: block.source.filter, value: block.value };
    case 'chart':
      return {
        ...draft,
        viewId: block.source.viewId,
        filter: block.source.filter,
        value: block.value,
        chart: block.chart,
        groupBy: block.groupBy.fieldId,
        dateBucket: block.groupBy.dateBucket ?? 'day',
        seriesBy: block.seriesBy,
        sort: block.sort,
        limit: block.limit,
        stacked: block.stacked,
      };
    case 'code':
      return { ...draft, html: block.html, css: block.css, javascript: block.javascript };
    case 'text':
      return { ...draft, style: block.style, text: block.text };
    case 'filter':
      return { ...draft, control: block.control, fieldId: block.fieldId, blockIds: block.blockIds };
    case 'hero':
      return {
        ...draft,
        mediaType: block.mediaType ?? 'image',
        heading: block.heading,
        text: block.text,
        image: block.image,
        alt: block.alt,
        heroButtons: block.buttons,
      };
    case 'media':
      return {
        ...draft,
        image: block.attachment,
        mediaType: block.mediaType,
        alt: block.alt,
        caption: block.caption,
      };
    case 'button':
      if (block.action.kind === 'page')
        return { ...draft, label: block.label, action: 'page', pageId: block.action.pageId };
      return block.action.kind === 'form'
        ? { ...draft, label: block.label, action: 'form', viewId: block.action.viewId }
        : { ...draft, label: block.label, action: 'url', url: block.action.url };
    default:
      return draft;
  }
}

/** The block the draft describes, or null while something it needs is missing. */
function contentOf(draft: Draft, page: InterfacePage, schema: SchemaState): BlockContent | null {
  const title = draft.title.trim();
  const band = { band: draft.band };
  const playback = { playback: draft.playback };
  const table = schema.tableById.get(draft.tableId);
  const fields = table ? (schema.fields.get(table.id) ?? []) : [];
  const field = (id: string | null) => (id ? fields.find((item) => item.id === id) : undefined);
  const view = draft.viewId ? schema.viewById.get(draft.viewId) : undefined;
  const viewFits = !draft.viewId || view?.tableId === draft.tableId;
  switch (draft.kind) {
    case 'code': {
      const parsed = InterfaceCode.safeParse(draft);
      return parsed.success ? { kind: 'code', title, ...parsed.data } : null;
    }
    case 'text':
      return { kind: 'text', ...band, title, style: draft.style, text: draft.text };
    case 'hero':
      return draft.heroButtons.every((button) => HeroButton.safeParse(button).success)
        ? {
            kind: 'hero',
            ...band,
            ...playback,
            title,
            mediaType: draft.mediaType,
            heading: draft.heading,
            text: draft.text,
            buttons: draft.heroButtons,
            image: draft.image,
            alt: draft.alt,
          }
        : null;
    case 'media':
      return {
        kind: 'media',
        ...band,
        ...playback,
        title,
        enlarge: draft.enlarge,
        attachment: draft.image,
        mediaType: draft.mediaType,
        alt: draft.alt,
        caption: draft.caption,
      };
    case 'record': {
      const source = followed(page, draft.recordsBlockId);
      if (!source) return null;
      const own = new Set((schema.fields.get(source.source.tableId) ?? []).map((item) => item.id));
      return {
        kind: 'record',
        title,
        recordsBlockId: source.id,
        fieldIds: draft.recordFieldIds.filter((id) => own.has(id)),
      };
    }
    case 'records':
      if (
        !table ||
        !view ||
        !viewFits ||
        !Number.isInteger(draft.pageSize) ||
        draft.pageSize < 1 ||
        draft.pageSize > INTERFACE_LIMITS.pageSize
      )
        return null;
      return {
        kind: 'records',
        ...band,
        ...playback,
        title,
        source: { tableId: table.id, viewId: view.id, filter: draft.filter },
        fieldIds: draft.listFieldIds.filter((id) => field(id)),
        display: draft.display,
        pageSize: draft.pageSize,
        showFieldNames: draft.showFieldNames,
        enlarge: draft.enlarge,
        altFieldId: field(draft.altFieldId) ? draft.altFieldId : null,
        linkFieldId: field(draft.linkFieldId) ? draft.linkFieldId : null,
        linkLabelFieldId: field(draft.linkLabelFieldId) ? draft.linkLabelFieldId : null,
        coverFieldId: field(draft.coverFieldId)?.type === 'attachment' ? draft.coverFieldId : null,
      };
    case 'filter': {
      const chosen = field(draft.fieldId);
      if (!table || !chosen || !filterControls(chosen).includes(draft.control)) return null;
      const targets = new Set(
        recordsBlocks(page)
          .filter((block) => block.source.tableId === table.id)
          .map((block) => block.id),
      );
      return {
        kind: 'filter',
        title,
        control: draft.control,
        tableId: table.id,
        fieldId: chosen.id,
        blockIds: draft.blockIds.filter((id) => targets.has(id)),
      };
    }
    case 'button': {
      const label = draft.label.trim();
      if (draft.action === 'page')
        return { kind: 'button', ...band, title, label, action: { kind: 'page', pageId: draft.pageId } };
      if (draft.action === 'url')
        return safeLink(draft.url.trim())
          ? { kind: 'button', ...band, title, label, action: { kind: 'url', url: draft.url.trim() } }
          : null;
      if (!table || !view || view.tableId !== table.id || view.type !== 'form') return null;
      return {
        kind: 'button',
        ...band,
        title,
        label,
        action: { kind: 'form', tableId: table.id, viewId: view.id },
      };
    }
    case 'number':
    case 'chart': {
      if (!table || !viewFits) return null;
      const valueFits =
        draft.value.fn === 'count' || aggregatesFor(field(draft.value.fieldId)).includes(draft.value.fn);
      if (!valueFits) return null;
      const value: TileValue =
        draft.value.fn === 'count'
          ? { fn: 'count', fieldId: null }
          : { fn: draft.value.fn, fieldId: draft.value.fieldId };
      const source = { tableId: table.id, viewId: draft.viewId, filter: draft.filter };
      if (draft.kind === 'number') return { kind: 'number', ...band, title, source, value };
      const group = field(draft.groupBy);
      if (!group) return null;
      const round = ROUND.has(draft.chart);
      const seriesBy = round || !field(draft.seriesBy) || draft.seriesBy === group.id ? null : draft.seriesBy;
      return {
        kind: 'chart',
        ...band,
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

/** Unavailable fields keep their stored slots when the visible fields change order. */
function FieldOrder({
  label,
  help,
  fields,
  value,
  max,
  onChange,
}: {
  label: string;
  help?: string;
  fields: readonly FieldMeta[];
  value: readonly string[];
  max: number;
  onChange(ids: string[]): void;
}) {
  const { t } = useLingui();
  const chosen = value.flatMap((id) => fields.filter((field) => field.id === id));
  const rest = fields.filter((field) => !value.includes(field.id));
  const reorder = (from: number, to: number) => {
    const ordered = moveList(chosen, from, to);
    const visible = new Set(chosen.map((field) => field.id));
    let index = 0;
    onChange(value.map((id) => (visible.has(id) ? ordered[index++]!.id : id)));
  };
  return (
    <fieldset className="rio-interface-editor__fields">
      <legend>{label}</legend>
      {help ? <p className="rio-interface-hint">{help}</p> : null}
      {chosen.length ? (
        <SortableList items={chosen.map((field) => ({ id: field.id, name: field.name }))} onMove={reorder}>
          <ol className="rio-interface-editor__order">
            {chosen.map((field, index) => {
              const name = field.name;
              return (
                <SortableItem id={field.id} key={field.id} as="li">
                  <>
                    <span>{name}</span>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={faArrowUp}
                      isDisabled={index === 0}
                      aria-label={t({ id: 'interfaces.fields.up', message: `Move ${name} up` })}
                      onPress={() => reorder(index, index - 1)}
                    />
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={faArrowDown}
                      isDisabled={index === chosen.length - 1}
                      aria-label={t({ id: 'interfaces.fields.down', message: `Move ${name} down` })}
                      onPress={() => reorder(index, index + 1)}
                    />
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={faXmark}
                      aria-label={t({ id: 'interfaces.fields.remove', message: `Remove ${name}` })}
                      onPress={() => onChange(value.filter((id) => id !== field.id))}
                    />
                  </>
                </SortableItem>
              );
            })}
          </ol>
        </SortableList>
      ) : null}
      {rest.length && chosen.length < max ? (
        <MenuTrigger>
          <Button
            size="sm"
            icon={faPlus}
            aria-label={t({ id: 'interfaces.fields.add', message: 'Add a field' })}
          />
          <Menu
            aria-label={t({ id: 'interfaces.fields.add', message: 'Add a field' })}
            onAction={(key) => {
              if (typeof key === 'string') onChange([...value, key]);
            }}
          >
            {rest.map((field) => (
              <MenuItem key={field.id} id={field.id} textValue={field.name}>
                {field.name}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : null}
    </fieldset>
  );
}

export interface BlockEditorProps {
  context: BlockContext;
  session: DatabaseSession;
  schema: SchemaState;
  /** The page the block is on, whose records blocks record and filter blocks can follow */
  page: InterfacePage;
  /** The block to change, or null to add one */
  block: Block | null;
  /** Names blocks on the page, for choosing which one a block follows */
  nameOf(block: Block): string;
  onSave(content: BlockContent): void;
  onCancel(): void;
}

/** Adds or changes a block: its kind, its title, and what it reads and shows. */
export function BlockEditor({
  context,
  session,
  schema,
  page,
  block,
  nameOf,
  onSave,
  onCancel,
}: BlockEditorProps) {
  const { t, i18n } = useLingui();
  const [draft, setDraft] = useState(() => initialDraft(block, page, schema));
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const table = schema.tableById.get(draft.tableId);
  const fields = table ? (schema.fields.get(table.id) ?? []) : [];
  const views = table ? (schema.views.get(table.id) ?? []) : [];
  const content = contentOf(draft, page, schema);
  const others = recordsBlocks(page).filter((item) => item.id !== block?.id);
  const valueField =
    draft.value.fn === 'count' ? undefined : fields.find((field) => field.id === draft.value.fieldId);
  const groupField = fields.find((field) => field.id === draft.groupBy);
  const round = ROUND.has(draft.chart);
  const chooseTable = (tableId: string) => {
    const next = schema.fields.get(tableId) ?? [];
    update({
      tableId,
      viewId: viewFor(schema, draft.kind, tableId, null),
      filter: null,
      listFieldIds: [],
      coverFieldId: null,
      altFieldId: null,
      linkFieldId: null,
      linkLabelFieldId: null,
      value: { fn: 'count', fieldId: null },
      groupBy: firstGroup(next),
      seriesBy: null,
      fieldId: null,
      blockIds: [],
    });
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
  const tableSelect = (
    <Select
      label={t({ id: 'dashboards.tile.table', message: 'Table' })}
      selectedKey={table?.id ?? null}
      onSelectionChange={(key) => {
        if (typeof key === 'string' && key !== draft.tableId) chooseTable(key);
      }}
    >
      {schema.tables.map((item) => (
        <ListBoxItem key={item.id} id={item.id}>
          {item.name}
        </ListBoxItem>
      ))}
    </Select>
  );
  const viewSelect = (required: boolean, onlyForms = false) => (
    <Select
      label={
        onlyForms
          ? t({ id: 'interfaces.button.formView', message: 'Form' })
          : t({ id: 'dashboards.tile.view', message: 'View' })
      }
      selectedKey={draft.viewId ?? NONE}
      isDisabled={!table}
      onSelectionChange={(key) => update({ viewId: typeof key === 'string' && key !== NONE ? key : null })}
    >
      {required ? null : (
        <ListBoxItem id={NONE}>{t({ id: 'dashboards.tile.allRecords', message: 'All records' })}</ListBoxItem>
      )}
      {views
        .filter((view) => !onlyForms || view.type === 'form')
        .map((view) => (
          <ListBoxItem key={view.id} id={view.id}>
            {view.name}
          </ListBoxItem>
        ))}
    </Select>
  );
  const filterEditor = table ? (
    <fieldset className="rio-dashboard-editor__filter">
      <legend>{t({ id: 'view.toolbar.filter', message: 'Filter' })}</legend>
      <FilterEditor
        fields={fields}
        session={session}
        primaryFieldId={table.primaryFieldId}
        collaborators={schema.collaborators}
        value={draft.filter}
        onChange={(filter: FilterGroup | null) => update({ filter })}
      />
    </fieldset>
  ) : null;
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
  const recordsSource = followed(page, draft.recordsBlockId);
  const filterFields = fields.filter((field) => filterControls(field).includes(draft.control));
  const filterTargets = others.filter((item) => item.source.tableId === draft.tableId);
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
          {block
            ? t({ id: 'interfaces.editor.edit', message: 'Edit block' })
            : t({ id: 'interfaces.editor.add', message: 'Add a block' })}
        </DialogTitle>
        <form className="rio-dashboard-editor__form" noValidate onSubmit={submit}>
          <DialogBody>
            <div className="rio-dashboard-editor__fields">
              <Select
                label={t({ id: 'dashboards.tile.kind', message: 'Type' })}
                selectedKey={draft.kind}
                onSelectionChange={(key) => {
                  const kind = BLOCK_KINDS.find((item) => item === key);
                  if (kind) update({ kind, viewId: viewFor(schema, kind, draft.tableId, draft.viewId) });
                }}
              >
                {BLOCK_KINDS.map((kind) => (
                  <ListBoxItem
                    key={kind}
                    id={kind}
                    textValue={i18n._(KIND_LABELS[kind])}
                    icon={KIND_ICONS[kind]}
                    description={i18n._(KIND_DESCRIPTIONS[kind])}
                  >
                    {i18n._(KIND_LABELS[kind])}
                  </ListBoxItem>
                ))}
              </Select>
              <TextField
                label={t({ id: 'dashboards.tile.title', message: 'Title' })}
                value={draft.title}
                maxLength={LIMITS.nameLength}
                onChange={(title) => update({ title })}
              />
              {['text', 'hero', 'media', 'records', 'number', 'chart', 'button'].includes(draft.kind) ? (
                <Select
                  label={t({ id: 'interfaces.band', message: 'Band' })}
                  selectedKey={draft.band}
                  onSelectionChange={(key) => {
                    const band = BLOCK_BANDS.find((value) => value === key);
                    if (band) update({ band });
                  }}
                >
                  {BLOCK_BANDS.map((value) => (
                    <ListBoxItem key={value} id={value}>
                      {i18n._(BAND_LABELS[value])}
                    </ListBoxItem>
                  ))}
                </Select>
              ) : null}
              {((draft.kind === 'media' || draft.kind === 'hero') && draft.mediaType === 'video') ||
              (draft.kind === 'records' && ['sections', 'cards', 'list'].includes(draft.display)) ? (
                <SegmentedControl
                  label={t({ id: 'interfaces.media.playback', message: 'Video playback' })}
                  items={[
                    { id: 'controls', label: t({ id: 'interfaces.media.controls', message: 'Controls' }) },
                    { id: 'loop', label: t({ id: 'interfaces.media.loop', message: 'Muted loop' }) },
                  ]}
                  selectedId={draft.playback}
                  onChange={(id) => {
                    if (id === 'controls' || id === 'loop') update({ playback: id });
                  }}
                />
              ) : null}
              {draft.kind === 'media' ? (
                <Checkbox isSelected={draft.enlarge} onChange={(enlarge) => update({ enlarge })}>
                  {t({ id: 'interfaces.media.enlarge', message: 'Enlarge on press' })}
                </Checkbox>
              ) : null}
              {draft.kind === 'records' ? (
                <>
                  <div className="rio-dashboard-editor__row">
                    {tableSelect}
                    {viewSelect(true)}
                  </div>
                  {filterEditor}
                  {table ? (
                    <FieldOrder
                      label={t({ id: 'interfaces.records.fields', message: 'Fields to show' })}
                      fields={fields.filter((field) => field.type !== 'button')}
                      value={draft.listFieldIds}
                      max={INTERFACE_LIMITS.listFields}
                      onChange={(listFieldIds) => update({ listFieldIds })}
                    />
                  ) : null}
                  <SegmentedControl
                    label={t({ id: 'interfaces.records.display', message: 'Show as' })}
                    items={RECORDS_DISPLAYS.map((display) => ({
                      id: display,
                      label: i18n._(DISPLAY_LABELS[display]),
                    }))}
                    selectedId={draft.display}
                    onChange={(id) => {
                      const display = RECORDS_DISPLAYS.find((item) => item === id);
                      if (display) update({ display });
                    }}
                  />
                  <NumberField
                    label={t({ id: 'interfaces.records.pageSize', message: 'Records per page' })}
                    description={t({
                      id: 'interfaces.records.pageSize.hint',
                      message: 'Choose a whole number from 1 to 100.  The default is 25.',
                    })}
                    value={draft.pageSize}
                    minValue={1}
                    maxValue={INTERFACE_LIMITS.pageSize}
                    step={1}
                    onChange={(pageSize) => update({ pageSize })}
                  />
                  {draft.display !== 'table' ? (
                    <Checkbox
                      isSelected={draft.showFieldNames}
                      onChange={(showFieldNames) => update({ showFieldNames })}
                    >
                      {t({ id: 'interfaces.records.showFieldNames', message: 'Show field names' })}
                    </Checkbox>
                  ) : null}
                </>
              ) : null}
              {draft.kind === 'records' && ['sections', 'cards', 'list'].includes(draft.display) ? (
                <>
                  <Select
                    label={
                      draft.display === 'sections'
                        ? t({ id: 'interfaces.records.sectionCover', message: 'Section media field' })
                        : draft.display === 'list'
                          ? t({ id: 'interfaces.records.listCover', message: 'List cover field' })
                          : t({ id: 'interfaces.records.cover', message: 'Card cover field' })
                    }
                    selectedKey={draft.coverFieldId ?? NONE}
                    onSelectionChange={(key) =>
                      update({ coverFieldId: typeof key === 'string' && key !== NONE ? key : null })
                    }
                  >
                    <ListBoxItem id={NONE}>{t({ id: 'sites.noImage', message: 'No image' })}</ListBoxItem>
                    {fields.filter((field) => field.type === 'attachment').map(fieldOption)}
                  </Select>
                  <Checkbox isSelected={draft.enlarge} onChange={(enlarge) => update({ enlarge })}>
                    {t({ id: 'interfaces.media.enlarge', message: 'Enlarge on press' })}
                  </Checkbox>
                </>
              ) : null}
              {draft.kind === 'records' && draft.display === 'sections' ? (
                <>
                  {(
                    [
                      [
                        'altFieldId',
                        t({ id: 'interfaces.records.altField', message: 'Alternative text field' }),
                      ],
                      [
                        'linkFieldId',
                        t({ id: 'interfaces.records.linkField', message: 'Link address field' }),
                      ],
                      [
                        'linkLabelFieldId',
                        t({ id: 'interfaces.records.linkLabelField', message: 'Link label field' }),
                      ],
                    ] as const
                  ).map(([setting, label]) => (
                    <Select
                      key={setting}
                      label={label}
                      selectedKey={draft[setting] ?? NONE}
                      onSelectionChange={(key) =>
                        update({ [setting]: typeof key === 'string' && key !== NONE ? key : null })
                      }
                    >
                      <ListBoxItem id={NONE}>
                        {t({ id: 'interfaces.band.none', message: 'None' })}
                      </ListBoxItem>
                      {fields
                        .filter((field) => field.type !== 'button' && field.type !== 'attachment')
                        .map(fieldOption)}
                    </Select>
                  ))}
                </>
              ) : null}
              {draft.kind === 'record' ? (
                others.length ? (
                  <>
                    <Select
                      label={t({ id: 'interfaces.record.source', message: 'Shows the record picked in' })}
                      selectedKey={recordsSource?.id ?? null}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string') update({ recordsBlockId: key, recordFieldIds: [] });
                      }}
                    >
                      {others.map((item) => (
                        <ListBoxItem key={item.id} id={item.id}>
                          {nameOf(item)}
                        </ListBoxItem>
                      ))}
                    </Select>
                    {recordsSource ? (
                      <FieldOrder
                        label={t({ id: 'interfaces.record.fields', message: 'Fields' })}
                        help={t({
                          id: 'interfaces.record.fieldsHelp',
                          message: 'Leave this empty to show every field.',
                        })}
                        fields={schema.fields.get(recordsSource.source.tableId) ?? []}
                        value={draft.recordFieldIds}
                        max={INTERFACE_LIMITS.recordFields}
                        onChange={(recordFieldIds) => update({ recordFieldIds })}
                      />
                    ) : null}
                  </>
                ) : (
                  <p className="rio-interface-hint">
                    {t({
                      id: 'interfaces.record.needsRecords',
                      message: 'Add a records block to this page first.',
                    })}
                  </p>
                )
              ) : null}
              {draft.kind === 'number' || draft.kind === 'chart' ? (
                <>
                  <div className="rio-dashboard-editor__row">
                    {tableSelect}
                    {viewSelect(false)}
                  </div>
                  {filterEditor}
                </>
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
                          update({ groupBy: key, seriesBy: draft.seriesBy === key ? null : draft.seriesBy });
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
              {draft.kind === 'code' ? (
                <CodeFields
                  code={{ html: draft.html, css: draft.css, javascript: draft.javascript }}
                  onChange={update}
                  context={context}
                />
              ) : null}
              {draft.kind === 'text' ? (
                <>
                  <SegmentedControl
                    label={t({ id: 'interfaces.text.style', message: 'Style' })}
                    items={TEXT_STYLES.map((style) => ({ id: style, label: i18n._(STYLE_LABELS[style]) }))}
                    selectedId={draft.style}
                    onChange={(id) => {
                      const style = TEXT_STYLES.find((item) => item === id);
                      if (style) update({ style });
                    }}
                  />
                  {draft.style === 'heading' ? (
                    <TextField
                      label={t({ id: 'interfaces.text.text', message: 'Text' })}
                      value={draft.text}
                      maxLength={LIMITS.nameLength}
                      onChange={(text) => update({ text })}
                    />
                  ) : (
                    <TextArea
                      label={t({ id: 'interfaces.text.text', message: 'Text' })}
                      value={draft.text}
                      rows={8}
                      maxLength={LIMITS.descriptionLength}
                      onChange={(text) => update({ text })}
                    />
                  )}
                </>
              ) : null}
              {draft.kind === 'hero' || draft.kind === 'media' ? (
                <>
                  {draft.kind === 'hero' ? (
                    <>
                      <TextField
                        label={t({ id: 'interfaces.hero.heading', message: 'Heading' })}
                        value={draft.heading}
                        maxLength={LIMITS.nameLength}
                        onChange={(heading) => update({ heading })}
                      />
                      <TextArea
                        label={t({ id: 'interfaces.hero.lead', message: 'Lead paragraph' })}
                        value={draft.text}
                        maxLength={LIMITS.descriptionLength}
                        onChange={(text) => update({ text })}
                      />
                      {draft.heroButtons.map((button, index) => {
                        const change = (part: Partial<HeroButton>) =>
                          update({
                            heroButtons: draft.heroButtons.map((item, slot) =>
                              slot === index ? { ...item, ...part } : item,
                            ),
                          });
                        return (
                          <fieldset key={index}>
                            <legend>
                              {t({ id: 'interfaces.hero.button', message: `Button ${index + 1}` })}
                            </legend>
                            <TextField
                              label={t({ id: 'interfaces.button.label', message: 'Label' })}
                              value={button.label}
                              maxLength={LIMITS.buttonLabelLength}
                              onChange={(label) => change({ label })}
                            />
                            <SegmentedControl
                              label={t({ id: 'interfaces.button.action', message: 'When pressed' })}
                              items={[
                                {
                                  id: 'url',
                                  label: t({ id: 'interfaces.button.url', message: 'Open a web address' }),
                                },
                                {
                                  id: 'page',
                                  label: t({ id: 'interfaces.button.page', message: 'Open a page' }),
                                },
                              ]}
                              selectedId={button.action.kind}
                              onChange={(id) =>
                                change({
                                  action:
                                    id === 'page'
                                      ? { kind: 'page', pageId: page.id }
                                      : { kind: 'url', url: '' },
                                })
                              }
                            />
                            {button.action.kind === 'url' ? (
                              <TextField
                                label={t({ id: 'interfaces.button.address', message: 'Web address' })}
                                value={button.action.url}
                                maxLength={LIMITS.urlLength}
                                onChange={(url) => change({ action: { kind: 'url', url } })}
                              />
                            ) : (
                              <Select
                                label={t({
                                  id: 'interfaces.button.destination',
                                  message: 'Destination page',
                                })}
                                selectedKey={button.action.pageId}
                                onSelectionChange={(key) => {
                                  if (typeof key === 'string')
                                    change({ action: { kind: 'page', pageId: key } });
                                }}
                              >
                                {(
                                  schema.interfaces.find((item) => item.id === context.interfaceId)
                                    ?.pages ?? [page]
                                ).map((item) => (
                                  <ListBoxItem key={item.id} id={item.id}>
                                    {item.name}
                                  </ListBoxItem>
                                ))}
                              </Select>
                            )}
                            <Button
                              onPress={() =>
                                update({ heroButtons: draft.heroButtons.filter((_, slot) => slot !== index) })
                              }
                            >
                              {t({ id: 'interfaces.hero.removeButton', message: 'Remove button' })}
                            </Button>
                          </fieldset>
                        );
                      })}
                      {draft.heroButtons.length < 2 ? (
                        <Button
                          onPress={() =>
                            update({
                              heroButtons: [
                                ...draft.heroButtons,
                                { label: '', action: { kind: 'url', url: '' } },
                              ],
                            })
                          }
                        >
                          {t({ id: 'interfaces.hero.addButton', message: 'Add button' })}
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <SegmentedControl
                      label={t({ id: 'interfaces.media.type', message: 'Media type' })}
                      items={[
                        { id: 'image', label: t({ id: 'sites.imageFile', message: 'Image' }) },
                        { id: 'video', label: t({ id: 'sites.videoFile', message: 'Video' }) },
                      ]}
                      selectedId={draft.mediaType}
                      onChange={(id) => {
                        if (id === 'image' || id === 'video') update({ mediaType: id, image: null });
                      }}
                    />
                  )}
                  {draft.kind === 'hero' ? (
                    <SegmentedControl
                      label={t({ id: 'interfaces.media.type', message: 'Media type' })}
                      items={[
                        { id: 'image', label: t({ id: 'sites.imageFile', message: 'Image' }) },
                        { id: 'video', label: t({ id: 'sites.videoFile', message: 'Video' }) },
                      ]}
                      selectedId={draft.mediaType}
                      onChange={(id) => {
                        if (id === 'image' || id === 'video') update({ mediaType: id, image: null });
                      }}
                    />
                  ) : null}
                  <AttachmentPicker
                    label={t({ id: 'interfaces.media.attachment', message: 'Record attachment' })}
                    value={draft.image}
                    onChange={(image) => update({ image })}
                    session={session}
                    schema={schema}
                    kind={draft.mediaType}
                  />
                  <TextField
                    label={t({ id: 'interfaces.media.alt', message: 'Alternative text' })}
                    value={draft.alt}
                    maxLength={LIMITS.descriptionLength}
                    onChange={(alt) => update({ alt })}
                  />
                  {draft.kind === 'media' ? (
                    <TextArea
                      label={t({ id: 'interfaces.media.caption', message: 'Caption' })}
                      value={draft.caption}
                      maxLength={LIMITS.descriptionLength}
                      onChange={(caption) => update({ caption })}
                    />
                  ) : null}
                </>
              ) : null}
              {draft.kind === 'filter' ? (
                <>
                  <SegmentedControl
                    label={t({ id: 'interfaces.filter.control', message: 'Control' })}
                    items={FILTER_CONTROLS.map((control) => ({
                      id: control,
                      label: i18n._(CONTROL_LABELS[control]),
                    }))}
                    selectedId={draft.control}
                    onChange={(id) => {
                      const control = FILTER_CONTROLS.find((item) => item === id);
                      if (control) update({ control, fieldId: null });
                    }}
                  />
                  <div className="rio-dashboard-editor__row">
                    {tableSelect}
                    <Select
                      label={t({ id: 'dashboards.tile.field', message: 'Field' })}
                      selectedKey={
                        filterFields.some((field) => field.id === draft.fieldId) ? draft.fieldId : null
                      }
                      isDisabled={!filterFields.length}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string') update({ fieldId: key });
                      }}
                    >
                      {filterFields.map(fieldOption)}
                    </Select>
                  </div>
                  {filterTargets.length ? (
                    <CheckboxGroup
                      label={t({ id: 'interfaces.filter.narrows', message: 'Narrows' })}
                      description={t({
                        id: 'interfaces.filter.narrowsHelp',
                        message: 'Leave these clear to narrow every records block for this table.',
                      })}
                      value={draft.blockIds}
                      onChange={(blockIds) => update({ blockIds })}
                    >
                      {filterTargets.map((item) => (
                        <Checkbox key={item.id} value={item.id}>
                          {nameOf(item)}
                        </Checkbox>
                      ))}
                    </CheckboxGroup>
                  ) : null}
                </>
              ) : null}
              {draft.kind === 'button' ? (
                <>
                  <TextField
                    label={t({ id: 'interfaces.button.label', message: 'Label' })}
                    value={draft.label}
                    maxLength={LIMITS.buttonLabelLength}
                    onChange={(label) => update({ label })}
                  />
                  <SegmentedControl
                    label={t({ id: 'interfaces.button.action', message: 'When pressed' })}
                    items={[
                      { id: 'page', label: t({ id: 'interfaces.button.page', message: 'Open a page' }) },
                      { id: 'form', label: t({ id: 'interfaces.button.form', message: 'Open a form' }) },
                      { id: 'url', label: t({ id: 'interfaces.button.url', message: 'Open a web address' }) },
                    ]}
                    selectedId={draft.action}
                    onChange={(id) => {
                      if (id === 'form' || id === 'url' || id === 'page') update({ action: id });
                    }}
                  />
                  {draft.action === 'page' ? (
                    <Select
                      label={t({ id: 'interfaces.button.destination', message: 'Destination page' })}
                      selectedKey={draft.pageId}
                      onSelectionChange={(key) => {
                        if (typeof key === 'string') update({ pageId: key });
                      }}
                    >
                      {(
                        schema.interfaces.find((item) => item.id === context.interfaceId)?.pages ?? [page]
                      ).map((item) => (
                        <ListBoxItem key={item.id} id={item.id}>
                          {item.name}
                        </ListBoxItem>
                      ))}
                    </Select>
                  ) : draft.action === 'form' ? (
                    <div className="rio-dashboard-editor__row">
                      {tableSelect}
                      {views.some((view) => view.type === 'form') ? (
                        viewSelect(true, true)
                      ) : (
                        <p className="rio-interface-hint">
                          {t({
                            id: 'interfaces.button.noForms',
                            message: 'This table has no form views yet.  Add one from its views first.',
                          })}
                        </p>
                      )}
                    </div>
                  ) : (
                    <TextField
                      label={t({ id: 'interfaces.button.address', message: 'Web address' })}
                      description={t({
                        id: 'interfaces.button.addressHelp',
                        message: 'Starts with http:// or https://',
                      })}
                      type="url"
                      value={draft.url}
                      maxLength={LIMITS.urlLength}
                      onChange={(url) => update({ url })}
                    />
                  )}
                </>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onPress={onCancel}>
              {t({ id: 'field.dialog.cancel', message: 'Cancel' })}
            </Button>
            <Button type="submit" variant="primary" isDisabled={!content}>
              {t({ id: 'interfaces.editor.save', message: 'Save block' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
