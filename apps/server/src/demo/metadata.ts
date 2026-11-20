import {
  AiSettings,
  FieldMeta,
  GridConfig,
  type AutomationStep,
  type DatabaseSchema,
  type InterfacePage,
  type SiteSettings,
  type SitePageSettings,
  type SessionInfo,
  type IngestDecisionQuestion,
  type IngestDecisionAnswer,
  type IngestDecisionRule,
} from '@riosoma/contracts';

// A leaf accepts only scalars.  Adding an object beneath a display field cannot publish its settings.
type Shape = ((value: unknown) => unknown) | true | { [key: string]: Shape } | readonly [Shape];
const leaves = (keys: string): Record<string, Shape> =>
  Object.fromEntries(keys.split(' ').map((key) => [key, true]));

function project(value: unknown, shape: Shape): unknown {
  if (value === null || value === undefined) return value;
  if (typeof shape === 'function') return shape(value);
  if (shape === true) return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((item) => project(item, shape[0]!)) : [];
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(shape).flatMap(([key, child]) => {
      const shown = project(input[key], child);
      return shown === undefined ? [] : [[key, shown]];
    }),
  );
}

function display<T>(value: T, shape: Shape): T {
  return project(value, shape) as T;
}

const fieldDictionary = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      /^fld[0-9A-Za-z]{14}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof item)
        ? [[key, item]]
        : [],
    ),
  );
};
const theme = leaves('id scheme');
const place = leaves('x y w h');
const attachment = leaves('tableId recordId fieldId attachmentId');
const source = leaves('tableId viewId');
const groupBy = leaves('fieldId dateBucket');
const tileValue = leaves('fn fieldId');
const pivot: Shape = {
  ...leaves('rowTotals columnTotals order'),
  rows: [groupBy],
  column: groupBy,
  values: [tileValue],
};
const tile: Shape = {
  ...leaves('id kind title chart seriesBy sort limit stacked text'),
  place,
  source,
  value: tileValue,
  groupBy,
  pivot,
  fieldIds: [true],
};
const action = leaves('kind tableId viewId pageId url');
const block: Shape = {
  ...leaves(
    'id kind title display pageSize showFieldNames band playback enlarge altFieldId linkFieldId linkLabelFieldId coverFieldId recordsBlockId style text heading alt mediaType caption control tableId fieldId label chart seriesBy sort limit stacked',
  ),
  place,
  source,
  value: tileValue,
  groupBy,
  fieldIds: [true],
  blockIds: [true],
  image: attachment,
  attachment,
  action,
  buttons: [{ label: true, action }],
};
const page: Shape = { id: true, name: true, blocks: [block] };
const timestamps = leaves('createdAt updatedAt');
const navigation: Shape = {
  folders: [leaves('id name section parentId position')],
};
const database: Shape = {
  ...leaves('id name description icon color createdBy role'),
  ...timestamps,
  theme,
  navigation,
};
// Ingest ownership, file policy, field keys, and row meanings stay private in demo reads.
const table: Shape = {
  ...leaves(
    'id databaseId name description primaryFieldId position allowComputedOverrides historyRetentionDays',
  ),
  ...timestamps,
  lineItems: leaves('parentTableId parentFieldId'),
};
const fieldOptions: Shape = {
  ...leaves(
    'required unique uniqueCaseInsensitive precision thousands allowNegative includeTime dateFormat timeFormat timeZone color richText linkedTableId inverseFieldId oneWay prefersSingle limitToViewId linkFieldId targetFieldId resultType fn sortable code format max icon allowMultiple label',
  ),
  choices: [leaves('id name color')],
  displayFieldIds: [true],
  match: leaves('fieldId linkedFieldId'),
  sort: [leaves('fieldId direction')],
  columns: [
    {
      ...leaves('id name description type'),
      options: leaves('precision thousands code color includeTime dateFormat timeFormat'),
    },
  ],
};
// Field marks describe the private reading format and are omitted from the projection.
const field: Shape = {
  ...leaves('id tableId name description type position'),
  ...timestamps,
  options: fieldOptions,
};
const form: Shape = {
  ...leaves('title description submitLabel thankYou allowAnother allowEdits editLinkDays'),
  theme,
  questions: [leaves('fieldId required label help')],
};
const viewConfig: Shape = {
  ...leaves('locked frozenFieldCount rowHeight'),
  columnWidths: fieldDictionary,
  headerColors: fieldDictionary,
  summaries: fieldDictionary,
  pinnedRecordIds: [true],
  fieldOrder: [true],
  hiddenFieldIds: [true],
  columnGroups: [{ ...leaves('id name collapsed color'), fieldIds: [true] }],
  sorts: [leaves('fieldId direction')],
  groups: [leaves('fieldId direction dateGranularity')],
  kanban: {
    ...leaves('stackFieldId hideEmptyStacks coverFieldId coverFit'),
    stackOrder: [true],
    hiddenStacks: [true],
  },
  gallery: leaves('coverFieldId coverFit cardSize'),
  calendar: leaves('startFieldId endFieldId range'),
  timeline: leaves('startFieldId endFieldId groupFieldId labelFieldId zoom'),
  gantt: leaves('startFieldId endFieldId dependencyFieldId progressFieldId labelFieldId labelWidth zoom'),
  list: leaves('groupFieldId parentFieldId visibleFieldCount'),
  map: leaves('locationFieldId colorFieldId'),
  orgChart: leaves('parentFieldId'),
  form,
  pivot,
  colorScales: [{ fieldId: true, stops: [leaves('color value')] }],
  dataBars: [leaves('fieldId color showValue')],
  iconSets: [{ ...leaves('fieldId style'), thresholds: [true], labels: [true] }],
  chart: { ...leaves('chart seriesBy sort limit stacked'), groupBy, value: tileValue },
};

