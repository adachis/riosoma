import { z } from 'zod';
import type { DatabaseSchema } from './data/schema.js';
import type { DashboardData, TileData } from './data/dashboards.js';
import type { ViewAggregate } from './data/aggregates.js';
import type { InterfaceData } from './data/interfaces.js';
import type { RowsPage } from './data/rows.js';
import type { SearchSource } from './knowledge.js';
import { ElectricityZone, type AiFootprint, type AiModelFootprint } from './ai-footprint.js';
import { Command } from './data/commands.js';
import { Autonomy } from './autonomy.js';
export { AUTONOMY, Autonomy, effectiveAutonomy } from './autonomy.js';

/**
 * Rio, the assistant.  Rio answers questions about a person's data and builds things for them,
 * always through the same commands and permissions as the app, so everything it does is audited,
 * broadcast, and undoable in one step.  Small, safe changes apply at once with a receipt.  Bigger
 * ones, and anything that deletes, arrive as a plan the person applies.
 *
 * AI is off until an admin with the AI role turns it on and connects a model provider.  Provider
 * names and models live in `packages/ai`, so these contracts only carry their IDs.
 *
 * Routes:
 * - `GET /api/rio/status` (session) → `RioStatus`
 * - `GET /api/rio/conversations` (session, the person's own) → `RioConversation[]`
 * - `POST /api/rio/conversations` (session) → `RioConversation`
 * - `GET /api/rio/conversations/:conversationId` → `{ conversation, messages: RioMessage[] }`
 * - `DELETE /api/rio/conversations/:conversationId`
 * - `POST /api/rio/conversations/:conversationId/messages` (`RioAsk`) → a `text/event-stream` of
 *   `RioEvent`s, ending with `done` or `error`
 * - `GET /api/rio/plans/:planId/preview?timeZone=...` → `RioPlanPreview`
 * - `POST /api/rio/plans/:planId/apply` → `RioBlock` (the receipt)
 * - `POST /api/rio/plans/:planId/dismiss`
 * - `POST /api/automations/:automationId/runs/:runId/diagnose` (`AutomationDiagnose`, schema
 *   access) → `AutomationDiagnosis`, Rio's explanation of a failed or skipped run
 * - `POST /api/automations/:automationId/diagnoses/apply` (`AutomationDiagnosisApply`) →
 *   `AutomationDiagnosisReceipt`, saving the diagnosis's fix as one undoable action
 * - `GET /api/ai/settings`, `PUT /api/ai/settings` (`AiSettingsUpdate`), `PUT` and `DELETE
 *   /api/ai/keys/:providerId`, `POST /api/ai/test` (`{ providerId }`) (admin, AI area)
 */

export const ProviderId = z.string().regex(/^[a-z0-9-]{2,32}$/);
export const ModelRef = z.object({ providerId: ProviderId, model: z.string().min(1).max(200) });
export type ModelRef = z.infer<typeof ModelRef>;

export const GatewayHeaderName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/);
export const GatewayConfig = z.object({
  providerId: ProviderId.regex(/^gateway(?:-[a-z0-9-]+)?$/),
  name: z.string().trim().min(1).max(100),
  baseUrl: z
    .string()
    .url()
    .max(500)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  auth: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('bearer') }),
    z.object({ mode: z.literal('header'), header: GatewayHeaderName }),
    z.object({ mode: z.literal('none') }),
  ]),
  /** Header values live in the encrypted credential store, never in settings. */
  headerNames: z.array(GatewayHeaderName).max(20).default([]),
  models: z
    .array(
      z.object({
        model: z.string().trim().min(1).max(200),
        contextTokens: z.number().int().min(128).max(10_000_000),
        mapping: ModelRef.nullable().default(null),
      }),
    )
    .max(200)
    .default([]),
});
export type GatewayConfig = z.infer<typeof GatewayConfig>;

/**
 * Where an AI address sends its requests: the address as the URL standard reads it, without a
 * trailing slash, or null for a provider's own address.  A stored key or header value belongs to
 * the address it was saved for, and the server and the forms tell a changed address this way.
 */
export function aiDestination(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseUrl;
  }
}

export const GatewayChange = z.object({
  gateway: GatewayConfig,
  key: z.string().trim().max(10_000).optional(),
  headers: z
    .record(
      GatewayHeaderName,
      z
        .string()
        .max(10_000)
        .regex(/^[^\r\n]*$/),
    )
    .optional(),
});
export type GatewayChange = z.infer<typeof GatewayChange>;

