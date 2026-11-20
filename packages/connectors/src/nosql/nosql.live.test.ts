import { describe, expect, it } from 'vitest';
import { NOSQL_KINDS, SourceConnection, SourceSecrets, SourceObjectRef } from '@riosoma/contracts';
import { createNoSqlConnector } from './connector.js';
import type { SourceRow } from '../types.js';
import { keyPredicate } from './reader.js';

for (const kind of NOSQL_KINDS) {
  const setting = process.env[`RIOSOMA_TEST_${kind.toUpperCase()}_SETTINGS`];
  describe.skipIf(!setting)(`${kind} against a configured local service`, () => {
    const config = () => {
      const parsed = JSON.parse(setting!) as Record<string, unknown>;
      const connection = SourceConnection.parse(parsed.connection);
      if (connection.kind !== kind) throw new Error('source kind mismatch');
      return {
        ctx: { connection, secrets: SourceSecrets.parse(parsed.secrets), timeoutMs: 30000 },
        object: SourceObjectRef.parse(parsed.object),
      };
    };
    it('tests the connection and lists the selected collection', async () => {
      const { ctx, object } = config();
      const connector = createNoSqlConnector(kind);
      expect(await connector.test(ctx)).toMatchObject({ ok: true });
      expect(await connector.listObjects(ctx)).toContainEqual(expect.objectContaining(object));
    });
    it('samples and reads the seeded collection with stable keys', async () => {
      const { ctx, object } = config();
      const connector = createNoSqlConnector(kind);
      const select = { kind: 'object' as const, object };
      const preview = await connector.preview(ctx, select, 5);
      expect(preview.rows.length).toBeGreaterThan(0);
      const [keyColumns] = await connector.keyCandidates(ctx, object);
      const rows: SourceRow[] = [];
      for await (const batch of connector.read(ctx, select, {
        columns: preview.columns.map((c) => c.name),
        types: Object.fromEntries(preview.columns.map((c) => [c.name, c.suggested?.type ?? 'text'])),
        keyColumns: keyColumns!,
        batchSize: 2,
      }))
        rows.push(...batch);
      expect(rows.length).toBeGreaterThanOrEqual(preview.rows.length);
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
      expect(rows[0]!.values).toBeDefined();
      for (const row of rows.slice(0, 20)) {
        const predicate = keyPredicate(
          { id: 'test', version: '1', kind, context: ctx, select, keyColumns: keyColumns! },
          [row.key],
        );
        const matched = await connector.documentQuery!(ctx, select, {
          predicate,
          order: [],
          limit: 5,
          columns: preview.columns.map((c) => c.name),
          types: Object.fromEntries(preview.columns.map((c) => [c.name, c.suggested?.type ?? 'text'])),
          keyColumns: keyColumns!,
        });
        expect(matched.map((result) => result.key)).toEqual([row.key]);
      }
    });
  });
}
