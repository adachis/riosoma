import type { IngestLiveEvent } from '../ingest-live.js';
import type { PersonIdentity } from '../people.js';
import { z } from 'zod';
import type { Change } from './changes.js';
import {
  type Choice,
  ChoiceId,
  ChoiceColor,
  LIMITS,
  ClientId,
  DatabaseId,
  FieldId,
  RecordId,
  TableId,
  ViewId,
} from './fields.js';

/**
 * Messages on the realtime WebSocket (`/api/realtime`).  The browser sends `hello` first with its
 * session's CSRF token, then subscribes to each open database with the last change it has seen.
 */
export const PresenceLocation = z.object({
  tableId: TableId,
  viewId: ViewId.optional(),
  /** The expanded record, when one is open */
  recordId: RecordId.optional(),
  /** The active cell */
  cell: z.object({ recordId: RecordId, fieldId: FieldId }).optional(),
  editing: z.boolean().optional(),
});
export type PresenceLocation = z.infer<typeof PresenceLocation>;

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: ClientId, csrf: z.string().min(1).max(200) }),
  z.object({ type: z.literal('subscribe'), databaseId: DatabaseId, sinceSeq: z.number().int().min(0) }),
  z.object({ type: z.literal('unsubscribe'), databaseId: DatabaseId }),
  z.object({ type: z.literal('presence'), databaseId: DatabaseId, where: PresenceLocation.nullable() }),
  z.object({
    type: z.literal('watchSelectOptions'),
    databaseId: DatabaseId,
    fieldId: FieldId,
    choiceIds: z.array(ChoiceId).max(LIMITS.choicesPerField),
  }),
  /** Ask for view deltas for the snapshot this client is paging */
  z.object({
    type: z.literal('watch'),
    databaseId: DatabaseId,
    viewId: ViewId,
    snapshot: z.string().max(64).nullable(),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export interface PresencePeer {
  clientId: string;
  userId: string;
  name: string;
  color: z.infer<typeof ChoiceColor>;
  where: PresenceLocation | null;
}

export type ServerMessage =
  | IngestLiveEvent
  | { type: 'organizationChanged' }
  | { type: 'personChanged'; person: PersonIdentity }
  | { type: 'accountDeactivated' }
  | { type: 'remoteToolsChanged' }
  | { type: 'ready' }
  | { type: 'homeChanged' }
  | { type: 'change'; change: Change }
  | {
      type: 'selectOptions';
      databaseId: string;
      fields: Array<{ fieldId: string; choices: Choice[]; truncated: boolean }>;
    }
  /** Everything up to `seq` has been sent for this database */
  | { type: 'caughtUp'; databaseId: string; seq: number }
  /** The client needs a fresh schema and rows, including choices resolved through its current access. */
  | {
      type: 'reload';
      databaseId: string;
      reason: 'tooFarBehind' | 'accessChanged' | 'trashed' | 'selectOptionsChanged' | 'dependenciesChanged';
    }
  | { type: 'presence'; databaseId: string; peers: PresencePeer[] }
  /**
   * Records that entered or left the watched view since the snapshot, or whose sort values changed.
   * The client shows these as prompts rather than moving rows.
   */
  | {
      type: 'viewDelta';
      databaseId: string;
      viewId: string;
      snapshot: string;
      entered: string[];
      left: string[];
      moved: string[];
    }
  | { type: 'error'; messageKey: string }
  | { type: 'pong' };

/** A person's presence color, the same on every screen. */
export function presenceColor(userId: string): z.infer<typeof ChoiceColor> {
  const colors = ChoiceColor.options.filter((c) => c !== 'gray');
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return colors[hash % colors.length]!;
}
