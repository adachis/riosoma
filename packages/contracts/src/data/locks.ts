import { z } from 'zod';
import { FilterGroup } from './filters.js';

export const RecordLockPolicy = z.object({
  condition: FilterGroup.nullable().default(null),
  bypass: z.enum(['owners', 'creators', 'nobody']).default('owners'),
  reason: z.string().trim().max(1000).default(''),
});
export type RecordLockPolicy = z.infer<typeof RecordLockPolicy>;
export const RecordLock = z.object({
  manual: z.boolean(),
  reason: z.string(),
  canEdit: z.boolean(),
});
export type RecordLock = z.infer<typeof RecordLock>;
export function canBypassRecordLock(policy: RecordLockPolicy | undefined, role: string | null): boolean {
  const bypass = policy?.bypass ?? 'owners';
  return bypass !== 'nobody' && (role === 'owner' || (bypass === 'creators' && role === 'creator'));
}
