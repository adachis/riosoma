import { useLingui } from '@lingui/react/macro';
import { shortcutFromHref, SHORTCUT_DRAG_TYPE, useAddShortcut } from '../../home/shortcuts';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { Button, ConfirmDialog, Menu, MenuItem, MenuSeparator, MenuTrigger } from '@riosoma/ui';
import { useRef, useState, type AnchorHTMLAttributes } from 'react';
import type { ExportFormat } from '@riosoma/contracts';
import { InlineName } from './InlineName';
import { navigateOnPlainClick } from './navigation';
import type { AnchorProps } from '../../../demos/anchors';

export interface NamedLinkCopy {
  menu: string;
  rename: string;
  duplicate?: string;
  delete: string;
  deleteTitle: string;
  deleteBody: string;
  deleteConfirm: string;
}

/** Downloading needs only read access, so a reader with nothing to edit still gets a menu. */
export interface NamedLinkDownloads {
  csv: string;
  xlsx: string;
  /** Word and PowerPoint, which open a dialog for a title before they download */
  docx?: string;
  pptx?: string;
  /** A download is running somewhere, so no second one can start. */
  busy: boolean;
  /** This view's own download is running, which its button shows. */
  pending: boolean;
  onDownload(format: ExportFormat): void;
  /** Printing or saving as a PDF, for the views that print */
  pdf?: { label: string; onAction(): void };
  /** The view's scheduled reports, which a reader can set up for themselves */
  reports?: { label: string; onAction(): void };
  /** Subscribing in a calendar app, for calendars, timelines, and Gantt charts */
  subscribe?: { label: string; onAction(): void };
}

export interface NamedLinkProps {
  name: string;
  href: string;
  active: boolean;
  icon: IconDefinition;
  canEdit: boolean;
  canDelete: boolean;
  copy: NamedLinkCopy;
  downloads?: NamedLinkDownloads;
  onNavigate(): void;
  onPreload?(): void;
  onRename(name: string): void;
  onDelete(): void;
  onDuplicate?: () => void;
  /** More menu items, shown before deleting.  Each label is already translated. */
  actions?: ReadonlyArray<{ id: string; label: string; canUse?: boolean; onAction(): void }>;
  /**
   * Names particular items of the menu for help and demos, by their key.  An item a demo may press
   * gets an anchor of its own, since the menu as a whole holds items that save.
   */
  itemAnchors?: Readonly<Record<string, AnchorProps>>;
  linkProps?: Pick<
    AnchorHTMLAttributes<HTMLAnchorElement>,
    'onKeyDown' | 'aria-keyshortcuts' | 'aria-description' | 'aria-describedby'
  >;
  /** Names the item's menu button for help, when it's the one help explains */
  menuAnchor?: AnchorProps;
}

