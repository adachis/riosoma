import { useSettingsDraft } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';
import { SettingsLoading } from '../SettingsLoading';

import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  ScimAdministration,
  ScimDomainVerification,
  ScimSettings as Settings,
  ScimToken,
  SsoProvider,
  UnmanagedMember,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Form,
  Heading,
  ListBoxItem,
  Modal,
  Select,
  TextField,
} from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSso } from '../sso/SsoSettings';
import './scim.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'scim',
  label: msg({ id: 'scim.title', message: 'Provisioning' }),
  roles: ['security'],
  keywords: msg({ id: 'settings.search.keywords.scim', message: 'provisioning SCIM dry run tokens domains' }),
});

const KEY = ['admin', 'scim'];
const DOMAINS = ['admin', 'scim', 'domains'];

export function ScimSettings() {
  return (
    <Setting page={settingsPage} id="overview" label={msg({ id: 'scim.title', message: 'Provisioning' })}>
      {canManageSso(useSession()) ? <Provisioning /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

function Provisioning() {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ token: ScimToken; rotate: boolean } | null>(null);
  const lastUsed = (value: string) => {
    const date = i18n.date(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });
    return t({ id: 'scim.lastUsed', message: `Last used: ${date}` });
  };
  const createdBy = (person: string) => t({ id: 'scim.createdBy', message: `Created by ${person}` });
  const settings = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<ScimAdministration>('/api/admin/scim', { signal }),
  });
  const save = useMutation({
    mutationFn: (body: Settings) => api<Settings>('/api/admin/scim', { method: 'PUT', body }),
    onSuccess: () => cache.invalidateQueries({ queryKey: KEY }),
  });
  const draft = useSettingsDraft(
    settings.data?.settings ?? ({ dryRun: true, deleteAction: 'suspend' } as Settings),
    (value) => save.mutateAsync(value),
  );
  const create = useMutation({
    mutationFn: async (rotateId?: string) => {
      const created = await api<ScimToken & { token: string }>(
        rotateId ? `/api/admin/scim/tokens/${encodeURIComponent(rotateId)}/rotate` : '/api/admin/scim/tokens',
        { method: 'POST', ...(rotateId ? {} : { body: { name } }) },
      );
      setSecret(created.token);
      // The query cache and mutation result keep metadata only.
      return created.id;
    },
    onSuccess: () => {
      setName('');
      setConfirm(null);
      return cache.invalidateQueries({ queryKey: KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/admin/scim/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirm(null);
      return cache.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <div className="rio-scim">
      <p>
        <Trans id="scim.intro">
          {
            'Provision people and groups from your identity provider.  Each token can reach only this organization.'
          }
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(settings.error ?? save.error ?? create.error ?? revoke.error)} />
      {settings.isPending || settings.data ? (
        <SettingsLoading isPending={settings.isPending}>
          <div className="rio-scim">
            <TextField
              label={t({ id: 'scim.baseUrl', message: 'SCIM base URL' })}
              value={settings.data?.baseUrl ?? ''}
              isReadOnly
            />
            <Setting
              page={settingsPage}
              id="dry-run"
              label={msg({
                id: 'scim.dryRun',
                message: 'Dry run—record proposed changes without applying them',
              })}
            >
              <Checkbox
                isSelected={draft.value.dryRun}
                isDisabled={!settings.data || save.isPending}
                onChange={(dryRun) => draft.setValue({ ...draft.value, dryRun })}
              >
                <Trans id="scim.dryRun">Dry run—record proposed changes without applying them</Trans>
              </Checkbox>
            </Setting>
            <p>
              <Trans id="scim.dryRun.help">
                {
                  'Use a dry run to check mappings before enabling provisioning.  Previewed accounts are not saved, so later requests for them return not found.'
                }
              </Trans>
            </p>
            <Setting
              page={settingsPage}
              id="delete-action"
              label={msg({ id: 'scim.deleteAction', message: 'When the provider deletes a person' })}
            >
              <Select
                label={t({ id: 'scim.deleteAction', message: 'When the provider deletes a person' })}
                selectedKey={draft.value.deleteAction}
                isDisabled={!settings.data || save.isPending}
                onSelectionChange={(key) => {
                  if (key === 'suspend' || key === 'remove')
                    draft.setValue({ ...draft.value, deleteAction: key });
                }}
              >
                <ListBoxItem id="suspend">
                  <Trans id="scim.delete.suspend">Suspend and keep data and ownership</Trans>
                </ListBoxItem>
                <ListBoxItem id="remove">
                  <Trans id="scim.delete.remove">Remove the account and its access</Trans>
                </ListBoxItem>
              </Select>
            </Setting>
            <p>
              <Trans id="scim.delete.help">
                {
                  'Removing an account keeps its databases and records.  Each database only that person owned goes to the organization’s owner first, and their public links and forms stop for good.'
                }
              </Trans>
            </p>
            <Form
              onSubmit={(event) => {
                event.preventDefault();
                if (settings.data && name.trim() && !create.isPending) create.mutate(undefined);
              }}
            >
              <Heading level={2} id="scim-tokens">
                <Trans id="scim.tokens">Provisioning tokens</Trans>
              </Heading>
              <p>
                <Trans id="scim.tokens.creator">
                  {
                    'A token stops working when the person who created it is suspended or removed, so create it as someone who will stay.'
                  }
                </Trans>
              </p>
              <Setting
                page={settingsPage}
                id="token-name"
                label={msg({ id: 'scim.tokenName', message: 'Token name' })}
                help={msg({
                  id: 'scim.tokens.creator',
                  message:
                    'A token stops working when the person who created it is suspended or removed, so create it as someone who will stay.',
                })}
              >
                <TextField
                  label={t({ id: 'scim.tokenName', message: 'Token name' })}
                  value={name}
                  isDisabled={!settings.data}
                  onChange={setName}
                  isRequired
                  maxLength={120}
                />
              </Setting>
              <Button type="submit" isDisabled={!settings.data || !name.trim()} isPending={create.isPending}>
                <Trans id="scim.create">Create token</Trans>
              </Button>
            </Form>
            <div className="rio-scim__viewport" role="region" aria-labelledby="scim-tokens" tabIndex={0}>
              <ul className="rio-scim__list">
                {settings.data?.tokens.map((token) => (
                  <li key={token.id}>
                    <strong>{token.name}</strong>
                    <span>
                      {token.createdBy
                        ? createdBy(token.createdBy.name)
                        : t({ id: 'scim.createdBy.gone', message: 'Its creator’s account was removed' })}
                    </span>
                    <span>
                      {token.lastUsedAt
                        ? lastUsed(token.lastUsedAt)
                        : t({ id: 'scim.neverUsed', message: 'Never used' })}
                    </span>
                    {token.revokedAt ? (
                      <span>
                        <Trans id="scim.revoked">Revoked</Trans>
                      </span>
                    ) : (
                      <>
                        <Button onPress={() => setConfirm({ token, rotate: true })}>
                          <Trans id="scim.rotate">Rotate</Trans>
                        </Button>
                        <Button onPress={() => setConfirm({ token, rotate: false })}>
                          <Trans id="scim.revoke">Revoke</Trans>
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <Unmanaged members={settings.data?.unmanaged ?? []} />
          </div>
        </SettingsLoading>
      ) : null}
      <Domains />
      <section>
        <Heading level={2}>
          <Trans id="scim.setup.title">Connect your identity provider</Trans>
        </Heading>
        <p>
          <Trans id="scim.setup.okta">
            {
              'In Okta, enable SCIM provisioning for your application.  Put the SCIM base URL in SCIM connector base URL, set the unique identifier to userName, and put the token in the HTTP Header authentication field.  Enable creating users, updating attributes, deactivating users, and group push as needed.'
            }
          </Trans>
        </p>
        <p>
          <Trans id="scim.setup.entra">
            {
              'In Microsoft Entra, open your enterprise application, choose Provisioning, and select Automatic.  Put the SCIM base URL in Tenant URL and the token in Secret Token.  Test the connection, review attribute mappings, and assign the people and groups to provision.'
            }
          </Trans>
        </p>
        <p>
          <Trans id="scim.setup.mapping">
            {
              'userName is the directory’s login name, such as a user principal name.  The person’s email is their primary address, else their work address, else userName when it is an address, and it must be on a domain verified in these settings.  Names map to the person’s name, active controls suspension, and externalId identifies the directory record.  Department, manager, and employee number appear on the person’s profile.  Only provisioned people can be group members, and membership controls any database or folder roles you assign to that group.'
            }
          </Trans>
        </p>
      </section>
      {confirm ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={
            confirm.rotate
              ? t({ id: 'scim.rotate.title', message: 'Rotate this provisioning token?' })
              : t({ id: 'scim.revoke.title', message: 'Revoke this provisioning token?' })
          }
          message={t({
            id: 'scim.revoke.help',
            message:
              'The current token stops working immediately.  Update the identity provider before it sends more requests.',
          })}
          confirmLabel={
            confirm.rotate
              ? t({ id: 'scim.rotate', message: 'Rotate' })
              : t({ id: 'scim.revoke', message: 'Revoke' })
          }
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
          onConfirm={async () => {
            if (confirm.rotate) await create.mutateAsync(confirm.token.id);
            else await revoke.mutateAsync(confirm.token.id);
          }}
        />
      ) : null}
      {secret ? (
        <Modal
          isOpen
          onOpenChange={(open) => {
            if (!open) setSecret(null);
          }}
        >
          <Dialog>
            <DialogTitle>
              <Trans id="scim.created">Save this token now</Trans>
            </DialogTitle>
            <DialogBody>
              <p>
                <Trans id="scim.shownOnce">
                  {
                    'This token is shown once.  Paste it into your identity provider before closing this dialog.'
                  }
                </Trans>
              </p>
              <TextField label={t({ id: 'scim.token', message: 'SCIM token' })} value={secret} isReadOnly />
              <Button onPress={() => setSecret(null)}>
                <Trans id="scim.closeToken">I saved the token</Trans>
              </Button>
            </DialogBody>
          </Dialog>
        </Modal>
      ) : null}
    </div>
  );
}

/** Members the directory doesn't manage, whom suspending or deleting there doesn't reach */
function Unmanaged({ members }: { members: readonly UnmanagedMember[] }) {
  return (
    <section>
      <Heading level={2} id="scim-unmanaged">
        <Trans id="scim.unmanaged">People outside provisioning</Trans>
      </Heading>
      <p>
        <Trans id="scim.unmanaged.help">
          {
            'These members joined by invitation or single sign-on, and suspending or deleting them in your identity provider doesn’t reach them here.  When the provider creates a person with one of these addresses on a verified domain, provisioning manages that member from then on.'
          }
        </Trans>
      </p>
      <div
        className="rio-scim__viewport rio-scim__viewport--members"
        role="region"
        aria-labelledby="scim-unmanaged"
        tabIndex={0}
      >
        {members.length ? (
          <ul className="rio-scim__list">
            {members.map((member) => (
              <li key={member.id}>
                <strong>{member.name}</strong>
                <span>{member.email}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            <Trans id="scim.unmanaged.none">
              Provisioning manages every member except the organization’s owner.
            </Trans>
          </p>
        )}
      </div>
    </section>
  );
}

function Domains() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [providerId, setProviderId] = useState('');
  const [domain, setDomain] = useState('');
  const providers = useQuery({
    queryKey: ['admin', 'sso'],
    queryFn: () => api<SsoProvider[]>('/api/admin/sso'),
  });
  const domains = useQuery({
    queryKey: DOMAINS,
    queryFn: () => api<ScimDomainVerification[]>('/api/admin/scim/domains'),
  });
  const change = useMutation({
    mutationFn: ({ providerId, domain, verify }: { providerId: string; domain: string; verify: boolean }) =>
      api<ScimDomainVerification>(`/api/admin/scim/domains${verify ? '/verify' : ''}`, {
        body: { providerId, domain },
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: DOMAINS }),
  });
  return (
    <section>
      <Heading level={2} id="scim-domains">
        <Trans id="scim.domains">Verify single sign-on domains</Trans>
      </Heading>
      <p>
        <Trans id="scim.domains.help">
          {
            'Provisioning gives people email addresses only on domains verified here, and a provisioned person’s first sign-in needs their domain verified for their single sign-on connection.  Add the domain to that connection’s allowed domains, generate a challenge here, and publish the displayed DNS TXT record.  Challenges expire after one day.  Keep the record published: verified domains are checked daily, and three failed checks in a row take verification away.  Only one organization on this server can verify a domain.'
          }
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(providers.error ?? domains.error ?? change.error)} />
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          change.mutate({ providerId, domain, verify: false });
        }}
      >
        <Setting
          page={settingsPage}
          id="provider"
          label={msg({ id: 'scim.provider', message: 'Single sign-on connection' })}
        >
          <Select
            label={t({ id: 'scim.provider', message: 'Single sign-on connection' })}
            selectedKey={providerId || null}
            onSelectionChange={(key) => setProviderId(String(key ?? ''))}
          >
            {providers.data?.map((provider) => (
              <ListBoxItem id={provider.id} key={provider.id}>
                {provider.name}
              </ListBoxItem>
            ))}
          </Select>
        </Setting>
        <Setting page={settingsPage} id="domain" label={msg({ id: 'scim.domain', message: 'Email domain' })}>
          <TextField
            label={t({ id: 'scim.domain', message: 'Email domain' })}
            value={domain}
            onChange={setDomain}
            isRequired
          />
        </Setting>
        <Button type="submit" isDisabled={!providerId || !domain.trim()} isPending={change.isPending}>
          <Trans id="scim.challenge">Generate DNS challenge</Trans>
        </Button>
      </Form>
      <div className="rio-scim__viewport" role="region" aria-labelledby="scim-domains" tabIndex={0}>
        <ul className="rio-scim__list">
          {domains.data?.map((entry) => (
            <li key={`${entry.providerId}:${entry.domain}`}>
              <strong>{entry.domain}</strong>
              <span>{providers.data?.find((provider) => provider.id === entry.providerId)?.name}</span>
              {entry.verifiedAt ? (
                <>
                  <span>
                    <Trans id="scim.verified">Verified</Trans>
                  </span>
                  {entry.failedChecks > 0 ? (
                    <span className="rio-scim__warning">
                      {t({
                        id: 'scim.failedChecks',
                        message: plural(entry.failedChecks, {
                          one: 'The last daily check couldn’t find the record.',
                          other: 'The last # daily checks couldn’t find the record.',
                        }),
                      })}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <TextField
                    label={t({ id: 'scim.dnsName', message: 'DNS TXT record name' })}
                    value={entry.recordName}
                    isReadOnly
                  />
                  <TextField
                    label={t({ id: 'scim.dnsValue', message: 'DNS TXT record value' })}
                    value={entry.recordValue}
                    isReadOnly
                  />
                  <Button
                    isPending={change.isPending}
                    onPress={() =>
                      change.mutate({ providerId: entry.providerId, domain: entry.domain, verify: true })
                    }
                  >
                    <Trans id="scim.verifyDomain">Verify domain</Trans>
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
