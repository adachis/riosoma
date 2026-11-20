import { z } from 'zod';

/** How much Rio may do before asking.  Deletes and external actions always ask. */
export const AUTONOMY = ['ask', 'previewBig', 'instant'] as const;
export const Autonomy = z.enum(AUTONOMY);
export type Autonomy = z.infer<typeof Autonomy>;

/** An absent personal choice follows the organization's cap. */
export function effectiveAutonomy(person: Autonomy | undefined, cap: Autonomy): Autonomy {
  return AUTONOMY[Math.min(AUTONOMY.indexOf(person ?? cap), AUTONOMY.indexOf(cap))]!;
}
