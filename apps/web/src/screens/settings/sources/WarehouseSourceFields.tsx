import { Trans, useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useRouter } from '@tanstack/react-router';
import { NumberField, Radio, RadioGroup, TextField } from '@riosoma/ui';
import type { SourceConnectionFormProps } from './SourceConnectionForm';
import type { SourceFormValues } from './kinds';

export function WarehouseSourceFields({
  kind,
  values,
  onChange,
  fieldError,
  isDisabled,
}: SourceConnectionFormProps) {
  const { t, i18n } = useLingui();
  const router = useRouter({ warn: false });
  const helpSearch = new URLSearchParams(window.location.search);
  helpSearch.set('help', 'warehouse-sources');
  const state = (name: string) => ({
    isDisabled,
    isInvalid: Boolean(fieldError(name)),
    errorMessage: fieldError(name),
  });
  const field = (name: keyof SourceFormValues, label: MessageDescriptor, isRequired = true) => (
    <TextField
      label={i18n._(label)}
      value={String(values[name])}
      onChange={(value) => onChange({ [name]: value })}
      isRequired={isRequired}
      autoComplete="off"
      {...state(name === 'duckPath' ? 'path' : name)}
    />
  );
  const region = field('region', msg({ id: 'sources.field.region', message: 'Region' }));
  const database = field('database', msg({ id: 'sources.field.database', message: 'Database' }));
  const workgroup = field('workgroup', msg({ id: 'sources.field.workgroup', message: 'Workgroup' }));
  return (
    <>
      <a
        href={`?${helpSearch}`}
        onClick={(event) => {
          if (
            !router ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          void router.navigate({
            to: '.',
            search: (previous: Record<string, unknown>) => ({ ...previous, help: 'warehouse-sources' }),
          });
        }}
      >
        <Trans id="sources.warehouses.help">Connection help</Trans>
      </a>
      {kind === 'redshift' ? (
        <>
          {field('host', msg({ id: 'sources.field.host', message: 'Host' }))}
          <NumberField
            label={t({ id: 'sources.field.port', message: 'Port' })}
            value={values.port}
            onChange={(port) => onChange({ port })}
            minValue={1}
            maxValue={65_535}
            formatOptions={{ useGrouping: false }}
            {...state('port')}
          />
          {database}
          {region}
          <RadioGroup
            label={t({ id: 'sources.redshift.deployment', message: 'Deployment' })}
            value={values.deployment}
            onChange={(deployment) => {
              if (deployment === 'provisioned' || deployment === 'serverless') onChange({ deployment });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="provisioned">
              <Trans id="sources.redshift.provisioned">Provisioned cluster</Trans>
            </Radio>
            <Radio value="serverless">
              <Trans id="sources.redshift.serverless">Serverless workgroup</Trans>
            </Radio>
          </RadioGroup>
          <RadioGroup
            label={t({ id: 'sources.field.auth', message: 'Sign in with' })}
            value={values.redshiftAuth}
            onChange={(redshiftAuth) => {
              if (redshiftAuth === 'iam' || redshiftAuth === 'password') onChange({ redshiftAuth });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="iam">
              <Trans id="sources.redshift.iam">IAM temporary credentials</Trans>
            </Radio>
            <Radio value="password">
              <Trans id="sources.secret.password">Password</Trans>
            </Radio>
          </RadioGroup>
          {values.redshiftAuth === 'password' || values.deployment === 'provisioned'
            ? field('user', msg({ id: 'sources.field.user', message: 'User' }))
            : null}
          {values.redshiftAuth === 'iam'
            ? values.deployment === 'provisioned'
              ? field(
                  'clusterIdentifier',
                  msg({ id: 'sources.redshift.clusterIdentifier', message: 'Cluster identifier' }),
                )
              : workgroup
            : null}
          <p className="rio-sources__note">
            <Trans id="sources.redshift.tls">
              TLS checks the endpoint name against the Amazon CA bundle.
            </Trans>
          </p>
        </>
      ) : kind === 'athena' ? (
        <>
          {region}
          {database}
          {field('catalog', msg({ id: 'sources.field.catalog', message: 'Catalog' }))}
          {workgroup}
          {field(
            'resultsLocation',
            msg({ id: 'sources.athena.resultsLocation', message: 'Results location (S3)' }),
          )}
          <NumberField
            label={t({ id: 'sources.athena.maxScannedBytes', message: 'Scan limit per query (bytes)' })}
            description={t({
              id: 'sources.athena.limitHint',
              message:
                'The workgroup must enforce a query scan limit at or below this value.  Queries are refused until that limit is configured.',
            })}
            value={values.maxScannedBytes}
            onChange={(maxScannedBytes) => onChange({ maxScannedBytes })}
            minValue={10_000_000}
            maxValue={Number.MAX_SAFE_INTEGER}
            isRequired
            {...state('maxScannedBytes')}
          />
        </>
      ) : (
        <>
          <RadioGroup
            label={t({ id: 'sources.duckdb.storage', message: 'File location' })}
            value={values.duckStorage}
            onChange={(duckStorage) => {
              if (duckStorage === 'local' || duckStorage === 'url' || duckStorage === 'bucket')
                onChange({ duckStorage });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="local">
              <Trans id="sources.duckdb.local">Allowed local path</Trans>
            </Radio>
            <Radio value="url">
              <Trans id="sources.duckdb.url">Uploaded file address</Trans>
            </Radio>
            <Radio value="bucket">
              <Trans id="sources.duckdb.bucket">S3 bucket</Trans>
            </Radio>
          </RadioGroup>
          {values.duckStorage === 'local' ? (
            field('duckPath', msg({ id: 'sources.duckdb.path', message: 'File or folder path' }))
          ) : values.duckStorage === 'url' ? (
            field('url', msg({ id: 'sources.field.url', message: 'Address' }))
          ) : (
            <>
              {field('bucket', msg({ id: 'sources.field.bucket', message: 'Bucket' }))}
              {field('prefix', msg({ id: 'sources.field.prefix', message: 'Key or prefix' }), false)}
              {region}
            </>
          )}
          <RadioGroup
            label={t({ id: 'sources.duckdb.format', message: 'File format' })}
            value={values.duckFormat}
            onChange={(duckFormat) => {
              if (duckFormat === 'duckdb' || duckFormat === 'parquet' || duckFormat === 'csv')
                onChange({ duckFormat });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="duckdb">
              <Trans id="sources.duckdb.databaseFile">DuckDB database</Trans>
            </Radio>
            <Radio value="parquet">
              <Trans id="sources.duckdb.parquet">Parquet folder</Trans>
            </Radio>
            <Radio value="csv">
              <Trans id="sources.duckdb.csv">CSV folder</Trans>
            </Radio>
          </RadioGroup>
          <p className="rio-sources__note">
            <Trans id="sources.duckdb.readOnly">
              Files are read-only. Local paths must be inside a directory your server operator allows.
            </Trans>
          </p>
        </>
      )}
    </>
  );
}
