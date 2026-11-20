import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createAppConnector } from './connector.js';
import { checkLiveApp, SALESFORCE_LIVE_TIMEOUT_MS } from './live-check.test-support.js';
import { salesforce } from './salesforce.js';
import type { FileNetwork } from '../files/network.js';

it('budgets the complete Salesforce live check for seventeen empty objects at its production pace', async () => {
  const standard = salesforce.discovery!.include![0]!.name as readonly string[];
  expect(standard).toHaveLength(17);
  const accessToken = randomBytes(24).toString('hex');
  let gets = 0;
  const network: FileNetwork = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const token = request.method === 'POST';
      if (!token) gets++;
      const path = request.url.pathname;
      const document = token
        ? { access_token: accessToken, expires_in: 3_600 }
        : path.endsWith('/sobjects')
          ? {
              sobjects: standard.map((name) => ({
                name,
                labelPlural: name,
                custom: false,
                queryable: true,
              })),
            }
          : path.endsWith('/describe')
            ? { fields: [{ name: 'Id' }, { name: 'Name' }] }
            : { records: [], done: true };
      return {
        status: 200,
        headers: {},
        url: request.url,
        body: (async function* () {
          yield Buffer.from(JSON.stringify(document));
        })(),
        close() {},
      };
    },
  };
  const source = createAppConnector(
    { network, sockets: { connect: async () => {}, handshake: async () => {} } },
    [{ ...salesforce, target: { ...salesforce.target, requestsPerSecond: 100 } }],
  );
  await checkLiveApp(
    'salesforce',
    { clientSecret: randomBytes(24).toString('hex') },
    { instance: 'https://sample.my.salesforce.com', clientId: 'sample-client' },
    'Id',
    false,
    source,
  );
  const pacedMs = ((gets - 1) * 1_000) / salesforce.target.requestsPerSecond;
  // Allow one request timeout per answer in addition to the production pacing waits.
  expect(SALESFORCE_LIVE_TIMEOUT_MS).toBeGreaterThan(pacedMs + gets * 30_000);
});
