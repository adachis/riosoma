import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
export async function fakeVault(answer: (request: Received) => { status?: number; body?: unknown }) {
  const calls: Received[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const body = !text
      ? {}
      : request.headers['content-type']?.includes('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(text))
        : (JSON.parse(text) as Record<string, unknown>);
    const call = { method: request.method!, path: request.url!, headers: request.headers, body };
    calls.push(call);
    try {
      const result = answer(call);
      response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
      response.end(result.body === undefined ? '' : JSON.stringify(result.body));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
