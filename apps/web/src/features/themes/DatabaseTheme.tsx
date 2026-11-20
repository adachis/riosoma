import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { themeAllowed, type ThemePick } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogFooter, DialogTitle, Modal, toast } from '@riosoma/ui';
import type { DatabaseSession } from '../../data/types';
import { anchor } from '../../demos/anchors';
import { reportError } from '../../grid/view/actions';
import { appliedSettings, useSession } from '../../session';
import './theme-picker.css';
import { useThemeOverride } from './override';
import { ThemePicker } from './ThemePicker';

// Databases whose theme this visit already said it couldn't show, so the note comes once.
const noted = new Set<string>();

/**
 * Shows an open database in the theme it forces, in place of the person's own, and puts theirs
 * back when they leave.  A theme the person's organization doesn't let them choose isn't shown.
 * They keep their own, and a note says why once a visit.  Answers the theme actually shown.
 */
export function useDatabaseTheme(databaseId: string, theme: ThemePick | null | undefined): ThemePick | null {
  const { t } = useLingui();
  const session = useSession();
  const allowed = appliedSettings(session)?.allowedThemes;
  const shown = theme && themeAllowed(theme.id, allowed) ? theme : null;
  useThemeOverride(shown ? { theme: shown.id, scheme: shown.scheme } : null);
  const blockedId = theme && !shown ? theme.id : null;
  useEffect(() => {
    if (!blockedId) return;
    const key = `${databaseId}:${blockedId}`;
    if (noted.has(key)) return;
    noted.add(key);
    toast.show({
      tone: 'info',
      title: t({
        id: 'databaseTheme.blockedToast',
        message: 'This database has its own theme, but your organization doesn’t allow it, so you see yours.',
      }),
    });
  }, [blockedId, databaseId, t]);
  return shown;
}

/**
 * The database's theme, for its owner: one theme and color scheme everyone sees while the database
 * is open, or each person's own.  A change saves and shows at once, for everyone who has the
 * database open.
 */
export function DatabaseThemeDialog({
  session,
  theme,
  onClose,
}: {
  session: DatabaseSession;
  theme: ThemePick | null;
  onClose(): void;
}) {
  const { t } = useLingui();
  const change = (next: ThemePick | null) => {
    try {
      session.run([{ kind: 'database.update', theme: next }]);
    } catch (error) {
      reportError(error);
    }
  };
  return (
    <Modal
      isOpen
      isDismissable
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog className="rio-database-theme">
        <DialogTitle>{t({ id: 'databaseTheme.title', message: 'Database theme' })}</DialogTitle>
        <DialogBody>
          <p className="rio-database-theme__help">
            {t({
              id: 'databaseTheme.help',
              message:
                'Everyone who opens this database sees it in this theme instead of their own.  Leaving the database brings back each person’s own theme.',
            })}
          </p>
          <ThemePicker
            value={theme}
            onChange={change}
            label={t({ id: 'databaseTheme.theme', message: 'Theme for everyone' })}
            inheritLabel={t({ id: 'databaseTheme.ownTheme', message: 'Each person’s own theme' })}
            description={t({
              id: 'databaseTheme.allowedHelp',
              message: 'People see it only if their organization allows the theme.  Otherwise they see their own.',
            })}
            blockedNote={t({
              id: 'databaseTheme.blocked',
              message:
                'Your organization doesn’t allow this theme anymore, so people see their own theme here instead.  Pick another to show one again.',
            })}
            anchorProps={anchor('database.theme.picker')}
          />
        </DialogBody>
        <DialogFooter>
          <Button onPress={onClose}>
            <Trans id="databaseTheme.done">Done</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
