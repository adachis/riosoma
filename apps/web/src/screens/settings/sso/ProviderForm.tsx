import { faCopy, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  SsoProviderCreate,
  SsoProviderUpdate,
  type OidcKind,
  type SsoProvider,
  type SsoTestResult,
} from '@riosoma/contracts';
import { Banner, Button, Checkbox, Form, Switch, TextField, toast } from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import './sso.css';
const tenantHelp = msg({
  id: 'sso.field.tenantHelp',
  message: 'Leave empty to allow any work or school account.',
});

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sso',
  label: msg({ id: 'settings.nav.sso', message: 'Single sign-on' }),
  roles: ['security'],
});

/** The issuer a provider signs in against, worked out the way the server does, for a test. */
export function issuerFor(kind: OidcKind, issuer: string, tenant: string): string {
  if (kind === 'google') return 'https://accounts.google.com';
  if (kind === 'microsoft')
    return `https://login.microsoftonline.com/${tenant.trim() || 'organizations'}/v2.0`;
  return issuer.trim();
}

/** Domains typed with commas, spaces, or line breaks between them, once each. */
export function domainList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((domain) => domain.toLowerCase())
        .filter(Boolean),
    ),
  ];
}

interface Issues {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>;
}

/** The same field keys the server sends back, so both kinds of complaint read alike. */
export function fieldKeys(error: Issues): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues)
    fields[issue.path.map(String).join('.') || '_'] ??= `validation.${issue.code}`;
  return fields;
}

export interface ProviderFormProps {
  kind: OidcKind;
  /** The provider being edited, or a new one when left out */
  provider?: SsoProvider;
  /** The callback address to register with the provider */
  callback: string;
  /** What the button says until someone types a label of their own */
  defaultName?: string;
  onSaved(provider: SsoProvider): void | Promise<void>;
  /** Offered for an existing provider, which the list asks about before deleting */
  onDelete?(): void;
}

/**
 * Everything about one provider: where it lives, the client the provider issued, who may use it,
 * and whether it shows on the sign-in page.  A stored secret is never shown, only replaced.
 */
