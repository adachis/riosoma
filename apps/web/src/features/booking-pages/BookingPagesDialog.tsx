import { EmbedPanel } from '../public-sharing/EmbedPanel';
import { faEllipsis, faCopy } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookingPage, FieldMeta, TableBookingPages } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Spinner,
  Switch,
  TextField,
} from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { bookingPagesKey, deleteBookingPage, listBookingPages, pageAddress, saveBookingPage } from './api';
import { BookingPageForm } from './BookingPageForm';
import { useCelebrations } from '../celebrations/useCelebrations';
import './booking-pages.css';

type Screen = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; page: BookingPage };

function PageItem({
  page,
  toggling,
  onToggle,
  onEdit,
  onDelete,
}: {
  page: BookingPage;
  toggling: boolean;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [copied, setCopied] = useState(false);
  const title = page.settings.title;
  const menu = t({ id: 'bookings.list.actions', message: `More for ${title}` });
  const url = pageAddress(page.url ?? page.path);
  const count = page.upcoming;
  const owner = page.owner?.name ?? '';
  const facts = useRef<HTMLParagraphElement>(null);
  const { observe } = useCelebrations();
  // Only pages made on this device were seen with no bookings, so only they can celebrate a first.
  useEffect(() => {
    if (count > 0) observe('bookingFirst', page.pageId, true, { anchor: facts.current, cause: 'others' });
  }, [count, page.pageId, observe]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard still shows the link, ready to select and copy.
    }
  }

  return (
    <li className="rio-booking-pages__item" data-enabled={page.enabled} data-booking-page={page.pageId}>
      <div className="rio-booking-pages__head">
        <Switch isSelected={page.enabled} isDisabled={toggling} onChange={onToggle}>
          {title}
        </Switch>
        <MenuTrigger>
          <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menu} />
          <Menu aria-label={menu}>
            <MenuItem id="edit" onAction={onEdit}>
              {t({ id: 'bookings.list.edit', message: 'Edit' })}
            </MenuItem>
            <MenuItem id="delete" tone="danger" onAction={onDelete}>
              {t({ id: 'bookings.list.delete', message: 'Delete' })}
            </MenuItem>
          </Menu>
        </MenuTrigger>
      </div>
      {page.problem ? <Banner tone="warning">{message(page.problem)}</Banner> : null}
      <div className="rio-booking-pages__link">
        <TextField label={t({ id: 'bookings.list.link', message: 'Public link' })} value={url} isReadOnly />
        <Button
          data-copy-link
          onPress={() => void copy()}
          aria-label={t({ id: 'bookings.list.copy', message: 'Copy link' })}
          icon={faCopy}
        />
      </div>
      <p className="rio-booking-pages__note" role="status">
        {copied ? t({ id: 'bookings.list.copied', message: 'Copied the link' }) : ''}
      </p>
      <p className="rio-booking-pages__facts" ref={facts}>
        {t({
          id: 'bookings.list.upcoming',
          message: plural(count, {
            0: 'No upcoming bookings',
            one: '# upcoming booking',
            other: '# upcoming bookings',
          }),
        })}
        {owner ? (
          <>
            {' · '}
            {t({ id: 'bookings.list.owner', message: `Bookings are added as ${owner}` })}
          </>
        ) : null}
      </p>
      <EmbedPanel target={{ kind: 'booking', linkId: page.pageId }} url={url} name={page.settings.title} />
    </li>
  );
}

export interface BookingPagesDialogProps {
  tableId: string;
  tableName: string;
  fields: readonly FieldMeta[];
  onClose(): void;
}

