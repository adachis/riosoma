import type { Migration } from '@riosoma/db';

/**
 * Counts the calls whose tokens were estimated because the provider reported no usage, such as a
 * document import that stopped partway, so a month's totals show how much of them is an estimate.
 */
export const m0082: Migration = {
  id: '0082_ai_usage_token_estimates',
  sql: `ALTER TABLE {{app}}.ai_usage ADD COLUMN token_estimated_calls bigint NOT NULL DEFAULT 0`,
};
