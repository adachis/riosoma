import { faBolt, faChartColumn, faTable, faObjectGroup } from '@fortawesome/free-solid-svg-icons';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { SchemaState } from '../../../data/types';
import type { PaletteItem } from '../../../palette/types';
import { VIEW_DEFINITIONS } from '../views/registry';
import { automationHref, dashboardHref, databaseHref, interfaceHref } from './routes';

/**
 * What an open database offers the palette: every table, every view of every table, and every
 * dashboard, interface, and automation, each with the path that opens it.  A table, dashboard,
 * interface, or automation names its database on the second line and a view names its table and
 * database, since none of their names says where it lives on its own.
 */
export function paletteItems(schema: SchemaState, databaseId: string, i18n: I18n): PaletteItem[] {
  const database = schema.database.name;
  const tables: PaletteItem[] = schema.tables.map((table) => ({
    id: table.id,
    group: 'tables',
    label: table.name,
    secondary: database,
    icon: faTable,
    path: databaseHref(databaseId, table.id),
  }));
  const views: PaletteItem[] = schema.tables.flatMap((table) =>
    (schema.views.get(table.id) ?? []).map((view) => ({
      id: view.id,
      group: 'views',
      label: view.name,
      secondary: i18n._({
        ...msg({ id: 'palette.view.context', message: '{table} · {database}' }),
        values: { table: table.name, database },
      }),
      // The view's own icon, so a card view and a calendar tell themselves apart at a glance.
      icon: VIEW_DEFINITIONS[view.type].icon,
      path: databaseHref(databaseId, table.id, view.id),
    })),
  );
  const dashboards: PaletteItem[] = schema.dashboards.map((dashboard) => ({
    id: dashboard.id,
    group: 'dashboards',
    label: dashboard.name,
    secondary: database,
    icon: faChartColumn,
    path: dashboardHref(databaseId, dashboard.id),
  }));
  const automations: PaletteItem[] = schema.automations.map((automation) => ({
    id: automation.id,
    group: 'automations',
    label: automation.name,
    secondary: database,
    icon: faBolt,
    path: automationHref(databaseId, automation.id),
  }));
  const interfaces: PaletteItem[] = schema.interfaces.map((item) => ({
    id: item.id,
    group: 'interfaces',
    label: item.name,
    secondary: database,
    icon: faObjectGroup,
    path: interfaceHref(databaseId, item.id),
  }));
  return [...tables, ...views, ...dashboards, ...interfaces, ...automations];
}
