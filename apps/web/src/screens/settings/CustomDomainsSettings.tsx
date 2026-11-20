import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { useSettingsDraft, useSettingsSection } from './SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from './Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CUSTOM_DOMAIN_HOST_MAX,
  DEFAULT_PUBLIC_PAGE_KINDS,
  PUBLIC_PAGE_KINDS,
  type CustomDomain,
  type PublicPageKind,
} from '@riosoma/contracts';
import { Button, Checkbox, ConfirmDialog, Form, Heading, Spinner, TextField } from '@riosoma/ui';
import { api } from '../../api';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';
import { canManageIntegrations } from './connections/IntegrationsSettings';
import './custom-domains.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'custom-domains',
  label: msg({ id: 'customDomains.title', message: 'Custom domains' }),
  roles: ['integrations'],
  keywords: msg({
    id: 'settings.search.keywords.custom-domains',
    message: 'custom domains DNS host names routing',
  }),
});

const KEY = ['admin', 'custom-domains'];
const PATH = '/api/admin/custom-domains';

export function CustomDomainsSettings() {
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'customDomains.title', message: 'Custom domains' })}
    >
      {canManageIntegrations(useSession()) ? (
        <Domains />
      ) : (
        <ErrorBanner error={{ key: 'errors.adminOnly' }} />
      )}
    </Setting>
  );
}

