import { z } from 'zod';
import { FieldId, LIMITS, Name, TableId, ViewId } from './fields.js';
import { FilterGroup } from './filters.js';
import { KnowledgeLabel } from '../knowledge-libraries.js';
import { automationConnectionProblems } from './automation-connections.js';

/**
 * Automations: when something happens in a database, do a series of steps.  An automation acts
 * as the person who turned it on, through the same commands and permissions as the app, so its
 * changes are audited, broadcast, and in the records' history, marked as coming from the
 * automation.  If that person loses access, the automation stops and says why.
 *
 * Automations change through commands (`automation.create`, `automation.update`,
 * `automation.publish`, `automation.discardDraft`, `automation.restoreVersion`, `automation.move`,
 * `automation.trash`, `automation.restore`), like dashboards.  What runs is the published version.
 * Changing the configuration saves a draft, which runs only in tests until someone publishes it.
 * Publishing keeps the version it replaces, the last 20 of them, and any of those can come back
 * as a draft.  Runs are read, tested, rerun, and resumed through routes (session, read access to
 * see runs and versions, schema access for the rest):
 * - `GET /api/automations/:automationId/runs?cursor=` → `AutomationRunsPage`
 * - `GET /api/automations/:automationId/versions` → `AutomationVersionsList`
 * - `POST /api/automations/:automationId/test` (`AutomationTest`) → `AutomationRun`
 * - `POST /api/automations/:automationId/runs/:runId/rerun` → `AutomationRun`, queued: the
 *   published version again, with the same trigger
 * - `POST /api/automations/:automationId/runs/:runId/resume` (`AutomationResume`) →
 *   `AutomationRun`, queued: the steps before the failed one keep what they did, and the run goes
 *   on from there
 * - `POST /api/automations/:automationId/simulate` (`AutomationSimulate`) → `AutomationSimulation`,
 *   a walk through every step that sends nothing, saves nothing, and is never a run
 * - `POST /api/hooks/:automationId/:secret` (public) starts a webhook automation with the JSON
 *   body, answering 202 at once
 *
 * Text in steps can include values with `{{…}}` tokens: `{{trigger.record.<fieldId>}}`,
 * `{{steps.<stepId>.record.<fieldId>}}`, `{{trigger.body.<path>}}` for webhooks, `{{now}}`, and
 * `{{trigger.record.url}}` for a link to the record.
 */
export const AutomationId = z.string().regex(/^aut[0-9A-Za-z]{14}$/);
export const StepId = z.string().regex(/^[0-9A-Za-z_-]{6,40}$/);

export const AutomationEndpoint = z.object({
  stepId: z.union([StepId, z.literal('trigger')]),
  port: z.string().min(1).max(40),
});
export type AutomationEndpoint = z.infer<typeof AutomationEndpoint>;
export const AutomationConnection = z.object({
  id: StepId,
  source: AutomationEndpoint,
  target: AutomationEndpoint,
});
export type AutomationConnection = z.infer<typeof AutomationConnection>;

/** Text that may contain `{{…}}` tokens */
export const Template = z.string().max(LIMITS.descriptionLength);

