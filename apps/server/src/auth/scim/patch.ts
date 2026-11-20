import { booleanOf, invalidPath, invalidValue, noTarget, ScimError } from './errors.js';
import { attribute, matches, parseFilter, type Filter, type ValueParent } from './filter.js';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** The most members a group may have, and the most member values one PATCH may carry */
export const MEMBER_LIMIT = 10_000;
/** The most email addresses a person may have */
export const EMAIL_LIMIT = 100;
/**
 * The most comparisons the value filters of one PATCH may make: each filtered operation costs
 * its comparisons times the values it reads.  Directories send one comparison per filter.
 */
export const FILTER_WORK_LIMIT = 1_000_000;

type ObjectValue = Record<string, unknown>;
export type ResourceKind = 'Users' | 'Groups';

const USER_FIELDS = ['userName', 'externalId', 'displayName', 'active', 'name', 'emails', ENTERPRISE_SCHEMA];
const GROUP_FIELDS = ['displayName', 'externalId', 'members'];
const READ_ONLY = new Set(['id', 'meta', 'schemas']);
const SUBFIELDS: Record<string, readonly string[]> = {
  name: ['givenName', 'familyName', 'formatted'],
  emails: ['value', 'type', 'primary', 'display'],
  members: ['value', 'display', 'type', '$ref'],
  [ENTERPRISE_SCHEMA]: ['department', 'manager', 'employeeNumber'],
};

export function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function known(name: string, fields: readonly string[]): string | undefined {
  return fields.find((field) => field.toLowerCase() === name.toLowerCase());
}

interface Path {
  field: string;
  child?: string;
  grandchild?: string;
  filter?: Filter;
}

/**
 * Schema prefixes contain colons and periods, so strip them before parsing the attribute path.
 * A path that doesn't parse is refused.  One that names an attribute Riosoma doesn't store gives
 * null, and the operation is skipped, the way POST and PUT drop such attributes.  Read-only
 * attributes are skipped inside a path-less value and refused as a path.
 */
