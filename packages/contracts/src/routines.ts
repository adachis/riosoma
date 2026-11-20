import { z } from 'zod';
import { DatabaseId, FieldId, TableId, isTimeZone } from './data/fields.js';
import type { AiFootprint } from './ai-footprint.js';
import type { RioUsage } from './rio.js';

/**
 * Routines: a recurring job a person describes in plain words, like "Every Monday at 9, summarize
 * last week's new support requests and email the summary to me," which Rio carries out on a
 * schedule.  A routine belongs to one database and acts as its owner, through their access at the
 * time it runs, with the tools Rio has in the panel.
 *
 * A routine changes records and nothing else: never a field, table, view, or source.  It makes no
 * change on its own: every change a run wants is prepared and waits for the owner's approval in
 * their notifications, where they approve, change, or skip it, and a plan they approve acts as if
 * they'd made it themselves, once the server has worked it out again and found it's what they were
 * shown.  A small one, whose every change the bell shows, can be approved there in one click.  A
 * plan changes only the tables the routine says it changes, and carries nothing but records and
 * their values.  No routine writes a signature, even with approval.  Reading, and emailing
 * the owner alone, are all a run does unattended.  What waits is shown as
 * the exact changes its commands make, worked out by the server, with the model's words beside
 * them.  Email to anyone but the owner always waits, unless the owner approved that exact
 * recipient list for the routine.
 *
 * A run fetches a page at an exact address in the owner's saved words, or, from a record, only the
 * root of a site (`https://example.com/`) its owner approved for the routine, when a field the
 * plan reads pages from names it.  Who wrote the record doesn't matter, since nothing but the
 * site's root ever goes out.  A site met in no list waits as a "hosts" approval, and nothing is
 * fetched from it, nor even looked up, until the owner approves it.
 *
 * Each run stops cleanly at its cost cap, its step cap, or its time limit, and says so, and a
 * pause, an off switch, or lost access stops it before its next step.  Every email it sends and
 * page it fetches is kept with the run and in the audit log.  Record values, fetched pages, and
 * file text are data, never instructions.
 *
 * A routine paused by its owner, by itself, or by an admin runs by no path, and what it left
 * waiting can be skipped but not approved or changed until it resumes.  Only an admin lifts an
 * admin's pause or deletes a routine under one, and while one stands, the owner's new routines in
 * that database, and any of theirs there whose words, plan, recipients, or sites they change, come
 * under it too.  A run under way reads those back before each step, so taking one back stops it.
 *
 * Routes (session, and only ever the signed-in person's own routines):
 * - `GET /api/rio/routines?databaseId=` → `Routine[]`
 * - `POST /api/rio/routines/draft` (`RoutineDraftRequest`) → `RoutineDraft`, Rio's restatement
 * - `POST /api/rio/routines/sites` (`RoutineSitesRequest`) → `{ sites: string[] }`, the sites the
 *   fields a plan reads pages from name now, for the owner to approve when saving
 * - `POST /api/rio/routines` (`RoutineInput`) → `Routine`
 * - `GET`, `PATCH` (`RoutineUpdate`), and `DELETE /api/rio/routines/:routineId`
 * - `POST /api/rio/routines/:routineId/pause` and `/resume` → `Routine`
 * - `POST /api/rio/routines/:routineId/run` → `RoutineRun`, queued to run now
 * - `GET /api/rio/routines/:routineId/runs` → `RoutineRun[]`, newest first
 * - `GET /api/rio/routine-approvals/:approvalId` → `RoutineApproval`
 * - `POST /api/rio/routine-approvals/:approvalId/approve` (`RoutineApprove`) → `RoutineApproval`
 * - `POST /api/rio/routine-approvals/:approvalId/change` (`RoutineChange`) → `RoutineRun`, a run
 *   that prepares the change again with the owner's note
 * - `POST /api/rio/routine-approvals/:approvalId/skip` → `RoutineApproval`
 *
 * Admin routes (AI area, organization scope):
 * - `GET /api/admin/routines` → `AdminRoutine[]`, every routine in the organization
 * - `POST /api/admin/routines/:routineId/pause` and `/resume` → `AdminRoutine`
 * - `DELETE /api/admin/routines/:routineId`
 */

