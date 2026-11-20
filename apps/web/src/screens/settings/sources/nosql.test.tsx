import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { SourceConnection, requiredSecrets } from '@riosoma/contracts';
import { renderSharing } from '../../database/share/testing';
import { blankValues, fromConnection, secretNamesFor, toConnection } from './kinds';
import { SourceConnectionForm } from './SourceConnectionForm';

afterEach(cleanup);
it.each(['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb'] as const)(
  'round-trips every %s setting and names required credentials',
  (kind) => {
    const connection = SourceConnection.parse({
      kind,
      endpoint: 'http://127.0.0.1:18000',
      region: 'us-east-1',
      segments: 3,
      user: 'reader',
      database: 'test',
      projectId: 'rio-test',
      emulator: true,
      collectionGroups: ['items'],
      auth: 'entra',
      flattenDepth: 2,
      arrays: 'json',
    });
    expect(toConnection(kind, fromConnection(connection))).toEqual(connection);
    expect(secretNamesFor(connection)).toEqual(expect.arrayContaining(requiredSecrets(connection)));
  },
);
it('offers labeled emulator and collection-group controls', async () => {
  const values = { ...blankValues('firestore'), projectId: 'rio-test' };
  let patch: unknown;
  renderSharing(
    <SourceConnectionForm
      kind="firestore"
      values={values}
      onChange={(value) => {
        patch = value;
      }}
      fieldError={() => undefined}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'Project ID' })).toBeDefined();
  expect(screen.getByRole('textbox', { name: 'Collection groups' })).toBeDefined();
  await userEvent.setup().click(screen.getByRole('switch', { name: 'Use the local emulator' }));
  expect(patch).toEqual({ emulator: true });
});
it('requires a service account outside the emulator and supports both Cosmos sign-ins', () => {
  expect(toConnection('cosmosdb', { ...blankValues('cosmosdb'), endpoint: 'http://127.0.0.1' })).toBeNull();
  expect(requiredSecrets(SourceConnection.parse({ kind: 'firestore', projectId: 'rio-test' }))).toEqual([
    'serviceAccountJson',
  ]);
  expect(
    requiredSecrets(
      SourceConnection.parse({ kind: 'cosmosdb', endpoint: 'https://127.0.0.1', database: 'test' }),
    ),
  ).toEqual(['secretAccessKey']);
  expect(
    requiredSecrets(
      SourceConnection.parse({
        kind: 'cosmosdb',
        endpoint: 'https://127.0.0.1',
        database: 'test',
        auth: 'entra',
      }),
    ),
  ).toEqual(['token']);
});
