import { faChevronDown, faPlus } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  isCalendarFeedViewType,
  isShareableViewType,
  VIEW_TYPES,
  type ViewMeta,
  type ViewType,
} from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Drawer,
  Menu,
  MenuItem,
  MenuTrigger,
  SearchField,
  SortableItem,
  SortableList,
  Toolbar,
} from '@riosoma/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFilter } from 'react-aria-components';
import { usePhone } from '../../../shell/useMediaQuery';
import type { ViewDownload } from '../view/download';
import { VIEW_DEFINITIONS } from '../views/registry';
import { printMenu } from '../print/messages';
import { reportsMenu } from '../../../features/reports/words';
import { subscribeMenu } from '../../../features/calendar-feeds/words';
import { isPrintableViewType } from '../print/options';
import { NamedLink, type NamedLinkProps } from './NamedLink';
import { useLevel } from '../../../levels/context';
import { useTrashPhrase } from '../../../features/retention/window';
import { anchor } from '../../../demos/anchors';
import './shell.css';

/** Past this many views, the phone's sheet of views offers a search. */
export const VIEW_SEARCH_THRESHOLD = 8;

export interface ViewTabsProps {
  views: readonly ViewMeta[];
  activeViewId: string | null;
  hrefFor(viewId: string): string;
  onNavigate(viewId: string): void;
  canEdit: boolean;
  onCreate(type: ViewType): void;
  onMove?(viewId: string, toIndex: number): void;
  onRename(viewId: string, name: string): void;
  onDuplicate(viewId: string): void;
  onDelete(viewId: string): void;
  /** Offered in every view's menu; a reader gets a menu with nothing but these. */
  downloads?: ViewDownload;
  /** Shares a grid, gallery, kanban, calendar, list, or map by link */
  onShare?(viewId: string): void;
  /** Prints a grid, gallery, or kanban, or saves it as a PDF */
  onPrint?(viewId: string): void;
  /** Opens a view's scheduled reports, for every view but a form */
  onReports?(viewId: string): void;
  /** Subscribes to a calendar, timeline, or Gantt chart in a calendar app */
  onSubscribe?(viewId: string): void;
}

/**
 * A table's views: a row of tabs, or on a phone, one button that names the current view and opens
 * a sheet of them all.
 */
export function ViewTabs(props: ViewTabsProps) {
  return usePhone() ? <ViewSwitcher {...props} /> : <ViewTabList {...props} />;
}

function ViewTabList(props: ViewTabsProps) {
  const { t } = useLingui();
  const { views, activeViewId, canEdit, onCreate } = props;
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeViewId, views]);
  const label = t({ id: 'database.views.label', message: 'Views' });
  return (
    <nav className="rio-db-views" aria-label={label} {...anchor('database.views')}>
      <SortableList
        items={views.map((view) => ({
          id: view.id,
          name: view.name,
          disabledReason: view.config.locked
            ? t({ id: 'view.locked', message: 'This view is locked.' })
            : undefined,
        }))}
        orientation="horizontal"
        disabledReason={
          !canEdit || !props.onMove
            ? t({ id: 'database.views.readOnly', message: 'You need permission to arrange views.' })
            : undefined
        }
        onMove={(from, to) => props.onMove?.(views[from]!.id, to)}
      >
        <ul ref={list} className="rio-db-view-list">
          <ViewLinks {...props} />
        </ul>
      </SortableList>
      {canEdit ? (
        <Toolbar aria-label={label} density="compact">
          <AddView views={views} onCreate={onCreate} />
        </Toolbar>
      ) : null}
    </nav>
  );
}

/**
 * The phone's view switcher.  Following a view, or starting something that opens a dialog of its
 * own, closes the sheet.  Renaming, deleting, and downloading happen in place.
 */
