import { IntegrationError, type Catalog } from '../../../packages/ui/src/integrations/messages';
import { matchLocale } from '../../../packages/i18n/src/locales';
import {
  secureOrigin,
  segment,
  textTypes,
  writable,
  type Table,
  type RecordsPage,
} from '../../shared/schema';
import { clipperLoopback, originPattern, type Target } from './manifest';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}
export interface Session {
  /** The address that issued these tokens.  They're never sent anywhere else. */
  origin: string;
  clientId: string;
  tokens: Tokens;
  expiresAt: number;
}
export interface Store {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface HostAccess {
  contains(permissions: { origins: string[] }): Promise<boolean>;
}
export interface Identity {
  getRedirectURL(): string;
  launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined>;
}
export interface PageClip {
  title: string;
  url: string;
  selection: string;
}
export interface Mapping {
  title: string;
  url: string;
  selection: string;
  screenshot: string;
}
export interface Destination {
  database: string;
  table: string;
  mapping: Mapping;
}
export interface ApiCall {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  screenshot?: string;
}
const scopes = 'schema.bases:read data.records:read data.records:write';
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export async function proofKey() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  return { verifier, state, challenge };
}

export function callbackCode(callback: string, redirect: string, state: string, issuer: string): string {
  const url = new URL(callback);
  const target = new URL(redirect);
  const query = url.searchParams;
  if (
    url.origin !== target.origin ||
    url.pathname !== target.pathname ||
    url.hash ||
    query.has('error') ||
    query.getAll('state').length !== 1 ||
    query.get('state') !== state ||
    query.getAll('iss').length !== 1 ||
    query.get('iss') !== issuer ||
    query.getAll('code').length !== 1 ||
    !query.get('code')
  )
    throw new IntegrationError('clipper.authFailed');
  return query.get('code')!;
}

/** The shared address rules, with plain HTTP allowed only on the clipper's own loopback address. */
export function clipperOrigin(value: string): string {
  const origin = secureOrigin(value.trim());
  const url = new URL(origin);
  if (url.protocol === 'http:' && !clipperLoopback.includes(url.hostname))
    throw new IntegrationError('integration.secureOrigin');
  return origin;
}

export class Connection {
  private refresh: Promise<Session> | undefined;
  private signingIn = false;
  /**
   * `settings` holds the address the person chose, and `store` holds the session.  The address is
   * read and checked on every use, so one build of the extension serves any Riosoma server.
   */
  constructor(
    private settings: Store,
    private store: Store,
    private identity: Identity,
    private hosts: HostAccess,
    private target: Target,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** The chosen address, once the person has granted the extension access to it. */
  async origin(): Promise<string> {
    const stored = (await this.settings.get('origin')).origin;
    if (typeof stored !== 'string') throw new IntegrationError('integration.secureOrigin');
    const origin = clipperOrigin(stored);
    if (!(await this.hosts.contains({ origins: [originPattern(origin, this.target)] })))
      throw new IntegrationError('clipper.permissionDenied');
    return origin;
  }

  private async tokens(origin: string, fields: Record<string, string>): Promise<Tokens> {
    const response = await this.fetcher(`${origin}/oauth/token`, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      body: new URLSearchParams(fields),
    });
    if (!response.ok) throw new IntegrationError('integration.signInAgain');
    const tokens = (await response.json()) as Tokens;
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      throw new IntegrationError('clipper.authFailed');
    return tokens;
  }

