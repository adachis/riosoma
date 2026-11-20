import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { OAuthConsent, OAuthDecision, SecondStepProof } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  CheckboxGroup,
  FilterableList,
  Heading,
  Radio,
  RadioGroup,
  Spinner,
} from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { mfaOverviewQuery } from '../mfa/overview';
import { needsProof, ProofForm } from '../mfa/ProofDialog';
import { errorInfo } from '../setup/useSetup';
import { useScopeLabels } from '../settings/tokens/labels';
import { OAuthAppIdentity } from '../settings/oauth/shared';
import '../settings/oauth/oauth.css';

/**
 * How long the screen must be on view and focused before Approve works.  A page that asks for a
 * double-click can swap this screen in between the two clicks, and the second must not land.
 */
export const APPROVE_DELAY_MS = 1_000;

/** Whether the page has been visible and focused, without a break, for `ms`. */
export function useSteadyAttention(ms: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      setReady(false);
      if (document.visibilityState === 'visible' && document.hasFocus())
        timer = setTimeout(() => setReady(true), ms);
    };
    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('blur', check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('blur', check);
    };
  }, [ms]);
  return ready;
}

export function OAuthConsentScreen() {
  const { request } = useSearch({ from: '/app/oauth/consent' });
  const consent = useQuery({
    queryKey: ['oauth', 'consent', request],
    queryFn: ({ signal }) =>
      api<OAuthConsent>(`/api/oauth/consent?request=${encodeURIComponent(request)}`, { signal }),
    retry: false,
    gcTime: 0,
  });
  return (
    <section className="rio-oauth rio-oauth__consent">
      <Heading level={1} data-anchor="oauth.consent.title">
        <Trans id="oauth.consent.title">Connect an app</Trans>
      </Heading>
      <ErrorBanner error={errorInfo(consent.error)} />
      {consent.isPending && <Spinner />}
      {consent.data && <Consent key={request} request={request} consent={consent.data} />}
    </section>
  );
}

