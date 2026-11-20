import { useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { UpdateStatus } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import { useSession } from '../../session';
import { runsServer, updatesQuery } from './query';
import { lazyFeature, LazyBoundary } from '../../shell/lazy';
import './UpdateNotice.css';

const PopoverSurface = lazyFeature(() =>
  import('../../shell/PopoverSurface').then((module) => ({ default: module.PopoverSurface })),
);
const UpdateDetails = lazyFeature(() =>
  import('./UpdateDetails').then((module) => ({ default: module.UpdateDetails })),
);

/** The notice asks again this often while the app is open, and the server checks the feed daily. */
const LOOK_EVERY_MS = 60 * 60_000;

/**
 * A quiet notice in the shell when a newer release is out, for the owner and admins only.  A
 * security release makes it stronger.  It opens the release's notes, with a way to the update
 * settings and to help.
 */
export function UpdateNotice() {
  const session = useSession();
  const allowed = runsServer(session);
  const query = useQuery({
    ...updatesQuery,
    enabled: allowed,
    staleTime: LOOK_EVERY_MS,
    refetchInterval: LOOK_EVERY_MS,
  });
  if (!allowed || !query.data?.available.length) return null;
  return <Notice status={query.data} />;
}

function Notice({ status }: { status: UpdateStatus }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const preload = () => {
    PopoverSurface.preload();
    UpdateDetails.preload();
  };
  const latest = status.available[0]!;
  const version = latest.version;
  const shown = status.security
    ? t({ id: 'updates.notice.security', message: 'Security update' })
    : t({ id: 'updates.notice.available', message: 'Update available' });
  const title = t({ id: 'updates.notice.title', message: `Riosoma ${version} is available` });
  return (
    <>
      <span
        ref={(element) => {
          trigger.current = element?.querySelector('button') ?? null;
        }}
        className="rio-deferred-menu-trigger"
      >
        <Button
          variant="quiet"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={open}
          onHoverStart={preload}
          onFocus={preload}
          onPress={() => setOpen(!open)}
          className={status.security ? 'rio-update-notice rio-update-notice--security' : 'rio-update-notice'}
          aria-label={t({ id: 'updates.notice.label', message: `${shown}: Riosoma ${version}` })}
        >
          {shown}
        </Button>
      </span>
      {open && (
        <LazyBoundary size="popover" triggerRef={trigger}>
          <PopoverSurface
            triggerRef={trigger}
            onClose={() => setOpen(false)}
            title={title}
            className="rio-update-notice__popover"
            dialogClassName="rio-update-notice__dialog"
          >
            <UpdateDetails status={status} title={title} onClose={() => setOpen(false)} />
          </PopoverSurface>
        </LazyBoundary>
      )}
    </>
  );
}
