import { columnRef, jsonValueExpr, selectExpr } from './physical/columns.js';
import type { RemoteAudience, LibraryScope } from '@riosoma/contracts';
import { relationalConditions } from './physical/conditional.js';
import { administersSource, requirePerson, reachablePeople } from '../org-units/store.js';
import {
  classificationAllows,
  loadClassification,
  type ClassificationTree,
  type ClassificationUse,
} from './governance.js';
import { relationalReads } from './physical/conditional.js';
import { type JoinedTable, joinedSources, isComputedType } from '@riosoma/contracts';
import {
  AppError,
  CURRENT_PERSON,
  DATABASE_ROLES,
  PUBLIC_QUESTION_TYPES,
  audienceNames,
  checkCondition,
  isDocumentKind,
  isGroup,
  isSearchSource,
  operatorsForField,
  roleAllows,
  searchFilterProblem,
  templateFieldIds,
  type DatabaseAction,
  type DatabaseRole,
  type FilterCondition,
  type FilterGroup,
  type SchemaAccess,
  type SourceKind,
  type SourceSelect,
  type ShortcutTarget,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from './context.js';
import { loadFields, loadView, relatedDatabaseIds } from './metadata.js';
import { loadDatabaseRules, type StoredFieldRules, type StoredRecordRule } from './permissions/store.js';
import { compileFilter } from './physical/filters.js';
import { expressionFieldIds, formulaExpression } from './physical/formulas.js';
import { fetchRowsById } from './physical/records.js';
import type { ReadContext, StoredField } from './types.js';
import { parse as parseFormula } from '@riosoma/formula';
import { functionCalls } from './named-functions.js';

/** A stored read never refreshes sources or changes records, and refuses unconfirmed live rules. */
export interface ReadMode {
  publicLines?: { tableId: string; fieldIds: ReadonlySet<string> };
  readOnly?: boolean;
  /** A live public form permits these answers, with a record read only after checking an edit token. */
  publicQuestions?: { tableId: string; fieldIds: ReadonlySet<string>; recordId?: string };
}

/** What `AccessScope` knows about one database once it has read its rules. */
interface Prepared {
  lineItems: ReadonlyMap<string, { parentTableId: string; parentFieldId: string; active: boolean }>;
  joined: ReadonlyMap<string, JoinedTable>;
  classification: ClassificationTree;
  databaseId: string;
  related: readonly string[];
  dataFingerprint: string;
  role: DatabaseRole | null;
  /** Owners see and change everything, whatever the rules say */
  owner: boolean;
  /** Every table of the database, trashed ones too */
  tableIds: ReadonlySet<string>;
  fieldRules: ReadonlyMap<string, StoredFieldRules>;
  /** Each table's rules that name this person, in order, and none for owners */
  applicable: ReadonlyMap<string, readonly StoredRecordRule[]>;
  /** Each table's rules, whoever they name */
  recordRules: ReadonlyMap<string, readonly StoredRecordRule[]>;
  /**
   * Fields this person can't see: restricted from them, AI fields whose prompts read records of a
   * table a record rule limits for them, or read something that can no longer be worked out while
   * any record rule limits them, and anything computed from those, transitively
   */
  hidden: ReadonlySet<string>;
  /** The database's live fields, read only when it has any rule */
  fields: ReadonlyMap<string, StoredField>;
  /**
   * The same fields and the trashed ones, which still count as what an AI field's prompt read,
   * since what they held is in the values its runs wrote
   */
  known: ReadonlyMap<string, StoredField>;
  /** Each table's primary field, by table, trashed tables too */
  primaries: ReadonlyMap<string, string | null>;
  /** For each link limited to a view, the fields that view's filter reads */
  linkLimits: ReadonlyMap<string, readonly string[]>;
  /** Compiled predicates, by table and alias */
  predicates: Map<string, Sql>;
  /** Tables that read their source live, read only when the database has record rules */
  live: ReadonlySet<string>;
}

const TRUE = sql`TRUE`;
const FALSE = sql`FALSE`;

/** Folder ownership participates in inheritance even for folders restored from an archive. */
export function folderGrantSource(schemas: Pick<DataSchemas, 'app'>): Sql {
  return sql`SELECT org_id, resource_kind, resource_id, principal_kind, principal_id, role
    FROM ${ident(schemas.app, 'grants')}
    UNION SELECT org_id, 'folder', id, 'user', owner_id, 'owner'
    FROM ${ident(schemas.app, 'folders')} WHERE owner_id IS NOT NULL`;
}

/** Home folders and databases whose roles are asked about together. */
export interface HomeResources {
  folders: readonly string[];
  databases: readonly string[];
}

/** One folder or database read as if a move had already put it somewhere else. */
export interface Placement {
  kind: 'folder.move' | 'database.move';
  id: string;
  /** Its new ancestor folders, outermost first */
  path: readonly string[];
  /** How many ancestors a moved folder had, which is where its descendants' own paths continue */
  depth: number;
}

/** One person's strongest role on one folder or database. */
export interface HeldRole {
  userId: string;
  name: string;
  kind: Actor['kind'];
  resourceId: string;
  resourceKind: 'folder' | 'database';
  role: DatabaseRole;
}

/**
 * Who holds a role on each folder and database, as common table expressions over one person or
 * every active member.  A role comes from a grant on the database itself, or from a grant or
 * ownership on a folder above it, where a folder counts as above itself.  An organization owner
 * also owns each folder nobody else owns.  Organization and group grants never reach guests, and
 * nothing in the trash counts unless asked.
 *
 * Grants are found through each resource's own ancestors, so the work follows the grants that
 * apply, never every grant in the organization.  `people` holds the people asked about, `live`
 * the resources still open, and `held` each grant that reaches a resource, before it is expanded
 * to people by `reachedBy`.  Guests also pass the classification gate in `AccessScope`.
 */
function roleSources(
  schemas: DataSchemas,
  orgId: string,
  person: { userId: string; kind: Actor['kind'] } | null,
  resources: HomeResources,
  options: { includeTrashed: boolean; placement?: Placement; retainedAutomation?: boolean },
): Sql {
  const table = (name: string) => ident(schemas.app, name);
  const { placement } = options;
  const movedFolder = placement?.kind === 'folder.move' ? placement : null;
  const movedDatabase = placement?.kind === 'database.move' ? placement : null;
  // The folders above `f`, as stored or as the proposed move would leave them.
  const above = movedFolder
    ? sql`CASE WHEN f.id = ${movedFolder.id} THEN ${movedFolder.path}::text[]
        WHEN f.path @> ARRAY[${movedFolder.id}]::text[]
          THEN ${movedFolder.path}::text[] || f.path[${movedFolder.depth + 1}:cardinality(f.path)]
        ELSE f.path END`
    : sql`f.path`;
  const containing = sql`COALESCE(${above} || f.id, ARRAY[]::text[])`;
  return sql`people AS (
    SELECT m.user_id, ${person ? sql`${person.kind}::text` : sql`m.kind`} AS kind, u.name
    FROM ${table('memberships')} m JOIN ${table('users')} u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND (u.deactivated_at IS NULL OR (${Boolean(options.retainedAutomation)} AND u.automation_access_retained))${person ? sql` AND m.user_id = ${person.userId}` : sql``}
  ), targets AS (
    SELECT f.id, 'folder'::text AS kind, f.owner_id IS NULL AS unowned, ${above} || f.id AS ancestors,
      false AS trashed
    FROM ${table('folders')} f WHERE f.org_id = ${orgId} AND f.id = ANY(${resources.folders}::text[])
    UNION ALL
    SELECT d.id, 'database', false,
      ${movedDatabase ? sql`CASE WHEN d.id = ${movedDatabase.id} THEN ${movedDatabase.path}::text[] ELSE ${containing} END` : containing},
      d.trashed_at IS NOT NULL
    FROM ${table('databases')} d
    LEFT JOIN ${table('folder_databases')} fd ON fd.org_id = d.org_id AND fd.database_id = d.id
    LEFT JOIN ${table('folders')} f ON f.org_id = fd.org_id AND f.id = fd.folder_id
    WHERE d.org_id = ${orgId} AND d.id = ANY(${resources.databases}::text[])
  ), live AS (
    SELECT * FROM targets t WHERE ${options.includeTrashed} OR (NOT t.trashed AND NOT EXISTS (
      SELECT 1 FROM ${table('folders')} a
      WHERE a.org_id = ${orgId} AND a.id = ANY(t.ancestors) AND a.trashed_at IS NOT NULL))
  ), held AS (
    SELECT r.id, r.kind, g.principal_kind, g.principal_id, g.role FROM live r
    JOIN ${table('grants')} g ON g.resource_kind = 'database' AND g.resource_id = r.id AND g.org_id = ${orgId}
    WHERE r.kind = 'database'
    UNION ALL
    SELECT r.id, r.kind, g.principal_kind, g.principal_id, g.role
    FROM live r CROSS JOIN LATERAL unnest(r.ancestors) AS a(id)
    JOIN ${table('grants')} g ON g.resource_kind = 'folder' AND g.resource_id = a.id AND g.org_id = ${orgId}
    UNION ALL
    SELECT r.id, r.kind, 'user', f.owner_id, 'owner'
    FROM live r CROSS JOIN LATERAL unnest(r.ancestors) AS a(id)
    JOIN ${table('folders')} f ON f.id = a.id AND f.org_id = ${orgId} AND f.owner_id IS NOT NULL
  )`;
}

/**
 * The people each row of `source` reaches: the person it names, every member who isn't a guest for
 * the organization, or a group's members who aren't guests.  `source` has `key`, `resource_kind`,
 * `principal_kind`, `principal_id`, and `role` columns.
 */
function reachedBy(schemas: DataSchemas, orgId: string, source: Sql): Sql {
  return sql`SELECT s.key, s.resource_kind, s.role, p.user_id, p.kind, p.name FROM ${source} s
    JOIN people p ON s.principal_kind = 'user' AND p.user_id = s.principal_id
    UNION ALL
    SELECT s.key, s.resource_kind, s.role, p.user_id, p.kind, p.name FROM ${source} s
    JOIN people p ON s.principal_kind = 'org' AND s.principal_id = ${orgId} AND p.kind <> 'guest'
    UNION ALL
    SELECT s.key, s.resource_kind, s.role, p.user_id, p.kind, p.name FROM ${source} s
    JOIN ${ident(schemas.app, 'group_members')} gm
      ON s.principal_kind = 'group' AND gm.org_id = ${orgId} AND gm.group_id = s.principal_id
    JOIN people p ON p.user_id = gm.user_id AND p.kind <> 'guest'`;
}

/**
 * The one place permission questions get answered.  Every handler that reads or changes a
 * database asks here first, and every record read takes `recordPredicate` and `visibleFields`.
 *
 * A person without read access gets `not_found`, never `forbidden`, so IDs don't reveal what
 * exists.  Someone who can read but not do the thing asked gets `forbidden`.
 *
 * On top of roles, a database's field and record rules decide what each person sees and changes
 * (`packages/contracts/src/data/permissions.ts`).  `require` reads them along with the role, and
 * the synchronous questions (`recordPredicate`, `visibleFields`, `canEditField`, and the rest)
 * answer from what it read.  Asking about a table whose database hasn't been read is a bug, and
 * throws rather than guessing.
 */
export class AccessScope {
  private readonly mappedFormulaValues = new Map<string, Sql>();
  private readonly mappedFormulaReads = new Map<string, Promise<void>>();
  private publicRead = false;

  /** Public views and site tiles use only sources that may be published. */
  usePublicFields(): void {
    this.publicRead = true;
  }

  /**
   * Account controls require a live browser session, and People authority for another person.  A
   * `copiedLink` hands its creator the account, so only an owner creates one for a person who holds
   * administration roles.
   */
  async requireAccount(userId: string, copiedLink = false): Promise<void> {
    if (this.actor.token) throw new AppError('forbidden', 'data.access.denied');
    const live = await query<{ id: string; kind: Actor['kind']; admin_roles: string[] }>(
      this.db,
      sql`SELECT s.id, m.kind, m.admin_roles FROM ${ident(this.schemas.app, 'sessions')} s
      JOIN ${ident(this.schemas.app, 'users')} u ON u.id = s.user_id
      JOIN ${ident(this.schemas.app, 'memberships')} m ON m.user_id = u.id AND m.org_id = ${this.actor.orgId}
      WHERE s.id = ${this.actor.sessionId} AND s.user_id = ${this.actor.userId}
      AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.deactivated_at IS NULL
      FOR SHARE OF s`,
    );
    if (!live.rowCount) throw new AppError('unauthenticated', 'errors.signInRequired');
    if (userId !== this.actor.userId) {
      const member = live.rows[0]!;
      const actor = { ...this.actor, kind: member.kind, adminRoles: member.admin_roles };
      const schema = '"' + this.schemas.app.replaceAll('"', '""') + '"';
      this.actor.auditUnitId = await requirePerson(this.db, schema, actor, userId, 'people');
      const target = await query<{ kind: string; administers: boolean }>(
        this.db,
        sql`SELECT m.kind, cardinality(m.admin_roles) > 0 OR EXISTS (
          SELECT 1 FROM ${ident(this.schemas.app, 'org_unit_admins')} a
          WHERE a.org_id = m.org_id AND a.user_id = m.user_id AND cardinality(a.roles) > 0) AS administers
        FROM ${ident(this.schemas.app, 'memberships')} m WHERE m.org_id = ${this.actor.orgId} AND m.user_id = ${userId}`,
      );
      if (target.rows[0]?.kind === 'owner' && actor.kind !== 'owner')
        throw new AppError('forbidden', 'errors.adminOnly');
      if (copiedLink && target.rows[0]?.administers && actor.kind !== 'owner')
        throw new AppError('forbidden', 'auth.reset.adminLink');
    }
  }

  /** Organization administration checks current membership so revoked roles cannot retain access */
  async requireOrganizationAdmin(area: string, ownerOnly = false): Promise<void> {
    const result = await query<{ kind: string; admin_roles: string[] }>(
      this.db,
      sql`SELECT m.kind, m.admin_roles
      FROM ${ident(this.schemas.app, 'memberships')} m JOIN ${ident(this.schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${this.actor.orgId} AND m.user_id = ${this.actor.userId} AND u.deactivated_at IS NULL`,
    );
    const member = result.rows[0];
    if (
      this.actor.token ||
      !member ||
      (member.kind !== 'owner' &&
        (ownerOnly || member.kind !== 'member' || !member.admin_roles.includes(area)))
    )
      throw new AppError('forbidden', 'errors.adminOnly');
  }

  /** Security administration governs organization resources without granting access to their records. */
  async requireGovernanceDatabase(databaseId: string): Promise<void> {
    await this.requireOrganizationAdmin('security');
    const result = await query(
      this.db,
      sql`SELECT 1 FROM ${ident(this.schemas.app, 'databases')}
      WHERE id = ${databaseId} AND org_id = ${this.actor.orgId}`,
    );
    if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
  }

  async shortcutTarget(
    target: ShortcutTarget,
  ): Promise<{ databaseId: string; name: string; href: string } | null> {
    const table = target.kind === 'form' || target.kind === 'view' ? 'views' : `${target.kind}s`;
    const result =
      table === 'views'
        ? await query<{ database_id: string; table_id: string; name: string; type: string }>(
            this.db,
            sql`SELECT t.database_id, v.table_id, v.name, v.type FROM ${ident(this.schemas.app, 'views')} v
          JOIN ${ident(this.schemas.app, 'tables')} t ON t.id = v.table_id
          WHERE v.id = ${target.id} AND t.org_id = ${this.actor.orgId} AND v.trashed_at IS NULL AND t.trashed_at IS NULL`,
          )
        : await query<{ database_id: string; name: string; table_id?: string; type?: string }>(
            this.db,
            sql`SELECT database_id, name FROM ${ident(this.schemas.app, table)}
          WHERE id = ${target.id} AND org_id = ${this.actor.orgId} AND trashed_at IS NULL`,
          );
    const row = result.rows[0];
    if (
      !row ||
      !(await this.databaseRole(row.database_id)) ||
      (target.kind === 'form' && row.type !== 'form')
    )
      return null;
    await this.require(row.database_id, 'read');
    const parts =
      table === 'views' ? [row.database_id, row.table_id!, target.id] : [row.database_id, table, target.id];
    return {
      databaseId: row.database_id,
      name: row.name,
      href: `/${parts.map(encodeURIComponent).join('/')}`,
    };
  }

  /** Library access uses current membership and the same database roles as ordinary reads. */
  async requireLibraryScope(library: LibraryScope, manage = false): Promise<void> {
    await this.requireOrganization();
    if (library.kind === 'database') {
      if (manage && this.actor.token && !this.actor.token.scopes.includes('schema.bases:write'))
        throw new AppError('forbidden', 'errors.tokenScope');
      await this.require(library.databaseId, manage ? 'editSchema' : 'read');
      return;
    }
    if (this.actor.token?.databases) throw new AppError('not_found', 'errors.notFound');
    if (library.kind === 'personal') return;
    if (manage && this.actor.token) throw new AppError('forbidden', 'errors.adminOnly');
    const member = await query<{ kind: string; admin_roles: string[]; org_unit_id: string | null }>(
      this.db,
      sql`SELECT kind, admin_roles, org_unit_id FROM ${ident(this.schemas.app, 'memberships')}
        WHERE org_id = ${this.actor.orgId} AND user_id = ${this.actor.userId}`,
    );
    const current = member.rows[0]!;
    if (current.kind === 'guest') throw new AppError('not_found', 'errors.notFound');
    if (library.kind === 'organization') {
      if (manage) await this.requireOrganizationAdmin('ai');
      return;
    }
    const chain = await query<{ id: string }>(
      this.db,
      sql`WITH RECURSIVE chain AS (
        SELECT id, parent_id, ARRAY[id] AS path FROM ${ident(this.schemas.app, 'org_units')}
          WHERE org_id = ${this.actor.orgId} AND id = ${library.unitId}
        UNION ALL SELECT u.id, u.parent_id, c.path || u.id FROM ${ident(this.schemas.app, 'org_units')} u
          JOIN chain c ON c.parent_id = u.id WHERE u.org_id = ${this.actor.orgId} AND NOT u.id = ANY(c.path)
      ) SELECT id FROM chain`,
    );
    if (!chain.rowCount) throw new AppError('not_found', 'errors.notFound');
    const admin = current.kind === 'owner' || current.admin_roles.includes('ai');
    const grant = await query(
      this.db,
      sql`SELECT 1 FROM ${ident(this.schemas.app, 'org_unit_admins')}
      WHERE org_id = ${this.actor.orgId} AND user_id = ${this.actor.userId}
        AND unit_id = ANY(${chain.rows.map((row) => row.id)}::text[]) AND 'ai' = ANY(roles)`,
    );
    if (admin || grant.rowCount) return;
    if (!manage && current.org_unit_id) {
      const visible = await query(
        this.db,
        sql`WITH RECURSIVE chain AS (
        SELECT id, parent_id, ARRAY[id] AS path FROM ${ident(this.schemas.app, 'org_units')}
          WHERE org_id = ${this.actor.orgId} AND id = ${current.org_unit_id}
        UNION ALL SELECT u.id, u.parent_id, c.path || u.id FROM ${ident(this.schemas.app, 'org_units')} u
          JOIN chain c ON c.parent_id = u.id WHERE u.org_id = ${this.actor.orgId} AND NOT u.id = ANY(c.path)
      ) SELECT 1 FROM chain WHERE id = ${library.unitId}`,
      );
      if (visible.rowCount) return;
    }
    throw new AppError(manage ? 'forbidden' : 'not_found', 'data.access.denied');
  }

  /** Remote tool audiences use current membership, groups, and inherited unit membership. */
  async remoteTools(audience: RemoteAudience): Promise<boolean> {
    await this.requireOrganization();
    if (this.actor.token?.databases) return false;
    const member = await query<{ kind: string; admin_roles: string[]; org_unit_id: string | null }>(
      this.db,
      sql`SELECT kind, admin_roles, org_unit_id FROM ${ident(this.schemas.app, 'memberships')}
        WHERE org_id = ${this.actor.orgId} AND user_id = ${this.actor.userId}`,
    );
    const person = member.rows[0]!;
    if (person.kind === 'guest') return audience.roles.includes('guest');
    if (
      audience.everyone ||
      audience.roles.some((role) => role === person.kind || person.admin_roles.includes(role))
    )
      return true;
    const group = await query(
      this.db,
      sql`SELECT 1 FROM ${ident(this.schemas.app, 'group_members')} m
      JOIN ${ident(this.schemas.app, 'groups')} g ON g.id = m.group_id
      WHERE g.org_id = ${this.actor.orgId} AND m.user_id = ${this.actor.userId} AND g.id = ANY(${audience.groups}::text[])`,
    );
    if (group.rowCount) return true;
    if (!person.org_unit_id || !audience.units.length) return false;
    const unit = await query(
      this.db,
      sql`WITH RECURSIVE chain AS (
      SELECT id, parent_id, ARRAY[id] AS path FROM ${ident(this.schemas.app, 'org_units')}
        WHERE org_id = ${this.actor.orgId} AND id = ${person.org_unit_id}
      UNION ALL SELECT u.id, u.parent_id, c.path || u.id FROM ${ident(this.schemas.app, 'org_units')} u
        JOIN chain c ON c.parent_id = u.id WHERE u.org_id = ${this.actor.orgId} AND NOT u.id = ANY(c.path)
    ) SELECT 1 FROM chain WHERE id = ANY(${audience.units}::text[])`,
    );
    return Boolean(unit.rowCount);
  }

  private readonly roles = new Map<string, Promise<DatabaseRole | null>>();
  private readonly loading = new Map<string, Promise<Prepared>>();
  private readonly prepared = new Map<string, Prepared>();
  /** Records of live tables a live read confirmed this person may see, by table */
  private readonly confirmed = new Map<string, Set<string>>();

  constructor(
    private readonly db: Queryable,
    private readonly schemas: DataSchemas,
    readonly actor: Actor,
    private readonly readMode: ReadMode = {},
  ) {}

  /** Public identity is available only when the installation identifies one organization unambiguously. */
  static async signInBranding(db: Queryable, schema: string) {
    const result = await query<{ name: string; logo: unknown }>(
      db,
      sql`SELECT name, settings->'logo' AS logo FROM ${ident(schema, 'orgs')} WHERE (SELECT count(*) FROM ${ident(schema, 'orgs')}) = 1`,
    );
    const row = result.rows[0];
    return row ? { name: row.name, logo: row.logo ?? null } : null;
  }

  /** Person reads and administration share current membership and directory visibility. */
  async currentPerson(options: { retainedAutomation?: boolean } = {}): Promise<Actor> {
    const found = await query<{ kind: Actor['kind']; adminRoles: string[] }>(
      this.db,
      sql`SELECT m.kind, m.admin_roles AS "adminRoles" FROM ${ident(this.schemas.app, 'memberships')} m
      JOIN ${ident(this.schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${this.actor.orgId} AND m.user_id = ${this.actor.userId}
        AND (u.deactivated_at IS NULL OR (${Boolean(options.retainedAutomation && this.actor.automation && !this.actor.automation.testStep)} AND u.automation_access_retained))`,
    );
    if (!found.rows[0]) throw new AppError('unauthenticated', 'errors.signInRequired');
    return { ...this.actor, ...found.rows[0] };
  }

  async requirePeoplePerson(userId: string): Promise<string | null> {
    const actor = await this.currentPerson();
    if (actor.token || actor.automation || actor.routine) throw new AppError('forbidden', 'errors.adminOnly');
    return requirePerson(this.db, `"${this.schemas.app}"`, actor, userId, 'people');
  }

  async manageablePeople(): Promise<Set<string> | null> {
    const actor = await this.currentPerson();
    if (actor.token) return new Set();
    return reachablePeople(this.db, `"${this.schemas.app}"`, actor, 'people');
  }

  async visiblePeople(): Promise<Set<string> | null> {
    const actor = await this.currentPerson({ retainedAutomation: true });
    if (actor.kind !== 'guest') return null;
    const databases = await query<{ id: string }>(
      this.db,
      sql`SELECT id FROM ${ident(this.schemas.app, 'databases')}
        WHERE org_id = ${actor.orgId} AND trashed_at IS NULL`,
    );
    const resources = {
      folders: [],
      databases: databases.rows
        .map((row) => row.id)
        .filter((id) => !actor.token?.databases || actor.token.databases.includes(id)),
    };
    const readable = await this.heldRoles(actor, resources, { includeTrashed: false });
    if (!readable.length) return new Set([actor.userId]);
    const found = await query<{ userId: string }>(
      this.db,
      sql`WITH ${roleSources(
        this.schemas,
        actor.orgId,
        actor,
        { folders: [], databases: readable.map((role) => role.resourceId) },
        { includeTrashed: false },
      )}
      SELECT DISTINCT principal_id AS "userId" FROM held WHERE principal_kind = 'user'`,
    );
    return new Set([actor.userId, ...found.rows.map((row) => row.userId)]);
  }

  /** Stored references stay valid even when their person's display identity is hidden. */
  async organizationMemberIds(): Promise<Set<string>> {
    const found = await query<{ userId: string }>(
      this.db,
      sql`SELECT user_id AS "userId" FROM ${ident(this.schemas.app, 'memberships')}
        WHERE org_id = ${this.actor.orgId}`,
    );
    return new Set(found.rows.map((row) => row.userId));
  }

  async requirePersonRead(userId: string): Promise<void> {
    const visible = await this.visiblePeople();
    if (visible && !visible.has(userId)) throw new AppError('not_found', 'errors.notFound');
    const found = await query(
      this.db,
      sql`SELECT 1 FROM ${ident(this.schemas.app, 'memberships')}
      WHERE org_id = ${this.actor.orgId} AND user_id = ${userId}`,
    );
    if (!found.rowCount) throw new AppError('not_found', 'errors.notFound');
  }

  async requireOrganization(): Promise<void> {
    const result = await query(
      this.db,
      sql`SELECT 1 FROM ${ident(this.schemas.app, 'memberships')} m
      JOIN ${ident(this.schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${this.actor.orgId} AND m.user_id = ${this.actor.userId}
        AND (u.deactivated_at IS NULL OR (${Boolean(this.actor.automation && !this.actor.automation.testStep)} AND u.automation_access_retained))`,
    );
    if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
  }

  /** A live invitation is a capability for its pending item names, never for item contents. */
  static async invitationItems(db: Queryable, schemas: DataSchemas, tokenHash: string) {
    return (
      await query<{ name: string; resource_kind: 'database' | 'folder'; resource_id: string }>(
        db,
        sql`
      SELECT COALESCE(d.name, f.name) AS name, g.resource_kind, g.resource_id
      FROM ${ident(schemas.app, 'invitations')} i JOIN ${ident(schemas.app, 'invitation_grants')} g ON g.invitation_id = i.id AND g.org_id = i.org_id
      LEFT JOIN ${ident(schemas.app, 'databases')} d ON g.resource_kind = 'database' AND d.id = g.resource_id AND d.org_id = g.org_id AND d.trashed_at IS NULL
      LEFT JOIN ${ident(schemas.app, 'folders')} f ON g.resource_kind = 'folder' AND f.id = g.resource_id AND f.org_id = g.org_id AND f.trashed_at IS NULL
      WHERE i.token_hash = ${tokenHash} AND i.accepted_at IS NULL AND i.expires_at > clock_timestamp()
        AND (d.id IS NOT NULL OR f.id IS NOT NULL) ORDER BY g.resource_kind, g.resource_id`,
      )
    ).rows;
  }

  /** A copyable link may carry only pending grants the caller can manage. */
  async manageableInvitationGrants(invitationIds: string[]) {
    const grants = (
      await query<{
        invitation_id: string;
        resource_kind: 'database' | 'folder';
        resource_id: string;
      }>(
        this.db,
        sql`SELECT invitation_id, resource_kind, resource_id
      FROM ${ident(this.schemas.app, 'invitation_grants')}
      WHERE org_id = ${this.actor.orgId} AND invitation_id = ANY(${invitationIds}::text[])`,
      )
    ).rows;
    const manageable: typeof grants = [];
    for (const grant of grants) {
      try {
        if (grant.resource_kind === 'database') await this.require(grant.resource_id, 'manage');
        else await this.requireFolder(grant.resource_id, 'manage');
        manageable.push(grant);
      } catch (error) {
        if (!(error instanceof AppError) || !['not_found', 'forbidden'].includes(error.code)) throw error;
      }
    }
    return manageable;
  }

  /** The actor's strongest role in the database, or null.  Trashed databases count only when asked. */
  databaseRole(databaseId: string, options: { includeTrashed?: boolean } = {}): Promise<DatabaseRole | null> {
    const key = `${databaseId}:${options.includeTrashed ? 1 : 0}`;
    let role = this.roles.get(key);
    if (!role) {
      role = this.loadRole(databaseId, options.includeTrashed ?? false);
      this.roles.set(key, role);
    }
    return role;
  }

  private async loadRole(databaseId: string, includeTrashed: boolean): Promise<DatabaseRole | null> {
    const a = this.actor;
    if (a.token?.databases && !a.token.databases.includes(databaseId)) return null;
    const [held] = await this.heldRoles(
      { userId: a.userId, kind: a.kind },
      { folders: [], databases: [databaseId] },
      { includeTrashed },
    );
    return held?.role ?? null;
  }

  async folderRole(folderId: string, includeTrashed = false): Promise<DatabaseRole | null> {
    const a = this.actor;
    if (a.token?.databases) return null;
    const [held] = await this.heldRoles(
      { userId: a.userId, kind: a.kind },
      { folders: [folderId], databases: [] },
      { includeTrashed },
    );
    return held?.role ?? null;
  }

  /**
   * Every active member's role on each of these folders and databases, as `folderRole` and
   * `databaseRole` answer for one person, and optionally as if one of them had already moved.
   */
  memberRoles(resources: HomeResources, placement?: Placement): Promise<HeldRole[]> {
    return this.heldRoles(null, resources, { includeTrashed: false, ...(placement ? { placement } : {}) });
  }

  /** Every active member who can open at least one of these folders or databases. */
  async memberReaders(resources: HomeResources): Promise<Set<string>> {
    const { db, schemas, actor } = this;
    if (!resources.folders.length && !resources.databases.length) return new Set();
    const result = await query<{ userId: string; gated: string | null }>(
      db,
      sql`WITH ${roleSources(schemas, actor.orgId, null, resources, { includeTrashed: false })},
      principals AS (
        -- Only a guest's own grants can reach them, and the databases those reach pass the label gate.
        SELECT DISTINCT CASE WHEN principal_kind = 'user' AND kind = 'database' THEN id END AS key,
          'database'::text AS resource_kind, principal_kind, principal_id, NULL::text AS role
        FROM held
      ), reached AS (
        ${reachedBy(schemas, actor.orgId, sql`principals`)}
        UNION ALL
        SELECT NULL, 'folder', 'owner', p.user_id, p.kind, p.name FROM people p
        WHERE p.kind = 'owner' AND EXISTS (SELECT 1 FROM live WHERE unowned)
      ) SELECT DISTINCT user_id AS "userId", CASE WHEN kind = 'guest' THEN key END AS gated FROM reached`,
    );
    const closed = await this.closedToGuests(result.rows.flatMap((row) => (row.gated ? [row.gated] : [])));
    return new Set(
      result.rows.flatMap((row) => (row.gated === null || !closed.has(row.gated) ? [row.userId] : [])),
    );
  }

  /** The one statement every role question about folders and databases is answered by. */
  private async heldRoles(
    person: { userId: string; kind: Actor['kind'] } | null,
    resources: HomeResources,
    options: { includeTrashed: boolean; placement?: Placement },
  ): Promise<HeldRole[]> {
    const { db, schemas, actor } = this;
    if (!resources.folders.length && !resources.databases.length) return [];
    const result = await query<HeldRole>(
      db,
      sql`WITH ${roleSources(schemas, actor.orgId, person, resources, { ...options, retainedAutomation: Boolean(person && person.userId === actor.userId && actor.automation && !actor.automation.testStep) })},
      reached AS (
        ${reachedBy(schemas, actor.orgId, sql`(SELECT id AS key, kind AS resource_kind, principal_kind, principal_id, role FROM held)`)}
        UNION ALL
        SELECT r.id, r.kind, 'owner', p.user_id, p.kind, p.name FROM live r JOIN people p ON p.kind = 'owner'
        WHERE r.unowned
      ) SELECT DISTINCT ON (user_id, key) user_id AS "userId", name, kind, key AS "resourceId",
        resource_kind AS "resourceKind", role
      FROM reached ORDER BY user_id, key, array_position(${[...DATABASE_ROLES]}::text[], role)`,
    );
    const closed = await this.closedToGuests(
      result.rows.flatMap((row) =>
        row.kind === 'guest' && row.resourceKind === 'database' ? [row.resourceId] : [],
      ),
    );
    return closed.size
      ? result.rows.filter((row) => row.kind !== 'guest' || !closed.has(row.resourceId))
      : result.rows;
  }

  /** The databases among these whose labels keep guests out, each read once. */
  private async closedToGuests(databaseIds: readonly string[]): Promise<Set<string>> {
    const closed = new Set<string>();
    for (const databaseId of new Set(databaseIds)) {
      const tree = await loadClassification(this.db, this.schemas, this.actor.orgId, databaseId);
      const rules = tree.fields.size
        ? [...tree.fields.values()]
        : tree.tables.size
          ? [...tree.tables.values()]
          : [tree.database];
      if (rules.some((value) => !classificationAllows(value, 'guestSharing'))) closed.add(databaseId);
    }
    return closed;
  }

  /** People administration retains its organization folders without exposing personal ones. */
  async folderVisibleForAdministration(folderId: string): Promise<boolean> {
    if (await this.folderRole(folderId)) return true;
    const a = this.actor;
    if (
      a.kind !== 'owner' &&
      !a.adminRoles.includes('people') &&
      !a.unitAdminGrants?.some((grant) => grant.roles.includes('people'))
    )
      return false;
    const result = await query(
      this.db,
      sql`SELECT id FROM ${ident(this.schemas.app, 'folders')}
      WHERE org_id = ${a.orgId} AND id = ${folderId} AND organization_folder AND trashed_at IS NULL
      AND EXISTS (SELECT 1 FROM ${ident(this.schemas.app, 'memberships')} m
        JOIN ${ident(this.schemas.app, 'users')} u ON u.id = m.user_id
        WHERE m.org_id = ${a.orgId} AND m.user_id = ${a.userId} AND u.deactivated_at IS NULL)`,
    );
    return Boolean(result.rowCount);
  }

  async requireFolder(
    folderId: string,
    action: DatabaseAction,
    includeTrashed = false,
  ): Promise<DatabaseRole> {
    const role = await this.folderRole(folderId, includeTrashed);
    if (!role) throw new AppError('not_found', 'errors.notFound');
    if (!roleAllows(role, action)) throw new AppError('forbidden', 'data.access.denied');
    return role;
  }

  /** Throws unless the actor may do `action` in the database; returns their role. */
  async require(
    databaseId: string,
    action: DatabaseAction,
    options: { includeTrashed?: boolean } = {},
  ): Promise<DatabaseRole> {
    const role = await this.databaseRole(databaseId, options);
    if (!role) throw new AppError('not_found', 'errors.notFound');
    if (!roleAllows(role, action)) throw new AppError('forbidden', 'data.access.denied');
    await this.prepare(databaseId);
    return role;
  }

  /**
   * Reads a database's field and record rules for this person.  `require` does it, so only code
   * that asks for a role some other way needs to call this before asking about fields or records.
   */
  async prepare(databaseId: string): Promise<void> {
    const prepared = await this.prepareDatabase(databaseId);
    // Loading one database never waits on another, so inverse pairs and longer cycles terminate.
    for (const id of prepared.related) await this.prepareDatabase(id);
    if (prepared.related.length > 1) this.classifyRelations(prepared.related);
    for (const id of prepared.related) {
      let reading = this.mappedFormulaReads.get(id);
      if (!reading) {
        reading = this.readMappedFormulas(this.forDatabase(id));
        this.mappedFormulaReads.set(id, reading);
      }
      await reading;
    }
  }

  /** JavaScript-only sources retain the same dependencies and record scope as ordinary formula reads. */
  private async readMappedFormulas(prepared: Prepared): Promise<void> {
    const visited = new Set<string>();
    const read = async (tableId: string): Promise<void> => {
      if (visited.has(tableId)) return;
      visited.add(tableId);
      const joined = prepared.joined.get(tableId);
      if (!joined) return;
      for (const id of [joined.baseTableId, ...joined.steps.map((step) => step.tableId)]) await read(id);
      for (const mapping of joined.fields.filter((mapping) => mapping.sources))
        for (const source of joinedSources(mapping)) {
          if (this.mappedFormulaValues.has(source.fieldId)) continue;
          const known = prepared.fields.get(source.fieldId);
          if (!known || known.type !== 'formula') continue;
          const field = this.visibleFields(source.tableId, [known])[0];
          if (!field || formulaExpression(field)) continue;
          const ids = await query<{ id: string }>(
            this.db,
            sql`SELECT __id AS id FROM ${ident(this.schemas.data, source.tableId)}
              WHERE __deleted_at IS NULL AND NOT __source_gone AND (${this.recordPredicate(source.tableId)})
              ORDER BY __rid`,
          );
          const values: Record<string, unknown> = {};
          for (let offset = 0; offset < ids.rows.length; offset += 1000) {
            const rows = await fetchRowsById(
              this.db,
              this.schemas.data,
              source.tableId,
              [field],
              ids.rows.slice(offset, offset + 1000).map((row) => row.id),
            );
            for (const row of rows) values[row.id] = row.errors?.[field.id] ? null : row.values[field.id];
          }
          this.mappedFormulaValues.set(field.id, sql`${JSON.stringify(values)}::jsonb`);
        }
    };
    for (const id of prepared.joined.keys()) await read(id);
  }

  /** Derived values keep their inputs' destination restrictions across database boundaries. */
  private classifyRelations(ids: readonly string[]): void {
    const databases = ids.map((id) => this.forDatabase(id));
    const rules = new Map(databases.flatMap((database) => [...database.classification.fields]));
    const primaries = new Map(databases.flatMap((database) => [...database.primaries]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const database of databases)
        for (const field of database.known.values()) {
          const own = rules.get(field.id);
          if (!own) continue;
          for (const id of dependencyIds(field, primaries, database.linkLimits)) {
            const dependency = rules.get(id);
            if (!dependency) continue;
            for (const key of Object.keys(own) as Array<keyof typeof own>)
              if (dependency[key] && !own[key]) {
                own[key] = true;
                changed = true;
              }
          }
        }
    }
  }

  private async prepareDatabase(databaseId: string): Promise<Prepared> {
    let loading = this.loading.get(databaseId);
    if (!loading) {
      loading = this.load(databaseId);
      this.loading.set(databaseId, loading);
    }
    try {
      return await loading;
    } catch (error) {
      this.loading.delete(databaseId);
      throw error;
    }
  }

  private async load(databaseId: string): Promise<Prepared> {
    const role =
      (await this.roles.get(`${databaseId}:0`)) ??
      (await this.roles.get(`${databaseId}:1`)) ??
      (await this.databaseRole(databaseId));
    const tables = await query<{
      id: string;
      primary_field_id: string | null;
      joined: JoinedTable | null;
      line_items: { parentTableId: string; parentFieldId: string } | null;
      trashed_at: Date | null;
      data_version: string;
      updated_at: Date;
    }>(
      this.db,
      sql`SELECT id, primary_field_id, joined, line_items, trashed_at, data_version, updated_at
        FROM ${ident(this.schemas.app, 'tables')} WHERE database_id = ${databaseId} ORDER BY id`,
    );
    const related = await relatedDatabaseIds(
      this.db,
      this.schemas,
      tables.rows.map((row) => row.id),
    );
    const classification = await loadClassification(this.db, this.schemas, this.actor.orgId, databaseId);
    const classified = [...classification.fields.values()].some((rules) =>
      Object.values(rules).some(Boolean),
    );
    const rules = await loadDatabaseRules(this.db, this.schemas, databaseId);
    const owner = role === 'owner';
    const person = { userId: this.actor.userId, role };
    const recordRules = new Map<string, StoredRecordRule[]>();
    for (const rule of rules.records)
      recordRules.set(rule.tableId, [...(recordRules.get(rule.tableId) ?? []), rule]);
    const applicable = new Map<string, StoredRecordRule[]>();
    if (!owner)
      for (const rule of rules.records)
        if (audienceNames(rule, person))
          applicable.set(rule.tableId, [...(applicable.get(rule.tableId) ?? []), rule]);
    const { fields, known } =
      rules.fields.length ||
      rules.records.length ||
      classified ||
      related.length > 1 ||
      tables.rows.some((row) => row.line_items || row.joined)
        ? await databaseFields(
            this.db,
            this.schemas,
            tables.rows.map((row) => row.id),
          )
        : { fields: new Map<string, StoredField>(), known: new Map<string, StoredField>() };
    const primaries = new Map(tables.rows.map((row) => [row.id, row.primary_field_id]));
    // A link limited to a view offers and accepts only the records the view's filter keeps, which
    // says something of every field the filter reads, as a filter of the link's own would.
    const linkLimits = new Map<string, string[]>();
    for (const field of known.values()) {
      if (field.type !== 'link' || !field.options.limitToViewId) continue;
      const limit = await loadView(this.db, this.schemas, field.options.limitToViewId);
      if (limit && !limit.trashed && limit.view.tableId === field.options.linkedTableId)
        linkLimits.set(
          field.id,
          relationalConditions(limit.view.config.filter ?? undefined).map((condition) => condition.fieldId),
        );
    }
    const fieldRules = new Map(rules.fields.map((rule) => [rule.fieldId, rule]));
    const live = rules.records.length
      ? await query<{ table_id: string }>(
          this.db,
          sql`SELECT ts.table_id FROM ${ident(this.schemas.app, 'table_sources')} ts
          JOIN ${ident(this.schemas.app, 'tables')} t ON t.id = ts.table_id
          WHERE t.database_id = ${databaseId}
          AND (ts.settings ->> 'freshness' = 'live' OR COALESCE((ts.status ->> 'switchingToCopy')::boolean, false))`,
        )
      : { rows: [] };
    const joined = new Map(tables.rows.flatMap((row) => (row.joined ? [[row.id, row.joined] as const] : [])));
    // Derived values retain every restriction of the values used to compute or match them.
    let changed = true;
    while (changed && classified) {
      changed = false;
      for (const field of known.values()) {
        const own = classification.fields.get(field.id);
        if (!own) continue;
        for (const id of [
          ...joinedFieldDependencies(field.id, joined.get(field.tableId)),
          ...storedMappingDependencies(field, known, primaries, joined),
          ...dependencyIds(field, primaries, linkLimits),
        ]) {
          const dependency = classification.fields.get(id);
          if (!dependency) continue;
          for (const key of Object.keys(own) as Array<keyof typeof own>)
            if (dependency[key] && !own[key]) {
              classification.fields.set(field.id, { ...classification.fields.get(field.id)!, [key]: true });
              own[key] = true;
              changed = true;
            }
        }
      }
    }
    const prepared: Prepared = {
      dataFingerprint: JSON.stringify([
        tables.rows.map((row) => [row.id, row.data_version, row.updated_at, row.trashed_at]),
        [...known.values()].map((field) => [field.id, field.updatedAt]),
      ]),
      lineItems: new Map(
        tables.rows.flatMap((row) =>
          row.line_items
            ? [
                [
                  row.id,
                  {
                    ...row.line_items,
                    active: tables.rows.some(
                      (parent) => parent.id === row.line_items!.parentTableId && !parent.trashed_at,
                    ),
                  },
                ] as const,
              ]
            : [],
        ),
      ),
      joined,
      classification,
      databaseId,
      related,
      role,
      owner,
      tableIds: new Set(tables.rows.map((row) => row.id)),
      fieldRules,
      applicable,
      recordRules,
      hidden: new Set(),
      fields,
      known,
      primaries,
      linkLimits,
      predicates: new Map(),
      live: new Set(live.rows.map((row) => row.table_id)),
    };
    if (!owner)
      prepared.hidden = hiddenClosure(
        known,
        primaries,
        fieldRules,
        person,
        limitedTables(prepared),
        prepared.joined,
        linkLimits,
      );
    this.prepared.set(databaseId, prepared);
    return prepared;
  }

  requireTableUse(tableId: string, use: ClassificationUse, fieldIds?: readonly string[]): void {
    const prepared = this.forTable(tableId);
    if (!this.allowsUse(prepared.databaseId, use, { tableId, ...(fieldIds ? { fieldIds } : {}) }))
      throw new AppError('forbidden', 'governance.classificationDenied');
  }

  /**
   * Whether every value involved may leave through this destination.  `withDatabase` also asks the
   * database's own label, for data that will inherit it, such as a new table.
   */
  allowsUse(
    databaseId: string,
    use: ClassificationUse,
    options: { tableId?: string; fieldIds?: readonly string[]; withDatabase?: boolean } = {},
  ): boolean {
    const tree = this.forDatabase(databaseId).classification;
    if (options.withDatabase && !classificationAllows(tree.database, use)) return false;
    const outbound = use === 'export' || use === 'external' || use === 'recipient';
    const memo = new Map<string, boolean>();
    const allowed = (id: string, seen = new Set<string>()): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      const field = this.knownField(id);
      const prepared = field ? this.forTable(field.tableId) : this.forDatabase(databaseId);
      const rules = prepared.classification.fields.get(id);
      if (!rules || !classificationAllows(rules, use)) return false;
      if (!outbound || !field || seen.has(id)) return true;
      seen.add(id);
      const mapping = prepared.joined.get(field.tableId)?.fields.find((item) => item.outputFieldId === id);
      const sources =
        mapping?.sources?.filter((source) => {
          const field = this.knownField(source.fieldId);
          return field && !this.hides(prepared, field);
        }) ?? [];
      // Exported values and pins can retain information from any readable mapping source.
      const permitted = [
        ...sources.map((source) => source.fieldId),
        ...dependencyIds(field, prepared.primaries).filter((id) => this.knownField(id)),
      ].every((id) => allowed(id, new Set(seen)));
      memo.set(id, permitted);
      return permitted;
    };
    if (options.fieldIds) return options.fieldIds.every((id) => tree.fields.has(id) && allowed(id));
    const prepared = this.forDatabase(databaseId);
    const selected = [...tree.fields].filter(
      ([id]) => !options.tableId || prepared.known.get(id)?.tableId === options.tableId,
    );
    if (selected.length) return selected.every(([id]) => allowed(id));
    return classificationAllows(
      options.tableId ? (tree.tables.get(options.tableId) ?? tree.database) : tree.database,
      use,
    );
  }

  async requireUse(
    databaseId: string,
    use: ClassificationUse,
    options: { tableId?: string; fieldIds?: readonly string[]; withDatabase?: boolean } = {},
  ): Promise<void> {
    await this.prepare(databaseId);
    if (!this.allowsUse(databaseId, use, options))
      throw new AppError('forbidden', 'governance.classificationDenied');
  }

  /** Token reads leave the organization even when their destination also masks provider input. */
  async requireMachineUse(databaseId: string, tableId: string): Promise<void> {
    if (!this.actor.token) return;
    for (const use of ['export', 'external'] as const) await this.requireUse(databaseId, use, { tableId });
  }

  private classifiedHidden(prepared: Prepared, fieldId: string): boolean {
    const rules = prepared.classification.fields.get(fieldId);
    if (!rules) return false;
    return (
      (this.publicRead && !classificationAllows(rules, 'public')) ||
      (this.actor.kind === 'guest' &&
        (!classificationAllows(rules, 'guest') || !classificationAllows(rules, 'external'))) ||
      Boolean(this.actor.dataUse && !classificationAllows(rules, this.actor.dataUse))
    );
  }

  /**
   * Makes sure the rules of a table's database are read, reading them again when the table is newer
   * than what was read, as when a command made it moments ago.
   */
  async ensureTable(tableId: string): Promise<void> {
    for (const prepared of this.prepared.values()) if (prepared.tableIds.has(tableId)) return;
    const result = await query<{ database_id: string }>(
      this.db,
      sql`SELECT database_id FROM ${ident(this.schemas.app, 'tables')} WHERE id = ${tableId}`,
    );
    const databaseId = result.rows[0]?.database_id;
    if (!databaseId) return;
    this.prepared.delete(databaseId);
    this.loading.delete(databaseId);
    await this.prepare(databaseId);
  }

  /** The rules read for the database a table belongs to.  Throws when none were read. */
  private forTable(tableId: string): Prepared {
    for (const prepared of this.prepared.values()) if (prepared.tableIds.has(tableId)) return prepared;
    throw new Error(`Access rules for table ${tableId} were not read before asking about it`);
  }

  private forDatabase(databaseId: string): Prepared {
    const prepared = this.prepared.get(databaseId);
    if (!prepared) throw new Error(`Access rules for database ${databaseId} were not read before asking`);
    return prepared;
  }

  private person(prepared: Prepared) {
    return { userId: this.actor.userId, role: prepared.role };
  }

  /**
   * Source reads use the same scope as the tables they can populate: the organization's Data
   * Sources admins may do everything, and so may a unit's, with the sources its people made and
   * fill only its people's databases.
   */
  async requireSource(
    source: { id: string; org_id: string; kind: SourceKind; access: 'admins' | 'creators' },
    select?: SourceSelect,
  ): Promise<void> {
    if (source.org_id !== this.actor.orgId) throw new AppError('not_found', 'errors.notFound');
    const admin = await administersSource(this.db, `"${this.schemas.app}"`, this.actor, source.id);
    if (select?.kind === 'query' && !admin) throw new AppError('forbidden', 'sources.queryAdminsOnly');
    if (select?.kind === 'object' && select.filter !== undefined) {
      // Document filters, like queries, may only be written by an admin.
      if (!isDocumentKind(source.kind)) throw new AppError('validation_failed', 'sources.filterUnsupported');
      if (!admin) throw new AppError('forbidden', 'sources.filterAdminsOnly');
    }
    if (select?.kind === 'object' && select.nativeFilter !== undefined) {
      // A search engine's own filter, like a query, may only be written by an admin.
      if (!isSearchSource(source.kind)) throw new AppError('validation_failed', 'sources.filterUnsupported');
      if (!admin) throw new AppError('forbidden', 'sources.filterAdminsOnly');
      // An admin writes the filter, but the record rules still bind everyone who reads the table.
      // Meilisearch binds AND tighter than OR, so a filter that closes a group it never opened
      // would end the group the rules sit in.  Typesense joins the rules after the filter in one
      // string and toggles on every backtick, so an open backtick would swallow them.  Either
      // would exempt rows from the rules, and a filter left open fails every read.
      if (
        (source.kind === 'meilisearch' || source.kind === 'typesense') &&
        searchFilterProblem(select.nativeFilter, source.kind) !== null
      )
        throw new AppError('validation_failed', 'sources.engines.filterGroup');
    }
    if (admin || (source.access === 'creators' && (await this.canCreateTables()))) return;
    throw new AppError('forbidden', 'sources.notAllowed');
  }

  async canCreateTables(): Promise<boolean> {
    const result = await query<{ id: string }>(
      this.db,
      sql`SELECT id FROM ${ident(this.schemas.app, 'databases')} WHERE org_id = ${this.actor.orgId} AND trashed_at IS NULL`,
    );
    for (const row of result.rows) {
      const role = await this.databaseRole(row.id);
      if (role && roleAllows(role, 'editSchema')) return true;
    }
    return false;
  }

  /**
   * SQL condition limiting which records of a table the actor can see: the conditions of every
   * record rule that names them, any of which will do, or TRUE when none does.  `alias` qualifies
   * the columns when the query names the table something else.  A condition that can't be read,
   * such as one on a field that's gone, matches nothing rather than everything.
   * History can include trashed parents while retaining their field and record access rules.
   */
  recordPredicate(tableId: string, alias?: string, options: { trashedParents?: boolean } = {}): Sql {
    const prepared = this.forTable(tableId);
    const ownership = prepared.lineItems.get(tableId);
    if (ownership) {
      const field = prepared.fields.get(ownership.parentFieldId);
      if (!ownership.active || !field || this.hides(prepared, field)) return FALSE;
      const source = `line_owner_${tableId}`;
      return sql`EXISTS (SELECT 1 FROM ${ident(this.schemas.data, ownership.parentTableId)} ${ident(source)}
        WHERE ${ident(source, '__id')} = ${alias ? ident(alias, '__parent_id') : ident(tableId, '__parent_id')}
          ${options.trashedParents ? sql`` : sql`AND ${ident(source, '__deleted_at')} IS NULL`}
          AND (${this.recordPredicate(ownership.parentTableId, source, options)}))`;
    }
    const settings = prepared.joined.get(tableId);
    const own = this.ownRecordPredicate(tableId, alias);
    if (!settings) return own;
    if (
      settings.steps.some(
        (step) => prepared.hidden.has(step.leftFieldId) || prepared.hidden.has(step.rightFieldId),
      )
    )
      return FALSE;
    const origins = alias ? ident(alias, '__joined_records') : ident(tableId, '__joined_records');
    const inputs = [settings.baseTableId, ...settings.steps.map((step) => step.tableId)];
    if (inputs.some((id) => !prepared.tableIds.has(id))) return FALSE;
    return sql`(${own}) AND ${join(
      inputs.map((id, index) => {
        const source = `joined_scope_${id}_${index}`;
        return sql`(${origins} ->> ${id} IS NULL OR EXISTS (
        SELECT 1 FROM ${ident(this.schemas.data, id)} ${ident(source)}
        WHERE ${ident(source, '__id')} = ${origins} ->> ${id}
          AND ${ident(source, '__deleted_at')} IS NULL AND NOT ${ident(source, '__source_gone')}
          AND (${this.recordPredicate(id, source)})))`;
      }),
      ' AND ',
    )}`;
  }

  private ownRecordPredicate(tableId: string, alias?: string): Sql {
    const prepared = this.forTable(tableId);
    if (roleless(prepared)) {
      const questions = this.readMode.publicQuestions;
      // A submitter has no identity a record rule can name, so ruled tables stay private.
      if (
        this.actor.userId ||
        questions?.tableId !== tableId ||
        !questions.recordId ||
        prepared.recordRules.get(tableId)?.length
      )
        return FALSE;
      return sql`${alias ? ident(alias, '__id') : sql`__id`} = ${questions.recordId}`;
    }
    const rules = prepared.applicable.get(tableId);
    if (!rules?.length) return TRUE;
    // Identity rows have no reliable source values, so stored reads cannot confirm live rules.
    if (prepared.live.has(tableId)) {
      if (this.readMode.readOnly) return FALSE;
      const ids = [...(this.confirmed.get(tableId) ?? [])];
      return ids.length ? sql`${alias ? ident(alias, '__id') : sql`__id`} = ANY(${ids}::text[])` : FALSE;
    }
    const key = `${tableId}\u0000${alias ?? ''}`;
    let predicate = prepared.predicates.get(key);
    if (!predicate) {
      const fields = new Map(
        [...prepared.fields.values()].filter((f) => f.tableId === tableId).map((f) => [f.id, f]),
      );
      const context: ReadContext = { timeZone: 'UTC', now: new Date(), natural: false };
      const each = rules.map((rule) =>
        ruleCondition(rule.condition, fields, context, this.schemas.app, alias, this.actor.userId),
      );
      predicate = sql`(${join(each, ' OR ')})`;
      prepared.predicates.set(key, predicate);
    }
    return predicate;
  }

  /**
   * The same condition for a linked record read inside another query under `alias`, such as a
   * link's or a lookup's own subquery.  It reads the record again under a name of its own, so a
   * rule whose condition goes through the very link being read can't mistake the outer record for
   * its own.
   */
  linkedPredicate(tableId: string, alias: string): Sql {
    if (!this.limitsRecords(tableId)) return TRUE;
    const own = `q_${alias}`.slice(0, 63);
    return sql`EXISTS (SELECT 1 FROM ${ident(this.schemas.data, tableId)} AS ${ident(own)}
      WHERE ${ident(own, '__rid')} = ${ident(alias, '__rid')} AND ${this.recordPredicate(tableId, own)})`;
  }

  /**
   * For a table that reads its source live: the conditions of the record rules that name the
   * actor, with the current person filled in, for the source to apply.  Null when no rule limits
   * them, and empty when they may see no record at all.
   */
  liveRules(tableId: string): FilterGroup[] | null {
    const prepared = this.forTable(tableId);
    if (roleless(prepared)) return [];
    const rules = prepared.applicable.get(tableId);
    if (!rules?.length) return null;
    return rules.map((rule) => withPersonGroup(rule.condition, this.actor.userId));
  }

  /** Notes records of a live table that a live read confirmed the actor may see. */
  confirmLive(tableId: string, ids: Iterable<string>): void {
    const set = this.confirmed.get(tableId) ?? new Set<string>();
    for (const id of ids) set.add(id);
    this.confirmed.set(tableId, set);
  }

  /** Whether a record rule limits which of the table's records the actor sees. */
  limitsRecords(tableId: string): boolean {
    const prepared = this.forTable(tableId);
    return (
      roleless(prepared) ||
      prepared.lineItems.has(tableId) ||
      prepared.joined.has(tableId) ||
      Boolean(prepared.applicable.get(tableId)?.length)
    );
  }

  /** Changing a rule's inputs needs the same access as changing the rule itself. */
  async requireAdministerRecordRules(tableId: string): Promise<void> {
    const prepared = this.forTable(tableId);
    await this.require(prepared.databaseId, 'editSchema');
    if (this.limitsRecords(tableId)) throw new AppError('forbidden', 'data.access.rulesLimited');
    for (const rule of prepared.recordRules.get(tableId) ?? [])
      for (const condition of relationalConditions(rule.condition)) {
        const field = prepared.known.get(condition.fieldId);
        if (field && !this.visibleFields(field.tableId, [field]).length)
          throw new AppError('forbidden', 'data.access.fieldHidden');
      }
  }

  /**
   * The database's formulas that call any of these named functions, trashed ones too.  Read only
   * where rules or links to another database had the scope read the fields at all.
   */
  formulasCalling(databaseId: string, names: ReadonlySet<string>): StoredField[] {
    return [...this.forDatabase(databaseId).known.values()].filter((field) => {
      if (field.type !== 'formula') return false;
      const parsed = parseFormula(field.options.expression);
      return 'ast' in parsed && functionCalls(parsed.ast).some((name) => names.has(name));
    });
  }

  /** Follows saved callers even when a missing function or field has broken their execution plan. */
  async requireNamedFunctionMutation(databaseId: string, names: ReadonlySet<string>): Promise<void> {
    await this.prepare(databaseId);
    const prepared = this.forDatabase(databaseId);
    if (!prepared.recordRules.size) return;
    const affected = new Set(this.formulasCalling(databaseId, names).map((field) => field.id));
    const readsAffected = (id: string, seen: Set<string>): boolean => {
      if (affected.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const field = prepared.known.get(id);
      return Boolean(
        field &&
        [
          ...dependencyIds(field, prepared.primaries, prepared.linkLimits),
          ...joinedFieldDependencies(id, prepared.joined.get(field.tableId)),
        ].some((dependency) => readsAffected(dependency, seen)),
      );
    };
    for (const [tableId, rules] of prepared.recordRules)
      if (
        rules.some((rule) =>
          relationalConditions(rule.condition).some((condition) =>
            readsAffected(condition.fieldId, new Set()),
          ),
        )
      )
        await this.requireAdministerRecordRules(tableId);
  }

  /**
   * The fields of a table the actor can see.  Links, lookups, rollups, and counts among them come
   * back reading only the linked records the actor may see, so everything computed from them is
   * computed over those records alone.
   */
  visibleFields<F extends { id: string }>(tableId: string, fields: readonly F[]): F[] {
    const prepared = this.forTable(tableId);
    if (roleless(prepared) && !this.readMode.publicQuestions) return [];
    fields = fields.filter((field) => !this.classifiedHidden(prepared, field.id));
    if (
      !this.publicRead &&
      prepared.related.length <= 1 &&
      !prepared.lineItems.size &&
      !prepared.joined.size &&
      (prepared.owner || (!prepared.hidden.size && !prepared.applicable.size && !roleless(prepared)))
    )
      return [...fields];
    const memo = new Map<string, StoredField>();
    const loaded = new Map<string, StoredField>(
      fields.flatMap((field) => (isStored(field) ? [[field.id, field] as const] : [])),
    );
    // Anything with only an ID, such as a trash entry, is judged by its ID alone.
    return fields
      .filter((field) => !this.hides(prepared, field as unknown as StoredField))
      .map((field) =>
        isStored(field) ? (this.scoped(prepared, field, memo, new Set(), loaded) as unknown as F) : field,
      );
  }

  /** Whether a field is hidden from the actor, by its rules or by what it's computed from. */
  private hides(
    prepared: Prepared,
    field: StoredField,
    seen = new Set<string>(),
    boundary?: { databaseId: string; hidden: ReadonlySet<string> },
  ): boolean {
    if (field.tableId) prepared = this.forTable(field.tableId);
    if (boundary && prepared.databaseId !== boundary.databaseId) return false;
    const lines = this.readMode.publicLines;
    if (lines && lines.tableId === field.tableId && lines.fieldIds.has(field.id))
      return Boolean(
        prepared.fieldRules.get(field.id)?.restricted || prepared.fieldRules.get(field.id)?.locked,
      );
    const owner = prepared.lineItems.get(field.tableId);
    if (owner) {
      const parent = prepared.known.get(owner.parentFieldId);
      if (!parent || this.hides(prepared, parent, seen)) return true;
      if (
        parent.type === 'lineItems' &&
        this.publicQuestion(parent) &&
        (field.id === parent.options.inverseFieldId ||
          parent.options.columns.some((column) => column.id === field.id && column.type !== 'link'))
      )
        return Boolean(
          prepared.fieldRules.get(field.id)?.restricted || prepared.fieldRules.get(field.id)?.locked,
        );
    }
    if (roleless(prepared) && !this.publicQuestion(field)) return true;
    if (this.classifiedHidden(prepared, field.id)) return true;
    if (this.publicRead && this.restrictedForAnyone(field.tableId, field)) return true;
    if (!prepared.owner && (boundary?.hidden ?? prepared.hidden).has(field.id)) return true;
    if (field.type === 'lineItems' && this.publicQuestion(field)) return false;
    if (seen.has(field.id)) return false;
    seen.add(field.id);
    const mapping = prepared.joined
      .get(field.tableId)
      ?.fields.find((item) => item.outputFieldId === field.id);
    if (
      mapping?.sources &&
      mapping.sources.every((source) => {
        const known = prepared.known.get(source.fieldId);
        return !known || this.hides(prepared, known, new Set(seen), boundary);
      })
    )
      return true;
    // An AI field made since this scope read its rules still follows what its prompt reads, and the
    // record rules of the tables it reads through links.
    if (
      !boundary &&
      field.ai &&
      (templateFieldIds(field.ai.prompt).some((id) => prepared.hidden.has(id)) ||
        this.readsLimited(prepared, field.ai.prompt))
    )
      return true;
    // A field this scope didn't read, such as one made since, still follows what it reads.
    const dependencies = [
      ...storedMappingDependencies(field, prepared.known, prepared.primaries, prepared.joined).flatMap(
        (id) => this.knownField(id) ?? [],
      ),
      ...nestedDependencies(field),
      ...dependencyIds(field, prepared.primaries, prepared.linkLimits).flatMap(
        (id) => this.knownField(id) ?? [],
      ),
    ];
    return dependencies.some((dependency) => this.hides(prepared, dependency, seen, boundary));
  }

  private publicQuestion(field: StoredField): boolean {
    const questions = this.readMode.publicQuestions;
    return Boolean(
      questions &&
      !this.actor.userId &&
      questions.tableId === field.tableId &&
      questions.fieldIds.has(field.id) &&
      PUBLIC_QUESTION_TYPES.some((type) => type === field.type),
    );
  }

  private knownField(id: string): StoredField | undefined {
    for (const prepared of this.prepared.values()) {
      const field = prepared.known.get(id);
      if (field) return field;
    }
    return undefined;
  }

  /**
   * Whether an AI field's prompt reads, through a link, lookup, rollup, or count, records of a table
   * a record rule limits for the actor.  Its value was written through its person's access, so it
   * could name linked records the actor can't see, and the field is hidden from them the way a
   * restricted field is.  The record's own fields need nothing more, since the record's own rules
   * already decide whether they see it.  Fields in the trash still count, and when what the prompt
   * read can't be worked out at all, it counts as reading limited records for anyone a record rule
   * limits anywhere in the database.  `fields` adds fields newer than the rules this scope read,
   * such as the table's as a command is about to leave them.
   */
  readsLimitedRecords(tableId: string, prompt: string, fields: readonly StoredField[] = []): boolean {
    const prepared = this.forTable(tableId);
    return this.readsLimited(prepared, prompt, new Map(fields.map((field) => [field.id, field])));
  }

  private readsLimited(
    prepared: Prepared,
    prompt: string,
    newer: ReadonlyMap<string, StoredField> = new Map(),
  ): boolean {
    const databases = [
      prepared,
      ...prepared.related.filter((id) => id !== prepared.databaseId).map((id) => this.forDatabase(id)),
    ];
    const limited = new Set(databases.flatMap((database) => [...limitedTables(database)]));
    if (!limited.size) return false;
    const primaries = new Map(databases.flatMap((database) => [...database.primaries]));
    const reads = promptReads(prompt, (id) => newer.get(id) ?? this.knownField(id), primaries);
    return reads.unresolved || [...reads.tables].some((id) => limited.has(id));
  }

  /** A field with every relation in it limited to the linked records the actor may see. */
  private scoped(
    prepared: Prepared,
    field: StoredField,
    memo: Map<string, StoredField>,
    seen: Set<string>,
    loaded: ReadonlyMap<string, StoredField>,
  ): StoredField {
    prepared = this.forTable(field.tableId);
    const known = memo.get(field.id);
    if (known) return known;
    if (seen.has(field.id)) return field;
    seen.add(field.id);
    let result = field;
    const mapping = prepared.joined
      .get(field.tableId)
      ?.fields.find((item) => item.outputFieldId === field.id);
    if (mapping?.sources) {
      const readable = joinedSources(mapping).flatMap((source) => {
        const known = prepared.fields.get(source.fieldId);
        return known && !this.hides(prepared, known, new Set(seen))
          ? [this.scoped(prepared, known, memo, new Set(seen), loaded)]
          : [];
      });
      const complete = readable.length === mapping.sources.length;
      result = {
        ...result,
        joinedPartial: !complete,
        ...(field.source && readable[0] ? { source: { ...field.source, column: readable[0].id } } : {}),
        joinedRead: (alias) => {
          const origins = alias ? ident(alias, '__joined_records') : ident(field.tableId, '__joined_records');
          const values = readable.map((source, index) => {
            const side = `mapped_${field.id}_${index}`;
            const expression = source.type === 'formula' ? formulaExpression(source, side) : null;
            const raw =
              source.type === 'formula'
                ? expression
                  ? sql`(SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN NULL ELSE value END
                    FROM (SELECT ${expression} AS value) formula_source)`
                  : sql`(${this.mappedFormulaValues.get(source.id) ?? sql`'{}'::jsonb`} -> ${ident(side, '__id')})`
                : source.type === 'number'
                  ? columnRef(source, side)
                  : selectExpr(source, side);
            const json =
              (field.type === 'json' && source.type !== 'json') ||
              (field.type === 'text' && source.type === 'formula' && source.formula?.type === 'number')
                ? sql`to_jsonb((${raw})::text)`
                : sql`to_jsonb(${raw})`;
            return sql`(SELECT NULLIF(NULLIF(NULLIF(${json}, 'null'::jsonb), '""'::jsonb), '[]'::jsonb)
            FROM ${ident(this.schemas.data, source.tableId)} ${ident(side)}
            WHERE ${ident(side, '__id')} = ${origins} ->> ${source.tableId}
              AND ${ident(side, '__deleted_at')} IS NULL AND NOT ${ident(side, '__source_gone')}
              AND (${this.recordPredicate(source.tableId, side)}))`;
          });
          const value =
            values.length > 1 ? sql`COALESCE(${join(values, ', ')})` : (values[0] ?? sql`NULL::jsonb`);
          // Pins may have been copied from a source this reader cannot see.
          const stored = alias ? ident(alias, '__overrides') : ident('__overrides');
          const pinned =
            complete && !field.ignoreOverride
              ? sql`CASE WHEN ${stored} ? ${field.id} THEN to_jsonb(${alias ? ident(alias, field.columnName) : ident(field.columnName)}) ELSE ${value} END`
              : value;
          return jsonValueExpr(field, pinned);
        },
      };
    }
    const relation = field.relation;
    if (relation) {
      const linked = relation.linkedTableId;
      const limited = this.limitsRecords(linked);
      result = {
        ...result,
        relation: {
          ...relation,
          ...(relation.primary
            ? { primary: this.scoped(prepared, relation.primary, memo, seen, loaded) }
            : {}),
          ...(relation.target ? { target: this.scoped(prepared, relation.target, memo, seen, loaded) } : {}),
          ...(relation.conditionFields
            ? {
                conditionFields: relation.conditionFields.map((item) =>
                  this.scoped(prepared, item, memo, seen, loaded),
                ),
              }
            : {}),
          ...(limited ? { scope: (alias: string) => this.linkedPredicate(linked, alias) } : {}),
        },
      };
    }
    if (field.lineColumns)
      result = {
        ...result,
        lineColumns: field.lineColumns
          .filter((column) => !this.hides(prepared, column))
          .map((column) => this.scoped(prepared, column, memo, seen, loaded)),
      };
    if (result.type === 'lineItems' && result.lineColumns) {
      const visible = new Set(result.lineColumns.map((column) => column.id));
      result = {
        ...result,
        options: {
          ...result.options,
          columns: result.options.columns.filter((column) => visible.has(column.id)),
        },
      };
    }
    if (field.formula) {
      result = {
        ...result,
        formula: {
          ...field.formula,
          scope: (tableId, alias) => this.linkedPredicate(tableId, alias),
          fields: field.formula.fields.map((dependency) =>
            this.scoped(prepared, dependency, memo, seen, loaded),
          ),
        },
      };
    }
    if (
      result.formula?.fields.some((dependency) => dependency.joinedPartial) ||
      result.relation?.target?.joinedPartial
    )
      result = { ...result, joinedPartial: true, ignoreOverride: true };
    if (field.historyFields)
      result = {
        ...result,
        historyFields: field.historyFields
          .filter((item) => !this.hides(prepared, item))
          .map((item) => {
            // Unrestricted databases have no prepared definitions.  Use loaded fields, and keep
            // unresolved history metadata out of the memo shared with live dependencies.
            const resolved = loaded.get(item.id) ?? prepared.fields.get(item.id);
            return this.scoped(
              prepared,
              resolved ?? item,
              resolved ? memo : new Map(memo),
              new Set(seen),
              loaded,
            );
          })
          .filter((item) => !item.joinedPartial),
      };
    memo.set(field.id, result);
    return result;
  }

  /**
   * Whether the actor sees every record and every field of a table.  A whole copy of a database,
   * such as a snapshot or a duplicate, needs this for every table, since a copy that left out what
   * one person may not see would be a different database.
   */
  readsEverything<F extends { id: string }>(
    tableId: string,
    fields: readonly F[],
    options: { retainExternalReferences?: boolean } = {},
  ): boolean {
    const prepared = this.forTable(tableId);
    // A duplicate retains external field definitions, but reads their values through normal scopes.
    const boundary = options.retainExternalReferences
      ? {
          databaseId: prepared.databaseId,
          hidden: hiddenClosure(
            prepared.known,
            prepared.primaries,
            prepared.fieldRules,
            this.person(prepared),
            limitedTables(prepared),
            prepared.joined,
            prepared.linkLimits,
          ),
        }
      : undefined;
    if (fields.some((field) => this.classifiedHidden(prepared, field.id))) return false;
    if (limitedTables(prepared).has(tableId)) return false;
    return fields.every(
      (field) =>
        !this.hides(prepared, field as unknown as StoredField, new Set(), boundary) &&
        !this.readsLimitedDependency(field as unknown as StoredField, new Set(), boundary?.databaseId),
    );
  }

  private readsLimitedDependency(field: StoredField, seen = new Set<string>(), boundary?: string): boolean {
    if (boundary && field.tableId && this.forTable(field.tableId).databaseId !== boundary) return false;
    if (seen.has(field.id)) return false;
    seen.add(field.id);
    const mapping = field.tableId
      ? this.forTable(field.tableId)
          .joined.get(field.tableId)
          ?.fields.find((item) => item.outputFieldId === field.id)
      : undefined;
    if (
      mapping?.sources &&
      mapping.sources.some((source) => {
        const known = this.knownField(source.fieldId);
        return (
          !known ||
          this.hides(this.forTable(known.tableId), known) ||
          this.readsLimitedDependency(known, new Set(seen), boundary)
        );
      })
    )
      return true;
    const linked = field.relation?.linkedTableId;
    const ownership = linked ? this.forTable(linked).lineItems.get(linked) : undefined;
    if (
      field.relation &&
      (!boundary || this.forTable(field.relation.linkedTableId).databaseId === boundary) &&
      this.limitsRecords(ownership?.parentTableId ?? field.relation.linkedTableId)
    )
      return true;
    return nestedDependencies(field).some((dependency) =>
      this.readsLimitedDependency(dependency, seen, boundary),
    );
  }

  /**
   * Whether a rule hides any of the database's fields from anyone.  What leaves the organization
   * without a person's own access, such as a report to an outside address, is refused when one
   * does.
   */
  async restrictsFields(databaseId: string): Promise<boolean> {
    await this.prepare(databaseId);
    return [...this.forDatabase(databaseId).fieldRules.values()].some((rule) => rule.restricted !== null);
  }

  /** Whether the database has any field or record rule at all. */
  async hasRules(databaseId: string): Promise<boolean> {
    await this.prepare(databaseId);
    const prepared = this.forDatabase(databaseId);
    return prepared.fieldRules.size > 0 || prepared.recordRules.size > 0;
  }

  /**
   * Whether links tie the database to another one.  Its links, lookups, rollups, and counts may then
   * read that database's records, whose roles and rules apply even when this one has no rule.
   */
  readsOtherDatabases(databaseId: string): boolean {
    return this.forDatabase(databaseId).related.length > 1;
  }

  /**
   * Every field worked out from one of these, however many steps away, with its table: the
   * formulas, lookups, rollups, counts, and links that read it, in each database read so far.
   * Trashed fields count, since they come back reading what they read before.
   */
  computedFrom(fieldIds: Iterable<string>): Map<string, string> {
    const databases = [...this.prepared.values()];
    const primaries = new Map(databases.flatMap((database) => [...database.primaries]));
    const dependents = new Map<string, StoredField[]>();
    for (const database of databases)
      for (const field of database.known.values())
        for (const id of [
          ...joinedFieldDependencies(field.id, database.joined.get(field.tableId)),
          ...dependencyIds(field, primaries, database.linkLimits),
        ])
          dependents.set(id, [...(dependents.get(id) ?? []), field]);
    const found = new Map<string, string>();
    const queue = [...fieldIds];
    while (queue.length)
      for (const dependent of dependents.get(queue.pop()!) ?? [])
        if (!found.has(dependent.id)) {
          found.set(dependent.id, dependent.tableId);
          queue.push(dependent.id);
        }
    return found;
  }

  /**
   * Whether the actor may change a field's values: they can see it, and its lock, if any, names
   * them.  Their role still has to allow editing records, which the command bus checks first.
   */
  canEditField(tableId: string, field: StoredField): boolean {
    // Only Riosoma writes a managed field, such as a payment result, whoever the person is.
    if (field.managed) return false;
    const prepared = this.forTable(tableId);
    const ownership = prepared.lineItems.get(tableId);
    if (ownership) {
      const parent = prepared.known.get(ownership.parentFieldId);
      if (!parent || !this.canEditField(ownership.parentTableId, parent)) return false;
    }
    if (this.classifiedHidden(prepared, field.id)) return false;
    if (this.hides(prepared, field)) return false;
    if (prepared.owner) return true;
    const locked = prepared.fieldRules.get(field.id)?.locked;
    return !locked || audienceNames(locked, this.person(prepared));
  }

  /** Schema rewrites honor the presence of a lock, including for people its audience allows. */
  fieldLocked(tableId: string, field: StoredField): boolean {
    return Boolean(field.managed || this.forTable(tableId).fieldRules.get(field.id)?.locked);
  }

  /** Whether a field is restricted from anyone at all, or computed from one that is. */
  restrictedForAnyone(tableId: string, field: StoredField): boolean {
    const parent = this.forTable(tableId);
    const restricted = (candidate: StoredField, seen: Set<string>): boolean => {
      const prepared = candidate.tableId ? this.forTable(candidate.tableId) : parent;
      if (prepared.fieldRules.get(candidate.id)?.restricted) return true;
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      const known = prepared.known.get(candidate.id) ?? candidate;
      const mapping = prepared.joined
        .get(known.tableId)
        ?.fields.find((item) => item.outputFieldId === candidate.id);
      if (
        mapping?.sources &&
        mapping.sources.every((source) => {
          const field = prepared.known.get(source.fieldId);
          return !field || restricted(field, new Set(seen));
        })
      )
        return true;
      const dependencies = [
        ...storedMappingDependencies(known, prepared.known, prepared.primaries, prepared.joined).flatMap(
          (id) => this.knownField(id) ?? [],
        ),
        ...joinedFieldDependencies(candidate.id, prepared.joined.get(known.tableId)).flatMap(
          (id) => prepared.known.get(id) ?? [],
        ),
        ...nestedDependencies(candidate),
        ...dependencyIds(known, prepared.primaries, prepared.linkLimits).flatMap(
          (id) => this.knownField(id) ?? [],
        ),
      ];
      return dependencies.some((dependency) => restricted(dependency, seen));
    };
    return restricted(field, new Set());
  }

  /** The IDs of fields hidden from the actor, optionally within one table. */
  hiddenFieldIds(databaseId: string, tableId?: string): ReadonlySet<string> {
    const prepared = this.forDatabase(databaseId);
    const hidden = new Set([
      ...prepared.hidden,
      ...[...prepared.classification.fields.keys()].filter((id) => this.classifiedHidden(prepared, id)),
      ...[...prepared.known.values()].filter((field) => this.hides(prepared, field)).map((field) => field.id),
    ]);
    return tableId
      ? new Set([...hidden].filter((id) => prepared.known.get(id)?.tableId === tableId))
      : hidden;
  }

  /** Whether any rule limits what the actor sees in the database. */
  limited(databaseId: string): boolean {
    const prepared = this.forDatabase(databaseId);
    return [databaseId, ...prepared.related.filter((id) => id !== databaseId)].some((id) => {
      const database = this.forDatabase(id);
      return roleless(database) || this.hiddenFieldIds(id).size > 0 || limitedTables(database).size > 0;
    });
  }

  /** Whether any rule limits what the actor sees in the database that holds the table. */
  limitedFor(tableId: string): boolean {
    return this.limited(this.forTable(tableId).databaseId);
  }

  /**
   * A short summary of everything the rules decide for this person in a database, so a realtime
   * connection can tell when a rule change means its tab has to reload.
   */
  async fingerprint(databaseId: string): Promise<string> {
    await this.prepare(databaseId);
    const root = this.forDatabase(databaseId);
    return JSON.stringify(
      [databaseId, ...root.related.filter((id) => id !== databaseId)].map((id) => {
        const prepared = this.forDatabase(id);
        const person = this.person(prepared);
        return [
          id,
          this.actor.kind,
          prepared.role,
          // Unrestricted columns arrive as schema changes, rather than changing anyone's access.
          [...prepared.classification.fields]
            .filter(([, rules]) => Object.values(rules).some(Boolean))
            .sort(([left], [right]) => left.localeCompare(right)),
          [...this.hiddenFieldIds(id)].sort(),
          [...prepared.fieldRules.values()].map((rule) => [
            rule.fieldId,
            rule.restricted !== null,
            rule.locked !== null,
            prepared.owner || !rule.locked || audienceNames(rule.locked, person),
          ]),
          [...prepared.recordRules.entries()].map(([tableId, rules]) => [
            tableId,
            rules.map((rule) => [
              rule.id,
              rule.condition,
              prepared.applicable.get(tableId)?.includes(rule) ?? false,
            ]),
          ]),
        ];
      }),
    );
  }

  /** Databases whose committed permissions this scope uses, including linked destinations. */
  dependsOnDatabase(databaseId: string): boolean {
    return this.prepared.has(databaseId);
  }

  /** Foreign values and metadata can change without advancing the source database's sequence. */
  dependencyFingerprint(databaseId: string): string {
    return JSON.stringify(
      this.forDatabase(databaseId)
        .related.filter((id) => id !== databaseId)
        .map((id) => {
          const prepared = this.forDatabase(id);
          return [id, roleless(prepared) ? null : prepared.dataFingerprint];
        }),
    );
  }

  /**
   * The key the snapshot cache keeps a reader's orders under.  People no rule limits share one,
   * and anyone else gets their own, since a lookup, a sort, or a filter may read differently for them.
   */
  accessKey(tableId: string): string {
    const prepared = this.forTable(tableId);
    if (this.publicRead) return `public:${[...this.hiddenFieldIds(prepared.databaseId)].sort().join(',')}`;
    if (prepared.related.length > 1 && this.limited(prepared.databaseId))
      return `person:${this.actor.userId}:${this.actor.dataUse ?? 'read'}:${[...this.hiddenFieldIds(prepared.databaseId)].sort().join(',')}`;
    if ([...prepared.classification.fields.keys()].some((id) => this.classifiedHidden(prepared, id)))
      return `person:${this.actor.userId}:${this.actor.dataUse ?? 'read'}:${[...this.hiddenFieldIds(prepared.databaseId)].sort().join(',')}`;
    if (prepared.owner || (!prepared.applicable.size && !prepared.hidden.size)) return 'all';
    return `person:${this.actor.userId}`;
  }

  /** What a schema read tells the actor about their own access, or undefined when no rule exists. */
  schemaAccess(
    databaseId: string,
    fields: readonly StoredField[],
    canChange: boolean,
  ): SchemaAccess | undefined {
    const prepared = this.forDatabase(databaseId);
    const managed = fields.some((field) => field.managed);
    if (
      !prepared.fieldRules.size &&
      !prepared.recordRules.size &&
      !managed &&
      !this.hiddenFieldIds(databaseId).size
    )
      return undefined;
    const person = this.person(prepared);
    return {
      hiddenFields: fields
        .filter((field) => this.hides(prepared, field))
        .map((field) => ({ id: field.id, tableId: field.tableId, position: field.position })),
      // A managed field reads as locked for everyone, owners included.
      fields: fields
        .filter(
          (field) => (prepared.fieldRules.has(field.id) || field.managed) && !this.hides(prepared, field),
        )
        .map((field) => {
          const rule = prepared.fieldRules.get(field.id);
          return {
            fieldId: field.id,
            restricted: Boolean(rule?.restricted),
            locked: Boolean(field.managed || rule?.locked),
            editable:
              !field.managed && (prepared.owner || !rule?.locked || audienceNames(rule.locked, person)),
          };
        }),
      limitedTables: [...prepared.applicable.keys()],
      ruledTables: canChange ? [...prepared.recordRules.keys()] : [],
    };
  }
}

/**
 * A missing grant denies every record, including in databases without record rules.
 */
function roleless(prepared: Prepared): boolean {
  return prepared.role === null;
}

/** The tables whose records a record rule limits for the person, by ID. */
function limitedTables(prepared: Prepared): ReadonlySet<string> {
  if (prepared.owner) return new Set();
  if (roleless(prepared)) return prepared.tableIds;
  const limited = new Set(prepared.applicable.keys());
  for (let pass = 0; pass < prepared.joined.size; pass++)
    for (const [id, joined] of prepared.joined)
      if (
        [joined.baseTableId, ...joined.steps.map((step) => step.tableId)].some((input) => limited.has(input))
      )
        limited.add(id);
  return limited;
}

/**
 * The fields of a database's tables, trashed ones too, as `known`, and those not trashed as
 * `fields`.
 */
async function databaseFields(
  db: Queryable,
  schemas: DataSchemas,
  tableIds: readonly string[],
): Promise<{ fields: Map<string, StoredField>; known: Map<string, StoredField> }> {
  const all = await loadFields(db, schemas, tableIds, { includeTrashed: true });
  const trashed = await query<{ id: string }>(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'fields')}
         WHERE table_id = ANY(${tableIds}::text[]) AND trashed_at IS NOT NULL`,
  );
  const gone = new Set(trashed.rows.map((row) => row.id));
  return {
    fields: new Map(all.filter((field) => !gone.has(field.id)).map((field) => [field.id, field])),
    known: new Map(all.map((field) => [field.id, field])),
  };
}

/** What an AI field's prompt reads, as `promptReads` works it out. */
export interface PromptReads {
  /** The tables whose records it reads through a link, lookup, rollup, or count */
  tables: Set<string>;
  /** Every field it reads, directly or through another, by ID, whether or not it was found */
  fields: Set<string>;
  /** Whether a field it reads couldn't be found, or a formula no longer parses, so what it read can't be told */
  unresolved: boolean;
}

/**
 * What an AI field's prompt reads: the fields it names, and whatever those read in turn, such as a
 * lookup's link and target, a formula's references, the names a link shows, or another AI field's
 * prompt, and the linked tables of the links, lookups, rollups, and counts among them.  `find`
 * looks a field up by ID, trashed ones included, since what a trashed field held is still in the
 * values the prompt's runs wrote, and a field's resolved relations fill in any it can't.
 * `primaries` names each table's primary field, for a link whose relation wasn't resolved, such as
 * one in the trash.
 */
export function promptReads(
  prompt: string,
  find: (id: string) => StoredField | undefined,
  primaries: ReadonlyMap<string, string | null>,
): PromptReads {
  const tables = new Set<string>();
  const fields = new Set<string>();
  let unresolved = false;
  const visit = (id: string, nested?: StoredField): void => {
    if (fields.has(id)) return;
    fields.add(id);
    const field = find(id) ?? nested;
    if (!field) {
      unresolved = true;
      return;
    }
    if (field.ai) for (const read of templateFieldIds(field.ai.prompt)) visit(read);
    const relation = field.relation;
    switch (field.type) {
      case 'lineItems':
      case 'link': {
        const linked = field.options.linkedTableId;
        tables.add(linked);
        // A link reads as its linked records' names, which their primary field holds.
        if (relation?.primary) visit(relation.primary.id, relation.primary);
        else if (!primaries.has(linked)) unresolved = true;
        else {
          const primary = primaries.get(linked);
          if (primary) visit(primary);
        }
        break;
      }
      case 'lookup':
      case 'rollup':
      case 'count':
        visit(field.options.linkFieldId);
        if (relation) tables.add(relation.linkedTableId);
        if (field.type !== 'count') visit(field.options.targetFieldId, relation?.target);
        break;
      case 'formula': {
        // The expression names what it read even when one of those is gone or in the trash, which
        // leaves the formula's resolved fields empty.
        const nested = new Map(
          (field.formula?.fields ?? []).map((dependency) => [dependency.id, dependency]),
        );
        const named = expressionFieldIds(field.options.expression);
        if (!named) unresolved = true;
        for (const read of new Set([...(named ?? []), ...nested.keys()])) visit(read, nested.get(read));
        break;
      }
      default:
        break;
    }
  };
  for (const id of templateFieldIds(prompt)) visit(id);
  return { tables, fields, unresolved };
}

function isStored(field: { id: string }): field is StoredField {
  return 'type' in field && 'tableId' in field && 'options' in field;
}

/**
 * The fields a field's value is computed from, by ID: a formula's references (and, for a link or a
 * lookup of one it reads by name, the primary field that names those records), a lookup's or
 * rollup's link and target, a count's link, a link's other side, the fields a matched link
 * follows, and the primary field that names its records, the fields a button's link fills in, and
 * the fields an AI field's prompt reads.  `limits` adds, for a link limited to a view, the fields
 * that view's filter reads.
 */
function dependencyIds(
  field: StoredField,
  primaries: ReadonlyMap<string, string | null> = new Map(),
  limits: ReadonlyMap<string, readonly string[]> = new Map(),
): string[] {
  const ids: string[] = [
    ...relationalReads(field),
    ...(limits.get(field.id) ?? []),
    ...(field.ai ? templateFieldIds(field.ai.prompt) : []),
  ];
  switch (field.type) {
    case 'singleSelect':
    case 'multipleSelect': {
      if (field.options.cascade) ids.push(field.options.cascade.fieldId);
      const source = field.options.source;
      if (source) {
        const label = source.fieldId ?? primaries.get(source.tableId);
        if (label) ids.push(label);
        ids.push(...relationalConditions(source.filter).map((condition) => condition.fieldId));
      }
      break;
    }
    case 'formula':
      // What the expression names counts too, in case one of those is in the trash.
      ids.push(...(expressionFieldIds(field.options.expression) ?? []));
      for (const dependency of field.formula?.fields ?? []) {
        ids.push(dependency.id);
        ids.push(...namesFrom(dependency));
      }
      break;
    case 'lookup':
    case 'rollup':
      ids.push(field.options.linkFieldId, field.options.targetFieldId);
      break;
    case 'count':
      ids.push(field.options.linkFieldId);
      break;
    case 'lineItems':
    case 'link':
      if (field.options.inverseFieldId) ids.push(field.options.inverseFieldId);
      if (field.options.match) ids.push(field.options.match.fieldId, field.options.match.linkedFieldId);
      if (field.relation?.primary) ids.push(field.relation.primary.id);
      break;
    case 'button':
      if ('urlTemplate' in field.options.action)
        ids.push(...templateFieldIds(field.options.action.urlTemplate));
      break;
    default:
      break;
  }
  return ids;
}

/** The primary fields whose values name what a link, or a lookup of one, holds. */
function namesFrom(field: StoredField, seen = new Set<string>()): string[] {
  if (seen.has(field.id)) return [];
  seen.add(field.id);
  if (field.type === 'link' || field.type === 'lineItems')
    return field.relation?.primary ? [field.relation.primary.id] : [];
  if (field.type === 'lookup' && field.relation?.target) return namesFrom(field.relation.target, seen);
  return [];
}

/** The same dependencies, as the field objects a loaded field carries with it. */
function nestedDependencies(field: StoredField): StoredField[] {
  const out: StoredField[] = [];
  if (!isStored(field)) return out;
  if (field.type === 'formula') {
    for (const dependency of field.formula?.fields ?? []) {
      out.push(dependency);
      let named: StoredField | undefined = dependency;
      const seen = new Set<string>();
      while (named && !seen.has(named.id)) {
        seen.add(named.id);
        if (named.type === 'link' || named.type === 'lineItems') {
          if (named.relation?.primary) out.push(named.relation.primary);
          break;
        }
        named = named.type === 'lookup' ? named.relation?.target : undefined;
      }
    }
  }
  if (field.relation?.target) out.push(field.relation.target);
  if (field.relation?.conditionFields) out.push(...field.relation.conditionFields);
  if ((field.type === 'link' || field.type === 'lineItems') && field.relation?.primary)
    out.push(field.relation.primary);
  if (field.relation?.match) out.push(field.relation.match.field, field.relation.match.linked);
  return out;
}

/** Stored generated values cannot recompute after a reader loses one of a mapping's sources. */
function storedMappingDependencies(
  field: StoredField,
  fields: ReadonlyMap<string, StoredField>,
  primaries: ReadonlyMap<string, string | null>,
  joined: ReadonlyMap<string, JoinedTable>,
): string[] {
  if (!field.ai) return [];
  const reads = promptReads(field.ai.prompt, (id) => fields.get(id), primaries);
  const sources = new Set<string>();
  const pending = [...reads.fields];
  while (pending.length) {
    const id = pending.pop()!;
    const candidate = fields.get(id);
    const mapping =
      candidate && joined.get(candidate.tableId)?.fields.find((item) => item.outputFieldId === id);
    for (const source of mapping ? joinedSources(mapping) : [])
      if (!sources.has(source.fieldId)) {
        sources.add(source.fieldId);
        pending.push(source.fieldId);
      }
  }
  return [...sources];
}

/** A projected value also reveals its matching keys, even when those keys are not projected. */
function joinedFieldDependencies(fieldId: string, joined: JoinedTable | undefined): string[] {
  const mapping = joined?.fields.find((field) => field.outputFieldId === fieldId);
  return mapping
    ? [
        ...(mapping.sources ? [] : [mapping.fieldId]),
        ...joined!.steps.flatMap((step) => [step.leftFieldId, step.rightFieldId]),
      ]
    : [];
}

/**
 * Every field hidden from a person: those restricted from them, and AI fields whose prompts read
 * records of a table in `limited` through a relation, or read something that can no longer be
 * worked out while `limited` holds any table, then everything computed from one of those, until
 * nothing more is.  `fields` holds trashed fields too, which still count.  A link and its other
 * side stand or fall together, since each lists it as a dependency and each shows the same links.
 */
function hiddenClosure(
  fields: ReadonlyMap<string, StoredField>,
  primaries: ReadonlyMap<string, string | null>,
  rules: ReadonlyMap<string, StoredFieldRules>,
  person: { userId: string; role: DatabaseRole | null },
  limited: ReadonlySet<string>,
  joined: ReadonlyMap<string, JoinedTable>,
  limits: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const hidden = new Set<string>();
  for (const rule of rules.values())
    if (rule.restricted && !audienceNames(rule.restricted, person)) hidden.add(rule.fieldId);
  if (limited.size)
    for (const field of fields.values()) {
      if (!field.ai) continue;
      const reads = promptReads(field.ai.prompt, (id) => fields.get(id), primaries);
      if (reads.unresolved || [...reads.tables].some((id) => limited.has(id))) hidden.add(field.id);
    }
  // A stored relation cannot be recomputed through a limited reader's linked record scope.
  const unavailable = (id: string) => {
    const source = fields.get(id);
    return (
      !source ||
      hidden.has(id) ||
      (limited.size > 0 && isComputedType(source.type)) ||
      ((source.type === 'link' || source.type === 'lineItems') && limited.has(source.options.linkedTableId))
    );
  };
  for (const settings of joined.values())
    for (const mapping of settings.fields)
      if (joinedSources(mapping).every((source) => unavailable(source.fieldId)))
        hidden.add(mapping.outputFieldId);
  if (!hidden.size) return hidden;
  const dependents = new Map<string, string[]>();
  for (const field of fields.values())
    for (const id of [
      ...joinedFieldDependencies(field.id, joined.get(field.tableId)),
      ...storedMappingDependencies(field, fields, primaries, joined),
      ...dependencyIds(field, primaries, limits),
    ])
      dependents.set(id, [...(dependents.get(id) ?? []), field.id]);
  const queue = [...hidden];
  while (queue.length) {
    for (const settings of joined.values())
      for (const mapping of settings.fields)
        if (
          !hidden.has(mapping.outputFieldId) &&
          joinedSources(mapping).every((source) => unavailable(source.fieldId))
        ) {
          hidden.add(mapping.outputFieldId);
          queue.push(mapping.outputFieldId);
        }
    const id = queue.pop()!;
    for (const dependent of dependents.get(id) ?? [])
      if (!hidden.has(dependent)) {
        hidden.add(dependent);
        queue.push(dependent);
      }
  }
  return hidden;
}

/** A condition's values with "the current person" put in as the person reading. */
function withPerson(condition: FilterCondition, userId: string): FilterCondition {
  const value = condition.value;
  if (value === CURRENT_PERSON) return { ...condition, value: userId || undefined };
  if (Array.isArray(value))
    return {
      ...condition,
      value: value.map((item) => (item === CURRENT_PERSON ? userId : item)).filter(Boolean),
    };
  return condition;
}

/** A whole condition with "the current person" put in as the person reading. */
function withPersonGroup(group: FilterGroup, userId: string): FilterGroup {
  return {
    conjunction: group.conjunction,
    conditions: group.conditions.map((item) =>
      isGroup(item) ? withPersonGroup(item, userId) : withPerson(item, userId),
    ),
  };
}

/**
 * A record rule's condition as SQL, strictly: anything that can't be read (a field that's gone, an
 * operator it no longer offers, a value still missing, a formula only JavaScript computes, or a
 * group with nothing in it) matches no record, where a view's filter would leave it out and match
 * every record.  Rule conditions read every value as it is, not as the reader sees it, so a rule
 * never depends on another rule.
 */
function ruleCondition(
  group: FilterGroup,
  fields: ReadonlyMap<string, StoredField>,
  context: ReadContext,
  appSchema: string,
  alias: string | undefined,
  userId: string,
): Sql {
  const parts: Sql[] = [];
  for (const item of group.conditions) {
    if (isGroup(item)) {
      parts.push(ruleCondition(item, fields, context, appSchema, alias, userId));
      continue;
    }
    const condition = withPerson(item, userId);
    const field = fields.get(condition.fieldId);
    if (
      !field ||
      !operatorsForField(field).includes(condition.operator) ||
      !checkCondition(field, condition).usable ||
      (field.type === 'formula' && !field.options.sortable)
    ) {
      parts.push(FALSE);
      continue;
    }
    try {
      const compiled = compileFilter(
        { conjunction: 'and', conditions: [condition] },
        fields,
        context,
        appSchema,
        alias,
      );
      parts.push(compile(compiled).text.trim() === 'TRUE' ? FALSE : compiled);
    } catch {
      parts.push(FALSE);
    }
  }
  if (!parts.length) return FALSE;
  return sql`(${join(parts, group.conjunction === 'and' ? ' AND ' : ' OR ')})`;
}
