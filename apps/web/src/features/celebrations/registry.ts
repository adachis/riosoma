import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

export type CelebrationSize = 'small' | 'medium' | 'large';

/**
 * What sets a celebration off.  A `crossing` is a state the app reads (a count, a status) that has
 * to be seen on both sides of the line, so data that was already past it when this device first
 * looked never celebrates.  An `event` is something the app watches happen, such as an import
 * finishing.
 */
export interface CelebrationTrigger {
  kind: 'crossing' | 'event';
  /** Where the app sees it */
  source:
    | 'databases'
    | 'viewRows'
    | 'publicForm'
    | 'import'
    | 'syncStatus'
    | 'automationRun'
    | 'kanbanStacks'
    | 'checkbox'
    | 'bookingPage';
}

/** At most once for each key, or at most once for each key in a window of time. */
export type CelebrationRule = { once: true } | { everyMs: number };

export interface CelebrationDefinition {
  id: string;
  size: CelebrationSize;
  trigger: CelebrationTrigger;
  rule: CelebrationRule;
  /**
   * What Rio says, in its own voice.  A large celebration shows one in a toast, and at reduced
   * motion a toast stands in for every size.  One is picked at random so repeats vary.
   */
  lines: readonly MessageDescriptor[];
}

const HOUR = 60 * 60_000;

/** No more than one celebration this often for one person.  Large ones don't wait. */
export const QUIET_INTERVAL_MS = 10 * 60_000;

export const CELEBRATIONS = {
  firstTable: {
    id: 'first-table',
    size: 'large',
    trigger: { kind: 'crossing', source: 'databases' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.firstTable.1', message: 'Your first table.  Every garden starts with one seed.' }),
      msg({ id: 'celebrate.firstTable.2', message: 'A first table.  Let’s see what grows.' }),
    ],
  },
  records100: {
    id: 'records-100',
    size: 'large',
    trigger: { kind: 'crossing', source: 'viewRows' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.records100.1', message: '100 records.  This table is growing roots.' }),
      msg({ id: 'celebrate.records100.2', message: '100 records.  Things are sprouting.' }),
    ],
  },
  records1000: {
    id: 'records-1000',
    size: 'large',
    trigger: { kind: 'crossing', source: 'viewRows' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.records1000.1', message: '1,000 records.  That’s a whole forest.' }),
      msg({ id: 'celebrate.records1000.2', message: '1,000 records.  The roots run deep now.' }),
    ],
  },
  formFirstResponse: {
    id: 'form-first-response',
    size: 'medium',
    trigger: { kind: 'crossing', source: 'publicForm' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.formFirstResponse.1', message: 'Your form’s first answer just landed.' }),
      msg({
        id: 'celebrate.formFirstResponse.2',
        message: 'Someone filled in your form.  The first of many.',
      }),
    ],
  },
  importClean: {
    id: 'import-clean',
    size: 'small',
    trigger: { kind: 'event', source: 'import' },
    rule: { everyMs: 0 },
    lines: [
      msg({ id: 'celebrate.importClean.1', message: 'Every row came in clean.' }),
      msg({ id: 'celebrate.importClean.2', message: 'Imported without a single hiccup.' }),
    ],
  },
  syncFirstSuccess: {
    id: 'sync-first-success',
    size: 'medium',
    trigger: { kind: 'crossing', source: 'syncStatus' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.syncFirstSuccess.1', message: 'First sync done.  The data’s flowing.' }),
      msg({ id: 'celebrate.syncFirstSuccess.2', message: 'Synced.  Fresh from the source.' }),
    ],
  },
  automationFirstRun: {
    id: 'automation-first-run',
    size: 'medium',
    trigger: { kind: 'crossing', source: 'automationRun' },
    rule: { once: true },
    lines: [
      msg({
        id: 'celebrate.automationFirstRun.1',
        message: 'Your automation worked.  One less thing to do by hand.',
      }),
      msg({ id: 'celebrate.automationFirstRun.2', message: 'First run done.  It’s got this now.' }),
    ],
  },
  kanbanDone: {
    id: 'kanban-done',
    size: 'medium',
    trigger: { kind: 'event', source: 'kanbanStacks' },
    rule: { everyMs: HOUR },
    lines: [
      msg({ id: 'celebrate.kanbanDone.1', message: 'Every card made it across.  Time to stretch.' }),
      msg({ id: 'celebrate.kanbanDone.2', message: 'All done.  The board is clear.' }),
    ],
  },
  checklistComplete: {
    id: 'checklist-complete',
    size: 'small',
    trigger: { kind: 'event', source: 'checkbox' },
    rule: { everyMs: HOUR },
    lines: [
      msg({ id: 'celebrate.checklistComplete.1', message: 'All checked.  Nice and tidy.' }),
      msg({ id: 'celebrate.checklistComplete.2', message: 'Every box ticked.' }),
    ],
  },
  bookingFirst: {
    id: 'booking-first',
    size: 'medium',
    trigger: { kind: 'crossing', source: 'bookingPage' },
    rule: { once: true },
    lines: [
      msg({ id: 'celebrate.bookingFirst.1', message: 'Your first booking.  Someone’s coming by.' }),
      msg({ id: 'celebrate.bookingFirst.2', message: 'First booking in.  The calendar’s awake.' }),
    ],
  },
} as const satisfies Record<string, CelebrationDefinition>;

export type CelebrationName = keyof typeof CELEBRATIONS;