export function NamedLink({
  name,
  href,
  active,
  icon,
  canEdit,
  canDelete,
  copy,
  downloads,
  onNavigate,
  onPreload,
  onRename,
  onDelete,
  onDuplicate,
  actions,
  itemAnchors,
  linkProps,
  menuAnchor,
}: NamedLinkProps) {
  const { t } = useLingui();
  const shortcut = shortcutFromHref(href);
  const addShortcut = useAddShortcut();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const link = useRef<HTMLAnchorElement>(null);
  const availableActions = actions?.filter((action) => action.canUse ?? canEdit) ?? [];
  /** What names one of this menu's items, when help explains it. */
  const item = (id: string): AnchorProps | Record<string, never> => itemAnchors?.[id] ?? {};
  const finish = (restoreFocus = true) => {
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => link.current?.focus());
  };
  return (
    <>
      <div className="rio-db-named-link" data-active={active || undefined}>
        {editing && canEdit ? (
          <InlineName
            name={name}
            label={copy.rename}
            onCancel={finish}
            onSave={(value) => {
              onRename(value);
              finish();
            }}
          />
        ) : (
          <a
            {...linkProps}
            draggable={Boolean(shortcut)}
            onDragStart={(event) => {
              if (!shortcut) return;
              if (!canEdit) event.stopPropagation();
              event.dataTransfer.effectAllowed = 'copyMove';
              event.dataTransfer.setData(SHORTCUT_DRAG_TYPE, JSON.stringify(shortcut));
            }}
            ref={link}
            href={href}
            onMouseEnter={onPreload}
            onFocus={onPreload}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => navigateOnPlainClick(event, onNavigate)}
          >
            <Icon icon={icon} />
            <span title={name}>{name}</span>
          </a>
        )}
        {canEdit || downloads || shortcut || availableActions.length ? (
          <MenuTrigger>
            <Button
              className="rio-db-item-menu"
              variant="quiet"
              size="sm"
              icon={faEllipsis}
              aria-label={copy.menu}
              isPending={downloads?.pending}
              {...menuAnchor}
            />
            <Menu aria-label={copy.menu}>
              {shortcut ? (
                <MenuItem id="home-shortcut" onAction={() => addShortcut(shortcut)}>
                  {t({ id: 'home.shortcuts.add', message: 'Add shortcut to home' })}
                </MenuItem>
              ) : null}
              {downloads ? (
                <>
                  <MenuItem
                    id="csv"
                    {...item('csv')}
                    isDisabled={downloads.busy}
                    onAction={() => downloads.onDownload('csv')}
                  >
                    {downloads.csv}
                  </MenuItem>
                  <MenuItem
                    id="xlsx"
                    {...item('xlsx')}
                    isDisabled={downloads.busy}
                    onAction={() => downloads.onDownload('xlsx')}
                  >
                    {downloads.xlsx}
                  </MenuItem>
                  {downloads.docx ? (
                    <MenuItem
                      id="docx"
                      {...item('docx')}
                      isDisabled={downloads.busy}
                      onAction={() => downloads.onDownload('docx')}
                    >
                      {downloads.docx}
                    </MenuItem>
                  ) : null}
                  {downloads.pptx ? (
                    <MenuItem
                      id="pptx"
                      {...item('pptx')}
                      isDisabled={downloads.busy}
                      onAction={() => downloads.onDownload('pptx')}
                    >
                      {downloads.pptx}
                    </MenuItem>
                  ) : null}
                  {downloads.pdf ? (
                    <MenuItem id="pdf" {...item('pdf')} onAction={downloads.pdf.onAction}>
                      {downloads.pdf.label}
                    </MenuItem>
                  ) : null}
                  {downloads.reports ? (
                    <MenuItem id="reports" {...item('reports')} onAction={downloads.reports.onAction}>
                      {downloads.reports.label}
                    </MenuItem>
                  ) : null}
                  {downloads.subscribe ? (
                    <MenuItem id="subscribe" {...item('subscribe')} onAction={downloads.subscribe.onAction}>
                      {downloads.subscribe.label}
                    </MenuItem>
                  ) : null}
                  {canEdit ? <MenuSeparator /> : null}
                </>
              ) : null}
              {canEdit ? (
                <MenuItem id="rename" onAction={() => setEditing(true)}>
                  {copy.rename}
                </MenuItem>
              ) : null}
              {canEdit && onDuplicate ? (
                <MenuItem id="duplicate" onAction={onDuplicate}>
                  {copy.duplicate}
                </MenuItem>
              ) : null}
              {availableActions.map((action) => (
                <MenuItem key={action.id} id={action.id} {...item(action.id)} onAction={action.onAction}>
                  {action.label}
                </MenuItem>
              ))}
              {canEdit ? (
                <MenuItem
                  id="delete"
                  tone="danger"
                  isDisabled={!canDelete}
                  onAction={() => setDeleting(true)}
                >
                  {copy.delete}
                </MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={deleting && canEdit && canDelete}
        onOpenChange={setDeleting}
        title={copy.deleteTitle}
        message={copy.deleteBody}
        confirmLabel={copy.deleteConfirm}
        tone="danger"
        onConfirm={onDelete}
      />
    </>
  );
}
