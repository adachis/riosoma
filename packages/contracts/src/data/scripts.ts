import { z } from 'zod';
import { Description, Name, TableId, RecordId, FieldId } from './fields.js';

/**
 * Scripts: JavaScript saved with a database and run by hand from its script panel, in the same
 * WebAssembly sandbox as an automation's script step.  A run acts as the person running it, with
 * their role and their field and record rules, and its writes go through the command bus, so
 * they're audited, broadcast, and undone together as one action.
 *
 * Scripts change through commands (`script.create`, `script.update`, `script.move`,
 * `script.trash`, `script.restore`) that need schema access, like automations.  People who can't
 * change the schema see each script's name and description, never its code.
 *
 * A run is one WebSocket at `GET /api/scripts/:scriptId/run` (session, record editing access,
 * same origin).  The panel sends `start` with the session's CSRF token, the server answers
 * `started`, then streams the run's logs, output, prompts, and writes, and ends with `finished`.
 * A prompt pauses the script until the panel sends an `answer`, and `cancel`, or closing the
 * socket, stops the run.
 */
export const ScriptId = z.string().regex(/^scr[0-9A-Za-z]{14}$/);

export const SCRIPT_LIMITS = {
  /** Bytes of code, the same as an automation's script step */
  sourceBytes: 65_536,
  /** Characters of a prompt's label or a button's text */
  labelLength: 1_000,
  /** Buttons one prompt offers */
  buttons: 20,
  /** Characters of a typed answer */
  answerLength: 10_000,
  /** Columns one table of output shows */
  tableColumns: 100,
  /** Rows one table of output shows */
  tableRows: 5_000,
  /** The script's own time, waits for the person left out, unless the server sets another */
  timeoutMs: 60_000,
  /** The most the server may set the script's own time to */
  maxTimeoutMs: 600_000,
  /** A whole run, waits for the person included */
  runMs: 30 * 60_000,
} as const;

export const ScriptSource = z
  .string()
  .max(SCRIPT_LIMITS.sourceBytes)
  .refine((value) => new TextEncoder().encode(value).length <= SCRIPT_LIMITS.sourceBytes);

export const ScriptMeta = z.object({
  id: ScriptId,
  databaseId: z.string(),
  name: Name,
  description: Description,
  /** The code, for people who can change the schema, and empty for everyone else */
  source: ScriptSource,
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScriptMeta = z.infer<typeof ScriptMeta>;

export const ScriptCreate = z.object({
  id: ScriptId,
  name: Name,
  description: Description.default(''),
  source: ScriptSource.default(''),
});
export type ScriptCreate = z.infer<typeof ScriptCreate>;

export const ScriptButtonContext = z.object({ tableId: TableId, recordId: RecordId, fieldId: FieldId });
export type ScriptButtonContext = z.infer<typeof ScriptButtonContext>;

/** What the panel sends on a run's socket */
export const ScriptClientMessage = z.discriminatedUnion('type', [
  /** The first message, and only once */
  z.object({
    type: z.literal('start'),
    csrf: z.string().min(1).max(200),
    button: ScriptButtonContext.optional(),
  }),
  /**
   * The answer to the prompt the server is waiting on: text for `text`, a button's index for
   * `buttons`, a table ID for `table`, a record ID for `record`, and true or false for `delete`
   */
  z.object({ type: z.literal('answer'), promptId: z.number().int().positive(), value: z.unknown() }),
  /** Stops the run */
  z.object({ type: z.literal('cancel') }),
]);
export type ScriptClientMessage = z.infer<typeof ScriptClientMessage>;

/** What a paused script asks the person */
export type ScriptPrompt =
  | { kind: 'text'; label: string }
  | { kind: 'buttons'; label: string; options: string[] }
  | { kind: 'table'; label: string }
  | { kind: 'record'; label: string; tableId: string }
  /** `records.delete` waits for the person to agree before anything is deleted */
  | { kind: 'delete'; tableId: string; count: number };

/** Something the script showed with `output.text`, `output.markdown`, or `output.table` */
export type ScriptOutput =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; text: string }
  /** Each row has a cell for every column, as text.  A column named '' holds plain values. */
  | { kind: 'table'; columns: string[]; rows: string[][] };

export type ScriptLogLevel = 'log' | 'info' | 'warn' | 'error';

export type ScriptRunState = 'succeeded' | 'failed' | 'canceled';

export interface ScriptRunError {
  messageKey: string;
  detail?: string;
  line?: number;
  column?: number;
}

/** What the server sends on a run's socket */
export type ScriptServerMessage =
  /** `groupId` is the action every write of the run belongs to, which undo takes back at once */
  | { type: 'started'; runId: string; groupId: string; timeoutMs: number; runMs: number }
  | { type: 'log'; level: ScriptLogLevel; text: string }
  | { type: 'output'; output: ScriptOutput }
  | { type: 'prompt'; promptId: number; prompt: ScriptPrompt }
  /** Records the run has created, changed, or deleted so far */
  | { type: 'wrote'; writes: number }
  /** `ms` is the script's own time, waits for the person left out */
  | { type: 'finished'; state: ScriptRunState; writes: number; ms: number; error: ScriptRunError | null }
  /** The run couldn't start */
  | { type: 'refused'; messageKey: string };
