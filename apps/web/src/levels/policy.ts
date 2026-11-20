import {
  FIELD_TYPES,
  VIEW_TYPES,
  IMPORT_PLATFORMS,
  reaches,
  type AutomationStep,
  type AutomationTrigger,
  type FieldType,
  type Level,
  type ViewType,
} from '@riosoma/contracts';

export type Surface =
  /** The Add view menu */
  | 'viewPicker'
  /** The type menu in the field dialog */
  | 'fieldTypePicker'
  /** The controls above a view */
  | 'viewToolbar'
  /** A field's header menu */
  | 'fieldMenu'
  /** A table's menu in the sidebar */
  | 'tableMenu'
  /** The Add a table menu */
  | 'addTable'
  /** The database's sidebar sections */
  | 'databaseSidebar'
  /** The database settings menu */
  | 'databaseMenu'
  /** The Add a step menu in an automation */
  | 'stepPicker'
  /** The trigger menu in an automation */
  | 'triggerPicker'
  /** An open record's More menu */
  | 'recordMenu'
  /** Personal settings sections */
  | 'settings'
  /** The home screen's buttons */
  | 'home'
  /** A command that only the palette offers, which a level never tidies away */
  | 'palette';

/** An entry as `surface:item`, the way screens name one to the palette */
export type PlaceKey = `${Surface}:${string}`;

type StepKind = AutomationStep['kind'];
type TriggerKind = AutomationTrigger['kind'];

/**
 * What already exists where an entry is offered.  The database screen fills in what its schema
 * holds, and a surface adds what only it knows, such as the person's tokens or a record's
 * signature requests.  Each feature's `kept` reads the part that is its own.
 */
export interface Holdings {
  /** The kinds of view the database has */
  viewTypes?: ReadonlySet<ViewType>;
  /** The kinds of field the database has, with AI fields as `ai` */
  fieldTypes?: ReadonlySet<FieldType | 'ai'>;
  /** Views that paint records with conditional colors */
  coloredViews?: number;
  dashboards?: number;
  interfaces?: number;
  automations?: number;
  /** Whether an import made the database, which leaves its report in the database's settings */
  imported?: boolean;
  /** Tables a data source fills */
  syncedTables?: number;
  scripts?: number;
  /** The kinds of step the database's automations take */
  stepKinds?: ReadonlySet<StepKind>;
  /** The kinds of trigger the database's automations start from */
  triggerKinds?: ReadonlySet<TriggerKind>;
  /** The database's webhooks */
  webhooks?: number;
  /** Fields with permission rules */
  ruledFields?: number;
  /** Tables whose records follow rules */
  ruledTables?: number;
  /** The person's recent SQL queries in the database */
  sqlQueries?: number;
  /** Whether the database's read-only SQL login is on */
  sqlLogin?: boolean;
  /** The person's personal access tokens */
  tokens?: number;
  /** An open record's signature requests */
  signatureRequests?: number;
}

export interface Place {
  surface: Surface;
  /** The entry there: a view type, a field type, a menu item's ID, or a section's */
  item: string;
}

export interface Feature {
  id: string;
  level: Level;
  places: readonly Place[];
  /** Whether someone already has some of the feature, which keeps its entries at every level */
  kept(holdings: Holdings): boolean;
}

/** The views everyone sees.  The others are Standard. */
const SIMPLE_VIEWS: readonly ViewType[] = ['grid', 'kanban', 'gallery', 'calendar', 'form'];

/** The common field types everyone sees.  The others, formulas and lookups among them, are Standard. */
const SIMPLE_FIELDS: readonly FieldType[] = [
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
];

const some = (count: number | undefined) => (count ?? 0) > 0;

