import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Banner,
  Dialog,
  DialogBody,
  DialogTitle,
  Drawer,
  ListBox,
  ListBoxItem,
  toast,
  useConfirm,
} from '@riosoma/ui';
import { useCallback, useId, useState, useSyncExternalStore } from 'react';
import { useSaveState } from '../../../data/hooks';
import type { DatabaseSession, HistoryEntry, UndoHistory } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';
import { useRelativeTime } from '../../../relative-time';
import { describeAction } from './describe';
import './undo.css';

const NONE: UndoHistory = { undo: [], redo: [] };

/** The session's undo and redo stacks, newest first, kept current as actions come and go. */
export function useUndoHistory(session: DatabaseSession | null): UndoHistory {
  return useSyncExternalStore(
    useCallback((listener) => session?.subscribeUndoHistory(listener) ?? (() => undefined), [session]),
    useCallback(() => session?.undoHistory() ?? NONE, [session]),
    () => NONE,
  );
}

function When({ at }: { at: number }) {
  return <>{useRelativeTime(new Date(at).toISOString())}</>;
}

function HistoryList({
  label,
  entries,
  disabled,
  onChoose,
  redo = false,
}: {
  label: string;
  entries: readonly HistoryEntry[];
  disabled: boolean;
  onChoose(entry: HistoryEntry, steps: number): void;
  redo?: boolean;
}) {
  const { i18n } = useLingui();
  const t = i18n._.bind(i18n);
  return (
    <ListBox
      aria-label={label}
      className="rio-undo-history__list"
      selectionMode="none"
      disabledKeys={disabled ? entries.map((entry) => entry.groupId) : []}
      onAction={(key) => {
        const index = entries.findIndex((entry) => entry.groupId === key);
        if (index >= 0) onChoose(entries[index]!, index + 1);
      }}
    >
      {entries.map((entry) => (
        <ListBoxItem
          key={entry.groupId}
          id={entry.groupId}
          description={
            <>
              <When at={entry.at} />
              {!redo &&
              (entry.summary.asksFirst ||
                ['database.create', 'table.create', 'table.duplicate'].includes(entry.summary.kind)) ? (
                <small className="rio-undo-history__asks-first">
                  <Trans id="undo.history.asksFirst">Asks first</Trans>
                </small>
              ) : null}
            </>
          }
        >
          {describeAction(entry.summary, t)}
        </ListBoxItem>
      ))}
    </ListBox>
  );
}

/**
 * The person's own recent changes in this database, from the session's undo stack, with what redo
 * would put back listed apart.  Choosing a change undoes it and everything after it, newest first,
 * the way pressing undo that many times would, and asks first when that's more than one.  Other
 * people's changes are never listed, so they're never undone from here.
 */
export function UndoHistoryPanel({ session, onClose }: { session: DatabaseSession; onClose(): void }) {
  const { t, i18n } = useLingui();
  const history = useUndoHistory(session);
  const save = useSaveState(session);
  const ask = useConfirm();
  const [busy, setBusy] = useState(false);
  const undoHeading = useId();
  const redoHeading = useId();
  const offline = save.status === 'offline';

  const choose = async (entry: HistoryEntry, steps: number, redo: boolean) => {
    const action = describeAction(entry.summary, i18n._.bind(i18n));
    if (steps > 1) {
      const later = steps - 1;
      const confirmed = await ask(
        redo
          ? {
              title: t({
                id: 'undo.history.redoTitle',
                message: plural(steps, { one: 'Redo # change?', other: 'Redo # changes?' }),
              }),
              message: t({
                id: 'undo.history.redoBody',
                message: plural(later, {
                  one: `This redoes “${action}” and the change you undid after it.`,
                  other: `This redoes “${action}” and the # changes you undid after it.`,
                }),
              }),
              confirmLabel: t({
                id: 'undo.history.redoMany',
                message: plural(steps, { one: 'Redo # change', other: 'Redo # changes' }),
              }),
            }
          : {
              title: t({
                id: 'undo.history.undoTitle',
                message: plural(steps, { one: 'Undo # change?', other: 'Undo # changes?' }),
              }),
              message: t({
                id: 'undo.history.undoBody',
                message: plural(later, {
                  one: `This undoes “${action}” and the change you made after it.`,
                  other: `This undoes “${action}” and the # changes you made after it.`,
                }),
              }),
              confirmLabel: t({
                id: 'undo.history.undoMany',
                message: plural(steps, { one: 'Undo # change', other: 'Undo # changes' }),
              }),
            },
      );
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      const outcome = await (redo ? session.redoThrough(entry.groupId) : session.undoThrough(entry.groupId));
      // A refusal already has its own message, from the same place any undo's does.
      if (outcome.moved)
        toast.show({
          tone: 'info',
          title: redo
            ? t({
                id: 'undo.history.redone',
                message: plural(outcome.moved, { one: 'Redid # change', other: 'Redid # changes' }),
              })
            : t({
                id: 'undo.history.undone',
                message: plural(outcome.moved, { one: 'Undid # change', other: 'Undid # changes' }),
              }),
        });
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog className="rio-undo-history">
        <DialogTitle>
          <Trans id="undo.history.title">Undo history</Trans>
        </DialogTitle>
        <DialogBody>
          <p className="rio-undo-history__intro">
            {t({
              id: 'undo.history.intro',
              message:
                'Your own changes in this database since you opened it.  Choose one to undo it and everything you did after it.',
            })}
          </p>
          {offline ? (
            <Banner tone="info">
              <Trans id="undo.history.offline">Undo waits until you’re back online.</Trans>
            </Banner>
          ) : null}
          <section className="rio-undo-history__section" aria-labelledby={undoHeading}>
            <h3 id={undoHeading} className="rio-undo-history__heading">
              <Trans id="undo.history.undoList">Undo</Trans>
            </h3>
            {history.undo.length ? (
              <HistoryList
                label={t({ id: 'undo.history.undoListLabel', message: 'Changes to undo, newest first' })}
                entries={history.undo}
                disabled={busy || offline}
                onChoose={(entry, steps) => void choose(entry, steps, false)}
              />
            ) : (
              <p className="rio-undo-history__empty">
                <Trans id="undo.history.nothing">Nothing to undo yet.</Trans>
              </p>
            )}
          </section>
          {history.redo.length ? (
            <section className="rio-undo-history__section" aria-labelledby={redoHeading}>
              <h3 id={redoHeading} className="rio-undo-history__heading">
                <Trans id="undo.history.redoList">Redo</Trans>
              </h3>
              <HistoryList
                label={t({ id: 'undo.history.redoListLabel', message: 'Changes to redo, next first' })}
                redo
                entries={history.redo}
                disabled={busy || offline}
                onChoose={(entry, steps) => void choose(entry, steps, true)}
              />
            </section>
          ) : null}
        </DialogBody>
      </Dialog>
    </Drawer>
  );
}
