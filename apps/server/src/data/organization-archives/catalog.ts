import { randomBytes } from 'node:crypto';
import { AppError } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { seal, unseal } from '../../secrets.js';
import { sealCredential, unsealCredential } from '../../credentials/service.js';

export type Row = Record<string, unknown>;

/**
 * How an import brings a catalog back.  `rows` inserts each row, in the plan's order, after the
 * catalogs it refers to.  `streamed` reads the catalog's lines again at the end, one at a time, so
 * memory stays bounded however many there are.  `review` inserts nothing: each row becomes an item
 * on the review list, which makes it anew when the owner turns it on.  `own` is restored by a step
 * of its own in the import, which `OWN_STEPS` there names.
 */
export type Restore = 'rows' | 'streamed' | 'review' | 'own';

export interface CatalogPlan {
  catalog: string;
  /** The archive entry it's written to: the organization's, each database's, or both */
  entry: 'organization' | 'database' | 'both';
  restore: Restore;
}

/**
 * Every catalog an archive carries, in the order an import restores them.  The export writes these
 * and nothing else, and the import restores each one as it says, so a catalog can't travel without
 * a way back.  Sign-in providers and AI provider keys stay behind: an import never restores
 * sign-in, security, or AI provider settings, so an archive has no reason to carry their
 * credentials.
 */
export const CATALOG_PLAN: readonly CatalogPlan[] = [
  // Classification definitions and retention travel with the organization, assignments and holds with their resources.
  // Organization logo bytes travel inside settings, receive fresh storage keys, and are sanitized again on import.
  { catalog: 'orgs', entry: 'organization', restore: 'own' },
  { catalog: 'org_units', entry: 'organization', restore: 'rows' },
  // Folder paths and parents travel together, with ownership assigned to the importing owner.
  { catalog: 'folders', entry: 'organization', restore: 'rows' },
  { catalog: 'groups', entry: 'organization', restore: 'rows' },
  { catalog: 'sources', entry: 'organization', restore: 'rows' },
  { catalog: 'oauth_apps', entry: 'organization', restore: 'rows' },
  { catalog: 'oauth_clients', entry: 'organization', restore: 'rows' },
  { catalog: 'ai_settings', entry: 'organization', restore: 'rows' },
  { catalog: 'databases', entry: 'database', restore: 'rows' },
  { catalog: 'named_functions', entry: 'database', restore: 'rows' },
  { catalog: 'folder_databases', entry: 'organization', restore: 'rows' },
  { catalog: 'tables', entry: 'database', restore: 'rows' },
  { catalog: 'fields', entry: 'database', restore: 'rows' },
  { catalog: 'views', entry: 'database', restore: 'rows' },
  { catalog: 'links', entry: 'database', restore: 'rows' },
  { catalog: 'table_sources', entry: 'database', restore: 'rows' },
  { catalog: 'field_permissions', entry: 'database', restore: 'rows' },
  { catalog: 'record_rules', entry: 'database', restore: 'rows' },
  { catalog: 'record_locks', entry: 'database', restore: 'rows' },
  { catalog: 'dashboards', entry: 'database', restore: 'rows' },
  { catalog: 'automations', entry: 'database', restore: 'rows' },
  { catalog: 'interfaces', entry: 'database', restore: 'rows' },
  { catalog: 'scripts', entry: 'database', restore: 'rows' },
  // Folder grants travel with the organization, and database grants with each database.
  { catalog: 'grants', entry: 'both', restore: 'rows' },
  { catalog: 'webhooks', entry: 'database', restore: 'rows' },
  { catalog: 'booking_pages', entry: 'database', restore: 'rows' },
  // What a form or booking page charges, and the managed result fields it fills.  They follow
  // their form view or booking page through the import's ID map.  A page that charges comes in
  // refusing answers until the organization connects Stripe again, and never takes them free.
  { catalog: 'payment_fields', entry: 'database', restore: 'rows' },
  { catalog: 'payment_pages', entry: 'database', restore: 'rows' },
  { catalog: 'sql_settings', entry: 'database', restore: 'rows' },
  { catalog: 'organization_import_authors', entry: 'organization', restore: 'rows' },
  { catalog: 'group_members', entry: 'organization', restore: 'own' },
  { catalog: 'files', entry: 'database', restore: 'own' },
  { catalog: 'org_templates', entry: 'organization', restore: 'own' },
  { catalog: 'comments', entry: 'database', restore: 'streamed' },
  { catalog: 'record_positions', entry: 'database', restore: 'streamed' },
  // The audit log, only when the export asks for it
  { catalog: 'events', entry: 'organization', restore: 'streamed' },
  { catalog: 'shared_views', entry: 'database', restore: 'review' },
  { catalog: 'public_forms', entry: 'database', restore: 'review' },
  { catalog: 'knowledge_libraries', entry: 'organization', restore: 'review' },
  { catalog: 'knowledge_documents', entry: 'organization', restore: 'review' },
];