/** Quick answers from an everyday model, or harder work from a stronger one. */
export const RIO_TIERS = ['everyday', 'power'] as const;
export const RioTier = z.enum(RIO_TIERS);
export type RioTier = z.infer<typeof RioTier>;

export const AiSettings = z.object({
  enabled: z.boolean().default(false),
  gateways: z.array(GatewayConfig).max(20).optional(),
  /** Providers people's data may be sent to; nothing goes to a provider that isn't listed */
  providers: z
    .array(z.object({ providerId: ProviderId, baseUrl: z.string().url().max(500).optional() }))
    .max(20)
    .default([]),
  models: z.object({ everyday: ModelRef.nullable(), power: ModelRef.nullable() }),
  /** The most any person may choose; people can pick less */
  autonomy: Autonomy.default('previewBig'),
  /** Estimated spend a month across the organization; Rio stops at it.  Null has no cap. */
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().default(null),
  /** Stored ingest controls.  Per-file and per-build ceilings are in US dollars. */
  ingest: z.boolean().default(false),
  ingestFileLimitUsd: z.number().min(0).max(1_000_000).default(1),
  ingestBuildLimitUsd: z.number().min(0).max(1_000_000).default(10),
  /** Whether AI fields may run.  Off stops new runs and keeps the values already written. */
  aiFields: z.boolean().default(true),
  /** Whether Rio may explain failed automation runs from the run history */
  automationDiagnose: z.boolean().default(true),
  automationAi: z.boolean().default(true),
  automationRunLimitUsd: z.number().min(0.01).max(100).default(1),
  /** The electricity zone footprint estimates use, or null for the server's setting */
  electricityZone: ElectricityZone.nullable().default(null),
  /** Whether people may set up routines, which Rio carries out on a schedule as them */
  routines: z.boolean().default(true),
  /** The most one routine run may spend, in US dollars.  Each routine's own cap sits at or below it. */
  routineRunLimitUsd: z.number().min(0.01).max(100).default(1),
});
export type AiSettings = z.infer<typeof AiSettings>;

export const AiSettingsUpdate = AiSettings.partial().extend({
  expectedRevision: z.string().length(64).optional(),
  gatewayChanges: z.array(GatewayChange).max(20).optional(),
  removedGatewayIds: z
    .array(ProviderId.regex(/^gateway(?:-[a-z0-9-]+)?$/))
    .max(20)
    .optional(),
});
export type AiSettingsUpdate = z.infer<typeof AiSettingsUpdate>;

/** What the admin page shows: the settings, which providers exist, and what each offers. */
export interface AiSettingsView {
  revision: string;
  settings: AiSettings;
  registryModels?: Array<ModelRef & { name: string }>;
  providers: Array<{
    providerId: string;
    /** The provider's display name, from the server's registry */
    name: string;
    /** Whether an API key is stored (or set in the server's environment), never the key */
    hasKey: boolean;
    keyFromEnvironment: boolean;
    /** Runs on the organization's own hardware, so data never leaves it */
    local: boolean;
    models: Array<{
      model: string;
      name: string;
      tiers: Array<RioTier | 'vision'>;
      priceKnown: boolean;
      /** Null when the footprint method has no estimate for the model */
      footprint: AiModelFootprint | null;
    }>;
  }>;
  spentThisMonthUsd: number | null;
}

export interface RioStatus {
  enabled: boolean;
  /** Why Rio is off when AI is on but no provider has the organization's consent */
  disabledReason?: 'noProvider';
  tiers: RioTier[];
  /** The person's saved choice, limited by the organization cap. */
  autonomy: Autonomy;
  /** The organization cap before applying the person's saved choice. */
  autonomyCap?: Autonomy;
  /** Set when the organization's monthly budget is used up */
  paused: boolean;
  /** Whether Diagnose is on for automation runs, which also needs Rio to be enabled */
  diagnose: boolean;
  /** Whether the person may set up and run routines, which also needs Rio to be enabled */
  routines: boolean;
  /** The most one routine run may spend, in US dollars */
  routineRunLimitUsd: number;
}

/** Where the person is, so Rio knows what "this table" means. */
export const RioContext = z.object({
  page: z.enum(['home', 'settings']).optional(),
  folderId: z.string().max(40).optional(),
  databaseId: z.string().max(40).optional(),
  tableId: z.string().max(40).optional(),
  viewId: z.string().max(40).optional(),
  recordId: z.string().max(40).optional(),
  recordIds: z.array(z.string().max(40)).max(200).optional(),
  fieldIds: z.array(z.string().max(40)).max(100).optional(),
});
export type RioContext = z.infer<typeof RioContext>;

