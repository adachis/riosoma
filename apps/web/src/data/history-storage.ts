import { Command, isId } from '@riosoma/contracts';
import type { ActionSummary, HistoryEntry, UndoHistory } from './history';

const kinds = new Set<string>([
  'script.run',
  'database.create',
  ...Command.options.map((command) => command.shape.kind.value),
]);
const key = (userId: string, databaseId: string, clientId: string) =>
  `rio.data.history:${JSON.stringify([userId, databaseId, clientId])}`;

export interface StoredActionProgress {
  groupId: string;
  applied: number;
  deferred: number;
  rejected: number;
  confirmed: string[];
}

export interface StoredReversal extends HistoryEntry {
  commandId: string;
  confirmedMajorCreation?: boolean;
  redo: boolean;
  retainRedo: boolean;
  precedingUndo: string[];
}

export interface StoredHistory extends UndoHistory {
  progress?: StoredActionProgress[];
  reversal?: StoredReversal;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summary(value: unknown): value is ActionSummary {
  return (
    object(value) &&
    typeof value.kind === 'string' &&
    kinds.has(value.kind) &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.name === 'string' &&
    (value.to === undefined || typeof value.to === 'string') &&
    (value.table === undefined || typeof value.table === 'string') &&
    (value.theme === undefined || value.theme === true) &&
    (value.asksFirst === undefined || value.asksFirst === true)
  );
}

/** Each tab keeps its own history, isolated from other accounts and databases on the same browser. */
export function readHistoryStorage(userId: string, databaseId: string, clientId: string): StoredHistory {
  const empty = { undo: [], redo: [] };
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key(userId, databaseId, clientId)) ?? 'null');
    if (!object(stored) || !Array.isArray(stored.undo) || !Array.isArray(stored.redo)) return empty;
    const seen = new Set<string>();
    const entries = (values: unknown[]): HistoryEntry[] =>
      values.slice(0, 100).flatMap((value) => {
        if (
          !object(value) ||
          !isId(value.groupId, 'action') ||
          seen.has(value.groupId) ||
          typeof value.at !== 'number' ||
          !Number.isFinite(value.at) ||
          !summary(value.summary)
        )
          return [];
        seen.add(value.groupId);
        return [{ groupId: value.groupId, at: value.at, summary: value.summary }];
      });
    const undo = entries(stored.undo);
    const history: StoredHistory = { undo, redo: entries(stored.redo).slice(0, 100 - undo.length) };
    const count = (value: unknown): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (Array.isArray(stored.progress))
      history.progress = stored.progress.flatMap((value) =>
        object(value) &&
        isId(value.groupId, 'action') &&
        count(value.applied) &&
        count(value.deferred) &&
        value.deferred <= value.applied &&
        count(value.rejected) &&
        Array.isArray(value.confirmed) &&
        value.confirmed.every((id) => isId(id, 'command'))
          ? [
              {
                groupId: value.groupId,
                applied: value.applied,
                deferred: value.deferred,
                rejected: value.rejected,
                confirmed: [...new Set<string>(value.confirmed)],
              },
            ]
          : [],
      );
    const reversal = stored.reversal;
    if (
      object(reversal) &&
      isId(reversal.groupId, 'action') &&
      isId(reversal.commandId, 'command') &&
      typeof reversal.redo === 'boolean' &&
      typeof reversal.retainRedo === 'boolean' &&
      typeof reversal.at === 'number' &&
      Number.isFinite(reversal.at) &&
      summary(reversal.summary) &&
      Array.isArray(reversal.precedingUndo) &&
      reversal.precedingUndo.every((id) => isId(id, 'action'))
    )
      history.reversal = {
        groupId: reversal.groupId,
        commandId: reversal.commandId,
        ...(reversal.confirmedMajorCreation === true ? { confirmedMajorCreation: true } : {}),
        redo: reversal.redo,
        retainRedo: reversal.retainRedo,
        at: reversal.at,
        summary: reversal.summary,
        precedingUndo: reversal.precedingUndo.slice(0, 100),
      };
    return history;
  } catch {
    // Storage may be unavailable or contain an interrupted write.  Undo still works in this session.
    return empty;
  }
}

export function writeHistoryStorage(
  userId: string,
  databaseId: string,
  clientId: string,
  history: StoredHistory,
): void {
  try {
    const name = key(userId, databaseId, clientId);
    if (!history.undo.length && !history.redo.length && !history.progress?.length && !history.reversal)
      sessionStorage.removeItem(name);
    else sessionStorage.setItem(name, JSON.stringify(history));
  } catch {
    // A full or disabled store must not prevent edits or undo in the current session.
  }
}
