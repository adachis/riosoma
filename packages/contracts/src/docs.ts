import { z } from 'zod';
import { LEVELS, type Level } from './levels.js';

/**
 * Help documentation lives in the app as modules: one short topic each, written in Markdown with
 * front matter, one file per language at `docs/modules/<area>/<id>/<locale>.md`.
 *
 * Bodies can reference the interface instead of repeating it, so docs never drift from the app:
 *   {{ui:<i18n key>}}      the current label for a control, in the reader's language
 *   {{keys:<shortcut id>}} the keyboard shortcut, shown for the reader's platform
 *   {{doc:<module id>}}    a link to another module
 */
export const DOC_LEVELS = LEVELS;
export type DocLevel = Level;

export const DOC_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const DocModuleMeta = z.object({
  /** Stable id used in deep links: /-/docs/<id> */
  id: z.string().regex(DOC_ID),
  title: z.string().min(1).max(80),
  /** One sentence shown in lists and search results */
  summary: z.string().min(1).max(200),
  /** Groups modules in the docs sidebar, such as `getting-started` or `appearance` */
  area: z.string().regex(DOC_ID),
  /** Sort order inside the area */
  order: z.number().int().default(0),
  /** The experience level of what the module explains.  Every module stays readable at every level. */
  level: z.enum(DOC_LEVELS).default('simple'),
  /** Interface anchors this module explains, so help can open beside the control */
  anchors: z.array(z.string()).default([]),
  /** Maps interface anchors to heading IDs with `anchor=section` entries. */
  sections: z.array(z.string().regex(/^[a-zA-Z][\w.]*=[a-z0-9]+(?:-[a-z0-9]+)*$/)).default([]),
  /** A trailing `*` matches the remainder of a route segment. */
  routes: z.array(z.string().startsWith('/')).default([]),
  related: z.array(z.string().regex(DOC_ID)).default([]),
  /** A looping demonstration video, by id */
  video: z.string().optional(),
  /** A "Show me" walkthrough script, by id */
  demo: z.string().optional(),
});
export type DocModuleMeta = z.infer<typeof DocModuleMeta>;

export const DOC_AREAS = [
  'getting-started',
  'rio',
  'databases',
  'appearance',
  'personal',
  'account',
  'administration',
  'data-sources',
] as const;

/**
 * A "Show me" demonstration: a short list of steps played in the real interface, beside its help
 * module at `docs/modules/<area>/<id>/demo.json`.  Each step points at a control by its interface
 * anchor, says one line of narration, and does at most one thing from a fixed set.  Nothing a demo
 * does is saved: it runs in a sandbox that the interface leaves exactly as it found it.
 *
 * - `open` presses a control that opens a menu, list, popover, dialog, or panel
 * - `focus` moves focus to a field
 * - `type` types the text of a message into a field
 * - `choose` presses an item in a menu, list, or popover the demo opened, the anchor itself or the
 *   item named by `item`
 * - `scroll` scrolls the control into view
 * - `wait` holds on the step for `ms` milliseconds after its narration
 */
export const DEMO_ACTIONS = ['open', 'focus', 'type', 'choose', 'scroll', 'wait'] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];

/** Where a demo has to start: anywhere in the app, inside a database, or on one of its tables */
export const DEMO_PLACES = ['anywhere', 'database', 'table'] as const;
export type DemoPlace = (typeof DEMO_PLACES)[number];

const MESSAGE_ID = z.string().regex(/^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/);
const ANCHOR_ID = z.string().regex(/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);

export const DemoStep = z
  .object({
    /** The interface anchor to point at, a `data-anchor` value */
    anchor: ANCHOR_ID,
    /** An item inside the menu or list the anchor opened, by its key, to point at or choose */
    item: z.string().regex(DOC_ID).optional(),
    /** The narration's message ID, so it can be translated */
    say: MESSAGE_ID,
    /**
     * A recorded narration clip, played instead of speech when the file exists, from
     * `/narration/<locale>/<clip>.mp3`
     */
    audio: z
      .string()
      .regex(/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/)
      .optional(),
    do: z.enum(DEMO_ACTIONS).optional(),
    /** For `type`: the message ID of the text to type */
    text: MESSAGE_ID.optional(),
    /** For `wait`: how long to hold, at most ten seconds */
    ms: z.number().int().min(100).max(10_000).optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.do === 'type' && !step.text)
      context.addIssue({ code: 'custom', message: 'A type step needs text', path: ['text'] });
    if (step.do !== 'type' && step.text)
      context.addIssue({ code: 'custom', message: 'Only a type step has text', path: ['text'] });
    if (step.do === 'wait' && !step.ms)
      context.addIssue({ code: 'custom', message: 'A wait step needs ms', path: ['ms'] });
    if (step.do !== 'wait' && step.ms)
      context.addIssue({ code: 'custom', message: 'Only a wait step has ms', path: ['ms'] });
  });
export type DemoStep = z.infer<typeof DemoStep>;

export const DemoScript = z
  .object({
    /** The help module the demo belongs to, which is also the demo's own ID */
    id: z.string().regex(DOC_ID),
    /** Where the person has to be for the demo's first step to be on screen */
    where: z.enum(DEMO_PLACES),
    steps: z.array(DemoStep).min(1).max(20),
  })
  .strict();
export type DemoScript = z.infer<typeof DemoScript>;
