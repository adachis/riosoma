import { z } from 'zod';
import { DatabaseRole } from './data/schema.js';

export const SqlSettings = z.object({
  roles: z.array(DatabaseRole).max(5).default(['owner']),
  timeoutMs: z.number().int().min(10).max(120_000).default(15_000),
  rowCap: z.number().int().min(1).max(100_000).default(10_000),
});
export type SqlSettings = z.infer<typeof SqlSettings>;
export const SqlRunRequest = z.object({
  id: z.string().uuid(),
  query: z.string().min(1).max(100_000),
});
export type SqlRunRequest = z.infer<typeof SqlRunRequest>;
export interface SqlCatalogTable {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string }>;
}
export interface SqlResult {
  id: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  capped: boolean;
}
export interface SqlHistory {
  id: string;
  query: string;
  rowCount: number;
  durationMs: number;
  error: string | null;
  createdAt: string;
}
export interface SqlAccess {
  allowed: boolean;
  admin: boolean;
  settings: SqlSettings;
  tables: SqlCatalogTable[];
  /**
   * For admins: the PostgreSQL role queries run as, which reads only the data schema, and the SQL
   * a database administrator runs to add it while it isn't in use
   */
  queryRole?: { role: string; active: boolean; sql: string | null; reason?: SqlSetupIssue };
}
export type SqlSetupIssue =
  | 'sql.setup.publicCreate'
  | 'sql.setup.publicDefaults'
  | 'sql.setup.preparedTransactions'
  | 'sql.setup.outsideLogins';
export interface SqlLogin {
  enabled: boolean;
  ready: boolean;
  personId: string | null;
  role: string;
  schema: string;
  sql?: string;
  reason?: SqlSetupIssue;
  password?: string;
}
