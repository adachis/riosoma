import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@riosoma/contracts';
import { refusedPort } from '@riosoma/testkit';
import { startFakeAirtable, type FakeAirtable, type FakeBase } from '../../../test/fake-airtable.js';
import { AirtableClient, RATE_LIMIT_WAIT_MS, RateLimiter, TRIES, type Clock } from './api.js';

const TOKEN = 'test-airtable-token-not-a-secret';

/** A clock that moves only when something waits on it, so nothing here waits for real. */
function virtualClock(): Clock & { waits: number[] } {
  let now = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
}

const record = (index: number) => ({
  id: `rec${String(index).padStart(14, '0')}`,
  fields: { fldName0000000000: `Row ${index}` },
});

function base(records = 250): FakeBase {
  return {
    id: 'appBase0000000000',
    name: 'Base',
    tables: [
      {
        id: 'tblRows0000000000',
        name: 'Rows',
        description: `Shared with ${TOKEN}`,
        primaryFieldId: 'fldName0000000000',
        fields: [{ id: 'fldName0000000000', name: 'Name', type: 'singleLineText' }],
        views: [{ id: 'viwGrid0000000000', name: 'Grid', type: 'grid' }],
        records: Array.from({ length: records }, (_, index) => record(index + 1)),
      },
    ],
  };
}

let fake: FakeAirtable;
let clock: ReturnType<typeof virtualClock>;
let limiters: Map<string, RateLimiter>;

function client(token = TOKEN) {
  return new AirtableClient({
    apiUrl: fake.url,
    token,
    clock,
    limiter: (key) => {
      let limiter = limiters.get(key);
      if (!limiter) limiters.set(key, (limiter = new RateLimiter(clock)));
      return limiter;
    },
  });
}

beforeEach(async () => {
  clock = virtualClock();
  limiters = new Map();
  fake = await startFakeAirtable({
    token: TOKEN,
    bases: [base(), { id: 'appOther000000000', name: 'Other', tables: [] }],
    basesPerPage: 1,
    now: () => clock.now(),
  });
});
afterEach(async () => {
  await fake.close();
});

async function all(generator: AsyncGenerator<unknown[]>) {
  const pages: unknown[][] = [];
  for await (const page of generator) pages.push(page);
  return pages;
}

describe('the Airtable API client', () => {
  it('lists every base the token can see, page by page, sending the token only as a header', async () => {
    expect(await client().bases()).toEqual([
      { id: 'appBase0000000000', name: 'Base', permissionLevel: 'create' },
      { id: 'appOther000000000', name: 'Other', permissionLevel: 'create' },
    ]);
    expect(fake.requests.map((request) => request.path)).toEqual(['/v0/meta/bases', '/v0/meta/bases']);
    expect(fake.requests.every((request) => request.authorized)).toBe(true);
    expect(fake.requests.some((request) => request.query.toString().includes(TOKEN))).toBe(false);
  });

  it('reads records a hundred at a time by field ID, and a view’s records in its order', async () => {
    const pages = await all(client().records('appBase0000000000', 'tblRows0000000000'));
    expect(pages.map((page) => page.length)).toEqual([100, 100, 50]);
    const [first] = fake.requests;
    expect(first!.query.get('returnFieldsByFieldId')).toBe('true');
    expect(first!.query.get('pageSize')).toBe('100');
    fake.bases[0]!.tables[0]!.views[0]!.records = [record(3).id, record(1).id];
    const view = await all(
      client().records('appBase0000000000', 'tblRows0000000000', {
        view: 'viwGrid0000000000',
        fields: ['fldName0000000000'],
      }),
    );
    expect(view.flat().map((row) => (row as { id: string }).id)).toEqual([record(3).id, record(1).id]);
    expect(fake.requests.at(-1)!.query.getAll('fields[]')).toEqual(['fldName0000000000']);
  });

  it('starts at most five requests in any second for one base', async () => {
    fake.bases[0]!.tables[0]!.records = Array.from({ length: 1_200 }, (_, index) => record(index + 1));
    await all(client().records('appBase0000000000', 'tblRows0000000000'));
    const times = fake.requests.map((request) => request.at);
    expect(times).toHaveLength(12);
    for (let index = 5; index < times.length; index++)
      expect(times[index]! - times[index - 5]!).toBeGreaterThanOrEqual(1_000);
  });

  it('waits as long as Airtable asks after a 429, then carries on', async () => {
    fake.throttle('/v0/appBase0000000000', 2);
    const pages = await all(client().records('appBase0000000000', 'tblRows0000000000'));
    expect(pages.flat()).toHaveLength(250);
    const first = fake.requests.filter((request) => !request.query.get('offset'));
    expect(first).toHaveLength(3);
    expect(first[1]!.at - first[0]!.at).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(first[2]!.at - first[1]!.at).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    fake.throttle('/v0/appBase0000000000', 1, 5);
    const before = clock.now();
    await all(client().records('appBase0000000000', 'tblRows0000000000'));
    expect(clock.now() - before).toBeGreaterThanOrEqual(5_000);
  });

  it('gives up after a few tries when Airtable keeps saying to slow down', async () => {
    fake.throttle('/v0/meta/bases', TRIES + 5);
    await expect(client().bases()).rejects.toMatchObject({
      code: 'rate_limited',
      messageKey: 'import.airtable.rateLimited',
    });
    expect(fake.requests).toHaveLength(TRIES);
  });

  it('says what went wrong with the token or the base, in its own words', async () => {
    const wrong = await client('wrong-token')
      .bases()
      .catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(AppError);
    expect(wrong).toMatchObject({
      messageKey: 'import.airtable.tokenInvalid',
      fields: { token: 'import.airtable.tokenInvalid' },
    });
    expect(JSON.stringify((wrong as AppError).toBody())).not.toContain('wrong-token');
    fake.refuseWith(403);
    await expect(client().bases()).rejects.toMatchObject({ messageKey: 'import.airtable.scopes' });
    await expect(client().schema('appBase0000000000')).rejects.toMatchObject({
      messageKey: 'import.airtable.baseUnavailable',
    });
    fake.refuseWith(null);
    await expect(client().schema('appMissing0000000')).rejects.toMatchObject({
      messageKey: 'import.airtable.baseUnavailable',
    });
  });

  it('takes the token out of anything Airtable sends back', async () => {
    const schema = await client().schema('appBase0000000000');
    expect(schema.tables[0]!.description).toBe('Shared with [redacted]');
    expect(fake.requests[0]!.query.getAll('include[]')).toEqual(['visibleFieldIds']);
  });

  it('tries again after network trouble, waiting longer each time', async () => {
    // An address nothing listens on, which stays that way through every wait and try.
    const closed = await refusedPort();
    const unreachable = new AirtableClient({
      apiUrl: `http://127.0.0.1:${closed}`,
      token: TOKEN,
      clock,
      limiter: () => new RateLimiter(clock),
    });
    await expect(unreachable.bases()).rejects.toMatchObject({ messageKey: 'import.airtable.unavailable' });
    expect(clock.waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  });
});
