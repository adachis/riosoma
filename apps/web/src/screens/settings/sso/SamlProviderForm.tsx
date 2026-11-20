import { faCopy, faDownload, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { useSettingsSection } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  SsoProviderCreate,
  SsoProviderUpdate,
  type SamlCertificate,
  type SamlDraft,
  type SamlMetadata,
  type SamlMetadataSource,
  type SsoProvider,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Form,
  Heading,
  Switch,
  TextArea,
  TextField,
  Text,
  toast,
} from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { saveFile } from '../../database/view/download';
import { errorInfo } from '../../setup/useSetup';
import { domainList, fieldKeys } from './ProviderForm';
import './sso.css';
const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sso',
  label: msg({ id: 'settings.nav.sso', message: 'Single sign-on' }),
  roles: ['security'],
});

export interface SamlProviderFormProps {
  /** The provider being edited, or a new one when left out */
  provider?: SsoProvider;
  /** A new provider's ID and Riosoma's details for it, from the server */
  draft?: SamlDraft;
  onSaved(provider: SsoProvider): void;
  /** Offered for an existing provider, which the list asks about before deleting */
  onDelete?(): void;
}

/** The certificates as one block of PEM text, the way the field shows them. */
function certificateText(certificates: readonly SamlCertificate[]): string {
  return certificates.map((certificate) => certificate.pem.trim()).join('\n');
}

/** A metadata address starts with http, and anything else is the metadata itself. */
function metadataSource(text: string): SamlMetadataSource {
  const value = text.trim();
  return /^https?:\/\//i.test(value) ? { url: value } : { xml: value };
}

/**
 * A SAML identity provider: Riosoma's details to enter there, the identity provider's own details,
 * read from its metadata or typed in, and the same account settings every provider has.
 */
