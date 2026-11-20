import { useRouter } from '@tanstack/react-router';
import { isHttpEngine, isNoSqlKind } from '@riosoma/contracts';
import { HttpEngineSourceFields } from './HttpEngineSourceFields';
import { NoSqlConnectionForm } from './NoSqlConnectionForm';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  dataverseEnvironmentOf,
  FILE_FORMATS,
  FIREBIRD_WIRE_CRYPT,
  MONGODB_TLS_MODES,
  ORACLE_TLS_MODES,
  REST_AUTH_METHODS,
  REST_LIMITS,
  sharePointSiteOf,
  SHEETS_LIMITS,
  TLS_MODES,
  TRINO_AUTH_METHODS,
  workbookAddressOf,
  type FileFormat,
  type FirebirdWireCrypt,
  type MongoTlsMode,
  type OracleTlsMode,
  type RestAuthMethod,
  type SourceKind,
  type TrinoAuthMethod,
} from '@riosoma/contracts';
import {
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  ListBoxItem,
  NumberField,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextArea,
  TextField,
} from '@riosoma/ui';
import {
  effectiveOracleTls,
  hasAdvanced,
  isAnalyticsKind,
  pastedAddress,
  typedAddress,
  portAfterSecure,
  unreadableLines,
  unreadableSpreadsheets,
  type AuthMethod,
  type EntraCredential,
  type SourceFormValues,
  type TlsMode,
} from './kinds';
import {
  ARRAY_LABELS,
  AUTH_LABELS,
  CLIENT_AUTH_LABELS,
  CREDENTIALS,
  CREDENTIAL_LABELS,
  FILE_FORMAT_LABELS,
  FIREBIRD_WIRE_CRYPT_LABELS,
  MONGO_ADDRESS_LABELS,
  MONGO_TLS_LABELS,
  ORACLE_ADDRESS_LABELS,
  ORACLE_TLS_LABELS,
  POSTGRES_AUTH_METHODS,
  REST_AUTH_LABELS,
  SIGNATURE_FORMAT_LABELS,
  SNOWFLAKE_AUTH_LABELS,
  SQL_SERVER_AUTH_METHODS,
  TLS_MODE_LABELS,
  TRINO_AUTH_LABELS,
} from './labels';
import { WarehouseSourceFields } from './WarehouseSourceFields';
import './sources.css';

export interface SourceConnectionFormProps {
  kind: SourceKind;
  values: SourceFormValues;
  onChange(patch: Partial<SourceFormValues>): void;
  /** Translated text for a field the server rejected, looked up by the form's own field name. */
  fieldError(name: string): string | undefined;
  /** Starts the advanced disclosure open, for a stored connection that already uses one of them. */
  defaultAdvancedOpen?: boolean;
  isDisabled?: boolean;
}

/**
 * The fields one kind needs, required ones first, with everything most people never touch behind
 * one Advanced disclosure.  Which secrets to ask for is decided by the connection this builds, so
 * the form and the contract can't drift apart.
 */
