import { setupI18n } from '@lingui/core';
import { FIELD_TYPES, VIEW_TYPES } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { FEATURES, PLACE_KEYS, featureAt, featureLevel, offersAt, type Holdings } from './features';
import { placeWords } from './palette';

describe('the feature registry', () => {
  it('keeps every task and document import in the level policy and palette', () => {
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    for (const [platform, label] of [
      ['clickup', 'Import lists from ClickUp'],
      ['asana', 'Import projects from Asana'],
      ['notion', 'Import a database from Notion'],
      ['monday', 'Import a board from monday.com'],
    ] as const) {
      expect(featureAt('home', `import.${platform}`)?.id).toBe('imports');
      expect(offersAt('simple', 'home', `import.${platform}`)).toBe(false);
      expect(offersAt('simple', 'home', `import.${platform}`, { imported: true })).toBe(true);
      expect(placeWords(i18n, `home:import.${platform}`).label).toBe(label);
    }
  });

  it('registers every feature once, in one place per entry', () => {
    const ids = FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
    const places = FEATURES.flatMap((feature) =>
      feature.places.map((place) => `${place.surface}:${place.item}`),
    );
    expect(new Set(places).size).toBe(places.length);
    // Every kind of view and field is somewhere, so no picker has to decide for itself.
    for (const type of VIEW_TYPES) expect(featureAt('viewPicker', type)).toBeDefined();
    for (const type of FIELD_TYPES) expect(featureAt('fieldTypePicker', type)).toBeDefined();
  });

  it('puts the everyday views and fields at Simple', () => {
    const simpleViews = VIEW_TYPES.filter((type) => featureAt('viewPicker', type)?.level === 'simple');
    expect(simpleViews).toEqual(['grid', 'kanban', 'gallery', 'calendar', 'form']);
    const simpleFields = FIELD_TYPES.filter((type) => featureAt('fieldTypePicker', type)?.level === 'simple');
    expect([...simpleFields].sort()).toEqual(
      [
        'text',
        'longText',
        'number',
        'currency',
        'date',
        'checkbox',
        'singleSelect',
        'multipleSelect',
        'attachment',
        'user',
        'link',
        'email',
        'url',
        'phone',
      ].sort(),
    );
  });

  it('puts formulas, dashboards, automations, imports, data sources, and signature requests at Standard', () => {
    for (const type of ['formula', 'lookup', 'rollup'] as const)
      expect(featureAt('fieldTypePicker', type)?.level).toBe('standard');
    for (const type of ['timeline', 'gantt', 'chart', 'pivot', 'list', 'map'] as const)
      expect(featureAt('viewPicker', type)?.level).toBe('standard');
    for (const id of [
      'colors',
      'dashboards',
      'interfaces',
      'automations',
      'imports',
      'dataSources',
      'signatures',
    ])
      expect(featureLevel(id)).toBe('standard');
  });

  it('puts code, SQL, the API, webhooks, MCP, permissions, and developer settings at Advanced', () => {
    for (const id of [
      'scripts',
      'codeSteps',
      'sql',
      'api',
      'webhooks',
      'mcp',
      'permissions',
      'developerSettings',
    ])
      expect(featureLevel(id)).toBe('advanced');
    expect(featureAt('stepPicker', 'script')?.id).toBe('codeSteps');
    expect(featureAt('stepPicker', 'callWebhook')?.id).toBe('webhooks');
    expect(featureAt('triggerPicker', 'webhook')?.id).toBe('webhooks');
    expect(featureAt('fieldMenu', 'permissions')?.id).toBe('permissions');
    expect(featureAt('tableMenu', 'recordAccess')?.id).toBe('permissions');
    // Every other step, and the step picker's plain ones, show at every level.
    expect(featureAt('stepPicker', 'sendEmail')).toBeUndefined();
  });

  it('offers an entry at its level and above, and anything it doesn’t know to everyone', () => {
    expect(offersAt('simple', 'fieldTypePicker', 'text')).toBe(true);
    expect(offersAt('simple', 'fieldTypePicker', 'formula')).toBe(false);
    expect(offersAt('standard', 'fieldTypePicker', 'formula')).toBe(true);
    expect(offersAt('standard', 'databaseSidebar', 'sql')).toBe(false);
    expect(offersAt('advanced', 'databaseSidebar', 'sql')).toBe(true);
    expect(offersAt('simple', 'stepPicker', 'sendEmail')).toBe(true);
    // The palette is never tidied.
    expect(offersAt('simple', 'palette', 'api')).toBe(true);
  });

  it('keeps an entry at every level once someone has some of its feature', () => {
    expect(offersAt('simple', 'databaseMenu', 'webhooks')).toBe(false);
    expect(offersAt('simple', 'databaseMenu', 'webhooks', { webhooks: 0 })).toBe(false);
    expect(offersAt('simple', 'databaseMenu', 'webhooks', { webhooks: 2 })).toBe(true);
    expect(offersAt('standard', 'settings', 'tokens', {}, { tokens: 1 })).toBe(true);
    // Having one feature's things keeps nothing else.
    expect(offersAt('simple', 'databaseSidebar', 'sql', { webhooks: 2, tokens: 1 })).toBe(false);
  });
});

