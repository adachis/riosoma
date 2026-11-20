import { z } from 'zod';
import { attribute } from './filter.js';
import { booleanOf, invalidValue } from './errors.js';
import {
  EMAIL_LIMIT,
  ENTERPRISE_SCHEMA,
  GROUP_SCHEMA,
  MEMBER_LIMIT,
  USER_SCHEMA,
  object,
  type ResourceKind,
} from './patch.js';

const text = z.string().trim().max(1000);
const email = z.string().trim().toLowerCase().email().max(320);
/** Entra sends booleans as the strings "True" and "False". */
const bool = z.preprocess((value) => booleanOf(value) ?? value, z.boolean());
const Email = z.object({
  value: email,
  type: text.optional(),
  primary: bool.optional(),
  display: text.optional(),
});
const Name = z.object({
  givenName: text.optional(),
  familyName: text.optional(),
  formatted: text.optional(),
});
const Enterprise = z.object({
  department: text.optional(),
  employeeNumber: text.optional(),
  manager: z.object({ value: z.string().min(1).max(100), displayName: text.optional() }).optional(),
});
const User = z.object({
  /** The directory's login name, such as a user principal name.  It needn't be an email address. */
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().min(1).max(1000).optional(),
  displayName: z.string().trim().max(120).optional(),
  name: Name.optional(),
  active: bool.default(true),
  emails: z.array(Email).max(EMAIL_LIMIT).default([]),
  [ENTERPRISE_SCHEMA]: Enterprise.optional(),
});
/** Members are people.  RFC 7643 section 8.7.1 compares the type without regard to case. */
const MemberType = z
  .string()
  .refine((type) => type.toLowerCase() === 'user')
  .transform(() => 'User' as const);
const Group = z.object({
  displayName: z.string().trim().min(1).max(120),
  externalId: z.string().min(1).max(1000).optional(),
  members: z
    .array(z.object({ value: z.string().min(1).max(100), type: MemberType.optional() }))
    .max(MEMBER_LIMIT)
    .default([]),
});

function select(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!object(value)) invalidValue();
  return Object.fromEntries(
    keys.flatMap((key) => {
      const item = attribute(value, key);
      return item === undefined || item === null ? [] : [[key, item]];
    }),
  );
}

/** Lists are checked against their limits before any entry is read. */
function entries(value: unknown, limit: number, keys: readonly string[]): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length > limit) invalidValue();
  return value.map((item) => select(item, keys));
}

/** Drop unsupported and read-only attributes, and canonicalize supported attribute names. */
export function normalizeResource(payload: unknown, kind: ResourceKind): Record<string, unknown> {
  if (!object(payload)) invalidValue();
  const schemas = attribute(payload, 'schemas');
  const core = kind === 'Users' ? USER_SCHEMA : GROUP_SCHEMA;
  if (!Array.isArray(schemas) || !schemas.includes(core)) invalidValue();
  if (kind === 'Groups') {
    const value = select(payload, ['displayName', 'externalId', 'members']);
    value.members = entries(value.members, MEMBER_LIMIT, ['value', 'type']);
    const parsed = Group.safeParse(value);
    if (!parsed.success) invalidValue();
    return {
      schemas: [GROUP_SCHEMA],
      ...parsed.data,
      members: [...new Map(parsed.data.members.map((member) => [member.value, member])).values()],
    };
  }
  const value = select(payload, [
    'userName',
    'externalId',
    'displayName',
    'name',
    'active',
    'emails',
    ENTERPRISE_SCHEMA,
  ]);
  if (value.name !== undefined) value.name = select(value.name, ['givenName', 'familyName', 'formatted']);
  value.emails = entries(value.emails, EMAIL_LIMIT, ['value', 'type', 'primary', 'display']);
  if (value[ENTERPRISE_SCHEMA] !== undefined) {
    const enterprise = select(value[ENTERPRISE_SCHEMA], ['department', 'employeeNumber', 'manager']);
    const manager = enterprise.manager;
    // Some directories send the manager as a bare ID, as Microsoft's SCIM guide shows it.
    if (typeof manager === 'string') {
      if (manager.trim()) enterprise.manager = { value: manager.trim() };
      else delete enterprise.manager;
    } else if (manager !== undefined) enterprise.manager = select(manager, ['value', 'displayName']);
    value[ENTERPRISE_SCHEMA] = enterprise;
  }
  const parsed = User.safeParse(value);
  if (!parsed.success) invalidValue();
  const user = parsed.data;
  if (user.emails.filter((entry) => entry.primary).length > 1) invalidValue();
  const document = {
    schemas: [USER_SCHEMA, ...(user[ENTERPRISE_SCHEMA] ? [ENTERPRISE_SCHEMA] : [])],
    ...user,
  };
  personEmail(document);
  return document;
}

