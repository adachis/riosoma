import { z } from 'zod';
import { UserId } from './data/fields.js';
import { MemberKind } from './sharing.js';
import { SecondStepProof } from './mfa.js';
import { PASSWORD_MAX_LENGTH } from './password.js';

export const ProfileUpdate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** A square PNG, JPEG, or WebP, normalized again before it is stored. */
    picture: z.string().max(3_000_000).nullable().optional(),
    revision: z.string().length(64),
  })
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

export interface PersonalProfile {
  name: string;
  email: string;
  pictureUrl: string | null;
  managedFields: Array<'name' | 'email' | 'picture'>;
  emailChangeAllowed: boolean;
  revision: string;
}

export const ChangeMemberRole = z.object({ role: MemberKind }).strict();
export const ChangeMemberStatus = z.object({ deactivated: z.boolean() }).strict();
export const TransferOwnership = z
  .object({
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    proof: SecondStepProof.optional(),
  })
  .strict();
export type TransferOwnership = z.infer<typeof TransferOwnership>;
export const ChangeEmail = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict();
export const ConfirmEmail = z.object({ token: z.string().min(20).max(200) }).strict();

export const MemberCommand = z.discriminatedUnion('kind', [
  ChangeMemberRole.extend({ kind: z.literal('people.role'), userId: UserId }),
  ChangeMemberStatus.extend({ kind: z.literal('people.status'), userId: UserId }),
  z.object({ kind: z.literal('people.transfer'), userId: UserId }).strict(),
  z.object({ kind: z.literal('people.remove'), userId: UserId }).strict(),
]);

export interface PersonIdentity {
  id: string;
  name: string;
  email: string;
  pictureUrl?: string | null;
  deactivated?: boolean;
}
