import { lookup as systemLookup, resolveSrv } from 'node:dns/promises';
import { createConnection, isIP, type LookupFunction } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type {
  CellValue,
  MongoConnection,
  SourceColumn,
  SourceObject,
  SourceObjectRef,
  SourceSelect,
  SourceTestResult,
  TestStep,
} from '@riosoma/contracts';
import { openTunnel, TunnelError, type Tunnel } from '@riosoma/db';
import {
  MongoClient,
  type Collection,
  type Db,
  type Document,
  type FindCursor,
  type MongoClientOptions,
} from 'mongodb';
import { Budget, resource } from '@riosoma/connectors/internal/common.js';
import type { FileCell } from '@riosoma/connectors/internal/files/cells.js';
import { FileNetworkError, type CheckedAddress } from '@riosoma/connectors/internal/files/network.js';
import { sourceKey } from '@riosoma/connectors/internal/registry.js';
import {
  cellsOf,
  plainColumn,
  SAMPLE_RECORDS,
  Sampler,
  type RestColumn,
} from '@riosoma/connectors/internal/rest/records.js';
import { positive } from '@riosoma/connectors/internal/sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
} from '@riosoma/connectors/internal/types.js';
import { scrubDetail } from '@riosoma/connectors/internal/warehouses/errors.js';
import { RowBatcher } from '@riosoma/connectors/internal/warehouses/values.js';
import {
  asksForTls,
  hostText,
  isHost,
  parseConnectionString,
  plainHost,
  refusedOption,
  throughTunnel,
  type MongoAddress,
} from '@riosoma/connectors/internal/mongodb/address.js';
import { documentRecord } from '@riosoma/connectors/internal/mongodb/documents.js';
import { FILTER_KEYS, parseFilter } from './filter.js';

/**
 * MongoDB, MongoDB Atlas, and services that speak its protocol.  A source reads one database, and
 * offers its collections and views the way a database offers tables.  Documents flatten into
 * columns by the rules API sources use, over a sample of up to 1,000 documents, and MongoDB's own
 * types read the way `documents.ts` says.
 *
 * Every call connects, works, and closes, like the other connectors.  Where the server may be is
 * the server's call: every name the driver looks up goes through the network the server supplies,
 * which holds it to the private-network rule, and so does every address the connection string or
 * a replica set names outright, which the driver would otherwise reach without a lookup.  An SSH
 * tunnel's bastion is held to the rule too, and the servers behind it are the bastion's business.
 * A synced table's filter only ever runs as a query document, never as JavaScript.
 */

export const MONGO_KEYS = {
  blocked: 'sources.mongodb.blocked',
  connectionString: 'sources.mongodb.connectionString',
  option: 'sources.mongodb.option',
  host: 'sources.remote.host',
  tunnel: 'sources.mongodb.tunnel',
  srv: 'sources.mongodb.srv',
  denied: 'sources.mongodb.denied',
  unauthorized: 'sources.mongodb.unauthorized',
  selection: 'sources.mongodb.selection',
  noQueries: 'sources.mongodb.noQueries',
  filter: FILTER_KEYS.json,
  javascript: FILTER_KEYS.javascript,
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  secretsMissing: 'sources.secretsMissing',
  timeout: 'sources.test.timeout',
  tls: 'sources.test.tls',
  tunnelFailed: 'sources.test.tunnel',
} as const;

/** Keys a failed test step carries as they are, since each says more than the step's own advice. */
const ADVICE = new Set<string>([
  MONGO_KEYS.blocked,
  MONGO_KEYS.connectionString,
  MONGO_KEYS.option,
  MONGO_KEYS.host,
  MONGO_KEYS.tunnel,
  MONGO_KEYS.srv,
  MONGO_KEYS.denied,
  MONGO_KEYS.unauthorized,
  MONGO_KEYS.selection,
  MONGO_KEYS.secretsMissing,
  MONGO_KEYS.timeout,
  MONGO_KEYS.tunnelFailed,
]);

/**
 * How a MongoDB source reaches the network.  The server supplies one that holds every address to
 * the private-network rule.  Without one, names resolve the ordinary way and every address is open,
 * as they are for the other database sources.
 */