interface StoredEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

/**
 * The person's Riosoma email: their primary address, else their work address, else userName when
 * it is an address.  A person with none of these can't be provisioned.
 */
export function personEmail(document: Record<string, unknown>): string {
  const emails = (Array.isArray(document.emails) ? document.emails : []) as StoredEmail[];
  const chosen =
    emails.find((entry) => entry.primary) ?? emails.find((entry) => entry.type?.toLowerCase() === 'work');
  if (chosen) return chosen.value;
  const userName = email.safeParse(document.userName);
  return userName.success ? userName.data : invalidValue();
}

export function personName(document: Record<string, unknown>): string {
  const name = document.name as z.infer<typeof Name> | undefined;
  return (
    typeof document.displayName === 'string' && document.displayName
      ? document.displayName
      : name?.formatted || [name?.givenName, name?.familyName].filter(Boolean).join(' ')
  ).slice(0, 120);
}

export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export function listResponse(Resources: unknown[], totalResults = Resources.length, startIndex = 1) {
  return { schemas: [LIST_SCHEMA], totalResults, startIndex, itemsPerPage: Resources.length, Resources };
}

const ALWAYS_RETURNED = new Set(['id', 'schemas']);

function key(resource: Record<string, unknown>, name: string): string | undefined {
  return Object.keys(resource).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

/** `name.givenName` as `['name', 'givenName']`, with schema prefixes read as RFC 7644 allows */
function attributePath(source: string, kind: ResourceKind): [string, string?] {
  const core = `${kind === 'Users' ? USER_SCHEMA : GROUP_SCHEMA}:`.toLowerCase();
  const lower = source.toLowerCase();
  if (lower === ENTERPRISE_SCHEMA.toLowerCase()) return [ENTERPRISE_SCHEMA];
  if (lower.startsWith(`${ENTERPRISE_SCHEMA.toLowerCase()}:`))
    return [ENTERPRISE_SCHEMA, source.slice(ENTERPRISE_SCHEMA.length + 1).split('.')[0]];
  const [top, sub] = (lower.startsWith(core) ? source.slice(core.length) : source).split('.');
  return [top!, sub];
}

function names(list: string | undefined, kind: ResourceKind): Array<[string, string?]> {
  if (list === undefined) return [];
  return list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => attributePath(item, kind));
}

function only(value: unknown, subs: Set<string>): unknown {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => subs.has(name.toLowerCase())));
}

function without(value: unknown, sub: string): unknown {
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name.toLowerCase() !== sub.toLowerCase()),
  );
}

/**
 * Applies `attributes` and `excludedAttributes` (RFC 7644 section 3.4.2.5).  `id` and `schemas` are
 * always returned, and names the resource doesn't have are ignored.
 */
export function project(
  resource: Record<string, unknown>,
  kind: ResourceKind,
  attributes: string | undefined,
  excludedAttributes: string | undefined,
): Record<string, unknown> {
  let result = resource;
  const wanted = names(attributes, kind);
  if (wanted.length) {
    const picks = new Map<string, Set<string> | 'all'>();
    for (const [top, sub] of wanted) {
      const name = key(resource, top);
      if (!name) continue;
      const current = picks.get(name);
      if (!sub) picks.set(name, 'all');
      else if (current !== 'all') picks.set(name, (current ?? new Set<string>()).add(sub.toLowerCase()));
    }
    result = Object.fromEntries(
      Object.entries(resource).flatMap(([name, value]) => {
        if (ALWAYS_RETURNED.has(name)) return [[name, value]];
        const pick = picks.get(name);
        if (!pick) return [];
        if (pick === 'all') return [[name, value]];
        return [[name, Array.isArray(value) ? value.map((entry) => only(entry, pick)) : only(value, pick)]];
      }),
    );
  }
  for (const [top, sub] of names(excludedAttributes, kind)) {
    const name = key(result, top);
    if (!name || ALWAYS_RETURNED.has(name)) continue;
    if (result === resource) result = { ...resource };
    if (!sub) delete result[name];
    else {
      const value = result[name];
      result[name] = Array.isArray(value) ? value.map((entry) => without(entry, sub)) : without(value, sub);
    }
  }
  return result;
}
