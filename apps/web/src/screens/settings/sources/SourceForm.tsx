import { faArrowUpRightFromSquare, faCopy } from '@fortawesome/free-solid-svg-icons';
import { GraphQlSuggestions } from './GraphQlSuggestions';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LIMITS,
  APP_CATALOG,
  type AppCatalogEntry,
  requiredSecrets,
  serviceAccountEmailOf,
  type AirtableSourceBase,
  type SecretName,
  type SourceConnection,
  type SourceCreate,
  type SourceKind,
  type SourceMeta,
  type SourcePreview,
  type SourceTestResult,
  type SourceUpdate,
} from '@riosoma/contracts';
import { appIcon, Icon } from '@riosoma/icons';
import { Button, FilterableList, Heading, Radio, RadioGroup, TextArea, TextField, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { anchor } from '../../../demos/anchors';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { SOURCES_KEY } from './query';
import {
  advancedInUse,
  blankValues,
  fromConnection,
  kindInfo,
  probeConnection,
  secretNamesFor,
  toConnection,
  toRestTarget,
  FORM_KIND_INFO as KIND_INFO,
  type SourceFormValues,
} from './kinds';
import { AirtableBasesPicker, type AirtableBasesLoader } from './AirtableBasesPicker';
import { EndpointsEditor, type EndpointPreviewer } from './EndpointsEditor';
import { ACCESS_LABELS, KIND_SECRET_HINTS } from './labels';
import { SecretField } from './SecretField';
import { AppSourceAccount } from './AppSourceAccount';
import { useConnection } from '../../../files/pickers/ConnectPrompt';
import { AppSourceFields } from './AppSourceFields';
import { SourceConnectionForm } from './SourceConnectionForm';
import { TestSteps } from './TestSteps';
import { WebhookPanel } from './WebhookPanel';
import './sources.css';

/**
 * The address a Google service account has, for people to share their spreadsheets with, with a
 * button that copies it.
 */
function ShareWith({ email }: { email: string }) {
  const { t } = useLingui();
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
    } catch {
      // Without clipboard access the address stays in its field, where it can be copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'sources.google.copied', message: 'Copied' }) });
  }
  return (
    <div className="rio-sources__share">
      <div className="rio-sources__share-field">
        <TextField
          label={t({ id: 'sources.google.shareWith', message: 'Share each spreadsheet with' })}
          description={t({
            id: 'sources.google.shareWith.hint',
            message: 'In Google Sheets, choose Share and add this address as a viewer.',
          })}
          value={email}
          isReadOnly
        />
      </div>
      <Button
        onPress={() => void copy()}
        aria-label={t({ id: 'sources.google.copy', message: 'Copy' })}
        icon={faCopy}
      />
    </div>
  );
}

/** A source an admin may edit: the connection comes with it, since only admins are sent one. */
export type EditableSource = SourceMeta & { connection: SourceConnection };

/**
 * Everything a container needs to draw its own chrome around the form: the rendered body, whether a
 * kind is chosen, the readiness and pending state for the footer buttons, and the two actions those
 * buttons run.  The form's state lives in the caller through this hook, so it survives a modal that
 * closes and reopens, such as the settings dialog stepping aside while help is open.
 */
export interface SourceFormController {
  /** The form body: the kinds, the connection, the secrets, who may use it, and the test results. */
  body: ReactNode;
  /** The chosen kind, or null while the kind picker is still open. */
  kind: SourceKind | null;
  /** The source may be saved: a kind is chosen, it has a name, and a new one has every secret. */
  ready: boolean;
  /** Saved sources test their stored account independently of the current person's selection. */
  testReady: boolean;
  /** A save is in flight. */
  saving: boolean;
  /** A connection test is in flight. */
  testing: boolean;
  /** Either request is in flight, so the form is read-only for the moment. */
  busy: boolean;
  save(): void;
  runTest(): void;
}

export interface SourceFormProps {
  appCatalog?: readonly AppCatalogEntry[];
  /** The source being edited; absent while adding one. */
  source?: EditableSource;
  initialKind?: SourceKind;
  onKindChange?(kind: SourceKind): void;
  onSaved(source: SourceMeta): void;
  /** A brand-new webhook's address comes back once; the container decides how to show it. */
  onCreatedWebhook?(source: SourceMeta, webhookPath: string): void;
}

function withName(set: ReadonlySet<SecretName>, name: SecretName, present: boolean): Set<SecretName> {
  const next = new Set(set);
  if (present) next.add(name);
  else next.delete(name);
  return next;
}

