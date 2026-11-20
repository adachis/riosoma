import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AwsCredentialsError, awsCredentials, METADATA_URL } from './aws-credentials.js';

/**
 * The AWS key chain: the keys in the settings, the standard environment variables, a task's
 * credentials endpoint, and an instance's metadata service, with role keys fetched again before they
 * expire.  Every request here goes to a stand-in on this machine.
 */

interface Recorded {
  method: string;
  target: string;
  headers: Record<string, string>;
}

const ROLE_KEYS = {
  AccessKeyId: 'role-access-key',
  SecretAccessKey: ['role-secret-', 'key'].join(''),
  Token: 'role-session-token',
  Expiration: new Date(Date.now() + 3_600_000).toISOString(),
};

let server: Awaited<ReturnType<typeof start>> | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** A stand-in for the credentials endpoints, answering from a map of paths. */
async function start(
  answers: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const requests: Recorded[] = [];
  const service = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({
      method: request.method ?? '',
      target: request.url ?? '',
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name.toLowerCase(),
          Array.isArray(value) ? value.join(', ') : String(value ?? ''),
        ]),
      ),
    });
    const answer = answers[request.url ?? ''] ?? { status: 404, body: 'not here' };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
    response.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers });
    response.end(text);
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  const address = service.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => service.close(() => resolve())),
  };
}