export const FEATURES: readonly Feature[] = [
  ...VIEW_TYPES.map((type): Feature => ({
    id: `view.${type}`,
    level: SIMPLE_VIEWS.includes(type) ? 'simple' : 'standard',
    places: [{ surface: 'viewPicker', item: type }],
    kept: ({ viewTypes }) => Boolean(viewTypes?.has(type)),
  })),
  ...FIELD_TYPES.map((type): Feature => ({
    id: `field.${type}`,
    level: SIMPLE_FIELDS.includes(type) ? 'simple' : 'standard',
    places: [{ surface: 'fieldTypePicker', item: type }],
    kept: ({ fieldTypes }) => Boolean(fieldTypes?.has(type)),
  })),
  {
    id: 'field.ai',
    level: 'standard',
    places: [{ surface: 'fieldTypePicker', item: 'ai' }],
    kept: ({ fieldTypes }) => Boolean(fieldTypes?.has('ai')),
  },
  {
    id: 'colors',
    level: 'standard',
    places: [
      {
        surface: 'viewToolbar',
        item: 'colors',
      },
    ],
    kept: ({ coloredViews }) => some(coloredViews),
  },
  {
    id: 'dashboards',
    level: 'standard',
    places: [
      {
        surface: 'databaseSidebar',
        item: 'dashboards',
      },
    ],
    kept: ({ dashboards }) => some(dashboards),
  },
  {
    id: 'interfaces',
    level: 'standard',
    places: [
      {
        surface: 'databaseSidebar',
        item: 'interfaces',
      },
    ],
    kept: ({ interfaces }) => some(interfaces),
  },
  {
    id: 'automations',
    level: 'standard',
    places: [
      {
        surface: 'databaseSidebar',
        item: 'automations',
      },
    ],
    kept: ({ automations }) => some(automations),
  },
  {
    id: 'imports',
    level: 'standard',
    places: [
      {
        surface: 'addTable',
        item: 'import',
      },
      {
        surface: 'tableMenu',
        item: 'importInto',
      },
      {
        surface: 'home',
        item: 'import',
      },
      {
        surface: 'home',
        item: 'importAirtable',
      },
      ...IMPORT_PLATFORMS.map((platform): Place => ({
        surface: 'home',
        item: `import.${platform}`,
      })),
    ],
    kept: ({ imported }) => Boolean(imported),
  },
  {
    id: 'dataSources',
    level: 'standard',
    places: [
      {
        surface: 'addTable',
        item: 'sync',
      },
    ],
    kept: ({ syncedTables }) => some(syncedTables),
  },
  {
    id: 'signatures',
    level: 'standard',
    places: [
      {
        surface: 'recordMenu',
        item: 'signatures',
      },
    ],
    kept: ({ signatureRequests }) => some(signatureRequests),
  },
  {
    id: 'scripts',
    level: 'advanced',
    places: [
      {
        surface: 'databaseSidebar',
        item: 'scripts',
      },
    ],
    kept: ({ scripts }) => some(scripts),
  },
  {
    id: 'codeSteps',
    level: 'advanced',
    places: [{ surface: 'stepPicker', item: 'script' }],
    kept: ({ stepKinds }) => Boolean(stepKinds?.has('script')),
  },
  {
    id: 'sql',
    level: 'advanced',
    places: [
      {
        surface: 'databaseSidebar',
        item: 'sql',
      },
    ],
    kept: ({ sqlQueries, sqlLogin }) => some(sqlQueries) || Boolean(sqlLogin),
  },
  {
    id: 'api',
    level: 'advanced',
    places: [
      {
        surface: 'palette',
        item: 'api',
      },
    ],
    // The API acts through a person's tokens.
    kept: ({ tokens }) => some(tokens),
  },
  {
    id: 'webhooks',
    level: 'advanced',
    places: [
      {
        surface: 'databaseMenu',
        item: 'webhooks',
      },
      { surface: 'stepPicker', item: 'callWebhook' },
      { surface: 'triggerPicker', item: 'webhook' },
    ],
    kept: ({ webhooks, stepKinds, triggerKinds }) =>
      some(webhooks) || Boolean(stepKinds?.has('callWebhook')) || Boolean(triggerKinds?.has('webhook')),
  },
  {
    id: 'mcp',
    level: 'advanced',
    places: [
      {
        surface: 'palette',
        item: 'mcp',
      },
    ],
    // An app connects as the person through one of their tokens.
    kept: ({ tokens }) => some(tokens),
  },
  {
    id: 'permissions',
    level: 'advanced',
    places: [
      {
        surface: 'fieldMenu',
        item: 'permissions',
      },
      {
        surface: 'tableMenu',
        item: 'recordAccess',
      },
    ],
    kept: ({ ruledFields, ruledTables }) => some(ruledFields) || some(ruledTables),
  },
  {
    id: 'developerSettings',
    level: 'advanced',
    places: [
      {
        surface: 'settings',
        item: 'tokens',
      },
    ],
    kept: ({ tokens }) => some(tokens),
  },
];

export type FeatureId = string;

const BY_ID = new Map(FEATURES.map((feature) => [feature.id, feature]));
const BY_PLACE = new Map(
  FEATURES.flatMap((feature) =>
    feature.places.map((place) => [`${place.surface}:${place.item}`, { feature, place }] as const),
  ),
);

export function featureById(id: FeatureId): Feature | undefined {
  return BY_ID.get(id);
}

/** Every registered entry, as screens name them to the palette */
export const PLACE_KEYS = [...BY_PLACE.keys()] as readonly PlaceKey[];

/** A registered entry and the feature it belongs to, or nothing for an entry at every level. */
export function placeAt(key: PlaceKey): { feature: Feature; place: Place } | undefined {
  return BY_PLACE.get(key);
}

/** The feature an entry is, or nothing when the entry shows at every level. */
export function featureAt(surface: Surface, item: string): Feature | undefined {
  return BY_PLACE.get(`${surface}:${item}`)?.feature;
}

/**
 * Whether someone at this level sees an entry: at the feature's level and above, and at every
 * level once any of the holdings has some of the feature.  The palette is never tidied, and an
 * entry the registry doesn't know shows to everyone.
 */
export function offersAt(
  level: Level,
  surface: Surface,
  item: string,
  ...holdings: readonly Holdings[]
): boolean {
  if (surface === 'palette') return true;
  const feature = featureAt(surface, item);
  return !feature || reaches(level, feature.level) || holdings.some((held) => feature.kept(held));
}

/** The level a feature belongs to, or Simple when the registry doesn't know it. */
export function featureLevel(id: FeatureId): Level {
  return featureById(id)?.level ?? 'simple';
}

/**
 * Whether a level falls short of a feature, so a surface knows it has to look for what the
 * person already has before it can decide what to offer.
 */
export function tidiesAt(level: Level, id: FeatureId): boolean {
  return !reaches(level, featureLevel(id));
}
