import { I18nProvider } from '@lingui/react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { createRoot } from 'react-dom/client';
import { ConfirmDialog, toast } from '@riosoma/ui';
import { msg } from '@lingui/core/macro';
import { UndoPreview } from '@riosoma/contracts';
import { api } from '../api';
import { i18n } from '../i18n';
import type { Http } from './deps';
import { redoDatabaseAction } from './session';
import { reportError } from '../messages/reportError';

type Creation = UndoPreview['creations'][number];

export function MajorUndoConfirmation({
  creation,
  onAnswer,
}: {
  creation: Creation;
  onAnswer(confirmed: boolean): void;
}) {
  const { t } = useLingui();
  const { kind, name, tables, records, changedSince } = creation;
  return (
    <ConfirmDialog
      isOpen
      title={
        kind === 'database'
          ? t({ id: 'undo.major.databaseTitle', message: `Undo creating the database ${name}?` })
          : t({ id: 'undo.major.tableTitle', message: `Undo creating the table ${name}?` })
      }
      message={
        <>
          <p>
            {kind === 'database'
              ? t({
                  id: 'undo.major.databaseBody',
                  message: `It and its ${plural(tables, { one: '# table', other: '# tables' })} and ${plural(records, { one: '# record', other: '# records' })} go to the trash.`,
                })
              : t({
                  id: 'undo.major.tableBody',
                  message: `It and its ${plural(records, { one: '# record', other: '# records' })} go to the trash.`,
                })}
          </p>
          {changedSince.map((person) => (
            <p key={person.actorId}>
              {person.records > 0
                ? t({
                    id: 'undo.major.recordsSince',
                    message: `${person.name} added ${plural(person.records, { one: '# record', other: '# records' })} since.`,
                  })
                : null}{' '}
              {person.tables > 0
                ? t({
                    id: 'undo.major.tablesSince',
                    message: `${person.name} added ${plural(person.tables, { one: '# table', other: '# tables' })} since.`,
                  })
                : null}{' '}
              {person.shares > 0
                ? t({
                    id: 'undo.major.sharesSince',
                    message: `${person.name} added ${plural(person.shares, { one: '# share', other: '# shares' })} since.`,
                  })
                : null}{' '}
              {!person.records && !person.tables && !person.shares
                ? t({
                    id: 'undo.major.changedSince',
                    message: `${person.name} changed it since it was created.`,
                  })
                : null}
            </p>
          ))}
        </>
      }
      confirmLabel={t({ id: 'undo.major.moveToTrash', message: 'Move to trash' })}
      cancelLabel={t({ id: 'undo.major.keep', message: 'Keep it' })}
      tone="danger"
      autoFocusCancel
      onConfirm={() => onAnswer(true)}
      onOpenChange={(open) => {
        if (!open) onAnswer(false);
      }}
    />
  );
}

let pending: Promise<unknown> = Promise.resolve();

/** All undo entry points share one question, including actions after their screen closes. */
export async function confirmMajorUndo(
  databaseId: string,
  groupId: string,
  http: Http = api,
): Promise<boolean> {
  const preview = UndoPreview.parse(
    await http(
      `/api/databases/${encodeURIComponent(databaseId)}/undo-preview/${encodeURIComponent(groupId)}`,
    ),
  );
  for (const creation of preview.creations) {
    const answer = pending.then(
      () =>
        new Promise<boolean>((resolve) => {
          const container = document.createElement('div');
          document.body.append(container);
          const root = createRoot(container);
          let answered = false;
          const onAnswer = (confirmed: boolean) => {
            if (answered) return;
            answered = true;
            // Unmount after the button's event finishes, so focus can return to its trigger.
            setTimeout(() => {
              root.unmount();
              container.remove();
              resolve(confirmed);
            }, 0);
          };
          root.render(
            <I18nProvider i18n={i18n}>
              <MajorUndoConfirmation creation={creation} onAnswer={onAnswer} />
            </I18nProvider>,
          );
        }),
    );
    pending = answer.catch(() => undefined);
    if (!(await answer)) return false;
  }
  return true;
}

/** A database undo leaves its screen, so its restore stays available on the resulting toast. */
export function offerCreationRedo(databaseId: string): void {
  toast.show({
    tone: 'info',
    title: i18n._(msg({ id: 'undo.major.trashed', message: 'Moved to trash.' })),
    timeout: 0,
    action: {
      label: i18n._(msg({ id: 'undo.major.redo', message: 'Redo' })),
      onPress: () => {
        void redoDatabaseAction(databaseId).catch(reportError);
      },
    },
  });
}
