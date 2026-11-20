import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Level } from '@riosoma/contracts';

/** Each level's name, as settings, onboarding, and help call it */
export const LEVEL_NAMES: Readonly<Record<Level, MessageDescriptor>> = {
  simple: msg({ id: 'levels.simple', message: 'Simple' }),
  standard: msg({ id: 'levels.standard', message: 'Standard' }),
  advanced: msg({ id: 'levels.advanced', message: 'Advanced' }),
};

/** What each level shows, in a line */
export const LEVEL_SUMMARIES: Readonly<Record<Level, MessageDescriptor>> = {
  simple: msg({
    id: 'levels.simple.summary',
    message: 'Grids, boards, galleries, calendars, forms, and the everyday field types.',
  }),
  standard: msg({
    id: 'levels.standard.summary',
    message: 'Adds formulas, lookups, dashboards, interfaces, automations, imports, and data sources.',
  }),
  advanced: msg({
    id: 'levels.advanced.summary',
    message: 'Adds scripts, SQL, the API, webhooks, and field and record permissions.',
  }),
};

/** The note when the palette opens a feature above the person's level */
export const ABOVE_LEVEL_NOTES: Readonly<Record<Exclude<Level, 'simple'>, MessageDescriptor>> = {
  standard: msg({
    id: 'levels.note.standard',
    message: 'This is a Standard feature.  Show Standard features?',
  }),
  advanced: msg({
    id: 'levels.note.advanced',
    message: 'This is an Advanced feature.  Show Advanced features?',
  }),
};

/** The note's button, which answers its question */
export const SHOW_THEM = msg({ id: 'levels.note.show', message: 'Show them' });

/** The suggestion to move up, once someone keeps reaching past their level */
export const SUGGESTIONS: Readonly<Record<Exclude<Level, 'simple'>, MessageDescriptor>> = {
  standard: msg({
    id: 'levels.suggestion.standard',
    message: 'You’ve opened Standard features several times this week.  Show them in your menus too?',
  }),
  advanced: msg({
    id: 'levels.suggestion.advanced',
    message: 'You’ve opened Advanced features several times this week.  Show them in your menus too?',
  }),
};

/** The button that moves someone up to a level */
export const SHOW_LEVEL: Readonly<Record<Exclude<Level, 'simple'>, MessageDescriptor>> = {
  standard: msg({ id: 'levels.show.standard', message: 'Show Standard features' }),
  advanced: msg({ id: 'levels.show.advanced', message: 'Show Advanced features' }),
};
