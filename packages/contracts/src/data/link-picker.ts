import { z } from 'zod';
import { type Choice, type FieldMeta, LIMITS, RecordId } from './fields.js';
import type { CellValues } from './values.js';
import { FieldId } from './fields.js';

export const LinkChoicesRequest = z.object({
  query: z.string().max(LIMITS.textLength).default(''),
  offset: z.number().int().min(0).max(10_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  recordId: RecordId.optional(),
  values: z
    .record(FieldId, z.unknown())
    .refine((values) => Object.keys(values).length <= LIMITS.fieldsPerTable)
    .default({}),
});
export type LinkChoicesRequest = z.input<typeof LinkChoicesRequest>;
export interface LinkChoice {
  id: string;
  name: string;
  values: CellValues;
  selectChoices?: Record<string, Choice[]>;
}
export interface LinkChoicesPage {
  records: LinkChoice[];
  fields: FieldMeta[];
  hasMore: boolean;
  canCreate: boolean;
}
