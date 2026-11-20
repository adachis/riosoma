import { z } from 'zod';

/**
 * First-run setup.  The wizard walks the stages in order; the server reports where it is so a
 * reload lands on the right step.
 */
export const SETUP_STAGES = ['database', 'owner', 'ready'] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

export const SetupStatus = z.object({
  stage: z.enum(SETUP_STAGES),
  /** The database was configured by the operator's environment, so the wizard skips that step. */
  databaseManaged: z.boolean(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * The connection check runs one rung at a time, stopping at the first failure, so the person sees
 * exactly which layer is wrong and a plain-language fix for it.
 */
export const DIAGNOSTIC_STEPS = [
  'dns',
  'tunnel',
  'tcp',
  'tls',
  'auth',
  'database',
  'privileges',
  'extensions',
  'version',
  'latency',
] as const;
export type DiagnosticStepId = (typeof DIAGNOSTIC_STEPS)[number];

export const DiagnosticStep = z.object({
  step: z.enum(DIAGNOSTIC_STEPS),
  status: z.enum(['ok', 'warn', 'fail', 'skipped']),
  /** i18n key describing what happened, e.g. `setup.diagnose.auth.passwordRejected` */
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** i18n key for the suggested fix, when there is one */
  fixKey: z.string().optional(),
  elapsedMs: z.number().nonnegative(),
});
export type DiagnosticStep = z.infer<typeof DiagnosticStep>;

export const DiagnosticReport = z.object({
  ok: z.boolean(),
  steps: z.array(DiagnosticStep),
  serverVersion: z.string().optional(),
});
export type DiagnosticReport = z.infer<typeof DiagnosticReport>;