export interface MongoNetwork {
  /**
   * Every address a host name resolves to, once each has passed the rule.  One the rule refuses
   * throws `FileNetworkError('blocked')`, and a name that doesn't resolve `FileNetworkError('resolve')`.
   */
  lookup(hostname: string): Promise<CheckedAddress[]>;
  /** Whether an address written outright, like `10.0.0.5`, may be reached */
  allowsAddress(address: string): boolean;
}

export const OPEN_NETWORK: MongoNetwork = {
  async lookup(hostname) {
    try {
      return (await systemLookup(hostname, { all: true, verbatim: true })).map((entry) => ({
        address: entry.address,
        family: entry.family === 6 ? 6 : 4,
      }));
    } catch (error) {
      throw new FileNetworkError('resolve', error instanceof Error ? error.message : undefined);
    }
  },
  allowsAddress: () => true,
};

export interface MongoConnectorOptions {
  network?: MongoNetwork;
  /** How long a sample, a count, or a listing may run on the server: 20 seconds unless set */
  serverMs?: number;
  /** Collections whose sizes a listing asks for, at most: 200 unless set */
  estimates?: number;
}

/** The ways the driver signs in with a user and password alone. */
const PASSWORDS = new Set<string>(['DEFAULT', 'PLAIN', 'SCRAM-SHA-1', 'SCRAM-SHA-256']);

const DEFAULT_SERVER_MS = 20_000;
const DEFAULT_ESTIMATES = 200;
/** Size estimates asked for at once while listing. */
const ESTIMATE_CONCURRENCY = 8;

/** One call's watch over where the driver goes, which stops the call the moment it goes somewhere refused. */
interface Guard {
  blocked: string | null;
  stop: AbortController;
  /** Values no message may hold beyond the stored secrets, like a password inside a connection string */
  hidden: string[];
}

/** A connection that's open for one call. */
interface Session {
  client: MongoClient;
  db: Db;
  settings: MongoConnection;
  budget: Budget;
  /** Aborts when the caller gives up, or when the guard refuses an address */
  signal: AbortSignal;
  close(): Promise<void>;
}

/** Where a connection goes, and how: what the driver is given, and what the test ladder checks. */
interface Plan {
  url: string;
  options: MongoClientOptions;
  /** The servers named outright, or the one DNS name that finds them */
  seeds: Array<{ host: string; port: number }>;
  srv: boolean;
  tls: boolean;
}

/** What a synced table reads: a collection or view, and the filter it runs with. */
interface Target {
  collection: Collection<Document>;
  view: boolean;
  filter: Document;
  filtered: boolean;
}

function settingsOf(ctx: ConnectorContext): MongoConnection {
  if (ctx.connection.kind !== 'mongodb')
    throw new ConnectorError(
      MONGO_KEYS.read,
      `the connection settings are for ${ctx.connection.kind}, not mongodb`,
    );
  return ctx.connection;
}

function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/** The host of an address the driver writes as `host:port` or `[v6]:port`. */
function hostOfAddress(address: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(address);
  if (bracketed) return bracketed[1]!;
  const colon = address.lastIndexOf(':');
  return colon < 0 ? address : address.slice(0, colon);
}

/** The top-level field a flattened column comes from, which is what a projection names. */
function topField(column: string): string {
  const dot = column.indexOf('.');
  return dot < 0 ? column : column.slice(0, dot);
}

