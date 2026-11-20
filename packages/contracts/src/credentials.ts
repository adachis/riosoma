import { z } from 'zod';

export const CredentialCommand = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().uuid(),
    kind: z.literal('move'),
    profile: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string().uuid(),
    kind: z.literal('rotate'),
    revision: z.number().int().nonnegative(),
    keyProfile: z.string().max(200).optional(),
  }),
  z.object({
    id: z.string().uuid(),
    kind: z.literal('undo'),
    jobId: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
  }),
  z.object({ id: z.string().uuid(), kind: z.literal('resume'), jobId: z.string().min(1).max(200) }),
]);
export type CredentialCommand = z.infer<typeof CredentialCommand>;

export interface CredentialJob {
  id: string;
  kind: 'move' | 'rotate' | 'migrate' | 'undo';
  state: 'running' | 'failed' | 'finished';
  processed: number;
  error: string | null;
}
export interface CredentialStatus {
  profile: string;
  keyId: string;
  revision: number;
  profiles: { id: string; kind: string; wrapping: boolean }[];
  jobs: CredentialJob[];
  failedProfiles: string[];
  cacheSeconds: number;
}
export interface CredentialPreview {
  profile: string;
  revision: number;
  count: number;
}