const planned = (test: (plan: CatalogPlan) => boolean) =>
  CATALOG_PLAN.filter(test).map((plan) => plan.catalog);
/** The catalogs written to the organization's entry */
export const ORG_CATALOGS: readonly string[] = planned((plan) => plan.entry !== 'database');
/** The catalogs written to each database's entry */
export const DATABASE_CATALOGS: readonly string[] = planned((plan) => plan.entry !== 'organization');
export const CATALOGS: readonly string[] = CATALOG_PLAN.map((plan) => plan.catalog);
/** Catalogs an import reads line by line at the end instead of holding them */
export const STREAMED_CATALOGS: ReadonlySet<string> = new Set([
  ...planned((plan) => plan.restore === 'streamed'),
  'knowledge_documents',
]);
/** Links and forms receive new addresses from the review list */
export const REVIEW_ONLY_CATALOGS: ReadonlySet<string> = new Set(
  planned((plan) => plan.restore === 'review'),
);

/** Every deliberate exclusion, with its reason.  Every other table in the app schema is in the plan. */
export const LEFT_OUT: Readonly<Record<string, string>> = {
  ingest_live_requests: 'Pending ingest actions belong to the original files, people, and command history',
  ingest_original_deletions: 'Original storage cleanup belongs to the installation that owns the bytes',
  ingest_pipeline_jobs:
    'Pipeline evidence, retry identities, and notification history belong to the original files',
  ingest_senders: 'Sender approvals require fresh table setup in the destination organization',
  ingest_formats: 'Reading formats depend on local setup, senders, and examples',
  ingest_files: 'Incoming files and worker leases belong to the original table',
  ingest_examples: 'Gold pairs refer to original arrivals and reading formats',
  ingest_drafts: 'Draft rows and spot checks refer to original arrivals, formats, and people',
  ingest_studies: 'Study evidence and draft checkpoints belong to the original files and people',
  ingest_builds: 'Build drafts, outcomes, and costs belong to the original examples and people',
  ingest_row_state: 'Written value hashes and identities belong to the original records',
  ingest_write_batches: 'Ingest retry checkpoints belong to the original files and command history',

  ingest_questions:
    'Incoming questions refer to the original files and are raised again when those files are read',
  ingest_answers: 'Incoming answer history belongs to the original files and their questions',
  ingest_rules:
    'Incoming file rules depend on the original approved senders and formats and require fresh table setup',
  remote_servers: 'Remote connections and credentials require fresh administrator setup',
  remote_actions: 'Remote connection undo history belongs to the original organization',
  remote_calls: 'Remote approvals and results belong to the original person and session',
  home_shortcuts: 'Home aliases stay with their original owners and target access',
  home_tags: 'Shared and private home labels stay with their original organization',
  home_tag_links: 'Label assignments follow the local home labels',
  home_tag_colors: 'The home palette is configured by the destination organization',
  credential_policies: 'Credential storage settings belong to this installation',
  credential_keys: 'Wrapping keys never travel',
  credential_jobs: 'Credential maintenance reports belong to this installation',
  sync_runs: 'Sync execution history belongs to the original sources and expires locally',
  sync_record_changes: 'Source value history follows its local sync run retention',
  outbound_syncs: 'Outbound syncs hold credentials for outside systems and are set up again by their owners',
  outbound_sync_rows: 'Outbound sync row maps describe one outside table and are rebuilt by the next sync',
  outbound_sync_runs: 'Outbound sync history is not restored',
  memberships: 'People travel in the manifest and join through fresh invitations',
  invitations: 'Pending people travel in the manifest, and invitation credentials never travel',
  invitation_grants:
    'Pending shares require fresh invitations and item access in the destination organization',
  users: 'People travel in the manifest, and sign-in credentials never travel',
  sessions: 'Sessions never travel',
  login_tokens: 'Sign-in credentials never travel',
  password_reset_latest_requests: 'Password reset request ordering is local to the server',
  auth_attempts: 'Sign-in throttling is local to the server',
  api_tokens: 'Personal access credentials never travel',
  passkeys: 'Sign-in and security settings are not restored',
  authenticator_secrets: 'Sign-in credentials never travel',
  recovery_codes: 'Sign-in credentials never travel',
  mfa_spent: 'Sign-in challenges are local to the server',
  sso_providers: 'Sign-in and security settings are not restored',
  sso_identities: 'Sign-in and security settings are not restored',
  saml_assertions: 'Sign-in challenges are local to the server',
  sso_domain_verifications: 'A domain must be verified again on the new server',
  scim_settings: 'Provisioning must be configured again on the new server',
  scim_tokens: 'Provisioning credentials never travel',
  scim_users: 'Directory identities must be linked again on the new server',
  scim_groups: 'Directory identities must be linked again on the new server',
  scim_unit_mappings: 'Provisioning must be configured again on the new server',
  org_unit_admins:
    "Each person's unit admin roles travel in the manifest and return when they accept their invitation",
  knowledge_chunks:
    'Derived passages and vectors are rebuilt from the extracted document sources carried in the archive',
  knowledge_settings: 'Search and embedding connections require fresh configuration',
  memories: 'Private and shared notes stay in their original organization and database',
  'knowledge_libraries:personal': 'Private and shared notes stay in their original organization and database',
  'knowledge_documents:personal': 'Private and shared notes stay in their original organization and database',
  knowledge_actions: 'Private undo history is not restored',
  knowledge_index_jobs: 'Indexing starts again from the document sources the archive carries',
  embedding_changes: 'Pending search updates are rebuilt with the index after import',
  embedding_tables: 'An administrator must enable indexing again after import',
  embeddings: 'Derived search indexes are rebuilt after import',
  ai_keys: 'Provider credentials never travel',
  ai_spend: 'Usage history belongs to the old server',
  ai_usage: 'Usage history, and the footprint estimates kept with it, belong to the old server',
  ai_field_jobs: 'Job state is not restored',
  ai_field_runs: 'Run history is not restored',
  ai_field_turns: 'Worker scheduling is rebuilt on the new server',
  rio_conversations: 'Personal conversation history is not restored',
  rio_messages: 'Personal conversation history is not restored',
  rio_active_conversations: 'Active conversations are personal and tied to sign-in sessions',
  rio_conversation_summaries: 'Personal conversation history is not restored',
  rio_plans: 'Pending changes from conversations are not restored',
  rio_routines:
    'Routines act on their own as their owner, so each owner sets them up again on the new server',
  rio_routine_runs: 'Run history is not restored',
  rio_routine_approvals: 'Changes and emails waiting for approval are not restored',
  changes: 'Change and undo history is not restored',
  record_changes: 'Change and undo history is not restored',
  // The audit log's own table for expired events lives in the audit schema, and an import re-chains
  // the events it brings in, so the places this installation freed stay behind with their hashes.
  purged: 'Expired audit chain state belongs to the installation that removed the events',
  commands: 'Command replay state is not restored',
  undo_groups: 'Undo history is not restored',
  column_backups: 'Retired columns used only for undo are not restored',
  data_indexes: 'Query indexes are rebuilt on the new server',
  user_database_state: 'Personal favorites and recently opened databases are not restored',
  notifications: 'Notification and delivery history is not restored',
  notification_preferences: 'Personal notification choices are not restored',
  notification_organizations: 'Channel policies require fresh configuration',
  notification_credentials: 'Delivery credentials never travel',
  notification_devices: 'Push subscriptions belong to the original installation',
  notification_phones: 'Phone numbers must be verified again',
  notification_actions: 'Personal notification undo history is not restored',
  notification_deliveries: 'Pending deliveries and delivery history are not restored',
  notification_alert_events: 'Alert delivery cursors belong to the original installation',
  automation_runs: 'Run history and test runs are not restored',
  calendar_removals: 'Calendar events waiting to be removed after an undo belong to the old server',
  automation_versions: 'Only the published configuration and current draft are restored',
  report_schedules: 'Personal delivery schedules must be recreated by their owners',
  report_recipients: 'Personal delivery schedules must be recreated by their owners',
  report_runs: 'Run history is not restored',
  feedback: 'Personal feedback and screenshots are not restored',
  feedback_replies: 'Personal feedback history is not restored',
  airtable_imports: 'Import jobs and their temporary credentials are not restored',
  platform_imports: 'Import jobs and their temporary credentials are not restored',
  database_snapshots: 'Historical snapshots are not restored',
  database_copies: 'Copy jobs are not restored',
  table_copies: 'Table copy jobs are not restored; copied tables travel as ordinary tables',
  organization_archives: 'Archive jobs are not restored',
  organization_archive_chunks: 'Archive job contents are not restored',
  organization_import_review: 'The review list is rebuilt from the imported settings',
  file_chunks: 'Attachment contents travel as file entries when requested',
  file_moves: 'Storage cleanup jobs belong to the old server',
  file_uploads: 'Unfinished upload jobs are not restored',
  file_upload_chunks: 'Unfinished upload contents are not restored',
  source_stage: 'Staged synchronization jobs are not restored',
  source_hooks: 'Incoming addresses are rebuilt when enabled from the review list',
  source_hook_deliveries: 'Incoming delivery history is not restored',
  source_hook_posts: 'Queued incoming posts are not restored',
  source_hook_samples: 'Temporary incoming samples are not restored',
  webhook_events: 'Queued outgoing events are not restored',
  webhook_deliveries: 'Outgoing delivery jobs are not restored',
  webhook_attempts: 'Outgoing delivery history is not restored',
  public_form_attempts: 'Public request throttling is local to the server',
  bookings: 'Booking delivery and cancellation history is not restored, but records travel',
  booking_attempts: 'Public request throttling is local to the server',
  signature_requests: 'Sent requests contain private signer data and are not reusable templates',
  signature_history: 'Signature history is not restored',
  signature_deliveries: 'Signature delivery jobs are not restored',
  signature_attempts: 'Public request throttling is local to the server',
  sql_logins: 'SQL login credentials and server roles never travel',
  sql_history: 'Query history and cached results are not restored',
  oauth_settings: 'Dynamic registration is a security setting of the new server',
  oauth_consents: 'App permissions require fresh consent on the new server',
  oauth_grants: 'App grants never travel',
  oauth_credentials: 'App tokens and authorization codes never travel',
  oauth_requests: 'Pending authorizations never travel',
  oauth_webhooks: 'Grant ownership cannot be restored without fresh consent',
  oauth_connections: 'Personal cloud drive credentials never travel',
  oauth_flows: 'Pending cloud drive authorizations never travel',
  calendar_feeds: "Each person's subscription address is private to them, so they make new ones",
  custom_domains: 'A domain must be verified again on the new server',
  published_sites: 'Public sites require a fresh publishing decision and publisher on the new server',
  stripe_connections: 'Stripe is connected again by an Integrations administrator, and its keys never travel',
  payments: 'Payments belong to the Stripe account that took them, which stays behind',
  payment_events: 'Applied webhook events belong to the Stripe account that sent them',
  payment_refusals: 'Refused webhook counts belong to the Stripe account they were for',
  schema_migrations: 'Each server records the migrations it has run',
  update_checks: 'Update checks belong to the server, which checks its own feed',
  update_runs: 'Update history belongs to the old server',
  telemetry: "Usage counts are the server owner's choice, and each server keeps its own install ID",
};
export const AUTHOR_CATALOGS = new Set([
  'databases',
  'named_functions',
  'tables',
  'fields',
  'views',
  'sources',
  'field_permissions',
  'record_rules',
  'record_locks',
  'dashboards',
  'automations',
  'interfaces',
  'scripts',
  'comments',
  'files',
  'webhooks',
  'org_templates',
]);
export const AUTHOR_COLUMNS = new Set([
  'created_by',
  'updated_by',
  'trashed_by',
  'locked_by',
  'run_as_id',
  'author_id',
  // Who published an automation's version and who last changed its draft
  'published_by',
  'draft_updated_by',
]);

