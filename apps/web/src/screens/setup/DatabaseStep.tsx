import { Trans, useLingui } from '@lingui/react/macro';
import { useState, type FormEvent } from 'react';
import type { DatabaseProfile } from '@riosoma/contracts';
import {
  Button,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Form,
  FormActions,
  Heading,
  ListBoxItem,
  NumberField,
  PasswordField,
  Select,
  Text,
  TextArea,
  TextField,
} from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { DiagnosticList } from './DiagnosticList';
import { errorInfo, type useSetupFlow } from './useSetup';

type TlsMode = DatabaseProfile['tls']['mode'];

interface DatabaseForm {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tlsMode: TlsMode;
  caPem: string;
  serverName: string;
}

const INITIAL: DatabaseForm = {
  host: '',
  port: 5432,
  database: 'riosoma',
  user: '',
  password: '',
  // Most self-hosted databases start without certificates, so encrypt when the server offers it.
  tlsMode: 'prefer',
  caPem: '',
  serverName: '',
};

/** Field errors the form shows beside a field; any other one falls back to the banner. */
const SHOWN_FIELDS = new Set([
  'host',
  'port',
  'database',
  'user',
  'auth.password',
  'tls.caPem',
  'tls.serverName',
]);

function toProfile(form: DatabaseForm): DatabaseProfile {
  return {
    host: form.host.trim(),
    port: form.port,
    database: form.database.trim(),
    user: form.user.trim(),
    auth: { method: 'password', password: form.password },
    tls: {
      mode: form.tlsMode,
      ...(form.caPem.trim() ? { caPem: form.caPem.trim() } : {}),
      ...(form.serverName.trim() ? { serverName: form.serverName.trim() } : {}),
    },
    pooler: 'none',
    schemas: { app: 'rio_app', data: 'rio_data', audit: 'rio_audit' },
    pool: { max: 10, idleTimeoutMs: 30_000 },
    applicationName: 'riosoma',
  };
}

function fieldValue(profile: DatabaseProfile | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
  }, profile);
}

