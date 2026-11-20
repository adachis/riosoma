import type { ContractTransport } from '@riosoma/connectors';
import { SourceConnection } from '@riosoma/contracts';
import type * as mongodb from 'mongodb';

/**
 * The MongoDB driver with its client replaced by one that answers from three documents, for the
 * shared contract.  A test mocks `mongodb` with it, here and in the connector service's contract
 * test, and the boundary sees every client the connector makes.
 */
export function fakeMongoModule(
  original: typeof mongodb,
  boundary: ContractTransport,
): Record<string, unknown> {
  const documents = [1, 2, 3].map((id) => ({ _id: `item-${id}`, title: `item-${id}` }));
  class Cursor {
    private offset = 0;
    constructor(
      readonly rows: typeof documents,
      readonly size = 1000,
    ) {}
    async toArray() {
      return this.rows;
    }
    async hasNext() {
      return this.offset < this.rows.length;
    }
    readBufferedDocuments() {
      const batch = this.rows.slice(this.offset, this.offset + this.size);
      this.offset += batch.length;
      return batch;
    }
    async close() {}
  }
  const collection = {
    estimatedDocumentCount: async () => documents.length,
    aggregate: () => new Cursor(documents),
    find: (filter: Record<string, unknown>, options: { batchSize?: number; limit?: number }) =>
      new Cursor(
        documents
          .filter((row) =>
            Object.entries(filter).every(([name, value]) => row[name as keyof typeof row] === value),
          )
          .slice(0, options.limit ?? documents.length),
        options.batchSize,
      ),
  };
  return {
    ...original,
    MongoClient: boundary.wrap(
      class {
        // The driver settles its options when a client is made, and the adapter reads them.
        readonly options = {};
        on() {
          return this;
        }
        async connect() {
          return this;
        }
        async close() {}
        db() {
          return {
            listCollections: (filter: { name?: string }) =>
              new Cursor(
                (!filter.name || filter.name === 'items'
                  ? [{ name: 'items', type: 'collection' }]
                  : []) as unknown as typeof documents,
              ),
            collection: () => collection,
          };
        }
      },
    ),
  };
}

/** Where the fixture's client pretends to be, with a password made up for each run. */
export function mongoContractContext() {
  return {
    connection: SourceConnection.parse({
      kind: 'mongodb',
      address: 'host',
      host: '127.0.0.1',
      port: 27017,
      database: 'fixture',
      auth: 'none',
    }),
    secrets: { password: crypto.randomUUID() },
    timeoutMs: 1000,
  };
}

export const MONGO_CONTRACT_SELECT = { kind: 'object' as const, object: { schema: null, name: 'items' } };
