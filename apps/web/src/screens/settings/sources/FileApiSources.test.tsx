import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { renderSharing } from '../../database/share/testing';
import { SourceConnectionForm } from './SourceConnectionForm';
import { blankValues, fromConnection, probeConnection, secretNamesFor, toConnection } from './kinds';
import { GraphQlSuggestions } from './GraphQlSuggestions';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['sftp', 'ftp', 'ftps', 'webdav', 'graphql', 'odata'] as const)(
  'round trips %s settings and offers required secrets before completion',
  (kind) => {
    const values = {
      ...blankValues(kind),
      host: '192.0.2.1',
      user: 'reader',
      sshHostKey: 'public-key',
      url: 'https://192.0.2.1/files/',
      baseUrl: 'https://192.0.2.1/service',
      graphQuery: '{ items { id } }',
      graphRecords: 'data.items',
      restAuth: 'bearer' as const,
    };
    const connection = toConnection(kind, values);
    expect(connection).not.toBeNull();
    expect(toConnection(kind, fromConnection(connection!))).toEqual(connection);
    const probe = probeConnection(kind, { ...blankValues(kind), restAuth: 'bearer' });
    expect(probe).not.toBeNull();
    expect(secretNamesFor(probe)).toContain(['graphql', 'odata'].includes(kind) ? 'token' : 'password');
  },
);

it('offers a pinned host key and keyboard access to authentication choices', async () => {
  const onChange = vi.fn();
  renderSharing(
    <SourceConnectionForm
      kind="sftp"
      values={blankValues('sftp')}
      onChange={onChange}
      fieldError={() => undefined}
    />,
  );
  expect((screen.getByRole('textbox', { name: 'Server host key' }) as HTMLTextAreaElement).required).toBe(
    true,
  );
  expect((screen.getByRole('textbox', { name: 'Path or glob' }) as HTMLInputElement).value).toBe('*');
  const key = screen.getByRole('radio', { name: 'SSH key' });
  key.focus();
  await userEvent.setup().keyboard(' ');
  expect(onChange).toHaveBeenCalledWith({ remoteAuth: 'key' });
  expect(screen.getByRole('link', { name: 'Connection help' }).getAttribute('href')).toContain(
    'help=file-api-sources',
  );
});

it('keeps one form when the kind changes between a document service and a file server', async () => {
  // Picking another kind in the dialog keeps the form mounted, so both kinds share its hooks.
  function Switching() {
    const [kind, setKind] = useState<'dynamodb' | 'sftp'>('dynamodb');
    return (
      <>
        <button type="button" onClick={() => setKind('sftp')}>
          Choose another kind
        </button>
        <SourceConnectionForm
          kind={kind}
          values={blankValues(kind)}
          onChange={() => {}}
          fieldError={() => undefined}
        />
      </>
    );
  }
  renderSharing(<Switching />);
  expect(screen.getByRole('textbox', { name: 'Service address' })).toBeDefined();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Choose another kind' }));
  expect(screen.getByRole('textbox', { name: 'Path or glob' })).toBeDefined();
  expect(screen.queryByRole('textbox', { name: 'Service address' })).toBeNull();
});

it('requests introspection and displays suggested fields', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify([{ name: 'Item.id', sourceType: 'Int' }]), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const connection = SourceConnection.parse({
    kind: 'graphql',
    baseUrl: 'https://192.0.2.1/',
    query: '{ items { id } }',
    records: 'data.items',
  });
  renderSharing(<GraphQlSuggestions connection={connection} secrets={{}} disabled={false} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Suggest fields' }));
  expect(await screen.findByText('Item.id')).toBeTruthy();
  expect(fetch.mock.calls).toHaveLength(1);
});
