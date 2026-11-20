import { isIP } from 'node:net';
import { MONGODB_DEFAULT_PORT } from '@riosoma/contracts';

/**
 * A MongoDB connection string, read far enough to know where it points: whether it finds its
 * servers through DNS (`mongodb+srv`), the hosts it names, the user and password in it, its
 * database, and its options.  The driver reads the string itself when it connects.  This reading
 * is for checking where it points before anything connects, and for putting an SSH tunnel's
 * address in place of its one host.
 */
export interface MongoAddress {
  srv: boolean;
  hosts: Array<{ host: string; port: number }>;
  user: string | null;
  password: string | null;
  database: string | null;
  options: URLSearchParams;
  /** Where the host list starts and ends in the text */
  hostSpan: readonly [number, number];
}

const SCHEME = /^(mongodb(?:\+srv)?):\/\//i;

/**
 * The options a connection string may carry, by their lowercase names, since the driver reads
 * names without regard to case.  Each one says how to talk to the servers the string names.
 * Anything else is refused, because the driver would act on it before any address is checked: a
 * proxy is another place to connect to, a certificate or key file is a path on this machine, a
 * server name changes which server the certificate must be for, and the other sign-in mechanisms
 * hand the server this machine's own identity.
 */
const OPTIONS = new Set([
  'appname',
  'authmechanism',
  'authsource',
  'compressors',
  'connecttimeoutms',
  'directconnection',
  'heartbeatfrequencyms',
  'journal',
  'localthresholdms',
  'maxidletimems',
  'maxpoolsize',
  'maxstalenessseconds',
  'minpoolsize',
  'readconcernlevel',
  'readpreference',
  'readpreferencetags',
  'replicaset',
  'retryreads',
  'retrywrites',
  'serverselectiontimeoutms',
  'sockettimeoutms',
  'ssl',
  'timeoutms',
  'tls',
  'w',
  'waitqueuetimeoutms',
  'wtimeoutms',
  'zlibcompressionlevel',
]);

/** The ways to sign in that use only the user and password the string itself holds. */
const MECHANISMS = new Set(['default', 'plain', 'scram-sha-1', 'scram-sha-256']);

/**
 * A host name as the driver reads one, with no character that starts another part of an address.
 * One dot may end it, the way a full name is written.  A name outside ASCII is written in its
 * ASCII form, so the name checked here is the name the driver looks up.
 */
const HOST_NAME = /^[a-z0-9_]([a-z0-9._-]*[a-z0-9_])?\.?$/i;

/** A host as the checks compare it: in lowercase, without the dot that ends a full name. */
export function plainHost(host: string): string {
  const name = host.toLowerCase();
  return isIP(name) === 0 ? name.replace(/\.$/, '') : name;
}

/** Whether text is one host name or IP address and nothing more, with an IPv6 address bare. */
export function isHost(text: string): boolean {
  if (isIP(text) !== 0) return true;
  const name = plainHost(text);
  // An address with a dot after it isn't a name, and a socket file isn't a host.
  return HOST_NAME.test(text) && isIP(name) === 0 && !name.endsWith('.sock');
}

/** The options part of a connection string, or null when it has none to read. */
function queryOf(input: string): URLSearchParams | null {
  const text = input.trim();
  const scheme = SCHEME.exec(text);
  if (!scheme) return null;
  const question = text.indexOf('?', scheme[0].length);
  return question < 0 ? null : new URLSearchParams(text.slice(question + 1));
}

/**
 * The first option a connection string sets that a source may not use, or null when every option
 * is one it may.  A sign-in mechanism has to be named exactly, since the driver takes a part of a
 * name for the whole.
 */
export function refusedOption(input: string): string | null {
  for (const [name, value] of queryOf(input) ?? []) {
    const key = name.toLowerCase();
    if (!OPTIONS.has(key)) return name;
    if (key === 'authmechanism' && !MECHANISMS.has(value.toLowerCase())) return name;
  }
  return null;
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** One `host[:port]` of the host list, or null when it isn't one. */
function hostOf(text: string, srv: boolean): { host: string; port: number } | null {
  let host: string;
  let port: string | undefined;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) return null;
    port = rest === '' ? undefined : rest.slice(1);
    if (isIP(host) !== 6) return null;
  } else {
    const colon = text.lastIndexOf(':');
    host = colon < 0 ? text : text.slice(0, colon);
    port = colon < 0 ? undefined : text.slice(colon + 1);
    // An IPv6 address goes in brackets, or its colons read as a port.
    if (host.includes(':')) return null;
  }
  // A socket file is a path on the server's own machine, which a source never reaches.  Any other
  // character would let the driver read a different host than the one checked here.
  if (!isHost(host)) return null;
  if (port !== undefined && (srv || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535))
    return null;
  return { host: plainHost(host), port: port === undefined ? MONGODB_DEFAULT_PORT : Number(port) };
}

/** Reads a connection string, or null when it isn't one a source can use. */
export function parseConnectionString(input: string): MongoAddress | null {
  const text = input.trim();
  const scheme = SCHEME.exec(text);
  if (!scheme) return null;
  const srv = scheme[1]!.toLowerCase() === 'mongodb+srv';
  const start = scheme[0].length;
  const rest = text.slice(start);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? null : authority.slice(0, at);
  const hostText = at < 0 ? authority : authority.slice(at + 1);
  let user: string | null = null;
  let password: string | null = null;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(':');
    user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
    password = colon < 0 ? null : decode(userinfo.slice(colon + 1));
    if (user === null || user === '' || (colon >= 0 && password === null)) return null;
  }
  const hosts = hostText.split(',').map((part) => hostOf(part, srv));
  if (hosts.length === 0 || hosts.some((host) => host === null)) return null;
  if (srv && hosts.length !== 1) return null;
  const tail = authorityEnd < 0 ? '' : rest.slice(authorityEnd);
  const question = tail.indexOf('?');
  const path = question < 0 ? tail : tail.slice(0, question);
  const query = question < 0 ? '' : tail.slice(question + 1);
  const database = path.startsWith('/') && path.length > 1 ? decode(path.slice(1)) : null;
  if (path.length > 1 && (database === null || database.includes('/'))) return null;
  if (refusedOption(text) !== null) return null;
  const hostStart = start + (at < 0 ? 0 : at + 1);
  return {
    srv,
    hosts: hosts as Array<{ host: string; port: number }>,
    user,
    password,
    database,
    options: new URLSearchParams(query),
    hostSpan: [hostStart, hostStart + hostText.length],
  };
}

/** Whether a connection string asks for a secure connection itself. */
export function asksForTls(address: MongoAddress): boolean {
  if (address.srv) return address.options.get('tls') !== 'false' && address.options.get('ssl') !== 'false';
  return address.options.get('tls') === 'true' || address.options.get('ssl') === 'true';
}

/** A host as an address writes it, with an IPv6 address in brackets. */
export function hostText(host: string, port?: number): string {
  const name = isIP(host) === 6 ? `[${host}]` : host;
  return port === undefined ? name : `${name}:${port}`;
}

/**
 * The connection string with one host in place of its host list, for an SSH tunnel.  A tunnel
 * reaches one server, so a string naming several, or one found through DNS, can't use one.
 */
export function throughTunnel(input: string, address: MongoAddress, host: string, port: number): string {
  const text = input.trim();
  const [from, to] = address.hostSpan;
  return `mongodb://${text.slice(SCHEME.exec(text)![0].length, from)}${hostText(host, port)}${text.slice(to)}`;
}
