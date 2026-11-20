import { z } from 'zod';

export const IngestFieldKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .max(100)
  .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key));
export const INGEST_PROCESS_FIELDS = {
  needsReview: 'checkbox',
  reviewNote: 'longText',
  readByAi: 'checkbox',
  source: 'text',
  received: 'date',
} as const;
export const IngestField = z
  .strictObject({ key: IngestFieldKey, role: z.enum(['data', 'process']) })
  .refine((mark) => mark.role === 'data' || Object.hasOwn(INGEST_PROCESS_FIELDS, mark.key));
export type IngestField = z.infer<typeof IngestField>;