function Domains() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const [host, setHost] = useState('');
  const [queued, setQueued] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [kinds, setKinds] = useState<PublicPageKind[]>([...DEFAULT_PUBLIC_PAGE_KINDS]);
  const [removing, setRemoving] = useState<CustomDomain | null>(null);
  const labels: Record<PublicPageKind, string> = {
    sites: t({ id: 'sites.kind', message: 'Sites' }),
    forms: t({ id: 'customDomains.forms', message: 'Forms' }),
    views: t({ id: 'customDomains.views', message: 'View links' }),
    bookings: t({ id: 'customDomains.bookings', message: 'Booking pages' }),
    signing: t({ id: 'customDomains.signing', message: 'Signing pages' }),
  };
  const domains = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<CustomDomain[]>(PATH, { signal }),
  });
  const change = useMutation({
    mutationFn: ({
      path,
      method,
      body,
    }: {
      path: string;
      method: 'POST' | 'PATCH' | 'DELETE';
      body?: unknown;
    }) => api<CustomDomain | undefined>(path, { method, body }),
    onSuccess: (_result, variables) => {
      if (variables.path === PATH) {
        setHost('');
        setKinds([...DEFAULT_PUBLIC_PAGE_KINDS]);
        setQueued(false);
      }
      setRemoving(null);
    },
    onSettled: () => cache.invalidateQueries({ queryKey: KEY }),
  });
  const storedDomains = (domains.data ?? []).map((domain) => ({
    ...domain,
    kinds: PUBLIC_PAGE_KINDS.filter((kind) => domain.kinds.includes(kind)),
  }));
  const draft = useSettingsDraft(storedDomains, async (values) => {
    for (const domain of values) {
      const stored = domains.data?.find((item) => item.id === domain.id);
      if (JSON.stringify([...(stored?.kinds ?? [])].sort()) !== JSON.stringify([...domain.kinds].sort()))
        await change.mutateAsync({
          path: `${PATH}/${domain.id}`,
          method: 'PATCH',
          body: { kinds: domain.kinds },
        });
    }
  });
  useSettingsSection({
    dirty: Boolean(host) || queued || JSON.stringify(kinds) !== JSON.stringify(DEFAULT_PUBLIC_PAGE_KINDS),
    discard: () => {
      setHost('');
      setKinds([...DEFAULT_PUBLIC_PAGE_KINDS]);
      setQueued(false);
      setInvalid(false);
    },
    validate: () => {
      const valid = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host.trim());
      setInvalid(!valid);
      return valid
        ? null
        : t({
            id: 'customDomains.invalidHost',
            message: 'Enter a complete host name, such as pages.example.com.',
          });
    },
    save: () => change.mutateAsync({ path: PATH, method: 'POST', body: { host, kinds } }),
  });
  const choices = (selected: PublicPageKind[], update: (next: PublicPageKind[]) => void) => (
    <div className="rio-custom-domains__kinds">
      {PUBLIC_PAGE_KINDS.map((kind) => (
        <Setting
          page={settingsPage}
          id="page-types"
          label={msg({ id: 'settings.search.pageTypes', message: 'Public page types' })}
        >
          <Checkbox
            key={kind}
            isSelected={selected.includes(kind)}
            isDisabled={change.isPending || (selected.length === 1 && selected.includes(kind))}
            onChange={(checked) =>
              update(PUBLIC_PAGE_KINDS.filter((item) => (item === kind ? checked : selected.includes(item))))
            }
          >
            {labels[kind]}
          </Checkbox>
        </Setting>
      ))}
    </div>
  );
  return (
    <div className="rio-custom-domains">
      <p>
        <Trans id="customDomains.intro">
          Publish your organization’s public pages on a domain you control.
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(domains.error ?? change.error)} />
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (host.trim() && !change.isPending) setQueued(true);
        }}
      >
        <Setting
          page={settingsPage}
          id="host"
          label={msg({ id: 'customDomains.host', message: 'Host name' })}
        >
          <TextField
            label={t({ id: 'customDomains.host', message: 'Host name' })}
            value={host}
            onChange={setHost}
            isRequired
            maxLength={CUSTOM_DOMAIN_HOST_MAX}
            isInvalid={invalid}
            errorMessage={t({
              id: 'customDomains.invalidHost',
              message: 'Enter a complete host name, such as pages.example.com.',
            })}
            autoComplete="off"
          />
        </Setting>
        {choices(kinds, setKinds)}
        <Button type="submit" isDisabled={!host.trim() || change.isPending}>
          <Trans id="customDomains.add">Add domain</Trans>
        </Button>
      </Form>
      {queued && (
        <p role="status">
          {t({
            id: 'customDomains.queued',
            message: 'The new domain will be added when you save this page.',
          })}
        </p>
      )}
      {domains.isPending && <Spinner />}
      {draft.value.map((domain) => (
        <section key={domain.id} className="rio-custom-domains__domain" aria-label={domain.host}>
          <Heading level={2}>{domain.host}</Heading>
          <p>
            {domain.verifiedAt
              ? t({ id: 'customDomains.verified', message: 'Verified' })
              : t({ id: 'customDomains.pending', message: 'Awaiting verification' })}
          </p>
          <TextField
            label={t({ id: 'customDomains.txtName', message: 'TXT record name' })}
            value={domain.recordName}
            isReadOnly
          />
          <TextField
            label={t({ id: 'customDomains.txtValue', message: 'TXT record value' })}
            value={domain.recordValue}
            isReadOnly
          />
          <TextField
            label={t({ id: 'customDomains.targetType', message: 'Routing record type' })}
            value={domain.targetType}
            isReadOnly
          />
          <TextField
            label={t({ id: 'customDomains.target', message: 'Routing record target' })}
            value={domain.target}
            isReadOnly
          />
          <p>
            {t({
              id: 'customDomains.dnsHelp',
              message:
                'Keep the TXT record published.  Riosoma checks it daily, and three failed checks in a row stop this domain.  Your server’s proxy must also support custom domain HTTPS.',
            })}
          </p>
          {choices(domain.kinds, (next) =>
            draft.setValue((current) =>
              current.map((item) => (item.id === domain.id ? { ...item, kinds: next } : item)),
            ),
          )}
          <div className="rio-custom-domains__actions">
            <Button
              isDisabled={change.isPending}
              onPress={() => change.mutate({ path: `${PATH}/${domain.id}/verify`, method: 'POST' })}
            >
              <Trans id="customDomains.verify">Verify domain</Trans>
            </Button>
            <Button
              isDisabled={change.isPending}
              onPress={() => setRemoving(domain)}
              aria-label={t({ id: 'customDomains.remove', message: 'Remove domain' })}
              icon={faXmark}
            />
          </div>
        </section>
      ))}
      <ConfirmDialog
        isOpen={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t({ id: 'customDomains.removeTitle', message: 'Remove this domain?' })}
        confirmLabel={t({ id: 'customDomains.remove', message: 'Remove domain' })}
        onConfirm={async () => {
          if (removing) await change.mutateAsync({ path: `${PATH}/${removing.id}`, method: 'DELETE' });
        }}
        message={t({
          id: 'customDomains.removeHelp',
          message:
            'Pages on this domain stop immediately.  New links use another verified domain or the main address.',
        })}
      />
    </div>
  );
}