/** Something of each feature, as a screen would hold it */
const EXAMPLES: Record<string, Holdings> = {
  ...Object.fromEntries(VIEW_TYPES.map((type) => [`view.${type}`, { viewTypes: new Set([type]) }])),
  ...Object.fromEntries(FIELD_TYPES.map((type) => [`field.${type}`, { fieldTypes: new Set([type]) }])),
  'field.ai': { fieldTypes: new Set(['text', 'ai'] as const) },
  colors: { coloredViews: 1 },
  dashboards: { dashboards: 1 },
  interfaces: { interfaces: 1 },
  automations: { automations: 1 },
  imports: { imported: true },
  dataSources: { syncedTables: 1 },
  signatures: { signatureRequests: 1 },
  scripts: { scripts: 1 },
  codeSteps: { stepKinds: new Set(['script'] as const) },
  sql: { sqlQueries: 1 },
  api: { tokens: 1 },
  webhooks: { webhooks: 1 },
  mcp: { tokens: 1 },
  permissions: { ruledFields: 1 },
  developerSettings: { tokens: 1 },
};

describe('what people already have', () => {
  it('has a check for every feature, which finds its own things and nothing in an empty screen', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(FEATURES.map((feature) => feature.id).sort());
    for (const feature of FEATURES) {
      expect(feature.kept({}), feature.id).toBe(false);
      expect(feature.kept(EXAMPLES[feature.id]!), feature.id).toBe(true);
    }
  });

  it('counts every way a database uses a feature', () => {
    const webhooks = FEATURES.find((feature) => feature.id === 'webhooks')!;
    expect(webhooks.kept({ stepKinds: new Set(['callWebhook'] as const) })).toBe(true);
    expect(webhooks.kept({ triggerKinds: new Set(['webhook'] as const) })).toBe(true);
    expect(webhooks.kept({ triggerKinds: new Set(['schedule'] as const) })).toBe(false);
    const sql = FEATURES.find((feature) => feature.id === 'sql')!;
    expect(sql.kept({ sqlLogin: true })).toBe(true);
    const permissions = FEATURES.find((feature) => feature.id === 'permissions')!;
    expect(permissions.kept({ ruledTables: 1 })).toBe(true);
  });
});

describe('the palette’s words', () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

  it('names every registered entry, so no feature can be left out of search', () => {
    const labels = PLACE_KEYS.map((key) => placeWords(i18n, key));
    for (const words of labels) {
      expect(words.label.trim(), words.place).not.toBe('');
      expect(words.icon, words.place).toBeDefined();
    }
    // Two entries of one feature never read alike, so each row says which it is.
    const byLabel = new Map(labels.map((words) => [words.label, words.place]));
    expect(byLabel.size).toBe(labels.length);
    expect(placeWords(i18n, 'triggerPicker:webhook').label).toBe('When: Another app calls a webhook');
    expect(placeWords(i18n, 'tableMenu:importInto').label).toBe('Import into this table');
    expect(placeWords(i18n, 'fieldTypePicker:ai').label).toBe('New field: AI');
    expect(placeWords(i18n, 'recordMenu:signatures')).toMatchObject({
      label: 'Request signatures',
      feature: 'signatures',
    });
  });

  it('refuses an entry the registry doesn’t know', () => {
    expect(() => placeWords(i18n, 'databaseMenu:snapshots')).toThrow('No feature is registered');
  });
});