export const RioAsk = z.object({
  text: z.string().trim().min(1).max(8_000),
  context: RioContext.default({}),
  tier: RioTier.default('everyday'),
  /** A request can further narrow the saved personal choice and organization cap. */
  autonomy: Autonomy.optional(),
  /** The reply's language, as a BCP 47 tag */
  locale: z.string().min(2).max(35),
});
export type RioAsk = z.infer<typeof RioAsk>;

export interface RioConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  contextUsage?: RioContextUsage;
}

export interface RioContextUsage {
  tokens: number;
  /** The history scope measured by this usage, retained when the screen changes. */
  databaseId?: string | null;
  /** Null for a custom model whose context size is unknown to the registry. */
  limit: number | null;
}

export interface RioConversationDetail {
  conversation: RioConversation;
  messages: RioMessage[];
}

export interface RioUsage {
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model's price isn't known */
  costUsd: number | null;
  ms: number;
  /** Set when the provider reported no usage, so the tokens, and the cost from them, are estimates */
  tokensEstimated?: boolean;
  /**
   * The estimated footprint, or null when the model has none.  Absent when nothing was generated,
   * and on replies from before estimates were kept.
   */
  footprint?: AiFootprint | null;
}

export type RioPlanStatus = 'pending' | 'applied' | 'dismissed' | 'failed';

/** What a message is made of, in order. */
export type RioBlock =
  | { kind: 'notice'; messageKey: string }
  | { kind: 'remoteApproval'; approvalId: string }
  | { kind: 'sources'; sources: SearchSource[] }
  /** Prose, in a small Markdown subset: emphasis, lists, inline code, and links */
  | { kind: 'text'; text: string }
  /** Something the person should see before anything else, pinned above the composer */
  | { kind: 'attention'; text: string }
  /** A question with suggested answers the person can tap */
  | { kind: 'questions'; prompt: string; options: string[] }
  /** Records explicitly shown, with the primary field and at most three other fields */
  | { kind: 'records'; tableId: string; recordIds: string[]; fieldIds: string[]; total?: number }
  /** Changes waiting for the person to apply them */
  | {
      kind: 'plan';
      planId: string;
      /** Null for changes to home */
      databaseId: string | null;
      summary: string;
      steps: string[];
      /** Deletes, or more records than the person's autonomy allows at once */
      needsApproval: boolean;
      status: RioPlanStatus;
      messageKey?: string;
      /** A database plan that can be opened in the sandbox */
      preview?: boolean;
      details?: Array<{ kind: string; configuration: string }>;
      external?: boolean;
    }
  /** Changes undoable as action `groupId` in `databaseId`, or as a home command when null */
  | {
      kind: 'receipt';
      planId: string;
      databaseId: string | null;
      groupId: string;
      summary: string;
      jobId?: string;
      /** The saved undo group or Home action has already been reversed */
      undone?: boolean;
      createdDatabase?: boolean;
      /** Things the plan created, each linkable from the receipt so a person can open it */
      created?: RioCreated[];
    }
  | { kind: 'error'; messageKey: string; params?: Record<string, string>; providerId?: string };

/** Something a plan created, for the receipt to link to. */
export interface RioCreated {
  kind: 'table' | 'view' | 'dashboard' | 'interface';
  id: string;
  /** The table a view belongs to, for its link */
  tableId?: string;
  name: string;
}

export interface RioMessage {
  id: string;
  role: 'person' | 'rio';
  blocks: RioBlock[];
  createdAt: string;
  usage?: RioUsage;
  summarized?: boolean;
  compaction?: boolean;
  context?: { databaseId?: string; tableId?: string; label: string };
}

/** One server-sent event while Rio replies. */
export type RioEvent =
  | { type: 'start'; message: RioMessage }
  | { type: 'text'; blockIndex: number; delta: string }
  | { type: 'block'; blockIndex: number; block: RioBlock }
  /** What Rio is doing right now, as a `rio.working.*` message key */
  | { type: 'working'; messageKey: string }
  | { type: 'usage'; usage: RioUsage }
  | { type: 'contextUsage'; usage: RioContextUsage }
  | { type: 'done' }
  | { type: 'error'; messageKey: string; params?: Record<string, string>; providerId?: string };

