import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HTTP_ENGINE_KINDS, SourceConnection } from '@riosoma/contracts';
import { renderSharing } from '../../database/share/testing';
import { HttpEngineSourceFields } from './HttpEngineSourceFields';
import { SourceConnectionForm } from './SourceConnectionForm';
import { KIND_SECRET_HINTS } from './labels';
import {
  blankValues,
  fromConnection,
  KIND_INFO,
  probeConnection,
  secretNamesFor,
  toConnection,
} from './kinds';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

it.each(HTTP_ENGINE_KINDS)(
  'round trips %s settings and discovers credentials before the form is complete',
  (kind) => {
    const endpoint = `https://${crypto.randomUUID()}.invalid`;
    const source = SourceConnection.parse({ kind, endpoint, database: 'metrics', query: 'up' });
    expect(toConnection(kind, fromConnection(source))).toEqual(source);
    expect(KIND_INFO.some((entry) => entry.kind === kind)).toBe(true);
    const draft = probeConnection(kind, blankValues(kind));
    expect(draft?.kind).toBe(kind);
    expect(secretNamesFor(draft)).toEqual(
      kind === 'prometheus'
        ? []
        : kind === 'neo4j' || kind === 'opensearch'
          ? ['password']
          : kind === 'influxdb'
            ? ['token']
            : ['apiKey'],
    );
  },
);

it.each(HTTP_ENGINE_KINDS)('labels %s setup controls and preserves its deep link in help', (kind) => {
  window.history.replaceState(null, '', `/settings/sources?source=new&kind=${kind}`);
  renderSharing(
    <HttpEngineSourceFields
      kind={kind}
      values={blankValues(kind)}
      onChange={vi.fn()}
      fieldError={() => undefined}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'HTTP endpoint' })).toHaveProperty('required', true);
  expect(screen.getByRole('radiogroup', { name: 'Sign in with' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Connection help' }).getAttribute('href')).toBe(
    `?source=new&kind=${kind}&help=search-graph-metrics`,
  );
  if (kind === 'prometheus')
    expect(screen.getByRole('textbox', { name: 'PromQL range query' })).toHaveProperty('required', true);
  if (kind === 'influxdb' || kind === 'prometheus')
    expect(screen.getByRole('textbox', { name: 'Window in minutes' })).toHaveProperty('value', '60');
});

it('says where each engine’s credential comes from', () => {
  // A secret's own label is one word, so each kind names the place its key or token is made.
  expect(KIND_SECRET_HINTS.elasticsearch?.apiKey?.id).toBe('sources.engines.apiKey.hint');
  expect(KIND_SECRET_HINTS.opensearch?.apiKey?.id).toBe('sources.engines.apiKey.hint');
  expect(KIND_SECRET_HINTS.opensearch?.accessKeyId?.id).toBe('sources.engines.awsKey.hint');
  expect(KIND_SECRET_HINTS.meilisearch?.apiKey?.id).toBe('sources.engines.meiliKey.hint');
  expect(KIND_SECRET_HINTS.typesense?.apiKey?.id).toBe('sources.engines.typesenseKey.hint');
  expect(KIND_SECRET_HINTS.neo4j?.password?.id).toBe('sources.engines.neo4jPassword.hint');
  expect(KIND_SECRET_HINTS.influxdb?.token?.id).toBe('sources.engines.influxToken.hint');
  expect(KIND_SECRET_HINTS.prometheus?.token?.id).toBe('sources.engines.bearer.hint');
});

it('switches AWS authentication using the keyboard', async () => {
  const onChange = vi.fn();
  renderSharing(
    <HttpEngineSourceFields
      kind="opensearch"
      values={blankValues('opensearch')}
      onChange={onChange}
      fieldError={() => undefined}
    />,
  );
  screen.getByRole('radio', { name: 'AWS Signature Version 4' }).focus();
  await userEvent.setup().keyboard(' ');
  expect(onChange).toHaveBeenCalledWith({ engineAuth: 'aws-sigv4' });
});

it('offers an AWS session token beside the keys that sign a request', () => {
  // Signing with an identity's key pair may also take a temporary token, as the other AWS sources do.
  const signed = SourceConnection.parse({
    kind: 'opensearch',
    endpoint: `https://${crypto.randomUUID()}.invalid`,
    auth: 'aws-sigv4',
  });
  expect(secretNamesFor(signed)).toEqual(['accessKeyId', 'secretAccessKey', 'sessionToken']);
});

it.each(HTTP_ENGINE_KINDS)('answers %s from the shared setup form', (kind) => {
  // The dialog keeps one form for every kind, which hands these seven to their own fields.
  window.history.replaceState(null, '', `/settings/sources?source=new&kind=${kind}`);
  renderSharing(
    <SourceConnectionForm
      kind={kind}
      values={blankValues(kind)}
      onChange={vi.fn()}
      fieldError={() => undefined}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'HTTP endpoint' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Connection help' }).getAttribute('href')).toBe(
    `?source=new&kind=${kind}&help=search-graph-metrics`,
  );
});