function parsePath(source: string, kind: ResourceKind, pathless: boolean): Path | null {
  let path = source;
  const core = kind === 'Users' ? USER_SCHEMA : GROUP_SCHEMA;
  if (path.toLowerCase().startsWith(`${core.toLowerCase()}:`)) path = path.slice(core.length + 1);
  if (READ_ONLY.has(path.toLowerCase())) {
    if (pathless) return null;
    throw new ScimError(400, 'scim.errors.mutability', 'mutability');
  }
  if (kind === 'Users' && path.toLowerCase() === ENTERPRISE_SCHEMA.toLowerCase()) {
    return { field: ENTERPRISE_SCHEMA };
  }
  if (path.toLowerCase().startsWith(`${ENTERPRISE_SCHEMA.toLowerCase()}:`)) {
    if (kind !== 'Users') return null;
    const suffix = path.slice(ENTERPRISE_SCHEMA.length + 1).split('.');
    if (suffix.length > 2 || !suffix.every((part) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(part))) invalidPath();
    const child = known(suffix[0]!, SUBFIELDS[ENTERPRISE_SCHEMA]!);
    if (!child) return null;
    if (!suffix[1]) return { field: ENTERPRISE_SCHEMA, child };
    const grandchild = child === 'manager' ? known(suffix[1], ['value', 'displayName']) : undefined;
    return grandchild ? { field: ENTERPRISE_SCHEMA, child, grandchild } : null;
  }
  // Another schema's extension, such as a directory's custom attributes, isn't stored either.
  if (/^urn:[A-Za-z0-9:._-]+$/i.test(path)) return null;
  const match =
    /^([A-Za-z][A-Za-z0-9_-]*)(?:\[((?:[^"\]]|"(?:[^"\\]|\\.)*")+)\])?(?:\.([A-Za-z$][A-Za-z0-9_-]*))?$/.exec(
      path,
    );
  if (!match) invalidPath();
  const field = known(match[1]!, kind === 'Users' ? USER_FIELDS : GROUP_FIELDS);
  if (!field) return null;
  if (match[2] && field !== 'emails' && field !== 'members') invalidPath();
  let filter: Filter | undefined;
  if (match[2]) {
    try {
      filter = parseFilter(match[2], field as ValueParent);
    } catch {
      invalidPath();
    }
  }
  if (!match[3]) return { field, ...(filter ? { filter } : {}) };
  const child = known(match[3], SUBFIELDS[field] ?? []);
  return child ? { field, child, ...(filter ? { filter } : {}) } : null;
}

/**
 * A complex value with the sub-attributes the change names replaced or added, and the rest left
 * unchanged, as RFC 7644 section 3.5.2.3 says.  Names ignore case, and keep the spelling stored.
 */
function merge(current: ObjectValue, value: ObjectValue): ObjectValue {
  const result: ObjectValue = { ...current };
  for (const [key, item] of Object.entries(value)) {
    const stored = Object.keys(result).find((name) => name.toLowerCase() === key.toLowerCase());
    const previous = stored === undefined ? undefined : result[stored];
    result[stored ?? key] = object(previous) && object(item) ? merge(previous, item) : structuredClone(item);
  }
  return result;
}

function write(target: ObjectValue, key: string, value: unknown, op: string): void {
  if (op === 'remove') {
    delete target[key];
    return;
  }
  if (op === 'add' && Array.isArray(target[key])) {
    target[key] = [...target[key], ...(Array.isArray(value) ? value : [value])];
  } else if (object(target[key]) && object(value)) {
    target[key] = merge(target[key], value);
  } else {
    target[key] = structuredClone(value);
  }
}

/** How many comparisons one pass of a filter makes over one value */
function comparisons(filter: Filter): number {
  if (filter.kind === 'comparison') return 1;
  if (filter.kind === 'valuePath') return comparisons(filter.filter);
  return comparisons(filter.left) + comparisons(filter.right);
}

/** What the PATCH's filters may still spend, charged before each one runs */
interface Budget {
  left: number;
}

/** The value a filter of equalities describes, such as `{ type: 'work' }` for `type eq "work"` */
function described(filter: Filter, fields: readonly string[]): ObjectValue | null {
  if (filter.kind === 'and') {
    const left = described(filter.left, fields);
    const right = described(filter.right, fields);
    return left && right ? { ...left, ...right } : null;
  }
  if (filter.kind !== 'comparison' || filter.operator !== 'eq' || filter.value === null) return null;
  const key = known(filter.path, fields);
  return key ? { [key]: filter.value } : null;
}

function apply(target: ObjectValue, path: Path, value: unknown, op: string, budget: Budget): void {
  if (!path.filter && !path.child) {
    // Some directory clients send removed member IDs in value instead of a path filter.
    if (path.field === 'members' && op === 'remove' && value !== undefined) {
      if (!Array.isArray(value) || value.some((entry) => typeof attribute(entry, 'value') !== 'string'))
        invalidValue();
      const removed = new Set(value.map((entry) => attribute(entry, 'value')));
      target.members = (Array.isArray(target.members) ? target.members : []).filter(
        (entry) => !removed.has(attribute(entry, 'value')),
      );
      return;
    }
    if (
      path.field === 'emails' &&
      op === 'add' &&
      Array.isArray(value) &&
      value.some((entry) => booleanOf(attribute(entry, 'primary')) === true)
    ) {
      const existing = target.emails;
      if (Array.isArray(existing)) for (const entry of existing) if (object(entry)) entry.primary = false;
    }
    write(target, path.field, value, op);
    return;
  }
  if (path.field === 'emails' || path.field === 'members') {
    const fields = SUBFIELDS[path.field]!;
    let values: unknown[] = Array.isArray(target[path.field]) ? (target[path.field] as unknown[]) : [];
    if (path.filter) {
      budget.left -= comparisons(path.filter) * values.length;
      if (budget.left < 0) invalidValue();
    }
    // A Set keeps selection linear however many values match.
    const selected = new Set(values.filter((entry) => !path.filter || matches(path.filter, entry)));
    if (path.filter && selected.size === 0) {
      // Only a replace needs a target.  A remove of nothing succeeds, and an add creates the value
      // its filter describes, such as the work address for `emails[type eq "work"].value`.
      if (op === 'replace') noTarget();
      const entry = op === 'add' ? described(path.filter, fields) : null;
      if (!entry) return;
      values = [...values, entry];
      target[path.field] = values;
      selected.add(entry);
    }
    if (op === 'remove' && !path.child) {
      target[path.field] = values.filter((entry) => !selected.has(entry));
      return;
    }
    for (const entry of selected) {
      if (!object(entry)) invalidValue();
      if (path.child) write(entry, path.child, value, op);
      else if (object(value)) {
        for (const [key, item] of Object.entries(value)) {
          const field = known(key, fields);
          if (field) write(entry, field, item, op);
        }
      } else invalidValue();
    }
    if (
      path.field === 'emails' &&
      op !== 'remove' &&
      ((path.child === 'primary' && booleanOf(value) === true) ||
        (!path.child && booleanOf(attribute(value, 'primary')) === true))
    ) {
      for (const entry of values) if (object(entry) && !selected.has(entry)) entry.primary = false;
    }
    return;
  }
  const current = target[path.field];
  if (!object(current)) {
    if (op === 'remove') return;
    target[path.field] = {};
  }
  const parent = target[path.field] as ObjectValue;
  if (path.grandchild) {
    if (!object(parent[path.child!])) {
      if (op === 'remove') return;
      parent[path.child!] = {};
    }
    write(parent[path.child!] as ObjectValue, path.grandchild, value, op);
  } else write(parent, path.child!, value, op);
}

/** How many values the operations carry in arrays, counted before any of them is read */
function carried(operations: unknown[]): number {
  let count = 0;
  for (const operation of operations) {
    const value = attribute(operation, 'value');
    if (Array.isArray(value)) count += value.length;
    else if (object(value))
      for (const item of Object.values(value)) if (Array.isArray(item)) count += item.length;
  }
  return count;
}

function withinLimits(resource: ObjectValue): boolean {
  const { members, emails } = resource;
  return (
    (!Array.isArray(members) || members.length <= MEMBER_LIMIT) &&
    (!Array.isArray(emails) || emails.length <= EMAIL_LIMIT)
  );
}

/** Work on a private copy so a later failing operation cannot leave earlier changes behind. */
export function patchResource(resource: ObjectValue, payload: unknown, kind: ResourceKind): ObjectValue {
  if (!object(payload)) invalidValue();
  const schemas = attribute(payload, 'schemas');
  const operations = attribute(payload, 'Operations');
  if (
    !Array.isArray(schemas) ||
    !schemas.includes(PATCH_SCHEMA) ||
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 100
  )
    invalidValue();
  if (carried(operations) > MEMBER_LIMIT) invalidValue();
  const result = structuredClone(resource);
  const budget: Budget = { left: FILTER_WORK_LIMIT };
  for (const operation of operations) {
    if (!object(operation)) invalidValue();
    const rawOp = attribute(operation, 'op');
    const op = typeof rawOp === 'string' ? rawOp.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') invalidValue();
    const path = attribute(operation, 'path');
    const value = attribute(operation, 'value');
    if (op !== 'remove' && value === undefined) invalidValue();
    if (path === undefined) {
      // RFC 7644 section 3.5.2.2: a remove must say what it removes.
      if (op === 'remove') noTarget();
      if (!object(value)) invalidPath();
      for (const [key, item] of Object.entries(value)) {
        const parsed = parsePath(key, kind, true);
        if (parsed) apply(result, parsed, item, op, budget);
      }
    } else {
      if (typeof path !== 'string' || path.length > 4096) invalidPath();
      const parsed = parsePath(path, kind, false);
      if (parsed) apply(result, parsed, value, op, budget);
    }
    if (!withinLimits(result)) invalidValue();
  }
  return result;
}
