import { setAdminSearch, useAdminSearch } from '../admin-search';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Member, PasswordResetAvailability, PasswordResetLink } from '@riosoma/contracts';
import { Button, ConfirmDialog, Dialog, DialogBody, DialogTitle, Modal, Text, TextField } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';

export function AccountSecurityActions({ member, menu = false }: { member: Member; menu?: boolean }) {
  const { t } = useLingui();
  const session = useSession();
  const search = useAdminSearch();
  const selected = search.get('member') === member.id;
  const open = selected && search.get('account-action') === 'password-reset';
  const ending = selected && search.get('account-action') === 'sessions';
  const setOpen = (value: boolean) =>
    setAdminSearch({ member: member.id, 'account-action': value ? 'password-reset' : undefined });
  const setEnding = (value: boolean) =>
    setAdminSearch({ member: member.id, 'account-action': value ? 'sessions' : undefined });
  const [copied, setCopied] = useState(false);
  const availability = useQuery({
    queryKey: ['auth', 'password-reset'],
    queryFn: () => api<PasswordResetAvailability>('/api/auth/password-reset'),
  });
  const reset = useMutation({
    mutationFn: (delivery: 'email' | 'copy') =>
      api<PasswordResetLink>(`/api/admin/people/${encodeURIComponent(member.id)}/password-reset`, {
        body: { delivery },
      }),
  });
  const end = useMutation({
    mutationFn: () => api(`/api/admin/people/${encodeURIComponent(member.id)}/sessions/end`, { body: {} }),
    onSuccess: () => setEnding(false),
  });
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(reset.data?.link ?? ''),
    onSuccess: () => setCopied(true),
  });
  if (member.deactivated || (member.kind === 'owner' && session?.membership.kind !== 'owner')) return null;
  return (
    <>
      {!menu && member.id !== session?.user.id ? (
        <Button
          onPress={() => {
            reset.reset();
            setCopied(false);
            setOpen(true);
          }}
        >
          <Trans id="auth.reset.admin">Reset password</Trans>
        </Button>
      ) : null}
      {!menu ? (
        <Button
          onPress={() => {
            end.reset();
            setEnding(true);
          }}
        >
          <Trans id="auth.sessions.adminEnd">End all sessions</Trans>
        </Button>
      ) : null}
      {open ? (
        <Modal
          isOpen
          onOpenChange={(value) => {
            if (!value) setOpen(false);
          }}
        >
          <Dialog>
            <DialogTitle>
              <Trans id="auth.reset.admin">Reset password</Trans>
            </DialogTitle>
            <DialogBody>
              <Text>{member.email}</Text>
              <Text>
                <Trans id="auth.reset.adminExplain">
                  {
                    'A reset link works once and expires in 30 minutes.  Using it ends every session for this person.'
                  }
                </Trans>
              </Text>
              <ErrorBanner error={errorInfo(reset.error)} />
              {reset.data?.link ? (
                <>
                  <TextField
                    label={t({ id: 'auth.reset.oneTimeLink', message: 'One-time reset link' })}
                    value={reset.data.link}
                    isReadOnly
                  />
                  <Button onPress={() => copy.mutate()}>
                    <Trans id="auth.reset.copy">Copy link</Trans>
                  </Button>
                  <ErrorBanner error={errorInfo(copy.error)} />
                  {copied ? (
                    <Text role="status">
                      <Trans id="auth.reset.copied">Copied the link.</Trans>
                    </Text>
                  ) : null}
                </>
              ) : reset.isSuccess ? (
                <Text role="status">
                  <Trans id="auth.reset.adminSent">Sent the reset email.</Trans>
                </Text>
              ) : (
                <>
                  {availability.data?.email ? (
                    <Button isPending={reset.isPending} onPress={() => reset.mutate('email')}>
                      <Trans id="auth.reset.send">Send reset link</Trans>
                    </Button>
                  ) : null}
                  <Button isPending={reset.isPending} onPress={() => reset.mutate('copy')}>
                    <Trans id="auth.reset.create">Create one-time link</Trans>
                  </Button>
                </>
              )}
              <Button onPress={() => setOpen(false)}>
                <Trans id="mfa.settings.codesDone">Done</Trans>
              </Button>
            </DialogBody>
          </Dialog>
        </Modal>
      ) : null}
      {ending ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'auth.sessions.adminEnd', message: 'End all sessions' })}
          message={
            <>
              <Text>
                <Trans id="auth.sessions.adminConfirm">
                  This person will need to sign in again on every device.
                </Trans>
              </Text>
              <ErrorBanner error={errorInfo(end.error)} />
            </>
          }
          confirmLabel={t({ id: 'auth.sessions.adminEnd', message: 'End all sessions' })}
          onConfirm={() => end.mutateAsync()}
          onOpenChange={(value) => {
            if (!value) setEnding(false);
          }}
        />
      ) : null}
    </>
  );
}
