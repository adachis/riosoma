import { budgetReached } from '../ai/budget.js';
import type { AiFieldTier, AiSettings, RioTier } from '@riosoma/contracts';
import type { AppContext } from '../app.js';
import { modelFor, settingsFor, spent } from '../ai/settings.js';

export type FieldModel = NonNullable<Awaited<ReturnType<typeof modelFor>>>;

/**
 * The model an AI field's tier asks for, through the admin AI settings.  A fast field takes the
 * everyday model, or the power model when that's all there is, and a careful field takes the
 * power model.  Each tier's model defaults to the cheapest capable one the organization has connected.
 */
export async function modelForTier(
  ctx: AppContext,
  orgId: string,
  settings: AiSettings,
  tier: AiFieldTier,
): Promise<FieldModel | null> {
  const tiers: RioTier[] = tier === 'fast' ? ['everyday', 'power'] : ['power'];
  for (const candidate of tiers) {
    const model = await modelFor(ctx, orgId, settings, candidate);
    if (model) return model;
  }
  return null;
}

/**
 * Why AI fields can't run in the organization right now, as a message key, or null when they can:
 * an admin turned them off, no provider is connected, or the month's budget is spent.
 */
export async function unavailableReason(
  ctx: AppContext,
  orgId: string,
  settings?: AiSettings,
): Promise<string | null> {
  const current = settings ?? (await settingsFor(ctx, orgId));
  if (!current.aiFields) return 'aiFields.off';
  if (!current.enabled || !(await modelForTier(ctx, orgId, current, 'fast'))) return 'aiFields.noProvider';
  if (current.monthlyBudgetUsd !== null && budgetReached(await spent(ctx, orgId), current.monthlyBudgetUsd))
    return 'aiFields.paused';
  return null;
}
