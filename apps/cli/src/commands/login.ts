import { message } from '../messages.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DATA_SCOPES,
  RioApiError,
  apiResource,
  authorizationCallback,
  authorizationServerMetadata,
  authorizationUrl,
  createPkceChallenge,
  exchangeAuthorizationCode,
  type TokenScope,
} from '@riosoma/sdk';
import { splitList, type Args } from '../args.js';
import {
  describeProfile,
  loadProfile,
  profileName,
  removeProfile,
  saveProfile,
  type StoredProfile,
} from '../credentials.js';
import { counted } from '../format.js';
import { Failure, UsageError, type Io } from '../io.js';
import { GLOBAL_FLAGS, session } from '../context.js';

/**
 * Signing in, and signing out.
 *
 * A personal access token is the way most people start: make one in the app's settings and give it
 * here.  A browser sign-in is the way that never puts a long-lived secret in a shell's history: the
 * tool listens on a loopback address, sends the person to their server to approve, and takes the
 * tokens the approval produces.  That needs an OAuth app an owner registered, public, with a
 * redirect address of `http://127.0.0.1/callback`, since only an app the server trusts may ask for
 * tokens for its REST API.  The port the tool takes is its own, which the server allows for a
 * public app's loopback address.
 */

export const LOGIN_FLAGS = {
  ...GLOBAL_FLAGS,
  browser: { help: message('cli.login.signInWithOauthInABrowser') },
  'client-id': { value: true, help: message('cli.login.theOauthAppToSignInWith') },
  scopes: { value: true, help: message('cli.login.theScopesToAskForCommaSeparated') },
  wait: { value: true, help: message('cli.login.howManySecondsToWaitForThe') },
  'no-open': { help: message('cli.login.printTheAddressButDonTTry') },
  check: { help: message('cli.login.withNoTokenGivenTryTheStored') },
} as const;

export const LOGOUT_FLAGS = {
  profile: GLOBAL_FLAGS.profile,
  json: GLOBAL_FLAGS.json,
  all: { help: message('cli.login.forgetEveryStoredCredentialNotJustThis') },
} as const;

/**
 * Stores a credential, or, with nothing to store, says what this profile holds.  Signing in with a
 * token checks it first, so a mistyped one is a refusal here rather than a failure later.
 */
export async function login(args: Args, io: Io): Promise<void> {
  const profile = profileName(io, args.string('profile'));
  const stored = await loadProfile(io, profile);
  const url = args.string('url') ?? io.env.RIOSOMA_URL ?? stored?.url;
  const token = args.string('token') ?? (args.boolean('browser') ? undefined : io.env.RIOSOMA_TOKEN);
  if (!token && !args.boolean('browser')) return showStored(args, io, profile, stored);
  if (!url) throw new UsageError(message('cli.login.sayWhichServerToSignInTo'));
  if (token) {
    const { client } = await session(args, io);
    const databases = await client.databases.list();
    const where = await saveProfile(io, profile, {
      url,
      kind: 'token',
      token,
      person: personOf(io),
      savedAt: new Date(io.now?.() ?? Date.now()).toISOString(),
    });
    io.print(message('cli.login.signedInToWithAPersonalAccess', { url: url }));
    report(io, message('cli.login.storedInAs', { value1: where.where, profile: profile }));
    report(io, message('cli.login.reachableWithIt', { value1: counted(databases.length, 'database') }));
    return;
  }
  await browserLogin(args, io, url, profile, stored);
}

/** What a profile holds, with no secret in it, and whether it still works. */
async function showStored(args: Args, io: Io, profile: string, stored: StoredProfile | null): Promise<void> {
  if (!stored) {
    io.print(message('cli.login.nothingIsStoredForRunRiosomaLogin', { profile: profile }));
    return;
  }
  io.print(message('cli.login.holds', { profile: profile, value2: describeProfile(stored) }));
  io.print(message('cli.login.storedOn', { value1: stored.savedAt }));
  if (stored.kind === 'oauth' && stored.expiresAt)
    io.print(
      stored.expiresAt > (io.now?.() ?? Date.now())
        ? message('cli.login.theAccessTokenRunsOutOn', { value1: new Date(stored.expiresAt).toISOString() })
        : message('cli.login.theAccessTokenHasRunOutAnd'),
    );
  if (!args.boolean('check')) return;
  try {
    const { client } = await session(args, io);
    io.print(
      message('cli.login.itReaches', { value1: counted((await client.databases.list()).length, 'database') }),
    );
  } catch (error) {
    if (error instanceof RioApiError)
      io.print(message('cli.login.itDoesnTWorkAnyMore', { value1: error.message }));
    else throw error;
  }
}

