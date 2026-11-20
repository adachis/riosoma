import { faArrowDown, faArrowUp, faRightLeft, faXmark } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { SEARCH_LIMITS } from '@riosoma/contracts';
import { Button, TextField } from '@riosoma/ui';
import { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { searchCommand } from '../../../../../packages/grid-core/src/keyboard';
import { serverMessage } from '../../messages/useServerMessage';
import type { FindController } from './find';
import './find.css';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * The bar Ctrl+F opens over the top of the grid.  Enter and Shift+Enter step through the matches,
 * Escape closes it and gives the grid its focus back, and people who may edit records can open
 * the replace row.
 */
export function FindBar({
  find,
  canReplace,
  onClose,
}: {
  find: FindController;
  canReplace: boolean;
  onClose(): void;
}) {
  const state = useSyncExternalStore(find.subscribe, find.getState);
  const { t, i18n } = useLingui();
  const bar = useRef<HTMLDivElement>(null);
  const replaceRow = useId();
  const replacing = state.mode === 'replace' && canReplace;

  useEffect(() => {
    if (!state.open) return;
    const input = bar.current?.querySelector<HTMLInputElement>('input[name="find"]');
    input?.focus();
    input?.select();
  }, [state.open, state.requests]);

  if (!state.open) return null;

  const close = () => {
    find.close();
    onClose();
  };
  const number = (value: number) => i18n.number(value);
  const position = number(state.current + 1);
  const total = number(state.total ?? 0);
  const count = state.searching
    ? t({ id: 'grid.find.searching', message: 'Searching…' })
    : state.total === null
      ? ''
      : state.total === 0
        ? t({ id: 'grid.find.none', message: 'No matches' })
        : state.current < 0
          ? t({ id: 'grid.find.total', message: plural(state.total, { one: '# match', other: '# matches' }) })
          : t({ id: 'grid.find.count', message: `${position} of ${total}` });

  const notices: Array<{ text: string; danger?: boolean }> = [];
  const notice = state.notice;
  if (notice?.kind === 'error') notices.push({ text: serverMessage(i18n, notice.messageKey), danger: true });
  if (notice?.kind === 'replaced') {
    notices.push({
      text: t({
        id: 'grid.find.replaced',
        message: plural(notice.cells, {
          0: 'Nothing was replaced.',
          one: 'Replaced # cell.',
          other: 'Replaced # cells.',
        }),
      }),
    });
    if (notice.unfit)
      notices.push({
        text: t({
          id: 'grid.find.unfit',
          message: plural(notice.unfit, {
            one: '# cell was left as it was, since the new text doesn’t fit its field.',
            other: '# cells were left as they were, since the new text doesn’t fit their fields.',
          }),
        }),
      });
    if (notice.capped)
      notices.push({
        text: t({
          id: 'grid.find.capped',
          message: plural(SEARCH_LIMITS.replaceCells, {
            other: 'Replace all changes up to # cells at a time.  Replace all again for the rest.',
          }),
        }),
      });
  }
  if (replacing && state.elsewhere > 0 && !state.searching)
    notices.push({
      text: t({
        id: 'grid.find.elsewhere',
        message: plural(state.elsewhere, {
          one: '# match is in a field Replace doesn’t change.',
          other: '# matches are in fields Replace doesn’t change.',
        }),
      }),
    });
  if (state.total !== null && state.total > state.listed && state.listed > 0)
    notices.push({
      text: t({
        id: 'grid.find.listed',
        message: plural(state.listed, { other: 'Stepping through the first # matches.' }),
      }),
    });

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLInputElement;
    const search = searchCommand(event.nativeEvent, MAC);
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (search) {
      // The browser's own find stays out of the way while this bar has the focus.
      event.preventDefault();
      if (search === 'replace' && canReplace) find.setMode('replace');
      const input = bar.current?.querySelector<HTMLInputElement>(
        search === 'replace' && canReplace ? 'input[name="replace"]' : 'input[name="find"]',
      );
      input?.focus();
      input?.select();
    } else if (event.key === 'Enter' && target.name === 'find') {
      event.preventDefault();
      void (event.shiftKey ? find.previous() : find.next());
    } else if (event.key === 'Enter' && target.name === 'replace') {
      event.preventDefault();
      void find.replace();
    }
  }

  return (
    <div
      ref={bar}
      className="rio-grid-find"
      role="search"
      aria-label={t({ id: 'grid.find.region', message: 'Find in this view' })}
      onKeyDown={keyDown}
    >
      <div className="rio-grid-find__row">
        <TextField
          className="rio-grid-find__field"
          name="find"
          size="sm"
          aria-label={t({ id: 'grid.find.label', message: 'Find' })}
          placeholder={t({ id: 'grid.find.placeholder', message: 'Find in view' })}
          value={state.query}
          onChange={find.setQuery}
        />
        <span className="rio-grid-find__count" aria-live="polite" aria-atomic="true">
          {count}
        </span>
        <Button
          icon={faArrowUp}
          variant="quiet"
          size="sm"
          aria-label={t({ id: 'grid.find.previous', message: 'Previous match' })}
          isDisabled={!state.listed}
          onPress={() => void find.previous()}
        />
        <Button
          icon={faArrowDown}
          variant="quiet"
          size="sm"
          aria-label={t({ id: 'grid.find.next', message: 'Next match' })}
          isDisabled={!state.listed}
          onPress={() => void find.next()}
        />
        {canReplace && (
          <Button
            icon={faRightLeft}
            variant="quiet"
            size="sm"
            aria-label={t({ id: 'grid.find.toggleReplace', message: 'Replace' })}
            aria-expanded={replacing}
            aria-controls={replaceRow}
            onPress={() => find.setMode(replacing ? 'find' : 'replace')}
          />
        )}
        <Button
          icon={faXmark}
          variant="quiet"
          size="sm"
          aria-label={t({ id: 'grid.find.close', message: 'Close find' })}
          onPress={close}
        />
      </div>
      {replacing && (
        <div className="rio-grid-find__row" id={replaceRow}>
          <TextField
            className="rio-grid-find__field"
            name="replace"
            size="sm"
            aria-label={t({ id: 'grid.find.replaceLabel', message: 'Replace with' })}
            placeholder={t({ id: 'grid.find.replacePlaceholder', message: 'Replace with' })}
            value={state.replacement}
            onChange={find.setReplacement}
          />
          <Button size="sm" isDisabled={!state.listed || state.replacing} onPress={() => void find.replace()}>
            {t({ id: 'grid.find.replace', message: 'Replace' })}
          </Button>
          <Button
            size="sm"
            isDisabled={!state.query || state.total === 0}
            isPending={state.replacing}
            onPress={() => void find.replaceAll()}
          >
            {t({ id: 'grid.find.replaceAll', message: 'Replace all' })}
          </Button>
        </div>
      )}
      {notices.length > 0 && (
        <div className="rio-grid-find__notices" aria-live="polite">
          {notices.map((item) => (
            <p
              key={item.text}
              className="rio-grid-find__notice"
              data-tone={item.danger ? 'danger' : undefined}
            >
              {item.text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
