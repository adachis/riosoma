import { describe, expect, it } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import { createAppConnector } from './connector.js';
import type { RestConnectorOptions } from '../rest/connector.js';
import type { ConnectorContext } from '../types.js';
import { checkLiveApp, SALESFORCE_LIVE_TIMEOUT_MS } from './live-check.test-support.js';

const hubspotToken = process.env.RIOSOMA_TEST_HUBSPOT_TOKEN;
const pipedriveToken = process.env.RIOSOMA_TEST_PIPEDRIVE_TOKEN;
const calendlyToken = process.env.RIOSOMA_TEST_CALENDLY_TOKEN;
const jotformKey = process.env.RIOSOMA_TEST_JOTFORM_API_KEY;
const linearKey = process.env.RIOSOMA_TEST_LINEAR_API_KEY;
const trelloKey = process.env.RIOSOMA_TEST_TRELLO_KEY;
const trelloToken = process.env.RIOSOMA_TEST_TRELLO_TOKEN;
const intercomToken = process.env.RIOSOMA_TEST_INTERCOM_TOKEN;
const shopifyStore = process.env.RIOSOMA_TEST_SHOPIFY_STORE;
const shopifyToken = process.env.RIOSOMA_TEST_SHOPIFY_ADMIN_TOKEN;
const salesforceInstance = process.env.RIOSOMA_TEST_SALESFORCE_INSTANCE_URL;
const salesforceClientId = process.env.RIOSOMA_TEST_SALESFORCE_CLIENT_ID;
const salesforceClientSecret = process.env.RIOSOMA_TEST_SALESFORCE_CLIENT_SECRET;
const zoomAccountId = process.env.RIOSOMA_TEST_ZOOM_ACCOUNT_ID;
const zoomClientId = process.env.RIOSOMA_TEST_ZOOM_CLIENT_ID;
const zoomClientSecret = process.env.RIOSOMA_TEST_ZOOM_CLIENT_SECRET;
const zohoClientId = process.env.RIOSOMA_TEST_ZOHO_CLIENT_ID;
const zohoClientSecret = process.env.RIOSOMA_TEST_ZOHO_CLIENT_SECRET;
const zohoRefreshToken = process.env.RIOSOMA_TEST_ZOHO_REFRESH_TOKEN;
const gitlabToken = process.env.RIOSOMA_TEST_GITLAB_TOKEN;
const oktaDomain = process.env.RIOSOMA_TEST_OKTA_DOMAIN;
const oktaToken = process.env.RIOSOMA_TEST_OKTA_API_TOKEN;
const freshdeskDomain = process.env.RIOSOMA_TEST_FRESHDESK_DOMAIN;
const freshdeskKey = process.env.RIOSOMA_TEST_FRESHDESK_API_KEY;
const mailchimpKey = process.env.RIOSOMA_TEST_MAILCHIMP_API_KEY;
const codaToken = process.env.RIOSOMA_TEST_CODA_TOKEN;
const typeformToken = process.env.RIOSOMA_TEST_TYPEFORM_TOKEN;

const atlassianSite = process.env.RIOSOMA_TEST_ATLASSIAN_SITE;
const atlassianEmail = process.env.RIOSOMA_TEST_ATLASSIAN_EMAIL;
const atlassianToken = process.env.RIOSOMA_TEST_ATLASSIAN_API_TOKEN;

describe.skipIf(!salesforceInstance || !salesforceClientId || !salesforceClientSecret)(
  'Salesforce live app source',
  () => {
    it(
      'tests, lists, previews, and reads every available object, including empty objects',
      { timeout: SALESFORCE_LIVE_TIMEOUT_MS },
      async () => {
        await checkLiveApp(
          'salesforce',
          { clientSecret: salesforceClientSecret! },
          { instance: salesforceInstance!, clientId: salesforceClientId! },
          'Id',
        );
      },
    );
  },
);

describe.skipIf(!zoomAccountId || !zoomClientId || !zoomClientSecret)('Zoom live app source', () => {
  it(
    'tests, lists, previews, and reads available objects or names their missing scopes',
    { timeout: 300_000 },
    async () => {
      await checkLiveApp(
        'zoom',
        { clientSecret: zoomClientSecret! },
        { accountId: zoomAccountId!, clientId: zoomClientId! },
        'id',
        true,
      );
    },
  );
});