  async signIn(clientId: string): Promise<void> {
    if (!clientId.trim() || this.signingIn) throw new IntegrationError('clipper.authFailed');
    this.signingIn = true;
    try {
      const origin = await this.origin();
      const proof = await proofKey();
      const redirect = this.identity.getRedirectURL();
      const url = new URL(`${origin}/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId.trim(),
        redirect_uri: redirect,
        response_type: 'code',
        scope: scopes,
        resource: `${origin}/api/v1`,
        state: proof.state,
        code_challenge: proof.challenge,
        code_challenge_method: 'S256',
      }).toString();
      const callback = await this.identity.launchWebAuthFlow({ url: url.href, interactive: true });
      if (!callback) throw new IntegrationError('clipper.authFailed');
      const code = callbackCode(callback, redirect, proof.state, origin);
      const tokens = await this.tokens(origin, {
        grant_type: 'authorization_code',
        client_id: clientId.trim(),
        redirect_uri: redirect,
        code,
        code_verifier: proof.verifier,
        resource: `${origin}/api/v1`,
      });
      await this.store.set({
        session: {
          origin,
          clientId: clientId.trim(),
          tokens,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        },
      });
    } finally {
      this.signingIn = false;
    }
  }

  private async stored(): Promise<Session | undefined> {
    return (await this.store.get('session')).session as Session | undefined;
  }

  /** The session, only while it belongs to the address currently chosen. */
  async session(): Promise<Session | undefined> {
    const current = await this.stored();
    if (!current) return undefined;
    if (current.origin === (await this.settings.get('origin')).origin) return current;
    await this.store.remove('session');
    return undefined;
  }

  private async access(): Promise<Session> {
    const current = await this.session();
    if (!current) throw new IntegrationError('integration.signInAgain');
    if (current.expiresAt > Date.now() + 60_000) return current;
    if (!this.refresh) {
      this.refresh = (async () => {
        try {
          const tokens = await this.tokens(current.origin, {
            grant_type: 'refresh_token',
            client_id: current.clientId,
            refresh_token: current.tokens.refresh_token,
          });
          const next = { ...current, tokens, expiresAt: Date.now() + tokens.expires_in * 1000 };
          await this.store.set({ session: next });
          return next;
        } catch (error) {
          await this.store.remove('session');
          throw error;
        }
      })().finally(() => {
        this.refresh = undefined;
      });
    }
    return this.refresh;
  }

  async signOut(): Promise<void> {
    if (this.refresh) await this.refresh.catch(() => undefined);
    // The grant is revoked where it was issued, even if the chosen address has changed since.
    const current = await this.stored();
    try {
      if (current) {
        const response = await this.fetcher(`${current.origin}/oauth/revoke`, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          body: new URLSearchParams({ client_id: current.clientId, token: current.tokens.refresh_token }),
        });
        if (!response.ok) throw new IntegrationError('integration.failed');
      }
    } finally {
      await this.store.remove('session');
    }
  }

  async api(call: ApiCall): Promise<unknown> {
    const method = call.method ?? 'GET';
    const read = /^\/databases(?:\/[A-Za-z0-9_-]+\/tables)?$/.test(call.path) && method === 'GET';
    const write =
      /^\/tables\/[A-Za-z0-9_-]+\/records\?shape=airtable&fieldKey=id$/.test(call.path) && method === 'POST';
    const upload =
      /^\/tables\/[A-Za-z0-9_-]+\/fields\/[A-Za-z0-9_-]+\/files$/.test(call.path) && method === 'POST';
    if (!read && !write && !upload) throw new IntegrationError('integration.invalid');
    const current = await this.access();
    let body: BodyInit | undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${current.tokens.access_token}`,
      Accept: 'application/json',
    };
    if (upload) {
      if (
        !call.screenshot ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(call.screenshot) ||
        call.screenshot.length > 14_000_000
      )
        throw new IntegrationError('integration.invalid');
      body = Uint8Array.from(atob(call.screenshot.split(',')[1]!), (character) => character.charCodeAt(0));
      headers['Content-Type'] = 'image/png';
      headers['X-File-Name'] = 'page.png';
    } else if (call.body !== undefined) {
      body = JSON.stringify(call.body);
      headers['Content-Type'] = 'application/json';
    }
    const response = await this.fetcher(`${current.origin}/api/v1${call.path}`, {
      method,
      headers,
      body,
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) await this.store.remove('session');
      throw new IntegrationError(response.status === 401 ? 'integration.signInAgain' : 'integration.failed');
    }
    return response.json();
  }
}

export function clipFields(
  table: Table,
  mapping: Mapping,
  clip: PageClip,
  screenshot: boolean,
): Record<string, unknown> {
  const chosen = [mapping.title, mapping.url, mapping.selection, ...(screenshot ? [mapping.screenshot] : [])];
  if (chosen.some((id) => !id) || new Set(chosen).size !== chosen.length)
    throw new IntegrationError('integration.invalid');
  for (const [index, id] of chosen.entries()) {
    const field = table.fields.find((candidate) => candidate.id === id);
    if (
      !field ||
      !writable(field) ||
      (index === 3 ? field.type !== 'attachment' : !textTypes.has(field.type))
    )
      throw new IntegrationError('integration.invalid');
  }
  const url = new URL(clip.url);
  if (!['https:', 'http:'].includes(url.protocol)) throw new IntegrationError('clipper.captureFailed');
  return { [mapping.title]: clip.title, [mapping.url]: clip.url, [mapping.selection]: clip.selection };
}

export async function saveClip(
  api: (call: ApiCall) => Promise<unknown>,
  destination: Destination,
  table: Table,
  clip: PageClip,
  screenshot?: string,
): Promise<string> {
  if (table.id !== destination.table) throw new IntegrationError('integration.invalid');
  const fields = clipFields(table, destination.mapping, clip, Boolean(screenshot));
  if (screenshot) {
    const file = (await api({
      path: `/tables/${segment(table.id)}/fields/${segment(destination.mapping.screenshot)}/files`,
      method: 'POST',
      screenshot,
    })) as { id: string };
    fields[destination.mapping.screenshot] = [segment(file.id)];
  }
  const result = (await api({
    path: `/tables/${segment(table.id)}/records?shape=airtable&fieldKey=id`,
    method: 'POST',
    body: { fieldKey: 'id', records: [{ fields }] },
  })) as RecordsPage;
  if (!result.records[0]) throw new IntegrationError('integration.failed');
  return result.records[0].id;
}

export function destinationHash(destination: Destination): string {
  return `#clip?${new URLSearchParams({ database: destination.database, table: destination.table, ...destination.mapping })}`;
}
export function readDestination(hash: string): Destination {
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const get = (key: string) => query.get(key) ?? '';
  return {
    database: get('database'),
    table: get('table'),
    mapping: {
      title: get('title'),
      url: get('url'),
      selection: get('selection'),
      screenshot: get('screenshot'),
    },
  };
}

/** The catalog for the browser's language, or American English when the build has none for it. */
export function chooseCatalog(
  uiLanguage: string,
  catalogs: Record<string, Catalog>,
): { language: string; catalog: Catalog | undefined } {
  const requested = matchLocale([uiLanguage]);
  const language = catalogs[requested] ? requested : 'en-US';
  return { language, catalog: catalogs[language] };
}
