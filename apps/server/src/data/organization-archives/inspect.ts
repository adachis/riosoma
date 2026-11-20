import {
  ArchiveTable,
  LibraryDetails,
  DatabaseArchive,
  type OrganizationArchivePreview,
  type OrganizationManifest,
} from '@riosoma/contracts';
import { z } from 'zod';
import { query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import {
  type ArchiveDirectory,
  CATALOG_LINES,
  ENTRY_LINES,
  invalidArchive,
  jsonLines,
  parseJson,
} from './container.js';
import {
  AUTHOR_CATALOGS,
  AUTHOR_COLUMNS,
  CATALOGS,
  identityOf,
  STREAMED_CATALOGS,
  type CatalogLine,
  type DataLine,
  type Row,
} from './catalog.js';
import { outsideFindings, type CatalogRow } from './outside.js';

export interface Inspection {
  catalogs: Map<string, CatalogRow[]>;
  counts: Record<string, number>;
  /** Every place a credential was taken out, which a secret line must name to be accepted */
  places: Set<string>;
}

const OrganizationDatabase = DatabaseArchive.extend({ tables: z.array(ArchiveTable) });
const Omitted = z.array(z.array(z.string().min(1).max(200)).min(1).max(32)).max(10_000);
/** Clocks on two servers seldom agree exactly, so an event may be this far ahead of this one's */
const CLOCK_SKEW_MS = 5 * 60_000;

export const placeKey = (entry: string, catalog: string, identity: unknown, path: unknown): string =>
  JSON.stringify([entry, catalog, identity, path]);

export const SecretLine = z
  .object({
    entry: z.string().max(200),
    catalog: z.string().max(100),
    identity: z.record(z.string(), z.unknown()),
    path: z.array(z.string().min(1).max(200)).min(1).max(32),
    context: z.string().max(500).nullable(),
    sealed: z
      .string()
      .startsWith('rio1.')
      .max(16 * 1024 * 1024),
  })
  .strict();
export type SecretLine = z.infer<typeof SecretLine>;

/** Each catalog's columns on this server, which every row an archive brings must keep to */
export type CatalogColumns = ReadonlyMap<string, ReadonlySet<string>>;

export async function catalogColumns(db: Queryable, schemas: DataSchemas): Promise<CatalogColumns> {
  const tables = CATALOGS.filter((name) => name !== 'events');
  const result = await query<{ catalog: string; column: string }>(
    db,
    sql`SELECT CASE WHEN table_schema = ${schemas.audit} THEN 'events' ELSE table_name END AS catalog,
      column_name AS column FROM information_schema.columns
    WHERE (table_schema = ${schemas.app} AND table_name = ANY(${tables}::text[]))
      OR (table_schema = ${schemas.audit} AND table_name = 'events')`,
  );
  const columns = new Map<string, Set<string>>();
  for (const { catalog, column } of result.rows) {
    const known = columns.get(catalog) ?? new Set<string>();
    known.add(column);
    columns.set(catalog, known);
  }
  return columns;
}

/**
 * Validation reads the whole upload before the preview can be confirmed, so an archive the
 * preview approves can import: every line parses, nothing nests too deeply, every catalog row has
 * only its table's columns, every template is a database archive, the names shown are the names
 * written, and no event claims to come from the future.
 */
export async function inspect(
  directory: ArchiveDirectory,
  summary: OrganizationManifest,
  columns: CatalogColumns,
  now = new Date(),
): Promise<Inspection> {
  const catalogs = new Map<string, CatalogRow[]>();
  const places = new Set<string>();
  const counts: Record<string, number> = {
    databases: 0,
    people: summary.people.length,
    records: 0,
    files: 0,
  };
  const records = new Set<string>();
  const links = new Set<string>();
  const entries = [
    'organization.jsonl',
    ...summary.databases.map((database) => `databases/${database.id}.jsonl`),
  ];
  for (const name of entries) {
    let first = true;
    // Catalog lines are held to less than records, and the organization's entry is only catalogs.
    const limits = name === 'organization.jsonl' ? CATALOG_LINES : ENTRY_LINES;
    for await (const item of jsonLines(directory.read(name), limits)) {
      const value = item as CatalogLine | DataLine | { kind: 'archive'; archive: unknown };
      if (!value || typeof value !== 'object') throw invalidArchive();
      if (first && name.startsWith('databases/')) {
        if (value.kind !== 'archive') throw invalidArchive();
        const parsed = OrganizationDatabase.safeParse(value.archive);
        if (!parsed.success || `databases/${parsed.data.database.id}.jsonl` !== name) throw invalidArchive();
        first = false;
        continue;
      }
      first = false;
      if (value.kind === 'catalog') {
        if (!CATALOGS.includes(value.catalog) || !value.row || typeof value.row !== 'object')
          throw invalidArchive();
        const row = value.row;
        // A row restores only into its own table's columns, so any other is planted.
        const known = columns.get(value.catalog);
        if (!known || Object.keys(row).some((column) => !known.has(column))) throw invalidArchive();
        const omitted = Omitted.safeParse(value.omitted ?? []);
        if (!omitted.success) throw invalidArchive();
        if ('org_id' in row && row.org_id !== summary.organization.id) throw invalidArchive();
        if (value.catalog === 'orgs' && row.id !== summary.organization.id) throw invalidArchive();
        // The name the preview shows is the name the import writes.
        if (value.catalog === 'orgs' && row.name !== summary.organization.name) throw invalidArchive();
        if (value.catalog === 'events') {
          if (!summary.audit || typeof row.action !== 'string') throw invalidArchive();
          const at = new Date(String(row.at));
          if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + CLOCK_SKEW_MS)
            throw invalidArchive();
        }
        // An authorship row names a column that someone's acceptance fills in, so it must be one
        // its catalog has.
        if (
          value.catalog === 'organization_import_authors' &&
          (!AUTHOR_CATALOGS.has(String(row.catalog)) ||
            !AUTHOR_COLUMNS.has(String(row.author_column)) ||
            row.key_column !== (row.catalog === 'field_permissions' ? 'field_id' : 'id') ||
            !columns.get(String(row.catalog))?.has(String(row.author_column)) ||
            !columns.get(String(row.catalog))?.has(String(row.key_column)))
        )
          throw invalidArchive();
        for (const path of omitted.data) places.add(placeKey(name, value.catalog, identityOf(row), path));
        if (value.catalog === 'knowledge_documents') {
          if (
            !z.string().trim().min(1).max(500000).safeParse(row.source_text).success ||
            String(row.source_text).includes('\0')
          )
            throw invalidArchive();
        }
        if (!STREAMED_CATALOGS.has(value.catalog) || value.catalog === 'knowledge_documents') {
          const list = catalogs.get(value.catalog) ?? [];
          // Unused document columns must not smuggle bodies back into the preview metadata.
          const metadata =
            value.catalog === 'knowledge_documents'
              ? { id: row.id, library_id: row.library_id, name: row.name, size: row.size }
              : row;
          list.push({ catalog: value.catalog, entry: name, row: metadata, omitted: omitted.data });
          catalogs.set(value.catalog, list);
        }
        counts[value.catalog] = (counts[value.catalog] ?? 0) + 1;
        if (value.catalog === 'tables') records.add(String(row.id));
        if (value.catalog === 'links') links.add(String(row.id));
      } else if (value.kind === 'records' || value.kind === 'links') {
        if (
          !(value.kind === 'records' ? records : links).has(value.table) ||
          !value.row ||
          typeof value.row !== 'object'
        )
          throw invalidArchive();
        if (value.kind === 'records') counts.records!++;
      } else throw invalidArchive();
    }
  }
  if (summary.encryption) {
    counts.secrets = 0;
    const named = new Set<string>();
    for await (const item of jsonLines(directory.read('secrets.jsonl'))) {
      const secret = SecretLine.safeParse(item);
      if (!secret.success) throw invalidArchive();
      const key = placeKey(secret.data.entry, secret.data.catalog, secret.data.identity, secret.data.path);
      // A secret belongs where a credential was taken out, and only one secret belongs there.
      if (!places.has(key) || named.has(key)) throw invalidArchive();
      named.add(key);
      counts.secrets++;
    }
  }
  if (
    catalogs.get('orgs')?.length !== 1 ||
    counts.databases !== summary.databases.length ||
    JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(summary.counts).sort())
  )
    throw invalidArchive();
  const files = new Map((catalogs.get('files') ?? []).map(({ row }) => [String(row.id), row]));
  for (const { row: database } of catalogs.get('databases') ?? [])
    if (
      !summary.databases.some(
        (item) =>
          item.id === database.id &&
          item.name === database.name &&
          item.trashed === Boolean(database.trashed_at),
      )
    )
      throw invalidArchive();
  const templateNames = new Set(
    (catalogs.get('org_templates') ?? []).map(({ row }) => `templates/${String(row.id)}.json`),
  );
  if (
    [...templateNames].some((name) => !directory.entries.has(name)) ||
    [...directory.entries.keys()].filter((name) => name.startsWith('templates/')).length !==
      templateNames.size
  )
    throw invalidArchive();
  for (const name of templateNames) await readTemplate(directory, name);
  for (const [id, file] of files) {
    const entry = directory.entries.get(`files/${id}`);
    if (summary.files && (!entry || entry.sha256 !== file.sha256 || entry.size !== Number(file.size)))
      throw invalidArchive();
    if (!summary.files && entry) throw invalidArchive();
  }
  if (
    [...directory.entries.keys()].filter((name) => name.startsWith('files/')).length !==
    (summary.files ? files.size : 0)
  )
    throw invalidArchive();
  const people = new Set(summary.people.map((person) => person.id));
  if (
    people.size !== summary.people.length ||
    new Set(summary.people.map((person) => person.email.toLowerCase())).size !== people.size
  )
    throw invalidArchive();
  const libraryIds = new Set<string>();
  const scopes = new Set<string>();
  for (const { row } of catalogs.get('knowledge_libraries') ?? []) {
    if (
      !z.string().uuid().safeParse(row.id).success ||
      !LibraryDetails.safeParse(row).success ||
      typeof row.target !== 'string' ||
      libraryIds.has(String(row.id))
    )
      throw invalidArchive();
    const target = row.target;
    const valid =
      row.scope === 'organization'
        ? target === summary.organization.id
        : row.scope === 'personal'
          ? people.has(target)
          : row.scope === 'unit'
            ? (catalogs.get('org_units') ?? []).some((item) => item.row.id === target)
            : row.scope === 'database'
              ? summary.databases.some((item) => item.id === target)
              : false;
    const scope = JSON.stringify([row.scope, target]);
    if (
      !valid ||
      scopes.has(scope) ||
      (!['organization', 'personal'].includes(String(row.scope)) && row.guidance)
    )
      throw invalidArchive();
    scopes.add(scope);
    libraryIds.add(String(row.id));
  }
  const documentIds = new Set<string>();
  for (const { row } of catalogs.get('knowledge_documents') ?? []) {
    if (
      !z.string().uuid().safeParse(row.id).success ||
      documentIds.has(String(row.id)) ||
      !libraryIds.has(String(row.library_id)) ||
      !z.string().min(1).max(200).safeParse(row.name).success ||
      !z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024)
        .safeParse(row.size).success
    )
      throw invalidArchive();
    documentIds.add(String(row.id));
  }
  return { catalogs, counts, places };
}

/** A saved template, which must be a database archive of bounded size and depth */
export async function readTemplate(directory: ArchiveDirectory, name: string): Promise<DatabaseArchive> {
  const parsed = DatabaseArchive.safeParse(parseJson(await directory.bytes(name)));
  if (!parsed.success) throw invalidArchive();
  return parsed.data;
}

/**
 * What the owner reviews before confirming: who will be invited and how, and everything that
 * reaches outside the organization, which comes in off.  Credentials count as coming back only
 * when the archive carries them, and then only with its passphrase.
 */
export function previewOf(
  inspection: Inspection,
  summary: OrganizationManifest,
  ownerEmail: string,
): OrganizationArchivePreview {
  return {
    people: summary.people.map((person) => ({
      name: person.name,
      email: person.email,
      invitedAs: person.kind === 'guest' ? 'guest' : 'member',
      importingOwner: person.email.toLowerCase() === ownerEmail.toLowerCase(),
    })),
    outside: outsideFindings(inspection.catalogs, () => Boolean(summary.encryption)).map(
      ({ kind, name, databaseName, destinations, needsSecret }) => ({
        kind,
        name,
        databaseName,
        destinations,
        needsSecret,
      }),
    ),
  };
}

export type { Row };
