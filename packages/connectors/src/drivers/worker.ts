type Row = Record<string, unknown>;
interface Cursor {
  description: unknown[][];
  columntypename: string[];
  executeAsync(sql: string, params?: unknown[]): Promise<void>;
  fetchmany(size: number): unknown[][];
  close(): void;
}
interface Teradata {
  cursor(): Cursor;
}
interface Result {
  /** Up to `count` rows, and none once the result is done */
  fetchN(count: number): Promise<Row[]>;
  close(): Promise<void>;
  getColumnMetadataSync(): Array<{
    SQL_DESC_NAME: string;
    SQL_DESC_TYPE_NAME: string;
    SQL_DESC_NULLABLE: number;
    SQL_DESC_LENGTH: number;
    SQL_DESC_SCALE: number;
  }>;
}
interface Ibm {
  beginTransaction(): Promise<void>;
  queryResult(sql: string, params: unknown[], callback: (error: Error | null, result: Result) => void): void;
}
let connection: Teradata | Ibm;
let cursor: Cursor | Result | undefined;
let kind = '';
let secrets: Record<string, string> = {};

/** A driver's own words for a failure.  IBM's driver fails with a plain object that has a message. */
function diagnostic(error: unknown): string {
  let message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);
  // Native diagnostics can render credentials with JSON or ODBC escaping.
  const forms = Object.values(secrets)
    .filter(Boolean)
    .flatMap((secret) => [
      secret,
      secret.replaceAll('}', '}}'),
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])
    .sort((a, b) => b.length - a.length);
  for (const form of forms) message = message.split(form).join('[redacted]');
  return message;
}

async function clearCursor() {
  if (cursor) await cursor.close();
  cursor = undefined;
}

/**
 * One value in IBM's connection string.  IBM's client reads every value as written, braces and
 * quotes included, up to the next semicolon, and has no way to escape one.  A value with a semicolon
 * or a control character would be read as more settings, so it's refused, and the connector says so
 * before it gets here.
 */
function ibmValue(value: unknown): string {
  const text = String(value);
  if (text.includes(';') || [...text].some((character) => character.charCodeAt(0) < 32))
    throw new Error('sources.test.ibmSemicolon');
  return text;
}

async function run(message: Record<string, unknown>) {
  if (message.action === 'open') {
    const c = message.connection as Record<string, unknown>;
    secrets = message.secrets as Record<string, string>;
    kind = String(c.kind);
    const loaded = await import(String(message.url));
    const driver = loaded.default ?? loaded;
    if (kind === 'teradata') {
      connection = await driver.connectAsync({
        host: c.host,
        user: c.user,
        password: secrets.password,
        database: c.database,
        logmech: c.logmech,
        cop: 'false',
        tmode: 'ANSI',
        sslmode: c.secure ? 'VERIFY-FULL' : 'DISABLE',
        https_port: String(c.port),
        dbs_port: String(c.port),
        ...(c.caPem ? { sslbase64: Buffer.from(String(c.caPem)).toString('base64url') } : {}),
        logon_timeout: String(Math.max(1, Math.ceil(Number(message.timeoutMs) / 1000))),
      });
    } else {
      const values: Record<string, unknown> = {
        DATABASE: c.database,
        HOSTNAME: c.host,
        PORT: c.port,
        PROTOCOL: 'TCPIP',
        UID: c.user,
        PWD: secrets.password,
      };
      if (kind === 'db2') values.ReadOnlyConnection = '1';
      // Informix reads a double-quoted name as text unless this is on, and every name the connector
      // sends is double-quoted.
      if (kind === 'informix') values.DELIMIDENT = 'y';
      if (c.secure) {
        values.SECURITY = 'SSL';
        values.SSLClientHostnameValidation = 'BASIC';
        if (message.caFile) values.SSLServerCertificate = message.caFile;
      }
      const text = Object.entries(values)
        .map(([key, value]) => `${key}=${ibmValue(value)}`)
        .join(';');
      connection = await driver.open(text, {
        connectTimeout: Math.max(1, Math.ceil(Number(message.timeoutMs) / 1000)),
      });
    }
    return null;
  }
  if (message.action === 'begin') {
    await (connection as Ibm).beginTransaction();
    return null;
  }
  if (message.action === 'execute') {
    await clearCursor();
    if (kind === 'teradata') {
      const result = (connection as Teradata).cursor();
      cursor = result;
      await result.executeAsync(String(message.sql), (message.params ?? []) as unknown[]);
      return (result.description ?? []).map((column, index) => ({
        name: String(column[0]),
        type: result.columntypename[index] ?? 'unknown',
        nullable: Boolean(column[6]),
        length: Number(column[3]),
        scale: Number(column[5]),
      }));
    }
    const result = await new Promise<Result>((resolve, reject) =>
      (connection as Ibm).queryResult(
        String(message.sql),
        (message.params ?? []) as unknown[],
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
    cursor = result;
    return result.getColumnMetadataSync().map((column) => ({
      name: column.SQL_DESC_NAME,
      type: column.SQL_DESC_TYPE_NAME,
      nullable: column.SQL_DESC_NULLABLE !== 0,
      length: column.SQL_DESC_LENGTH,
      scale: column.SQL_DESC_SCALE,
    }));
  }
  if (message.action === 'fetch') {
    const size = Number(message.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > 50000 || !cursor)
      throw new Error('sources.sync.read');
    if (kind === 'teradata') {
      const result = cursor as Cursor;
      return result
        .fetchmany(size)
        .map((row) =>
          Object.fromEntries(result.description.map((column, index) => [String(column[0]), row[index]])),
        );
    }
    // One call for the whole batch.  IBM's single-row fetch also loses the server's words when it fails.
    return (cursor as Result).fetchN(size);
  }
  if (message.action === 'clear') {
    await clearCursor();
    return null;
  }
  throw new Error('sources.sync.read');
}

/**
 * Keeps this process's event loop turning while a driver call is under way.  IBM's add-on hands its
 * native work straight to the event library's thread pool, and on some Node builds that work
 * finishing doesn't wake the loop, so its answer would wait for whatever wakes the loop next.  A
 * short timer is that next thing, and it stops when no call is left.
 */
const HEARTBEAT_MS = 10;
let calls = 0;
let heartbeat: NodeJS.Timeout | undefined;

process.on('message', (message: Record<string, unknown>) => {
  calls += 1;
  heartbeat ??= setInterval(() => undefined, HEARTBEAT_MS);
  void run(message)
    .then(
      (value) => process.send?.({ id: message.id, value }),
      (error: unknown) => process.send?.({ id: message.id, error: diagnostic(error) }),
    )
    .finally(() => {
      calls -= 1;
      if (calls === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    });
});
process.on('disconnect', () => process.exit(0));
