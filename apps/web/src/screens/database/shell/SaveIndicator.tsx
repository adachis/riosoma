import { faCheck, faCloudArrowUp } from '@fortawesome/free-solid-svg-icons';
import { Plural, useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import { Button, Spinner, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Focusable } from 'react-aria-components';
import type { SaveState } from '../../../data/types';
import './shell.css';

function SaveMessage({ status, children }: { status: SaveState['status']; children: ReactNode }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setFaded(true), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <span className="rio-db-save__message" data-faded={faded || status === 'idle' || undefined}>
      {children}
    </span>
  );
}

export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  const { t } = useLingui();
  if (state.retryRequired && onRetry)
    return (
      <Button size="sm" onPress={onRetry}>
        {t({ id: 'database.save.retry', message: 'Retry unsaved changes' })}
      </Button>
    );
  const count = state.pending;
  const labels = {
    idle: '',
    saving: t({ id: 'database.save.saving', message: 'Saving…' }),
    saved: t({ id: 'database.save.saved', message: 'Saved' }),
    offline: t({ id: 'database.save.offline', message: 'Offline' }),
    error: t({ id: 'database.save.error', message: 'Retrying…' }),
  };
  const message = (
    <>
      <span className="rio-db-save__icon" aria-hidden="true">
        {state.status === 'saving' ? (
          <Spinner size="sm" />
        ) : state.status === 'saved' ? (
          <Icon icon={faCheck} />
        ) : state.status === 'offline' ? (
          <Icon icon={faCloudArrowUp} />
        ) : null}
      </span>
      <span className="rio-db-save__label">{labels[state.status]}</span>
    </>
  );
  return (
    <span className="rio-db-save" title={labels[state.status]}>
      {/* All translated states reserve the same space, including after the saved message fades. */}
      {Object.values(labels).map((label, index) => (
        <span key={index} className="rio-db-save__measure" aria-hidden="true">
          <span className="rio-db-save__icon" />
          {label}
        </span>
      ))}
      <span className="rio-db-save__live" role="status" aria-live="polite" aria-atomic="true">
        <SaveMessage key={state.status} status={state.status}>
          {state.status === 'offline' ? (
            <TooltipTrigger>
              <Focusable>
                <span tabIndex={0} className="rio-db-save__offline">
                  {message}
                </span>
              </Focusable>
              <Tooltip>
                <Plural
                  id="database.save.offlineDetail"
                  value={count}
                  one="# change waits to be saved."
                  other="# changes wait to be saved."
                />
              </Tooltip>
            </TooltipTrigger>
          ) : (
            message
          )}
        </SaveMessage>
      </span>
    </span>
  );
}