describe('the AWS key chain', () => {
  it('uses the keys it was given, whatever the environment says', async () => {
    const keys = awsCredentials(
      { accessKeyId: 'configured-key', secretAccessKey: 'configured-secret' },
      { env: { AWS_ACCESS_KEY_ID: 'environment-key', AWS_SECRET_ACCESS_KEY: 'environment-secret' } },
    );
    expect(await keys()).toEqual({ accessKeyId: 'configured-key', secretAccessKey: 'configured-secret' });
  });

  it('uses the standard environment variables, with a role’s session token', async () => {
    const keys = awsCredentials(
      {},
      {
        env: {
          AWS_ACCESS_KEY_ID: 'environment-key',
          AWS_SECRET_ACCESS_KEY: 'environment-secret',
          AWS_SESSION_TOKEN: 'environment-token',
        },
      },
    );
    expect(await keys()).toEqual({
      accessKeyId: 'environment-key',
      secretAccessKey: 'environment-secret',
      sessionToken: 'environment-token',
    });
  });

  it('reads a task’s credentials from its endpoint, with the token it was given', async () => {
    const stand = (server = await start({ '/credentials': { body: ROLE_KEYS } }));
    let moment = Date.now();
    const keys = awsCredentials(
      {},
      {
        env: {
          AWS_CONTAINER_CREDENTIALS_FULL_URI: `${stand.url}/credentials`,
          AWS_CONTAINER_AUTHORIZATION_TOKEN: 'stand-in-container-token',
        },
        now: () => moment,
      },
    );
    const found = await keys();
    expect(found).toEqual({
      accessKeyId: ROLE_KEYS.AccessKeyId,
      secretAccessKey: ROLE_KEYS.SecretAccessKey,
      sessionToken: ROLE_KEYS.Token,
      expiresAt: Date.parse(ROLE_KEYS.Expiration),
    });
    expect(stand.requests[0]).toMatchObject({
      method: 'GET',
      target: '/credentials',
      headers: { authorization: 'stand-in-container-token' },
    });

    // Role keys are asked for again only once they're within five minutes of their end.
    moment += 3_600_000 - 6 * 60 * 1000;
    await keys();
    expect(stand.requests).toHaveLength(1);
    moment += 2 * 60 * 1000;
    await keys();
    expect(stand.requests).toHaveLength(2);
  });

  it('reads a task’s credentials from the relative address its platform sets', async () => {
    const stand = (server = await start({ '/v2/credentials/stand-in': { body: ROLE_KEYS } }));
    const keys = awsCredentials(
      {},
      {
        env: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/stand-in' },
        containerUrl: stand.url,
      },
    );
    expect((await keys()).accessKeyId).toBe(ROLE_KEYS.AccessKeyId);
  });

  it('refuses a plain-HTTP credentials address away from this machine', async () => {
    const keys = awsCredentials(
      {},
      { env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://credentials.example.test/keys' } },
    );
    await expect(keys()).rejects.toThrow(AwsCredentialsError);
    await expect(keys()).rejects.toThrow(/must be https away from this machine/);
  });

  /** A client that answers every request with the role's keys and keeps what it was asked. */
  function keyClient() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify(ROLE_KEYS), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchStub, calls };
  }

  it.each([
    ['EKS Pod Identity', 'http://169.254.170.23/v1/credentials'],
    ['EKS Pod Identity over IPv6', 'http://[fd00:ec2::23]/v1/credentials'],
    ['ECS', 'http://169.254.170.2/v2/credentials/stand-in'],
  ])(
    'reads %s keys from its agent over plain HTTP, with the token file the agent writes',
    async (_name, full) => {
      const dir = mkdtempSync(join(tmpdir(), 'rio-aws-token-'));
      try {
        const file = join(dir, 'token');
        writeFileSync(file, 'stand-in-token-from-file\n');
        const { fetchStub, calls } = keyClient();
        const keys = awsCredentials(
          {},
          {
            env: {
              AWS_CONTAINER_CREDENTIALS_FULL_URI: full,
              AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: file,
              AWS_CONTAINER_AUTHORIZATION_TOKEN: 'stand-in-token-from-environment',
            },
            fetch: fetchStub,
          },
        );
        expect((await keys()).accessKeyId).toBe(ROLE_KEYS.AccessKeyId);
        expect(calls.map((call) => call.url)).toEqual([full]);
        // The file wins over the variable, as it does in the AWS SDKs.
        expect(calls[0]!.headers.authorization).toBe('stand-in-token-from-file');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('reads the relative address before a full one, as the AWS SDKs do', async () => {
    const { fetchStub, calls } = keyClient();
    const keys = awsCredentials(
      {},
      {
        env: {
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/stand-in',
          AWS_CONTAINER_CREDENTIALS_FULL_URI: 'https://credentials.example.test/keys',
        },
        fetch: fetchStub,
      },
    );
    await keys();
    expect(calls.map((call) => call.url)).toEqual(['http://169.254.170.2/v2/credentials/stand-in']);
  });

  it('names the setting when the token file can’t be read, and not its path', async () => {
    const { fetchStub, calls } = keyClient();
    const keys = awsCredentials(
      {},
      {
        env: {
          AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials',
          AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: join(tmpdir(), 'rio-no-such-token-file'),
        },
        fetch: fetchStub,
      },
    );
    await expect(keys()).rejects.toThrow(
      'No AWS credentials to sign with: AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE could not be read',
    );
    expect(calls).toHaveLength(0);
  });

  it('says the metadata service could not be reached on a server away from AWS', async () => {
    const fetchStub = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const keys = awsCredentials({}, { env: {}, fetch: fetchStub });
    await expect(keys()).rejects.toThrow(
      'No AWS credentials to sign with: the instance metadata service could not be reached',
    );
  });

  it('reads an instance’s role through the metadata service, token first', async () => {
    const stand = (server = await start({
      '/latest/api/token': { body: 'stand-in-metadata-token' },
      '/latest/meta-data/iam/security-credentials/': { body: 'instance-role\n' },
      '/latest/meta-data/iam/security-credentials/instance-role': { body: ROLE_KEYS },
    }));
    const keys = awsCredentials({}, { env: {}, metadataUrl: stand.url });
    const found = await keys();
    expect(found.accessKeyId).toBe(ROLE_KEYS.AccessKeyId);
    expect(found.sessionToken).toBe(ROLE_KEYS.Token);
    expect(stand.requests.map((request) => `${request.method} ${request.target}`)).toEqual([
      'PUT /latest/api/token',
      'GET /latest/meta-data/iam/security-credentials/',
      'GET /latest/meta-data/iam/security-credentials/instance-role',
    ]);
    expect(stand.requests[0]!.headers['x-aws-ec2-metadata-token-ttl-seconds']).toBe('21600');
    expect(stand.requests[2]!.headers['x-aws-ec2-metadata-token']).toBe('stand-in-metadata-token');
  });

  it('leaves the metadata service alone when the environment turns it off', async () => {
    const stand = (server = await start({ '/latest/api/token': { body: 'stand-in-metadata-token' } }));
    const keys = awsCredentials({}, { env: { AWS_EC2_METADATA_DISABLED: 'true' }, metadataUrl: stand.url });
    await expect(keys()).rejects.toThrow(AwsCredentialsError);
    expect(stand.requests).toHaveLength(0);
    expect(METADATA_URL).toBe('http://169.254.169.254');
  });

  it('says where to look when nothing offers keys, and names no value', async () => {
    const keys = awsCredentials({}, { env: { AWS_EC2_METADATA_DISABLED: 'true' } });
    const error = await keys().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(error).toBeInstanceOf(AwsCredentialsError);
    expect(error!.message).toBe(
      'No AWS credentials to sign with: set the access key and secret, run as a task or instance with a role, or put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment',
    );
  });

  it('reports an endpoint that refuses, without repeating what it said', async () => {
    const stand = (server = await start({ '/credentials': { status: 403, body: 'Forbidden' } }));
    const keys = awsCredentials(
      {},
      { env: { AWS_CONTAINER_CREDENTIALS_FULL_URI: `${stand.url}/credentials` } },
    );
    await expect(keys()).rejects.toThrow(
      'No AWS credentials to sign with: the container credentials endpoint answered HTTP 403',
    );
  });
});
