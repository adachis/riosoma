import { z } from 'zod';
import { LIMITS, UserId, ViewId, isTimeZone } from './data/fields.js';

/**
 * Scheduled reports: a view's records, emailed on a schedule as a file and a short summary.  Each
 * schedule belongs to a view and to the person who set it up.  Anyone who can read the view can
 * send one to themselves, and people who can change the view can add other members of the
 * database, or, when the organization allows it, addresses outside it.
 *
 * Every member gets the records and fields they could see themselves when it's sent, so one
 * schedule can send different rows to different people.  An outside address gets what the
 * schedule's owner sees, which is why the organization has to allow them, and why they're never
 * allowed for a database with restricted fields.
 *
 * Routes (session unless marked):
 * - `GET /api/views/:viewId/reports` → `ViewReports`
 * - `POST /api/views/:viewId/reports` (`ReportScheduleInput`) → `ReportSchedule`
 * - `GET /api/reports` → `MyReports`, every schedule the person owns or receives
 * - `PUT /api/reports/:reportId` (`ReportScheduleInput`) → `ReportSchedule`, its owner only
 * - `DELETE /api/reports/:reportId` → 204, its owner or a manager of the database
 * - `POST /api/reports/:reportId/send` → `ReportRun`, sends it now, its owner only
 * - `GET /api/reports/:reportId/download` → a fresh PDF through the caller's own read access
 * - `POST /api/reports/:reportId/leave` → 204, stops the signed-in person receiving it
 * - `GET /api/reports/:reportId/runs?cursor=` → `ReportRunsPage`, newest first
 * - `GET /api/reports/unsubscribe?token=` (public) → `ReportUnsubscribePreview`
 * - `POST /api/reports/unsubscribe?token=` (public) → 204, the link in every email's footer
 * - `GET` and `PUT /api/admin/reports/policy` (admins for security) → `ReportPolicy`
 */
export const ReportId = z.string().regex(/^rpt[0-9A-Za-z]{14}$/);

/** A report deck lays out a slide for each record, as a downloaded deck does to start. */
export const REPORT_FORMATS = ['csv', 'xlsx', 'docx', 'pptx', 'pdf', 'none'] as const;
export const ReportFormat = z.enum(REPORT_FORMATS);
export type ReportFormat = z.infer<typeof ReportFormat>;

/** A file larger than this isn't attached, and the email links to the view instead. */
export const REPORT_ATTACHMENT_LIMIT = 20 * 1024 * 1024;
/** How many records the email's summary shows */
export const REPORT_SUMMARY_RECORDS = 20;
/** How many of the view's visible fields the summary shows, from the left */
export const REPORT_SUMMARY_FIELDS = 5;
/** The most people and addresses one schedule sends to */
export const REPORT_RECIPIENT_LIMIT = 50;
/** How long the link to stop receiving a report keeps working after it's sent */
export const REPORT_UNSUBSCRIBE_DAYS = 90;

const TimeOfDay = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/**
 * When it's sent, at a local time of day in the schedule's time zone.  A monthly day past the end
 * of a short month sends on that month's last day.
 */
export const ReportFrequency = z.discriminatedUnion('kind', [
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
export type ReportFrequency = z.infer<typeof ReportFrequency>;

const Address = z.string().trim().toLowerCase().email().max(320);

export const ReportRecipient = z.discriminatedUnion('kind', [
  /** A member of the organization, who gets what they could see themselves */
  z.object({ kind: z.literal('member'), userId: UserId }),
  /** An address outside the organization, which gets what the owner sees */
  z.object({ kind: z.literal('address'), address: Address }),
]);
export type ReportRecipient = z.infer<typeof ReportRecipient>;

export const ReportScheduleInput = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameLength),
  format: ReportFormat,
  recipients: z.array(ReportRecipient).min(1).max(REPORT_RECIPIENT_LIMIT),
  frequency: ReportFrequency,
  timeZone: z.string().refine(isTimeZone),
  enabled: z.boolean(),
});
export type ReportScheduleInput = z.infer<typeof ReportScheduleInput>;

