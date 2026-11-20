import { FEEDBACK_LIMITS } from './feedback-limits.js';
import { z } from 'zod';
import { idKind } from './ids.js';

/**
 * Feedback: a calm way for anyone in an organization to say something's broken, share an idea,
 * or ask a question, from wherever they are in the app, and one place for its admins to read it.
 *
 * Each piece carries a little context the sender sees before it goes: where they were, without
 * any record's ID, the app's version, their browser and platform, their theme and language, and
 * the last few errors the page ran into, as messages and stacks only.  A screenshot is optional,
 * taken in the browser with every value blurred out before it leaves the page.
 *
 * Feedback stays in the organization until an admin reviews and publishes a bug report through
 * an enabled GitHub or hub path. Hub reports carry only the redacted contract fields, with no screenshot.
 *
 * Routes:
 * - `POST /api/feedback` (session, `FeedbackCreate`) → `FeedbackCreated`, at most 20 an hour a person
 * - `GET /api/feedback/mine` (session) → `SentFeedbackList`, what the person sent and the replies
 * - `GET /api/admin/feedback?kind=&status=&before=` (feedback admins) → `FeedbackPage`, newest first
 * - `GET /api/admin/feedback/count` (feedback admins) → `FeedbackCount`
 * - `GET /api/admin/feedback/:feedbackId/screenshot` (feedback admins) → the image
 * - `PUT /api/admin/feedback/:feedbackId/status` (feedback admins, `FeedbackStatusUpdate`) → `FeedbackItem`
 * - `POST /api/admin/feedback/:feedbackId/replies` (feedback admins, `FeedbackReplyCreate`) → `FeedbackItem`
 * - `DELETE /api/admin/feedback/:feedbackId` (feedback admins) → 204
 * - `GET /api/admin/feedback/github` (feedback admins) → `FeedbackGithubSettings`
 * - `PUT /api/admin/feedback/github` (integrations admins, `FeedbackGithubUpdate`) → `FeedbackGithubSettings`
 * - `POST /api/admin/feedback/:feedbackId/github/preview` (feedback admins, `FeedbackIssueRequest`) → `FeedbackIssuePreview`
 * - `POST /api/admin/feedback/:feedbackId/github` (feedback admins, `FeedbackIssueSend`) → `FeedbackItem`
 *
 * "Feedback admins" are the organization's owners and members holding the `feedback` admin role.
 */
export const FeedbackId = z.string().regex(/^fbk[0-9A-Za-z]{14}$/);

export const FEEDBACK_KINDS = ['broken', 'idea', 'question'] as const;
export const FeedbackKind = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const FEEDBACK_STATUSES = ['new', 'seen', 'done'] as const;
export const FeedbackStatus = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;

export { FEEDBACK_LIMITS } from './feedback-limits.js';

/** The image types a screenshot may be, as the browser's canvas writes them */
export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** A screenshot as a data URL: its type and its base64 bytes, and never larger than the cap. */
export const ScreenshotDataUrl = z
  .string()
  .max(Math.ceil(FEEDBACK_LIMITS.screenshotBytes / 3) * 4 + 40)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

/** One error the page ran into: what it said and where, never the values it was working with. */
export const FeedbackClientError = z.object({
  message: z.string().max(FEEDBACK_LIMITS.errorMessageLength),
  stack: z.string().max(FEEDBACK_LIMITS.errorStackLength).optional(),
});
export type FeedbackClientError = z.infer<typeof FeedbackClientError>;

/** Placeholders a feedback path uses where a record's ID or another value stood. */
export const FEEDBACK_PATH_RECORD = ':record';
export const FEEDBACK_PATH_VALUE = ':value';

/**
 * Where someone was, fit to send: the path alone, with no search or fragment, each record's ID
 * replaced by `:record`, and anything else that isn't an ID or a plain word replaced by `:value`.
 * Databases, tables, views, dashboards, automations, and interfaces keep their IDs, since those
 * name places rather than anyone's data.
 */
export function feedbackPath(pathname: string): string {
  const segments = pathname
    .split(/[?#]/, 1)[0]!
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return FEEDBACK_PATH_VALUE;
      }
      // A path written here before comes back the same.
      if (decoded === FEEDBACK_PATH_RECORD || decoded === FEEDBACK_PATH_VALUE) return decoded;
      const kind = idKind(decoded);
      if (kind === 'record') return FEEDBACK_PATH_RECORD;
      if (kind) return decoded;
      return /^[a-z][a-z-]{0,39}$/.test(decoded) ? decoded : FEEDBACK_PATH_VALUE;
    });
  return `/${segments.join('/')}`;
}

