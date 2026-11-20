import { z } from 'zod';

export const PUBLIC_PAGE_KINDS = ['forms', 'views', 'bookings', 'signing', 'sites'] as const;
export const PublicPageKind = z.enum(PUBLIC_PAGE_KINDS);
export type PublicPageKind = z.infer<typeof PublicPageKind>;
/**
 * What a new domain serves until an admin chooses otherwise.  A domain that serves a site shows it
 * in place of every other public page, so sites wait for someone to turn them on.
 */
export const DEFAULT_PUBLIC_PAGE_KINDS: readonly PublicPageKind[] = PUBLIC_PAGE_KINDS.filter(
  (kind) => kind !== 'sites',
);

/** The TXT record an organization publishes to prove it controls a host is this plus the host. */
export const CUSTOM_DOMAIN_RECORD_PREFIX = '_riosoma-public.';
export function customDomainRecordName(host: string): string {
  return `${CUSTOM_DOMAIN_RECORD_PREFIX}${host}`;
}
/** A DNS name has at most 253 characters, so a host leaves room for its TXT record's prefix. */
export const CUSTOM_DOMAIN_HOST_MAX = 253 - CUSTOM_DOMAIN_RECORD_PREFIX.length;

/** Plain DNS names prevent wildcards, ports, URL syntax, and ambiguous numeric hosts. */
export const CustomDomainHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const CustomDomainKinds = z
  .array(PublicPageKind)
  .min(1)
  .max(5)
  .refine((kinds) => new Set(kinds).size === kinds.length);
export const CustomDomainInput = z.object({
  host: CustomDomainHost.max(CUSTOM_DOMAIN_HOST_MAX),
  kinds: CustomDomainKinds.default([...DEFAULT_PUBLIC_PAGE_KINDS]),
});
export interface CustomDomain {
  id: string;
  host: string;
  kinds: PublicPageKind[];
  verifiedAt: string | null;
  checkedAt: string | null;
  recordName: string;
  recordValue: string;
  target: string;
  targetType: 'CNAME' | 'A' | 'AAAA';
}