function ViewSwitcher(props: ViewTabsProps) {
  const { t } = useLingui();
  const { views, activeViewId, canEdit } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { contains } = useFilter({ sensitivity: 'base' });
  const list = useRef<HTMLUListElement>(null);
  const active = views.find((view) => view.id === activeViewId) ?? views[0];
  const searchable = views.length > VIEW_SEARCH_THRESHOLD;
  const needle = searchable ? query.trim() : '';
  const shown = needle ? views.filter((view) => contains(view.name, needle)) : views;
  const matches = shown.length;
  const label = t({ id: 'database.views.label', message: 'Views' });
  const searchLabel = t({ id: 'database.views.search', message: 'Find a view' });
  const closing =
    (action: ((viewId: string) => void) | undefined) =>
    (viewId: string): void => {
      setOpen(false);
      action?.(viewId);
    };
  // The current view is in sight from the sheet's first frame, so nothing scrolls under a finger
  // that is already reaching for a view.
  useLayoutEffect(() => {
    if (open) list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  return (
    <nav className="rio-db-views rio-db-views--phone" aria-label={label} {...anchor('database.views')}>
      <Button
        className="rio-db-view-switcher"
        variant="quiet"
        primaryAction
        icon={active ? VIEW_DEFINITIONS[active.type].icon : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPress={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        <span className="rio-db-view-switcher__name">{active?.name ?? label}</span>
        <Icon icon={faChevronDown} className="rio-db-view-switcher__chevron" />
      </Button>
      <Drawer side="bottom" isOpen={open} onOpenChange={setOpen} isDismissable>
        <Dialog className="rio-db-view-sheet">
          <DialogTitle>
            <Trans id="database.views.label">Views</Trans>
          </DialogTitle>
          {searchable ? (
            <SearchField
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={setQuery}
            />
          ) : null}
          <DialogBody>
            {shown.length ? (
              <SortableList
                items={views.map((view) => ({
                  id: view.id,
                  name: view.name,
                  disabledReason: view.config.locked
                    ? t({ id: 'view.locked', message: 'This view is locked.' })
                    : undefined,
                }))}
                disabledReason={
                  needle
                    ? t({ id: 'database.views.clearSearch', message: 'Clear the search to arrange views.' })
                    : !canEdit || !props.onMove
                      ? t({ id: 'database.views.readOnly', message: 'You need permission to arrange views.' })
                      : undefined
                }
                onMove={(from, to) => props.onMove?.(views[from]!.id, to)}
              >
                <ul ref={list} className="rio-db-view-sheet__list" aria-label={label}>
                  <ViewLinks
                    {...props}
                    views={shown}
                    canDelete={views.length > 1}
                    onNavigate={closing(props.onNavigate)}
                    onDuplicate={closing(props.onDuplicate)}
                    onShare={props.onShare && closing(props.onShare)}
                    onPrint={props.onPrint && closing(props.onPrint)}
                    onReports={props.onReports && closing(props.onReports)}
                    onSubscribe={props.onSubscribe && closing(props.onSubscribe)}
                  />
                </ul>
              </SortableList>
            ) : (
              <p className="rio-db-view-sheet__empty">
                {t({ id: 'database.views.noMatch', message: `No views match “${needle}”` })}
              </p>
            )}
            {/* The list narrows silently as a search is typed, so its size is read out. */}
            <span className="rio-visually-hidden" role="status">
              {needle
                ? t({
                    id: 'database.views.matches',
                    message: plural(matches, { one: '# view', other: '# views' }),
                  })
                : ''}
            </span>
          </DialogBody>
          {canEdit ? (
            <DialogFooter className="rio-db-view-sheet__footer">
              <AddView
                views={views}
                onCreate={(type) => {
                  setOpen(false);
                  props.onCreate(type);
                }}
              />
            </DialogFooter>
          ) : null}
        </Dialog>
      </Drawer>
    </nav>
  );
}

function AddView({ views, onCreate }: { views: readonly ViewMeta[]; onCreate(type: ViewType): void }) {
  const { t, i18n } = useLingui();
  const { offers } = useLevel();
  // The person's level decides which kinds of view to offer, and any kind the database already
  // has stays on offer.  Views that exist show as tabs at every level.
  const held = { viewTypes: new Set(views.map((view) => view.type)) };
  const types = VIEW_TYPES.filter((type) => offers('viewPicker', type, held));
  return (
    <MenuTrigger>
      <Button
        variant="quiet"
        icon={faPlus}
        {...anchor('database.views.add')}
        aria-label={t({ id: 'database.views.add', message: 'Add view' })}
      />
      <Menu
        aria-label={t({ id: 'database.views.add', message: 'Add view' })}
        onAction={(key) => {
          const type = types.find((item) => item === key);
          if (type) onCreate(type);
        }}
      >
        {types.map((type) => (
          <MenuItem id={type} key={type} icon={VIEW_DEFINITIONS[type].icon}>
            {i18n._(VIEW_DEFINITIONS[type].name)}
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}

/**
 * The anchors the open view's menu carries.  Help and a demo point at the view someone is looking
 * at, so only its menu has them, and only the items that open a dialog of their own.
 */
const OPEN_VIEW_ANCHORS = {
  menuAnchor: anchor('view.menu'),
  itemAnchors: { share: anchor('view.share'), reports: anchor('view.reports') },
} satisfies Partial<Pick<NamedLinkProps, 'menuAnchor' | 'itemAnchors'>>;

/** Each view as a list item: a link, and its menu. */
function ViewLinks({
  views,
  activeViewId,
  hrefFor,
  onNavigate,
  canEdit,
  canDelete = views.length > 1,
  onRename,
  onDuplicate,
  onDelete,
  downloads,
  onShare,
  onPrint,
  onReports,
  onSubscribe,
}: ViewTabsProps & { canDelete?: boolean }) {
  const { t, i18n } = useLingui();
  const trash = useTrashPhrase();
  return views.map(({ id, name, type }) => (
    <SortableItem id={id} key={id} as="li" className="rio-sidebar-sortable" altMoveScope="row">
      <>
        <NamedLink
          name={name}
          href={hrefFor(id)}
          active={activeViewId === id}
          {...(activeViewId === id ? OPEN_VIEW_ANCHORS : {})}
          icon={VIEW_DEFINITIONS[type].icon}
          canEdit={canEdit}
          canDelete={canDelete}
          onPreload={() => {
            VIEW_DEFINITIONS[type].View?.preload();
            VIEW_DEFINITIONS[type].Settings?.preload();
          }}
          onNavigate={() => onNavigate(id)}
          onRename={(value) => onRename(id, value)}
          onDelete={() => onDelete(id)}
          onDuplicate={() => onDuplicate(id)}
          actions={
            onShare && isShareableViewType(type)
              ? [
                  {
                    id: 'share',
                    label: t({ id: 'shareView.menu', message: 'Share view' }),
                    onAction: () => onShare(id),
                  },
                ]
              : undefined
          }
          downloads={
            downloads
              ? {
                  csv: downloads.labels.csv,
                  xlsx: downloads.labels.xlsx,
                  docx: downloads.labels.docx,
                  pptx: downloads.labels.pptx,
                  busy: downloads.pending !== null,
                  pending: downloads.pending?.viewId === id,
                  onDownload: (format) => downloads.download(id, format),
                  pdf:
                    onPrint && isPrintableViewType(type)
                      ? { label: i18n._(printMenu), onAction: () => onPrint(id) }
                      : undefined,
                  reports:
                    onReports && type !== 'form'
                      ? { label: i18n._(reportsMenu), onAction: () => onReports(id) }
                      : undefined,
                  subscribe:
                    onSubscribe && isCalendarFeedViewType(type)
                      ? { label: i18n._(subscribeMenu), onAction: () => onSubscribe(id) }
                      : undefined,
                }
              : undefined
          }
          copy={{
            menu: t({ id: 'database.views.menu', message: `More for ${name}` }),
            rename: t({ id: 'database.views.rename', message: 'Rename' }),
            duplicate: t({ id: 'database.views.duplicate', message: 'Duplicate' }),
            delete: t({ id: 'database.views.delete', message: 'Delete view' }),
            deleteTitle: t({ id: 'database.views.deleteTitle', message: `Delete ${name}?` }),
            deleteBody: t({
              id: 'database.views.deleteBody',
              message: `The view is deleted for everyone.  Its records stay in the table, and you can restore the view from the trash ${trash}.`,
            }),
            deleteConfirm: t({ id: 'database.views.deleteConfirm', message: 'Delete view' }),
          }}
        />
      </>
    </SortableItem>
  ));
}
