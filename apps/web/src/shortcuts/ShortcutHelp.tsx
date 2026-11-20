import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useLocation, useMatches } from '@tanstack/react-router';
import { Dialog, DialogBody, DialogTitle, Modal, SearchField } from '@riosoma/ui';
import { useDatabaseSession, useSchema } from '../data/hooks';
import { filterShortcutGroups, isAppleDevice, shortcutGroups, shortcutKeyParts } from './registry';
import './ShortcutHelp.css';

export function ShortcutHelp({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState('');
  const location = useLocation();
  const matches = useMatches();
  const params = Object.assign({}, ...matches.map((match) => match.params)) as {
    databaseId?: string;
    viewId?: string;
    recordId?: string;
  };
  const session = useDatabaseSession(params.databaseId ?? null);
  const schema = useSchema(session);
  const view = schema?.viewById.get(params.viewId ?? '');
  const current = /^\/(settings|admin)(\/|$)/.test(location.pathname)
    ? ['settings', 'general']
    : params.recordId
      ? ['records', view?.type ?? '', 'general', 'reordering']
      : [view?.type ?? '', ...(params.databaseId ? ['records'] : []), 'general', 'reordering'];
  const groups = filterShortcutGroups(
    shortcutGroups(current),
    query,
    (label) => i18n._(label),
    isAppleDevice(),
  );
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className={`rio-shortcuts-modal${groups.length <= 1 ? ' rio-shortcuts-modal--compact' : groups.length === 2 ? ' rio-shortcuts-modal--medium' : ''}`}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="shortcuts.title">Keyboard shortcuts</Trans>
        </DialogTitle>
        <div
          onKeyDownCapture={(event) => {
            // Escape closes this panel even when the filter has a query to clear.
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }
          }}
        >
          <SearchField
            autoFocus
            aria-label={t({ id: 'shortcuts.filter', message: 'Filter shortcuts' })}
            placeholder={t({ id: 'shortcuts.filter', message: 'Filter shortcuts' })}
            value={query}
            onChange={setQuery}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </div>
        <DialogBody className="rio-shortcuts-body" tabIndex={0}>
          {groups.length ? (
            <div className="rio-shortcuts-groups">
              {groups.map((group) => (
                <section
                  key={group.context}
                  className="rio-shortcuts-group"
                  aria-labelledby={`shortcuts-${group.context}`}
                >
                  <h3 id={`shortcuts-${group.context}`}>{i18n._(group.label)}</h3>
                  <dl>
                    {group.shortcuts.map((shortcut) => (
                      <div key={shortcut.id} className="rio-shortcuts-row" data-shortcut={shortcut.id}>
                        <dt>{i18n._(shortcut.label)}</dt>
                        <dd>
                          {shortcutKeyParts(shortcut.id).map((keys) => (
                            <kbd key={keys}>{keys}</kbd>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ) : (
            <p role="status">
              <Trans id="shortcuts.empty">No shortcuts match your filter.</Trans>
            </p>
          )}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