describe.skipIf(!zohoClientId || !zohoClientSecret || !zohoRefreshToken)('Zoho CRM live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 1_200_000 }, async () => {
    await checkLiveApp(
      'zoho-crm',
      { clientSecret: zohoClientSecret!, refreshToken: zohoRefreshToken! },
      { clientId: zohoClientId!, region: 'com' },
    );
  });
});
async function check(
  app: string,
  secrets: ConnectorContext['secrets'],
  settings: Record<string, string> = {},
  keySpec: string | Record<string, string> | ((name: string) => string) = 'id',
) {
  // Load the built server's options only inside an enabled live check, keeping its guard intact.
  const server = (await import(
    new URL('../../../../apps/server/dist/sources/rest.js', import.meta.url).href
  )) as {
    restConnectorOptions(config: {
      production: boolean;
      automationsAllowPrivateHosts: boolean;
    }): RestConnectorOptions;
  };
  const connector = createAppConnector(
    server.restConnectorOptions({ production: true, automationsAllowPrivateHosts: false }),
  );
  const context: ConnectorContext = {
    connection: AppConnection.parse({ kind: 'app', app, settings }),
    secrets,
    timeoutMs: 30_000,
  };
  expect((await connector.test(context)).ok).toBe(true);
  const objects = await connector.listObjects(context);
  expect(objects.length).toBeGreaterThan(0);
  for (const object of objects) {
    expect(typeof object.name).toBe('string');
    expect(object.schema).toBeNull();
    expect(object.type).toBe('endpoint');
    const select = { kind: 'object' as const, object: { schema: object.schema, name: object.name } };
    const preview = await connector.preview(context, select, 3);
    expect(Array.isArray(preview.columns)).toBe(true);
    expect(Array.isArray(preview.rows)).toBe(true);
    expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
    for (const column of preview.columns) expect(typeof column.name).toBe('string');
    const keyColumn =
      typeof keySpec === 'string'
        ? keySpec
        : typeof keySpec === 'function'
          ? keySpec(object.name)
          : (keySpec[object.name] ?? 'id');
    const columns = preview.columns.map((column) => column.name);
    if (!columns.includes(keyColumn)) columns.unshift(keyColumn);
    const keys = new Set<string>();
    for await (const batch of connector.read(context, select, {
      columns,
      types: Object.fromEntries(
        preview.columns.map((column) => [column.name, column.suggested?.type ?? 'text']),
      ),
      keyColumns: [keyColumn],
      batchSize: 100,
    })) {
      expect(Array.isArray(batch)).toBe(true);
      for (const row of batch) {
        expect(typeof row.key).toBe('string');
        expect(Object.keys(row.values).sort()).toEqual([...columns].sort());
        expect(row.values[keyColumn] !== null && row.values[keyColumn] !== undefined).toBe(true);
        expect(keys.has(row.key)).toBe(false);
        keys.add(row.key);
      }
    }
  }
}

describe.skipIf(!hubspotToken)('HubSpot live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('hubspot', { token: hubspotToken! });
  });
});

describe.skipIf(!pipedriveToken)('Pipedrive live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('pipedrive', { apiKey: pipedriveToken! });
  });
});

describe.skipIf(!calendlyToken)('Calendly live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('calendly', { token: calendlyToken! }, {}, 'uri');
  });
});

describe.skipIf(!jotformKey)('Jotform live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('jotform', { apiKey: jotformKey! });
  });
});

describe.skipIf(!linearKey)('Linear live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('linear', { apiKey: linearKey! });
  });
});

describe.skipIf(!trelloKey || !trelloToken)('Trello live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('trello', { apiKey: trelloToken! }, { key: trelloKey! });
  });
});

describe.skipIf(!intercomToken)('Intercom live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('intercom', { token: intercomToken! });
  });
});

describe.skipIf(!shopifyStore || !shopifyToken)('Shopify live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp('shopify', { apiKey: shopifyToken! }, { store: shopifyStore! });
  });
});

describe.skipIf(!gitlabToken)('GitLab live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('gitlab', { token: gitlabToken! });
  });
});

describe.skipIf(!oktaDomain || !oktaToken)('Okta live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check(
      'okta',
      { apiKey: oktaToken! },
      { organization: `https://${oktaDomain!}` },
      { system_log: 'uuid' },
    );
  });
});

describe.skipIf(!freshdeskDomain || !freshdeskKey)('Freshdesk live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('freshdesk', { apiKey: freshdeskKey! }, { helpdesk: `https://${freshdeskDomain!}` });
  });
});

describe.skipIf(!mailchimpKey)('Mailchimp live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('mailchimp', { apiKey: mailchimpKey! });
  });
});

describe.skipIf(!atlassianSite || !atlassianEmail || !atlassianToken)('Jira live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp(
      'jira',
      { password: atlassianToken! },
      { site: atlassianSite!, email: atlassianEmail! },
    );
  });
});

describe.skipIf(!atlassianSite || !atlassianEmail || !atlassianToken)('Confluence live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await checkLiveApp(
      'confluence',
      { password: atlassianToken! },
      { site: atlassianSite!, email: atlassianEmail! },
    );
  });
});

describe.skipIf(!codaToken)('Coda live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('coda', { token: codaToken! });
  });
});

describe.skipIf(!typeformToken)('Typeform live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('typeform', { token: typeformToken! }, {}, (name) =>
      name === 'forms' || name === 'workspaces' ? 'id' : 'response_id',
    );
  });
});

const githubToken = process.env.RIOSOMA_TEST_GITHUB_TOKEN;
describe.skipIf(!githubToken)('GitHub live app source', () => {
  it('tests, lists, previews, and reads every available object', { timeout: 300_000 }, async () => {
    await check('github', { token: githubToken! }, { connectionId: 'direct-live-account' });
  });
});
