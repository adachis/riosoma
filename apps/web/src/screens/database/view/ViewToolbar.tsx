import { useState, type ReactNode } from 'react';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import type { ExportFormat, FieldMeta, GridConfig } from '@riosoma/contracts';
import { MenuItem, MenuTrigger, Popover } from '@riosoma/ui';
import {
  ResponsiveToolbar,
  useToolbarOverflowTrigger,
  type ResponsiveToolbarItem,
} from '../../../components/ResponsiveToolbar';
import {
  faArrowDownWideShort,
  faArrowUpFromBracket,
  faEyeSlash,
  faFilter,
  faLinesLeaning,
  faPalette,
  faLayerGroup,
  faLock,
  faLockOpen,
} from '@fortawesome/free-solid-svg-icons';
import type { DatabaseSession } from '../../../data';
import { FilterEditor } from './FilterEditor';
import { SortEditor } from './SortEditor';
import { ColorEditor } from './ColorEditor';
import { HideFieldsEditor } from './HideFieldsEditor';
import { RowHeightMenu } from './RowHeightMenu';
import { conditionsOf, emptyCollaborators } from './filterValues';
import { namedFields, useRestrictedFields } from '../permissions/restricted';
import type { Collaborators } from './filterValues';
import { useLevel } from '../../../levels/context';
import { anchor } from '../../../demos/anchors';
import { useToolbarSettings } from './ToolbarSettings';
import './view.css';
import { HelpButton } from '../../../docs/HelpButton';

/** The overflow menu: what a view's own menu offers, for a row too narrow to show the view tabs. */
export interface ViewToolbarDownloads {
  csv: string;
  xlsx: string;
  /** Word and PowerPoint, which open a dialog for a title before they download */
  docx?: string;
  pptx?: string;
  /** A download is running somewhere, so no second one can start. */
  busy: boolean;
  /** This view's own download is running, which the button shows. */
  pending: boolean;
  onDownload(format: ExportFormat): void;
  /** Printing or saving as a PDF, for the views that print */
  pdf?: { label: string; onAction(): void };
  /** The view's scheduled reports, which need only read access too */
  reports?: { label: string; onAction(): void };
  /** Subscribing in a calendar app, for calendars, timelines, and Gantt charts */
  subscribe?: { label: string; onAction(): void };
}

export interface ViewToolbarProps {
  config: GridConfig;
  session?: DatabaseSession;
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  collaborators?: Collaborators;
  readOnly?: boolean;
  /** Offers conditional colors, for views that draw them.  People who can't edit see only the colors. */
  colorable?: boolean;
  groupable?: boolean;
  usesToolbar?: boolean;
  downloads?: ViewToolbarDownloads;
  /** Opens the conditional colors from elsewhere, such as the palette */
  colorsOpen?: boolean;
  onColorsOpenChange?(open: boolean): void;
  /** The Sync out control at the end of the toolbar, when the person may set one up on this view */
  syncOut?: { label: string; onAction(): void; onPreload?(): void };
  onConfigChange: (patch: Partial<GridConfig>) => void;
}

function EditorControl({
  helpId,
  label,
  isOpen,
  onOpenChange,
  overflow,
  button,
  children,
}: {
  helpId: string;
  label: string;
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  overflow: boolean;
  button: ReactNode;
  children: ReactNode;
}) {
  const moreRef = useToolbarOverflowTrigger();
  return (
    <DialogTrigger
      isOpen={isOpen}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && overflow) requestAnimationFrame(() => moreRef.current?.querySelector('button')?.focus());
      }}
    >
      {button}
      <Popover
        placement="bottom start"
        className="rio-view-popover"
        {...(overflow ? { triggerRef: moreRef } : {})}
      >
        <Dialog aria-label={label} className="rio-view-dialog">
          <div
            className="rio-help-heading"
            data-anchor={helpId === 'hide' ? 'view.settings.grid' : `view.${helpId}`}
          >
            <span>{label}</span>
            <HelpButton
              subject={label}
              moduleId={helpId === 'color' ? 'conditional-colors' : 'views'}
              section={
                {
                  filter: 'filter',
                  sort: 'sort',
                  group: 'group-records-in-a-grid',
                  hide: 'hide-fields-and-row-height',
                  color: 'rules',
                }[helpId]
              }
              onPress={() => onOpenChange(false)}
            />
          </div>
          {children}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function HeightControl({
  isOpen,
  onOpenChange,
  overflow,
  button,
  config,
  readOnly,
  onChange,
}: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  overflow: boolean;
  button: ReactNode;
  config: GridConfig;
  readOnly: boolean;
  onChange(patch: Partial<GridConfig>): void;
}) {
  const moreRef = useToolbarOverflowTrigger();
  return (
    <MenuTrigger
      isOpen={isOpen}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && overflow) requestAnimationFrame(() => moreRef.current?.querySelector('button')?.focus());
      }}
    >
      {button}
      <RowHeightMenu
        value={config.rowHeight}
        readOnly={readOnly}
        triggerRef={overflow ? moreRef : undefined}
        onChange={(rowHeight) => onChange({ rowHeight })}
      />
    </MenuTrigger>
  );
}

