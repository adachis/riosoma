import type { ReactNode } from 'react';
import { Spinner } from '@riosoma/ui';
import './SettingsLoading.css';

/** The final controls reserve their own space without exposing unstored values or accepting input. */
export function SettingsLoading({ isPending, children }: { isPending: boolean; children: ReactNode }) {
  return (
    <div className="rio-settings-loading" aria-busy={isPending}>
      <div
        className="rio-settings-loading__content"
        aria-hidden={isPending || undefined}
        inert={isPending || undefined}
      >
        {children}
      </div>
      {isPending && <Spinner className="rio-settings-loading__indicator" />}
    </div>
  );
}
