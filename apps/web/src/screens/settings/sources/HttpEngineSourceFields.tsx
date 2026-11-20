import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRouter } from '@tanstack/react-router';
import { NumberField, Radio, RadioGroup, TextArea, TextField } from '@riosoma/ui';
import type { SourceConnectionFormProps } from './SourceConnectionForm';
import type { SourceFormValues } from './kinds';

const AUTH = {
  none: msg({ id: 'sources.engines.auth.none', message: 'No authentication' }),
  basic: msg({ id: 'sources.engines.auth.basic', message: 'User and password' }),
  'api-key': msg({ id: 'sources.engines.auth.apiKey', message: 'API key' }),
  token: msg({ id: 'sources.engines.auth.token', message: 'Token' }),
  'aws-sigv4': msg({ id: 'sources.engines.auth.aws', message: 'AWS Signature Version 4' }),
};

export function HttpEngineSourceFields({
  kind,
  values,
  onChange,
  fieldError,
  isDisabled,
}: SourceConnectionFormProps) {
  const { t, i18n } = useLingui();
  const router = useRouter({ warn: false });
  const helpSearch = new URLSearchParams(window.location.search);
  helpSearch.set('help', 'search-graph-metrics');
  /** Shared wiring for one field: its server-reported error, and the pending-request state. */
  const state = (name: string) => ({
    isDisabled,
    isInvalid: Boolean(fieldError(name)),
    errorMessage: fieldError(name),
  });
  const field = (
    name: keyof SourceFormValues,
    label: MessageDescriptor,
    required = true,
    placeholder?: string,
  ) => (
    <TextField
      label={i18n._(label)}
      value={String(values[name])}
      onChange={(value) => onChange({ [name]: value })}
      isRequired={required}
      autoComplete="off"
      {...(placeholder ? { placeholder } : {})}
      {...state(name)}
    />
  );
  const auth =
    kind === 'neo4j'
      ? (['none', 'basic'] as const)
      : kind === 'influxdb'
        ? (['none', 'token'] as const)
        : kind === 'prometheus'
          ? (['none', 'basic', 'token'] as const)
          : kind === 'opensearch'
            ? (['none', 'basic', 'api-key', 'aws-sigv4'] as const)
            : (['none', 'basic', 'api-key'] as const);
  const metrics = kind === 'influxdb' || kind === 'prometheus';
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
            search: (previous: Record<string, unknown>) => ({ ...previous, help: 'search-graph-metrics' }),
          });
        }}
      >
        <Trans id="sources.engines.help">Connection help</Trans>
      </a>
      <TextField
        label={t({ id: 'sources.engines.endpoint', message: 'HTTP endpoint' })}
        description={t({
          id: 'sources.engines.endpointHint',
          message: 'The address of the engine’s own HTTP API, with its port and any path it sits under.',
        })}
        // An example of the shape, which is an address rather than words to translate.
        placeholder="https://search.example.com:9200"
        value={values.endpoint}
        onChange={(endpoint) => onChange({ endpoint })}
        isRequired
        autoComplete="off"
        {...state('endpoint')}
      />
      <RadioGroup
        label={t({ id: 'sources.field.auth', message: 'Sign in with' })}
        value={values.engineAuth}
        onChange={(value) => {
          if (value in AUTH) onChange({ engineAuth: value as SourceFormValues['engineAuth'] });
        }}
        isDisabled={isDisabled}
      >
        {auth.map((value) => (
          <Radio key={value} value={value}>
            {i18n._(AUTH[value])}
          </Radio>
        ))}
      </RadioGroup>
      {values.engineAuth === 'basic' && field('user', msg({ id: 'sources.field.user', message: 'User' }))}
      {values.engineAuth === 'aws-sigv4' && (
        <>
          {field('region', msg({ id: 'sources.field.region', message: 'Region' }))}
          <RadioGroup
            label={t({ id: 'sources.engines.awsService', message: 'OpenSearch deployment' })}
            value={values.engineService}
            onChange={(value) => {
              if (value === 'es' || value === 'aoss') onChange({ engineService: value });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="es">
              <Trans id="sources.engines.managed">Managed domain</Trans>
            </Radio>
            <Radio value="aoss">
              <Trans id="sources.engines.serverless">Serverless collection</Trans>
            </Radio>
          </RadioGroup>
        </>
      )}
      {(kind === 'neo4j' || kind === 'influxdb') &&
        field('database', msg({ id: 'sources.engines.database', message: 'Database or bucket' }))}
      {kind === 'influxdb' && (
        <>
          <RadioGroup
            label={t({ id: 'sources.engines.version', message: 'InfluxDB version' })}
            value={values.influxVersion}
            onChange={(value) => {
              if (value === '2' || value === '3') onChange({ influxVersion: value });
            }}
            isDisabled={isDisabled}
          >
            <Radio value="2">
              <Trans id="sources.engines.v2">Version 2 with Flux</Trans>
            </Radio>
            <Radio value="3">
              <Trans id="sources.engines.v3">Version 3 with SQL</Trans>
            </Radio>
          </RadioGroup>
          {values.influxVersion === '2' &&
            field('organization', msg({ id: 'sources.engines.organization', message: 'Organization' }))}
        </>
      )}
      {kind === 'prometheus' && (
        <>
          <TextArea
            label={t({ id: 'sources.engines.promql', message: 'PromQL range query' })}
            description={t({
              id: 'sources.engines.promqlHint',
              message: 'Read over the window below.  Every label it returns becomes a field.',
            })}
            value={values.query}
            onChange={(query) => onChange({ query })}
            isRequired
            rows={4}
            maxLength={20_000}
            {...state('query')}
          />
          <NumberField
            label={t({ id: 'sources.engines.step', message: 'Step in seconds' })}
            value={values.stepSeconds}
            onChange={(stepSeconds) => onChange({ stepSeconds })}
            minValue={1}
            maxValue={86_400}
            formatOptions={{ useGrouping: false }}
            {...state('stepSeconds')}
          />
        </>
      )}
      {metrics && (
        <>
          <NumberField
            label={t({ id: 'sources.engines.windowMinutes', message: 'Window in minutes' })}
            description={t({
              id: 'sources.engines.windowHint',
              message:
                'Each sync reads this window ending now.  Optional start and end times use a fixed range instead.',
            })}
            value={values.windowMinutes}
            onChange={(windowMinutes) => onChange({ windowMinutes })}
            minValue={1}
            maxValue={525_600}
            formatOptions={{ useGrouping: false }}
            {...state('windowMinutes')}
          />
          {/* Examples of the shape, which are timestamps rather than words to translate. */}
          {field(
            'start',
            msg({ id: 'sources.engines.start', message: 'Start time with time zone' }),
            false,
            '2026-01-01T00:00:00Z',
          )}
          {field(
            'end',
            msg({ id: 'sources.engines.end', message: 'End time with time zone' }),
            false,
            '2026-01-02T00:00:00-05:00',
          )}
        </>
      )}
      <TextArea
        label={t({ id: 'sources.engines.ca', message: 'Trusted certificate authority' })}
        description={t({
          id: 'sources.engines.caHint',
          message: 'Optional PEM certificate for a private certificate authority.',
        })}
        value={values.caPem}
        onChange={(caPem) => onChange({ caPem })}
        rows={3}
        {...state('caPem')}
      />
      <p>
        <Trans id="sources.engines.readOnlyHint">Use credentials that can only read the selected data.</Trans>
      </p>
    </>
  );
}
