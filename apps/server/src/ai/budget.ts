/** Treat arithmetic roundoff as equality without rounding away small dollar budgets. */
export function budgetReached(costUsd: number, budgetUsd: number): boolean {
  return (
    costUsd >= budgetUsd ||
    budgetUsd - costUsd <= Number.EPSILON * Math.max(Math.abs(costUsd), Math.abs(budgetUsd)) * 4
  );
}
