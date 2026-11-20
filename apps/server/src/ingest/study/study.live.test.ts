import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGISTRY } from '@riosoma/ai';
import { DatabaseCreate, newId } from '@riosoma/contracts';
import { generateArchetype } from '@riosoma/ingest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { providerKeysFrom } from '../../ai/provider-keys.js';
import { loadTable } from '../../data/metadata.js';
import { configure, workbook } from '../build/test-helpers.js';
import { loadStudy } from './store.js';

const live = process.env.RIOSOMA_INGEST_STUDY_EVAL_LIVE === '1';
let kit: TestPostgres;
let server: ServerFixture;
describe.skipIf(!live)('live unknown file studies', () => {
  beforeAll(async () => {
    const providerId = process.env.RIOSOMA_INGEST_STUDY_EVAL_PROVIDER;
    const model = process.env.RIOSOMA_INGEST_STUDY_EVAL_MODEL;
    expect(
      REGISTRY.some(
        (entry) => entry.providerId === providerId && entry.model === model && entry.tiers.includes('power'),
      ),
    ).toBe(true);
    kit = await startTestPostgres();
    server = await startServer(kit, 'studylive', providerKeysFrom(process.env));
    server.ctx.ingest!.pause();
    await configure(server, {
      providers: [{ providerId }],
      models: { everyday: null, power: { providerId, model } },
    });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });
  for (const archetype of [1, 2, 3] as const)
    it(`drafts reading rules for unknown generated file ${archetype}`, async () => {
      const generated = generateArchetype(archetype, { size: 3, seed: 31 });
      const keys = Object.keys(generated.expected[0]!.values);
      const input = DatabaseCreate.parse({
        id: newId('database'),
        name: 'Files',
        table: {
          id: newId('table'),
          name: 'Rows',
          fields: keys.map((key) => ({
            id: newId('field'),
            name: key,
            type: ['amount', 'units'].includes(key)
              ? 'number'
              : ['date', 'period'].includes(key)
                ? 'date'
                : 'text',
          })),
          view: { id: newId('view'), name: 'Grid' },
        },
      });
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: input,
      });
      expect(created.statusCode, created.body).toBe(200);
      const worker = server.ctx.ingest!;
      const context = {
        orgId: server.owner.info.org.id,
        tableId: input.table.id,
        userId: server.owner.userId,
      };
      await worker.store.tables.changeSettings(context, null, {
        state: 'live',
        ownerId: server.owner.userId,
        identity: null,
        rowMeaning: '',
        fields: keys.map((key, index) => ({
          key,
          fieldId: input.table.fields[index]!.id,
          meaning: '',
          required: false,
        })),
        originals: { keepDays: 90, readOnlyAccess: false },
        reply: true,
      });
      for (const [index, field] of input.table.fields.entries())
        await worker.store.tables.markField(context, field.id, { key: keys[index]!, role: 'data' });
      const table = (await loadTable(server.pool, server.schemas, input.table.id))!;
      const file = await worker.receiveFile(table, {
        name: 'generated.xlsx',
        bytes: Buffer.from(workbook(generated).base64, 'base64'),
        droppedBy: server.owner.userId,
      });
      await worker.drain();
      const study = await loadStudy(worker.store, file, file.id);
      expect(study?.build.state, JSON.stringify(study?.build)).toBe('passed');
      expect(study?.draft).toBeTruthy();
      expect(study?.reading?.rows.length).toBeGreaterThan(0);
      const result = await server.app.inject({
        url: `/api/tables/${table.id}/ingest/files/${file.id}/study`,
        headers: server.owner.headers,
      });
      expect(result.statusCode, result.body).toBe(200);
    }, 360_000);
});
