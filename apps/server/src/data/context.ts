import type pg from 'pg';
import { AppError } from '@riosoma/contracts';
import type { AppContext } from '../app.js';

export interface DataSchemas {
  /** System tables: databases, tables, fields, views, grants, changes */
  app: string;
  /** One physical table per Riosoma table */
  data: string;
  audit: string;
}

/** The pool and schema names the data layer works with, or `setup_required` before setup. */
export function dataStore(ctx: AppContext): { pool: pg.Pool; schemas: DataSchemas } {
  if (!ctx.pool || !ctx.config.database) throw new AppError('setup_required', 'setup.database.required');
  return { pool: ctx.pool, schemas: ctx.config.database.schemas };
}