export function createMongoConnector(options: MongoConnectorOptions = {}): Connector {
  const network = options.network ?? OPEN_NETWORK;
  const serverMs = options.serverMs ?? DEFAULT_SERVER_MS;
  const estimates = options.estimates ?? DEFAULT_ESTIMATES;

  function guardFor(ctx: ConnectorContext): Guard {
    const hidden: string[] = [];
    if (ctx.connection.kind === 'mongodb' && ctx.secrets.connectionString) {
      const address = parseConnectionString(ctx.secrets.connectionString);
      for (const value of [address?.password, address?.user])
        if (value) hidden.push(value, encodeURIComponent(value));
    }
    return { blocked: null, stop: new AbortController(), hidden };
  }

  function block(guard: Guard, host: string): void {
    guard.blocked ??= host;
    guard.stop.abort();
  }

  function scrubbed(detail: unknown, ctx: ConnectorContext, guard: Guard): string | undefined {
    let text = scrubDetail(detail, ctx);
    if (text === undefined) return undefined;
    for (const value of [...guard.hidden].sort((a, b) => b.length - a.length))
      if (value.length >= 4) text = text.split(value).join('[redacted]');
    return text;
  }

  /** The error a call leaves with: a key people can act on, and scrubbed words behind it. */
  function failure(
    error: unknown,
    ctx: ConnectorContext,
    guard: Guard,
    select?: SourceSelect | { object: SourceObjectRef },
  ): ConnectorError {
    if (guard.blocked !== null)
      return new ConnectorError(MONGO_KEYS.blocked, `${guard.blocked} is on a private network`);
    if (error instanceof ConnectorError) {
      const timedOut = error.messageKey === MONGO_KEYS.timeout;
      return new ConnectorError(
        timedOut ? MONGO_KEYS.read : error.messageKey,
        error.detail !== undefined
          ? scrubbed(error.detail, ctx, guard)
          : timedOut
            ? `MongoDB took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
            : ctx.signal?.aborted
              ? 'the call was stopped before it finished'
              : undefined,
        timedOut ? { ...error.params, reason: 'timeout' } : error.params,
      );
    }
    if (error instanceof FileNetworkError && error.problem === 'blocked')
      return new ConnectorError(MONGO_KEYS.blocked, scrubbed(error.detail, ctx, guard));
    const detail = scrubbed(error, ctx, guard);
    if (error instanceof TunnelError) return new ConnectorError(MONGO_KEYS.tunnelFailed, detail);
    const code = codeOf(error);
    if (code === 18) return new ConnectorError(MONGO_KEYS.denied, detail);
    if (code === 13) return new ConnectorError(MONGO_KEYS.unauthorized, detail);
    if (code === 26) {
      const object = select && 'object' in select ? select.object.name : '';
      return new ConnectorError(MONGO_KEYS.objectMissing, detail, { object });
    }
    if (nameOf(error) === 'MongoParseError') return new ConnectorError(MONGO_KEYS.connectionString, detail);
    if (nameOf(error) === 'MongoServerSelectionError')
      return new ConnectorError(MONGO_KEYS.selection, detail);
    return new ConnectorError(MONGO_KEYS.read, detail);
  }

  /** A host's addresses under the rule, with an address written outright checked as it is. */
  async function checkedHost(host: string, guard: Guard): Promise<CheckedAddress> {
    const literal = isIP(host);
    if (literal) {
      if (!network.allowsAddress(host)) {
        block(guard, host);
        throw new FileNetworkError('blocked', `${host} is on a private network`);
      }
      return { address: host, family: literal === 6 ? 6 : 4 };
    }
    try {
      const found = await network.lookup(host);
      if (!found[0]) throw new FileNetworkError('resolve', `${host} has no address`);
      return found[0];
    } catch (error) {
      if (error instanceof FileNetworkError && error.problem === 'blocked') block(guard, host);
      throw error;
    }
  }

  /** The driver's lookups, through the network the server supplied. */
  function lookupFor(guard: Guard): LookupFunction {
    return (hostname, lookupOptions, callback) => {
      const family =
        lookupOptions.family === 4 || lookupOptions.family === 'IPv4'
          ? 4
          : lookupOptions.family === 6 || lookupOptions.family === 'IPv6'
            ? 6
            : 0;
      network.lookup(hostname).then(
        (found) => {
          const usable = family ? found.filter((entry) => entry.family === family) : found;
          if (!usable[0]) {
            const missing = Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' });
            callback(missing, '', 4);
          } else if (lookupOptions.all)
            callback(
              null,
              usable.map(({ address, family }) => ({ address, family })),
            );
          else callback(null, usable[0].address, usable[0].family);
        },
        (error: unknown) => {
          const refused = error instanceof FileNetworkError && error.problem === 'blocked';
          if (refused) block(guard, hostname);
          const failed = Object.assign(
            new Error(refused ? `${hostname} is on a private network` : `${hostname} didn’t resolve`),
            {
              code: refused ? 'EACCES' : 'ENOTFOUND',
            },
          );
          callback(failed, '', 4);
        },
      );
    };
  }

  function secretOf(ctx: ConnectorContext, name: 'connectionString' | 'password'): string {
    const value = ctx.secrets[name];
    if (!value) throw new ConnectorError(MONGO_KEYS.secretsMissing, `the ${name} secret isn’t stored`);
    return value;
  }

  /**
   * Where a connection goes and what the driver is given.  With a tunnel, the driver connects to
   * the tunnel's end directly and checks the certificate against the server's own name.
   */
  function planOf(ctx: ConnectorContext, guard: Guard, tunnel?: Tunnel): Plan {
    const settings = settingsOf(ctx);
    const ms = positive(ctx.timeoutMs, 30000);
    const options: MongoClientOptions = {
      appName: 'Riosoma',
      serverSelectionTimeoutMS: ms,
      connectTimeoutMS: ms,
      maxPoolSize: 2,
      minPoolSize: 0,
      retryReads: true,
      lookup: lookupFor(guard),
      // A whole number too long for a number stays exact, and a pattern stays the text it was.
      promoteLongs: true,
      bsonRegExp: true,
    };
    let url: string;
    let seeds: Plan['seeds'];
    let srv: boolean;
    let tls: boolean;
    if (settings.address === 'uri') {
      const text = secretOf(ctx, 'connectionString');
      const address: MongoAddress | null = parseConnectionString(text);
      const refused = refusedOption(text);
      if (refused !== null)
        throw new ConnectorError(
          MONGO_KEYS.option,
          'the connection string sets an option a source can’t use',
        );
      if (!address)
        throw new ConnectorError(MONGO_KEYS.connectionString, 'the connection string doesn’t read as one');
      seeds = address.hosts;
      srv = address.srv;
      tls = settings.tls.mode === 'auto' ? asksForTls(address) : settings.tls.mode === 'on';
      if (settings.ssh && (address.srv || address.hosts.length !== 1))
        throw new ConnectorError(MONGO_KEYS.tunnel, 'a tunnel reaches one server, and the string names more');
      url = tunnel ? throughTunnel(text, address, tunnel.host, tunnel.port) : text;
      if (settings.tls.mode !== 'auto') options.tls = tls;
    } else {
      // The host goes into an address the driver reads, so it has to be a host and nothing more.
      const host = settings.host!.replace(/^\[(.*)\]$/, '$1');
      if (!isHost(host))
        throw new ConnectorError(MONGO_KEYS.host, 'the host isn’t a host name or an IP address on its own');
      srv = settings.srv;
      seeds = [{ host: plainHost(host), port: settings.port }];
      tls = settings.tls.mode === 'auto' ? srv : settings.tls.mode === 'on';
      url = tunnel
        ? `mongodb://${hostText(tunnel.host, tunnel.port)}/`
        : srv
          ? `mongodb+srv://${host}/`
          : `mongodb://${hostText(host, settings.port)}/`;
      options.tls = tls;
      if (settings.user) options.auth = { username: settings.user, password: secretOf(ctx, 'password') };
    }
    if (settings.authSource) options.authSource = settings.authSource;
    if (tls && settings.tls.caPem) options.ca = settings.tls.caPem;
    if (tunnel) {
      options.directConnection = true;
      const name = seeds[0]!.host;
      if (tls && !isIP(name)) options.servername = name;
    } else if (!settings.ssh) {
      // Addresses written outright never go through a lookup, so they're checked here.  Behind a
      // tunnel, the servers are wherever the bastion reaches.
      for (const seed of seeds)
        if (isIP(seed.host) && !network.allowsAddress(seed.host)) {
          block(guard, seed.host);
          throw new FileNetworkError('blocked', `${seed.host} is on a private network`);
        }
    }
    return { url, options, seeds, srv, tls };
  }

  /** Opens the SSH tunnel a connection has, to its bastion's checked address. */
  async function tunnelFor(ctx: ConnectorContext, guard: Guard, budget: Budget): Promise<Tunnel | undefined> {
    const settings = settingsOf(ctx);
    if (!settings.ssh) return undefined;
    // The plan says whether the string can go through a tunnel before the bastion is asked.
    const seed = planOf(ctx, guard).seeds[0]!;
    const bastion = await budget.run(() => checkedHost(settings.ssh!.host, guard));
    return resource(budget, () =>
      openTunnel(
        {
          ...settings.ssh!,
          host: bastion.address,
          privateKeyPem: ctx.secrets.sshPrivateKeyPem ?? '',
          passphrase: ctx.secrets.sshPassphrase,
        },
        seed,
      ),
    );
  }

  /**
   * A connected client.  A replica set names its members itself, and a member named by address
   * never goes through a lookup, so each one is checked as it's added.
   */
  async function connectClient(
    ctx: ConnectorContext,
    guard: Guard,
    budget: Budget,
    tunnel: Tunnel | undefined,
  ): Promise<MongoClient> {
    const plan = planOf(ctx, guard, tunnel);
    const client = new MongoClient(plan.url, plan.options);
    // The driver settles its own options from the address.  Whatever it settled on, it connects to
    // the servers themselves and signs in with the user and password it was given.
    const mechanism = client.options.credentials?.mechanism;
    if (client.options.proxyHost !== undefined || (mechanism !== undefined && !PASSWORDS.has(mechanism)))
      throw new ConnectorError(MONGO_KEYS.option, 'the connection would use a proxy or another sign-in');
    client.on('serverOpening', (event) => {
      const host = hostOfAddress(event.address);
      if (tunnel && host === tunnel.host) return;
      if (isIP(host) && !network.allowsAddress(host)) block(guard, host);
    });
    try {
      await budget.run(
        () => client.connect(),
        () => void client.close().catch(() => undefined),
      );
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return client;
  }

  /** A connected client for one call, closed along with its tunnel when the call is done. */
  async function openSession(ctx: ConnectorContext, guard: Guard): Promise<Session> {
    const settings = settingsOf(ctx);
    const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), guard.stop.signal]);
    const budget = new Budget({ ...ctx, signal });
    let tunnel: Tunnel | undefined;
    try {
      tunnel = await tunnelFor(ctx, guard, budget);
      const client = await connectClient(ctx, guard, budget, tunnel);
      const opened = tunnel;
      return {
        client,
        db: client.db(settings.database),
        settings,
        budget,
        signal,
        close: async () => {
          await client.close().catch(() => undefined);
          await opened?.close().catch(() => undefined);
        },
      };
    } catch (error) {
      await tunnel?.close().catch(() => undefined);
      throw error;
    }
  }

  /** One piece of work in a session of its own, which is closed however the work ends. */
  async function withSession<T>(
    ctx: ConnectorContext,
    work: (session: Session) => Promise<T>,
    select?: SourceSelect | { object: SourceObjectRef },
  ): Promise<T> {
    const guard = guardFor(ctx);
    let session: Session | undefined;
    try {
      session = await openSession(ctx, guard);
      const running = session;
      return await running.budget.run(
        () => work(running),
        () => void running.close(),
      );
    } catch (error) {
      throw failure(error, ctx, guard, select);
    } finally {
      await session?.close();
    }
  }

  /** The collection or view a select names, which must exist, and its filter. */
  async function targetOf(session: Session, select: SourceSelect): Promise<Target> {
    if (select.kind !== 'object')
      throw new ConnectorError(
        MONGO_KEYS.noQueries,
        'MongoDB sources read collections and views, not queries',
      );
    const filter = parseFilter(select.filter);
    const { name } = select.object;
    // A missing collection reads as an empty one, which would look like every record leaving.
    const found = await session.db
      .listCollections({ name }, { nameOnly: true, authorizedCollections: true, signal: session.signal })
      .toArray();
    if (!found[0])
      throw new ConnectorError(
        MONGO_KEYS.objectMissing,
        `the database has no collection or view named ${name}`,
        {
          object: name,
        },
      );
    return {
      collection: session.db.collection(name),
      view: found[0].type === 'view',
      filter,
      filtered: Object.keys(filter).length > 0,
    };
  }

  /**
   * Up to 1,000 documents that decide each column's type: a random sample, or the first ones when
   * the server can't sample, or sampling runs out of time on a large view.  A sample is put in
   * `_id` order, so columns come in the order the earliest documents have them, the same each time.
   */
  async function sampleOf(session: Session, target: Target): Promise<Document[]> {
    const pipeline: Document[] = [
      ...(target.filtered ? [{ $match: target.filter }] : []),
      { $sample: { size: SAMPLE_RECORDS } },
      { $sort: { _id: 1 } },
    ];
    try {
      return await target.collection
        .aggregate(pipeline, { maxTimeMS: serverMs, signal: session.signal })
        .toArray();
    } catch (error) {
      const code = codeOf(error);
      if (nameOf(error) !== 'MongoServerError' || code === 13 || code === 18 || session.signal.aborted)
        throw error;
    }
    return target.collection
      .find(target.filter, { limit: SAMPLE_RECORDS, maxTimeMS: serverMs, signal: session.signal })
      .toArray();
  }

  function samplerOf(settings: MongoConnection, documents: Document[]): Sampler {
    const sampler = new Sampler(settings);
    for (const document of documents) sampler.add(documentRecord(document));
    return sampler;
  }

  /** How many documents a collection or view holds, when that's cheap to know. */
  async function estimateOf(session: Session, target: Target, sampled: number): Promise<number | null> {
    // A sample smaller than it asked for holds every matching document.
    if (sampled < SAMPLE_RECORDS) return sampled;
    if (target.view || target.filtered) return null;
    return target.collection.estimatedDocumentCount({ maxTimeMS: serverMs }).catch(() => null);
  }

  async function listObjects(session: Session): Promise<SourceObject[]> {
    const listed = await session.db
      .listCollections({}, { nameOnly: true, authorizedCollections: true, signal: session.signal })
      .toArray();
    const shown = listed
      .filter((entry) => !entry.name.startsWith('system.'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const counts = new Map<string, number | null>();
    const counted = shown.filter((entry) => entry.type !== 'view').slice(0, estimates);
    for (let at = 0; at < counted.length; at += ESTIMATE_CONCURRENCY) {
      await Promise.all(
        counted.slice(at, at + ESTIMATE_CONCURRENCY).map(async (entry) => {
          const count = await session.db
            .collection(entry.name)
            .estimatedDocumentCount({ maxTimeMS: serverMs })
            .catch(() => null);
          counts.set(entry.name, count);
        }),
      );
    }
    return shown.map((entry) => ({
      schema: null,
      name: entry.name,
      type: entry.type === 'view' ? 'view' : 'collection',
      rowEstimate: counts.get(entry.name) ?? null,
    }));
  }

  function rowsOf(documents: Document[], columns: RestColumn[], settings: MongoConnection): CellValue[][] {
    return documents.map((document) => {
      const cells = cellsOf(documentRecord(document), settings);
      return columns.map((entry) =>
        entry.column.suggested
          ? entry.value(cells.get(entry.column.name), entry.column.suggested.type)
          : null,
      );
    });
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    const guard = guardFor(ctx);
    let tunnel: Tunnel | undefined;
    let client: MongoClient | undefined;
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    const enter = (step: TestStep) => {
      current = step;
      start = Date.now();
    };
    try {
      const settings = settingsOf(ctx);
      const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), guard.stop.signal]);
      const budget = new Budget({ ...ctx, signal });
      // Whether the settings make a connection at all comes before anything is asked of the network.
      let plan = planOf(ctx, guard);
      if (settings.ssh) {
        enter('tunnel');
        tunnel = await tunnelFor(ctx, guard, budget);
        passed('tunnel');
        plan = planOf(ctx, guard, tunnel);
      }

      enter('resolve');
      const seed = tunnel ? { host: tunnel.host, port: tunnel.port } : plan.seeds[0]!;
      let reach = seed;
      if (plan.srv && !tunnel) {
        // The servers are wherever the name's service records say, and the first one is tried.
        const records = await budget.run(() =>
          resolveSrv(`_mongodb._tcp.${seed.host}`).catch((error: unknown) => {
            throw new ConnectorError(
              MONGO_KEYS.srv,
              `no service records for ${seed.host}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        );
        const first = [...records].sort((a, b) => a.priority - b.priority)[0];
        if (!first) throw new ConnectorError(MONGO_KEYS.srv, `no service records for ${seed.host}`);
        reach = { host: first.name, port: first.port };
      }
      // A tunnel's end is this machine, which the rule has nothing to say about.
      const checked: CheckedAddress = tunnel
        ? { address: tunnel.host, family: 4 }
        : await budget.run(() => checkedHost(reach.host, guard));
      passed('resolve');

      enter('connect');
      const socket = createConnection({ host: checked.address, port: reach.port });
      try {
        await budget.run(
          () =>
            new Promise<void>((resolve, reject) => {
              socket.once('connect', resolve);
              socket.once('error', reject);
            }),
          () => socket.destroy(),
        );
      } finally {
        socket.destroy();
      }
      passed('connect');

      enter('tls');
      if (plan.tls) {
        const name = tunnel ? plan.seeds[0]!.host : reach.host;
        const secure = tlsConnect({
          host: checked.address,
          port: reach.port,
          ...(isIP(name) ? {} : { servername: name }),
          ...(settings.tls.caPem ? { ca: settings.tls.caPem } : {}),
        });
        try {
          await budget.run(
            () =>
              new Promise<void>((resolve, reject) => {
                secure.once('secureConnect', resolve);
                secure.once('error', reject);
              }),
            () => secure.destroy(),
          );
        } finally {
          secure.destroy();
        }
        passed('tls');
      } else steps.push({ step: 'tls', status: 'skipped', ms: null });

      // Signing in happens as the client connects, and a ping proves it took.
      enter('authenticate');
      const connected = await connectClient(ctx, guard, budget, tunnel);
      client = connected;
      const admin = connected.db('admin');
      await budget.run(() => admin.command({ ping: 1 }, { signal }));
      const version = await budget
        .run(() => admin.command({ buildInfo: 1 }, { signal }))
        .then((info) => (typeof info.version === 'string' ? info.version : null))
        .catch(() => null);
      passed('authenticate');

      enter('collections');
      const db = connected.db(settings.database);
      const listed = await budget.run(() =>
        db.listCollections({}, { nameOnly: true, authorizedCollections: true, signal }).toArray(),
      );
      passed('collections');

      enter('document');
      const first = listed
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith('system.'))
        .sort()[0];
      if (first === undefined) steps.push({ step: 'document', status: 'skipped', ms: null });
      else {
        await budget.run(() => db.collection(first).findOne({}, { maxTimeMS: serverMs, signal }));
        passed('document');
      }
      return { ok: true, steps, ...(version ? { serverVersion: `MongoDB ${version.slice(0, 50)}` } : {}) };
    } catch (error) {
      const detail = scrubbed(error instanceof ConnectorError ? (error.detail ?? '') : error, ctx, guard);
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey: testKey(error, current, guard),
        ...(detail ? { detail } : {}),
      });
      return { ok: false, steps };
    } finally {
      await client?.close().catch(() => undefined);
      await tunnel?.close().catch(() => undefined);
    }
  }

  /** The advice a failed step carries: the connector's own when it has one, the step's otherwise. */
  function testKey(error: unknown, step: TestStep, guard: Guard): string {
    if (guard.blocked !== null) return MONGO_KEYS.blocked;
    if (error instanceof ConnectorError)
      return ADVICE.has(error.messageKey) ? error.messageKey : `sources.test.${step}`;
    if (error instanceof FileNetworkError) {
      if (error.problem === 'blocked') return MONGO_KEYS.blocked;
      if (error.problem === 'resolve') return 'sources.test.resolve';
    }
    if (error instanceof TunnelError) return MONGO_KEYS.tunnelFailed;
    const code = codeOf(error);
    if (code === 18) return MONGO_KEYS.denied;
    if (code === 13) return MONGO_KEYS.unauthorized;
    if (nameOf(error) === 'MongoParseError') return MONGO_KEYS.connectionString;
    const text =
      error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : '';
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) return MONGO_KEYS.timeout;
    if (step === 'authenticate' && nameOf(error) === 'MongoServerSelectionError') {
      // A refused sign-in can surface as a failed selection, with the refusal as its cause.
      if (/auth/i.test(text) || codeOf((error as { cause?: unknown }).cause) === 18) return MONGO_KEYS.denied;
      return MONGO_KEYS.selection;
    }
    return `sources.test.${step}`;
  }

  return {
    kind: 'mongodb',
    test,
    listObjects: (ctx) => withSession(ctx, listObjects),
    async keyCandidates(ctx, object) {
      return withSession(
        ctx,
        async (session) => {
          const target = await targetOf(session, { kind: 'object', object });
          if (!target.view) return [['_id']];
          // A view can leave `_id` out, so it's offered only when the view has one.
          const first = await target.collection.findOne(
            {},
            { projection: { _id: 1 }, maxTimeMS: serverMs, signal: session.signal },
          );
          return first && '_id' in first ? [['_id']] : [];
        },
        { object },
      );
    },
    async describe(ctx, select): Promise<SourceColumn[]> {
      return withSession(
        ctx,
        async (session) => {
          const target = await targetOf(session, select);
          const sample = await sampleOf(session, target);
          return samplerOf(session.settings, sample)
            .describe()
            .map((entry) => entry.column);
        },
        select,
      );
    },
    async preview(ctx, select, limit): Promise<SourcePreviewRows> {
      positive(limit, 50);
      return withSession(
        ctx,
        async (session) => {
          const target = await targetOf(session, select);
          const sample = await sampleOf(session, target);
          const columns = samplerOf(session.settings, sample).describe();
          // The first documents, so a preview shows the same ones each time.
          const first = await target.collection
            .find(target.filter, { limit, maxTimeMS: serverMs, signal: session.signal })
            .toArray();
          return {
            columns: columns.map((entry) => entry.column),
            rows: rowsOf(first, columns, session.settings),
            rowEstimate: await estimateOf(session, target, sample.length),
          };
        },
        select,
      );
    },
    async *read(ctx, select, readOptions) {
      const guard = guardFor(ctx);
      let session: Session | undefined;
      let cursor: FindCursor<Document> | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        session = await openSession(ctx, guard);
        const running = session;
        const cancel = () => void running.close();
        const { budget, settings } = running;
        const target = await budget.run(() => targetOf(running, select), cancel);
        const wanted = [...new Set([...readOptions.columns, ...readOptions.keyColumns])];
        const fields = new Set(wanted.map(topField));
        // A name starting with `$` can't be projected, so a read that wants one reads everything.
        let projection: Document | undefined;
        if (![...fields].some((name) => name.startsWith('$'))) {
          projection = Object.fromEntries([...fields].map((name) => [name, 1]));
          // `_id` comes along unless it's left out by name.
          if (!fields.has('_id')) projection._id = 0;
        }
        cursor = target.collection.find(target.filter, {
          ...(projection ? { projection } : {}),
          batchSize: size,
          signal: running.signal,
        });
        const reading = cursor;
        let byName = new Map<string, RestColumn>();
        // A column no document in the sample has is still asked for, since documents leave out what's empty.
        const columnOf = (name: string): RestColumn => {
          let column = byName.get(name);
          if (!column) {
            column = plainColumn(name);
            byName.set(name, column);
          }
          return column;
        };
        const toRow = (cells: Map<string, FileCell>): SourceRow => ({
          key: sourceKey(readOptions.keyColumns.map((name) => columnOf(name).key(cells.get(name)))),
          values: Object.fromEntries(
            readOptions.columns.map((name) => {
              const column = columnOf(name);
              return [
                name,
                column.value(
                  cells.get(name),
                  readOptions.types[name] ?? column.column.suggested?.type ?? 'text',
                ),
              ];
            }),
          ),
        });
        // The first documents decide each column's type, the way a sample does, before any row leaves.
        const sampler = new Sampler(settings);
        let held: Array<Record<string, unknown>> | null = [];
        const batcher = new RowBatcher<SourceRow>(size);
        const settle = (): SourceRow[] => {
          byName = new Map(sampler.describe().map((entry) => [entry.column.name, entry]));
          const rows = held!.map((record) => toRow(cellsOf(record, settings)));
          held = null;
          return rows;
        };
        for (;;) {
          // Each batch the server sends gets the whole deadline, however long the read runs.
          const more = await budget.run(() => reading.hasNext(), cancel);
          if (!more) break;
          budget.renew();
          const records = reading.readBufferedDocuments().map((document) => documentRecord(document));
          let rows: SourceRow[];
          if (held !== null) {
            held.push(...records);
            for (const record of records) sampler.add(record);
            if (!sampler.full) continue;
            rows = settle();
          } else rows = records.map((record) => toRow(cellsOf(record, settings)));
          for (const batch of batcher.add(rows)) {
            running.signal.throwIfAborted();
            yield batch;
            budget.renew();
          }
        }
        // A collection smaller than the sample decides its types once every document is in.
        if (held !== null)
          for (const batch of batcher.add(settle())) {
            running.signal.throwIfAborted();
            yield batch;
          }
        const rest = batcher.flush();
        running.signal.throwIfAborted();
        if (rest) yield rest;
      } catch (error) {
        throw failure(error, ctx, guard, select);
      } finally {
        await cursor?.close().catch(() => undefined);
        await session?.close();
      }
    },
  };
}
