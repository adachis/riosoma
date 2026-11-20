import { z } from 'zod';
import { AttachmentId, FieldId } from './data/index.js';

export const SignatureField = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    signer: z.number().int().min(0).max(19),
    kind: z.enum(['signature', 'initials', 'date', 'name', 'text']),
    page: z.number().int().min(0).max(199),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.02).max(1),
    height: z.number().min(0.01).max(1),
  })
  .refine((field) => field.x + field.width <= 1 && field.y + field.height <= 1);
export type SignatureField = z.infer<typeof SignatureField>;

/** Whether two placed fields cover any of the same area on a page.  Touching edges don't count. */
export function fieldsOverlap(
  a: Pick<SignatureField, 'page' | 'x' | 'y' | 'width' | 'height'>,
  b: Pick<SignatureField, 'page' | 'x' | 'y' | 'width' | 'height'>,
): boolean {
  const gap = 1e-9;
  return (
    a.page === b.page &&
    a.x + a.width > b.x + gap &&
    b.x + b.width > a.x + gap &&
    a.y + a.height > b.y + gap &&
    b.y + b.height > a.y + gap
  );
}

/** The first pair of fields that overlap, by index, or null when none do. */
export function overlappingFields(fields: readonly SignatureField[]): [number, number] | null {
  for (let a = 0; a < fields.length; a++)
    for (let b = a + 1; b < fields.length; b++) if (fieldsOverlap(fields[a]!, fields[b]!)) return [a, b];
  return null;
}

/** The most characters a text box answer may hold, so every answer fits its box when stamped. */
export const SIGNATURE_TEXT_LIMIT = 500;

export const SignatureRequestInput = z
  .object({
    attachmentId: AttachmentId,
    signers: z
      .array(z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254) }))
      .min(1)
      .max(20),
    order: z.enum(['parallel', 'sequential']),
    fields: z.array(SignatureField).min(1).max(200),
    message: z.string().trim().max(4000).default(''),
    dueAt: z.iso.datetime().nullable().default(null),
    statusFieldId: FieldId.nullable().default(null),
    statusValue: z.string().max(200).default(''),
    dateFieldId: FieldId.nullable().default(null),
  })
  .superRefine((input, ctx) => {
    if (
      new Set(input.fields.map((field) => field.id)).size !== input.fields.length ||
      input.fields.some((field) => field.signer >= input.signers.length) ||
      input.signers.some(
        (_, index) => !input.fields.some((field) => field.signer === index && field.kind === 'signature'),
      ) ||
      new Set(input.signers.map((signer) => signer.email.toLowerCase())).size !== input.signers.length
    )
      ctx.addIssue({ code: 'custom', message: 'signatures.invalid' });
  });
export type SignatureRequestInput = z.infer<typeof SignatureRequestInput>;

export const SignatureAnswer = z.object({
  // The server counts characters after cleaning and refuses more than SIGNATURE_TEXT_LIMIT.
  text: z.string().trim().max(4000).default(''),
  image: z
    .string()
    .max(400_000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
    .optional(),
});
export type SignatureAnswer = z.infer<typeof SignatureAnswer>;
export const SignatureSubmission = z.object({
  consent: z.literal(true),
  consentText: z.string().min(1).max(2000),
  values: z.record(z.string().max(64), SignatureAnswer),
  /** The signer's IANA time zone, for the date signed.  Anything else falls back to UTC. */
  timeZone: z.string().max(64).optional(),
});
export type SignatureSubmission = z.infer<typeof SignatureSubmission>;

export interface SignatureSigner {
  id: string;
  name: string;
  email: string;
  status: 'pending' | 'signed' | 'declined';
  invitedAt: string | null;
  openedAt: string | null;
  signedAt: string | null;
  lastReminder: string | null;
  automaticReminder: boolean;
  reason: string | null;
  consent: string | null;
  ip: string | null;
  userAgent: string | null;
  /** The validated IANA zone the date signed was stamped in, or null for UTC */
  timeZone: string | null;
  values: Record<string, SignatureAnswer>;
}

export interface SignatureHistory {
  action:
    | 'sent'
    | 'opened'
    | 'signed'
    | 'declined'
    | 'reminded'
    | 'completed'
    | 'canceled'
    | 'failed'
    | 'undelivered';
  signerId: string | null;
  at: string;
  reason: string | null;
}

export interface SignatureRequestSummary {
  id: string;
  name: string;
  status: 'open' | 'completing' | 'completed' | 'declined' | 'canceled' | 'failed' | 'expired';
  expiresAt: string;
  order: SignatureRequestInput['order'];
  canManage: boolean;
  signers: Array<
    Pick<
      SignatureSigner,
      'id' | 'name' | 'email' | 'status' | 'signedAt' | 'reason' | 'lastReminder' | 'invitedAt'
    >
  >;
  history: SignatureHistory[];
  signedAttachmentId: string | null;
  originalHash: string;
  finalHash: string | null;
}

export interface PublicSignatureRequest {
  name: string;
  message: string;
  expiresAt: string;
  signerName: string;
  consent: string;
  fields: SignatureField[];
  /** Where other signers' fields sit, so nothing lands on the pages unseen.  Their answers never go out. */
  otherFields: Array<Pick<SignatureField, 'page' | 'x' | 'y' | 'width' | 'height'> & { signerName: string }>;
  pages: Array<{ width: number; height: number }>;
  signers: Array<{ name: string; signed: boolean }>;
}
