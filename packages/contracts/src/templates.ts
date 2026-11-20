import { z } from 'zod';
import type { ChoiceColor } from './data/fields.js';

/**
 * Starter templates: `GET /api/templates` (session) lists them for the new database dialog, and
 * `POST /api/databases/from-template` creates a database from one.  The dialog groups them by
 * category, in this order.
 */
export const TEMPLATE_CATEGORIES = ['work', 'personal', 'organizations'] as const;
export const TemplateCategory = z.enum(TEMPLATE_CATEGORIES);
export type TemplateCategory = z.infer<typeof TemplateCategory>;

/** What the dialog shows about one template.  Its text is in American English. */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  /** A Font Awesome icon name, as a database's icon is */
  icon: string;
  color: ChoiceColor;
  category: TemplateCategory;
  /** The names of the tables it creates, in order */
  tables: string[];
  /**
   * Set for a template someone in the organization saved from one of its databases, rather than
   * one that comes with Riosoma.  It says who saved it, when, and how many sample records it keeps.
   */
  organization?: { createdBy: string | null; createdAt: string; samples: number };
}
