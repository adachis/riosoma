import { randomBytes } from 'node:crypto';
import { payloadHash, sign } from '@riosoma/connectors/s3';
import { AZURE_VERSION, sharedKey, type AzureSettings } from '../data/files/azure-storage.js';
import type { S3Settings } from '../data/files/s3-storage.js';

/**
 * The object stores the storage tests run against, when their variables name them.  Each is set
 * up once per call with a prefix of its own, so test files never see each other's objects.
 *
 * - `RIOSOMA_TEST_S3_URL`, such as `http://<access key>:<secret key>@127.0.0.1:9000/<bucket>`, for
 *   MinIO or any S3-compatible service.  Keys in the address are percent-encoded, and without any
 *   the suite signs in with MinIO's defaults.  Without a bucket it uses `riosoma-test`.  Either
 *   bucket is made when it isn't there.
 * - `RIOSOMA_TEST_AZURITE_URL`, such as `http://devstoreaccount1:<account key>@127.0.0.1:10000/devstoreaccount1`,
 *   for Azurite, with the account key percent-encoded.  The container `riosoma-test` is made when
 *   it isn't there.
 */

export const S3_URL = process.env.RIOSOMA_TEST_S3_URL || undefined;
export const AZURITE_URL = process.env.RIOSOMA_TEST_AZURITE_URL || undefined;

export async function testS3(label: string): Promise<S3Settings> {
  const url = new URL(S3_URL!);
  const settings: S3Settings = {
    endpoint: url.origin,
    region: 'us-east-1',
    bucket: url.pathname.split('/').filter(Boolean)[0] ?? 'riosoma-test',
    prefix: `${label}-${randomBytes(4).toString('hex')}/`,
    accessKeyId: decodeURIComponent(url.username) || 'minioadmin',
    secretAccessKey: decodeURIComponent(url.password) || 'minioadmin',
    pathStyle: true,
  };
  const bucket = new URL(`${url.origin}/${settings.bucket}`);
  const response = await fetch(bucket, {
    method: 'PUT',
    headers: sign('PUT', bucket, 'us-east-1', settings, {}, new Date(), payloadHash()),
  });
  if (response.status !== 200 && response.status !== 409)
    throw new Error(`Couldn't make the test bucket: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
  return settings;
}

export async function testAzure(label: string): Promise<AzureSettings> {
  const url = new URL(AZURITE_URL!);
  const account = url.pathname.split('/').filter(Boolean)[0] ?? decodeURIComponent(url.username);
  const settings: AzureSettings = {
    account,
    container: 'riosoma-test',
    prefix: `${label}-${randomBytes(4).toString('hex')}/`,
    endpoint: `${url.origin}/${account}`,
    accountKey: decodeURIComponent(url.password),
  };
  const response = await azureRequest(settings, 'PUT', `/${settings.container}?restype=container`);
  if (response.status !== 201 && response.status !== 409)
    throw new Error(`Couldn't make the test container: ${response.status} ${await response.text()}`);
  await response.body?.cancel();
  return settings;
}

/** A request to Azurite signed with the account key, for looking at what a test left behind. */
export function azureRequest(settings: AzureSettings, method: string, path: string): Promise<Response> {
  const url = new URL(`${settings.endpoint}${path}`);
  const headers: Record<string, string> = {
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': AZURE_VERSION,
  };
  headers.authorization = sharedKey(method, url, headers, settings.account, settings.accountKey!);
  return fetch(url, { method, headers });
}

/** A request to the S3-compatible service signed with its keys, for looking at what a test left behind. */
export function s3Request(settings: S3Settings, method: string, path: string): Promise<Response> {
  const url = new URL(`${settings.endpoint}/${settings.bucket}${path}`);
  return fetch(url, { method, headers: sign(method, url, settings.region!, settings) });
}