/** Inputs, recipients, addresses, and executable settings are private even inside nested flow paths. */
function stepDisplay(step: AutomationStep): AutomationStep {
  const base = { id: step.id, kind: step.kind, name: step.name };
  switch (step.kind) {
    case 'if':
      return {
        ...base,
        kind: step.kind,
        conditions: null,
        then: step.then.map(stepDisplay),
        otherwise: step.otherwise.map(stepDisplay),
      };
    case 'repeat':
      return { ...base, kind: step.kind, list: '', steps: step.steps.map(stepDisplay) };
    case 'switch':
      return {
        ...base,
        kind: step.kind,
        value: '',
        cases: step.cases.map((item, index) => ({
          id: item.id,
          value: String(index),
          steps: item.steps.map(stepDisplay),
        })),
        otherwise: step.otherwise.map(stepDisplay),
      };
    case 'wait':
      return {
        ...base,
        kind: step.kind,
        mode: 'duration',
        seconds: 0,
        date: '',
        conditions: null,
        timeoutSeconds: 1,
      };
    case 'sendEmail':
      return { ...base, kind: step.kind, to: [''], subject: '', body: '' };
    case 'callWebhook':
      return { ...base, kind: step.kind, url: '', method: 'POST', headers: {}, body: '' };
    case 'script':
      return { ...base, kind: step.kind, script: '', input: {} };
    case 'slack':
    case 'teams':
    case 'discord':
      return { ...base, kind: step.kind, webhookUrl: '', body: '' };
    case 'studioFlow':
      return { ...base, kind: step.kind, webhookUrl: '', body: '', title: '', recipient: '', recordUrl: '' };
    case 'sms':
      return {
        ...base,
        kind: step.kind,
        accountSid: `AC${'0'.repeat(32)}`,
        authToken: '',
        from: `+1${'0'.repeat(10)}`,
        to: '',
        body: '',
      };
    case 'askAi':
      return {
        ...base,
        kind: step.kind,
        prompt: '',
        format: 'text',
        tier: 'everyday',
        classification: 'internal',
      };
    case 'createCalendarEvent':
      return {
        ...base,
        kind: step.kind,
        provider: step.provider,
        calendarId: '',
        title: '',
        description: '',
        start: '',
        end: '',
        timeZone: 'UTC',
      };
    case 'sendNotification':
      return {
        ...base,
        kind: step.kind,
        recipients: { kind: 'people', userIds: [] },
        title: '',
        body: '',
        link: { kind: 'none' },
      };
    case 'findRecords':
      return { ...base, kind: step.kind, tableId: step.tableId, filter: null, limit: 20 };
    case 'createRecord':
      return { ...base, kind: step.kind, tableId: step.tableId, values: {} };
    case 'updateRecord':
      return { ...base, kind: step.kind, tableId: step.tableId, record: step.record, values: {} };
    case 'generateDocument':
      return {
        ...base,
        kind: step.kind,
        tableId: step.tableId,
        record: step.record,
        templateFieldId: step.templateFieldId,
        attachmentFieldId: step.attachmentFieldId,
        format: step.format,
        filename: '',
        values: {},
      };
  }
}

export function demoPages(pages: InterfacePage[]): InterfacePage[] {
  return display(pages, [page]).map((item) => ({
    ...item,
    blocks: item.blocks.map((item) => {
      if (item.kind === 'code') return { ...item, html: '', css: '', javascript: '' };
      return item;
    }),
  }));
}

export function demoSiteSettings(settings: SiteSettings): SiteSettings {
  return display(settings, {
    ...leaves('slug title footer footerFormat motion noIndex'),
    theme,
    favicon: attachment,
    logo: attachment,
    headerButton: { label: true, action },
    socialImage: attachment,
    pages: [leaves('pageId slug title navLabel showInNav description slugFieldId')],
  });
}

export function demoSitePageSettings(settings: SitePageSettings): SitePageSettings {
  return display(settings, leaves('pageId slug title navLabel showInNav description slugFieldId'));
}

