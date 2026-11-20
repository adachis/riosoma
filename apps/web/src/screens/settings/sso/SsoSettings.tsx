import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { canManageSso } from '../access';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SSO_KINDS, type SamlDraft, type SsoKind, type SsoProvider } from '@riosoma/contracts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { ProviderForm } from './ProviderForm';
import { SamlProviderForm } from './SamlProviderForm';
import './sso.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sso',
  label: msg({ id: 'settings.nav.sso', message: 'Single sign-on' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.sso',
    message: 'single sign-on identity providers SAML OIDC',
  }),
});

const SSO_KEY = ['admin', 'sso'];
/**
 * A new SAML provider's ID, kept for the whole visit, so closing the dialog midway through setting
 * up the identity provider doesn't change the addresses already given to it.  Saving takes it.
 */
const SAML_DRAFT_KEY = ['admin', 'samlDraft'];

/** Owners, and the admins given the Security role, look after single sign-on. */
export { canManageSso } from '../access';

function isKind(value: string): value is SsoKind {
  return (SSO_KINDS as readonly string[]).includes(value);
}

function useKindLabels(): Record<SsoKind, string> {
  const { t } = useLingui();
  return {
    google: t({ id: 'sso.kind.google', message: 'Google' }),
    microsoft: t({ id: 'sso.kind.microsoft', message: 'Microsoft Entra ID' }),
    oidc: t({ id: 'sso.kind.oidc', message: 'Another OpenID Connect provider' }),
    saml: t({ id: 'sso.saml.kind', message: 'SAML identity provider' }),
  };
}

export function SsoSettings() {
  const session = useSession();
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.sso', message: 'Single sign-on' })}
    >
      {canManageSso(session) ? <Providers /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

function Providers() {
  const { t } = useLingui();
  const message = useServerMessage();
  // What a provider trusts is the owner's to set, so nobody else is offered a new one.
  const owner = useSession()?.membership.kind === 'owner';
  const [adding, setAdding] = useState(false);
  const providers = useQuery({
    queryKey: SSO_KEY,
    queryFn: ({ signal }) => api<SsoProvider[]>('/api/admin/sso', { signal }),
  });
  // Every provider shares one callback address.  Before the first one exists, this page's own
  // address stands in for the server's.
  const callback = providers.data?.[0]?.redirectUri ?? `${window.location.origin}/api/auth/sso/callback`;

  return (
    <div className="rio-sso">
      <p className="rio-sso__intro">
        <Trans id="sso.intro">
          Let people sign in with an account they already have, like Google or Microsoft.
        </Trans>
      </p>
      {owner ? (
        <div>
          <Button
            variant="primary"
            onPress={() => setAdding(true)}
            aria-label={t({ id: 'sso.add', message: 'Add a provider' })}
            icon={faPlus}
          />
        </div>
      ) : (
        <p className="rio-sso__intro">{message('sso.ownerOnly')}</p>
      )}
      <ErrorBanner error={errorInfo(providers.error)} />
      {providers.isPending ? <Spinner /> : null}
      {providers.data?.length ? (
        <div className="rio-sso__list">
          {providers.data.map((provider) => (
            <ProviderPanel key={provider.id} provider={provider} />
          ))}
        </div>
      ) : null}
      {adding ? <AddProvider callback={callback} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** One provider: its name, kind, whether it's on, and who uses it, with the settings behind it. */
function ProviderPanel({ provider }: { provider: SsoProvider }) {
  const { t } = useLingui();
  const kinds = useKindLabels();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: () => api<void>(`/api/admin/sso/${encodeURIComponent(provider.id)}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SSO_KEY }),
  });
  const { name } = provider;
  const count = provider.identities;

  return (
    <Disclosure className="rio-sso__provider">
      <DisclosureTrigger level={2}>{name}</DisclosureTrigger>
      <p className="rio-sso__summary">
        <span>{kinds[provider.kind]}</span>
        <span>
          {provider.enabled ? <Trans id="sso.status.on">On</Trans> : <Trans id="sso.status.off">Off</Trans>}
        </span>
        <span>
          {t({ id: 'sso.column.people', message: plural(count, { one: '# person', other: '# people' }) })}
        </span>
      </p>
      <DisclosurePanel className="rio-sso__panel">
        {provider.kind === 'saml' ? (
          <SamlProviderForm
            provider={provider}
            onSaved={() => queryClient.invalidateQueries({ queryKey: SSO_KEY })}
            onDelete={() => {
              remove.reset();
              setDeleting(true);
            }}
          />
        ) : (
          <ProviderForm
            kind={provider.kind}
            provider={provider}
            callback={provider.redirectUri}
            onSaved={() => queryClient.invalidateQueries({ queryKey: SSO_KEY })}
            onDelete={() => {
              remove.reset();
              setDeleting(true);
            }}
          />
        )}
      </DisclosurePanel>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'sso.delete.title', message: `Delete ${name}?` })}
          message={
            <>
              <Trans id="sso.delete.body">People who sign in with it will need another way to sign in.</Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'sso.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(false);
          }}
          onConfirm={() => remove.mutateAsync()}
        />
      ) : null}
    </Disclosure>
  );
}

/** Kind first, since it decides what else the provider needs. */
function AddProvider({ callback, onClose }: { callback: string; onClose(): void }) {
  const { t } = useLingui();
  const kinds = useKindLabels();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<SsoKind | null>(null);

  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="sso.add">Add a provider</Trans>
        </DialogTitle>
        <DialogBody className="rio-sso__add">
          <RadioGroup
            aria-label={t({ id: 'sso.add', message: 'Add a provider' })}
            value={kind}
            onChange={(value) => setKind(isKind(value) ? value : null)}
          >
            {SSO_KINDS.map((option) => (
              <Radio key={option} value={option}>
                {kinds[option]}
              </Radio>
            ))}
          </RadioGroup>
          {kind === 'saml' ? (
            <NewSamlProvider
              onSaved={() => {
                queryClient.removeQueries({ queryKey: SAML_DRAFT_KEY });
                void queryClient.invalidateQueries({ queryKey: SSO_KEY });
                onClose();
              }}
            />
          ) : kind ? (
            <ProviderForm
              key={kind}
              kind={kind}
              callback={callback}
              defaultName={kind === 'oidc' ? '' : kinds[kind]}
              onSaved={() => {
                void queryClient.invalidateQueries({ queryKey: SSO_KEY });
                onClose();
              }}
            />
          ) : null}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

/** A SAML provider starts with its ID, since Riosoma's addresses for it include it. */
function NewSamlProvider({ onSaved }: { onSaved(): void }) {
  const draft = useQuery({
    queryKey: SAML_DRAFT_KEY,
    queryFn: ({ signal }) => api<SamlDraft>('/api/admin/sso/saml/new', { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (draft.isPending) return <Spinner />;
  if (!draft.data) return <ErrorBanner error={errorInfo(draft.error)} />;
  return <SamlProviderForm draft={draft.data} onSaved={onSaved} />;
}
