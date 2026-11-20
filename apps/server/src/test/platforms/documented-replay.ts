import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DocumentedAnswer {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  operation?: string;
  variables?: unknown;
  status?: number;
  response: unknown;
}
export interface DocumentedRecording {
  answers: DocumentedAnswer[];
  error: unknown;
}

/** Replays documented response shapes through HTTP so imports also exercise the guarded client. */
export async function documentedReplay(
  file: string,
  authorized: (headers: IncomingHttpHeaders, path: string) => boolean,
) {
  const recording = JSON.parse(readFileSync(file, 'utf8')) as DocumentedRecording;
  const requests: Array<{ path: string; body: unknown; headers: IncomingHttpHeaders }> = [];
  const faults: Array<{ match: string; response: unknown; status: number; retry?: number }> = [];
  let origin = '';
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url!, 'http://replay.test');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      : undefined;
    requests.push({ path: request.url!, body, headers: request.headers });
    const operation = typeof body?.query === 'string' ? /query\s+(\w+)/.exec(body.query)?.[1] : undefined;
    const faultIndex = faults.findIndex(
      (fault) => url.pathname.includes(fault.match) || operation === fault.match,
    );
    if (faultIndex >= 0) {
      const fault = faults.splice(faultIndex, 1)[0]!;
      reply.writeHead(fault.status, {
        'content-type': 'application/json',
        ...(fault.retry ? { 'retry-after': String(fault.retry) } : {}),
      });
      reply.end(JSON.stringify(fault.response));
      return;
    }
    if (!authorized(request.headers, url.pathname)) {
      reply.writeHead(401, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(recording.error));
      return;
    }
    const answer = recording.answers.find(
      (answer) =>
        answer.method === request.method &&
        answer.path === url.pathname &&
        (!answer.query ||
          (Object.keys(answer.query).length === [...url.searchParams].length &&
            Object.entries(answer.query).every(([key, value]) => url.searchParams.get(key) === value))) &&
        (!answer.operation || operation === answer.operation) &&
        (answer.variables === undefined ||
          JSON.stringify(answer.variables) === JSON.stringify(body?.variables)) &&
        (answer.body === undefined || JSON.stringify(answer.body) === JSON.stringify(body)),
    );
    if (!answer) {
      reply.writeHead(404, { 'content-type': 'application/json' });
      reply.end(JSON.stringify({ code: 'object_not_found' }));
      return;
    }
    if (typeof answer.response === 'string') {
      reply.writeHead(answer.status ?? 200, { 'content-type': 'text/plain' });
      reply.end(answer.response);
    } else {
      reply.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(answer.response).replaceAll('{{origin}}', origin));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: origin,
    port,
    requests,
    recording,
    fault(match: string, response: unknown, status = 200, retry?: number) {
      faults.push({ match, response, status, ...(retry ? { retry } : {}) });
    },
    reset() {
      faults.length = 0;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