export function DatabaseStep({ flow }: { flow: ReturnType<typeof useSetupFlow> }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [form, setForm] = useState<DatabaseForm>(INITIAL);
  const set =
    <K extends keyof DatabaseForm>(key: K) =>
    (value: DatabaseForm[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    };

  const profile = toProfile(form);
  const lastError = errorInfo(flow.saveDatabase.error ?? flow.testDatabase.error);
  const rejectedProfile = flow.saveDatabase.error ? flow.saveDatabase.variables : flow.testDatabase.variables;
  const fieldError = (path: string) => {
    const key = lastError?.fields?.[path];
    return key && fieldValue(profile, path) === fieldValue(rejectedProfile, path) ? message(key) : undefined;
  };
  const report = flow.saveDatabase.data?.report ?? flow.testDatabase.data;

  const tlsOptions: Array<{ id: TlsMode; label: string }> = [
    {
      id: 'verify-full',
      label: t({ id: 'setup.database.tls.verifyFull', message: 'Verify the certificate and host name' }),
    },
    { id: 'verify-ca', label: t({ id: 'setup.database.tls.verifyCa', message: 'Verify the certificate' }) },
    { id: 'require', label: t({ id: 'setup.database.tls.require', message: 'Always encrypt' }) },
    {
      id: 'prefer',
      label: t({ id: 'setup.database.tls.prefer', message: 'Encrypt when the server offers it' }),
    },
    { id: 'disable', label: t({ id: 'setup.database.tls.disable', message: 'Don’t encrypt' }) },
  ];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    flow.saveDatabase.mutate(profile);
  };

  return (
    <Form onSubmit={onSubmit}>
      <Heading level={1} data-anchor="setup.database">
        <Trans id="setup.database.title">Connect a database</Trans>
      </Heading>
      <Text>
        <Trans id="setup.database.body">
          Riosoma keeps everything in PostgreSQL 14 or later. Enter how to reach yours, then check the
          connection.
        </Trans>
      </Text>
      <div className="rio-form-row">
        <TextField
          label={t({ id: 'setup.database.host', message: 'Server address' })}
          value={form.host}
          onChange={set('host')}
          isRequired
          autoFocus
          autoComplete="off"
          errorMessage={fieldError('host')}
          isInvalid={Boolean(fieldError('host'))}
        />
        <NumberField
          label={t({ id: 'setup.database.port', message: 'Port' })}
          value={form.port}
          onChange={(v: number) => set('port')(Number.isFinite(v) ? v : 5432)}
          errorMessage={fieldError('port')}
          isInvalid={Boolean(fieldError('port'))}
          minValue={1}
          maxValue={65535}
          formatOptions={{ useGrouping: false }}
          isRequired
        />
      </div>
      <TextField
        label={t({ id: 'setup.database.name', message: 'Database name' })}
        value={form.database}
        onChange={set('database')}
        errorMessage={fieldError('database')}
        isInvalid={Boolean(fieldError('database'))}
        isRequired
        autoComplete="off"
      />
      <TextField
        label={t({ id: 'setup.database.user', message: 'User name' })}
        value={form.user}
        onChange={set('user')}
        errorMessage={fieldError('user')}
        isInvalid={Boolean(fieldError('user'))}
        isRequired
        autoComplete="off"
      />
      <PasswordField
        label={t({ id: 'setup.database.password', message: 'Password' })}
        value={form.password}
        onChange={set('password')}
        errorMessage={fieldError('auth.password')}
        isInvalid={Boolean(fieldError('auth.password'))}
        isRequired
        autoComplete="off"
      />
      <Select
        label={t({ id: 'setup.database.tls', message: 'Encryption' })}
        selectedKey={form.tlsMode}
        onSelectionChange={(key) => set('tlsMode')(key as TlsMode)}
      >
        {tlsOptions.map((option) => (
          <ListBoxItem key={option.id} id={option.id}>
            {option.label}
          </ListBoxItem>
        ))}
      </Select>
      <Disclosure>
        <DisclosureTrigger>
          <Trans id="setup.database.advanced">Certificate settings</Trans>
        </DisclosureTrigger>
        <DisclosurePanel>
          <TextArea
            label={t({ id: 'setup.database.caPem', message: 'Certificate authority (PEM)' })}
            description={t({
              id: 'setup.database.caPemHelp',
              message: 'Only needed when the database’s certificate comes from a private authority.',
            })}
            value={form.caPem}
            onChange={set('caPem')}
            errorMessage={fieldError('tls.caPem')}
            isInvalid={Boolean(fieldError('tls.caPem'))}
            rows={4}
          />
          <TextField
            label={t({ id: 'setup.database.serverName', message: 'Name on the certificate' })}
            description={t({
              id: 'setup.database.serverNameHelp',
              message: 'Only needed when the certificate names a different host than the server address.',
            })}
            value={form.serverName}
            onChange={set('serverName')}
            errorMessage={fieldError('tls.serverName')}
            isInvalid={Boolean(fieldError('tls.serverName'))}
            autoComplete="off"
          />
        </DisclosurePanel>
      </Disclosure>
      {lastError && (!lastError.fields || Object.keys(lastError.fields).some((f) => !SHOWN_FIELDS.has(f))) ? (
        <ErrorBanner error={lastError} />
      ) : null}
      {report ? <DiagnosticList report={report} /> : null}
      <FormActions>
        <Button
          onPress={() => flow.testDatabase.mutate(profile)}
          isPending={flow.testDatabase.isPending}
          isDisabled={flow.saveDatabase.isPending}
        >
          <Trans id="setup.database.test">Check connection</Trans>
        </Button>
        <Button type="submit" variant="primary" isPending={flow.saveDatabase.isPending}>
          <Trans id="setup.database.save">Connect and continue</Trans>
        </Button>
      </FormActions>
    </Form>
  );
}
