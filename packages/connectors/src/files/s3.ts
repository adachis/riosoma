import { createHash, createHmac } from 'node:crypto';
import type { SourceConnection } from '@riosoma/contracts';

/**
 * Just enough of the S3 protocol to address a bucket's objects and sign requests for them with
 * Signature Version 4, which every S3-compatible service accepts: AWS S3, Cloudflare R2, Backblaze
 * B2, Google Cloud Storage's interoperability keys, and MinIO.  File sources list and read buckets
 * with it, through their guarded network, and the server's attachment storage writes, reads, and
 * copies objects with it.
 *
 * Signature Version 4 itself signs for any AWS service, not only S3, so the signer here takes the
 * service as a parameter and other AWS callers, such as the server's Amazon SES mail transport,
 * use the same code rather than a second copy of it.
 */

type BucketSettings = Extract<SourceConnection, { kind: 'bucket' }>;

/** Where a bucket is: all a file source's settings or the server's file storage need to address it. */
export type BucketPlace = Pick<BucketSettings, 'endpoint' | 'region' | 'bucket' | 'pathStyle'>;

export interface BucketTarget {
  /** The service's address with no bucket in it */
  endpoint: URL;
  region: string;
  bucket: string;
  pathStyle: boolean;
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** A role's session token, which rides along as `x-amz-security-token` when there is one */
  sessionToken?: string;
}

/** A request body's SHA-256 in hex, which Signature Version 4 signs along with the request. */
export function payloadHash(body: Buffer | string = ''): string {
  return createHash('sha256').update(body).digest('hex');
}

const EMPTY_HASH = payloadHash();

/**
 * The region requests are signed for.  AWS needs the bucket's own, and the others either take `auto`
 * or name their region in the endpoint's host, so a blank one is read from there.
 */
export function regionOf(settings: BucketPlace): string {
  if (settings.region) return settings.region;
  if (!settings.endpoint) return 'us-east-1';
  const host = new URL(settings.endpoint).hostname.toLowerCase();
  const named = /^s3[.-]([a-z0-9-]+)\.(?:amazonaws\.com|backblazeb2\.com)$/.exec(host);
  if (named) return named[1]!;
  if (host.endsWith('.r2.cloudflarestorage.com') || host === 'storage.googleapis.com') return 'auto';
  return 'us-east-1';
}

export function bucketTarget(settings: BucketPlace): BucketTarget {
  const region = regionOf(settings);
  const endpoint = new URL(settings.endpoint ?? `https://s3.${region}.amazonaws.com`);
  endpoint.pathname = '/';
  return { endpoint, region, bucket: settings.bucket, pathStyle: settings.pathStyle };
}

/** Percent-encoding as Signature Version 4 wants it: everything but unreserved characters. */
export function strictEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function origin(target: BucketTarget): string {
  const { protocol, host } = target.endpoint;
  return target.pathStyle ? `${protocol}//${host}` : `${protocol}//${target.bucket}.${host}`;
}

function bucketPath(target: BucketTarget): string {
  return target.pathStyle ? `/${strictEncode(target.bucket)}` : '';
}

/** The host a test checks: the endpoint's, or the bucket's own under it. */
export function bucketHostUrl(target: BucketTarget): URL {
  return new URL(`${origin(target)}/`);
}

/** An object's address.  Each part of the key is encoded on its own, so `/` keeps its meaning. */
export function objectUrl(target: BucketTarget, key: string): URL {
  const path = key.split('/').map(strictEncode).join('/');
  return new URL(`${origin(target)}${bucketPath(target)}/${path}`);
}

/** A page of the bucket's listing under a prefix. */
export function listUrl(target: BucketTarget, prefix: string, maxKeys: number, token?: string): URL {
  const query: Array<[string, string]> = [
    ['list-type', '2'],
    ['max-keys', String(maxKeys)],
    ['prefix', prefix],
  ];
  if (token) query.push(['continuation-token', token]);
  const search = query.map(([name, value]) => `${strictEncode(name)}=${strictEncode(value)}`).join('&');
  return new URL(`${origin(target)}${bucketPath(target)}/?${search}`);
}

function hmac(key: Buffer | string, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}

function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The request as Signature Version 4 reads it, and the scope and key that sign it. */
function signature(
  method: string,
  url: URL,
  region: string,
  service: string,
  credentials: Credentials,
  headers: Record<string, string>,
  stamp: string,
  hash: string,
): string {
  const day = stamp.slice(0, 8);
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [strictEncode(name), strictEncode(value)] as const)
    .sort(([a, aValue], [b, bValue]) =>
      a < b ? -1 : a > b ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    names.map((name) => `${name}:${headers[name]}\n`).join(''),
    names.join(';'),
    hash,
  ].join('\n');
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    `${day}/${region}/${service}/aws4_request`,
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), service),
    'aws4_request',
  );
  return createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
}