/** A recipient as the app shows one: a member by name, or an address as written. */
export type ReportRecipientInfo =
  { kind: 'member'; userId: string; name: string } | { kind: 'address'; address: string };

export interface ReportSchedule {
  id: string;
  databaseId: string;
  tableId: string;
  viewId: string;
  databaseName: string;
  tableName: string;
  viewName: string;
  name: string;
  format: ReportFormat;
  frequency: ReportFrequency;
  timeZone: string;
  enabled: boolean;
  /** Everyone it goes to, for its owner and people who can change the view, and empty otherwise */
  recipients: ReportRecipientInfo[];
  owner: { id: string; name: string };
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** A server message key saying why it turned itself off, or null */
  stoppedBecause: string | null;
  createdAt: string;
  updatedAt: string;
  /** Whether the person asking can change it, which only its owner can */
  canEdit: boolean;
  /** Whether the person asking can delete it: its owner, or a manager of the database */
  canDelete: boolean;
  /** Whether the person asking receives it */
  receiving: boolean;
}

/** Someone a report can go to: a member of the organization who can open the database */
export interface ReportMember {
  id: string;
  name: string;
  email: string;
}

export interface ViewReports {
  reports: ReportSchedule[];
  /** Whether the person can send to other members of the database */
  canAddMembers: boolean;
  /** The people they can add, when they can add anyone */
  members: ReportMember[];
  /** Whether addresses outside the organization are allowed for this view */
  outsideAllowed: boolean;
  /** Whether this server can send email at all */
  emailAvailable: boolean;
}

export interface MyReports {
  /** The ones the person set up */
  owned: ReportSchedule[];
  /** The ones someone else set up that the person receives */
  receiving: ReportSchedule[];
}

export const REPORT_RUN_STATES = [
  'queued',
  'running',
  'retrying',
  'sent',
  'partial',
  'failed',
  'skipped',
] as const;
export type ReportRunState = (typeof REPORT_RUN_STATES)[number];

export const REPORT_DELIVERY_STATES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type ReportDeliveryState = (typeof REPORT_DELIVERY_STATES)[number];

/** A server message key and, for mail failures, the provider's error code.  Never a value. */
export interface ReportError {
  messageKey: string;
  code?: string;
}

/** One recipient's part of a run: counts and what went wrong, never a record's values. */
export interface ReportDelivery {
  recipient: ReportRecipientInfo;
  state: ReportDeliveryState;
  /** How many records this recipient got */
  records: number | null;
  /** Whether the file went as an attachment, as a link because it was too large, or not at all */
  attachment: 'attached' | 'linked' | 'none' | null;
  attempts: number;
  error: ReportError | null;
  /** Fidelity and size notes use message keys.  Older runs may have none. */
  notes?: string[];
}

export interface ReportRun {
  id: string;
  trigger: 'schedule' | 'manual';
  state: ReportRunState;
  dueAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** When a run waiting after a mail failure tries again */
  retryAt: string | null;
  attempts: number;
  deliveries: ReportDelivery[];
  /** Why a run that sent nothing didn't */
  error: ReportError | null;
}

export interface ReportRunsPage {
  runs: ReportRun[];
  next: string | null;
}

export const ReportRunsQuery = z.object({ cursor: z.string().max(200).optional() });

/** Any text at all, so a link cut short in an email reads as a link that doesn't work. */
export const ReportUnsubscribeQuery = z.object({ token: z.string().max(2000) });
export type ReportUnsubscribeQuery = z.infer<typeof ReportUnsubscribeQuery>;

export interface ReportUnsubscribePreview {
  reportName: string;
  viewName: string;
  /** False once this recipient has already stopped receiving it */
  receiving: boolean;
}

export const ReportPolicy = z.object({
  /** Whether scheduled reports may go to addresses outside the organization.  Off by default. */
  outsideRecipients: z.boolean(),
});
export type ReportPolicy = z.infer<typeof ReportPolicy>;

export const ReportParams = z.object({ reportId: ReportId });
export const ReportViewParams = z.object({ viewId: ViewId });
