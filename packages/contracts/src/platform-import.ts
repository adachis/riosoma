import { IMPORT_PLATFORMS } from './import-platforms.js';
import { z } from 'zod';
import {
  AIRTABLE_IMPORT_STATES,
  AirtableImportId,
  AirtableImportProgress,
  AirtableReport,
  AirtableReportItem,
} from './airtable-import.js';
import { DatabaseId, FIELD_TYPES, LIMITS, Name } from './data/fields.js';

/**
 * Importing a whole base from NocoDB or Teable, a database from Baserow, a document from Grist, or
 * a base from SeaTable, lists from ClickUp, projects from Asana, a database from Notion, or a board
 * from monday.com, or a sheet from Smartsheet, through each tool's API, from a server someone runs themselves or
 * from the tool's hosted service.  It works the way importing from Airtable does: the person gives
 * the tool's address and a token, `POST /api/imports/:platform/bases` lists what the token can see,
 * and `POST /api/imports/:platform` starts a job that makes one database with every table, field,
 * record, link, file, and view that can come across, and a report of what changed.  The token is
 * sealed with the instance key while the job runs, never logged, and wiped when the job ends,
 * however it ends.
 *
 * Addresses follow the private-network rule outbound calls follow: an address on a private network
 * works only where the operator allows private hosts, and plain `http` only for addresses that rule
 * allows, since a token would otherwise cross the internet unencrypted.
 *
 * - NocoDB: an API token, sent as `xc-token`, read through the v2 meta and data APIs.
 * - Baserow: a database token reads tables, fields, rows, and files.  Views, and databases' names,
 *   are only shared with a signed-in person, so an email address and password can be given instead,
 *   which sign in once and keep only the refresh token Baserow hands back while the import runs.
 * - Grist: an API key, read through the documents, tables, columns, records, and SQL endpoints,
 *   with views from the document's own metadata tables.
 * - Teable: a personal access token, sent as a bearer, read through the base, table, field, view,
 *   and record endpoints.  A token that can list every base answers with all of them; one scoped to
 *   the bases it names lists those, through their spaces.
 * - SeaTable: an API token of one base, exchanged for the base token its own API reads with, so the
 *   list is that base alone.  Tables, columns, and views come from the base's metadata in one
 *   answer, rows a page at a time, and links from the link query, since a row's link column stops
 *   at fifty records.
 * - Smartsheet: a bearer token reads sheets, columns, rows, hierarchy, filters, and attachments.
 *   Companion field names are supplied in the caller's language.
 * - Notion: a connection token reads databases, their data sources, properties, pages, blocks,
 *   and views through the public REST API, including accessible related data sources.
 * - monday.com: a personal token reads boards, columns, groups, paginated items, subitems,
 *   and assets through GraphQL, observing request, formula-value, and complexity limits.
 *
 * - ClickUp and Asana: personal tokens read the accessible lists or projects, grouped by their
 *   workspace and space/folder or team.  Multiple selected lists or projects become tables in one
 *   database. `POST /api/imports/:platform/preview` reads their schema without creating a job.
 *
 * - `GET /api/imports/:platform`: the person's recent imports from that tool, newest first.
 * - `GET /api/imports/:platform/:importId`: one import.  With `?since=<version>` the answer waits,
 *   up to about 20 seconds, for the import to move past that version.
 * - `POST /api/imports/:platform/:importId/cancel`: stops a queued or running import.  What it made
 *   so far goes to the trash.
 * - `GET /api/databases/:databaseId/imports/:platform`: the imports from that tool that made a
 *   database, with their reports, for anyone who can read it.
 * - `GET /api/databases/:databaseId/platform-imports`: the same, from any of the tools.
 */
export { IMPORT_PLATFORMS } from './import-platforms.js';
export const ImportPlatform = z.enum(IMPORT_PLATFORMS);
export type ImportPlatform = z.infer<typeof ImportPlatform>;