/** A request to an AWS service, and the place and keys that sign it. */
export interface AwsRequest {
  method: string;
  url: URL;
  region: string;
  /** The service the request is signed for: `s3`, `ses`, and so on */
  service: string;
  credentials: Credentials;
  /** Headers signed along with the host, such as `content-type` */
  headers?: Record<string, string>;
  now?: Date;
  /** The body's SHA-256 in hex, which the canonical request ends with, or the empty body's */
  hash?: string;
  /** Also send `x-amz-content-sha256`, which S3 wants and other services leave out */
  payloadHeader?: boolean;
}

/**
 * The headers that sign a request to any AWS service: `authorization`, `x-amz-date`, the payload's
 * hash when the service asks for it, and a role's session token when the credentials carry one.
 * Every header passed in is signed too, along with the host, which the HTTP client sends itself.
 */
export function signAwsRequest(request: AwsRequest): Record<string, string> {
  const { method, url, region, service, credentials } = request;
  const hash = request.hash ?? EMPTY_HASH;
  const stamp = amzDate(request.now ?? new Date());
  const signed: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: url.host,
    'x-amz-date': stamp,
    ...(request.payloadHeader ? { 'x-amz-content-sha256': hash } : {}),
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
  const names = Object.keys(signed).sort();
  const scope = `${stamp.slice(0, 8)}/${region}/${service}/aws4_request`;
  const proof = signature(method, url, region, service, credentials, signed, stamp, hash);
  const { host: _host, ...sent } = signed;
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${proof}`,
  };
}

/**
 * The headers that sign a bucket request: `authorization`, `x-amz-date`, and `x-amz-content-sha256`.
 * A request with a body passes the body's hash from `payloadHash`, and one without leaves it out.
 */
export function sign(
  method: string,
  url: URL,
  region: string,
  credentials: Credentials,
  headers: Record<string, string> = {},
  now: Date = new Date(),
  hash: string = EMPTY_HASH,
): Record<string, string> {
  return signAwsRequest({
    method,
    url,
    region,
    service: 's3',
    credentials,
    headers,
    now,
    hash,
    payloadHeader: true,
  });
}

/**
 * A presigned address: the request's signature rides in its query, so whoever holds the address
 * can make that one request, with no keys, until it expires.  Only the host is signed, so a
 * browser can add a `Range` header of its own.
 */
export function presign(
  method: string,
  url: URL,
  region: string,
  credentials: Credentials,
  expiresSeconds: number,
  now: Date = new Date(),
): URL {
  const stamp = amzDate(now);
  const signed = new URL(url);
  signed.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  signed.searchParams.set(
    'X-Amz-Credential',
    `${credentials.accessKeyId}/${stamp.slice(0, 8)}/${region}/s3/aws4_request`,
  );
  signed.searchParams.set('X-Amz-Date', stamp);
  signed.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  signed.searchParams.set('X-Amz-SignedHeaders', 'host');
  const proof = signature(
    method,
    signed,
    region,
    's3',
    credentials,
    { host: url.host },
    stamp,
    'UNSIGNED-PAYLOAD',
  );
  signed.searchParams.set('X-Amz-Signature', proof);
  // The query is written out the way it was signed, since URLSearchParams encodes a space as `+`.
  signed.search = [...signed.searchParams.entries()]
    .map(([name, value]) => `${strictEncode(name)}=${strictEncode(value)}`)
    .join('&');
  return signed;
}

function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (_match, decimal, hex, named) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as 'amp']!;
    },
  );
}

/** The text of an answer's first element with this name, unescaped, or null when it has none. */
export function element(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found ? unescapeXml(found[1]!) : null;
}

export interface ListedObject {
  key: string;
  bytes: number | null;
}

export interface Listing {
  objects: ListedObject[];
  /** Where the next page starts, or null on the last page */
  next: string | null;
}

/** A `ListObjectsV2` answer's objects and where the next page starts. */
export function parseListing(xml: string): Listing {
  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = element(match[1]!, 'Key');
    if (key === null) continue;
    const size = Number(element(match[1]!, 'Size'));
    objects.push({ key, bytes: Number.isSafeInteger(size) && size >= 0 ? size : null });
  }
  const truncated = element(xml, 'IsTruncated') === 'true';
  return { objects, next: truncated ? element(xml, 'NextContinuationToken') : null };
}

/** An S3 error answer's code and message, which never carry a credential. */
export function parseError(xml: string): { code: string; message: string } | null {
  const code = element(xml, 'Code');
  if (code === null) return null;
  return { code, message: element(xml, 'Message') ?? '' };
}
