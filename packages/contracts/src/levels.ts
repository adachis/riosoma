import { z } from 'zod';

/**
 * Experience levels tidy the interface for people who don't need all of it.  Simple shows the
 * everyday views and fields, Standard adds formulas, dashboards, automations, and data sources,
 * and Advanced adds scripts, SQL, the API, and permissions.  A level only decides what menus and
 * pickers offer: it never takes access away, and anything already made keeps working at every
 * level.
 */
import { LEVELS } from './level-values.js';
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;

export * from './level-values.js';

/** `PUT /api/admin/levels`: the organization's default level, and the highest level for guests */
export const OrgLevelsUpdate = z.object({
  defaultLevel: Level,
  guestLevel: Level,
});
export type OrgLevelsUpdate = z.infer<typeof OrgLevelsUpdate>;