/** Names for fields synthesized from task properties, supplied in the person's language. */
export const TASK_IMPORT_FIELDS = [
  'name',
  'description',
  'status',
  'assignees',
  'followers',
  'customFields',
  'start',
  'due',
  'created',
  'updated',
  'completed',
  'completedAt',
  'priority',
  'tags',
  'estimate',
  'spent',
  'parent',
  'dependencies',
  'dependents',
  'relationships',
  'attachments',
  'section',
  'projects',
  'url',
  'taskType',
  'archived',
] as const;
export type TaskImportField = (typeof TASK_IMPORT_FIELDS)[number];

/** Localized names for synthesized fields across database and task imports. */
export const PLATFORM_IMPORT_FIELDS = [
  ...TASK_IMPORT_FIELDS,
  'body',
  'group',
  'children',
  'attachmentName',
  'attachmentParent',
  'predecessorDetails',
] as const;

/** Each tool's own name, which stays the same in every language */
export const PLATFORM_NAMES: Readonly<Record<ImportPlatform, string>> = {
  nocodb: 'NocoDB',
  baserow: 'Baserow',
  grist: 'Grist',
  teable: 'Teable',
  seatable: 'SeaTable',
  clickup: 'ClickUp',
  asana: 'Asana',
  notion: 'Notion',
  monday: 'monday.com',
  smartsheet: 'Smartsheet',
};

/** Where each tool's hosted service answers, for people who don't run their own */
export const PLATFORM_CLOUD_URLS: Readonly<Record<ImportPlatform, string>> = {
  nocodb: 'https://app.nocodb.com',
  baserow: 'https://api.baserow.io',
  grist: 'https://docs.getgrist.com',
  teable: 'https://app.teable.io',
  seatable: 'https://cloud.seatable.io',
  clickup: 'https://api.clickup.com',
  asana: 'https://app.asana.com',
  notion: 'https://api.notion.com',
  monday: 'https://api.monday.com',
  smartsheet: 'https://api.smartsheet.com/2.0',
};

export const SMARTSHEET_REGIONS = {
  us: 'https://api.smartsheet.com/2.0',
  eu: 'https://api.smartsheet.eu/2.0',
  au: 'https://api.smartsheet.au/2.0',
} as const;

export const PLATFORM_IMPORT_LIMITS = {
  tokenLength: 2_048,
  passwordLength: 256,
  /** The largest file one attachment may be */
  fileBytes: 1024 ** 3,
  /** Files one import downloads in all */
  totalFileBytes: 50 * 1024 ** 3,
  /** Bases or documents the list shows at most */
  bases: 1_000,
  /** Recent imports `GET /api/imports/:platform` answers */
  recent: 10,
} as const;

/**
 * What's wrong with an address, or null when it can be used: an `http` or `https` address with a
 * host, and no name or password in it.
 */
export function platformAddressProblem(value: string): 'invalid' | 'credentials' | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'invalid';
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return 'invalid';
  if (url.username || url.password) return 'credentials';
  return null;
}

/**
 * An address as the server keeps it: no query, no fragment, and no slash at the end, so
 * `https://example.com/grist/` and `https://example.com/grist` are the same address.
 */
export function platformAddress(value: string): string {
  const url = new URL(value.trim());
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

export const PlatformAddress = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.urlLength)
  .refine((value) => platformAddressProblem(value) === null, { message: 'invalid address' });

/** A token or key as pasted: printable characters, no spaces */
export const PlatformToken = z
  .string()
  .trim()
  .min(1)
  .max(PLATFORM_IMPORT_LIMITS.tokenLength)
  .regex(/^[\x21-\x7e]+$/);

export const PlatformEmail = z
  .string()
  .trim()
  .min(3)
  .max(LIMITS.emailLength)
  .regex(/^[^\s@]+@[^\s@]+$/);
export const PlatformPassword = z.string().min(1).max(PLATFORM_IMPORT_LIMITS.passwordLength);

/** A base, database, or document, by the tool's own ID for it */
export const PlatformBaseId = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/);