export function ViewToolbar({
  config,
  session,
  fields,
  primaryFieldId,
  collaborators = emptyCollaborators,
  readOnly = false,
  colorable = false,
  groupable = false,
  usesToolbar = true,
  downloads,
  colorsOpen,
  onColorsOpenChange,
  syncOut,
  onConfigChange,
}: ViewToolbarProps) {
  const { t } = useLingui();
  const settings = useToolbarSettings();
  const [open, setOpen] = useState<string | null>(null);
  const canLock = !readOnly;
  const lockLabel = config.locked
    ? t({ id: 'locks.view.unlock', message: 'Unlock view' })
    : t({ id: 'locks.view.lock', message: 'Lock view' });
  const readOnlyReason =
    config.locked && canLock
      ? t({ id: 'sortable.viewLocked', message: 'This view is locked.' })
      : t({ id: 'sortable.readOnly', message: 'You don’t have permission to rearrange these items.' });
  readOnly = readOnly || config.locked;
  const { offers } = useLevel();
  const restricted = useRestrictedFields();
  const byId = new Map(fields.map((field) => [field.id, field]));
  const hiddenCount = new Set(config.hiddenFieldIds.filter((id) => id !== primaryFieldId && byId.has(id)))
    .size;
  const filterIds = namedFields(
    conditionsOf(config.filter).map((condition) => condition.fieldId),
    fields,
    restricted,
  );
  const sortIds = namedFields(
    config.sorts.map((sort) => sort.fieldId),
    fields,
    restricted,
  );
  const filterName = filterIds.length === 1 ? byId.get(filterIds[0]!)?.name : undefined;
  const sortName = sortIds.length === 1 ? byId.get(sortIds[0]!)?.name : undefined;
  const filterCount = filterIds.length;
  const sortCount = sortIds.length;
  function hiddenLabel(count: number) {
    return count
      ? t({
          id: 'view.toolbar.hidden',
          message: plural(count, { one: '# hidden field', other: '# hidden fields' }),
        })
      : t({ id: 'view.toolbar.hide', message: 'Hide fields' });
  }
  function filteredLabel(count: number, name: string | undefined) {
    return !count
      ? t({ id: 'view.toolbar.filter', message: 'Filter' })
      : name
        ? t({ id: 'view.toolbar.filteredBy', message: `Filtered by ${name}` })
        : t({
            id: 'view.toolbar.filteredByMany',
            message: plural(count, { one: 'Filtered by # field', other: 'Filtered by # fields' }),
          });
  }
  function sortedLabel(count: number, name: string | undefined) {
    return !count
      ? t({ id: 'view.toolbar.sort', message: 'Sort' })
      : name
        ? t({ id: 'view.toolbar.sortedBy', message: `Sorted by ${name}` })
        : t({
            id: 'view.toolbar.sortedByMany',
            message: plural(count, { one: 'Sorted by # field', other: 'Sorted by # fields' }),
          });
  }
  const colorCount =
    config.colorRules.length +
    config.colorScales.length +
    config.dataBars.length +
    config.iconSets.length +
    config.sparklines.length;
  const colorLabel = colorCount
    ? t({
        id: 'views.color.toolbar.count',
        message: plural(colorCount, { one: '# color rule', other: '# color rules' }),
      })
    : t({ id: 'views.color.toolbar', message: 'Color' });
  const hideLabel = hiddenLabel(hiddenCount);
  const filterLabel = filteredLabel(filterCount, filterName);
  const sortLabel = sortedLabel(sortCount, sortName);
  function change(patch: Partial<GridConfig>) {
    if (!readOnly) onConfigChange(patch);
  }
  function editor(
    item: Omit<ResponsiveToolbarItem, 'onAction' | 'render'> & { dialogLabel?: string },
    children: ReactNode,
  ): ResponsiveToolbarItem {
    const isOpen = item.id === 'color' && onColorsOpenChange ? Boolean(colorsOpen) : open === item.id;
    const onOpenChange = (next: boolean) => {
      if (item.id === 'color') onColorsOpenChange?.(next);
      setOpen(next ? item.id : null);
    };
    return {
      ...item,
      onAction: () => onOpenChange(true),
      render: (button, { overflow }) => (
        <EditorControl
          helpId={item.id}
          label={item.dialogLabel ?? item.label}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          overflow={overflow}
          button={button}
        >
          {children}
        </EditorControl>
      ),
    };
  }
  const items: ResponsiveToolbarItem[] = [
    editor(
      {
        id: 'hide',
        label: hideLabel,
        icon: faEyeSlash,
        priority: 70,
        active: hiddenCount > 0,
        count: hiddenCount,
        shortLabel: hiddenCount
          ? t({
              id: 'view.toolbar.hiddenShort',
              message: plural(hiddenCount, { one: '# hidden', other: '# hidden' }),
            })
          : undefined,
        buttonProps: anchor('view.hide'),
      },
      <HideFieldsEditor
        fields={fields}
        primaryFieldId={primaryFieldId}
        fieldOrder={config.fieldOrder}
        hiddenFieldIds={config.hiddenFieldIds}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        onChange={change}
      />,
    ),
    editor(
      {
        id: 'filter',
        label: filterLabel,
        icon: faFilter,
        priority: 100,
        active: filterCount > 0,
        count: filterCount,
        shortLabel: filterCount
          ? t({
              id: 'view.toolbar.filtersShort',
              message: plural(filterCount, { one: '# filter', other: '# filters' }),
            })
          : undefined,
        buttonProps: anchor('view.filter'),
      },
      <FilterEditor
        session={session}
        fields={fields}
        primaryFieldId={primaryFieldId}
        collaborators={collaborators}
        value={config.filter}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        onChange={(filter) => change({ filter })}
        addAnchor={anchor('view.filter.add')}
      />,
    ),
    editor(
      {
        id: 'sort',
        label: sortLabel,
        icon: faArrowDownWideShort,
        priority: 90,
        active: sortCount > 0,
        count: sortCount,
        shortLabel: sortCount
          ? t({
              id: 'view.toolbar.sortsShort',
              message: plural(sortCount, { one: '# sort', other: '# sorts' }),
            })
          : undefined,
        buttonProps: anchor('view.sort'),
      },
      <SortEditor
        fields={fields}
        value={config.sorts}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        onChange={(sorts) => change({ sorts })}
      />,
    ),
  ];
  const groupCount = config.groups.length;
  if (groupable)
    items.push(
      editor(
        {
          id: 'group',
          dialogLabel: t({ id: 'view.toolbar.group', message: 'Group' }),
          label: groupCount
            ? t({
                id: 'view.toolbar.groupedByMany',
                message: plural(groupCount, { one: 'Grouped by # field', other: 'Grouped by # fields' }),
              })
            : t({ id: 'view.toolbar.group', message: 'Group' }),
          icon: faLayerGroup,
          priority: 80,
          active: groupCount > 0,
          count: groupCount,
          shortLabel: groupCount
            ? t({
                id: 'view.toolbar.groupsShort',
                message: plural(groupCount, { one: '# group', other: '# groups' }),
              })
            : undefined,
          buttonProps: anchor('view.group'),
        },
        <SortEditor
          grouping
          fields={fields}
          value={config.groups}
          readOnly={readOnly}
          readOnlyReason={readOnlyReason}
          onChange={(groups) => change({ groups })}
        />,
      ),
    );
  if (
    colorable &&
    !readOnly &&
    (offers('viewToolbar', 'colors', { coloredViews: colorCount > 0 ? 1 : 0 }) || colorsOpen)
  ) {
    items.push(
      editor(
        {
          id: 'color',
          buttonProps: anchor('view.color'),
          label: colorLabel,
          icon: faPalette,
          priority: 60,
          active: colorCount > 0,
          count: colorCount,
          shortLabel: colorCount
            ? t({
                id: 'view.toolbar.rulesShort',
                message: plural(colorCount, { one: '# rule', other: '# rules' }),
              })
            : undefined,
        },
        <ColorEditor
          session={session}
          fields={fields}
          primaryFieldId={primaryFieldId}
          collaborators={collaborators}
          value={config}
          onChange={change}
        />,
      ),
    );
  }
  items.push({
    id: 'height',
    label: t({ id: 'view.toolbar.rowHeight', message: 'Row height' }),
    icon: faLinesLeaning,
    priority: 50,
    active: config.rowHeight !== 'short',
    onAction: () => setOpen('height'),
    render: (button, { overflow }) => (
      <HeightControl
        isOpen={open === 'height'}
        onOpenChange={(next) => setOpen(next ? 'height' : null)}
        overflow={overflow}
        button={button}
        config={config}
        readOnly={readOnly}
        onChange={change}
      />
    ),
  });
  if (canLock || config.locked)
    items.push({
      id: 'lock',
      label: canLock ? lockLabel : t({ id: 'locks.view.locked', message: 'Locked view' }),
      icon: config.locked ? faLock : faLockOpen,
      priority: 40,
      active: config.locked,
      status: !canLock,
      onAction: () => {
        if (canLock) onConfigChange({ locked: !config.locked });
      },
    });
  const syncOutItem: ResponsiveToolbarItem[] = syncOut
    ? [
        {
          id: 'syncOut',
          label: syncOut.label,
          icon: faArrowUpFromBracket,
          priority: -10,
          buttonProps: anchor('view.syncOut'),
          onAction: syncOut.onAction,
          ...(syncOut.onPreload ? { onPreload: syncOut.onPreload } : {}),
        },
      ]
    : [];
  return (
    <div className="rio-view-toolbar-container">
      <ResponsiveToolbar
        items={[...(usesToolbar ? items : []), ...settings, ...syncOutItem]}
        className="rio-view-toolbar"
        label={t({ id: 'view.toolbar.label', message: 'View controls' })}
        toolbarProps={anchor('view.toolbar')}
        morePending={downloads?.pending}
        moreItems={
          downloads ? (
            <>
              <MenuItem isDisabled={downloads.busy} onAction={() => downloads.onDownload('csv')}>
                {downloads.csv}
              </MenuItem>
              <MenuItem isDisabled={downloads.busy} onAction={() => downloads.onDownload('xlsx')}>
                {downloads.xlsx}
              </MenuItem>
              {downloads.docx ? (
                <MenuItem isDisabled={downloads.busy} onAction={() => downloads.onDownload('docx')}>
                  {downloads.docx}
                </MenuItem>
              ) : null}
              {downloads.pptx ? (
                <MenuItem isDisabled={downloads.busy} onAction={() => downloads.onDownload('pptx')}>
                  {downloads.pptx}
                </MenuItem>
              ) : null}
              {downloads.pdf ? (
                <MenuItem onAction={downloads.pdf.onAction}>{downloads.pdf.label}</MenuItem>
              ) : null}
              {downloads.reports ? (
                <MenuItem onAction={downloads.reports.onAction}>{downloads.reports.label}</MenuItem>
              ) : null}
              {downloads.subscribe ? (
                <MenuItem onAction={downloads.subscribe.onAction}>{downloads.subscribe.label}</MenuItem>
              ) : null}
            </>
          ) : undefined
        }
      />
    </div>
  );
}