export function ProviderForm({
  kind,
  provider,
  callback,
  defaultName = '',
  onSaved,
  onDelete,
}: ProviderFormProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  // Where a provider lives and its client are the owner's to set.  Everyone else reads them, and
  // can turn linking off but not on.
  const owner = useSession()?.membership.kind === 'owner';
  const [name, setName] = useState(provider?.name ?? defaultName);
  const [issuer, setIssuer] = useState(provider?.kind === 'oidc' ? provider.issuer : '');
  const [tenant, setTenant] = useState(provider?.tenant ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [domains, setDomains] = useState(provider?.allowedDomains.join(', ') ?? '');
  const [autoCreate, setAutoCreate] = useState(provider?.autoCreate ?? false);
  const [linkByEmail, setLinkByEmail] = useState(provider?.linkByEmail ?? true);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [invalid, setInvalid] = useState<Record<string, string>>({});

  // The server never sends a stored secret to a new issuer, so moving one needs the secret again.
  const moving = kind === 'oidc' && provider !== undefined && issuer.trim() !== provider.issuer;
  const askSecret = !provider || replacing || moving || Boolean(secret);

  const save = useMutation({
    mutationFn: (body: SsoProviderUpdate) =>
      provider
        ? api<SsoProvider>(`/api/admin/sso/${encodeURIComponent(provider.id)}`, { method: 'PATCH', body })
        : api<SsoProvider>('/api/admin/sso', { body: { kind, ...body } }),
    onSuccess: async (saved, submitted) => {
      setName((current) => (current.trim() === submitted.name ? saved.name : current));
      setClientId((current) => (current.trim() === submitted.clientId ? saved.clientId : current));
      setIssuer((current) => (current.trim() === submitted.issuer ? (saved.issuer ?? '') : current));
      setTenant((current) => (current.trim() === submitted.tenant ? (saved.tenant ?? '') : current));
      setDomains((current) =>
        JSON.stringify(domainList(current)) === JSON.stringify(submitted.allowedDomains)
          ? saved.allowedDomains.join(', ')
          : current,
      );
      setSecret((current) => (current === submitted.clientSecret ? '' : current));
      setReplacing(false);
      await onSaved(saved);
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<SsoTestResult>('/api/admin/sso/test', { body: { issuer: issuerFor(kind, issuer, tenant) } }),
  });

  const serverFields = save.error instanceof ApiError ? (save.error.info.fields ?? {}) : {};
  const fields = { ...invalid, ...serverFields };
  const domainKey = Object.entries(fields).find(([key]) => key.startsWith('allowedDomains'))?.[1];
  const problem = (key: string | undefined) =>
    key ? { isInvalid: true, errorMessage: message(key), validationBehavior: 'aria' as const } : {};

  function check() {
    const body = {
      name: name.trim(),
      clientId: clientId.trim(),
      allowedDomains: domainList(domains),
      autoCreate,
      linkByEmail,
      enabled,
      ...(kind === 'oidc' && issuer.trim() ? { issuer: issuer.trim() } : {}),
      ...(kind === 'microsoft' ? { tenant: tenant.trim() } : {}),
      ...(askSecret && secret ? { clientSecret: secret } : {}),
    };
    // The contract is the rule book: what it would refuse never reaches the server.
    const parsed = provider
      ? SsoProviderUpdate.safeParse(body)
      : SsoProviderCreate.safeParse({ kind, ...body });
    const found = parsed.success ? {} : fieldKeys(parsed.error);
    const required = (field: string, missing: boolean) => {
      if (missing) found[field] = 'validation.invalid_type';
    };
    required('name', !body.name);
    required('clientId', !body.clientId);
    required('issuer', kind === 'oidc' && !issuer.trim());
    required('clientSecret', askSecret && (!provider || moving) && !secret);
    if (moving && !secret) found.clientSecret = 'sso.secret.reenter';
    setInvalid(found);
    save.reset();
    return { body, valid: parsed.success && Object.keys(found).length === 0 };
  }
  async function submit() {
    const checked = check();
    if (!checked.valid) throw new Error('validation.invalid_type');
    await save.mutateAsync(checked.body);
  }

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callback);
    } catch {
      // Without clipboard access the address stays in its field, where it can be copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'sso.copied', message: 'Copied' }) });
  }

  const secretLabel = t({ id: 'sso.field.clientSecret', message: 'Client secret' });
  const tested = test.data;

  const pageDraft = useSettingsSection({
    dirty:
      Boolean(provider) &&
      JSON.stringify([
        name.trim(),
        issuer.trim(),
        tenant.trim(),
        clientId.trim(),
        domainList(domains),
        autoCreate,
        linkByEmail,
        enabled,
        secret,
      ]) !==
        JSON.stringify([
          provider?.name ?? defaultName,
          provider?.kind === 'oidc' ? provider.issuer : '',
          provider?.tenant ?? '',
          provider?.clientId ?? '',
          provider?.allowedDomains ?? [],
          provider?.autoCreate ?? false,
          provider?.linkByEmail ?? true,
          provider?.enabled ?? true,
          '',
        ]),
    stored: provider,
    discard: () => {
      setName(provider?.name ?? defaultName);
      setIssuer(provider?.kind === 'oidc' ? provider.issuer : '');
      setTenant(provider?.tenant ?? '');
      setClientId(provider?.clientId ?? '');
      setSecret('');
      setReplacing(false);
      setDomains(provider?.allowedDomains.join(', ') ?? '');
      setAutoCreate(provider?.autoCreate ?? false);
      setLinkByEmail(provider?.linkByEmail ?? true);
      setEnabled(provider?.enabled ?? true);
      setInvalid({});
    },
    validate: () =>
      check().valid
        ? null
        : t({ id: 'sso.invalidDraft', message: 'Complete the required single sign-on fields.' }),
    save: submit,
  });
  return (
    <Form
      className="rio-sso__form"
      validationBehavior="aria"
      onSubmit={(event) => {
        event.preventDefault();
        if (provider) void pageDraft.save?.();
        else void submit().catch(() => undefined);
      }}
    >
      <Setting
        page={settingsPage}
        id="provider-name"
        label={msg({ id: 'sso.field.name', message: 'Button label' })}
      >
        <TextField
          label={t({ id: 'sso.field.name', message: 'Button label' })}
          value={name}
          onChange={setName}
          maxLength={60}
          isRequired
          {...problem(fields.name)}
        />
      </Setting>
      {kind === 'oidc' ? (
        <Setting
          page={settingsPage}
          id="provider-issuer"
          label={msg({ id: 'sso.field.issuer', message: 'Issuer URL' })}
        >
          <TextField
            label={t({ id: 'sso.field.issuer', message: 'Issuer URL' })}
            type="url"
            value={issuer}
            onChange={(value) => {
              setIssuer(value);
              test.reset();
            }}
            maxLength={500}
            isRequired
            isReadOnly={!owner}
            {...problem(fields.issuer)}
          />
        </Setting>
      ) : null}
      {kind === 'microsoft' ? (
        <Setting
          page={settingsPage}
          id="provider-tenant"
          label={msg({ id: 'sso.field.tenant', message: 'Tenant ID or domain' })}
          help={tenantHelp}
        >
          <TextField
            label={t({ id: 'sso.field.tenant', message: 'Tenant ID or domain' })}
            description={t(tenantHelp)}
            value={tenant}
            onChange={(value) => {
              setTenant(value);
              test.reset();
            }}
            maxLength={100}
            isReadOnly={!owner}
            {...problem(fields.tenant)}
          />
        </Setting>
      ) : null}
      <Setting
        page={settingsPage}
        id="provider-client-id"
        label={msg({ id: 'sso.field.clientId', message: 'Client ID' })}
      >
        <TextField
          label={t({ id: 'sso.field.clientId', message: 'Client ID' })}
          value={clientId}
          onChange={setClientId}
          maxLength={500}
          isRequired
          isReadOnly={!owner}
          {...problem(fields.clientId)}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="provider-secret"
        label={msg({ id: 'sso.field.clientSecret', message: 'Client secret' })}
      >
        {askSecret ? (
          <TextField
            label={secretLabel}
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={setSecret}
            maxLength={2000}
            isRequired={!provider || moving}
            autoFocus={replacing}
            {...problem(fields.clientSecret)}
          />
        ) : (
          <div className="rio-sso__secret" role="group" aria-label={secretLabel}>
            <span className="rio-sso__label">{secretLabel}</span>
            <span>
              <Trans id="sso.secret.stored">Stored</Trans>
            </span>
            <Button size="sm" isDisabled={!owner} onPress={() => setReplacing(true)}>
              <Trans id="sso.secret.replace">Replace</Trans>
            </Button>
          </div>
        )}
      </Setting>
      <div className="rio-sso__callback">
        <div className="rio-sso__callback-field">
          <TextField
            label={t({ id: 'sso.field.redirect', message: 'Callback address to register with the provider' })}
            value={callback}
            isReadOnly
          />
        </div>
        <Button
          onPress={() => void copyCallback()}
          aria-label={t({ id: 'sso.copy', message: 'Copy' })}
          icon={faCopy}
        />
      </div>
      <Setting
        page={settingsPage}
        id="provider-domains"
        label={msg({ id: 'sso.field.domains', message: 'Email domains that may create accounts' })}
      >
        <TextField
          label={t({ id: 'sso.field.domains', message: 'Email domains that may create accounts' })}
          value={domains}
          onChange={setDomains}
          {...problem(domainKey)}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="provider-auto-create"
        label={msg({
          id: 'sso.field.autoCreate',
          message: 'Create accounts for new people from these domains',
        })}
      >
        <Checkbox isSelected={autoCreate} onChange={setAutoCreate}>
          <Trans id="sso.field.autoCreate">Create accounts for new people from these domains</Trans>
        </Checkbox>
      </Setting>
      <Setting
        page={settingsPage}
        id="provider-link-by-email"
        label={msg({
          id: 'sso.field.linkByEmail',
          message: 'Link to existing accounts with the same verified email',
        })}
      >
        <Checkbox
          isSelected={linkByEmail}
          onChange={setLinkByEmail}
          isDisabled={!owner && !provider?.linkByEmail}
        >
          <Trans id="sso.field.linkByEmail">Link to existing accounts with the same verified email</Trans>
        </Checkbox>
      </Setting>
      <Setting
        page={settingsPage}
        id="provider-enabled"
        label={msg({ id: 'sso.field.enabled', message: 'Show on the sign-in page' })}
      >
        <Switch isSelected={enabled} onChange={setEnabled}>
          <Trans id="sso.field.enabled">Show on the sign-in page</Trans>
        </Switch>
      </Setting>
      {tested?.ok ? (
        <Banner tone="success">
          <Trans id="sso.test.passed">Found the provider.</Trans>
        </Banner>
      ) : null}
      {tested && !tested.ok ? <ErrorBanner error={{ key: tested.messageKey ?? 'errors.internal' }} /> : null}
      <ErrorBanner error={errorInfo(test.error ?? save.error)} />
      <div className="rio-sso__buttons">
        <Button
          isPending={test.isPending}
          isDisabled={kind === 'oidc' && !issuer.trim()}
          onPress={() => test.mutate()}
        >
          <Trans id="sso.test">Test</Trans>
        </Button>
        {onDelete ? (
          <Button
            variant="danger"
            onPress={onDelete}
            aria-label={t({ id: 'sso.delete', message: 'Delete' })}
            icon={faTrashCan}
          />
        ) : null}
        {!provider && (
          <Button className="rio-sso__save" type="submit" variant="primary" isPending={save.isPending}>
            <Trans id="sso.save">Save</Trans>
          </Button>
        )}
      </div>
    </Form>
  );
}
