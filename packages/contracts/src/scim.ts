import { z } from 'zod';

export const ScimSettings = z.object({
  dryRun: z.boolean(),
  deleteAction: z.enum(['suspend', 'remove']),
});
export type ScimSettings = z.infer<typeof ScimSettings>;

export const ScimTokenCreate = z.object({ name: z.string().trim().min(1).max(120) });

export interface ScimToken {
  id: string;
  name: string;
  /**
   * The person who made the token, or null once their account is gone.  A token stops working
   * when that person is suspended or removed.
   */
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** A member provisioning doesn't manage, whom suspending in the directory doesn't reach */
export interface UnmanagedMember {
  id: string;
  name: string;
  email: string;
}

export interface ScimAdministration {
  baseUrl: string;
  settings: ScimSettings;
  tokens: ScimToken[];
  /** Members, other than the owner, who joined outside provisioning and aren't managed by it */
  unmanaged: UnmanagedMember[];
}

export const ScimDomain = z.object({
  providerId: z.string().regex(/^[0-9A-Za-z]{16}$/),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
});

export interface ScimDomainVerification {
  providerId: string;
  domain: string;
  recordName: string;
  recordValue: string;
  verifiedAt: string | null;
  /** When the daily recheck of a verified domain last ran */
  checkedAt: string | null;
  /** Daily rechecks in a row that couldn't find the record.  The third takes verification away. */
  failedChecks: number;
}

/** Failed daily rechecks in a row that take a domain's verification away */
export const DOMAIN_CHECK_FAILURES = 3;

export interface ProvisionedProfile {
  externalId?: string;
  givenName?: string;
  familyName?: string;
  department?: string;
  employeeNumber?: string;
  manager?: { value: string; displayName?: string };
}