export const RoutineId = z.string().regex(/^rtn[0-9A-Za-z]{14}$/);
export const RoutineRunId = z.string().regex(/^rtr[0-9A-Za-z]{14}$/);
export const RoutineApprovalId = z.string().regex(/^rta[0-9A-Za-z]{14}$/);

export const ROUTINE_LIMITS = {
  nameLength: 100,
  instructionsLength: 4_000,
  /** The least a run may be capped at, in US dollars */
  minCapUsd: 0.01,
  /** The most an admin may let one run spend, in US dollars */
  maxLimitUsd: 100,
  /** Addresses one email may go to */
  recipients: 20,
  /** Recipient lists one routine may email without asking */
  approvedLists: 10,
  noteLength: 1_000,
  /** Sites one routine may read */
  sites: 200,
  subjectLength: 200,
  bodyLength: 20_000,
} as const;

/** What a new routine's cap starts at, in US dollars, when the admin's limit allows it */
export const ROUTINE_DEFAULT_CAP_USD = 0.25;
/** Tool calls one run may make before it stops */
export const ROUTINE_RUN_STEPS = 20;
/** How long one run may take before it stops, in milliseconds */
export const ROUTINE_RUN_TIME_MS = 5 * 60_000;
/** Failed runs in a row that pause a routine */
export const ROUTINE_FAILURE_LIMIT = 3;

const TimeOfDay = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/**
 * When a routine runs, in its time zone.  Hourly runs go on the hour.  A monthly day past the end
 * of a short month runs on that month's last day.
 */
export const RoutineSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly') }),
  z.object({ kind: z.literal('daily'), at: TimeOfDay }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 is Sunday */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    at: TimeOfDay,
  }),
  z.object({ kind: z.literal('monthly'), day: z.number().int().min(1).max(31), at: TimeOfDay }),
]);
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;

const Address = z.string().trim().toLowerCase().email().max(320);

/** An exact recipient list: addresses in lower case, each once, in order. */
export const RecipientList = z
  .array(Address)
  .min(1)
  .max(ROUTINE_LIMITS.recipients)
  .transform((list) => [...new Set(list)].sort());
export type RecipientList = z.infer<typeof RecipientList>;

/** Field types whose cells may name a site a routine reads: a URL, or a line of text */
export const ROUTINE_PAGE_FIELD_TYPES = ['url', 'text'] as const;

/** Host names that never reach the public internet, whatever they resolve to */
const PRIVATE_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|onion)$/;

/**
 * The site a value names, as an origin (`https://example.com`, with a port only when it isn't the
 * scheme's own), or null when it names none a routine may read: anything but a web address or a
 * bare host name, a host written as an IP address, a name without a dot, and names that stay on
 * private networks.  Resolving it to a public address is checked again when it's fetched.
 */
export function siteOrigin(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (
    !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ||
    /^[0-9.]+$/.test(host) ||
    !/[a-z]/.test(host.split('.').at(-1)!) ||
    PRIVATE_NAMES.test(host)
  )
    return null;
  return url.origin;
}

/** A site a routine may read the root of, written as its origin */
export const RoutineSite = z.string().refine((value) => siteOrigin(value) === value, 'not a site');

/**
 * Rio's restatement of a routine, which the owner saves with it: what it does, the tables it reads
 * and changes, what it sends to whom, and the fields whose cells name the sites it reads.  `owner`
 * in a send's `to` stands for the owner.  Every change a run proposes waits for approval, and it
 * reads a site named in a record only through a field it names.
 */
export const RoutinePlan = z.object({
  summary: z.string().trim().min(1).max(500),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  reads: z.array(TableId).max(50),
  writes: z.array(TableId).max(50),
  sends: z
    .array(
      z.object({
        to: z
          .array(z.union([z.literal('owner'), Address]))
          .min(1)
          .max(ROUTINE_LIMITS.recipients),
        what: z.string().trim().min(1).max(300),
      }),
    )
    .max(10),
  /** Fields whose cells name sites the routine reads the root of, such as a company's website */
  fetches: z
    .array(z.object({ tableId: TableId, fieldId: FieldId }))
    .max(10)
    .default([]),
});
export type RoutinePlan = z.infer<typeof RoutinePlan>;

