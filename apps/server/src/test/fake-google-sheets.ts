import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Google's token address and the Sheets API, for tests.  It hands out tokens only
 * for assertions signed with its service account's key and addressed to it, answers a
 * spreadsheet's sheets and a range of its rows the way the Sheets API does (unformatted, with
 * empty rows at the end left out), refuses spreadsheets nobody shared with a 403, and can answer
 * 429 a number of times.  It never reaches Google.
 */

export interface FakeSheet {
  id: number;
  title: string;
  /** The grid's size, which is more rows than it holds */
  rows: number;
  columns: number;
  /** Row 1 first */
  values: unknown[][];
}

export interface FakeSpreadsheet {
  title: string;
  sheets: FakeSheet[];
  /** Whether the service account may open it */
  shared: boolean;
}

export interface FakeGoogleSheets {
  /** Where the Sheets API answers, like `http://127.0.0.1:1234` */
  url: string;
  tokenUrl: string;
  /** The service account's JSON key, which only this stand-in accepts */
  key: string;
  email: string;
  spreadsheets: Map<string, FakeSpreadsheet>;
  requests: Array<{ method: string; path: string }>;
  /** Tokens the token address handed out */
  tokens: string[];
  /** Answers 429 to the next `times` Sheets requests */
  throttle(times: number, retryAfterSeconds?: number): void;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function problem(res: ServerResponse, code: number, status: string, message: string) {
  send(res, code, { error: { code, message, status } });
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function startFakeGoogleSheets(
  spreadsheets: Record<string, FakeSpreadsheet>,
): Promise<FakeGoogleSheets> {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const email = 'riosoma-sync@garden-project.iam.gserviceaccount.com';
  const key = JSON.stringify({
    type: 'service_account',
    project_id: 'garden-project',
    private_key_id: 'fake-key-id',
    private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: email,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  const sheets = new Map(Object.entries(spreadsheets));
  const requests: FakeGoogleSheets['requests'] = [];
  const tokens: string[] = [];
  let throttles = 0;
  let retryAfter: number | undefined;
  let origin = '';

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    requests.push({ method: req.method ?? 'GET', path: url.pathname });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await bodyOf(req));
      const [header, claims, signature] = (form.get('assertion') ?? '').split('.');
      const good =
        header &&
        claims &&
        signature &&
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${claims}`),
          pair.publicKey,
          Buffer.from(signature, 'base64url'),
        );
      const said = good
        ? (JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>)
        : {};
      if (!good || said.iss !== email || said.aud !== `${origin}/token`)
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const token = `ya29.fake-${tokens.length + 1}-${Math.random().toString(36).slice(2)}`;
      tokens.push(token);
      return send(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
    }
    if (!tokens.includes(String(req.headers.authorization ?? '').replace(/^Bearer /, '')))
      return problem(res, 401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
    if (throttles > 0) {
      throttles--;
      return send(
        res,
        429,
        { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },
        retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) },
      );
    }
    const match = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+))?$/.exec(url.pathname);
    const spreadsheet = match ? sheets.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !spreadsheet) return problem(res, 404, 'NOT_FOUND', 'Requested entity was not found.');
    if (!spreadsheet.shared)
      return problem(res, 403, 'PERMISSION_DENIED', 'The caller does not have permission');
    if (!match[2])
      return send(res, 200, {
        spreadsheetId: match[1],
        properties: { title: spreadsheet.title },
        sheets: spreadsheet.sheets.map((sheet, index) => ({
          properties: {
            sheetId: sheet.id,
            title: sheet.title,
            index,
            sheetType: 'GRID',
            gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns },
          },
        })),
      });
    const range = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(decodeURIComponent(match[2]));
    const sheet = spreadsheet.sheets.find((entry) => entry.title === range?.[1]?.replaceAll("''", "'"));
    if (!range || !sheet) return problem(res, 400, 'INVALID_ARGUMENT', 'Unable to parse range');
    if (Number(range[3]) > sheet.rows)
      return problem(res, 400, 'INVALID_ARGUMENT', 'Range exceeds grid limits');
    const rows = sheet.values.slice(Number(range[2]) - 1, Number(range[3])).map((row) => [...row]);
    while (rows.length && rows.at(-1)!.length === 0) rows.pop();
    send(res, 200, {
      range: decodeURIComponent(match[2]),
      majorDimension: 'ROWS',
      ...(rows.length ? { values: rows } : {}),
    });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: { code: 500, status: 'INTERNAL' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    tokenUrl: `${origin}/token`,
    key,
    email,
    spreadsheets: sheets,
    requests,
    tokens,
    throttle(times, retryAfterSeconds) {
      throttles = times;
      retryAfter = retryAfterSeconds;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
