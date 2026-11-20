import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseProfile } from '@riosoma/contracts';
import { passwordSource } from './tokens.js';

const rds = vi.hoisted(() => ({
  options: vi.fn(),
  getAuthToken: vi.fn<() => Promise<string>>(),
}));

// The signer otherwise searches the machine's credential providers before signing a token.
vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: class {
    constructor(options: unknown) {
      rds.options(options);
    }
    getAuthToken = rds.getAuthToken;
  },
}));

const google = vi.hoisted(() => ({
  scopes: [] as unknown[],
  getAccessToken: vi.fn<() => Promise<{ token: string | null }>>(),
  expiry: null as number | null,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: { scopes: unknown }) {
      google.scopes.push(options.scopes);
    }
    async getClient() {
      return { getAccessToken: google.getAccessToken, credentials: { expiry_date: google.expiry } };
    }
  },
}));

const profile = DatabaseProfile.parse({
  host: 'db.example.test',
  port: 5432,
  database: 'riosoma',
  user: 'riosoma-app@project.iam',
  auth: { method: 'gcp-cloudsql-iam', instanceConnectionName: 'project:us-central1:riosoma' },
  tls: { mode: 'verify-full' },
});

afterEach(() => {
  rds.options.mockReset();
  rds.getAuthToken.mockReset();
  google.scopes.length = 0;
  google.getAccessToken.mockReset();
  vi.useRealTimers();
});

describe('RDS IAM sign-in', () => {
  const rdsProfile = DatabaseProfile.parse({
    ...profile,
    auth: { method: 'aws-rds-iam', region: 'us-east-1' },
  });

  it('signs with the profile settings and refreshes the cached token before expiry', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 27, 12) });
    rds.getAuthToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const source = passwordSource(rdsProfile) as () => Promise<string>;
    expect(await Promise.all([source(), source()])).toEqual(['first', 'first']);
    expect(rds.options).toHaveBeenCalledExactlyOnceWith({
      hostname: rdsProfile.host,
      port: rdsProfile.port,
      username: rdsProfile.user,
      region: 'us-east-1',
    });
    expect(rds.getAuthToken).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await source()).toBe('second');
    expect(rds.getAuthToken).toHaveBeenCalledTimes(2);
  });

  it('propagates a stubbed credential failure and retries the next request', async () => {
    rds.getAuthToken.mockRejectedValueOnce(new Error('token unavailable')).mockResolvedValueOnce('retry');
    const source = passwordSource(rdsProfile) as () => Promise<string>;
    await expect(source()).rejects.toThrow('token unavailable');
    expect(await source()).toBe('retry');
  });
});

describe('Cloud SQL IAM sign-in', () => {
  it('asks for a token with the Cloud SQL login scope and reuses it until shortly before it expires', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 27, 12) });
    google.expiry = Date.now() + 60 * 60 * 1000;
    google.getAccessToken
      .mockResolvedValueOnce({ token: 'first' })
      .mockResolvedValueOnce({ token: 'second' });
    const source = passwordSource(profile) as () => Promise<string>;
    expect(await source()).toBe('first');
    expect(await source()).toBe('first');
    expect(google.scopes).toEqual([['https://www.googleapis.com/auth/sqlservice.login']]);

    // Within five minutes of expiry, a fresh token is fetched.
    vi.setSystemTime(Date.now() + 56 * 60 * 1000);
    google.expiry = Date.now() + 60 * 60 * 1000;
    expect(await source()).toBe('second');
    expect(google.getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when Google returns no token', async () => {
    google.getAccessToken.mockResolvedValueOnce({ token: null });
    const source = passwordSource(profile) as () => Promise<string>;
    await expect(source()).rejects.toThrow('Google Cloud returned no access token');
  });
});