/**
 * What one run is likely to use: its tokens, their cost when the model's price is known, and their
 * estimated energy and carbon, null when the estimate method has no data for the model.
 */
export interface RoutineEstimate {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  footprint: AiFootprint | null;
}

export const RoutineDraftRequest = z.object({
  databaseId: DatabaseId,
  instructions: z.string().trim().min(1).max(ROUTINE_LIMITS.instructionsLength),
  /** The restatement's language, as a BCP 47 tag */
  locale: z.string().min(2).max(35),
});
export type RoutineDraftRequest = z.infer<typeof RoutineDraftRequest>;

export interface RoutineDraft {
  /** A short name Rio suggests */
  name: string;
  plan: RoutinePlan;
  /** The names of the tables the plan names, by ID */
  tableNames: Record<string, string>;
  /** The names of the fields the plan reads sites from, by ID */
  fieldNames: Record<string, string>;
  estimate: RoutineEstimate;
  /** What restating it cost */
  usage: RioUsage;
  /** The most the admin lets one run spend, in US dollars */
  limitUsd: number;
}

export const RoutineInput = z.object({
  databaseId: DatabaseId,
  name: z.string().trim().min(1).max(ROUTINE_LIMITS.nameLength),
  instructions: z.string().trim().min(1).max(ROUTINE_LIMITS.instructionsLength),
  plan: RoutinePlan,
  schedule: RoutineSchedule,
  timeZone: z.string().refine(isTimeZone),
  /** The language of its reports, as a BCP 47 tag */
  locale: z.string().min(2).max(35),
  /** The most one run may spend, in US dollars, never above the admin's limit */
  costCapUsd: z.number().min(ROUTINE_LIMITS.minCapUsd).max(ROUTINE_LIMITS.maxLimitUsd),
  /** Recipient lists it may email without asking, each matched exactly */
  approvedRecipients: z.array(RecipientList).max(ROUTINE_LIMITS.approvedLists).default([]),
  /** Sites whose root it may read when a field its plan reads sites from names them */
  approvedSites: z
    .array(RoutineSite)
    .max(ROUTINE_LIMITS.sites)
    .transform((sites) => [...new Set(sites)].sort())
    .default([]),
});
export type RoutineInput = z.input<typeof RoutineInput>;

/** Anything left out keeps its current value.  New instructions need their plan with them. */
export const RoutineUpdate = RoutineInput.omit({ databaseId: true })
  .partial()
  .refine((update) => (update.instructions === undefined) === (update.plan === undefined), {
    message: 'instructions and plan change together',
  });
export type RoutineUpdate = z.input<typeof RoutineUpdate>;

export interface RoutineReceipt {
  databaseId: string;
  /** The undo group holding the changes */
  groupId: string;
  summary: string;
}

export const ROUTINE_RUN_STATES = ['queued', 'running', 'done', 'stopped', 'failed', 'skipped'] as const;
export type RoutineRunState = (typeof ROUTINE_RUN_STATES)[number];

export type RoutineApprovalStatus = 'pending' | 'approved' | 'skipped' | 'changed' | 'failed' | 'expired';

/** One value a plan changes in some records of a field: from what, to what, and in how many. */
export interface RoutineValueChange {
  before: string;
  after: string;
  records: number;
  /**
   * The primary values of the records an update changes this way, as the owner reads them, at most
   * `ROUTINE_NAMED_RECORDS`, so a plan says which records it changes and not only how
   */
  recordNames?: string[];
}

/** The most records a change names; a plan that changes more than it can name isn't small */
export const ROUTINE_NAMED_RECORDS = 20;

/** A field a plan changes values in, with each distinct change, the most common first. */
export interface RoutineFieldChange {
  fieldId: string;
  fieldName: string;
  values: RoutineValueChange[];
  /** Records changed in ways left out of `values`, which lists at most ten */
  more: number;
}