export const AutomationTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recordCreated'), tableId: TableId }),
  z.object({
    kind: z.literal('recordUpdated'),
    tableId: TableId,
    /** Only when one of these changes; any field when empty */
    fieldIds: z.array(FieldId).max(50).default([]),
  }),
  /** When a record starts matching, through a view's filter or its own */
  z.object({
    kind: z.literal('recordMatches'),
    tableId: TableId,
    viewId: ViewId.nullable().default(null),
    filter: FilterGroup.nullable().default(null),
  }),
  z.object({ kind: z.literal('formSubmitted'), viewId: ViewId }),
  z.object({
    kind: z.literal('schedule'),
    every: z.object({ unit: z.enum(['hour', 'day', 'week']), n: z.number().int().min(1).max(52) }),
    /** Local time of day, for daily and weekly schedules */
    at: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .default('09:00'),
    /** 0 is Sunday, for weekly schedules */
    weekday: z.number().int().min(0).max(6).default(1),
    timeZone: z.string().min(1).max(64),
  }),
  /** Called by another system at this automation's webhook address */
  z.object({ kind: z.literal('webhook') }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

const stepBase = { id: StepId, name: z.string().max(LIMITS.nameLength).default('') };

/**
 * A messaging step's credential never comes back once saved.  `secretSaved` says whether there is
 * one, and `secretRef` names which of the automation's sealed credentials this configuration uses,
 * so a draft, an earlier version, or an undo keeps sending where it did.  Only a name the server
 * gave this same step counts.
 */
const saved = {
  secretSaved: z.boolean().optional(),
  secretRef: z.string().max(120).optional(),
};

export const CalendarEventInput = z.object({
  provider: z.enum(['google-calendar', 'microsoft-calendar']),
  calendarId: z.string().max(500).default(''),
  title: Template,
  description: Template.default(''),
  start: Template,
  end: Template,
  timeZone: z.string().min(1).max(64).default('UTC'),
});
export type CalendarEventInput = z.infer<typeof CalendarEventInput>;

export const NotificationRecipients = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('people'), userIds: z.array(z.string().regex(/^usr[0-9A-Za-z]{14}$/)).max(50) }),
  z.object({ kind: z.literal('group'), groupId: z.string().regex(/^grp[0-9A-Za-z]{14}$/) }),
  z.object({ kind: z.literal('personField'), fieldId: FieldId }),
  z.object({ kind: z.literal('recordCreator') }),
  z.object({ kind: z.literal('automationOwner') }),
]);
export type NotificationRecipients = z.infer<typeof NotificationRecipients>;

const ActionStep = z.discriminatedUnion('kind', [
  z.object({
    ...stepBase,
    kind: z.literal('sendNotification'),
    recipients: NotificationRecipients,
    title: Template,
    body: Template,
    link: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('record') }),
        z.object({ kind: z.literal('none') }),
        z.object({ kind: z.literal('custom'), url: Template }),
      ])
      .default({ kind: 'record' }),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('findRecords'),
    tableId: TableId,
    filter: FilterGroup.nullable().default(null),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('createCalendarEvent'),
    ...CalendarEventInput.shape,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('generateDocument'),
    tableId: TableId,
    record: z.union([z.literal('trigger'), z.literal('item'), StepId]),
    templateFieldId: z.union([FieldId, z.literal('')]),
    attachmentFieldId: z.union([FieldId, z.literal('')]),
    format: z.enum(['docx', 'pdf', 'xlsx']),
    filename: Template.default(''),
    values: z.record(z.string().min(1).max(100), Template).default({}),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('askAi'),
    prompt: Template,
    format: z.enum(['text', 'json']).default('text'),
    tier: z.enum(['everyday', 'power']).default('everyday'),
    classification: KnowledgeLabel.default('internal'),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('slack'),
    webhookUrl: z.string().max(4096).default(''),
    ...saved,
    body: Template,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('teams'),
    webhookUrl: z.string().max(4096).default(''),
    ...saved,
    body: Template,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('studioFlow'),
    webhookUrl: z.string().max(4096).default(''),
    ...saved,
    body: Template,
    title: Template.default(''),
    recipient: Template,
    recordUrl: Template.default(''),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('discord'),
    webhookUrl: z.string().max(4096).default(''),
    ...saved,
    body: Template,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('sms'),
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    authToken: z.string().max(1024).default(''),
    ...saved,
    from: z.string().regex(/^\+[1-9][0-9]{1,14}$/),
    to: Template,
    body: Template,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('script'),
    script: z
      .string()
      .max(65536)
      .refine((value) => new TextEncoder().encode(value).length <= 65536),
    input: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), Template)
      .refine((value) => Object.keys(value).length <= 100)
      .default({}),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('updateRecord'),
    tableId: TableId,
    /** The trigger's record, or a record an earlier step created */
    record: z.union([z.literal('trigger'), z.literal('item'), StepId]),
    values: z.record(FieldId, Template),
    baseValues: z.record(FieldId, Template).optional(),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('createRecord'),
    tableId: TableId,
    values: z.record(FieldId, Template),
  }),
  z.object({
    ...stepBase,
    kind: z.literal('sendEmail'),
    /** Addresses, or tokens naming email and person fields */
    to: z.array(Template).min(1).max(20),
    subject: Template,
    /** A small Markdown subset */
    body: Template,
  }),
  z.object({
    ...stepBase,
    kind: z.literal('callWebhook'),
    url: Template,
    method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
    headers: z.record(z.string().max(100), Template).default({}),
    /** A JSON template; tokens inside strings are filled in and escaped */
    body: Template.default(''),
  }),
]);
type ActionStep = z.infer<typeof ActionStep>;
type FlowBase = { id: string; name: string };
export type AutomationStep =
  | ActionStep
  | (FlowBase &
      (
        | { kind: 'if'; conditions: FilterGroup | null; then: AutomationStep[]; otherwise: AutomationStep[] }
        | {
            kind: 'switch';
            value: string;
            cases: Array<{ id: string; value: string; steps: AutomationStep[] }>;
            otherwise: AutomationStep[];
          }
        | { kind: 'repeat'; list: string; steps: AutomationStep[] }
        | {
            kind: 'wait';
            mode: 'duration' | 'date' | 'condition';
            seconds: number;
            date: string;
            conditions: FilterGroup | null;
            timeoutSeconds: number;
          }
      ));