async function browserLogin(
  args: Args,
  io: Io,
  url: string,
  profile: string,
  stored: StoredProfile | null,
): Promise<void> {
  const clientId = args.string('client-id') ?? io.env.RIOSOMA_CLIENT_ID ?? stored?.clientId;
  if (!clientId)
    throw new Failure(message('cli.login.aBrowserSignInNeedsTheId'), {
      hint: message('cli.login.theAppExplainsThisInItsRegistering'),
    });
  const asked = splitList(args.string('scopes'));
  const scopes: readonly TokenScope[] | string = asked.length ? asked.join(' ') : DATA_SCOPES;
  const metadata = await authorizationServerMetadata(url, {
    ...(io.fetch ? { fetchImpl: io.fetch } : {}),
  });
  const pkce = await createPkceChallenge();
  const listener = await listenForCallback();
  const address = authorizationUrl({
    baseUrl: url,
    authorizationEndpoint: metadata.authorization_endpoint,
    clientId,
    redirectUri: listener.redirectUri,
    scopes,
    state: pkce.state,
    challenge: pkce.challenge,
  });
  const askedFor = Number(args.string('wait') ?? 300);
  const seconds = Number.isFinite(askedFor) && askedFor > 0 ? askedFor : 300;
  io.print(message('cli.login.openThisAddressToSignIn'));
  io.print('');
  io.print(`  ${address}`);
  io.print('');
  try {
    const opened = args.boolean('no-open') ? false : await io.open?.(address);
    if (opened) io.warn(message('cli.login.aBrowserShouldHaveOpenedApproveThe'));
    else io.warn(message('cli.login.noBrowserOpenedCopyTheAddressAbove'));
    io.warn(message('cli.login.waitingUpToSecondsForTheApproval', { seconds: seconds }));
    const callback = await listener.wait(seconds * 1_000);
    if (callback.state !== pkce.state)
      throw new Failure(message('cli.login.theRedirectCarriedAStateThisTool'));
    if (!callback.code)
      throw new Failure(
        callback.error
          ? message('cli.login.theServerRefusedTheSignIn', { value1: callback.error.replaceAll('_', ' ') })
          : message('cli.login.theRedirectCarriedNoCode'),
      );
    const tokens = await exchangeAuthorizationCode({
      baseUrl: url,
      tokenEndpoint: metadata.token_endpoint,
      clientId,
      code: callback.code,
      codeVerifier: pkce.verifier,
      redirectUri: listener.redirectUri,
      resource: apiResource(metadata.issuer),
    });
    const now = io.now?.() ?? Date.now();
    const where = await saveProfile(io, profile, {
      url,
      kind: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      clientId,
      expiresAt: now + Number(tokens.expires_in || 0) * 1_000,
      scopes: tokens.scope ? tokens.scope.split(' ') : asked,
      person: personOf(io),
      savedAt: new Date(now).toISOString(),
    });
    io.print(message('cli.login.signedIn'));
    report(io, message('cli.login.storedInAs', { value1: where.where, profile: profile }));
    report(io, message('cli.login.scopes', { value1: tokens.scope || asked.join(' ') }));
    if (tokens.refresh_token) report(io, message('cli.login.theAccessTokenWillBeReplacedWith'));
  } finally {
    await listener.close();
  }
}

function personOf(io: Io): string | undefined {
  return io.env.USER ?? io.env.USERNAME ?? undefined;
}

/** A line the tool prints unless the run asked for JSON only. */
function report(io: Io, text: string): void {
  if (!io.json) io.print(text);
}

/** What the loopback listener heard back from the browser. */
interface Callback {
  redirectUri: string;
  wait(ms: number): Promise<ReturnType<typeof authorizationCallback>>;
  close(): Promise<void>;
}

const PAGE = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${escapeHtml(message('cli.login.pageTitle'))}</title></head>`,
  '<body><main>',
  `<h1>${escapeHtml(message('cli.login.pageHeading'))}</h1>`,
  `<p>${escapeHtml(message('cli.login.pageBody'))}</p>`,
  '</main></body></html>',
].join('');

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Listens on a loopback address for the one redirect a browser sign-in ends with.  The address is
 * on this machine only, and the listener closes as soon as it has heard back or given up.
 */
async function listenForCallback(): Promise<Callback> {
  let settle: (value: ReturnType<typeof authorizationCallback>) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const heard = new Promise<ReturnType<typeof authorizationCallback>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A browser that never arrives would leave this waiting, so nothing may hold on to it.
  heard.catch(() => undefined);
  const listener: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(PAGE);
    settle(authorizationCallback(url));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (listener.address() as AddressInfo).port;
  let timer: NodeJS.Timeout | undefined;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    async wait(ms: number) {
      try {
        return await new Promise<ReturnType<typeof authorizationCallback>>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Failure(message('cli.login.noApprovalArrivedInTimeRunThe'))),
            ms,
          );
          heard.then(resolve, reject);
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async close() {
      if (timer) clearTimeout(timer);
      fail(new Failure(message('cli.login.theSignInEndedBeforeTheBrowser')));
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

/** Forgets a stored credential, which is the profile this run means unless it was asked for all. */
export async function logout(args: Args, io: Io): Promise<void> {
  const name = args.boolean('all') ? null : profileName(io, args.string('profile'));
  const removed = await removeProfile(io, name);
  if (!removed) {
    io.print(
      name
        ? message('cli.login.nothingWasStoredFor', { name: name })
        : message('cli.login.noCredentialsAreStored'),
    );
    return;
  }
  io.print(
    name
      ? message('cli.login.forgotTheCredentialStoredFor', { name: name })
      : message('cli.login.forgotEveryStoredCredential'),
  );
}