/** Admin settings have no public display, including ingest consent, ceilings, and usage features. */
export function demoAiSettings(): AiSettings {
  return AiSettings.parse({
    models: { everyday: null, power: null },
    ingest: false,
    ingestFileLimitUsd: 0,
    ingestBuildLimitUsd: 0,
  });
}

export function demoSession(info: SessionInfo): SessionInfo {
  const asset = leaves('surface key type storage');
  const appearance: Shape = {
    // File safety policy and scanner health are administrative settings, so neither is projected here.
    ...leaves('defaultLocale defaultLevel guestLevel'),
    defaultTheme: leaves('theme scheme mode'),
    allowedThemes: [true],
    logo: { mode: true, main: asset, compact: asset },
  };
  return {
    user: { id: info.user.id, name: info.user.name, locale: info.user.locale, email: '' },
    org: { id: info.org.id, name: info.org.name, settings: display(info.org.settings, appearance) },
    membership: { kind: 'member', adminRoles: [] },
    ...(info.effectiveSettings ? { effectiveSettings: display(info.effectiveSettings, appearance) } : {}),
    preferences: display(
      info.preferences,
      leaves(
        'theme scheme mode locale recordLayout motion sounds celebrations soundLevel narration level levelSuggestion',
      ),
    ),
    csrfToken: info.csrfToken,
  };
}

export function demoField(meta: FieldMeta): FieldMeta {
  return FieldMeta.parse(display(meta, field));
}

export function demoSchema(schema: DatabaseSchema): DatabaseSchema {
  const shownDatabase = display(schema.database, database);
  if (shownDatabase.navigation) {
    const folders = new Set(shownDatabase.navigation.folders.map((item) => item.id));
    const items = new Set(
      [
        ...schema.tables,
        ...(schema.dashboards ?? []),
        ...(schema.automations ?? []),
        ...(schema.interfaces ?? []),
        ...(schema.scripts ?? []),
      ].map((item) => item.id),
    );
    shownDatabase.navigation.parents = Object.fromEntries(
      Object.entries(schema.database.navigation?.parents ?? {}).filter(
        ([id, parent]) => items.has(id) && folders.has(parent),
      ),
    );
  }
  return {
    database: shownDatabase,
    tables: schema.tables.map((item) => display(item, table)),
    fields: schema.fields.map(demoField),
    views: schema.views.map((item) => ({
      ...display(item, { ...leaves('id tableId name type position createdBy'), ...timestamps }),
      config: GridConfig.parse(project(item.config, viewConfig)),
    })),
    dashboards: schema.dashboards?.map((item) =>
      display(item, {
        ...leaves('id databaseId name position'),
        ...timestamps,
        config: { tiles: [tile] },
      }),
    ),
    interfaces: schema.interfaces?.map((item) => ({
      ...display(item, { ...leaves('id databaseId name position'), ...timestamps }),
      pages: demoPages(item.pages),
    })),
    automations: schema.automations?.map((item) => ({
      ...display(item, {
        ...leaves(
          'id databaseId name position enabled createdBy publishedAt version neverPublished lastRunAt',
        ),
        ...timestamps,
      }),
      runAsId: null,
      stoppedBecause: null,
      config: {
        trigger: {
          ...display(item.config.trigger, {
            ...leaves('kind tableId viewId at weekday timeZone'),
            fieldIds: [true],
            every: leaves('unit n'),
          }),
          ...(item.config.trigger.kind === 'recordMatches' ? { filter: null } : {}),
        },
        conditions: null,
        steps: item.config.steps.map(stepDisplay),
        ...(item.config.connections
          ? {
              connections: display(item.config.connections, [
                { id: true, source: leaves('stepId port'), target: leaves('stepId port') },
              ]),
            }
          : {}),
      },
    })),
    scripts: schema.scripts?.map((item) => ({
      ...display(item, { ...leaves('id databaseId name description position'), ...timestamps }),
      source: '',
    })),
    namedFunctions: [],
    collaborators: schema.collaborators.map((item) => ({ id: item.id, name: item.name, email: '' })),
    access: schema.access
      ? display(schema.access, {
          hiddenFields: [leaves('id tableId position')],
          fields: [leaves('fieldId restricted locked editable')],
          limitedTables: [true],
          ruledTables: [true],
        })
      : undefined,
    seq: schema.seq,
  };
}

/** Incoming evidence, business answers, and remembered rules are private in a demo. */
export function demoIngestDecisions(_decisions: {
  questions: IngestDecisionQuestion[];
  answers: IngestDecisionAnswer[];
  rules: IngestDecisionRule[];
}): { questions: IngestDecisionQuestion[]; answers: IngestDecisionAnswer[]; rules: IngestDecisionRule[] } {
  return { questions: [], answers: [], rules: [] };
}

/** Table setup, sender identities, arrival details, examples, and written hashes stay private. */
export function demoIngestTables() {
  return { settings: null, senders: [], formats: [], files: [], examples: [], rowState: [] };
}
