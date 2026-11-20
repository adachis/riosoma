import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { DEFAULT_TRASH_WINDOW, type TrashWindow } from '@riosoma/contracts';
import { Button } from '@riosoma/ui';
import type { ReactNode } from 'react';
import { useMinuteClock, useRelativeTime } from '../../relative-time';
import './trash.css';

export function TrashEntry({
  name,
  trashedAt,
  deletedBy,
  kind,
  retention,
  onRestore,
  pending,
  disabled,
}: {
  name: string;
  trashedAt: string;
  deletedBy?: string;
  kind?: ReactNode;
  /** The window the administrator chose, which the countdown and Restore both follow */
  retention?: TrashWindow;
  onRestore(): void;
  pending: boolean;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const now = useMinuteClock();
  const when = useRelativeTime(trashedAt);
  const age = Math.max(0, now - Date.parse(trashedAt));
  const { days, legalHold } = retention ?? DEFAULT_TRASH_WINDOW;
  // A hold or a policy with no limit keeps the item, so there is nothing to count down to.
  const count = days === null ? null : Math.max(0, Math.ceil(days - age / 86_400_000));
  return (
    <li className="rio-trash-entry">
      <div className="rio-trash-entry__text">
        <strong>{name}</strong>
        {kind}
        <time dateTime={trashedAt}>
          <DeletionTime name={deletedBy} when={when} />
        </time>
        <span>
          {count === null ? (
            legalHold ? (
              <Trans id="trash.held">Kept while a legal hold is on</Trans>
            ) : (
              <Trans id="trash.kept">Kept with no time limit</Trans>
            )
          ) : (
            t({
              id: 'trash.daysLeft',
              message: plural(count, { one: 'Gone for good in # day', other: 'Gone for good in # days' }),
            })
          )}
        </span>
      </div>
      <Button
        onPress={(event) => {
          // The restored row disappears; keep keyboard focus inside the dialog.
          event.target.closest<HTMLElement>('[role="dialog"]')?.focus();
          onRestore();
        }}
        isPending={pending}
        isDisabled={disabled || count === 0}
        aria-label={t({ id: 'trash.restoreName', message: `Restore ${name}` })}
      >
        <Trans id="trash.restore">Restore</Trans>
      </Button>
    </li>
  );
}

function DeletionTime({ name, when }: { name?: string; when: string }) {
  const { t } = useLingui();
  return name
    ? t({ id: 'trash.deletedBy', message: `Deleted by ${name} ${when}` })
    : t({ id: 'trash.deleted', message: `Deleted ${when}` });
}