/**
 * Changes Rio proposes: ordinary commands, with every ID the server fills in left optional so the
 * model only describes what should change.
 */
export const RioProposal = z.object({
  databaseId: z.string().max(40),
  summary: z.string().min(1).max(500),
  steps: z.array(z.string().min(1).max(300)).min(1).max(50),
  commands: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
});
export type RioProposal = z.infer<typeof RioProposal>;

/** The commands a plan runs, once the server has filled in their IDs. */
export const RioPlanCommands = z.array(Command).min(1).max(100);

/**
 * What Diagnose can name as the cause of a failed or skipped automation run.  The run history
 * shows it beside Rio's explanation, and the evaluation checks it.
 */
export const DIAGNOSIS_CAUSES = [
  /** A step uses a field, step, or value that's gone */
  'missingField',
  /** A value doesn't fit the field or setting it goes into */
  'typeMismatch',
  /** The person the automation acts as can't do what the step needs */
  'permission',
  /** Another service answered that too many requests were sent */
  'rateLimit',
  /** A webhook or request address is wrong, unreachable, or refused */
  'badAddress',
  /** A script step threw an error, ran out of time or memory, or broke a limit */
  'scriptError',
  /** A value the trigger's record should supply was empty */
  'emptyTriggerValue',
  /** The conditions can't be met, so the steps never run */
  'conditionsNeverMatch',
  'other',
] as const;
export const DiagnosisCause = z.enum(DIAGNOSIS_CAUSES);
export type DiagnosisCause = z.infer<typeof DiagnosisCause>;

export const AutomationDiagnose = z.object({
  /** The reply's language, as a BCP 47 tag */
  locale: z.string().min(2).max(35),
});
export type AutomationDiagnose = z.infer<typeof AutomationDiagnose>;

/** One line of a fix's diff: a setting's path, and its value before and after. */
export interface DiagnosisDiffLine {
  /** Keys and positions from the configuration's root, such as `steps`, `1`, `values`, a field ID */
  path: Array<string | number>;
  /** Missing when the setting is new */
  before?: unknown;
  /** Missing when the setting goes away */
  after?: unknown;
}

/** The one change Diagnose proposes, waiting for the person to apply it. */
export interface DiagnosisFix {
  summary: string;
  /** What it changes: a step by ID, the conditions, or the trigger */
  target: { part: 'step'; stepId: string } | { part: 'conditions' } | { part: 'trigger' };
  diff: DiagnosisDiffLine[];
  /** Sealed by the server: the exact configuration to save, and the one it was worked out from */
  token: string;
}

export interface AutomationDiagnosis {
  runId: string;
  cause: DiagnosisCause;
  /** Plain words in the small Markdown subset Rio's replies use */
  explanation: string;
  fix: DiagnosisFix | null;
  /** Set when Rio suggested a change that didn't check out, so none is offered */
  fixRejected?: boolean;
  /** Set when values the person can't see were left out of what Rio read */
  redacted: boolean;
  /**
   * Set when a rule limits what the person sees in the database, so Rio read none of the run's
   * values at all: only the automation's settings, the errors, and the fields' names and types.
   */
  withheld?: boolean;
  usage: RioUsage;
}

export const AutomationDiagnosisApply = z.object({ token: z.string().min(1).max(1_000_000) });
export type AutomationDiagnosisApply = z.infer<typeof AutomationDiagnosisApply>;

/** A fix that was saved, undoable in one step as action `groupId` in `databaseId`. */
export interface AutomationDiagnosisReceipt {
  databaseId: string;
  groupId: string;
}

/** Access-scoped data captured before opening a plan's local sandbox */
export interface RioPlanPreview {
  creation?: {
    folderId: string | null;
    folderName?: string;
    templateName?: string;
    sampleCount: number;
    includeSamples: boolean;
  };
  details?: Array<{ kind: string; configuration: string }>;
  external?: boolean;
  schema: DatabaseSchema;
  dashboards: Record<string, DashboardData>;
  interfaces: Record<string, InterfaceData>;
  records: Record<string, TileData>;
  views: Record<string, TileData & Pick<RowsPage, 'groups' | 'pinnedCount'>>;
  aggregates?: Record<string, ViewAggregate>;
  rowLimit: number;
  targets: string[];
}

/** Opens the saved gateway whose route needs attention. */
export function gatewaySettingsPath(providerId: string): string {
  return `/settings/ai#${encodeURIComponent(providerId)}`;
}