/** One record and all the values the plan assigns to it, kept together for review. */
export interface RoutineRecordChange {
  recordId: string;
  name: string;
  showId: boolean;
  kind: 'created' | 'updated' | 'trashed' | 'restored';
  fields: Array<{ fieldId: string; fieldName: string; before: string; after: string }>;
}

/** The bell shows at most twenty complete record rows and three fields per row. */
export const ROUTINE_BELL_RECORDS = 20;
export const ROUTINE_BELL_FIELDS = 3;

/** What a plan does to one table's records. */
export interface RoutineTableChange {
  tableId: string;
  tableName: string;
  created: number;
  updated: number;
  /** Records it deletes, to the trash */
  trashed: number;
  restored: number;
  /** The names of the first ten records it deletes */
  trashedNames: string[];
  fields: RoutineFieldChange[];
  /** Missing only on approvals saved before record rows were kept */
  records?: RoutineRecordChange[];
  /** Open signature requests it cancels by taking away the document they were made from */
  signaturesCanceled?: number;
}

/** The record commands a routine may propose, which apply only once its owner approves them */
export const ROUTINE_COMMAND_KINDS = [
  'record.create',
  'record.update',
  'record.trash',
  'record.restore',
] as const;

/**
 * The field types whose changes the bell may approve in one click: values that stand alone.  A plan
 * that changes anything else, such as attachments, links, and people, is approved on its card.  No
 * routine ever writes a signature, which only its signer makes.
 */
export const ROUTINE_PLAIN_FIELD_TYPES = [
  'text',
  'longText',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'date',
  'checkbox',
  'singleSelect',
  'multipleSelect',
  'email',
  'url',
  'phone',
] as const;

/** The most changes of one field the bell lists, which a plan it approves in one click stays within */
export const ROUTINE_BELL_VALUES = 3;

/**
 * What a plan waiting for approval does, worked out by the server from its commands, never from
 * the model's words: every table and how many records, which fields go from what to what, and
 * every record it deletes.  A routine changes records alone, so that's everything it can do.
 */
export interface RoutineChanges {
  tables: RoutineTableChange[];
  /** Whether it deletes any records */
  deletes: boolean;
  /**
   * Whether it only adds or edits at most twenty records, every change of which is shown in full
   * here, with no signature request canceled, which the bell may approve in one click
   */
  small: boolean;
}