type FlowInputBase = { id: string; name?: string };
type AutomationStepInput =
  | z.input<typeof ActionStep>
  | (FlowInputBase &
      (
        | {
            kind: 'if';
            conditions?: unknown;
            then: AutomationStepInput[];
            otherwise: AutomationStepInput[];
          }
        | {
            kind: 'switch';
            value: string;
            cases: Array<{ id: string; value: string; steps: AutomationStepInput[] }>;
            otherwise: AutomationStepInput[];
          }
        | { kind: 'repeat'; list: string; steps: AutomationStepInput[] }
        | (Omit<Extract<AutomationStep, { kind: 'wait' }>, 'id' | 'name' | 'conditions'> & {
            conditions?: unknown;
          })
      ));

export const AutomationStep: z.ZodType<AutomationStep, AutomationStepInput> = z.lazy(() =>
  z.union([
    ActionStep,
    z.object({
      ...stepBase,
      kind: z.literal('if'),
      conditions: FilterGroup.nullable(),
      then: z.array(AutomationStep).max(25),
      otherwise: z.array(AutomationStep).max(25),
    }),
    z.object({
      ...stepBase,
      kind: z.literal('switch'),
      value: Template,
      cases: z
        .array(z.object({ id: StepId, value: Template, steps: z.array(AutomationStep).max(25) }))
        .max(20),
      otherwise: z.array(AutomationStep).max(25),
    }),
    z.object({
      ...stepBase,
      kind: z.literal('repeat'),
      list: Template,
      steps: z.array(AutomationStep).max(25),
    }),
    z.object({
      ...stepBase,
      kind: z.literal('wait'),
      mode: z.enum(['duration', 'date', 'condition']),
      seconds: z.number().int().min(0).max(31536000),
      date: Template,
      conditions: FilterGroup.nullable(),
      timeoutSeconds: z.number().int().min(1).max(31536000),
    }),
  ]),
);

export function automationPaths(step: AutomationStep): Array<{ id: string; steps: AutomationStep[] }> {
  if (step.kind === 'if')
    return [
      { id: 'then', steps: step.then },
      { id: 'otherwise', steps: step.otherwise },
    ];
  if (step.kind === 'switch') return [...step.cases, { id: 'otherwise', steps: step.otherwise }];
  if (step.kind === 'repeat') return [{ id: 'items', steps: step.steps }];
  return [];
}