/** A table's booking pages: setting one up, changing it, turning it on or off, and deleting it. */
export function BookingPagesDialog({ tableId, tableName, fields, onClose }: BookingPagesDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const key = bookingPagesKey(tableId);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [deleting, setDeleting] = useState<BookingPage | null>(null);
  const { observe } = useCelebrations();
  const pages = useQuery({ queryKey: key, queryFn: ({ signal }) => listBookingPages(tableId, signal) });
  const store = (page: BookingPage) =>
    queryClient.setQueryData<TableBookingPages>(key, (current) =>
      current
        ? {
            ...current,
            pages: current.pages.some((item) => item.pageId === page.pageId)
              ? current.pages.map((item) => (item.pageId === page.pageId ? page : item))
              : [...current.pages, page],
          }
        : current,
    );
  const toggle = useMutation({
    mutationFn: ({ page, enabled }: { page: BookingPage; enabled: boolean }) =>
      saveBookingPage(page.pageId, { settings: page.settings, enabled }),
    onSuccess: store,
  });
  const remove = useMutation({
    mutationFn: (pageId: string) => deleteBookingPage(pageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const data = pages.data;
  const listed = useMemo(() => data?.pages ?? [], [data]);
  // The form had the focus, so going back to the list hands it to the page just saved, or back to
  // where the form was opened from, rather than letting it fall out of the dialog.
  const returnTo = useRef<{ pageId: string | null; saved: boolean } | null>(null);
  const back = (pageId: string | null = null, saved = false) => {
    returnTo.current = { pageId, saved };
    setScreen({ kind: 'list' });
  };
  useEffect(() => {
    const to = returnTo.current;
    if (screen.kind !== 'list' || !to) return;
    // A page just made shows once the list holds it.
    if (to.saved && !listed.some((page) => page.pageId === to.pageId)) return;
    returnTo.current = null;
    const item = to.pageId ? document.querySelector(`[data-booking-page="${to.pageId}"]`) : null;
    const target =
      item?.querySelector<HTMLElement>(to.saved ? '[data-copy-link]' : '[aria-haspopup]') ??
      document.querySelector<HTMLElement>('[data-booking-add]');
    target?.focus();
  }, [screen, listed]);
  const titles: Record<Screen['kind'], string> = {
    list: t({ id: 'bookings.title', message: 'Booking pages' }),
    add: t({ id: 'bookings.add.title', message: 'Make a booking page' }),
    edit: t({ id: 'bookings.edit.title', message: 'Edit booking page' }),
  };
  const add = (
    <Button variant="primary" data-booking-add onPress={() => setScreen({ kind: 'add' })}>
      {t({ id: 'bookings.add', message: 'Make a booking page' })}
    </Button>
  );
  const deletingTitle = deleting?.settings.title ?? '';

  return (
    <>
      <Modal
        isOpen
        isDismissable
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        size="lg"
      >
        <Dialog>
          <DialogTitle>{titles[screen.kind]}</DialogTitle>
          {screen.kind === 'add' || screen.kind === 'edit' ? (
            <BookingPageForm
              key={screen.kind === 'edit' ? screen.page.pageId : 'new'}
              tableId={tableId}
              tableName={tableName}
              fields={fields}
              {...(screen.kind === 'edit' ? { page: screen.page } : {})}
              onCancel={() => back(screen.kind === 'edit' ? screen.page.pageId : null)}
              onSaved={(page) => {
                // A new page has had no bookings yet, so its first one can be celebrated.
                if (screen.kind === 'add') observe('bookingFirst', page.pageId, page.upcoming > 0);
                store(page);
                back(page.pageId, true);
              }}
            />
          ) : (
            <DialogBody className="rio-booking-pages">
              <p className="rio-booking-pages__intro">
                {t({
                  id: 'bookings.intro',
                  message:
                    'A public page where anyone picks an open time and books it.  Each booking adds a record to this table, and nobody who books sees anyone else’s bookings.',
                })}
              </p>
              {data && !data.emailAvailable ? (
                <Banner tone="info">
                  {t({
                    id: 'bookings.noEmail',
                    message:
                      'This server isn’t set up to send email yet, so bookers get no confirmation or cancel link.',
                  })}
                </Banner>
              ) : null}
              <ErrorBanner error={errorInfo(pages.error ?? toggle.error)} />
              {pages.isPending ? (
                <Spinner label={t({ id: 'bookings.loading', message: 'Loading booking pages' })} />
              ) : listed.length === 0 ? (
                <div className="rio-booking-pages__empty">
                  <p>{t({ id: 'bookings.empty', message: 'No booking pages for this table yet.' })}</p>
                  {pages.isError ? null : add}
                </div>
              ) : (
                <>
                  <div className="rio-booking-pages__actions">{add}</div>
                  <ul className="rio-booking-pages__list">
                    {listed.map((page) => (
                      <PageItem
                        key={page.pageId}
                        page={page}
                        toggling={toggle.isPending && toggle.variables?.page.pageId === page.pageId}
                        onToggle={(enabled) => {
                          toggle.reset();
                          toggle.mutate({ page, enabled });
                        }}
                        onEdit={() => setScreen({ kind: 'edit', page })}
                        onDelete={() => {
                          remove.reset();
                          setDeleting(page);
                        }}
                      />
                    ))}
                  </ul>
                </>
              )}
            </DialogBody>
          )}
        </Dialog>
      </Modal>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'bookings.delete.title', message: 'Delete this booking page?' })}
          message={
            <>
              {t({
                id: 'bookings.delete.body',
                message: `${deletingTitle} stops taking bookings at once, and the cancel links it sent stop working.  Its records stay in the table.`,
              })}
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'bookings.list.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting.pageId)}
        />
      ) : null}
    </>
  );
}
