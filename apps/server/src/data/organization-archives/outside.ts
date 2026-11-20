import { flattenAutomationSteps } from '@riosoma/contracts';
import {
  AutomationConfig,
  requiredSecrets,
  SourceConnection,
  type AutomationStep,
  type OrganizationDestination,
  type OrganizationOutsideItem,
} from '@riosoma/contracts';
import type { Row } from './catalog.js';

/** A catalog row as an archive holds it: the entry it came from, and where credentials were taken out */
export interface CatalogRow {
  catalog: string;
  entry: string;
  row: Row;
  omitted: string[][];
}

/** Whether the import put back the credential taken out at this place */
export type Restored = (item: CatalogRow, path: string[]) => boolean;

/** Something that reaches outside the organization, with the rows it came from */
export interface OutsideFinding extends OrganizationOutsideItem {
  catalog: string;
  source: CatalogRow;
  /** Automations only: the steps whose credentials are still missing */
  stepsNeedingSecrets: string[];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

/** A source's server, or the address it reads from, without any credential in it */
export function sourceDestinations(row: Row): OrganizationDestination[] {
  const connection = (row.connection ?? {}) as Row;
  if (row.kind === 'webhook') return [{ kind: 'incoming', value: '' }];
  for (const key of [
    'host',
    'url',
    'baseUrl',
    'endpoint',
    'uri',
    'account',
    'workspace',
    'project',
    'environmentUrl',
  ])
    if (text(connection[key])) return [{ kind: 'host', value: hostOf(text(connection[key])) }];
  return [{ kind: 'host', value: text(row.kind) }];
}

function stepDestinations(step: AutomationStep): OrganizationDestination[] {
  switch (step.kind) {
    case 'slack':
    case 'teams':
    case 'studioFlow':
    case 'discord':
      return [{ kind: 'service', value: step.kind }];
    case 'createCalendarEvent':
      return [{ kind: 'provider', value: step.provider }];
    case 'askAi':
      return [{ kind: 'service', value: 'ai' }];
    case 'sms':
      return [{ kind: 'phone', value: step.to }];
    case 'sendEmail':
      return step.to.map((value) => ({ kind: 'email' as const, value }));
    case 'callWebhook':
      return [{ kind: 'address', value: step.url }];
    case 'script':
      return [{ kind: 'script', value: step.name }];
    default:
      return [];
  }
}

/** Whether an automation talks to anything outside: messages, email, web calls, scripts, or a webhook trigger */
export function automationDestinations(config: AutomationConfig): OrganizationDestination[] {
  const destinations = flattenAutomationSteps(config.steps).flatMap(stepDestinations);
  if (config.trigger.kind === 'webhook') destinations.unshift({ kind: 'incoming', value: '' });
  return destinations.length ? destinations : [{ kind: 'inside', value: '' }];
}

/** The steps a credential was taken out of and not put back */
export function stepsMissingSecrets(
  item: CatalogRow,
  config: AutomationConfig,
  restored: Restored,
): string[] {
  const missing = new Set<string>();
  for (const path of item.omitted) {
    if (restored(item, path)) continue;
    if (path[0] === 'config' && path[1] === 'steps') {
      let value: unknown = config;
      let stepId: string | undefined;
      for (const segment of path.slice(1)) {
        if (!value || typeof value !== 'object') break;
        if ('kind' in value && 'id' in value && typeof value.id === 'string') stepId = value.id;
        value = (value as Record<string, unknown>)[segment];
      }
      if (stepId) missing.add(stepId);
    } else if (path[0] === 'messaging_secrets' && typeof path[1] === 'string') {
      missing.add(path[1].split(':')[0]!);
    }
  }
  return [...missing];
}

function missingAt(item: CatalogRow, restored: Restored, match: (path: string[]) => boolean): boolean {
  return item.omitted.some((path) => match(path) && !restored(item, path));
}

/**
 * Whether a source's connection or a webhook's address came without part of itself, such as a
 * web address with only its scheme and host left, so it must be entered again before it's used.
 */
export function addressMissing(item: CatalogRow, restored: Restored): boolean {
  if (item.catalog === 'sources') return missingAt(item, restored, (path) => path[0] === 'connection');
  if (item.catalog === 'webhooks') return missingAt(item, restored, (path) => path[0] === 'url');
  return false;
}

/**
 * Everything an archive brings in that reaches outside the organization and was on when it was
 * exported.  An import brings each in off, and the owner turns each on from the review list.
 */
export function outsideFindings(catalogs: Map<string, CatalogRow[]>, restored: Restored): OutsideFinding[] {
  const get = (name: string) => catalogs.get(name) ?? [];
  const databases = new Map(get('databases').map(({ row }) => [String(row.id), text(row.name)]));
  const views = new Map(get('views').map(({ row }) => [String(row.id), row]));
  const tables = new Map(get('tables').map(({ row }) => [String(row.id), row]));
  const databaseOfView = (viewId: unknown) => {
    const view = views.get(String(viewId));
    const table = view ? tables.get(String(view.table_id)) : undefined;
    return table ? (databases.get(String(table.database_id)) ?? null) : null;
  };
  const findings: OutsideFinding[] = [];
  const add = (
    catalog: string,
    source: CatalogRow,
    item: Omit<OutsideFinding, 'catalog' | 'source' | 'stepsNeedingSecrets'>,
    steps: string[] = [],
  ) => findings.push({ ...item, catalog, source, stepsNeedingSecrets: steps });

  for (const [catalog, kind] of [
    ['knowledge_libraries', 'knowledgeLibrary'],
    ['knowledge_documents', 'knowledgeDocument'],
  ] as const)
    for (const source of get(catalog))
      add(catalog, source, {
        kind,
        name: text(source.row.name),
        databaseName: null,
        destinations: [{ kind: 'inside', value: '' }],
        needsSecret: false,
      });
  for (const source of get('sources')) {
    const connection = SourceConnection.safeParse(source.row.connection);
    const needed = connection.success ? requiredSecrets(connection.data).length > 0 : true;
    add('sources', source, {
      kind: 'source',
      name: text(source.row.name),
      databaseName: null,
      destinations: sourceDestinations(source.row),
      needsSecret:
        (needed && missingAt(source, restored, (path) => path[0] === 'sealed_secrets')) ||
        addressMissing(source, restored),
    });
  }
  for (const webhook of get('webhooks')) {
    if (webhook.row.enabled !== true) continue;
    add('webhooks', webhook, {
      kind: 'webhook',
      name: text(webhook.row.url),
      databaseName: databases.get(String(webhook.row.database_id)) ?? null,
      destinations: [{ kind: 'address', value: text(webhook.row.url) }],
      needsSecret:
        missingAt(webhook, restored, (path) => path[0] === 'secret') || addressMissing(webhook, restored),
    });
  }
  for (const automation of get('automations')) {
    if (automation.row.enabled !== true || automation.row.trashed_at) continue;
    const config = AutomationConfig.safeParse(automation.row.config);
    if (!config.success) continue;
    const steps = stepsMissingSecrets(automation, config.data, restored);
    add(
      'automations',
      automation,
      {
        kind: 'automation',
        name: text(automation.row.name),
        databaseName: databases.get(String(automation.row.database_id)) ?? null,
        destinations: automationDestinations(config.data),
        needsSecret: steps.length > 0,
      },
      steps,
    );
  }
  for (const [catalog, kind] of [
    ['shared_views', 'publicLink'],
    ['public_forms', 'publicForm'],
  ] as const)
    for (const link of get(catalog)) {
      if (link.row.stopped_at) continue;
      const view = views.get(String(link.row.view_id));
      add(catalog, link, {
        kind,
        name: text(view?.name),
        databaseName: databaseOfView(link.row.view_id),
        destinations: [{ kind: 'public', value: '' }],
        needsSecret: missingAt(link, restored, (path) => path[0] === 'password_hash'),
      });
    }
  for (const org of get('orgs')) {
    if (org.row.calendar_feeds === true)
      add('orgs', org, {
        kind: 'calendarFeeds',
        name: '',
        databaseName: null,
        destinations: [{ kind: 'calendarApps', value: '' }],
        needsSecret: false,
      });
    if (org.row.feedback_github_enabled === true)
      add('orgs', org, {
        kind: 'feedback',
        name: text(org.row.feedback_github_repository),
        databaseName: null,
        destinations: [{ kind: 'repository', value: text(org.row.feedback_github_repository) }],
        needsSecret: missingAt(org, restored, (path) => path[0] === 'feedback_github_token'),
      });
  }
  for (const page of get('booking_pages'))
    add('booking_pages', page, {
      kind: 'bookingPage',
      name: text((page.row.settings as Row | undefined)?.title),
      databaseName: databases.get(String(page.row.database_id)) ?? null,
      destinations: [{ kind: 'public', value: '' }],
      needsSecret: false,
    });
  for (const client of get('oauth_clients'))
    add('oauth_clients', client, {
      kind: 'oauthClient',
      name: text(client.row.name),
      databaseName: null,
      destinations: (Array.isArray(client.row.redirect_uris) ? client.row.redirect_uris : []).map(
        (value) => ({ kind: 'address', value: text(value) }),
      ),
      needsSecret: client.row.secret_hash !== null,
    });
  for (const app of get('oauth_apps')) {
    if (app.row.enabled !== true) continue;
    add('oauth_apps', app, {
      kind: 'oauthApp',
      name: text(app.row.provider),
      databaseName: null,
      destinations: [{ kind: 'provider', value: text(app.row.provider) }],
      needsSecret: missingAt(app, restored, () => true),
    });
  }
  return findings;
}
