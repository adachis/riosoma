import type { FieldType, GridConfig, ViewType } from '@riosoma/contracts';
import type { SchemaState } from '../data/types';
import type { Holdings } from './features';

/** How many conditional colors a view's configuration paints with */
export function colorsIn(config: Pick<GridConfig, 'colorRules' | 'colorScales' | 'dataBars'>): number {
  return config.colorRules.length + config.colorScales.length + config.dataBars.length;
}

/**
 * What a database already holds that experience levels care about, read from its schema, so a
 * level never tidies away an entry for something the database already uses.
 */
export function databaseHoldings(schema: SchemaState, extra: Pick<Holdings, 'imported'> = {}): Holdings {
  const views = [...schema.views.values()].flat();
  const fields = [...schema.fields.values()].flat();
  const automations = schema.automations;
  return {
    ...extra,
    viewTypes: new Set<ViewType>(views.map((view) => view.type)),
    // An AI field keeps AI fields on offer, and the type it writes stays on offer too.
    fieldTypes: new Set<FieldType | 'ai'>(
      fields.flatMap((field) => (field.ai ? [field.type, 'ai'] : [field.type])),
    ),
    coloredViews: views.filter((view) => colorsIn(view.config) > 0).length,
    dashboards: schema.dashboards.length,
    interfaces: schema.interfaces.length,
    automations: automations.length,
    syncedTables: schema.tables.filter((table) => table.source).length,
    scripts: schema.scripts.length,
    stepKinds: new Set(automations.flatMap((automation) => automation.config.steps.map((step) => step.kind))),
    triggerKinds: new Set(automations.map((automation) => automation.config.trigger.kind)),
    ruledFields: schema.access.fields.size + schema.access.hiddenFields.size,
    ruledTables: schema.access.ruledTables.size,
  };
}
