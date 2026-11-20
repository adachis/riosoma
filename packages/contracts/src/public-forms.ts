import type { AttachmentMeta } from './data/files.js';
import type { PaymentSettings } from './payments.js';
import { z } from 'zod';
import type { CellValue } from './data/values.js';
import type { TextMergeNotice } from './text-merge.js';
import { isTimeZone } from './data/fields.js';
import type { FormShowIf } from './data/views.js';

/**
 * Public forms: a form view shared by link, so anyone can add a record without signing in.
 *
 * Publishing needs the right to change the database's views.  The link holds a random ID of 22
 * characters and works until someone stops sharing it.  A public form asks only its questions of
 * the kinds in `PUBLIC_QUESTION_TYPES`; people and linked-record questions, attachments, and
 * computed fields stay private, since answering them would reveal or store more than a form
 * should.  Submissions run through the command bus as `record.create` with `formViewId`, so the
 * form's own rules (only its questions, required ones answered) apply, attributed to no person.
 *
 * Abuse limits, since the routes are open: each submission needs a ticket from the form's `GET`
 * that is at least 2 seconds and at most 24 hours old, a hidden field that must stay empty, at
 * most 20 submissions an hour from one address to one form (admins can change it), and bodies of
 * at most 64 KB.
 *
 * Routes:
 * - `GET /api/views/:viewId/public-form` (session, read) → `PublicFormLink | null`
 * - `PUT /api/views/:viewId/public-form` (session, change views) → `PublicFormLink` (publishes, or
 *   shares again a form its suspended sharer paused)
 * - `DELETE /api/views/:viewId/public-form` (session, change views) (stops sharing)
 * - `GET /api/public/forms/:formId` (public) → `PublicForm`
 * - `POST /api/public/forms/:formId/submissions` (public, `PublicSubmission`) → `PublicSubmitted`
 *
 * The page itself is `/f/:formId` in the web app, outside the signed-in shell.
 */

export const PublicFormId = z.string().regex(/^[0-9A-Za-z]{22}$/);

export const PUBLIC_QUESTION_TYPES = [
  'lineItems',
  'barcode',
  'time',
  'multiCurrency',
  'text',
  'longText',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'checkbox',
  'date',
  'singleSelect',
  'multipleSelect',
  'dateRange',
  'json',
  'location',
  'signature',
] as const;

export interface PublicFormLink {
  formId: string;
  viewId: string;
  /** Path on this server, like `/f/<formId>` */
  path: string;
  /** Absolute public address when the server has a configured origin */
  url?: string;
  createdAt: string;
  createdBy: string | null;
  submissions: number;
  /** Questions of kinds a public form can't ask, left out of it */
  omittedFieldIds: string[];
  /**
   * The person who shared the form, while they're suspended, which pauses it.  Sharing again
   * keeps the address and makes whoever does it the form's sharer.
   */
  suspendedSharer: { id: string; name: string } | null;
}

/** One question as the public sees it: only what's needed to answer. */
export interface PublicQuestion {
  fieldId: string;
  showIf?: FormShowIf | null;
  type: (typeof PUBLIC_QUESTION_TYPES)[number];
  label: string;
  help: string;
  required: boolean;
  /** The field's options that shape the answer: choices (id, name, color), precision, currency, rating scale, whether a date or date range takes a time, and whether long text takes rich text */
  options: Record<string, unknown>;
}

export interface PublicForm {
  editEmailAvailable?: boolean;
  edit?: {
    session: string;
    expiresAt: string;
    values: PublicValues;
    /** Questions whose answers set what the response was charged, which an edit can't change */
    locked?: string[];
  };
  files?: AttachmentMeta[];
  payment?: PaymentSettings | null;
  formId: string;
  title: string;
  description: string;
  submitLabel: string;
  thankYou: string;
  allowAnother: boolean;
  questions: PublicQuestion[];
  /**
   * The theme the page shows in: the form's own, else its database's forced one, else the allowed
   * organization default.  A missing or blocked pick follows the same default and color scheme.
   */
  theme: { id: string; scheme: string } | null;
  /** Proof the form was fetched before submitting; send it back unchanged */
  ticket: string;
}

export const PublicSubmission = z.strictObject({
  confirmationEmail: z.email().max(254).optional(),
  ticket: z.string().min(1).max(500),
  values: z.record(z.string().max(40), z.unknown()),
  /** Must stay empty; it's hidden from people and filled only by bots */
  website: z.string().max(200).optional(),
  /** The visitor's IANA time zone, which decides the day a date question left blank defaults to */
  timeZone: z.string().max(64).refine(isTimeZone).optional(),
});
export type PublicSubmission = z.infer<typeof PublicSubmission>;

export interface PublicSubmitted {
  textMerges?: TextMergeNotice[];
  editLink?: { path: string; expiresAt: string };
  checkoutUrl?: string;
  thankYou: string;
  allowAnother: boolean;
}

export const PublicFormEditSession = z.strictObject({ token: z.string().min(1).max(2000) });
export const PublicFormEdit = z.strictObject({
  session: z.string().min(1).max(2000),
  values: z.record(z.string().max(40), z.unknown()),
  baseValues: z.record(z.string().max(40), z.string().max(1_000_000).nullable()).optional(),
});

/**
 * Values in a submission use the same forms as the app: choice IDs for selects, numbers,
 * `YYYY-MM-DD` dates, `{ start, end }` date ranges, `{ lat, lng, label }` locations, JSON text,
 * and `{ drawing, name }` signatures, which belong to no person.
 */
export type PublicValues = Record<string, CellValue>;