export interface CatalogLine {
  kind: 'catalog';
  catalog: string;
  row: Row;
  /** Where the export took out a credential, whether or not it carried it encrypted */
  omitted?: string[][];
}
export interface DataLine {
  kind: 'records' | 'links';
  table: string;
  row: Row;
}
/** A credential found while exporting, before it's sealed with the passphrase */
export interface SecretValue {
  catalog: string;
  identity: Row;
  path: string[];
  value: unknown;
  context: string | null;
}

/**
 * An audit event as an archive carries it.  Signers are outside the organization, so where one
 * signed from, their IP address and browser, stays behind with the request they signed.
 */
export function withoutSignerVisit(event: Row): Row {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== 'object' || (metadata as Row).actorKind !== 'signer') return event;
  const kept: Row = { ...(metadata as Row) };
  delete kept.ip;
  delete kept.userAgent;
  return { ...event, metadata: kept };
}

/** Cursors bound memory independently of the number of records, comments, or audit events. */
export async function* rows(db: Queryable, select: Sql): AsyncGenerator<Row> {
  const cursor = `archive_${randomBytes(8).toString('hex')}`;
  await query(db, sql`DECLARE ${ident(cursor)} NO SCROLL CURSOR FOR ${select}`);
  try {
    for (;;) {
      const result = await query<Row>(db, sql`FETCH FORWARD 250 FROM ${ident(cursor)}`);
      for (const row of result.rows) yield row;
      if (result.rows.length < 250) break;
    }
  } finally {
    await query(db, sql`CLOSE ${ident(cursor)}`);
  }
}