/** What goes with a piece of feedback, shown to the sender before it's sent. */
export const FeedbackContext = z.object({
  /** Where the person was, as `feedbackPath` writes it */
  path: z
    .string()
    .max(500)
    .refine((path) => feedbackPath(path) === path),
  appVersion: z.string().max(60),
  browser: z.string().max(80),
  platform: z.string().max(80),
  /** The theme, and its color scheme and mode where they're chosen */
  theme: z.string().max(120),
  language: z.string().max(35),
  /** The page's most recent errors, oldest first */
  errors: z.array(FeedbackClientError).max(FEEDBACK_LIMITS.errors),
});
export type FeedbackContext = z.infer<typeof FeedbackContext>;

export const FeedbackCreate = z.object({
  kind: FeedbackKind,
  message: z.string().trim().min(1).max(FEEDBACK_LIMITS.messageLength),
  context: FeedbackContext,
  screenshot: ScreenshotDataUrl.optional(),
});
export type FeedbackCreate = z.infer<typeof FeedbackCreate>;

export interface FeedbackCreated {
  id: string;
}

export interface FeedbackReply {
  id: string;
  body: string;
  /** The admin who wrote it, or null once they're gone */
  author: { id: string; name: string } | null;
  createdAt: string;
}

/** Feedback as its sender sees it afterward, with the admins' replies. */
export interface SentFeedback {
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  createdAt: string;
  replies: FeedbackReply[];
}

export interface SentFeedbackList {
  /** Newest first, the last 50 */
  items: SentFeedback[];
}

/** Feedback as its organization's admins see it. */
export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  context: FeedbackContext;
  /** The screenshot's size and type, or null when none came with it */
  screenshot: { bytes: number; type: string } | null;
  sender: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  replies: FeedbackReply[];
  /** The GitHub issue it was sent to or added to, when an admin sent it */
  issue: { number: number; url: string } | null;
  /** The upstream issue URL, once the hub has filed the report. */
  upstreamIssueUrl?: string | null;
  /** Accepted by the hub and waiting for an issue URL that an admin can refresh. */
  upstreamPending?: boolean;
}

export interface FeedbackPage {
  items: FeedbackItem[];
  /** Pass as `before` for the next page, or null on the last one */
  next: string | null;
}

export interface FeedbackCount {
  /** How many are new, for the count beside the inbox */
  new: number;
}

export const FeedbackListQuery = z.object({
  kind: FeedbackKind.optional(),
  status: FeedbackStatus.optional(),
  before: z.string().min(1).max(200).optional(),
});
export type FeedbackListQuery = z.infer<typeof FeedbackListQuery>;

export const FeedbackParams = z.object({ feedbackId: FeedbackId });

export const FeedbackStatusUpdate = z.object({ status: FeedbackStatus });
export type FeedbackStatusUpdate = z.infer<typeof FeedbackStatusUpdate>;

export const FeedbackReplyCreate = z.object({
  body: z.string().trim().min(1).max(FEEDBACK_LIMITS.replyLength),
});
export type FeedbackReplyCreate = z.infer<typeof FeedbackReplyCreate>;

/** A repository as GitHub names it: `owner/name` */
export const GithubRepository = z
  .string()
  .trim()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
  .refine((value) => !/\/\.{1,2}$/.test(value));

/** The organization's choice about bug reports on GitHub.  The token itself never comes back. */
export interface FeedbackGithubSettings {
  enabled: boolean;
  repository: string | null;
  /** Whether a token is saved */
  hasToken: boolean;
  /** Whether the person asking may change these, which takes owners and integrations admins */
  canChange: boolean;
}

export const FeedbackGithubUpdate = z.object({
  enabled: z.boolean(),
  repository: GithubRepository.nullable(),
  /** A new token, or null to remove the saved one.  Left out, the saved one stays. */
  token: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/)
    .nullable()
    .optional(),
});
export type FeedbackGithubUpdate = z.infer<typeof FeedbackGithubUpdate>;

export const FeedbackIssueRequest = z.object({
  /** Whether the screenshot goes too.  It never does unless an admin ticks it. */
  includeScreenshot: z.boolean().default(false),
});
export type FeedbackIssueRequest = z.infer<typeof FeedbackIssueRequest>;

export interface SimilarIssue {
  number: number;
  title: string;
  url: string;
}

/** Exactly what a bug report sends, and the open issues whose titles come close. */
export interface FeedbackIssuePreview {
  repository: string;
  title: string;
  /** The issue's or comment's text, word for word */
  body: string;
  /**
   * Where the screenshot will be added in the repository, when it goes too.  The issue links to
   * it at the end of the text.
   */
  screenshot: { path: string; bytes: number } | null;
  /** Open issues with a close title, closest first, to add a comment to instead */
  similar: SimilarIssue[];
}

export const FeedbackIssueSend = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), includeScreenshot: z.boolean() }),
  z.object({
    mode: z.literal('comment'),
    issueNumber: z.number().int().positive().max(2_147_483_647),
    includeScreenshot: z.boolean(),
  }),
]);
export type FeedbackIssueSend = z.infer<typeof FeedbackIssueSend>;
