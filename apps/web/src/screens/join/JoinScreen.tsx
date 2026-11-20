import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  AcceptInvitation,
  LEVELS,
  levelRank,
  needsSecondStep,
  type InvitationPreview,
  type Level,
  type SignInResult,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Form,
  FormActions,
  Heading,
  Radio,
  RadioGroup,
  Spinner,
  Text,
  TextField,
} from '@riosoma/ui';
import { LEVEL_NAMES, LEVEL_SUMMARIES } from '../../levels/words';
import { api, ApiError, setCsrfToken } from '../../api';
import { sessionQuery } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { secondStepQuery } from '../mfa/secondStep';
import { errorInfo } from '../setup/useSetup';
import './JoinScreen.css';

function readToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}

function invalidLink(error: unknown): boolean {
  return error instanceof ApiError && [400, 404, 409, 410].includes(error.status);
}

export function JoinScreen() {
  const [token, setToken] = useState(readToken);
  useEffect(() => {
    const clearFragment = () => {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    };
    const onHashChange = () => {
      if (!window.location.hash) return;
      setToken(readToken());
      clearFragment();
    };
    clearFragment();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A different invitation resets the form and any failed acceptance of the previous link.
  return <JoinInvitation key={token} token={token} />;
}

function JoinInvitation({ token }: { token: string | null }) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayName, setName] = useState('');
  const [level, setLevel] = useState<Level | null>(null);
  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => api<InvitationPreview>(`/api/auth/invitations/${encodeURIComponent(token!)}`),
    enabled: token !== null,
    retry: false,
    gcTime: 0,
  });
  // Where the invitee starts, and how far up they may go.  Keeping the level they start at makes
  // no choice, so they follow the organization's default if it changes later.
  const start = preview.data?.level?.start ?? 'standard';
  const highest = preview.data?.level?.highest ?? 'advanced';
  const levels = LEVELS.filter((choice) => levelRank(choice) <= levelRank(highest));
  const chosen = level ?? start;
  const send = () =>
    api<SignInResult>('/api/auth/invitations/accept', {
      body: AcceptInvitation.parse({
        token,
        name: displayName,
        locale: i18n.locale,
        ...(chosen !== start ? { level: chosen } : {}),
      }),
    });
  const accept = useMutation({
    mutationFn: async () => {
      try {
        return await send();
      } catch (error) {
        // An address that already has an account accepts from its own session.  A page opened
        // straight from the link hasn't read that session yet, so it reads it and asks once more.
        if (!(error instanceof ApiError) || error.info.messageKey !== 'share.invite.signInFirst') throw error;
        const session = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => null);
        if (!session) throw error;
        return send();
      }
    },
    onSuccess: (result) => {
      // A second step, the person's own or one the organization requires, comes before the app.
      if (needsSecondStep(result)) {
        queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: result.secondStep });
        void navigate(
          preview.data?.destination
            ? { to: '/sign-in', search: { next: preview.data.destination } }
            : { to: '/sign-in' },
        );
        return;
      }
      setCsrfToken(result.csrfToken);
      queryClient.setQueryData(sessionQuery.queryKey, result);
      void navigate({ to: preview.data?.destination ?? '/' });
    },
  });
  const invalid = token === null || invalidLink(preview.error) || invalidLink(accept.error);
  const org = preview.data?.orgName ?? '';
  const email = preview.data?.email ?? '';
  const name = preview.data?.invitedByName;

  return (
    <main className="rio-page-center">
      <div className="rio-card rio-join">
        {invalid ? (
          <>
            <Banner tone="danger">
              <Trans id="join.invalid">
                {'This invitation link has expired, was revoked, or was already used.  Ask for a new one.'}
              </Trans>
            </Banner>
            <Link to="/sign-in">
              <Trans id="join.signIn">Go to sign-in</Trans>
            </Link>
          </>
        ) : preview.isPending ? (
          <Spinner />
        ) : preview.isError ? (
          <>
            <ErrorBanner error={errorInfo(preview.error)} />
            <Button onPress={() => void preview.refetch()}>
              <Trans id="join.retry">Try again</Trans>
            </Button>
          </>
        ) : (
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (displayName.trim() && !accept.isPending) accept.mutate();
            }}
          >
            <Heading level={1}>
              <Trans id="join.title">Join {org}</Trans>
            </Heading>
            <Text>
              {name
                ? t({ id: 'join.invitedBy', message: `${name} invited ${email}.` })
                : t({ id: 'join.invited', message: `You were invited as ${email}.` })}
            </Text>
            {preview.data?.sharedItems ? (
              <Text>
                <Trans id="join.sharedItems">Shared with you: {preview.data.sharedItems.join(', ')}</Trans>
              </Text>
            ) : null}
            {preview.data?.sso ? (
              <a
                href={`/api/auth/${preview.data.sso.kind === 'saml' ? 'saml' : 'sso'}/${encodeURIComponent(preview.data.sso.id)}/start?${new URLSearchParams({ next: preview.data.destination ?? '/' })}`}
              >
                <Trans id="join.sso">Accept with {preview.data.sso.name}</Trans>
              </a>
            ) : (
              <>
                <TextField
                  label={t({ id: 'join.email', message: 'Invited email address' })}
                  value={email}
                  isReadOnly
                />
                <TextField
                  label={t({ id: 'join.name', message: 'Your name' })}
                  value={displayName}
                  onChange={setName}
                  maxLength={120}
                  isRequired
                  autoComplete="name"
                  autoFocus
                  isDisabled={accept.isPending}
                />
                {levels.length > 1 ? (
                  <RadioGroup
                    label={t({ id: 'levels.settings.label', message: 'How much to show' })}
                    description={t({
                      id: 'join.level.help',
                      message: 'You can change this anytime in your settings.',
                    })}
                    value={chosen}
                    isDisabled={accept.isPending}
                    onChange={(value) => {
                      const next = levels.find((item) => item === value);
                      if (next) setLevel(next);
                    }}
                  >
                    {levels.map((choice) => (
                      <Radio key={choice} value={choice} description={i18n._(LEVEL_SUMMARIES[choice])}>
                        {i18n._(LEVEL_NAMES[choice])}
                      </Radio>
                    ))}
                  </RadioGroup>
                ) : null}
                <ErrorBanner error={errorInfo(accept.error)} />
                <FormActions>
                  <Button
                    type="submit"
                    variant="primary"
                    isPending={accept.isPending}
                    isDisabled={!displayName.trim()}
                  >
                    <Trans id="join.submit">Join</Trans>
                  </Button>
                </FormActions>
              </>
            )}
          </Form>
        )}
      </div>
    </main>
  );
}