/** Something a run prepared and left for the owner to approve, change, or skip. */
export interface RoutineApproval {
  id: string;
  routineId: string;
  runId: string;
  databaseId: string;
  /** Changes, an email, or sites the run met that no one has approved yet */
  kind: 'plan' | 'email' | 'hosts';
  status: RoutineApprovalStatus;
  /** The model's own words for it, which the owner reads beside `changes` */
  summary: string;
  /** A plan's steps, in the model's words */
  steps: string[];
  /** A plan's exact changes, worked out by the server when it was prepared or last refreshed */
  changes: RoutineChanges | null;
  /**
   * Which working-out of a plan's changes this is, bumped each time approving finds the plan moved
   * and stores what it would do now.  Approving a plan names the revision that was shown.
   */
  revision: number;
  /** An email, as the run wrote it or the owner changed it */
  email: { to: string[]; subject: string; body: string } | null;
  /** New sites the run met in the fields its plan reads sites from, which it may read once approved */
  sites: string[];
  /** Changes made once a plan was approved, undoable in one step */
  receipt: RoutineReceipt | null;
  /** Why it failed, as a server message key */
  messageKey: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

/** Something a run did outside the database, as the server recorded it. */
export type RoutineActivity =
  /** `status` is `sending` for an email still on its way when the run ended */
  | { kind: 'email'; to: string[]; subject: string; status: 'sent' | 'failed' | 'sending'; at: string }
  /** `status` is the page's HTTP status, or null when it couldn't be reached */
  | { kind: 'fetch'; url: string; status: number | null; at: string };

export interface RoutineRun {
  id: string;
  routineId: string;
  /** `revision` prepares a change again with the owner's note */
  trigger: 'schedule' | 'manual' | 'revision';
  state: RoutineRunState;
  /** Why it stopped, failed, or was skipped, as a server message key */
  messageKey: string | null;
  /** Rio's report, in the small Markdown subset its replies use */
  report: string | null;
  /**
   * The changes the run made on its own, undoable in one step.  Only runs from before routines
   * stopped changing anything on their own have one.
   */
  receipt: RoutineReceipt | null;
  /** Every email it sent and page it fetched, whatever its report says */
  activity: RoutineActivity[];
  approvals: RoutineApproval[];
  /** Tool calls it made */
  steps: number;
  /** Tokens, cost, and estimated energy and carbon, once it asked the model anything */
  usage: RioUsage | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Routine {
  id: string;
  databaseId: string;
  databaseName: string;
  name: string;
  instructions: string;
  plan: RoutinePlan;
  schedule: RoutineSchedule;
  timeZone: string;
  locale: string;
  costCapUsd: number;
  approvedRecipients: string[][];
  /** Sites whose root it may read, as origins */
  approvedSites: string[];
  owner: { id: string; name: string };
  /** Paused by its owner, by itself, or by an admin, so it runs by no path */
  paused: boolean;
  /** Paused by an admin, which only an admin lifts */
  adminPaused: boolean;
  /** Why it's paused, as a server message key, or null while it runs on schedule */
  pausedBecause: string | null;
  /** Failed runs in a row */
  failures: number;
  nextRunAt: string | null;
  lastRun: Pick<RoutineRun, 'id' | 'state' | 'messageKey' | 'createdAt' | 'finishedAt'> | null;
  /** Approvals waiting for the owner */
  waiting: number;
  /** The names of the tables the plan names that the owner can open, by ID */
  tableNames: Record<string, string>;
  /** The names of the fields the plan fetches pages from that the owner can see, by ID */
  fieldNames: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A routine as an admin with the AI role sees it.  Its details come only when the admin can open
 * its database themselves, since its words and plan can name fields and values.
 */
export interface AdminRoutine extends Pick<
  Routine,
  | 'id'
  | 'databaseId'
  | 'databaseName'
  | 'name'
  | 'owner'
  | 'paused'
  | 'adminPaused'
  | 'pausedBecause'
  | 'failures'
  | 'nextRunAt'
  | 'lastRun'
  | 'waiting'
> {
  details: Pick<
    Routine,
    'instructions' | 'plan' | 'schedule' | 'timeZone' | 'costCapUsd' | 'approvedRecipients' | 'approvedSites'
  > | null;
}

/**
 * Approving a plan works it out again from the database as it is.  When that differs from what the
 * owner was shown, or from the stored values the plan was made against, or `revision` isn't the
 * one stored, nothing is made, the approval holds what it would do now under a new revision, and
 * the answer is 409 `routines.approval.stale`, for the owner to read it again.  When nothing is
 * left to do, the approval closes as skipped and the answer is 409 `routines.approval.nothingLeft`.
 */
export const RoutineApprove = z.object({
  /** An email as the owner changed it before sending */
  email: z
    .object({
      to: RecipientList,
      subject: z.string().trim().min(1).max(ROUTINE_LIMITS.subjectLength),
      body: z.string().trim().min(1).max(ROUTINE_LIMITS.bodyLength),
    })
    .optional(),
  /** For an email, let the routine send to these recipients from now on without asking */
  always: z.boolean().default(false),
  /**
   * Set when approving in one click from the bell, which the server allows only for a plan marked
   * `small`, as it's worked out again at the click
   */
  oneClick: z.boolean().default(false),
  /** For a plan, the revision of its changes the owner was shown */
  revision: z.number().int().min(0).optional(),
});
export type RoutineApprove = z.input<typeof RoutineApprove>;

export const RoutineSitesRequest = z.object({
  databaseId: DatabaseId,
  fetches: z.array(z.object({ tableId: TableId, fieldId: FieldId })).max(10),
});
export type RoutineSitesRequest = z.infer<typeof RoutineSitesRequest>;

export const RoutineChange = z.object({
  /** What to do differently, in the owner's words */
  note: z.string().trim().min(1).max(ROUTINE_LIMITS.noteLength),
});
export type RoutineChange = z.infer<typeof RoutineChange>;
