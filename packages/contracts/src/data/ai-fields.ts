import { z } from 'zod';
import type { AiFootprint } from '../ai-footprint.js';
// Types only: `fields.ts` reads the settings below, so a runtime import back would be circular.
import type { FieldType } from './fields.js';

/**
 * AI fields.  An AI field is an ordinary field of one of the types below whose values a model
 * writes from a prompt, like "Summarize {Notes} in one sentence".  The field keeps its type, so it
 * shows, sorts, filters, groups, downloads, and reads through the API exactly as that type does,
 * and `ai` on the field holds what makes it an AI field.  The prompt shows field names in braces
 * and is stored with field IDs, the way a button's link is, so renaming a field never breaks it.
 *
 * Runs go through a queue on the server, read the record as the person who last saved the
 * settings (`ownerId`), and write each value through the command bus as that person, so history,
 * undo, realtime, and automations see them like any change.
 *
 * Routes:
 * - `GET /api/tables/:tableId/ai-fields` → `AiFieldsStatus` (anyone who can read the table)
 * - `POST /api/fields/:fieldId/ai/estimate` (`AiFieldEstimateRequest`) → `AiFieldEstimate`
 * - `POST /api/fields/:fieldId/ai/generate` (`AiFieldGenerate`) → `AiFieldJobView`
 * - `POST /api/ai-field-jobs/:jobId/cancel` → 204
 */

/** The types an AI field can write, which the settings call its output type. */
export const AI_FIELD_OUTPUT_TYPES = [
  'text',
  'longText',
  'singleSelect',
  'multipleSelect',
  'number',
  'checkbox',
  'date',
] as const satisfies readonly FieldType[];
export type AiFieldOutputType = (typeof AI_FIELD_OUTPUT_TYPES)[number];

export function isAiOutputType(type: FieldType): type is AiFieldOutputType {
  return (AI_FIELD_OUTPUT_TYPES as readonly FieldType[]).includes(type);
}

/**
 * How capable a model the field asks for.  `fast` is the organization's everyday model, or its
 * power model when that's the only one.  `careful` is its power model.  The admin AI settings pick
 * both, and each defaults to the cheapest capable model the organization has connected.
 */
export const AI_FIELD_TIERS = ['fast', 'careful'] as const;
export const AiFieldTier = z.enum(AI_FIELD_TIERS);
export type AiFieldTier = z.infer<typeof AiFieldTier>;

/** When a value is written: whenever a field the prompt names changes, or only when someone asks. */
export const AI_FIELD_TRIGGERS = ['referencedChange', 'onRequest'] as const;
export const AiFieldTrigger = z.enum(AI_FIELD_TRIGGERS);
export type AiFieldTrigger = z.infer<typeof AiFieldTrigger>;

export const AI_FIELD_LIMITS = {
  promptLength: 10_000,
  /** Bulk runs of more records than this need the person to confirm the estimate first */
  confirmAbove: 25,
  /** Records one bulk run may cover */
  recordsPerJob: 100_000,
} as const;

/** What a client sends to make a field an AI field, or to change its settings. */
export const AiFieldSettingsInput = z.object({
  /** Field names or IDs in braces, which the server stores as IDs */
  prompt: z.string().trim().min(1).max(AI_FIELD_LIMITS.promptLength),
  tier: AiFieldTier.default('fast'),
  trigger: AiFieldTrigger.default('referencedChange'),
});
export type AiFieldSettingsInput = z.infer<typeof AiFieldSettingsInput>;

/** An AI field's settings as stored, with the person its runs act as. */
export const AiFieldSettings = AiFieldSettingsInput.extend({
  /** Whoever last saved the settings, which the server fills in and nobody chooses */
  ownerId: z
    .string()
    .regex(/^usr[0-9A-Za-z]{14}$/)
    .nullable()
    .default(null),
});
export type AiFieldSettings = z.infer<typeof AiFieldSettings>;

/** One cell waiting for its run, or whose last run failed. */
export interface AiFieldCellState {
  fieldId: string;
  recordId: string;
  state: 'pending' | 'error';
  /** Why the last run failed, as a server message key */
  messageKey: string | null;
  /** What fills in that message, such as the model's answer that wasn't one of the options */
  params?: Record<string, string | number | boolean>;
}

export const AI_FIELD_JOB_STATES = ['running', 'done', 'canceled', 'failed'] as const;
export type AiFieldJobState = (typeof AI_FIELD_JOB_STATES)[number];

/** A run over many records at once, started from a field's menu. */
export interface AiFieldJobView {
  id: string;
  fieldId: string;
  scope: AiFieldScope;
  state: AiFieldJobState;
  total: number;
  done: number;
  failed: number;
  createdAt: string;
}

/** Where a table's AI fields stand, for the person asking.  Fields hidden from them are left out. */
export interface AiFieldsStatus {
  /**
   * Null when AI fields can run in this organization, or why they can't: `aiFields.off` when an
   * admin turned them off, `aiFields.noProvider` when no provider is connected, and
   * `aiFields.paused` when the month's budget is spent, so runs wait for the next month
   */
  unavailable: string | null;
  /** Why a field's runs stop, such as its person losing access, for each field with a problem */
  problems: Array<{ fieldId: string; messageKey: string }>;
  cells: AiFieldCellState[];
  /** Bulk runs still going, and any that ended in the last minute */
  jobs: AiFieldJobView[];
}

/** Which records a bulk run covers. */
export const AiFieldScope = z.enum(['all', 'empty', 'records']);
export type AiFieldScope = z.infer<typeof AiFieldScope>;

export const AiFieldEstimateRequest = z.object({ scope: z.enum(['all', 'empty']) });
export type AiFieldEstimateRequest = z.infer<typeof AiFieldEstimateRequest>;

/**
 * What a bulk run is likely to take, the way Rio's usage line counts it: tokens, and the cost when
 * the model's price is known.  Ranges, since answers vary in length.
 */
export interface AiFieldEstimate {
  records: number;
  providerId: string;
  model: string;
  tokens: { low: number; high: number };
  /** US dollars, or null when the model's price isn't known */
  costUsd: { low: number; high: number } | null;
  /**
   * The run's estimated footprint, from every record's answer being as short as expected to every
   * one being as long, or null when the model has no estimate
   */
  footprint: AiFootprint | null;
  /** More records than `AI_FIELD_LIMITS.confirmAbove`, so the run needs `confirmed` */
  needsConfirmation: boolean;
}

export const AiFieldGenerate = z.discriminatedUnion('scope', [
  z.object({
    scope: z.enum(['all', 'empty']),
    /** Required when the run covers more than `AI_FIELD_LIMITS.confirmAbove` records */
    confirmed: z.boolean().default(false),
  }),
  z.object({
    scope: z.literal('records'),
    recordIds: z.array(z.string().max(40)).min(1).max(AI_FIELD_LIMITS.confirmAbove),
  }),
]);
export type AiFieldGenerate = z.infer<typeof AiFieldGenerate>;