export function SourceConnectionForm({
  kind,
  values,
  onChange,
  fieldError,
  defaultAdvancedOpen,
  isDisabled,
}: SourceConnectionFormProps) {
  const { t, i18n } = useLingui();
  const router = useRouter({ warn: false });
  if (isNoSqlKind(kind))
    return (
      <NoSqlConnectionForm {...{ kind, values, onChange, fieldError, defaultAdvancedOpen, isDisabled }} />
    );
  if (isHttpEngine(kind))
    return (
      <HttpEngineSourceFields {...{ kind, values, onChange, fieldError, defaultAdvancedOpen, isDisabled }} />
    );
  const helpSearch = new URLSearchParams(window.location.search);
  helpSearch.set('help', 'file-api-sources');
  const sourceHelp = (
    <a
      href={`${window.location.pathname}?${helpSearch}`}
      onClick={(event) => {
        if (!router || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        void router.navigate({
          to: '.',
          search: (previous: Record<string, unknown>) => ({ ...previous, help: 'file-api-sources' }),
        });
      }}
    >
      <Trans id="sources.remote.help">Connection help</Trans>
    </a>
  );
  const snowflakeHelpSearch = new URLSearchParams(window.location.search);
  snowflakeHelpSearch.set('help', 'snowflake-sources');
  const snowflakeHelp = (
    <a
      href={`${window.location.pathname}?${snowflakeHelpSearch}`}
      onClick={(event) => {
        if (!router || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        void router.navigate({
          to: '.',
          search: (previous: Record<string, unknown>) => ({ ...previous, help: 'snowflake-sources' }),
        });
      }}
    >
      <Trans id="sources.snowflake.help">Connection help</Trans>
    </a>
  );

  /** Shared wiring for one field: its server-reported error, and the pending-request state. */
  const state = (name: string) => {
    const errorMessage = fieldError(name);
    return { errorMessage, isInvalid: Boolean(errorMessage), isDisabled };
  };
  const chosen = <T extends string>(options: readonly T[], key: unknown): T | undefined =>
    options.find((option) => option === key);

  const host = (
    <TextField
      label={t({ id: 'sources.field.host', message: 'Host' })}
      value={values.host}
      onChange={(host) => onChange({ host })}
      isRequired
      autoComplete="off"
      {...state('host')}
    />
  );
  const port = (
    <NumberField
      label={t({ id: 'sources.field.port', message: 'Port' })}
      value={values.port}
      onChange={(port) => onChange({ port })}
      minValue={1}
      maxValue={65_535}
      formatOptions={{ useGrouping: false }}
      isRequired
      {...state('port')}
    />
  );
  const database = (isRequired: boolean) => (
    <TextField
      label={t({ id: 'sources.field.database', message: 'Database' })}
      value={values.database}
      onChange={(database) => onChange({ database })}
      isRequired={isRequired}
      autoComplete="off"
      {...state('database')}
    />
  );
  const user = (isRequired: boolean) => (
    <TextField
      label={t({ id: 'sources.field.user', message: 'User' })}
      value={values.user}
      onChange={(user) => onChange({ user })}
      isRequired={isRequired}
      autoComplete="off"
      {...state('user')}
    />
  );
  const schema = (
    <TextField
      label={t({ id: 'sources.field.schema', message: 'Schema' })}
      value={values.schema}
      onChange={(schema) => onChange({ schema })}
      autoComplete="off"
      {...state('schema')}
    />
  );

  /**
   * The host of an engine that answers over HTTP.  A whole address pasted into it fills in the
   * port and HTTPS too, since that's what ClickHouse Cloud and most consoles hand out.  A typed
   * address stays exactly as typed until the field loses focus, then splits the same way, so the
   * Port field always shows the port that's used.
   */
  const addressHost = (description: string) => (
    <TextField
      label={t({ id: 'sources.field.host', message: 'Host' })}
      description={description}
      value={values.host}
      onChange={(host) => onChange({ host })}
      onPaste={(event) => {
        const address = isAnalyticsKind(kind)
          ? pastedAddress(kind, event.clipboardData.getData('text'))
          : null;
        if (!address) return;
        event.preventDefault();
        onChange(address);
      }}
      onBlur={() => {
        const address = isAnalyticsKind(kind) ? typedAddress(kind, values.host) : null;
        if (address) onChange(address);
      }}
      isRequired
      autoComplete="off"
      {...state('host')}
    />
  );
  const portWith = (description: string) => (
    <NumberField
      label={t({ id: 'sources.field.port', message: 'Port' })}
      description={description}
      value={values.port}
      onChange={(port) => onChange({ port })}
      minValue={1}
      maxValue={65_535}
      formatOptions={{ useGrouping: false }}
      isRequired
      {...state('port')}
    />
  );
  /** HTTPS, which moves the port to the other default when it's still on one of the kind's own. */
  const secureSwitch = (description: string) => (
    <Switch
      isSelected={values.secure}
      onChange={(secure) =>
        onChange({
          secure,
          ...(isAnalyticsKind(kind) ? { port: portAfterSecure(kind, values.port, secure) } : {}),
        })
      }
      isDisabled={isDisabled}
      description={description}
    >
      {kind === 'db2' || kind === 'informix' ? (
        <Trans id="sources.drivers.useTls">Connect with TLS</Trans>
      ) : (
        <Trans id="sources.https.use">Connect over HTTPS</Trans>
      )}
    </Switch>
  );
  const httpsHint = t({
    id: 'sources.https.hint',
    message:
      'Leave on unless the server sits on a trusted private network.  Riosoma always checks its certificate.',
  });

  /** The sign-in choice, and the fields only the chosen method needs. */
  const authMethods = kind === 'sqlserver' ? SQL_SERVER_AUTH_METHODS : POSTGRES_AUTH_METHODS;
  const signIn = (
    <>
      <Select
        label={t({ id: 'sources.field.auth', message: 'Sign in with' })}
        selectedKey={values.authMethod}
        onSelectionChange={(key) => {
          const method = chosen<AuthMethod>(authMethods, key);
          if (method) onChange({ authMethod: method });
        }}
        isDisabled={isDisabled}
      >
        {authMethods.map((method) => (
          <ListBoxItem key={method} id={method}>
            {i18n._(AUTH_LABELS[method])}
          </ListBoxItem>
        ))}
      </Select>
      {values.authMethod === 'azure-entra' ? (
        <>
          <Select
            label={t({ id: 'sources.field.credential', message: 'Identity' })}
            selectedKey={values.credential}
            onSelectionChange={(key) => {
              const credential = chosen<EntraCredential>(CREDENTIALS, key);
              if (credential) onChange({ credential });
            }}
            isDisabled={isDisabled}
          >
            {CREDENTIALS.map((credential) => (
              <ListBoxItem key={credential} id={credential}>
                {i18n._(CREDENTIAL_LABELS[credential])}
              </ListBoxItem>
            ))}
          </Select>
          <TextField
            label={t({ id: 'sources.field.clientId', message: 'Client ID' })}
            value={values.clientId}
            onChange={(clientId) => onChange({ clientId })}
            autoComplete="off"
            {...state('clientId')}
          />
          <TextField
            label={t({ id: 'sources.field.tenantId', message: 'Tenant ID' })}
            value={values.tenantId}
            onChange={(tenantId) => onChange({ tenantId })}
            autoComplete="off"
            {...state('tenantId')}
          />
        </>
      ) : null}
      {values.authMethod === 'aws-rds-iam' ? (
        <TextField
          label={t({ id: 'sources.field.region', message: 'Region' })}
          value={values.region}
          onChange={(region) => onChange({ region })}
          isRequired
          autoComplete="off"
          {...state('region')}
        />
      ) : null}
      {values.authMethod === 'gcp-cloudsql-iam' ? (
        <TextField
          label={t({ id: 'sources.field.instance', message: 'Instance connection name' })}
          value={values.instanceConnectionName}
          onChange={(instanceConnectionName) => onChange({ instanceConnectionName })}
          isRequired
          autoComplete="off"
          {...state('instanceConnectionName')}
        />
      ) : null}
    </>
  );

  const tls = (
    <>
      <Select
        label={t({ id: 'sources.tls.mode', message: 'Secure connection' })}
        selectedKey={values.tlsMode}
        onSelectionChange={(key) => {
          const mode = chosen<TlsMode>(TLS_MODES, key);
          if (mode) onChange({ tlsMode: mode });
        }}
        isDisabled={isDisabled}
      >
        {TLS_MODES.map((mode) => (
          <ListBoxItem key={mode} id={mode}>
            {i18n._(TLS_MODE_LABELS[mode])}
          </ListBoxItem>
        ))}
      </Select>
      {values.tlsMode === 'verify-ca' || values.tlsMode === 'verify-full' ? (
        <TextArea
          label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
          value={values.caPem}
          onChange={(caPem) => onChange({ caPem })}
          rows={4}
          className="rio-sources__pem"
          {...state('caPem')}
        />
      ) : null}
      {values.tlsMode === 'disable' ? null : (
        <TextArea
          label={t({ id: 'sources.tls.clientCertPem', message: 'Client certificate (PEM)' })}
          value={values.clientCertPem}
          onChange={(clientCertPem) => onChange({ clientCertPem })}
          rows={4}
          className="rio-sources__pem"
          {...state('clientCertPem')}
        />
      )}
      {values.tlsMode === 'verify-full' ? (
        <TextField
          label={t({ id: 'sources.tls.serverName', message: 'Name to verify' })}
          value={values.serverName}
          onChange={(serverName) => onChange({ serverName })}
          autoComplete="off"
          {...state('serverName')}
        />
      ) : null}
    </>
  );

  const ssh = (
    <>
      <Switch isSelected={values.useSsh} onChange={(useSsh) => onChange({ useSsh })} isDisabled={isDisabled}>
        <Trans id="sources.ssh.use">Connect through an SSH tunnel</Trans>
      </Switch>
      {values.useSsh ? (
        <>
          <TextField
            label={t({ id: 'sources.ssh.host', message: 'SSH host' })}
            value={values.sshHost}
            onChange={(sshHost) => onChange({ sshHost })}
            isRequired
            autoComplete="off"
            {...state('sshHost')}
          />
          <NumberField
            label={t({ id: 'sources.ssh.port', message: 'SSH port' })}
            value={values.sshPort}
            onChange={(sshPort) => onChange({ sshPort })}
            minValue={1}
            maxValue={65_535}
            formatOptions={{ useGrouping: false }}
            isRequired
            {...state('sshPort')}
          />
          <TextField
            label={t({ id: 'sources.ssh.user', message: 'SSH user' })}
            value={values.sshUser}
            onChange={(sshUser) => onChange({ sshUser })}
            isRequired
            autoComplete="off"
            {...state('sshUser')}
          />
          <TextArea
            label={t({ id: 'sources.ssh.hostKey', message: 'SSH host key' })}
            value={values.sshHostKey}
            onChange={(sshHostKey) => onChange({ sshHostKey })}
            rows={2}
            isRequired
            {...state('sshHostKey')}
          />
        </>
      ) : null}
    </>
  );

  /**
   * Oracle's TLS, which listens on a port of its own, so the choice has no Use if available.  A
   * `tcps://` string asks for TLS on its own.
   */
  const oracleMode = effectiveOracleTls(values);
  const tcpsString = values.oracleTls === 'disable' && oracleMode !== 'disable';
  const oracleSettings = (
    <>
      <Select
        label={t({ id: 'sources.tls.mode', message: 'Secure connection' })}
        description={
          tcpsString
            ? t({
                id: 'sources.oracle.tls.tcps',
                message:
                  'The Easy Connect string starts with tcps://, so the connection is encrypted and its certificate checked for this host.',
              })
            : undefined
        }
        selectedKey={values.oracleTls}
        onSelectionChange={(key) => {
          const mode = chosen<OracleTlsMode>(ORACLE_TLS_MODES, key);
          if (mode) onChange({ oracleTls: mode });
        }}
        isDisabled={isDisabled}
      >
        {ORACLE_TLS_MODES.map((mode) => (
          <ListBoxItem key={mode} id={mode}>
            {i18n._(ORACLE_TLS_LABELS[mode])}
          </ListBoxItem>
        ))}
      </Select>
      {oracleMode !== 'disable' ? (
        <TextArea
          label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
          description={t({
            id: 'sources.oracle.caPem.hint',
            message:
              'Only for a server whose certificate comes from a private authority that the wallet doesn’t hold.',
          })}
          value={values.caPem}
          onChange={(caPem) => onChange({ caPem })}
          rows={4}
          className="rio-sources__pem"
          {...state('caPem')}
        />
      ) : null}
      {oracleMode === 'verify-full' ? (
        <TextField
          label={t({ id: 'sources.tls.serverName', message: 'Name to verify' })}
          value={values.serverName}
          onChange={(serverName) => onChange({ serverName })}
          autoComplete="off"
          {...state('serverName')}
        />
      ) : null}
      {ssh}
    </>
  );

  /** Firebird's role and wire encryption, which most connections leave as they are. */
  const firebirdSettings = (
    <>
      <TextField
        label={t({ id: 'sources.firebird.role', message: 'Role' })}
        description={t({
          id: 'sources.firebird.role.hint',
          message: 'A role to sign in with, when the user reads tables through privileges granted to it.',
        })}
        value={values.role}
        onChange={(role) => onChange({ role })}
        autoComplete="off"
        {...state('role')}
      />
      <Select
        label={t({ id: 'sources.firebird.wireCrypt', message: 'Wire encryption' })}
        description={t({
          id: 'sources.firebird.wireCrypt.hint',
          message:
            'Required signs in only with SRP and sends nothing more until the connection is encrypted.  When the server offers it also signs in with Legacy_Auth, which sends a hash of the password unencrypted, so choose it only on a network you trust.',
        })}
        selectedKey={values.wireCrypt}
        onSelectionChange={(key) => {
          const wireCrypt = chosen<FirebirdWireCrypt>(FIREBIRD_WIRE_CRYPT, key);
          if (wireCrypt) onChange({ wireCrypt });
        }}
        isDisabled={isDisabled}
      >
        {FIREBIRD_WIRE_CRYPT.map((option) => (
          <ListBoxItem key={option} id={option}>
            {i18n._(FIREBIRD_WIRE_CRYPT_LABELS[option])}
          </ListBoxItem>
        ))}
      </Select>
      {ssh}
    </>
  );

  /** A file source's format and sheet, which most files never need: the name says the format. */
  const fileSettings = (
    <>
      <Select
        label={t({ id: 'sources.field.format', message: 'Format' })}
        description={t({
          id: 'sources.field.format.hint',
          message: 'Leave on Automatic to go by each file’s extension.',
        })}
        selectedKey={values.fileFormat || 'auto'}
        onSelectionChange={(key) => {
          if (key === 'auto') onChange({ fileFormat: '' });
          else {
            const format = chosen<FileFormat>(FILE_FORMATS, key);
            if (format) onChange({ fileFormat: format });
          }
        }}
        isDisabled={isDisabled}
      >
        {[
          <ListBoxItem key="auto" id="auto">
            {t({ id: 'sources.format.auto', message: 'Automatic' })}
          </ListBoxItem>,
          ...FILE_FORMATS.map((format) => (
            <ListBoxItem key={format} id={format}>
              {i18n._(FILE_FORMAT_LABELS[format])}
            </ListBoxItem>
          )),
        ]}
      </Select>
      <TextField
        label={t({ id: 'sources.field.sheet', message: 'Sheet' })}
        description={t({
          id: 'sources.field.sheet.hint',
          message: 'For workbooks.  Leave empty to read the first sheet.',
        })}
        value={values.sheet}
        onChange={(sheet) => onChange({ sheet })}
        autoComplete="off"
        {...state('sheet')}
      />
    </>
  );

  /** How an API source signs in, and the settings only the chosen way needs.  Its secret comes after. */
  const apiSignIn = (
    <>
      <Select
        label={t({ id: 'sources.api.auth', message: 'Authentication' })}
        selectedKey={values.restAuth}
        onSelectionChange={(key) => {
          const method = chosen<RestAuthMethod>(REST_AUTH_METHODS, key);
          if (method) onChange({ restAuth: method });
        }}
        isDisabled={isDisabled}
      >
        {REST_AUTH_METHODS.map((method) => (
          <ListBoxItem key={method} id={method}>
            {i18n._(REST_AUTH_LABELS[method])}
          </ListBoxItem>
        ))}
      </Select>
      {values.restAuth === 'header' ? (
        <TextField
          label={t({ id: 'sources.api.headerName', message: 'Header name' })}
          description={t({ id: 'sources.api.headerName.hint', message: 'Like X-Api-Key.' })}
          value={values.keyName}
          onChange={(keyName) => onChange({ keyName })}
          isRequired
          autoComplete="off"
          {...state('name')}
        />
      ) : null}
      {values.restAuth === 'query' ? (
        <TextField
          label={t({ id: 'sources.api.paramName', message: 'Parameter name' })}
          description={t({ id: 'sources.api.paramName.hint', message: 'Like api_key.' })}
          value={values.keyName}
          onChange={(keyName) => onChange({ keyName })}
          isRequired
          autoComplete="off"
          {...state('name')}
        />
      ) : null}
      {values.restAuth === 'basic' ? user(true) : null}
      {values.restAuth === 'oauth-client' ? (
        <>
          <TextField
            label={t({ id: 'sources.api.tokenUrl', message: 'Token address' })}
            description={t({
              id: 'sources.api.tokenUrl.hint',
              message: 'Where Riosoma asks for an access token with the client ID and secret.',
            })}
            type="url"
            value={values.tokenUrl}
            onChange={(tokenUrl) => onChange({ tokenUrl })}
            isRequired
            autoComplete="off"
            {...state('tokenUrl')}
          />
          <TextField
            label={t({ id: 'sources.field.clientId', message: 'Client ID' })}
            value={values.clientId}
            onChange={(clientId) => onChange({ clientId })}
            isRequired
            autoComplete="off"
            {...state('clientId')}
          />
          <TextField
            label={t({ id: 'sources.api.scope', message: 'Scope' })}
            description={t({
              id: 'sources.api.scope.hint',
              message: 'Leave empty when the API asks for none.',
            })}
            value={values.scope}
            onChange={(scope) => onChange({ scope })}
            autoComplete="off"
            {...state('scope')}
          />
          <Select
            label={t({ id: 'sources.api.clientAuth', message: 'Send the client secret' })}
            selectedKey={values.clientAuth}
            onSelectionChange={(key) => {
              if (key === 'basic' || key === 'body') onChange({ clientAuth: key });
            }}
            isDisabled={isDisabled}
          >
            <ListBoxItem id="basic">{i18n._(CLIENT_AUTH_LABELS.basic)}</ListBoxItem>
            <ListBoxItem id="body">{i18n._(CLIENT_AUTH_LABELS.body)}</ListBoxItem>
          </Select>
        </>
      ) : null}
    </>
  );

  /**
   * A MongoDB source's advanced settings: encryption, where its user is defined, how its documents
   * flatten, and a tunnel.
   */
  const mongoSettings = (
    <>
      <Select
        label={t({ id: 'sources.tls.mode', message: 'Secure connection' })}
        description={t({
          id: 'sources.mongodb.tls.hint',
          message: 'Automatic turns it on for mongodb+srv addresses and whenever the connection string asks.',
        })}
        selectedKey={values.mongoTls}
        onSelectionChange={(key) => {
          const mode = chosen<MongoTlsMode>(MONGODB_TLS_MODES, key);
          if (mode) onChange({ mongoTls: mode });
        }}
        isDisabled={isDisabled}
      >
        {MONGODB_TLS_MODES.map((mode) => (
          <ListBoxItem key={mode} id={mode}>
            {i18n._(MONGO_TLS_LABELS[mode])}
          </ListBoxItem>
        ))}
      </Select>
      {values.mongoTls === 'off' ? null : (
        <TextArea
          label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
          value={values.caPem}
          onChange={(caPem) => onChange({ caPem })}
          rows={4}
          className="rio-sources__pem"
          {...state('caPem')}
        />
      )}
      <TextField
        label={t({ id: 'sources.mongodb.authSource', message: 'Authentication database' })}
        description={t({
          id: 'sources.mongodb.authSource.hint',
          message:
            'Where the user is defined.  Leave empty for admin, or for the one the connection string names.',
        })}
        value={values.authSource}
        onChange={(authSource) => onChange({ authSource })}
        autoComplete="off"
        {...state('authSource')}
      />
      <NumberField
        label={t({ id: 'sources.api.flattenDepth', message: 'Nested levels as columns' })}
        description={t({
          id: 'sources.mongodb.flattenDepth.hint',
          message:
            'How many levels of embedded documents become columns like address.city.  Deeper ones stay JSON.',
        })}
        value={values.flattenDepth}
        onChange={(flattenDepth) => onChange({ flattenDepth })}
        minValue={0}
        maxValue={REST_LIMITS.flattenDepth}
        isRequired
        {...state('flattenDepth')}
      />
      <Select
        label={t({ id: 'sources.api.arrays', message: 'Lists of values' })}
        selectedKey={values.arrays}
        onSelectionChange={(key) => {
          if (key === 'text' || key === 'json') onChange({ arrays: key });
        }}
        isDisabled={isDisabled}
      >
        <ListBoxItem id="text">{i18n._(ARRAY_LABELS.text)}</ListBoxItem>
        <ListBoxItem id="json">{i18n._(ARRAY_LABELS.json)}</ListBoxItem>
      </Select>
      {ssh}
    </>
  );

  /** How a webhook's posts flatten into columns, and how many it takes a minute. */
  const hookSettings = (
    <>
      <NumberField
        label={t({ id: 'sources.webhook.perMinute', message: 'Posts a minute' })}
        description={t({
          id: 'sources.webhook.perMinute.hint',
          message: 'Past this, posts are refused with 429 and a Retry-After, so a sender slows down.',
        })}
        value={values.hookPerMinute}
        onChange={(hookPerMinute) => onChange({ hookPerMinute })}
        minValue={1}
        maxValue={10_000}
        isRequired
        {...state('postsPerMinute')}
      />
      <NumberField
        label={t({ id: 'sources.api.flattenDepth', message: 'Nested levels as columns' })}
        description={t({
          id: 'sources.webhook.flattenDepth.hint',
          message:
            'How many levels of nested objects become columns like customer.name.  Deeper ones stay JSON.',
        })}
        value={values.flattenDepth}
        onChange={(flattenDepth) => onChange({ flattenDepth })}
        minValue={0}
        maxValue={REST_LIMITS.flattenDepth}
        isRequired
        {...state('flattenDepth')}
      />
      <Select
        label={t({ id: 'sources.api.arrays', message: 'Lists of values' })}
        selectedKey={values.arrays}
        onSelectionChange={(key) => {
          if (key === 'text' || key === 'json') onChange({ arrays: key });
        }}
        isDisabled={isDisabled}
      >
        <ListBoxItem id="text">{i18n._(ARRAY_LABELS.text)}</ListBoxItem>
        <ListBoxItem id="json">{i18n._(ARRAY_LABELS.json)}</ListBoxItem>
      </Select>
    </>
  );

  // Every Microsoft 365 kind signs in as one Entra app registration, whose secret the dialog asks for.
  const entraApp = (
    <>
      <TextField
        label={t({ id: 'sources.field.tenantId', message: 'Tenant ID' })}
        description={t({
          id: 'sources.microsoft.tenantId.hint',
          message:
            'The directory (tenant) ID from the app registration’s overview, or one of the tenant’s domains.',
        })}
        value={values.tenantId}
        onChange={(tenantId) => onChange({ tenantId })}
        isRequired
        autoComplete="off"
        {...state('tenantId')}
      />
      <TextField
        label={t({ id: 'sources.field.clientId', message: 'Client ID' })}
        description={t({
          id: 'sources.microsoft.clientId.hint',
          message: 'The application (client) ID from the same overview.',
        })}
        value={values.clientId}
        onChange={(clientId) => onChange({ clientId })}
        isRequired
        autoComplete="off"
        {...state('clientId')}
      />
    </>
  );

  // With HTTPS off, an engine that answers over HTTP has nothing advanced left to set.
  const showAdvanced = hasAdvanced(kind) && !(isAnalyticsKind(kind) && !values.secure);
  const advanced = showAdvanced ? (
    <Disclosure defaultExpanded={defaultAdvancedOpen}>
      <DisclosureTrigger level={4}>
        <Trans id="sources.advanced">Advanced</Trans>
      </DisclosureTrigger>
      <DisclosurePanel>
        <div className="rio-sources__group">
          {kind === 'sqlserver' ? (
            <>
              {signIn}
              <Switch
                isSelected={values.encrypt}
                onChange={(encrypt) => onChange({ encrypt })}
                isDisabled={isDisabled}
              >
                <Trans id="sources.sqlserver.encrypt">Encrypt the connection</Trans>
              </Switch>
              {values.encrypt ? (
                <Switch
                  isSelected={values.trustServerCertificate}
                  onChange={(trustServerCertificate) => onChange({ trustServerCertificate })}
                  isDisabled={isDisabled}
                >
                  <Trans id="sources.sqlserver.trust">
                    Trust the server’s certificate without checking it
                  </Trans>
                </Switch>
              ) : null}
              {/* A certificate is checked against a host name, so connecting by address needs one. */}
              {values.encrypt && !values.trustServerCertificate ? (
                <TextField
                  label={t({ id: 'sources.tls.serverName', message: 'Name to verify' })}
                  value={values.serverName}
                  onChange={(serverName) => onChange({ serverName })}
                  autoComplete="off"
                  {...state('serverName')}
                />
              ) : null}
              {ssh}
            </>
          ) : kind === 'postgres' ? (
            <>
              {signIn}
              {tls}
              {ssh}
            </>
          ) : kind === 'oracle' ? (
            oracleSettings
          ) : kind === 'firebird' ? (
            firebirdSettings
          ) : kind === 'file-url' ? (
            fileSettings
          ) : kind === 'webhook' ? (
            hookSettings
          ) : kind === 'clickhouse' || kind === 'trino' ? (
            <TextArea
              label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
              description={t({
                id: 'sources.https.caPem.hint',
                message: 'Only for a server whose certificate comes from a private authority.',
              })}
              value={values.caPem}
              onChange={(caPem) => onChange({ caPem })}
              rows={4}
              className="rio-sources__pem"
              {...state('caPem')}
            />
          ) : kind === 'mongodb' ? (
            mongoSettings
          ) : kind === 'google-sheets' ? (
            <NumberField
              label={t({ id: 'sources.google.headerRow', message: 'Header row' })}
              description={t({
                id: 'sources.google.headerRow.hint',
                message:
                  'The row that names each sheet’s columns.  The rows above it are left out, and every row below it is a record.',
              })}
              value={values.headerRow}
              onChange={(headerRow) => onChange({ headerRow })}
              minValue={1}
              maxValue={SHEETS_LIMITS.headerRow}
              formatOptions={{ useGrouping: false }}
              isRequired
              {...state('headerRow')}
            />
          ) : kind === 'rest' ? (
            <NumberField
              label={t({ id: 'sources.api.rate', message: 'Requests a second' })}
              description={t({
                id: 'sources.api.rate.hint',
                message: 'The most Riosoma asks of this API in a second, across every sync and preview.',
              })}
              value={values.requestsPerSecond}
              onChange={(requestsPerSecond) => onChange({ requestsPerSecond })}
              minValue={0.1}
              maxValue={100}
              step={0.1}
              isRequired
              {...state('requestsPerSecond')}
            />
          ) : kind === 'bucket' ? (
            <>
              <Switch
                isSelected={values.pathStyle}
                onChange={(pathStyle) => onChange({ pathStyle })}
                isDisabled={isDisabled}
                description={t({
                  id: 'sources.bucket.pathStyle.hint',
                  message: 'MinIO and some other services need the bucket in the path instead of the host.',
                })}
              >
                <Trans id="sources.bucket.pathStyle">Use path-style addresses</Trans>
              </Switch>
              {fileSettings}
            </>
          ) : (
            <>
              {tls}
              {ssh}
            </>
          )}
        </div>
      </DisclosurePanel>
    </Disclosure>
  ) : null;

  switch (kind) {
    case 'postgres':
    case 'mysql':
      return (
        <>
          {host}
          {port}
          {database(true)}
          {user(true)}
          {advanced}
        </>
      );
    case 'sqlserver':
      return (
        <>
          {host}
          {port}
          {database(true)}
          {/* SQL Server signs in as the Windows or Entra identity of the server when no user is given. */}
          {user(false)}
          {advanced}
        </>
      );
    case 'oracle':
      return (
        <>
          <RadioGroup
            label={t({ id: 'sources.oracle.address', message: 'Connect with' })}
            value={values.oracleAddress}
            onChange={(address) => {
              if (address === 'host' || address === 'easy-connect') onChange({ oracleAddress: address });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="host">{i18n._(ORACLE_ADDRESS_LABELS.host)}</Radio>
            <Radio value="easy-connect">{i18n._(ORACLE_ADDRESS_LABELS['easy-connect'])}</Radio>
          </RadioGroup>
          {values.oracleAddress === 'host' ? (
            <>
              {host}
              {port}
              <TextField
                label={t({ id: 'sources.oracle.serviceName', message: 'Service name' })}
                description={t({
                  id: 'sources.oracle.serviceName.hint',
                  message:
                    'The database’s service name, like FREEPDB1 or sales.example.com, rather than its SID.',
                })}
                value={values.serviceName}
                onChange={(serviceName) => onChange({ serviceName })}
                isRequired
                autoComplete="off"
                {...state('serviceName')}
              />
            </>
          ) : (
            <TextField
              label={t({ id: 'sources.oracle.easyConnect', message: 'Easy Connect string' })}
              description={t({
                id: 'sources.oracle.easyConnect.hint',
                message:
                  'Like db.example.com:1521/sales.example.com, or tcps://db.example.com:2484/sales for TLS.  One host and a service, without tnsnames.ora aliases or parameters.',
              })}
              value={values.easyConnect}
              onChange={(easyConnect) => onChange({ easyConnect })}
              isRequired
              autoComplete="off"
              {...state('easyConnect')}
            />
          )}
          {user(true)}
          {advanced}
        </>
      );
    case 'firebird':
      return (
        <>
          {host}
          {port}
          <TextField
            label={t({ id: 'sources.field.database', message: 'Database' })}
            description={t({
              id: 'sources.firebird.database.hint',
              message:
                'The database file’s path on the server, like /var/lib/firebird/data/sales.fdb, or its alias from databases.conf.',
            })}
            value={values.database}
            onChange={(database) => onChange({ database })}
            isRequired
            autoComplete="off"
            {...state('database')}
          />
          {user(true)}
          {advanced}
        </>
      );
    case 'snowflake':
      return (
        <>
          {snowflakeHelp}
          <TextField
            label={t({ id: 'sources.field.account', message: 'Account identifier' })}
            value={values.account}
            onChange={(account) => onChange({ account })}
            isRequired
            autoComplete="off"
            {...state('account')}
          />
          {user(true)}
          <TextField
            label={t({ id: 'sources.field.warehouse', message: 'Warehouse' })}
            value={values.warehouse}
            onChange={(warehouse) => onChange({ warehouse })}
            isRequired
            autoComplete="off"
            {...state('warehouse')}
          />
          {database(true)}
          {schema}
          <TextField
            label={t({ id: 'sources.field.role', message: 'Role' })}
            value={values.role}
            onChange={(role) => onChange({ role })}
            autoComplete="off"
            {...state('role')}
          />
          <RadioGroup
            label={t({ id: 'sources.field.auth', message: 'Sign in with' })}
            value={values.snowflakeAuth}
            onChange={(auth) => {
              if (auth === 'password' || auth === 'key-pair') onChange({ snowflakeAuth: auth });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="password">{i18n._(SNOWFLAKE_AUTH_LABELS.password)}</Radio>
            <Radio value="key-pair">{i18n._(SNOWFLAKE_AUTH_LABELS['key-pair'])}</Radio>
          </RadioGroup>
        </>
      );
    case 'bigquery':
      return (
        <>
          <TextField
            label={t({ id: 'sources.field.projectId', message: 'Project ID' })}
            value={values.projectId}
            onChange={(projectId) => onChange({ projectId })}
            isRequired
            autoComplete="off"
            {...state('projectId')}
          />
          <TextField
            label={t({ id: 'sources.field.location', message: 'Location' })}
            value={values.location}
            onChange={(location) => onChange({ location })}
            autoComplete="off"
            {...state('location')}
          />
          <TextField
            label={t({ id: 'sources.field.dataset', message: 'Dataset' })}
            value={values.dataset}
            onChange={(dataset) => onChange({ dataset })}
            autoComplete="off"
            {...state('dataset')}
          />
        </>
      );
    case 'databricks':
      return (
        <>
          {host}
          <TextField
            label={t({ id: 'sources.field.httpPath', message: 'HTTP path' })}
            value={values.httpPath}
            onChange={(httpPath) => onChange({ httpPath })}
            isRequired
            autoComplete="off"
            {...state('httpPath')}
          />
          <TextField
            label={t({ id: 'sources.field.catalog', message: 'Catalog' })}
            value={values.catalog}
            onChange={(catalog) => onChange({ catalog })}
            autoComplete="off"
            {...state('catalog')}
          />
          {schema}
        </>
      );
    case 'redshift':
    case 'athena':
    case 'duckdb-file':
      return (
        <WarehouseSourceFields
          kind={kind}
          values={values}
          onChange={onChange}
          fieldError={fieldError}
          isDisabled={isDisabled}
        />
      );
    case 'motherduck':
      return <>{database(true)}</>;
    case 'clickhouse':
      return (
        <>
          {addressHost(
            t({
              id: 'sources.clickhouse.host.hint',
              message:
                'A host, or the address from ClickHouse Cloud’s Connect dialog, like https://abc123.us-east-1.aws.clickhouse.cloud:8443.',
            }),
          )}
          {portWith(
            t({
              id: 'sources.clickhouse.port.hint',
              message: 'The HTTP interface’s port: 8443 over HTTPS, or 8123 without.',
            }),
          )}
          {secureSwitch(httpsHint)}
          <TextField
            label={t({ id: 'sources.field.database', message: 'Database' })}
            description={t({
              id: 'sources.clickhouse.database.hint',
              message: 'Listed first when choosing a table, and where a query’s unqualified names are read.',
            })}
            value={values.database}
            onChange={(database) => onChange({ database })}
            isRequired
            autoComplete="off"
            {...state('database')}
          />
          {user(true)}
          {advanced}
        </>
      );
    case 'trino': {
      const insecure = !values.secure && values.trinoAuth !== 'none';
      return (
        <>
          {addressHost(
            t({
              id: 'sources.trino.host.hint',
              message: 'The coordinator’s host, or its whole address, like https://trino.example.com.',
            }),
          )}
          {portWith(
            t({
              id: 'sources.trino.port.hint',
              message: 'Usually 443 or 8443 over HTTPS, and 8080 without.',
            }),
          )}
          {secureSwitch(httpsHint)}
          <TextField
            label={t({ id: 'sources.field.catalog', message: 'Catalog' })}
            description={t({
              id: 'sources.trino.catalog.hint',
              message: 'Like hive, iceberg, or postgresql.  Its schemas and tables are what people can sync.',
            })}
            value={values.catalog}
            onChange={(catalog) => onChange({ catalog })}
            isRequired
            autoComplete="off"
            {...state('catalog')}
          />
          <TextField
            label={t({ id: 'sources.field.schema', message: 'Schema' })}
            description={t({
              id: 'sources.trino.schema.hint',
              message: 'Listed first when choosing a table, and where a query’s unqualified names are read.',
            })}
            value={values.schema}
            onChange={(schema) => onChange({ schema })}
            autoComplete="off"
            {...state('schema')}
          />
          <Select
            label={t({ id: 'sources.field.auth', message: 'Sign in with' })}
            selectedKey={values.trinoAuth}
            onSelectionChange={(key) => {
              const method = chosen<TrinoAuthMethod>(TRINO_AUTH_METHODS, key);
              if (method) onChange({ trinoAuth: method });
            }}
            isDisabled={isDisabled}
            isInvalid={insecure}
            errorMessage={
              insecure
                ? t({
                    id: 'sources.trino.auth.httpsOnly',
                    message:
                      'Trino takes a password or a token only over HTTPS.  Turn HTTPS on, or sign in with no password.',
                  })
                : undefined
            }
          >
            {TRINO_AUTH_METHODS.map((method) => (
              <ListBoxItem key={method} id={method}>
                {i18n._(TRINO_AUTH_LABELS[method])}
              </ListBoxItem>
            ))}
          </Select>
          <TextField
            label={t({ id: 'sources.field.user', message: 'User' })}
            description={t({
              id: 'sources.trino.user.hint',
              message: 'Who queries run as.  With a token, leave it empty to go by the token’s own user.',
            })}
            value={values.user}
            onChange={(user) => onChange({ user })}
            isRequired={values.trinoAuth !== 'token'}
            autoComplete="off"
            {...state('user')}
          />
          {advanced}
        </>
      );
    }
    case 'druid':
      return (
        <>
          {addressHost(
            t({
              id: 'sources.druid.host.hint',
              message: 'The router’s host, or its whole address, like https://druid.example.com:9088.',
            }),
          )}
          {portWith(
            t({
              id: 'sources.druid.port.hint',
              message:
                'The router’s port: 9088 over HTTPS, or 8888 without, unless your cluster changed them.',
            }),
          )}
          {secureSwitch(
            t({
              id: 'sources.druid.https.hint',
              message:
                'Leave on unless the cluster sits on a trusted private network.  Riosoma checks the router’s certificate against its own server’s trusted authorities.',
            }),
          )}
          <TextField
            label={t({ id: 'sources.field.user', message: 'User' })}
            description={t({
              id: 'sources.druid.user.hint',
              message: 'Leave empty when the cluster doesn’t ask anyone to sign in.',
            })}
            value={values.user}
            onChange={(user) => onChange({ user })}
            autoComplete="off"
            {...state('user')}
          />
        </>
      );
    case 'db2':
    case 'informix':
      return (
        <>
          {host}
          {port}
          {database(true)}
          {user(true)}
          {secureSwitch(
            t({ id: 'sources.drivers.tlsHint', message: 'Verify the server certificate and host name.' }),
          )}
          <TextField
            label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
            value={values.caPem}
            onChange={(caPem) => onChange({ caPem })}
            {...state('caPem')}
          />
        </>
      );
    case 'teradata':
      return (
        <>
          {host}
          {port}
          {secureSwitch(
            t({ id: 'sources.drivers.tlsHint', message: 'Verify the server certificate and host name.' }),
          )}
          <TextField
            label={t({ id: 'sources.tls.caPem', message: 'Trusted certificate authorities (PEM)' })}
            value={values.caPem}
            onChange={(caPem) => onChange({ caPem })}
            {...state('caPem')}
          />
          {user(true)}
          {database(false)}
          <RadioGroup
            label={t({ id: 'sources.field.logmech', message: 'Sign-in method' })}
            value={values.logmech}
            onChange={(logmech) => {
              if (logmech === 'TD2' || logmech === 'LDAP') onChange({ logmech });
            }}
            isDisabled={isDisabled}
          >
            {/* The driver's own names for its two mechanisms; they aren't words to translate. */}
            <Radio value="TD2">TD2</Radio>
            <Radio value="LDAP">LDAP</Radio>
          </RadioGroup>
        </>
      );
    case 'file-url':
      return (
        <>
          <TextField
            label={t({ id: 'sources.field.url', message: 'Address' })}
            description={t({
              id: 'sources.field.url.hint',
              message: 'An https address of a CSV, TSV, JSON, NDJSON, Parquet, or Excel file.',
            })}
            type="url"
            value={values.url}
            onChange={(url) => onChange({ url })}
            isRequired
            autoComplete="off"
            {...state('url')}
          />
          {advanced}
        </>
      );
    case 'sftp':
    case 'ftp':
    case 'ftps':
    case 'webdav':
      return (
        <>
          {sourceHelp}
          {kind === 'webdav' ? (
            <TextField
              label={t({ id: 'sources.field.url', message: 'Address' })}
              value={values.url}
              onChange={(url) => onChange({ url })}
              isRequired
              {...state('url')}
            />
          ) : (
            <>
              {host}
              {port}
            </>
          )}
          {user(kind !== 'webdav' || values.davAuth === 'basic')}
          {kind === 'sftp' ? (
            <>
              <RadioGroup
                label={t({ id: 'sources.api.auth', message: 'Authentication' })}
                value={values.remoteAuth}
                onChange={(auth) => {
                  if (auth === 'password' || auth === 'key') onChange({ remoteAuth: auth });
                }}
                isDisabled={isDisabled}
              >
                <Radio value="password">
                  <Trans id="sources.auth.password">Password</Trans>
                </Radio>
                <Radio value="key">
                  <Trans id="sources.remote.key">SSH key</Trans>
                </Radio>
              </RadioGroup>
              <TextArea
                label={t({ id: 'sources.remote.hostKey.label', message: 'Server host key' })}
                description={t({
                  id: 'sources.remote.hostKey.hint',
                  message: 'Paste the public host key confirmed by the server administrator.',
                })}
                value={values.sshHostKey}
                onChange={(sshHostKey) => onChange({ sshHostKey })}
                isRequired
                {...state('hostKey')}
              />
            </>
          ) : null}
          {kind === 'webdav' ? (
            <RadioGroup
              label={t({ id: 'sources.api.auth', message: 'Authentication' })}
              value={values.davAuth}
              onChange={(auth) => {
                if (auth === 'basic' || auth === 'bearer') onChange({ davAuth: auth });
              }}
              isDisabled={isDisabled}
            >
              <Radio value="basic">
                <Trans id="sources.remote.basic">Username and password</Trans>
              </Radio>
              <Radio value="bearer">
                <Trans id="sources.remote.bearer">Bearer token</Trans>
              </Radio>
            </RadioGroup>
          ) : null}
          <TextField
            label={t({ id: 'sources.remote.path.label', message: 'Path or glob' })}
            description={t({
              id: 'sources.remote.path.hint',
              message: 'Use a file path, * for one folder, or ** for nested folders.',
            })}
            value={values.remotePath}
            onChange={(remotePath) => onChange({ remotePath })}
            isRequired
            {...state('path')}
          />
          {fileSettings}
        </>
      );
    case 'graphql':
    case 'odata':
      return (
        <>
          {sourceHelp}
          <TextField
            label={t({ id: 'sources.api.baseUrl', message: 'Base address' })}
            value={values.baseUrl}
            onChange={(baseUrl) => onChange({ baseUrl })}
            isRequired
            {...state('baseUrl')}
          />
          {apiSignIn}
          {kind === 'graphql' ? (
            <>
              <TextArea
                label={t({ id: 'sources.graphql.query.label', message: 'Query' })}
                value={values.graphQuery}
                onChange={(graphQuery) => onChange({ graphQuery })}
                isRequired
                {...state('query')}
              />
              <TextArea
                label={t({ id: 'sources.graphql.variables.label', message: 'Variables as JSON' })}
                value={values.graphVariables}
                onChange={(graphVariables) => onChange({ graphVariables })}
                isRequired
                {...state('variables')}
              />
              <TextField
                label={t({ id: 'sources.graphql.records.label', message: 'Path to rows' })}
                value={values.graphRecords}
                onChange={(graphRecords) => onChange({ graphRecords })}
                isRequired
                {...state('records')}
              />
              <RadioGroup
                label={t({ id: 'sources.graphql.paging.label', message: 'Pagination' })}
                value={values.graphPaging}
                onChange={(graphPaging) => {
                  if (graphPaging === 'none' || graphPaging === 'cursor' || graphPaging === 'offset')
                    onChange({ graphPaging, graphVariable: graphPaging === 'offset' ? 'offset' : 'after' });
                }}
                isDisabled={isDisabled}
              >
                <Radio value="none">
                  <Trans id="sources.graphql.paging.none">One page</Trans>
                </Radio>
                <Radio value="cursor">
                  <Trans id="sources.graphql.paging.cursor">Cursor</Trans>
                </Radio>
                <Radio value="offset">
                  <Trans id="sources.graphql.paging.offset">Offset</Trans>
                </Radio>
              </RadioGroup>
              {values.graphPaging !== 'none' ? (
                <>
                  <TextField
                    label={t({ id: 'sources.graphql.pageInfo.label', message: 'Path to pageInfo' })}
                    value={values.graphPageInfo}
                    onChange={(graphPageInfo) => onChange({ graphPageInfo })}
                    isRequired
                    {...state('pageInfo')}
                  />
                  <TextField
                    label={t({ id: 'sources.graphql.variable.label', message: 'Pagination variable' })}
                    value={values.graphVariable}
                    onChange={(graphVariable) => onChange({ graphVariable })}
                    isRequired
                    {...state('variable')}
                  />
                </>
              ) : null}
              {values.graphPaging === 'offset' ? (
                <>
                  <TextField
                    label={t({ id: 'sources.graphql.sizeVariable.label', message: 'Page size variable' })}
                    value={values.graphSizeVariable}
                    onChange={(graphSizeVariable) => onChange({ graphSizeVariable })}
                    isRequired
                    {...state('sizeVariable')}
                  />
                  <NumberField
                    label={t({ id: 'sources.graphql.size.label', message: 'Page size' })}
                    value={values.graphSize}
                    onChange={(graphSize) => onChange({ graphSize })}
                    minValue={1}
                    maxValue={10_000}
                    {...state('size')}
                  />
                </>
              ) : null}
            </>
          ) : null}
        </>
      );
    case 'rest':
      return (
        <>
          <TextField
            label={t({ id: 'sources.api.baseUrl', message: 'Base address' })}
            description={t({
              id: 'sources.api.baseUrl.hint',
              message: 'The https address every endpoint’s path goes under, like https://api.example.com/v2.',
            })}
            type="url"
            value={values.baseUrl}
            onChange={(baseUrl) => onChange({ baseUrl })}
            isRequired
            autoComplete="off"
            {...state('baseUrl')}
          />
          {apiSignIn}
          {advanced}
        </>
      );
    case 'mongodb':
      return (
        <>
          <RadioGroup
            label={t({ id: 'sources.mongodb.address', message: 'Connect with' })}
            value={values.mongoAddress}
            onChange={(address) => {
              if (address === 'uri' || address === 'host') onChange({ mongoAddress: address });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="uri">{i18n._(MONGO_ADDRESS_LABELS.uri)}</Radio>
            <Radio value="host">{i18n._(MONGO_ADDRESS_LABELS.host)}</Radio>
          </RadioGroup>
          {values.mongoAddress === 'host' ? (
            <>
              {host}
              {/* DNS says which ports the servers listen on. */}
              {values.srv ? null : port}
              <Switch
                isSelected={values.srv}
                onChange={(srv) => onChange({ srv })}
                isDisabled={isDisabled}
                description={t({
                  id: 'sources.mongodb.useSrv.hint',
                  message: 'For MongoDB Atlas and other clusters whose address starts with mongodb+srv.',
                })}
              >
                <Trans id="sources.mongodb.useSrv">Find the servers through DNS</Trans>
              </Switch>
            </>
          ) : null}
          <TextField
            label={t({ id: 'sources.field.database', message: 'Database' })}
            description={t({
              id: 'sources.mongodb.database.hint',
              message: 'The database whose collections and views people can sync.',
            })}
            value={values.database}
            onChange={(database) => onChange({ database })}
            isRequired
            autoComplete="off"
            {...state('database')}
          />
          {/* Without a user, the source connects without signing in. */}
          {values.mongoAddress === 'host' ? user(false) : null}
          {advanced}
        </>
      );
    case 'google-sheets': {
      const unreadable = unreadableSpreadsheets(values.spreadsheets);
      const serverError = fieldError('spreadsheets');
      const localError = unreadable.length
        ? t({
            id: 'sources.google.spreadsheets.unreadable',
            message: `These don’t name a spreadsheet: ${unreadable.join(', ')}`,
          })
        : undefined;
      return (
        <>
          <TextArea
            label={t({ id: 'sources.google.spreadsheets', message: 'Spreadsheets' })}
            description={t({
              id: 'sources.google.spreadsheets.hint',
              message:
                'One per line: the address from the browser while the spreadsheet is open, or the ID in it.  Every sheet in each one can be synced.',
            })}
            value={values.spreadsheets}
            onChange={(spreadsheets) => onChange({ spreadsheets })}
            rows={3}
            isRequired
            isDisabled={isDisabled}
            isInvalid={Boolean(serverError ?? localError)}
            errorMessage={serverError ?? localError}
          />
          {advanced}
        </>
      );
    }
    case 'airtable':
      // The token comes first, and the bases it lists follow it, so both are the dialog's to show.
      return null;
    case 'sharepoint-list':
    case 'excel-online': {
      const lists = kind === 'sharepoint-list';
      const text = lists ? values.sharePointSites : values.workbooks;
      const unreadable = unreadableLines(text, lists ? sharePointSiteOf : workbookAddressOf);
      const serverError = fieldError(lists ? 'sites' : 'workbooks');
      const localError = !unreadable.length
        ? undefined
        : lists
          ? t({
              id: 'sources.sharepoint.sites.unreadable',
              message: `These aren’t SharePoint addresses: ${unreadable.join(', ')}`,
            })
          : t({
              id: 'sources.excel.workbooks.unreadable',
              message: `These aren’t the addresses of .xlsx files in SharePoint or OneDrive: ${unreadable.join(', ')}`,
            });
      return (
        <>
          {entraApp}
          <TextArea
            label={
              lists
                ? t({ id: 'sources.sharepoint.sites', message: 'Sites' })
                : t({ id: 'sources.excel.workbooks', message: 'Workbooks' })
            }
            description={
              lists
                ? t({
                    id: 'sources.sharepoint.sites.hint',
                    message:
                      'One per line: the address of the site, or of any page or list in it.  Every list in each site can be synced.',
                  })
                : t({
                    id: 'sources.excel.workbooks.hint',
                    message:
                      'One per line: the address Excel gives under File, then Info, then Copy path.  Every sheet in each workbook can be synced.',
                  })
            }
            value={text}
            onChange={(next) => onChange(lists ? { sharePointSites: next } : { workbooks: next })}
            rows={3}
            isRequired
            isDisabled={isDisabled}
            isInvalid={Boolean(serverError ?? localError)}
            errorMessage={serverError ?? localError}
          />
        </>
      );
    }
    case 'dataverse': {
      const typed = values.environmentUrl.trim();
      const localError =
        typed && !dataverseEnvironmentOf(typed)
          ? t({
              id: 'sources.dataverse.environmentUrl.unreadable',
              message: 'That isn’t a Dataverse environment’s address, like https://contoso.crm.dynamics.com.',
            })
          : undefined;
      const serverError = fieldError('environmentUrl');
      return (
        <>
          {entraApp}
          <TextField
            label={t({ id: 'sources.dataverse.environmentUrl', message: 'Environment address' })}
            description={t({
              id: 'sources.dataverse.environmentUrl.hint',
              message:
                'The environment’s URL from the Power Platform admin center, like https://contoso.crm.dynamics.com.',
            })}
            type="url"
            value={values.environmentUrl}
            onChange={(environmentUrl) => onChange({ environmentUrl })}
            isRequired
            autoComplete="off"
            isDisabled={isDisabled}
            isInvalid={Boolean(serverError ?? localError)}
            errorMessage={serverError ?? localError}
          />
        </>
      );
    }
    case 'feed':
      return (
        <TextField
          label={t({ id: 'sources.feed.url', message: 'Feed address' })}
          description={t({
            id: 'sources.feed.url.hint',
            message: 'The https address of an RSS, Atom, or JSON feed, like https://example.com/feed.xml.',
          })}
          type="url"
          value={values.url}
          onChange={(url) => onChange({ url })}
          isRequired
          autoComplete="off"
          {...state('url')}
        />
      );
    case 'webhook':
      return (
        <>
          <p className="rio-sources__note">
            <Trans id="sources.webhook.intro">
              {
                'Other systems post JSON, up to 1 MB at a time, to this webhook’s address, and each post becomes records in the tables that sync from it.  Riosoma makes the address when you save, and shows it once.'
              }
            </Trans>
          </p>
          <TextField
            label={t({ id: 'sources.webhook.records', message: 'Where the records are' })}
            description={t({
              id: 'sources.webhook.records.hint',
              message:
                'A path like data.items, when a post keeps its records inside it.  Leave empty when the post itself is the record or the list.',
            })}
            value={values.hookRecords}
            onChange={(hookRecords) => onChange({ hookRecords })}
            autoComplete="off"
            {...state('records')}
          />
          <Switch
            isSelected={values.hookSplit}
            onChange={(hookSplit) => onChange({ hookSplit })}
            isDisabled={isDisabled}
            description={t({
              id: 'sources.webhook.split.hint',
              message:
                'When a post holds a list, each item becomes its own record.  Otherwise the whole post is one.',
            })}
          >
            <Trans id="sources.webhook.split">Make a record of each item in a list</Trans>
          </Switch>
          <Switch
            isSelected={values.hookSigned}
            onChange={(hookSigned) => onChange({ hookSigned })}
            isDisabled={isDisabled}
            description={t({
              id: 'sources.webhook.signed.hint',
              message:
                'Refuses any post whose HMAC-SHA256 signature doesn’t match the shared secret, or that was signed too long ago.',
            })}
          >
            <Trans id="sources.webhook.signed">Check each post’s signature</Trans>
          </Switch>
          {values.hookSigned ? (
            <div className="rio-sources__group">
              <RadioGroup
                label={t({ id: 'sources.webhook.format', message: 'Signature form' })}
                value={values.hookFormat}
                onChange={(format) => {
                  if (format === 'timestamped' || format === 'hex') onChange({ hookFormat: format });
                }}
                isDisabled={isDisabled}
              >
                <Radio value="timestamped">{i18n._(SIGNATURE_FORMAT_LABELS.timestamped)}</Radio>
                <Radio value="hex">{i18n._(SIGNATURE_FORMAT_LABELS.hex)}</Radio>
              </RadioGroup>
              <TextField
                label={t({ id: 'sources.webhook.header', message: 'Signature header' })}
                description={t({
                  id: 'sources.webhook.header.hint',
                  message: 'Riosoma-Signature for another Riosoma, or the header the sending service names.',
                })}
                value={values.hookHeader}
                onChange={(hookHeader) => onChange({ hookHeader })}
                isRequired
                autoComplete="off"
                {...state('header')}
              />
              {values.hookFormat === 'hex' ? (
                <TextField
                  label={t({ id: 'sources.webhook.timestampHeader', message: 'Time header' })}
                  description={t({
                    id: 'sources.webhook.timestampHeader.hint',
                    message:
                      'The header holding the time, in Unix seconds, when the signature covers it.  Without one, a copied post can be sent again.',
                  })}
                  value={values.hookTimestampHeader}
                  onChange={(hookTimestampHeader) => onChange({ hookTimestampHeader })}
                  autoComplete="off"
                  {...state('timestampHeader')}
                />
              ) : null}
              <NumberField
                label={t({ id: 'sources.webhook.tolerance', message: 'Oldest signature taken, in seconds' })}
                description={t({
                  id: 'sources.webhook.tolerance.hint',
                  message:
                    'A post signed longer ago than this is refused, so a copy can’t be sent again later.',
                })}
                value={values.hookTolerance}
                onChange={(hookTolerance) => onChange({ hookTolerance })}
                minValue={30}
                maxValue={86_400}
                isRequired
                {...state('toleranceSeconds')}
              />
            </div>
          ) : null}
          <Switch
            isSelected={values.hookPaused}
            onChange={(hookPaused) => onChange({ hookPaused })}
            isDisabled={isDisabled}
            description={t({
              id: 'sources.webhook.paused.hint',
              message:
                'While paused, posts are refused with 503, and senders that try again send them later.',
            })}
          >
            <Trans id="sources.webhook.paused">Pause this webhook</Trans>
          </Switch>
          {advanced}
        </>
      );
    case 'bucket':
      return (
        <>
          <TextField
            label={t({ id: 'sources.field.endpoint', message: 'Endpoint' })}
            description={t({
              id: 'sources.field.endpoint.hint',
              message:
                'The service’s own address, such as an R2, B2, or MinIO endpoint.  Leave empty for AWS S3.',
            })}
            type="url"
            value={values.endpoint}
            onChange={(endpoint) => onChange({ endpoint })}
            autoComplete="off"
            {...state('endpoint')}
          />
          <TextField
            label={t({ id: 'sources.field.region', message: 'Region' })}
            description={t({
              id: 'sources.field.bucketRegion.hint',
              message:
                'For AWS S3, the bucket’s region, or us-east-1 when empty.  Other services go by their endpoint.',
            })}
            value={values.region}
            onChange={(region) => onChange({ region })}
            autoComplete="off"
            {...state('region')}
          />
          <TextField
            label={t({ id: 'sources.field.bucket', message: 'Bucket' })}
            value={values.bucket}
            onChange={(bucket) => onChange({ bucket })}
            isRequired
            autoComplete="off"
            {...state('bucket')}
          />
          <TextField
            label={t({ id: 'sources.field.prefix', message: 'Key or prefix' })}
            description={t({
              id: 'sources.field.prefix.hint',
              message:
                'One file’s key, or a folder like exports/ to offer every file in it.  Leave empty for the whole bucket.',
            })}
            value={values.prefix}
            onChange={(prefix) => onChange({ prefix })}
            autoComplete="off"
            {...state('prefix')}
          />
          {advanced}
        </>
      );
  }
}
