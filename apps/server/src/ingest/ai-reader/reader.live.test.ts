import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTRY } from '@riosoma/ai';
import { DatabaseCreate, IngestFormat, IngestTableSettings, newId } from '@riosoma/contracts';
import { comparePairRows, generateArchetype } from '@riosoma/ingest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { loadTable } from '../../data/metadata.js';
import { createAiReader } from './index.js';

// The explicit evaluation flag keeps ordinary runs offline even when provider credentials are present.
const live = process.env.RIOSOMA_TEST_INGEST_READER_LIVE === '1';
let kit: TestPostgres;
let server: ServerFixture;
describe.skipIf(!live)('Spreadsheet reading with a live provider', () => {
  beforeAll(async () => {
    const providerId = process.env.RIOSOMA_TEST_INGEST_PROVIDER;
    const model = process.env.RIOSOMA_TEST_INGEST_MODEL;
    const key = process.env.RIOSOMA_TEST_INGEST_KEY;
    if (
      !providerId ||
      !model ||
      !key ||
      !REGISTRY.some(
        (entry) => entry.providerId === providerId && entry.model === model && entry.tiers.includes('vision'),
      )
    )
      throw new Error('ingest.aiReader.providerUnavailable');
    kit = await startTestPostgres();
    server = await startServer(kit, 'readerlive', { providerApiKeys: { [providerId]: key } });
    server.ctx.ingest!.pause();
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/ai/settings',
      headers: server.owner.headers,
      payload: {
        enabled: true,
        ingest: true,
        providers: [{ providerId }],
        models: { everyday: null, power: null },
        ingestFileLimitUsd: 1,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const current = await server.app.inject({
      method: 'GET',
      url: '/api/knowledge/settings',
      headers: server.owner.headers,
    });
    const knowledge = await server.app.inject({
      method: 'POST',
      url: '/api/knowledge/commands',
      headers: server.owner.headers,
      payload: {
        id: randomUUID(),
        kind: 'knowledge.settings',
        settings: { ...current.json(), imports: { model: { providerId, model } } },
      },
    });
    expect(knowledge.statusCode, knowledge.body).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });
  it.each([21, 22, 23])(
    'reproduces the expected rows of generated workbook %s',
    async (seed) => {
      const corpus = generateArchetype(3, { seed, size: 5 });
      const fields = ['id', 'product', 'amount', 'period'].map((key) => ({
        key,
        id: newId('field'),
        name: key,
        type: key === 'amount' ? 'number' : key === 'period' ? 'date' : 'text',
      }));
      const input = DatabaseCreate.parse({
        id: newId('database'),
        name: 'Orders',
        table: { id: newId('table'), name: 'Orders', fields, view: { id: newId('view'), name: 'Grid' } },
      });
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: '/api/databases',
            headers: server.owner.headers,
            payload: input,
          })
        ).statusCode,
      ).toBe(200);
      const settings = IngestTableSettings.parse({
        state: 'setup',
        ownerId: null,
        rowMeaning: 'Each row represents one order.',
        identity: ['id', 'period'],
        fields: fields.map((field) => ({
          key: field.key,
          fieldId: field.id,
          meaning: `The order ${field.key}.`,
          required: true,
        })),
        originals: { keepDays: 90 },
        revision: 1,
      });
      const table = { ...(await loadTable(server.pool, server.schemas, input.table.id))!, ingest: settings };
      const format = {
        ...IngestFormat.parse({
          id: 'orders',
          orgId: server.owner.info.org.id,
          tableId: table.id,
          name: 'Orders',
          reading: 'ai',
          rules: null,
          state: 'draft',
          revision: 1,
          probationPassed: 0,
          signature: corpus.signature,
          createdBy: null,
          createdAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
        }),
        reading: 'ai' as const,
        rules: null,
      };
      const actor = {
        orgId: server.owner.info.org.id,
        userId: server.owner.userId,
        kind: 'owner' as const,
        sessionId: 'evaluation',
        csrfToken: '',
        adminRoles: [],
      };
      const reading = await createAiReader(server.ctx, actor)(corpus.source, format, table);
      expect(reading.status, JSON.stringify(reading)).toBe('read');
      expect(reading.flagged).toBe(false);
      const compared = comparePairRows(reading.rows, corpus.expected, {
        ...settings,
        fields: settings.fields.map((field) => ({
          ...field,
          type:
            field.key === 'amount'
              ? ('number' as const)
              : field.key === 'period'
                ? ('date' as const)
                : ('text' as const),
        })),
      });
      expect(compared.differences).toEqual([]);
      expect(compared.passed).toBe(true);
    },
    120_000,
  );
});
