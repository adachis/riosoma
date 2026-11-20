import {
  bucketTarget,
  element,
  objectUrl,
  parseError,
  payloadHash,
  presign,
  sign,
  strictEncode,
} from '@riosoma/connectors/s3';
import type { FileStorage, SignedUrlOptions } from './storage.js';
import {
  answerText,
  checkedKey,
  lazyDownload,
  MissingFile,
  PART_BYTES,
  partsOf,
  REQUEST_TIMEOUT_MS,
  StorageServiceError,
  withRetries,
  type RemoteOptions,
} from './remote.js';

/**
 * Attachments in an S3-compatible bucket: AWS S3, Cloudflare R2, Backblaze B2, Google Cloud
 * Storage through its interoperability keys, and MinIO.  Requests are signed with the same
 * Signature Version 4 code file sources use.  Small files go up in one request, and larger ones in
 * parts, holding one part in memory at a time.  An upload that fails partway is aborted, so the
 * bucket keeps none of its parts.
 */

export interface S3Settings {
  /** The service's address with no bucket in it, or AWS S3 in `region` when absent */
  endpoint?: string;
  region?: string;
  bucket: string;
  /** Put before every key, such as `riosoma/`, or empty */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Addresses like `endpoint/bucket/key` instead of `bucket.endpoint/key` */
  pathStyle: boolean;
  /** The `x-amz-server-side-encryption` header each new object is written with */
  serverSideEncryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
}

interface Call {
  headers?: Record<string, string>;
  body?: Buffer;
  /** The statuses that mean it worked */
  ok?: readonly number[];
}

function completion(etags: readonly string[]): Buffer {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = etags.map(
    (etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escape(etag)}</ETag></Part>`,
  );
  return Buffer.from(`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`, 'utf8');
}

export function s3Storage(settings: S3Settings, options: RemoteOptions = {}): FileStorage {
  const target = bucketTarget(settings);
  const credentials = { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey };
  const send = options.fetch ?? fetch;
  const partBytes = options.partBytes ?? PART_BYTES;
  const encryption: Record<string, string> = {};
  if (settings.serverSideEncryption)
    encryption['x-amz-server-side-encryption'] = settings.serverSideEncryption;
  if (settings.kmsKeyId) encryption['x-amz-server-side-encryption-aws-kms-key-id'] = settings.kmsKeyId;

  const objectName = (key: string) => `${settings.prefix}${checkedKey(key)}`;
  function urlOf(key: string, query: Record<string, string> = {}): URL {
    const url = objectUrl(target, objectName(key));
    // Written out the way Signature Version 4 encodes it, which URLSearchParams doesn't quite do.
    url.search = Object.entries(query)
      .map(([name, value]) => `${strictEncode(name)}=${strictEncode(value)}`)
      .join('&');
    return url;
  }

  async function call(method: string, url: URL, { headers = {}, body, ok = [200] }: Call): Promise<Response> {
    const response = await withRetries(() => {
      const signal =
        options.timeoutMs !== undefined
          ? AbortSignal.timeout(options.timeoutMs)
          : body
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : undefined;
      return send(url, {
        method,
        headers: sign(method, url, target.region, credentials, headers, new Date(), payloadHash(body)),
        ...(body ? { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) } : {}),
        ...(signal ? { signal } : {}),
      });
    });
    if (ok.includes(response.status)) return response;
    const code = parseError(await answerText(response))?.code ?? null;
    if (response.status === 404 && (code === null || code === 'NoSuchKey')) throw new MissingFile();
    throw new StorageServiceError(response.status, code);
  }

  /** A call whose answer is short XML, which can report a failure even with a 200. */
  async function callForXml(method: string, url: URL, request: Call): Promise<string> {
    const text = await answerText(await call(method, url, request));
    const error = parseError(text);
    if (error) throw new StorageServiceError(200, error.code);
    return text;
  }

  async function done(response: Promise<Response>): Promise<void> {
    await (await response).body?.cancel();
  }

  return {
    async write(key, source) {
      const url = urlOf(key);
      const parts = partsOf(source, partBytes)[Symbol.asyncIterator]();
      const first = await parts.next();
      const second = first.done ? first : await parts.next();
      if (second.done) {
        await done(
          call('PUT', url, { headers: encryption, body: first.done ? Buffer.alloc(0) : first.value }),
        );
        return;
      }
      const created = await callForXml('POST', urlOf(key, { uploads: '' }), { headers: encryption });
      const uploadId = element(created, 'UploadId');
      if (!uploadId) throw new StorageServiceError(200, null);
      try {
        const etags: string[] = [];
        const upload = async (part: Buffer) => {
          const number = String(etags.length + 1);
          const response = await call('PUT', urlOf(key, { partNumber: number, uploadId }), { body: part });
          await response.body?.cancel();
          const etag = response.headers.get('etag');
          if (!etag) throw new StorageServiceError(response.status, null);
          etags.push(etag);
        };
        await upload(first.value!);
        await upload(second.value);
        for (let part = await parts.next(); !part.done; part = await parts.next()) await upload(part.value);
        await callForXml('POST', urlOf(key, { uploadId }), { body: completion(etags) });
      } catch (error) {
        await parts.return(undefined);
        // Aborting removes the parts already sent, which the bucket would otherwise keep and bill.
        await done(call('DELETE', urlOf(key, { uploadId }), { ok: [200, 204, 404] })).catch(() => undefined);
        throw error;
      }
    },
    read(key, range) {
      const url = urlOf(key);
      return lazyDownload(() =>
        call('GET', url, {
          headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
          ok: [200, 206],
        }),
      );
    },
    async delete(key) {
      await done(call('DELETE', urlOf(key), { ok: [200, 204, 404] }));
    },
    async copy(from, to) {
      const source = `/${settings.bucket}/${objectName(from).split('/').map(strictEncode).join('/')}`;
      await callForXml('PUT', urlOf(to), { headers: { 'x-amz-copy-source': source, ...encryption } });
    },
    signedUrl(key, { seconds, type, disposition }: SignedUrlOptions) {
      const url = urlOf(key, { 'response-content-disposition': disposition, 'response-content-type': type });
      return Promise.resolve(presign('GET', url, target.region, credentials, seconds).href);
    },
  };
}
