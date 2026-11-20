import { z } from 'zod';
import { DatabaseId, Name } from './data/fields.js';

/**
 * Importing a whole Airtable base through Airtable's Web API.
 *
 * The person pastes a personal access token with the `data.records:read` and `schema.bases:read`
 * scopes.  `POST /api/imports/airtable/bases` lists the bases it can see, and
 * `POST /api/imports/airtable` starts a job that creates one database with every table, field,
 * record, link, file, and view that can come across.  The token is sealed with the instance key
 * while the job runs, never logged, and wiped when the job ends, however it ends.
 *
 * - `GET /api/imports/airtable`: the person's recent imports, newest first.
 * - `GET /api/imports/airtable/:jobId`: one import.  With `?since=<version>` the answer waits,
 *   up to about 20 seconds, for the import to move past that version.
 * - `POST /api/imports/airtable/:jobId/cancel`: stops a queued or running import.  What it made
 *   so far goes to the trash.
 * - `GET /api/databases/:databaseId/imports/airtable`: the imports that made a database, with
 *   their reports, for anyone who can read it.
 */
export const AIRTABLE_TOKEN_SCOPES = ['data.records:read', 'schema.bases:read'] as const;

export const AIRTABLE_IMPORT_LIMITS = {
  tokenLength: 512,
  /** The largest file one attachment may be */
  fileBytes: 1024 ** 3,
  /** Files one import downloads in all */
  totalFileBytes: 50 * 1024 ** 3,
  /**
   * Airtable doesn't share views' filters and sorts, so they're worked out from the records each
   * view shows.  Larger tables skip that, since it reads every view's records.
   */
  inferenceRecords: 5_000,
  /** Bases the list shows at most */
  bases: 1_000,
  /** Recent imports `GET /api/imports/airtable` answers */
  recent: 10,
} as const;

export const AirtableBaseId = z.string().regex(/^app[A-Za-z0-9]{14}$/);
/** A token as pasted: printable characters, no spaces */
export const AirtableToken = z
  .string()
  .trim()
  .min(1)
  .max(AIRTABLE_IMPORT_LIMITS.tokenLength)
  .regex(/^[\x21-\x7e]+$/);
export const AirtableImportId = z.string().regex(/^job[0-9A-Za-z]{14}$/);

export const AirtableBasesRequest = z.object({ token: AirtableToken }).strict();
export type AirtableBasesRequest = z.infer<typeof AirtableBasesRequest>;

export const AirtableBase = z.object({
  id: AirtableBaseId,
  name: z.string(),
  /** Airtable's own level: `none`, `read`, `comment`, `edit`, or `create` */
  permissionLevel: z.string(),
  workspace: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type AirtableBase = z.infer<typeof AirtableBase>;

export const AirtableBases = z.object({ bases: z.array(AirtableBase) });
export type AirtableBases = z.infer<typeof AirtableBases>;

export const AirtableImportRequest = z
  .object({
    token: AirtableToken,
    baseId: AirtableBaseId,
    /** The new database's name, or the base's own name when left out */
    name: Name.optional(),
    /** A name for the grid view a table gets when it had none, in the person's language */
    viewName: Name.optional(),
  })
  .strict();
export type AirtableImportRequest = z.infer<typeof AirtableImportRequest>;

export const AIRTABLE_IMPORT_STATES = ['queued', 'running', 'finished', 'failed', 'canceled'] as const;
export type AirtableImportState = (typeof AIRTABLE_IMPORT_STATES)[number];

/** Whether an import has ended, one way or another. */
export function isImportDone(state: AirtableImportState): boolean {
  return state === 'finished' || state === 'failed' || state === 'canceled';
}

/**
 * What a running import is doing: reading the schema and making tables and fields, bringing
 * records and their files across, linking records, turning on formulas, lookups, rollups, and
 * counts, setting up views, and writing the report.
 */
export const AIRTABLE_IMPORT_PHASES = ['schema', 'records', 'links', 'fields', 'views', 'report'] as const;
export type AirtableImportPhase = (typeof AIRTABLE_IMPORT_PHASES)[number];

export const AirtableImportProgress = z.object({
  phase: z.enum(AIRTABLE_IMPORT_PHASES).nullable(),
  tables: z.number().int().min(0),
  /** Tables whose records are all in */
  tablesDone: z.number().int().min(0),
  records: z.number().int().min(0),
  files: z.number().int().min(0),
  /** The table being read now, by its name in Airtable */
  table: z.string().nullable(),
});
export type AirtableImportProgress = z.infer<typeof AirtableImportProgress>;

const Params = z.record(z.string(), z.union([z.string(), z.number()]));

/**
 * One line of an import's report.  `exact` came across as it was, `changed` came across
 * differently, and `omitted` was left out.  `messageKey` (an `import.airtable.report.` key) says
 * how, with `params`, and `detail` can carry a further server message, such as why a formula
 * didn't fit.  `table` and `name` are names as they are in Riosoma, or in Airtable for what was
 * left out.
 */
export const AirtableReportItem = z.object({
  status: z.enum(['exact', 'changed', 'omitted']),
  subject: z.enum(['base', 'table', 'field', 'view', 'records', 'files']),
  table: z.string().nullable(),
  name: z.string().nullable(),
  messageKey: z.string(),
  params: Params.default({}),
  detail: z.object({ messageKey: z.string(), params: Params.default({}) }).optional(),
});
export type AirtableReportItem = z.infer<typeof AirtableReportItem>;

/** What came across exactly, what changed, and what was left out, kept with the database. */
export const AirtableReport = z.object({
  tables: z.number().int().min(0),
  fields: z.number().int().min(0),
  records: z.number().int().min(0),
  views: z.number().int().min(0),
  files: z.number().int().min(0),
  items: z.array(AirtableReportItem),
});
export type AirtableReport = z.infer<typeof AirtableReport>;

export const AirtableImport = z.object({
  id: AirtableImportId,
  baseId: AirtableBaseId,
  /** The database's name */
  name: z.string(),
  /** Set once the database exists */
  databaseId: DatabaseId.nullable(),
  state: z.enum(AIRTABLE_IMPORT_STATES),
  progress: AirtableImportProgress,
  /** Goes up with every change, for `?since=` */
  version: z.number().int().min(0),
  /** Why a failed import stopped, as a server message key */
  error: z.object({ messageKey: z.string(), params: Params.default({}) }).nullable(),
  /** Set once the import finishes */
  report: AirtableReport.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AirtableImport = z.infer<typeof AirtableImport>;

export const AirtableImportList = z.object({ imports: z.array(AirtableImport) });
export type AirtableImportList = z.infer<typeof AirtableImportList>;
