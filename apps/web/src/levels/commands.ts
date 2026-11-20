import type { I18n, MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  faBolt,
  faChartColumn,
  faCloudArrowDown,
  faCode,
  faFileCsv,
  faFileImport,
  faKey,
  faPalette,
  faPlug,
  faShieldHalved,
  faSignature,
  faTerminal,
  faTowerBroadcast,
} from '@fortawesome/free-solid-svg-icons';
import {
  FIELD_TYPES,
  IMPORT_PLATFORMS,
  VIEW_TYPES,
  type AutomationStep,
  type AutomationTrigger,
  type ImportPlatform,
  type ViewType,
} from '@riosoma/contracts';
import type { IconDefinition } from '@riosoma/icons';
import {
  STEP_ICONS,
  STEP_LABELS,
  TRIGGER_ICONS,
  TRIGGER_LABELS,
} from '../screens/database/automations/labels';
import { AI_FIELD_INFO, fieldTypeInfo } from '../screens/database/fields/fieldTypes';
import { INTERFACE_ICON } from '../screens/database/interfaces/model';
import { VIEW_KINDS } from '../screens/database/views/kinds';

import type { PlaceKey } from './policy';
type StepKind = AutomationStep['kind'];
type TriggerKind = AutomationTrigger['kind'];
export interface PlaceCommand {
  label(i18n: I18n): string;
  icon: IconDefinition;
}

const said = (message: MessageDescriptor, icon: IconDefinition): PlaceCommand => ({
  label: (i18n) => i18n._(message),
  icon,
});

function newView(type: ViewType): PlaceCommand {
  return {
    label: (i18n) => {
      const kind = i18n._(VIEW_KINDS[type].name);
      return i18n._(msg({ id: 'levels.palette.newView', message: `New view: ${kind}` }));
    },
    icon: VIEW_KINDS[type].icon,
  };
}

function newField(info: { icon: IconDefinition; name: MessageDescriptor }): PlaceCommand {
  return {
    label: (i18n) => {
      const kind = i18n._(info.name);
      return i18n._(msg({ id: 'levels.palette.newField', message: `New field: ${kind}` }));
    },
    icon: info.icon,
  };
}

function addStep(kind: StepKind): PlaceCommand {
  return {
    label: (i18n) => {
      const step = i18n._(STEP_LABELS[kind]);
      return i18n._(msg({ id: 'levels.palette.addStep', message: `Add a step: ${step}` }));
    },
    icon: STEP_ICONS[kind],
  };
}

function setTrigger(kind: TriggerKind): PlaceCommand {
  return {
    label: (i18n) => {
      const trigger = i18n._(TRIGGER_LABELS[kind]);
      return i18n._(msg({ id: 'levels.palette.trigger', message: `When: ${trigger}` }));
    },
    icon: TRIGGER_ICONS[kind],
  };
}

/** What the palette calls each tool a base can come from */
const PLATFORM_IMPORTS: Record<ImportPlatform, MessageDescriptor> = {
  nocodb: msg({ id: 'import.platform.palette.nocodb', message: 'Import a base from NocoDB' }),
  baserow: msg({ id: 'import.platform.palette.baserow', message: 'Import a database from Baserow' }),
  grist: msg({ id: 'import.platform.palette.grist', message: 'Import a document from Grist' }),
  teable: msg({ id: 'import.platform.palette.teable', message: 'Import a base from Teable' }),
  seatable: msg({ id: 'import.platform.palette.seatable', message: 'Import a base from SeaTable' }),
  clickup: msg({ id: 'import.platform.palette.clickup', message: 'Import lists from ClickUp' }),
  asana: msg({ id: 'import.platform.palette.asana', message: 'Import projects from Asana' }),
  notion: msg({ id: 'import.platform.palette.notion', message: 'Import a database from Notion' }),
  monday: msg({ id: 'import.platform.palette.monday', message: 'Import a board from monday.com' }),
  smartsheet: msg({ id: 'import.platform.palette.smartsheet', message: 'Import a sheet from Smartsheet' }),
};

const COMMANDS = new Map<PlaceKey, PlaceCommand>([
  ...VIEW_TYPES.map((type) => [`viewPicker:${type}`, newView(type)] as const),
  ...FIELD_TYPES.map((type) => [`fieldTypePicker:${type}`, newField(fieldTypeInfo(type))] as const),
  ['fieldTypePicker:ai', newField(AI_FIELD_INFO)],
  [
    'viewToolbar:colors',
    said(msg({ id: 'levels.palette.colors', message: 'Conditional colors' }), faPalette),
  ],
  [
    'databaseSidebar:dashboards',
    said(msg({ id: 'dashboards.add', message: 'Add a dashboard' }), faChartColumn),
  ],
  [
    'databaseSidebar:interfaces',
    said(msg({ id: 'interfaces.add', message: 'Add an interface' }), INTERFACE_ICON),
  ],
  ['databaseSidebar:automations', said(msg({ id: 'automations.add', message: 'Add an automation' }), faBolt)],
  [
    'addTable:import',
    said(msg({ id: 'import.add.menu', message: 'Import a CSV or Excel file' }), faFileImport),
  ],
  [
    'tableMenu:importInto',
    said(msg({ id: 'import.into.menu', message: 'Import into this table' }), faFileImport),
  ],
  [
    'home:import',
    said(
      msg({ id: 'import.palette.newDatabase', message: 'New database from a CSV or Excel file' }),
      faFileCsv,
    ),
  ],
  [
    'home:importAirtable',
    said(msg({ id: 'import.airtable.palette', message: 'Import a base from Airtable' }), faCloudArrowDown),
  ],
  ...IMPORT_PLATFORMS.map(
    (platform) => [`home:import.${platform}`, said(PLATFORM_IMPORTS[platform], faCloudArrowDown)] as const,
  ),
  [
    'addTable:sync',
    said(msg({ id: 'synced.add.sync', message: 'Sync from a data source' }), faCloudArrowDown),
  ],
  [
    'recordMenu:signatures',
    said(msg({ id: 'signatures.request.title', message: 'Request signatures' }), faSignature),
  ],
  ['databaseSidebar:scripts', said(msg({ id: 'scripts.add', message: 'Add a script' }), faCode)],
  ['stepPicker:script', addStep('script')],
  ['databaseSidebar:sql', said(msg({ id: 'sql.title', message: 'SQL' }), faTerminal)],
  ['palette:api', said(msg({ id: 'palette.cmd.api', message: 'Use the REST API' }), faCode)],
  ['databaseMenu:webhooks', said(msg({ id: 'webhooks.title', message: 'Webhooks' }), faTowerBroadcast)],
  ['stepPicker:callWebhook', addStep('callWebhook')],
  ['triggerPicker:webhook', setTrigger('webhook')],
  ['palette:mcp', said(msg({ id: 'palette.cmd.mcp', message: 'Connect an app through MCP' }), faPlug)],
  [
    'fieldMenu:permissions',
    said(msg({ id: 'levels.palette.fieldPermissions', message: 'Field permissions' }), faShieldHalved),
  ],
  [
    'tableMenu:recordAccess',
    said(msg({ id: 'permissions.records.menu', message: 'Record access' }), faShieldHalved),
  ],
  ['settings:tokens', said(msg({ id: 'settings.nav.tokens', message: 'Personal access tokens' }), faKey)],
]);

export function commandAt(key: PlaceKey): PlaceCommand {
  const command = COMMANDS.get(key);
  if (!command) throw new Error(`Unregistered feature entry: ${key}`);
  return command;
}