const Credentials = {
  address: PlatformAddress,
  /**
   * NocoDB's API token, Baserow's database token, Grist's API key, Teable's personal access token,
   * or SeaTable's API token for one base
   */
  token: PlatformToken.optional(),
  /** Baserow only, in place of a token: signs in to read views and databases' names too */
  email: PlatformEmail.optional(),
  password: PlatformPassword.optional(),
};

/** A token, or for Baserow an email address and password, but never both or neither. */
function oneWayIn(value: {
  token?: string | undefined;
  email?: string | undefined;
  password?: string | undefined;
}) {
  return value.token !== undefined
    ? value.email === undefined && value.password === undefined
    : value.email !== undefined && value.password !== undefined;
}

export const PlatformBasesRequest = z
  .object(Credentials)
  .strict()
  .refine(oneWayIn, { message: 'a token, or an email address and password', path: ['token'] });
export type PlatformBasesRequest = z.infer<typeof PlatformBasesRequest>;

export const PlatformBase = z.object({
  id: PlatformBaseId,
  name: z.string(),
  /** Where it lives in the tool, like a workspace's name, when the tool says */
  group: z.string().nullable(),
});
export type PlatformBase = z.infer<typeof PlatformBase>;

export const PlatformBases = z.object({ bases: z.array(PlatformBase) });
export type PlatformBases = z.infer<typeof PlatformBases>;

export const PlatformImportRequest = z
  .object({
    ...Credentials,
    baseId: PlatformBaseId,
    /** Additional ClickUp lists or Asana projects to import as tables in the same database. */
    additionalBaseIds: z
      .array(PlatformBaseId)
      .max(PLATFORM_IMPORT_LIMITS.bases - 1)
      .optional(),
    fieldNames: z.partialRecord(z.enum(PLATFORM_IMPORT_FIELDS), Name).optional(),
    /** The new database's name, or the base's own name when left out */
    name: Name.optional(),
    /** A name for the grid view a table gets when it had none, in the person's language */
    viewName: Name.optional(),
  })
  .strict()
  .refine(oneWayIn, { message: 'a token, or an email address and password', path: ['token'] });
export type PlatformImportRequest = z.infer<typeof PlatformImportRequest>;

/** Companion fields need names in the caller's language before a sheet can be previewed or imported. */
export const SmartsheetImportRequest = PlatformImportRequest.refine(
  (request) =>
    ['parent', 'attachments', 'attachmentName', 'attachmentParent', 'predecessorDetails'].every(
      (name) => request.fieldNames?.[name as keyof NonNullable<PlatformImportRequest['fieldNames']>],
    ),
  { path: ['fieldNames'] },
);

/** A schema preview reads source tables and fields and creates no database or import job. */
export const PlatformPreview = z.object({
  tables: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      fields: z.array(z.object({ name: z.string(), type: z.enum(FIELD_TYPES) })),
      views: z.number().int().min(0),
    }),
  ),
  notes: z.array(AirtableReportItem),
});
export type PlatformPreview = z.infer<typeof PlatformPreview>;

/**
 * The report has the shape an Airtable import's has.  Its lines' message keys start with
 * `import.platform.report.`, and read with the tool's name as `{product}`.
 */
export const PlatformReport = AirtableReport;
export type PlatformReport = AirtableReport;

export const PlatformImport = z.object({
  id: AirtableImportId,
  platform: ImportPlatform,
  /** The tool's address, as the server keeps it */
  address: z.string(),
  baseId: PlatformBaseId,
  /** The database's name */
  name: z.string(),
  /** Set once the database exists */
  databaseId: DatabaseId.nullable(),
  state: z.enum(AIRTABLE_IMPORT_STATES),
  progress: AirtableImportProgress,
  /** Goes up with every change, for `?since=` */
  version: z.number().int().min(0),
  /** Why a failed import stopped, as a server message key */
  error: z
    .object({
      messageKey: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    })
    .nullable(),
  /** Set once the import finishes */
  report: PlatformReport.nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type PlatformImport = z.infer<typeof PlatformImport>;

export const PlatformImportList = z.object({ imports: z.array(PlatformImport) });
export type PlatformImportList = z.infer<typeof PlatformImportList>;
