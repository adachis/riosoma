import { z } from 'zod';
import { DatabaseId, TableId, RecordId, FieldId } from './data/fields.js';

/** Token provenance keeps notification wording subject to the recipient’s current access. */
export const AutomationNotificationContent = z.object({
  databaseId: DatabaseId,
  title: z.string().max(10000),
  message: z.string().max(10000),
  link: z.string().max(10000),
  tokens: z.record(
    z.string().max(200),
    z.object({
      text: z.string().max(10000),
      source: z
        .object({ tableId: TableId, recordId: RecordId, fieldId: FieldId.optional(), accessKey: z.string() })
        .optional(),
      databaseWide: z.boolean().optional(),
    }),
  ),
});
export type AutomationNotificationContent = z.infer<typeof AutomationNotificationContent>;
