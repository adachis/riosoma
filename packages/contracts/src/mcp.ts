import { z } from 'zod';

export const MCP_DEFAULT_CALLS_PER_MINUTE = 120;
/** Null explicitly disables the limit, while an absent app override inherits it. */
export const McpCallLimit = z.number().int().min(1).max(1_000_000).nullable();
export const McpRateSettings = z
  .object({
    callsPerMinute: McpCallLimit.default(MCP_DEFAULT_CALLS_PER_MINUTE),
    appOverrides: z.record(z.string().regex(/^[a-f0-9]{32}$/), McpCallLimit).default({}),
  })
  .strict();
export type McpRateSettings = z.infer<typeof McpRateSettings>;

export interface McpAppActivity {
  clientId: string;
  appName: string;
  /** All requests in the rolling minute, including refusals. */
  callsLastMinute: number;
  limitedLastDay: number;
}
