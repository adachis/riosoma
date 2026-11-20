import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { publicRow } from './catalog.js';

describe('archive rows', () => {
  it('removes nested step headers from configurations and wrapped audit data', () => {
    const credential = randomBytes(16).toString('hex');
    const config = {
      steps: [
        {
          kind: 'if',
          then: [
            {
              kind: 'repeat',
              steps: [
                {
                  kind: 'switch',
                  cases: [{ steps: [{ kind: 'callWebhook', headers: { 'X-Custom': credential } }] }],
                },
              ],
            },
          ],
          otherwise: [],
        },
      ],
    };
    for (const value of [{ config }, { draft_config: config }, { metadata: { automation: { config } } }]) {
      const { row, omitted } = publicRow('automations', value, randomBytes(32));
      expect(JSON.stringify(row)).not.toContain(credential);
      expect(omitted).toHaveLength(1);
      expect(omitted[0]?.slice(-2)).toEqual(['headers', 'X-Custom']);
    }
  });

  it('takes the credentials out of an automation’s draft steps as it does from its published ones', () => {
    // A stand-in value, made fresh so the test never holds a real-looking credential as a literal.
    const credential = randomBytes(6).toString('hex');
    const step = {
      id: 'call-app',
      kind: 'callWebhook',
      url: `https://api.example.test/in?mode=${credential}`,
      headers: { 'X-Access-Key': credential },
      body: '',
    };
    const config = { trigger: { kind: 'webhook' }, conditions: null, steps: [step] };
    const { row, omitted } = publicRow(
      'automations',
      { id: 'aut00000000000001', config, draft_config: config },
      randomBytes(32),
    );
    for (const column of ['config', 'draft_config'])
      expect((row[column] as typeof config).steps[0]).toMatchObject({
        // Only the address's origin travels: its path and query can carry a credential.
        url: 'https://api.example.test',
        headers: { 'X-Access-Key': '' },
      });
    expect(omitted).toEqual(
      expect.arrayContaining([
        ['draft_config', 'steps', '0', 'url'],
        ['draft_config', 'steps', '0', 'headers', 'X-Access-Key'],
      ]),
    );
    expect(JSON.stringify(row)).not.toContain(credential);
  });
});