function Consent({ request, consent }: { request: string; consent: OAuthConsent }) {
  const { t } = useLingui();
  const labels = useScopeLabels();
  const attentive = useSteadyAttention(APPROVE_DELAY_MS);
  const overview = useQuery(mfaOverviewQuery);
  const [reach, setReach] = useState(
    consent.remembered === 'all' || consent.remembered === null ? 'all' : 'chosen',
  );
  const [chosen, setChosen] = useState<string[]>(
    Array.isArray(consent.remembered)
      ? consent.remembered.filter((id) => consent.databases.some((db) => db.id === id))
      : [],
  );
  // Approving adds a way into the account, so someone with a second step confirms it's them.
  const [proving, setProving] = useState(false);
  const [busy, setBusy] = useState(false);
  const decisionFor = (approve: boolean, proof?: SecondStepProof): OAuthDecision => ({
    request,
    approve,
    databases: !approve || reach === 'all' ? 'all' : chosen,
    ...(proof ? { proof } : {}),
  });
  const decision = useMutation({
    mutationFn: (body: OAuthDecision) => api<{ redirect: string }>('/api/oauth/consent', { body }),
    onSuccess: ({ redirect }) => {
      window.location.assign(redirect);
    },
    onError: (error) => {
      // A second step added since the page loaded: ask for it now.
      if (error instanceof ApiError && error.info.messageKey === 'mfa.proof.required') {
        void overview.refetch();
        setProving(true);
      }
    },
  });
  const pending = decision.isPending || busy;
  function approve() {
    if (overview.data && needsProof(overview.data)) setProving(true);
    else decision.mutate(decisionFor(true));
  }
  if (proving)
    return overview.data ? (
      <ProofForm
        message={t({
          id: 'oauth.consent.proof',
          message: 'Connecting an app adds another way into your account, so confirm it’s you first.',
        })}
        confirmLabel={t({ id: 'oauth.approve', message: 'Approve access' })}
        overview={overview.data}
        tone="primary"
        onBusyChange={setBusy}
        onProof={(proof) => decision.mutateAsync(decisionFor(true, proof))}
        onCancel={() => {
          decision.reset();
          setProving(false);
        }}
      />
    ) : (
      <Spinner />
    );
  return (
    <>
      <OAuthAppIdentity app={consent.app} />
      {!consent.app.verified && (
        <Banner tone="warning">
          {t({
            id: 'oauth.consent.unverified',
            message:
              'An administrator has not reviewed this app.  Continue only if you recognize it and trust it with your data.',
          })}
        </Banner>
      )}
      {consent.connected && (
        <Banner tone="info">
          {consent.remembered === null
            ? t({
                id: 'oauth.consent.shared',
                message:
                  'You already connected this app.  What you approve now replaces your earlier choices everywhere it’s signed in as you, so a narrower choice applies to all of them at once.',
              })
            : t({
                id: 'oauth.consent.remembered',
                message:
                  'You already approved this access, and your saved database choices are selected.  What you approve now replaces them everywhere this app is signed in as you, so a narrower choice applies to all of them at once.',
              })}
        </Banner>
      )}
      <p>
        {t({
          id: 'oauth.consent.person',
          message: 'This app acts as you.  Your permissions still limit every read and change.',
        })}
      </p>
      <div className="rio-oauth__destination">
        <span>
          <Trans id="oauth.redirect.host">After approval, you go to</Trans>
        </span>
        <strong className="rio-oauth__host">{consent.redirectHost}</strong>
        <span>
          <Trans id="oauth.redirect.full">Full address</Trans> <code>{consent.redirectUri}</code>
        </span>
      </div>
      <Heading level={2}>
        <Trans id="tokens.scopes">What it can do</Trans>
      </Heading>
      <ul>
        {consent.scopes.map((scope) => (
          <li key={scope}>{labels[scope]}</li>
        ))}
      </ul>
      <p>
        <Trans id="oauth.resource">Resource</Trans> <code>{consent.resource}</code>
      </p>
      <RadioGroup
        label={t({ id: 'tokens.databases.pick', message: 'Databases' })}
        value={reach}
        onChange={setReach}
        isDisabled={pending}
      >
        <Radio value="all">
          <Trans id="tokens.databases.allLabel">All databases I can open, now and later</Trans>
        </Radio>
        <Radio value="chosen">
          <Trans id="tokens.databases.chosen">Only these databases</Trans>
        </Radio>
      </RadioGroup>
      {reach === 'chosen' ? (
        consent.databases.length > 10 ? (
          <FilterableList
            listId="oauth.databases"
            label={t({ id: 'tokens.databases.chosen', message: 'Only these databases' })}
            items={consent.databases.map((db) => ({ id: db.id, name: db.name }))}
            selectionMode="multiple"
            selectedKeys={chosen}
            onSelectionChange={(keys) => setChosen([...keys].map(String))}
            isDisabled={pending}
          />
        ) : (
          <CheckboxGroup
            aria-label={t({ id: 'tokens.databases.chosen', message: 'Only these databases' })}
            value={chosen}
            onChange={setChosen}
            isDisabled={pending}
          >
            {consent.databases.map((db) => (
              <Checkbox key={db.id} value={db.id}>
                {db.name}
              </Checkbox>
            ))}
          </CheckboxGroup>
        )
      ) : (
        <ul>
          {consent.databases.map((db) => (
            <li key={db.id}>{db.name}</li>
          ))}
        </ul>
      )}
      <ErrorBanner error={errorInfo(decision.error)} />
      <div className="rio-oauth__actions">
        <Button
          variant="primary"
          isPending={decision.isPending}
          isDisabled={!attentive || (reach === 'chosen' && chosen.length === 0)}
          onPress={approve}
        >
          {consent.remembered === null ? (
            <Trans id="oauth.approve">Approve access</Trans>
          ) : (
            <Trans id="oauth.continue">Continue with this access</Trans>
          )}
        </Button>
        <Button isDisabled={pending} onPress={() => decision.mutate(decisionFor(false))}>
          <Trans id="oauth.deny">Deny access</Trans>
        </Button>
      </div>
      <p>
        <Trans id="oauth.consent.revoke">You can revoke access at any time in Connected apps.</Trans>
      </p>
    </>
  );
}
