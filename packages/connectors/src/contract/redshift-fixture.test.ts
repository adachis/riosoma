import { FixtureBoundary } from './boundary.test-support.js';
import { strictFixture } from './strict.test-support.js';
import { SourceConnection } from '@riosoma/contracts';
import type pg from 'pg';
import { it } from 'vitest';
import { createRedshiftConnector } from '../warehouses/redshift.js';
import { exerciseFixture } from './fixture.js';

it('runs the public Redshift adapter against catalog and cursor fixtures', async () => {
  let offset = 0;
  const data = [1, 2, 3].map((id) => ({ id: String(id), title: `item-${id}` }));
  let selected = data;
  const boundary = new FixtureBoundary();
  const client = {
    on() {},
    async connect() {},
    async end() {},
    async query({ text, values }: { text: string; values?: unknown[] }) {
      let rows: unknown[] = [];
      if (text.includes('svv_columns'))
        rows = [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
          {
            column_name: 'title',
            data_type: 'character varying',
            character_maximum_length: 80,
            is_nullable: 'YES',
          },
        ];
      else if (text.includes('FROM svv_tables')) rows = [{ schema: 'public', name: 'items', type: 'TABLE' }];
      else if (text.startsWith('DECLARE')) {
        offset = 0;
        selected = /"id" = 2/.test(text)
          ? data.slice(1, 2)
          : /"id" DESC/.test(text)
            ? [...data].reverse()
            : data;
      } else if (text.includes('LIMIT 0'))
        return {
          rows: [],
          fields: [
            { name: 'id', dataTypeID: 23, dataTypeModifier: -1 },
            { name: 'title', dataTypeID: 1043, dataTypeModifier: 84 },
          ],
        };
      else if (text.includes('format_type'))
        rows = [{ type: values?.[0] === 1043 ? 'character varying(80)' : 'integer' }];
      else if (text.startsWith('FETCH')) {
        const size = Number(text.match(/FORWARD (\d+)/)?.[1]);
        rows = selected.slice(offset, offset + size);
        offset += rows.length;
      }
      return { rows, fields: [] };
    },
  };
  const connector = createRedshiftConnector({
    client: () => boundary.wrap(client) as unknown as pg.Client,
    ca: async () => 'fixture-root',
  });
  const context = {
    connection: SourceConnection.parse({
      kind: 'redshift',
      host: 'warehouse.invalid',
      database: 'fixture',
      region: 'us-east-1',
      user: 'reader',
      auth: 'password',
    }),
    secrets: { password: ['fixture', 'password', '86412'].join('-') },
    timeoutMs: 1000,
  };
  const select = { kind: 'object' as const, object: { schema: 'public', name: 'items' } };
  await exerciseFixture(connector, context, select, ['id'], 3);
  await strictFixture(connector, context, select, ['id'], 3, boundary, (ctx) =>
    connector.preview(ctx, select, 1),
  );
});
