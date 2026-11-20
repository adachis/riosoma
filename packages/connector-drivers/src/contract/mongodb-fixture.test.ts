import {
  exerciseFixture,
  strictFixture,
  type ContractTransport as FixtureBoundary,
} from '@riosoma/connectors';
import { it, vi } from 'vitest';
import type * as mongodb from 'mongodb';
import { createMongoConnector } from '../mongodb/connector.js';
import { MONGO_CONTRACT_SELECT, mongoContractContext } from './mongodb-driver.test-support.js';

const trace = vi.hoisted(() => ({ boundary: undefined as FixtureBoundary | undefined }));

vi.mock('mongodb', async (importOriginal) => {
  const original = await importOriginal<typeof mongodb>();
  const { ContractTransport } = await import('@riosoma/connectors');
  const { fakeMongoModule } = await import('./mongodb-driver.test-support.js');
  const boundary = new ContractTransport();
  trace.boundary = boundary;
  return fakeMongoModule(original, boundary);
});

it('runs the public MongoDB adapter against driver cursor fixtures', async () => {
  const connector = createMongoConnector();
  const context = mongoContractContext();
  const select = MONGO_CONTRACT_SELECT;
  await exerciseFixture(connector, context, select, ['_id'], 3);
  await strictFixture(connector, context, select, ['_id'], 3, trace.boundary!, (ctx) =>
    connector.preview(ctx, select, 1),
  );
});