function contextOf(catalog: string, row: Row, path: string[]): string | null {
  if (catalog === 'sources') return `source:${String(row.id)}`;
  if (catalog === 'webhooks') return `riosoma.webhooks.secret:${String(row.id)}`;
  if (catalog === 'oauth_apps') return `oauth-app:${String(row.org_id)}:${String(row.provider)}`;
  if (catalog === 'orgs' && path[0] === 'feedback_github_token') return `feedback.github:${String(row.id)}`;
  if (catalog === 'automations' && path[0] === 'messaging_secrets')
    return `riosoma.automations.message:${String(row.id)}:${path[1]}`;
  return null;
}

const SENSITIVE =
  /(?:password|secret|credential|authorization|(?:api|private|client)[_-]?key|authToken|webhookUrl|smtpUrl|token$)/i;
/** Names a JSON body gives its credentials, besides the ones any credential's name matches */
const SECRET_MEMBER = /^(?:api_?key|token|secret|password|sig|signature|key|access_?key)$/i;
const EPHEMERAL = new Set(['lease_token', 'held_token', 'webhook_secret_hash', 'webhook_salt']);
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const WHOLE_URL = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
/** One string member of a JSON object, as text: its name, what follows the name, and its value */
const JSON_MEMBER = /"((?:[^"\\\n]|\\.)*)"(\s*:\s*)"((?:[^"\\\n]|\\.)*)"/g;

export function identityOf(row: Row): Row {
  if (typeof row.id === 'string') return { id: row.id };
  if (typeof row.database_id === 'string' && !('table_id' in row)) return { database_id: row.database_id };
  if (typeof row.table_id === 'string') return { table_id: row.table_id };
  if (typeof row.provider_id === 'string') return { org_id: row.org_id, provider_id: row.provider_id };
  if (typeof row.provider === 'string') return { org_id: row.org_id, provider: row.provider };
  return { org_id: row.org_id };
}

/**
 * The index of the steps list a path runs through, as in `config.steps.3.url`, or -1.  An
 * automation's draft, in `draft_config`, holds steps the same way.
 */
function stepsAt(path: string[]): number {
  const root = path.findIndex(
    (part, index) =>
      (part === 'config' || part === 'draft_config') &&
      path[index + 1] === 'steps' &&
      /^\d+$/.test(path[index + 2] ?? ''),
  );
  if (root < 0) return -1;
  for (let index = path.length - 3; index > root; index--)
    if (['steps', 'then', 'otherwise'].includes(path[index]!) && /^\d+$/.test(path[index + 1]!)) return index;
  return -1;
}

function sensitiveName(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    /* A malformed escape is checked as written. */
  }
  return SENSITIVE.test(decoded);
}

/**
 * Text with the credentials in its web addresses taken out: any user name and password, and the
 * query values whose names say they could hold a key.  The text is edited as text, so `{{…}}`
 * tokens stay as they were written.
 */
export function withoutAddressSecrets(text: string): string {
  return text.replace(URL_IN_TEXT, (address) => {
    let url = address.replace(/^(https?:\/\/)[^/?#\s]*@/i, '$1');
    const query = url.indexOf('?');
    if (query < 0) return url;
    const fragment = url.indexOf('#', query);
    const end = fragment < 0 ? url.length : fragment;
    const pairs = url
      .slice(query + 1, end)
      .split('&')
      .map((pair) => {
        const equals = pair.indexOf('=');
        if (equals < 0) return pair;
        const name = pair.slice(0, equals);
        return sensitiveName(name) ? `${name}=` : pair;
      });
    url = `${url.slice(0, query + 1)}${pairs.join('&')}${url.slice(end)}`;
    return url;
  });
}

/** An address's scheme and host, which is all the review list shows of it, or nothing */
export function schemeAndHost(address: string): string {
  try {
    const url = new URL(address);
    return url.host ? `${url.protocol}//${url.host}` : '';
  } catch {
    return '';
  }
}

/** Whether an address is only a scheme and a host, with nothing that could hold a credential */
function bareAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return (
      Boolean(url.host) &&
      !url.username &&
      !url.password &&
      (url.pathname === '' || url.pathname === '/') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Where text is configuration that sends somewhere: an automation step's settings, a data
 * source's connection, and a webhook's address.  Any web address there can hold a credential
 * anywhere in it, in its path as well as its query.
 */
function sendingPlace(catalog: string, path: string[]): boolean {
  if (stepsAt(path) >= 0) return true;
  if (catalog === 'sources') return path[0] === 'connection';
  return catalog === 'webhooks' && path.length === 1 && path[0] === 'url';
}

/**
 * Sending configuration without its credentials.  A web address keeps only its scheme and host,
 * whether it's the whole text or inside it, and a JSON body's text values lose the ones whose
 * names say they're keys, tokens, signatures, or passwords.
 */
function withoutSendingSecrets(text: string): string {
  const trimmed = text.trim();
  if (WHOLE_URL.test(trimmed)) return bareAddress(trimmed) ? text : schemeAndHost(trimmed);
  return text
    .replace(URL_IN_TEXT, (address) => (bareAddress(address) ? address : schemeAndHost(address)))
    .replace(JSON_MEMBER, (member, name: string, colon: string) => {
      let decoded = name;
      try {
        decoded = JSON.parse(`"${name}"`) as string;
      } catch {
        /* A malformed escape is checked as written. */
      }
      return SECRET_MEMBER.test(decoded) || SENSITIVE.test(decoded) ? `"${name}"${colon}""` : member;
    });
}

/**
 * A row without its credentials.  Every sealed value is taken out, including sealed values added
 * by a future setting, and so is any text whose name says it's a credential.  Configuration that
 * sends somewhere counts every web address in it as a credential, keeping only its scheme and
 * host, and every JSON body value named like one.  In automation steps every header value counts
 * too.  Only text is ever a credential: a flag such as `secretSaved` stays as it is.  `found` hears
 * each credential with its value, for sealing with a passphrase, and `omitted` lists where each
 * one was, which travels in the clear so an import knows what needs entering again.
 */
export function publicRow(
  catalog: string,
  row: Row,
  key: Buffer,
  found?: (secret: SecretValue) => void,
): { row: Row; omitted: string[][] } {
  if (catalog === 'knowledge_libraries' || catalog === 'knowledge_documents') return { row, omitted: [] };
  const omitted: string[][] = [];
  const take = (path: string[], value: string, context: string | null, replacement: string | null) => {
    omitted.push(path);
    if (value.startsWith('riov.')) return replacement;
    found?.({
      catalog,
      identity: identityOf(row),
      path,
      value: context ? unseal(key, value, context) : value,
      context,
    });
    return replacement;
  };
  const walk = (value: unknown, path: string[]): unknown => {
    const name = path.at(-1) ?? '';
    if (path.length === 1 && catalog === 'shared_views' && name === 'originals_access') return false;
    if (path.length === 1 && ['tables', 'fields'].includes(catalog) && name === 'ingest') return null;
    // Client secrets must be issued again on the destination server.
    if (path.length === 1 && catalog === 'oauth_clients' && name === 'secret_hash')
      return value === null ? null : '';
    if (catalog === 'table_sources' && path.length === 1 && name === 'fetch_state') return null;
    if (EPHEMERAL.has(name)) return null;
    if (catalog === 'automations' && path.length === 1 && name === 'messaging_secrets') {
      // Each step's sealed address or token is its own credential, and a missing one is left out.
      const kept: Row = {};
      for (const [step, sealed] of Object.entries((value as Row | null) ?? {})) {
        if (typeof sealed !== 'string' || !sealed) continue;
        const context = contextOf(catalog, row, [name, step]);
        take([name, step], sealed, context, null);
      }
      return kept;
    }
    if (typeof value === 'string') {
      const steps = stepsAt(path);
      if (value.startsWith('riov.')) {
        omitted.push(path);
        return '';
      }
      if (value.startsWith('rio2.') && !found) {
        omitted.push(path);
        return '';
      }
      if (value.startsWith('rio2.'))
        throw new AppError('validation_failed', 'organizationArchive.unknownSecret');
      if (value.startsWith('rio1.')) {
        const context = contextOf(catalog, row, path);
        if (!context) throw new AppError('validation_failed', 'organizationArchive.unknownSecret');
        return take(path, value, context, '');
      }
      if (!value) return value;
      if (path.length && SENSITIVE.test(name)) return take(path, value, null, '');
      if (steps >= 0 && path[steps + 2] === 'headers' && path.length === steps + 4)
        return take(path, value, null, '');
      const cleaned = sendingPlace(catalog, path)
        ? withoutSendingSecrets(value)
        : withoutAddressSecrets(value);
      if (cleaned !== value) return take(path, value, null, cleaned);
      return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, String(index)]));
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, [...path, k])]));
    return value;
  };
  return { row: walk(row, []) as Row, omitted };
}

