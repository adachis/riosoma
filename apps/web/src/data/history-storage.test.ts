import { afterEach, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import { readHistoryStorage, writeHistoryStorage } from './history-storage';
import type { StoredHistory } from './history-storage';
import type { HistoryEntry } from './history';

const entry = (): HistoryEntry => ({
  groupId: newId('action'),
  at: 1234,
  summary: { kind: 'record.update', count: 2, name: '東京 🦋 مرحبا' },
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

it('isolates history by account, database, and tab while retaining both stack orders', () => {
  const history = { undo: [entry(), entry()], redo: [entry()] };
  writeHistoryStorage('person', 'database', 'tab', history);
  expect(readHistoryStorage('person', 'database', 'tab')).toEqual(history);
  for (const scope of [
    ['other', 'database', 'tab'],
    ['person', 'other', 'tab'],
    ['person', 'database', 'other'],
  ])
    expect(readHistoryStorage(scope[0]!, scope[1]!, scope[2]!)).toEqual({ undo: [], redo: [] });
  writeHistoryStorage('person', 'database', 'tab', { undo: [], redo: [] });
  expect(sessionStorage.length).toBe(0);
});

it('discards invalid and duplicate entries and caps the total retained history', () => {
  const valid = entry();
  const history = { undo: [valid], redo: [] };
  writeHistoryStorage('person', 'database', 'tab', history);
  const name = sessionStorage.key(0)!;
  sessionStorage.setItem(
    name,
    JSON.stringify({
      undo: [
        null,
        { ...valid, groupId: 'invalid' },
        { ...valid, summary: { ...valid.summary, count: -1 } },
        valid,
        valid,
      ],
      redo: [valid, ...Array.from({ length: 110 }, entry)],
    }),
  );
  const restored = readHistoryStorage('person', 'database', 'tab');
  expect(restored.undo).toEqual([valid]);
  expect(restored.redo).toHaveLength(99);
  expect(new Set([...restored.undo, ...restored.redo].map((item) => item.groupId)).size).toBe(100);
  sessionStorage.setItem(name, '{');
  expect(readHistoryStorage('person', 'database', 'tab')).toEqual({ undo: [], redo: [] });
});

it('keeps unavailable storage from interrupting edits or history loading', () => {
  vi.stubGlobal('sessionStorage', {
    setItem: () => {
      throw new Error('Full');
    },
    getItem: () => {
      throw new Error('Unavailable');
    },
  });
  expect(() => writeHistoryStorage('person', 'database', 'tab', { undo: [entry()], redo: [] })).not.toThrow();
  expect(readHistoryStorage('person', 'database', 'tab')).toEqual({ undo: [], redo: [] });
});

it('retains confirmed progress and a reversal even when a new edit clears its history stack', () => {
  const action = entry();
  const history: StoredHistory = {
    undo: [],
    redo: [],
    progress: [
      { groupId: action.groupId, applied: 100, deferred: 0, rejected: 0, confirmed: [newId('command')] },
    ],
    reversal: { ...action, commandId: newId('command'), redo: true, retainRedo: false, precedingUndo: [] },
  };
  writeHistoryStorage('person', 'database', 'tab', history);
  expect(readHistoryStorage('person', 'database', 'tab')).toEqual(history);
  const name = sessionStorage.key(0)!;
  sessionStorage.setItem(
    name,
    JSON.stringify({
      ...history,
      progress: [
        { ...history.progress![0], applied: -1 },
        { ...history.progress![0], deferred: 101 },
        { ...history.progress![0], confirmed: ['invalid'] },
      ],
      reversal: { ...history.reversal, commandId: 'invalid' },
    }),
  );
  expect(readHistoryStorage('person', 'database', 'tab')).toEqual({ undo: [], redo: [], progress: [] });
});
