import { faClockRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Button, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { useCallback, useMemo, useState } from 'react';
import type { DatabaseSession } from '../../../data/types';
import { usePaletteItems } from '../../../palette/sources';
import type { PaletteOffer } from '../../../palette/types';
import { shortcutKeys } from '../../../shortcuts/registry';
import { useShortcut } from '../../../shortcuts/useShortcut';
import { UndoHistoryPanel } from './UndoHistory';

/**
 * Opens the undo history three ways: this button in the database's header, Mod+Alt+Z beside redo's
 * Mod+Shift+Z, and a command in the palette for as long as the database is open.
 */
export function UndoHistoryButton({ session }: { session: DatabaseSession }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  useShortcut('undo.history', show);
  const label = t({ id: 'undo.history.open', message: 'Undo history' });
  const commands = useMemo<PaletteOffer[]>(
    () => [{ id: 'cmd:undo.history', group: 'commands', label, icon: faClockRotateLeft, run: show }],
    [label, show],
  );
  usePaletteItems('database.undo', commands);
  return (
    <>
      <TooltipTrigger>
        <Button variant="quiet" icon={faClockRotateLeft} aria-label={label} onPress={show} primaryAction />
        <Tooltip>
          {label} <kbd>{shortcutKeys('undo.history')}</kbd>
        </Tooltip>
      </TooltipTrigger>
      {open ? <UndoHistoryPanel session={session} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
