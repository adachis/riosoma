import { z } from 'zod';
import { DATABASE_ROLES, DatabaseRole } from './data/schema.js';
import { UserId } from './data/fields.js';
import { Level } from './levels.js';

/**
 * Bringing people in and sharing databases with them.  People join an organization by invitation;
 * databases are shared with people, or with everyone in the organization, at a role.
 */
export const InvitationEmail = z.string().trim().toLowerCase().email().max(320);
const Email = InvitationEmail;

const shareResource = z.object({ kind: z.enum(['database', 'folder']), id: z.string().min(1).max(100) });
export const SharingAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('share.invite'), resource: shareResource, email: Email, role: DatabaseRole }),
  z.object({
    kind: z.literal('share.resend'),
    resource: shareResource,
    invitationId: z.string().min(1).max(100),
  }),
  z.object({
    kind: z.literal('share.revoke'),
    resource: shareResource,
    invitationId: z.string().min(1).max(100),
  }),
]);
export type SharingAction = z.infer<typeof SharingAction>;

export interface SharingInvitations {
  allowed: boolean;
  refusal: 'membersOnly' | 'administratorsOnly' | null;
  administratorsOnly: boolean;
  domains: string[];
  kind: 'guest' | 'member';
  mailAvailable: boolean;
  pending: Array<{ id: string; email: string; role: DatabaseRole; expiresAt: string }>;
}

export const MEMBER_KINDS = ['owner', 'member', 'guest'] as const;
export const MemberKind = z.enum(MEMBER_KINDS);
export type MemberKind = z.infer<typeof MemberKind>;

export const Member = z.object({
  unitId: z.string().nullable().optional(),
  id: UserId,
  name: z.string(),
  email: z.string(),
  kind: MemberKind,
  adminRoles: z.array(z.string()),
  deactivated: z.boolean(),
  pictureUrl: z.string().nullable().optional(),
  canManage: z.boolean().optional(),
  lastOwner: z.boolean().optional(),
  guestRoleBlocked: z.boolean().optional(),
  managed: z.literal('scim').optional(),
  profile: z
    .object({
      /** The directory's login name, which needn't be the person's email */
      userName: z.string().optional(),
      externalId: z.string().optional(),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      department: z.string().optional(),
      division: z.string().optional(),
      organization: z.string().optional(),
      costCenter: z.string().optional(),
      employeeNumber: z.string().optional(),
      manager: z.object({ value: z.string(), displayName: z.string().optional() }).optional(),
    })
    .optional(),
});
export type Member = z.infer<typeof Member>;

/** `POST /api/org/invitations` (People administrators) */
export const InvitePeople = z.object({
  emails: z.array(Email).min(1).max(50),
  /** Guests see only what's shared with them by name, never what's shared with everyone */
  kind: z.enum(['member', 'guest']).default('member'),
});
export type InvitePeople = z.infer<typeof InvitePeople>;

export const Invitation = z.object({
  id: z.string(),
  email: z.string(),
  kind: z.enum(['member', 'guest']),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

export const InviteResult = z.object({
  invited: z.array(Invitation),
  /** Addresses that already belong to someone in the organization */
  alreadyMembers: z.array(z.string()),
});
export type InviteResult = z.infer<typeof InviteResult>;

/** `POST /api/auth/invitations/accept`: the token from the emailed link, and the new person's name */
export const AcceptInvitation = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(120),
  locale: z.string().max(16).optional(),
  /** The experience level the person chose while joining.  Left out, they follow where their kind starts. */
  level: Level.optional(),
});
export type AcceptInvitation = z.infer<typeof AcceptInvitation>;

/** `GET /api/auth/invitations/:token` (public): enough to greet the invitee, nothing more */
export const InvitationPreview = z.object({
  orgName: z.string(),
  email: z.string(),
  invitedByName: z.string().nullable(),
  /** Where the invitee starts, and the highest experience level they can choose */
  level: z.object({ start: Level, highest: Level }),
  sharedItems: z.array(z.string()).optional(),
  destination: z.string().optional(),
  sso: z.object({ id: z.string(), name: z.string(), kind: z.string() }).optional(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;

export const Principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: UserId }),
  z.object({ kind: z.literal('group'), id: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('org') }),
]);
export type Principal = z.infer<typeof Principal>;

/**
 * One entry in a database's sharing list.  An entry with `inheritedFrom` comes from the folder the
 * database is in: it's read-only here and changes with the folder's roles.  Its ID and name are
 * present only when the caller can see that folder.
 */
export const Grant = z.object({
  principal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('user'), id: UserId, name: z.string(), email: z.string() }),
    z.object({ kind: z.literal('group'), id: z.string(), name: z.string() }),
    z.object({ kind: z.literal('org'), name: z.string() }),
  ]),
  role: DatabaseRole,
  inheritedFrom: z
    .object({ kind: z.literal('folder'), id: z.string().optional(), name: z.string().optional() })
    .optional(),
});
export type Grant = z.infer<typeof Grant>;

/**
 * `PUT /api/databases/:databaseId/grants` sets one principal's role, and `DELETE` with a
 * principal removes it.  Only owners share.  A database always keeps at least one owner, and the
 * whole organization can't be made owner.
 */
export const SetGrant = z.object({
  principal: Principal,
  role: DatabaseRole,
});
export type SetGrant = z.infer<typeof SetGrant>;

export const RemoveGrant = z.object({ principal: Principal });
export type RemoveGrant = z.infer<typeof RemoveGrant>;

/** Roles someone can be given when sharing, strongest first */
export const SHARE_ROLES = DATABASE_ROLES;

export const OrganizationGroup = z.object({
  id: z.string(),
  name: z.string(),
  managed: z.boolean(),
  members: z.array(z.string()),
});
export type OrganizationGroup = z.infer<typeof OrganizationGroup>;

export interface OrganizationFolder {
  id: string;
  name: string;
  databases: string[];
  grants: Array<{ groupId: string; role: z.infer<typeof DatabaseRole> }>;
  /** Whether this person may change the folder's roles: its owners and the organization's owner */
  canGrant: boolean;
}
