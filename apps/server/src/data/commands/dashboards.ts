import type { Command } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { validateDashboardConfig } from '../dashboards/config.js';
import { dashboardMeta, loadDashboard, type StoredDashboard } from '../metadata.js';
import { guardConfig } from '../permissions/config-guard.js';
import {
  missing,
  nextPosition,
  scopeOf,
  setTrashed,
  unusedId,
  type CommandContext,
  type Mutation,
} from './context.js';

type DashboardCommand = Extract<Command, { kind: `dashboard.${string}` }>;

/** A dashboard of the command's database, including trashed ones only when asked. */
export async function dashboard(
  c: CommandContext,
  id: string,
  includeTrashed = false,
): Promise<StoredDashboard> {
  const value = await loadDashboard(c.db, c.schemas, id);
  if (
    !value ||
    value.databaseId !== c.databaseId ||
    value.orgId !== c.actor.orgId ||
    (!includeTrashed && value.trashed)
  )
    return missing();
  return value;
}

/** Dashboards change like views: the same right, the same change log, and the same trash. */
export async function applyDashboards(c: CommandContext, command: DashboardCommand): Promise<Mutation> {
  const { db, schemas } = c;
  switch (command.kind) {
    case 'dashboard.create': {
      const input = command.dashboard;
      guardConfig((await scopeOf(c)).hiddenFieldIds(c.databaseId), null, input.config);
      await unusedId(c, 'dashboard', input.id);
      await validateDashboardConfig(c, input.config, null);
      const position = command.position ?? (await nextPosition(c, 'dashboard', c.databaseId));
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'dashboards')}
        (id, org_id, database_id, name, position, config, created_by)
        VALUES (${input.id}, ${c.actor.orgId}, ${c.databaseId}, ${input.name}, ${position},
          ${JSON.stringify(input.config)}::jsonb, ${c.actor.userId})`,
      );
      return {
        body: { kind: 'dashboard.created', dashboard: dashboardMeta(await dashboard(c, input.id)) },
        prev: {},
      };
    }
    case 'dashboard.update':
    case 'dashboard.move': {
      const before = await dashboard(c, command.dashboardId);
      let update = command.kind === 'dashboard.update' ? command : null;
      if (update?.config)
        update = {
          ...update,
          config: guardConfig((await scopeOf(c)).hiddenFieldIds(c.databaseId), before.config, update.config),
        };
      // Only a new configuration is checked, so renaming never trips over an old tile.
      if (update?.config) await validateDashboardConfig(c, update.config, before.config);
      const name = update?.name ?? before.name;
      const config = update?.config ?? before.config;
      const position = command.kind === 'dashboard.move' ? command.position : before.position;
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'dashboards')} SET name = ${name},
        config = ${JSON.stringify(config)}::jsonb, position = ${position}, updated_at = statement_timestamp()
        WHERE id = ${before.id}`,
      );
      return {
        body: { kind: 'dashboard.updated', dashboard: dashboardMeta(await dashboard(c, before.id)) },
        prev: { dashboard: dashboardMeta(before) },
      };
    }
    case 'dashboard.trash':
    case 'dashboard.restore': {
      const before = await dashboard(c, command.dashboardId, true);
      const trash = command.kind === 'dashboard.trash';
      await setTrashed(c, 'dashboard', before.id, trash);
      return {
        body: trash
          ? { kind: 'dashboard.trashed', dashboardId: before.id }
          : { kind: 'dashboard.restored', dashboard: dashboardMeta(await dashboard(c, before.id)) },
        prev: { trashed: before.trashed },
      };
    }
  }
}