export function automationStepEntries(
  steps: readonly AutomationStep[],
  prefix: Array<string | number> = ['steps'],
): Array<{ step: AutomationStep; path: Array<string | number> }> {
  return steps.flatMap((step, index) => {
    const path = [...prefix, index];
    const children =
      step.kind === 'if'
        ? [
            ...automationStepEntries(step.then, [...path, 'then']),
            ...automationStepEntries(step.otherwise, [...path, 'otherwise']),
          ]
        : step.kind === 'repeat'
          ? automationStepEntries(step.steps, [...path, 'steps'])
          : step.kind === 'switch'
            ? [
                ...step.cases.flatMap((branch, at) =>
                  automationStepEntries(branch.steps, [...path, 'cases', at, 'steps']),
                ),
                ...automationStepEntries(step.otherwise, [...path, 'otherwise']),
              ]
            : [];
    return [{ step, path }, ...children];
  });
}

export function flattenAutomationSteps(steps: readonly AutomationStep[]): AutomationStep[] {
  return steps.flatMap((step) => [
    step,
    ...automationPaths(step).flatMap((path) => flattenAutomationSteps(path.steps)),
  ]);
}

export function mapAutomationSteps(
  steps: readonly AutomationStep[],
  map: (step: AutomationStep) => AutomationStep,
): AutomationStep[] {
  return steps.map((step) => {
    if (step.kind === 'if')
      step = {
        ...step,
        then: mapAutomationSteps(step.then, map),
        otherwise: mapAutomationSteps(step.otherwise, map),
      };
    if (step.kind === 'switch')
      step = {
        ...step,
        cases: step.cases.map((path) => ({ ...path, steps: mapAutomationSteps(path.steps, map) })),
        otherwise: mapAutomationSteps(step.otherwise, map),
      };
    if (step.kind === 'repeat') step = { ...step, steps: mapAutomationSteps(step.steps, map) };
    return map(step);
  });
}

export const AutomationConfig = z
  .object({
    trigger: AutomationTrigger,
    /** Checked against the trigger's record before any step runs */
    conditions: FilterGroup.nullable().default(null),
    steps: z.array(AutomationStep).max(25).default([]),
    /** Absent in older saves, which retain their ordered paths.  An empty graph is a disconnected draft. */
    connections: z.array(AutomationConnection).max(600).optional(),
    loopItemCap: z.number().int().min(1).max(10000).optional(),
    notes: z
      .array(
        z.object({
          id: StepId,
          text: Template,
          x: z.number().min(0).max(100000),
          y: z.number().min(0).max(100000),
        }),
      )
      .max(100)
      .optional(),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    let count = 0;
    const visit = (steps: AutomationStep[], depth: number) => {
      for (const step of steps) {
        const paths = automationPaths(step);
        if (ids.has(step.id) || step.id === 'trigger' || ++count > 100 || (paths.length && depth >= 5))
          context.addIssue({ code: 'custom', message: 'automations.flow.invalid' });
        ids.add(step.id);
        if (
          step.kind === 'switch' &&
          (new Set(step.cases.map((path) => path.value)).size !== step.cases.length ||
            new Set(step.cases.map((path) => path.id)).size !== step.cases.length ||
            step.cases.some((path) => path.id === 'otherwise'))
        )
          context.addIssue({ code: 'custom', message: 'automations.flow.invalid' });
        for (const path of paths) visit(path.steps, depth + 1);
      }
    };
    visit(config.steps, 0);
    for (const problem of automationConnectionProblems(config, false))
      context.addIssue({ code: 'custom', message: problem.messageKey, path: ['connections'] });
  });
export type AutomationConfig = z.infer<typeof AutomationConfig>;

/** Versions count up from 1 as they're published, and a number never comes back. */
export const AutomationVersionNumber = z.number().int().positive().safe();

/** How many versions an automation keeps besides the published one */
export const AUTOMATION_VERSIONS_KEPT = 20;