/** External references never leave the installation, even when an export includes credentials */
export async function credentialArchiveRow(
  catalog: string,
  row: Row,
  key: Buffer,
  orgId: string,
  importing = false,
  db?: Queryable,
): Promise<Row> {
  const walk = async (value: unknown, path: string[]): Promise<unknown> => {
    if (typeof value === 'string' && (importing ? value.startsWith('rio1.') : value.startsWith('rio2.'))) {
      const context = contextOf(catalog, row, path);
      if (!context) throw new AppError('validation_failed', 'organizationArchive.unknownSecret');
      return importing
        ? sealCredential(key, unseal(key, value, context), context, orgId, db)
        : seal(key, await unsealCredential(key, value, context, orgId, db), context);
    }
    if (Array.isArray(value))
      return Promise.all(value.map((item, index) => walk(item, [...path, String(index)])));
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value))
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([name, part]) => [name, await walk(part, [...path, name])]),
        ),
      );
    return value;
  };
  return (await walk(row, [])) as Row;
}

/** JSON with object keys in order, so two values compare equal however they were written */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Puts a restored credential back where it was taken from, sealed again for this server. */
export function applySecret(
  row: Row,
  path: string[],
  value: unknown,
  context: string | null,
  key: Buffer,
  mapText: (text: string) => string,
): void {
  if (!path.length || path.some((name) => UNSAFE_NAMES.has(name))) throw new Error('Invalid secret path');
  let target: Row = row;
  for (const name of path.slice(0, -1)) {
    const next: unknown = target[name];
    if (!next || typeof next !== 'object') throw new Error('Invalid secret path');
    target = next as Row;
  }
  if (typeof value !== 'string') throw new Error('Invalid secret value');
  target[path.at(-1)!] = context ? seal(key, value, mapText(context)) : value;
}
