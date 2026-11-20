import { createRequire } from 'node:module';
import { databaseURL } from './base';

/**
 * SQL against the test database, standing in for an outside system Riosoma syncs from, or reading
 * back what the server stored.  The test kit's own driver does the talking, so this package needs
 * no database driver of its own.
 */
interface Client {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

const load = createRequire(import.meta.resolve('@riosoma/testkit'));
const { Client } = load('pg') as { Client: new (options: { connectionString: string }) => Client };

export async function sql(statements: string): Promise<void> {
  const client = new Client({ connectionString: databaseURL() });
  await client.connect();
  try {
    await client.query(statements);
  } finally {
    await client.end();
  }
}

/**
 * Reads rows from the test database, for a test that checks what the server stored rather than
 * what a page shows.  Values go as parameters, never into the text.
 */
export async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: databaseURL() });
  await client.connect();
  try {
    return (await client.query(text, values)).rows as T[];
  } finally {
    await client.end();
  }
}

/** The pieces of the test database's address a data source's connection asks for. */
export function connection() {
  const url = new URL(databaseURL());
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    // The throwaway cluster trusts every local connection, but a source always stores a password.
    password: decodeURIComponent(url.password) || 'test',
  };
}
