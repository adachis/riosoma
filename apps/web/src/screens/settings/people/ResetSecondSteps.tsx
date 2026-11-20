import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { Member, SessionInfo } from '@riosoma/contracts';
import { Button, ConfirmDialog, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSso } from '../sso/SsoSettings';

/**
 * Owners and Security admins can clear someone else's second steps, never read them.  An owner's
 * are for another owner to clear, and your own change in Sign-in and security, which asks for a
 * fresh second step first.
 */
export function canResetSecondSteps(session: SessionInfo | null, member: Member): boolean {
  if (!session || !canManageSso(session)) return false;
  if (member.id === session.user.id || member.deactivated) return false;
  return member.kind !== 'owner' || session.membership.kind === 'owner';
}

export function ResetSecondSteps({
  member,
  open,
  onClose,
}: {
  member: Member;
  open?: boolean;
  onClose?(): void;
}) {
  const { t } = useLingui();
  const [asking, setAsking] = useState(false);
  const name = member.name || member.email;
  const reset = useMutation({
    mutationFn: () =>
      api<void>(`/api/admin/mfa/people/${encodeURIComponent(member.id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      onClose?.();
      toast.show({
        tone: 'success',
        title: t({ id: 'mfa.people.done', message: `Reset the second steps for ${name}` }),
      });
    },
  });

  return (
    <>
      {open === undefined ? (
        <Button
          size="sm"
          variant="quiet"
          aria-label={t({ id: 'mfa.people.resetNamed', message: `Reset second steps for ${name}` })}
          onPress={() => {
            reset.reset();
            setAsking(true);
          }}
        >
          <Trans id="mfa.people.reset">Reset second steps</Trans>
        </Button>
      ) : null}
      {(open ?? asking) ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'mfa.people.title', message: `Reset the second steps for ${name}?` })}
          message={
            <>
              <Trans id="mfa.people.body">
                {
                  'Their passkeys, authenticator app, and recovery codes stop working.  If a second step is required, they add a new one the next time they sign in.'
                }
              </Trans>
              <ErrorBanner error={errorInfo(reset.error)} />
            </>
          }
          confirmLabel={t({ id: 'mfa.people.confirm', message: 'Reset' })}
          onOpenChange={(open) => {
            if (!open) {
              setAsking(false);
              onClose?.();
            }
          }}
          onConfirm={() => reset.mutateAsync()}
        />
      ) : null}
    </>
  );
}