/** Changes to an automation that aren't live yet */
export const AutomationDraft = z.object({
  config: AutomationConfig,
  updatedAt: z.string(),
  /** Who changed it last */
  updatedBy: z.string().nullable(),
});
export type AutomationDraft = z.infer<typeof AutomationDraft>;

export const AutomationMeta = z.object({
  id: AutomationId,
  databaseId: z.string(),
  name: Name,
  position: z.number(),
  enabled: z.boolean(),
  /** The published version: what runs */
  config: AutomationConfig,
  /** The published version's number, where absent reads as 1 */
  version: AutomationVersionNumber.optional(),
  publishedAt: z.string().nullable().optional(),
  /** Explicit in new snapshots because older published copies had no publication timestamp */
  neverPublished: z.boolean().optional(),
  publishedBy: z.string().nullable().optional(),
  /**
   * Changes saved since the last publish, or null when there are none.  Only people who can change
   * the automation see it.
   */
  draft: AutomationDraft.nullable().optional(),
  /** Who it acts as: whoever turned it on last */
  runAsId: z.string().nullable(),
  /** Set when it stopped on its own, with the reason's message key */
  stoppedBecause: z.string().nullable(),
  /** The webhook address's path, for webhook automations, shown only to people who can change it */
  webhookPath: z.string().nullable().optional(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationMeta = z.infer<typeof AutomationMeta>;

export const AutomationCreate = z.object({
  id: AutomationId,
  name: Name,
  config: AutomationConfig,
  /** Starts with an unpublished draft that a person must publish before enabling */
  draftOnly: z.boolean().optional(),
});
export type AutomationCreate = z.infer<typeof AutomationCreate>;

export const AUTOMATION_RUN_STATES = [
  'queued',
  'running',
  'waiting',
  'canceled',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type AutomationRunState = (typeof AUTOMATION_RUN_STATES)[number];

export interface AutomationRun {
  id: string;
  automationId: string;
  state: AutomationRunState;
  /** What started it */
  trigger: { kind: AutomationTrigger['kind']; recordId: string | null; at: string };
  /** Whether it was a test run from the editor */
  test: boolean;
  /**
   * The published version it ran, or null for a test of the draft and for runs from before
   * versions were kept
   */
  version?: number | null;
  /** Whether it was a test of the draft */
  draft?: boolean;
  /**
   * For a rerun or a resumed run, the run it came from and when that one started, or was queued if
   * it never started, while it's still kept.  A resumed run also names the step it went on from.
   */
  from?: { runId: string; kind: 'rerun' | 'resume'; stepId?: string; at: string | null };
  /** The only step executed by a single-step test */
  testStepId?: string;
  steps: Array<{
    stepId: string;
    executionId?: string;
    path?: string[];
    state: AutomationRunState;
    /** A failed outcome completed by following its error connection */
    handled?: boolean;
    /** In a resumed run, a step that kept what it did in the run it came from instead of running again */
    reused?: boolean;
    ms: number | null;
    /** What the step did, such as the record it created or the address it emailed */
    output: Record<string, unknown> | null;
    logs?: Array<{ level: 'log' | 'info' | 'warn' | 'error'; text: string }>;
    input?: Record<string, unknown>;
    error: { messageKey: string; detail?: string; line?: number; column?: number } | null;
  }>;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AutomationRunsPage {
  runs: AutomationRun[];
  next: string | null;
}

/** A version as the list shows it.  Its configuration comes back only by restoring it. */
export interface AutomationVersion {
  version: number;
  publishedAt: string | null;
  publishedBy: string | null;
  /** Whether it's the published version */
  live: boolean;
  trigger: AutomationTrigger['kind'];
  steps: number;
}

export interface AutomationVersionsList {
  /** Newest first, the published version among them */
  versions: AutomationVersion[];
}

export const AutomationResume = z.object({
  /** The step that failed, where the new run goes on from */
  stepId: StepId,
});
export type AutomationResume = z.infer<typeof AutomationResume>;

export const AutomationTest = z.object({
  /** The record to run it with, for record triggers; the newest matching record when left out */
  recordId: z.string().max(40).optional(),
});
export type AutomationTest = z.infer<typeof AutomationTest>;

export const AutomationMessagingPolicy = z.object({ smsEnabled: z.boolean() });
export type AutomationMessagingPolicy = z.infer<typeof AutomationMessagingPolicy>;

export const AutomationStepTest = z.object({
  preview: z.boolean().default(false),
  /** Sample values keyed by token path, including recordId for update targets */
  samples: z.record(z.string().max(500), z.unknown()).default({}),
});
export type AutomationStepTest = z.infer<typeof AutomationStepTest>;

export interface AutomationStepTestPreview {
  source: 'history' | 'sample';
  inputs: Record<string, unknown>;
  missing: string[];
  error: { messageKey: string; detail?: string } | null;
}

export const AutomationSimulate = z.object({
  /** The trigger's record, for record triggers, or the newest matching record when left out */
  recordId: z.string().max(40).optional(),
  /** A webhook call's JSON body, or the last call received when left out */
  body: z.unknown().optional(),
});
export type AutomationSimulate = z.infer<typeof AutomationSimulate>;

/** A record change a simulation worked out and threw away, with values as the person reads them. */
export interface SimulatedWrite {
  tableId: string;
  recordId: string;
  created: boolean;
  /** Only the fields that change, with empty values as null */
  changes: Array<{ fieldId: string; before: string | null; after: string | null }>;
}

/** Something a step would send, with its content filled in. */
export type SimulatedSend =
  | {
      kind: 'notification';
      recipients: Array<{ id: string; name: string; title: string; message: string; link: string }>;
    }
  | { kind: 'email'; to: string[]; subject: string; text: string }
  | {
      kind: 'message';
      channel: 'slack' | 'teams' | 'studioFlow' | 'discord' | 'sms';
      to?: string;
      text: string;
      title?: string;
      recordUrl?: string;
    }
  | {
      kind: 'webhook' | 'fetch';
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    };

export interface SimulatedStep {
  executionId?: string;
  path?: string[];
  stepId: string;
  state: 'succeeded' | 'failed' | 'skipped';
  /** A failed outcome whose error connection lets the simulation continue */
  handled?: boolean;
  ms: number | null;
  /** The step's settings with every token filled in */
  input: Record<string, unknown> | null;
  /** What later steps read from it.  A step that would send gets a stand-in answer. */
  output: Record<string, unknown> | null;
  writes: SimulatedWrite[];
  sends: SimulatedSend[];
  logs?: Array<{ level: 'log' | 'info' | 'warn' | 'error'; text: string }>;
  error: { messageKey: string; detail?: string; line?: number; column?: number } | null;
}

export interface AutomationSimulation {
  /** Finished every step, stopped at an error, or stopped before the steps */
  state: 'succeeded' | 'failed' | 'skipped';
  /** Why the steps didn't run, when they didn't: the conditions, or a record that can't be read */
  skippedBecause?: 'conditions' | 'record';
  trigger: {
    kind: AutomationTrigger['kind'];
    recordId: string | null;
    body: unknown;
    /** The trigger record's values by field ID, as the person simulating reads them */
    values: Record<string, string | null>;
  };
  /**
   * Each of the top-level conditions and whether the record meets it, or null without conditions.
   * A condition on a field hidden from the person simulating is left out, as a view's filter leaves
   * it out for them, and its part is null.
   */
  conditions: { matched: boolean; parts: Array<boolean | null> } | null;
  steps: SimulatedStep[];
  /**
   * Whose access the simulation read and wrote with: always the person simulating.  `differs` is
   * set when a real run acts as someone whose access reads differently, named by `ownerId`.
   */
  access: { userId: string; ownerId: string | null; differs: boolean };
}
