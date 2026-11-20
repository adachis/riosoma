import { TableSourceSettings, type SourceMeta, type SourcePreview } from '@riosoma/contracts';
import { queuedSource } from '../source';
import { FakeServer } from './fake-server';

export const source: SourceMeta = {
  id: 'src00000000000001',
  name: 'Warehouse',
  description: '',
  kind: 'postgres',
  connection: null,
  secrets: [],
  access: 'creators',
  createdAt: '',
  createdBy: null,
  updatedAt: '',
  lastTest: null,
  tables: 0,
};
export const preview: SourcePreview = {
  columns: [
    {
      name: 'id',
      sourceType: 'integer',
      nullable: false,
      suggested: { type: 'number', options: {} },
      alternatives: ['text'],
    },
    {
      name: 'name',
      sourceType: 'text',
      nullable: true,
      suggested: { type: 'text', options: {} },
      alternatives: ['longText'],
    },
    { name: 'bytes', sourceType: 'binary', nullable: true, suggested: null, alternatives: [] },
  ],
  rows: [[1, 'First', null]],
  rowEstimate: 100,
  keyCandidates: [['id']],
};
export function syncedFixture(count = 10) {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  const database = server.database(fixture.databaseId);
  const settings = TableSourceSettings.parse({
    sourceId: source.id,
    select: { kind: 'object', object: { schema: 'public', name: 'People' } },
    keyColumns: ['id'],
  });
  const table = database.schema.tables[0]!;
  table.source = { ...queuedSource(settings), sourceName: source.name };
  table.source.status.state = 'idle';
  database.schema.fields = database.schema.fields.map((field) =>
    field.id === fixture.textFieldId ? { ...field, source: { column: 'name', sourceType: 'text' } } : field,
  );
  return { server, fixture, table, database };
}