/**
 * The connection form itself: the kinds, that kind's connection, the secrets it needs, who may use
 * it, and the test with its step-by-step results.  It is a hook so its state lives in the caller and
 * survives a modal closing and reopening, and so it reads the same inside the settings dialog and
 * inside the sync wizard, which draw their own chrome and footer around the body it returns.
 * Testing never blocks saving: a source can be set up while the system it points at is down.
 */
export function useSourceForm({
  appCatalog = APP_CATALOG,
  source,
  initialKind,
  onKindChange,
  onSaved,
  onCreatedWebhook,
}: SourceFormProps): SourceFormController {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<SourceKind | null>(source?.kind ?? initialKind ?? null);
  const [values, setValues] = useState<SourceFormValues>(() => {
    if (!source) return blankValues(initialKind ?? 'postgres');
    return {
      ...fromConnection(source.connection),
      name: source.name,
      description: source.description,
      access: source.access,
    };
  });
  const [secrets, setSecrets] = useState<Partial<Record<SecretName, string>>>({});
  const [removed, setRemoved] = useState<ReadonlySet<SecretName>>(() => new Set());
  const [replacing, setReplacing] = useState<ReadonlySet<SecretName>>(() => new Set());
  const [result, setResult] = useState<SourceTestResult | null>(null);
  // Read once: a disclosure is uncontrolled, and a stored connection's own settings decide it.
  const [advancedOpen] = useState(() => advancedInUse(source?.connection ?? null));
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Focus after the modal portal is attached; an input can mount while it is still detached.
    formRef.current?.querySelector<HTMLInputElement>(kind ? 'input:not([type="search"])' : 'input')?.focus();
  }, [kind]);

  const app = kind === 'app' ? appCatalog.find((app) => app.id === values.app) : undefined;
  const connection = kind ? toConnection(kind, values, appCatalog) : null;
  // The shape of the connection decides which secrets to ask for, so they appear before every
  // field is filled in; the connection above decides what may actually be saved.
  const shape = kind && kind !== 'app' ? probeConnection(kind, values) : null;
  const appSecrets = app?.secret ? [app.secret, ...(app.additionalSecrets ?? [])] : [];
  const accounts = useConnection(app?.connect?.provider);
  const secretNames = app ? appSecrets.map((secret) => secret.name) : secretNamesFor(shape);
  const stored = source?.secrets ?? [];
  const required = app ? secretNames : shape ? requiredSecrets(shape) : [];
  const missing = required.filter((name) => !secrets[name] && !(stored.includes(name) && !removed.has(name)));
  // A new source needs everything its connection asks for; an edit may save a source whose secret
  // was just removed, and the server says when that has gone too far.
  const ready =
    Boolean(kind) &&
    connection !== null &&
    values.name.trim() !== '' &&
    (!app?.connect ||
      (accounts.connection?.available === true &&
        accounts.connection.account?.id === values.appSettings.connectionId &&
        !accounts.connection.account?.needsReconnect)) &&
    (Boolean(source) || missing.length === 0);

  // An API endpoint's first page is read with the address, sign-in, and secrets in the dialog.  A
  // saved source's secrets never come back to the browser, so it reads with the stored ones, and
  // only while the address and sign-in are still the stored ones too.
  const target = kind === 'rest' ? toRestTarget(values) : null;
  const typed: Partial<Record<SecretName, string>> = {};
  for (const name of secretNames) if (secrets[name]) typed[name] = secrets[name];
  const savedApi = source?.connection.kind === 'rest' ? source.connection : null;
  const moved =
    savedApi !== null &&
    (JSON.stringify([target?.baseUrl, target?.auth]) !== JSON.stringify([savedApi.baseUrl, savedApi.auth]) ||
      Object.keys(typed).length > 0 ||
      removed.size > 0);
  const previewBlocked =
    kind !== 'rest'
      ? undefined
      : moved
        ? t({
            id: 'sources.api.preview.saveFirst',
            message: 'Save the source to see the first page with its new address or sign-in.',
          })
        : !target || (!source && missing.length > 0)
          ? t({
              id: 'sources.api.preview.signInFirst',
              message: 'Fill in the base address and sign-in to see the first page.',
            })
          : undefined;
  const previewKey = JSON.stringify([source?.id ?? null, target, typed]);
  const preview = useMemo<EndpointPreviewer | null>(() => {
    if (kind !== 'rest') return null;
    if (source)
      return (endpoint, signal) =>
        api<SourcePreview>(`/api/sources/${encodeURIComponent(source.id)}/endpoint-preview`, {
          body: { endpoint },
          signal,
        });
    return (endpoint, signal) =>
      api<SourcePreview>('/api/sources/endpoint-preview', {
        body: { connection: target, secrets: typed, endpoint },
        signal,
      });
    // The previewer changes when what it reads with changes, which the key says in full.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, kind]);

  // An Airtable source's bases are listed with the token being typed, or else a saved source's
  // stored one, which never comes back to the browser.
  const typedToken = kind === 'airtable' ? (secrets.token ?? '').trim() : '';
  const storedToken =
    kind === 'airtable' && source?.kind === 'airtable' && stored.includes('token') && !removed.has('token');
  const listBases = useMemo<AirtableBasesLoader | null>(() => {
    if (typedToken)
      return (signal) =>
        api<AirtableSourceBase[]>('/api/sources/airtable-bases', { body: { token: typedToken }, signal });
    if (storedToken && source)
      return (signal) =>
        api<AirtableSourceBase[]>(`/api/sources/${encodeURIComponent(source.id)}/airtable-bases`, {
          method: 'POST',
          signal,
        });
    return null;
  }, [typedToken, storedToken, source]);

  function change(patch: Partial<SourceFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setResult(null);
  }

  function choose(next: SourceKind, appId = '') {
    if (source) return;
    setKind(next);
    onKindChange?.(next);
    // What the person said about the source survives a different kind; the connection doesn't.
    setValues((current) => ({
      ...blankValues(next),
      app: appId,
      name: current.name,
      description: current.description,
      access: current.access,
    }));
    setSecrets({});
    setRemoved(new Set());
    setReplacing(new Set());
    setResult(null);
  }

  function createBody(): SourceCreate | null {
    if (!connection) return null;
    const sending: SourceCreate['secrets'] = {};
    for (const name of secretNames) {
      const value = secrets[name];
      if (value) sending[name] = value;
    }
    return {
      name: values.name.trim(),
      description: values.description.trim(),
      connection,
      secrets: sending,
      access: values.access,
    };
  }

  function updateBody(): SourceUpdate | null {
    if (!connection) return null;
    // Only what changed travels: a value for a replaced secret, null for a removed one, and
    // nothing at all for the secrets the server already holds.
    const changed: NonNullable<SourceUpdate['secrets']> = {};
    for (const name of secretNames) {
      const value = secrets[name];
      if (value) changed[name] = value;
      else if (removed.has(name) && stored.includes(name)) changed[name] = null;
    }
    return {
      name: values.name.trim(),
      description: values.description.trim(),
      connection,
      access: values.access,
      ...(Object.keys(changed).length ? { secrets: changed } : {}),
    };
  }

  const save = useMutation({
    mutationFn: (body: SourceCreate | SourceUpdate) =>
      source
        ? api<SourceMeta>(`/api/sources/${encodeURIComponent(source.id)}`, { method: 'PATCH', body })
        : api<SourceMeta>('/api/sources', { body }),
    onSuccess: (meta) => {
      void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
      if (!source && meta.webhookPath && onCreatedWebhook) {
        const { webhookPath: path, ...saved } = meta;
        onCreatedWebhook(saved, path);
        return;
      }
      onSaved(meta);
    },
  });
  const test = useMutation({
    // A saved source is tested as it is stored: its secrets never come back to the browser, so a
    // draft can't be tested against them.  Saving first and testing after is the way to change one.
    mutationFn: (draft: SourceCreate | null) =>
      source
        ? api<SourceTestResult>(`/api/sources/${encodeURIComponent(source.id)}/test`, { method: 'POST' })
        : api<SourceTestResult>('/api/sources/test', { body: draft }),
    onSuccess: (report) => {
      setResult(report);
      // A tested source carries its result home, so the list's "last test" column follows.
      if (source) void queryClient.invalidateQueries({ queryKey: SOURCES_KEY });
    },
  });
  const busy = save.isPending || test.isPending;
  const info = errorInfo(save.error ?? test.error);
  /** Field errors arrive as paths into the request; the last part names the form's own field. */
  const fieldErrors = new Map<string, string>(
    Object.entries(info?.fields ?? {}).map(([path, key]) => [path.split('.').pop() ?? path, message(key)]),
  );
  const fieldError = (name: string) => fieldErrors.get(name);

  function submit() {
    if (!ready || busy) return;
    const body = source ? updateBody() : createBody();
    if (body) save.mutate(body);
  }

  function runTest() {
    if ((!source && !ready) || busy) return;
    const draft = source ? null : createBody();
    if (!source && !draft) return;
    setResult(null);
    test.mutate(draft);
  }

  const current = kind ? kindInfo(kind) : null;
  // The account to share spreadsheets with: the one in a key being typed, or else the stored one's.
  const typedKey = kind === 'google-sheets' ? secrets.serviceAccountJson : undefined;
  const shareEmail =
    kind !== 'google-sheets'
      ? null
      : ((typedKey ? serviceAccountEmailOf(typedKey) : null) ??
        (removed.has('serviceAccountJson') ? null : values.serviceAccountEmail || null));

  const body = (
    <form
      ref={formRef}
      className="rio-sources__form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {source && current ? (
        <p className="rio-sources__kind-line">
          <Icon icon={app ? appIcon(app.id, app.name) : current.icon} />
          <span>{app ? app.name : i18n._(current.name)}</span>
        </p>
      ) : (
        <>
          <Heading level={3}>
            <Trans id="sources.chooseKind">What do you want to connect?</Trans>
          </Heading>
          <div data-anchor="sources.app.choose">
            <FilterableList
              listId="sources.kinds"
              label={t({ id: 'sources.chooseKind', message: 'What do you want to connect?' })}
              filterLabel={t({ id: 'sources.app.filter', message: 'Filter sources' })}
              items={[
                ...KIND_INFO.map((info) => {
                  const files = ['file-url', 'bucket', 'sftp', 'ftp', 'ftps', 'webdav', 'duckdb-file'];
                  const services = [
                    'google-sheets',
                    'airtable',
                    'sharepoint-list',
                    'excel-online',
                    'dataverse',
                  ];
                  const web = ['rest', 'graphql', 'odata', 'feed', 'webhook'];
                  const group = files.includes(info.kind)
                    ? 'files'
                    : services.includes(info.kind)
                      ? 'services'
                      : web.includes(info.kind)
                        ? 'web'
                        : 'databases';
                  const names = {
                    files: t({ id: 'sources.groups.files', message: 'Files' }),
                    services: t({ id: 'sources.groups.services', message: 'Connected services' }),
                    web: t({ id: 'sources.groups.web', message: 'Web data' }),
                    databases: t({ id: 'sources.groups.databases', message: 'Databases' }),
                  };
                  return {
                    id: info.kind,
                    name: i18n._(info.name),
                    group,
                    groupName: names[group],
                    leadingIcon: info.icon,
                  };
                }),
                ...appCatalog.map((app) => ({
                  id: `app:${app.id}`,
                  name: app.name,
                  group: 'apps',
                  groupName: t({ id: 'sources.app.group', message: 'Apps' }),
                  leadingIcon: appIcon(app.id, app.name),
                })),
              ]}
              selectedKeys={kind === 'app' ? [`app:${values.app}`] : kind ? [kind] : []}
              recentlyUsed
              isDisabled={busy}
              onSelectionChange={(keys) => {
                const app = appCatalog.find((app) => keys.has(`app:${app.id}`));
                if (app) {
                  if (kind !== 'app' || values.app !== app.id) choose('app', app.id);
                  return;
                }
                const next = KIND_INFO.find((info) => keys.has(info.kind));
                if (next) choose(next.kind);
              }}
            />
          </div>
        </>
      )}
      {kind && current ? (
        <>
          <TextField
            label={t({ id: 'sources.field.name', message: 'Name' })}
            value={values.name}
            onChange={(name) => change({ name })}
            maxLength={LIMITS.nameLength}
            isRequired
            autoFocus
            autoComplete="off"
            isDisabled={busy}
            errorMessage={fieldError('name')}
            isInvalid={Boolean(fieldError('name'))}
          />
          <TextArea
            label={t({ id: 'sources.field.description', message: 'Description' })}
            value={values.description}
            onChange={(description) => change({ description })}
            maxLength={LIMITS.descriptionLength}
            rows={2}
            isDisabled={busy}
          />
          {app ? (
            <AppSourceFields
              app={app}
              settingChoices={
                accounts.connection?.account?.id === values.appSettings.connectionId
                  ? accounts.connection?.account?.settingChoices
                  : undefined
              }
              settings={values.appSettings}
              onChange={(appSettings) => change({ appSettings })}
              fieldError={fieldError}
              isDisabled={busy}
            />
          ) : (
            <SourceConnectionForm
              kind={kind}
              values={values}
              onChange={change}
              fieldError={fieldError}
              defaultAdvancedOpen={advancedOpen}
              isDisabled={busy}
            />
          )}
          {kind === 'graphql' ? (
            <GraphQlSuggestions
              key={JSON.stringify([connection, typed, source?.id])}
              sourceId={source?.id}
              connection={connection}
              secrets={typed}
              disabled={
                busy ||
                !connection ||
                missing.length > 0 ||
                Boolean(
                  source &&
                  (JSON.stringify(source.connection) !== JSON.stringify(connection) ||
                    Object.keys(typed).length ||
                    removed.size),
                )
              }
            />
          ) : null}
          {app?.connect ? (
            <AppSourceAccount
              key={app.id}
              provider={app.connect.provider}
              connection={accounts.connection}
              loaded={accounts.loaded}
              value={values.appSettings.connectionId ?? ''}
              onChange={(connectionId) => change({ appSettings: { ...values.appSettings, connectionId } })}
              isDisabled={busy}
            />
          ) : null}
          <div className="rio-sources__secrets">
            {secretNames.map((name) => {
              const field = appSecrets.find((secret) => secret.name === name);
              return (
                <div
                  key={name}
                  className={app ? 'rio-sources__app-key' : undefined}
                  {...(app ? anchor('sources.app.key') : {})}
                >
                  <SecretField
                    key={name}
                    name={name}
                    stored={stored.includes(name)}
                    removed={removed.has(name)}
                    replacing={replacing.has(name)}
                    value={secrets[name] ?? ''}
                    app={Boolean(app)}
                    {...(field
                      ? {
                          hint: i18n._(field.helpMessageId),
                          ...('labelMessageId' in field ? { label: i18n._(field.labelMessageId) } : {}),
                        }
                      : {})}
                    {...(kind && KIND_SECRET_HINTS[kind]?.[name]
                      ? { hint: i18n._(KIND_SECRET_HINTS[kind]![name]!) }
                      : {})}
                    isRequired={required.includes(name)}
                    errorMessage={fieldError(name)}
                    isDisabled={busy}
                    onChange={(value) => {
                      setSecrets((typed) => ({ ...typed, [name]: value }));
                      setResult(null);
                    }}
                    onReplace={() => {
                      setReplacing((set) => withName(set, name, true));
                      setRemoved((set) => withName(set, name, false));
                      setResult(null);
                    }}
                    onRemove={(remove) => {
                      setRemoved((set) => withName(set, name, remove));
                      setReplacing((set) => withName(set, name, false));
                      setResult(null);
                    }}
                  />
                  {app ? (
                    <a
                      className="rio-sources__app-key-link"
                      {...anchor('sources.app.createKey')}
                      href={app.keyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t({ id: 'sources.app.createKey', message: 'Create a key' })}
                      title={t({ id: 'sources.app.createKey', message: 'Create a key' })}
                    >
                      <Icon icon={faArrowUpRightFromSquare} />
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
          {shareEmail ? <ShareWith email={shareEmail} /> : null}
          {kind === 'airtable' ? (
            <AirtableBasesPicker
              chosen={values.airtableBases}
              onChange={(airtableBases) => change({ airtableBases })}
              load={listBases}
              blocked={t({
                id: 'sources.airtable.bases.tokenFirst',
                message: 'Paste the token to list its bases.',
              })}
              errorMessage={fieldError('bases')}
              isDisabled={busy}
            />
          ) : null}
          {kind === 'webhook' && source ? <WebhookPanel source={source} /> : null}
          {kind === 'rest' ? (
            <EndpointsEditor
              endpoints={values.endpoints}
              onChange={(endpoints) => change({ endpoints })}
              preview={previewBlocked ? null : preview}
              previewBlocked={previewBlocked}
              isDisabled={busy}
            />
          ) : null}
          <RadioGroup
            label={t({ id: 'sources.access.label', message: 'Who can sync from it' })}
            value={values.access}
            onChange={(access) => {
              if (access === 'admins' || access === 'creators') change({ access });
            }}
            isDisabled={busy}
          >
            <Radio value="admins">{i18n._(ACCESS_LABELS.admins)}</Radio>
            <Radio value="creators">{i18n._(ACCESS_LABELS.creators)}</Radio>
          </RadioGroup>
          <ErrorBanner error={info} />
          {result ? (
            <div {...(app ? anchor('sources.app.test') : {})}>
              <TestSteps result={result} />
            </div>
          ) : null}
          {/* A hidden submit keeps Enter in a field saving the source the way a footer button does. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </>
      ) : null}
    </form>
  );

  return {
    body,
    kind,
    ready,
    testReady: Boolean(source) || ready,
    busy,
    testing: test.isPending,
    saving: save.isPending,
    save: submit,
    runTest,
  };
}
