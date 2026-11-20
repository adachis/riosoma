import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@riosoma/contracts';
import { Button, Dialog, DialogBody, DialogTitle, Modal, Text } from '@riosoma/ui';
import { api, ApiError, setCsrfToken } from '../api';
import { sameSessionIdentity, sessionQuery } from '../session';
import { recoverDatabaseSessions } from '../data/session';
import { SignInForm } from '../screens/SignInScreen';
import { secondStepQuery } from '../screens/mfa/secondStep';
import { errorInfo } from '../messages/errorInfo';
import { ErrorBanner } from './ErrorBanner';

/** Keep the current page mounted so an expired session cannot discard unsaved input. */
export function ReauthenticationDialog({
  identity,
  deactivated = false,
}: {
  identity: SessionInfo;
  deactivated?: boolean;
}) {
  const { t } = useLingui();
  const client = useQueryClient();
  const resume = useMutation({
    mutationFn: async (session: SessionInfo) => {
      // Another person's session must start with its own page and its own cached data.
      if (!sameSessionIdentity(session, identity)) {
        window.location.reload();
        return;
      }
      setCsrfToken(session.csrfToken);
      await recoverDatabaseSessions(session);
      client.setQueryData(sessionQuery.queryKey, session);
      client.setQueryData(secondStepQuery.queryKey, { secondStep: null });
      // Only failed reads retry.  A person's failed write waits for them to submit it again.
      void client.invalidateQueries({
        predicate: (query) => query.state.error instanceof ApiError && query.state.error.status === 401,
      });
    },
  });
  const check = useMutation({
    mutationFn: () => api<SessionInfo>('/api/auth/session'),
    onSuccess: (session) => resume.mutate(session),
  });
  return (
    <Modal isOpen isDismissable={false} isKeyboardDismissDisabled>
      <Dialog hideCloseButton>
        <DialogTitle>
          {deactivated ? (
            <Trans id="people.accessEnded.title">Your account is deactivated</Trans>
          ) : (
            <Trans id="auth.session.resumeTitle">Sign in again</Trans>
          )}
        </DialogTitle>
        <DialogBody>
          {deactivated ? (
            <Text>
              <Trans id="people.accessEnded.body">
                {
                  'Your administrator deactivated your account.  Your sessions ended, and your work is preserved.  Contact your administrator to restore access.'
                }
              </Trans>
            </Text>
          ) : (
            <>
              <Text>
                <Trans id="auth.session.resumeBody">
                  {
                    'Your session ended.  Sign in again to keep working.  Your unsaved changes are still here.'
                  }
                </Trans>
              </Text>
              <SignInForm email={identity.user.email} onSignedIn={(session) => resume.mutate(session)} />
              <Text>
                <a href="/sign-in" target="_blank" rel="noopener noreferrer">
                  <Trans id="auth.session.anotherTab">Open sign-in in another tab</Trans>
                </a>
              </Text>
              <Button isPending={check.isPending || resume.isPending} onPress={() => check.mutate()}>
                {t({ id: 'auth.session.check', message: 'I signed in in another tab' })}
              </Button>
              <ErrorBanner error={errorInfo(resume.error ?? check.error)} />
            </>
          )}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