export function SamlProviderForm({ provider, draft, onSaved, onDelete }: SamlProviderFormProps) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  // The identity provider's details are the owner's to set.  Everyone else reads them, and can
  // turn verified emails and linking off but not on.
  const owner = useSession()?.membership.kind === 'owner';
  const ids = useId();
  const saml = provider?.saml;
  const serviceProvider = saml?.serviceProvider ?? draft?.serviceProvider;
  const [name, setName] = useState(provider?.name ?? '');
  const [source, setSource] = useState('');
  const [entityId, setEntityId] = useState(saml?.entityId ?? '');
  const [ssoUrl, setSsoUrl] = useState(saml?.ssoUrl ?? '');
  const [certificates, setCertificates] = useState(certificateText(saml?.certificates ?? []));
  // The certificates the field holds, as the server read them.  Typing in the field hides them
  // until the next save or load says what it holds.
  const [read, setRead] = useState<SamlCertificate[]>(saml?.certificates ?? []);
  const [verifiesEmails, setVerifiesEmails] = useState(saml?.verifiesEmails ?? false);
  const [domains, setDomains] = useState(provider?.allowedDomains.join(', ') ?? '');
  const [autoCreate, setAutoCreate] = useState(provider?.autoCreate ?? false);
  const [linkByEmail, setLinkByEmail] = useState(provider?.linkByEmail ?? true);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [invalid, setInvalid] = useState<Record<string, string>>({});

  const load = useMutation({
    mutationFn: (body: SamlMetadataSource) => api<SamlMetadata>('/api/admin/sso/saml/metadata', { body }),
    onSuccess: (found) => {
      setEntityId(found.entityId);
      setSsoUrl(found.ssoUrl);
      setCertificates(certificateText(found.certificates));
      setRead(found.certificates);
    },
  });
  const save = useMutation({
    mutationFn: (body: SsoProviderUpdate) =>
      provider
        ? api<SsoProvider>(`/api/admin/sso/${encodeURIComponent(provider.id)}`, { method: 'PATCH', body })
        : api<SsoProvider>('/api/admin/sso', { body: { kind: 'saml', id: draft?.id, ...body } }),
    onSuccess: (saved) => {
      const stored = saved.saml?.certificates ?? [];
      setCertificates(certificateText(stored));
      setRead(stored);
      onSaved(saved);
    },
  });

  const serverFields = save.error instanceof ApiError ? (save.error.info.fields ?? {}) : {};
  const fields = { ...invalid, ...serverFields };
  const loadFields = load.error instanceof ApiError ? (load.error.info.fields ?? {}) : {};
  const firstOf = (prefix: string, from: Record<string, string>) =>
    Object.entries(from).find(([key]) => key === prefix || key.startsWith(`${prefix}.`))?.[1];
  const problem = (key: string | undefined) =>
    key ? { isInvalid: true, errorMessage: message(key), validationBehavior: 'aria' as const } : {};

  function check() {
    const body = {
      name: name.trim(),
      saml: {
        entityId: entityId.trim(),
        ssoUrl: ssoUrl.trim(),
        certificates: certificates.trim() ? [certificates.trim()] : [],
        verifiesEmails,
      },
      allowedDomains: domainList(domains),
      autoCreate,
      linkByEmail,
      enabled,
    };
    // The contract is the rule book: what it would refuse never reaches the server.
    const parsed = provider
      ? SsoProviderUpdate.safeParse(body)
      : SsoProviderCreate.safeParse({ kind: 'saml', ...(draft ? { id: draft.id } : {}), ...body });
    const found = parsed.success ? {} : fieldKeys(parsed.error);
    const required = (field: string, missing: boolean) => {
      if (missing) found[field] = 'validation.invalid_type';
    };
    required('name', !body.name);
    required('saml.entityId', !body.saml.entityId);
    required('saml.ssoUrl', !body.saml.ssoUrl);
    required('saml.certificates', !body.saml.certificates.length);
    setInvalid(found);
    save.reset();
    return { body, valid: parsed.success && Object.keys(found).length === 0 };
  }
  async function submit() {
    const checked = check();
    if (!checked.valid) throw new Error('validation.invalid_type');
    await save.mutateAsync(checked.body);
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Without clipboard access the value stays in its field, where it can be copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'sso.copied', message: 'Copied' }) });
  }

  function download() {
    if (!serviceProvider) return;
    const file = new Blob([serviceProvider.metadata], { type: 'application/samlmetadata+xml' });
    saveFile(file, `riosoma-saml-${provider?.id ?? draft?.id ?? 'metadata'}.xml`);
  }

  // Read once per render, like the other screens that compare dates with today.
  const today = new Date();
  const certificateList = read.map((certificate) => {
    const { subject } = certificate;
    const expires = new Date(certificate.expiresAt);
    const date = i18n.date(expires, { dateStyle: 'medium' });
    return (
      <li key={certificate.fingerprint}>
        {expires < today
          ? t({ id: 'sso.saml.certificate.expired', message: `${subject}, expired ${date}` })
          : t({ id: 'sso.saml.certificate.expires', message: `${subject}, expires ${date}` })}
      </li>
    );
  });

  const pageDraft = useSettingsSection({
    dirty:
      Boolean(provider) &&
      JSON.stringify([
        name,
        entityId,
        ssoUrl,
        certificates,
        verifiesEmails,
        domains,
        autoCreate,
        linkByEmail,
        enabled,
      ]) !==
        JSON.stringify([
          provider?.name ?? '',
          saml?.entityId ?? '',
          saml?.ssoUrl ?? '',
          certificateText(saml?.certificates ?? []),
          saml?.verifiesEmails ?? false,
          provider?.allowedDomains.join(', ') ?? '',
          provider?.autoCreate ?? false,
          provider?.linkByEmail ?? true,
          provider?.enabled ?? true,
        ]),
    stored: provider,
    discard: () => {
      setName(provider?.name ?? '');
      setEntityId(saml?.entityId ?? '');
      setSsoUrl(saml?.ssoUrl ?? '');
      setCertificates(certificateText(saml?.certificates ?? []));
      setRead(saml?.certificates ?? []);
      setVerifiesEmails(saml?.verifiesEmails ?? false);
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
        id="saml-name"
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

      {serviceProvider ? (
        <section className="rio-sso__part" aria-labelledby={`${ids}-riosoma`}>
          <Heading level={3} id={`${ids}-riosoma`}>
            <Trans id="sso.saml.riosoma.title">Riosoma’s details</Trans>
          </Heading>
          <Text elementType="p" variant="muted">
            <Trans id="sso.saml.riosoma.intro">
              Enter these in your identity provider’s settings for Riosoma.
            </Trans>
          </Text>
          <div className="rio-sso__callback">
            <div className="rio-sso__callback-field">
              <TextField
                label={t({ id: 'sso.saml.riosoma.entityId', message: 'Entity ID' })}
                description={t({
                  id: 'sso.saml.riosoma.entityIdHelp',
                  message: 'Also called the audience or the identifier.',
                })}
                value={serviceProvider.entityId}
                isReadOnly
              />
            </div>
            <Button
              aria-label={t({ id: 'sso.saml.riosoma.copyEntityId', message: 'Copy entity ID' })}
              onPress={() => void copy(serviceProvider.entityId)}
              icon={faCopy}
            />
          </div>
          <div className="rio-sso__callback">
            <div className="rio-sso__callback-field">
              <TextField
                label={t({ id: 'sso.saml.riosoma.acsUrl', message: 'Assertion Consumer Service URL' })}
                description={t({
                  id: 'sso.saml.riosoma.acsUrlHelp',
                  message: 'Also called the ACS, reply, or single sign-on URL.',
                })}
                value={serviceProvider.acsUrl}
                isReadOnly
              />
            </div>
            <Button
              aria-label={t({ id: 'sso.saml.riosoma.copyAcsUrl', message: 'Copy ACS URL' })}
              onPress={() => void copy(serviceProvider.acsUrl)}
              icon={faCopy}
            />
          </div>
          <div>
            <Button
              onPress={download}
              aria-label={t({ id: 'sso.saml.riosoma.download', message: 'Download Riosoma’s metadata' })}
              icon={faDownload}
            />
          </div>
        </section>
      ) : null}

      <section className="rio-sso__part" aria-labelledby={`${ids}-idp`}>
        <Heading level={3} id={`${ids}-idp`}>
          <Trans id="sso.saml.idp.title">Identity provider’s details</Trans>
        </Heading>
        {owner ? (
          <>
            <Setting
              page={settingsPage}
              id="saml-source"
              label={msg({ id: 'sso.saml.metadata.source', message: 'Metadata URL or XML' })}
            >
              <TextArea
                label={t({ id: 'sso.saml.metadata.source', message: 'Metadata URL or XML' })}
                description={t({
                  id: 'sso.saml.metadata.sourceHelp',
                  message: 'Paste its metadata address or the metadata itself to fill in the fields below.',
                })}
                value={source}
                onChange={(value) => {
                  setSource(value);
                  load.reset();
                }}
                rows={2}
                {...problem(firstOf('url', loadFields) ?? firstOf('xml', loadFields))}
              />
            </Setting>
            <div>
              <Button
                isPending={load.isPending}
                isDisabled={!source.trim()}
                onPress={() => load.mutate(metadataSource(source))}
              >
                <Trans id="sso.saml.metadata.load">Load metadata</Trans>
              </Button>
            </div>
            {load.isSuccess ? (
              <Banner tone="success">
                <Trans id="sso.saml.metadata.loaded">
                  Filled in the identity provider’s details from its metadata.
                </Trans>
              </Banner>
            ) : null}
            {load.error && !(load.error instanceof ApiError && load.error.info.fields) ? (
              <ErrorBanner error={errorInfo(load.error)} />
            ) : null}
          </>
        ) : null}
        <Setting
          page={settingsPage}
          id="saml-entity-id"
          label={msg({ id: 'sso.saml.field.entityId', message: 'Identity provider’s entity ID' })}
        >
          <TextField
            label={t({ id: 'sso.saml.field.entityId', message: 'Identity provider’s entity ID' })}
            description={t({ id: 'sso.saml.field.entityIdHelp', message: 'Also called its issuer.' })}
            value={entityId}
            onChange={setEntityId}
            maxLength={1024}
            isRequired
            isReadOnly={!owner}
            {...problem(fields['saml.entityId'])}
          />
        </Setting>
        <Setting
          page={settingsPage}
          id="saml-sso-url"
          label={msg({ id: 'sso.saml.field.ssoUrl', message: 'Sign-in URL' })}
        >
          <TextField
            label={t({ id: 'sso.saml.field.ssoUrl', message: 'Sign-in URL' })}
            description={t({
              id: 'sso.saml.field.ssoUrlHelp',
              message: 'Where it signs people in with the HTTP-Redirect binding.',
            })}
            type="url"
            value={ssoUrl}
            onChange={setSsoUrl}
            maxLength={2048}
            isRequired
            isReadOnly={!owner}
            {...problem(fields['saml.ssoUrl'])}
          />
        </Setting>
        <Setting
          page={settingsPage}
          id="saml-certificates"
          label={msg({ id: 'sso.saml.field.certificates', message: 'Signing certificates' })}
        >
          <TextArea
            label={t({ id: 'sso.saml.field.certificates', message: 'Signing certificates' })}
            description={t({
              id: 'sso.saml.field.certificatesHelp',
              message: 'One or more, as PEM or base64.  During a rotation, include the old one and the new.',
            })}
            value={certificates}
            onChange={(value) => {
              setCertificates(value);
              setRead([]);
            }}
            rows={4}
            isRequired
            isReadOnly={!owner}
            {...problem(firstOf('saml.certificates', fields))}
          />
        </Setting>
        {certificateList.length ? (
          <ul
            className="rio-sso__certificates"
            aria-label={t({ id: 'sso.saml.certificate.list', message: 'Certificates in use' })}
          >
            {certificateList}
          </ul>
        ) : null}
        <Setting
          page={settingsPage}
          id="saml-verifies-emails-help"
          label={msg({
            id: 'sso.saml.field.verifiesEmailsHelp',
            message:
              'Turn this on only if it checks that people own their addresses.  Linking and new accounts need it.',
          })}
        >
          <Checkbox
            isSelected={verifiesEmails}
            onChange={setVerifiesEmails}
            isDisabled={!owner && !saml?.verifiesEmails}
            description={t({
              id: 'sso.saml.field.verifiesEmailsHelp',
              message:
                'Turn this on only if it checks that people own their addresses.  Linking and new accounts need it.',
            })}
          >
            <Trans id="sso.saml.field.verifiesEmails">This identity provider verifies email addresses</Trans>
          </Checkbox>
        </Setting>
      </section>

      <Setting
        page={settingsPage}
        id="saml-domains"
        label={msg({ id: 'sso.field.domains', message: 'Email domains that may create accounts' })}
      >
        <TextField
          label={t({ id: 'sso.field.domains', message: 'Email domains that may create accounts' })}
          value={domains}
          onChange={setDomains}
          {...problem(firstOf('allowedDomains', fields))}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="saml-auto-create"
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
        id="saml-link-by-email"
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
        id="saml-enabled"
        label={msg({ id: 'sso.field.enabled', message: 'Show on the sign-in page' })}
      >
        <Switch isSelected={enabled} onChange={setEnabled}>
          <Trans id="sso.field.enabled">Show on the sign-in page</Trans>
        </Switch>
      </Setting>
      <ErrorBanner error={errorInfo(save.error)} />
      <div className="rio-sso__buttons">
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
