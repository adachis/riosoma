import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Member, SessionInfo } from '@riosoma/contracts';
import { Button, ConfirmDialog, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { canManagePeople } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';

/**
 * The owner and People admins can remove the account of someone provisioning manages once it's
 * deactivated, so the directory can give their login name to someone new.  Never the owner's.
 */
export function canRemoveAccount(session: SessionInfo | null, member: Member): boolean {
  return (
    canManagePeople(session) && member.managed === 'scim' && member.deactivated && member.kind !== 'owner'
  );
}

export function RemoveAccount({
  member,
  open,
  onClose,
}: {
  member: Member;
  open?: boolean;
  onClose?(): void;
}) {
  const { t } = useLingui();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const name = member.name || member.email;
  const remove = useMutation({
    mutationFn: () => api<void>(`/api/org/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setAsking(false);
      onClose?.();
      toast.show({
        tone: 'success',
        title: t({ id: 'people.remove.done', message: `Removed the account for ${name}` }),
      });
      await Promise.all(
        [
          ['org', 'members'],
          ['org', 'groups'],
          ['admin', 'scim'],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
    },
  });

  return (
    <>
      {open === undefined ? (
        <Button
          size="sm"
          variant="quiet"
          aria-label={t({ id: 'people.remove.named', message: `Remove the account for ${name}` })}
          onPress={() => {
            remove.reset();
            setAsking(true);
          }}
          icon={faXmark}
        />
      ) : null}
      {(open ?? asking) ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'people.remove.title', message: `Remove the account for ${name}?` })}
          message={
            <>
              <Trans id="people.remove.body">
                {
                  'This can’t be undone.  Their access ends for good, each database only they own goes to the organization’s owner, and their public links and forms stop.  Their records stay.  Your identity provider can then give their user name to someone new.'
                }
              </Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'people.remove', message: 'Remove account' })}
          onOpenChange={(open) => {
            if (!open) {
              setAsking(false);
              onClose?.();
            }
          }}
          onConfirm={() => remove.mutateAsync()}
        />
      ) : null}
    </>
  );
}
