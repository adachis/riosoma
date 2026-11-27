import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { holdPort, startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, OWNER, signIn, visit } from '../helpers';
import { invite, mailTo, waitForMail } from '../people';
import { rows } from '../sql';
import { freePort, SETUP_TOKEN, startStack } from '../stack';
import {
  TestAuthenticator,
  type CreationOptions,
  type RequestOptions,
} from '../../server/src/test/authenticator';

test.use({ serviceWorkers: 'block' });

test('first run explains database failures and resumes setup after reload and Back', async ({ page }) => {
  test.setTimeout(180_000);
  const password = randomBytes(24).toString('base64url');
  const ownerPassword = randomBytes(768).toString('base64url');
  const ownerEmail = `${randomBytes(8).toString('hex')}@example.test`;
  const postgres = await startTestPostgres({ password });
  const database = await postgres.createDatabase('qa_setup_sign_in');
  const installation = await startStack({ database: false });
  try {
    const url = installation.baseURL;
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, `${url}/setup#token=${SETUP_TOKEN}`);
    await expect(page.getByRole('heading', { name: 'Connect a database' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Connect a database' })).toBeVisible();
    const profile = database.profile;
    const host = page.getByLabel('Server address');
    const port = page.getByRole('textbox', { name: 'Port', exact: true });
    const name = page.getByLabel('Database name');
    const user = page.getByLabel('User name');
    const secret = page.getByLabel('Password', { exact: true });
    await host.fill(`${randomBytes(8).toString('hex')}.invalid`);
    await port.fill(String(profile.port));
    await name.fill(profile.database);
    await user.fill(profile.user);
    await secret.fill(password);
    const check = page.getByRole('button', { name: 'Check connection' });
    const report = page.getByRole('list', { name: 'Connection check' });
    await check.click();
    await expect(report).toContainText('Check the host name for typos');
    await host.fill(profile.host);
    await port.fill(String(await freePort()));
    await page.getByRole('button', { name: 'Connect and continue' }).click();
    await expect(report).toContainText('Check the port number');
    await port.fill(String(profile.port));
    await check.click();
    await expect(report).toContainText('Signed in to the database.');
    await expect(report).not.toContainText('Check the port number');

    await secret.fill(randomBytes(24).toString('hex'));
    await check.click();
    await expect(report).toContainText('Check the user name and password.');
    await secret.fill(password);
    await name.fill(randomBytes(12).toString('hex'));
    await check.click();
    await expect(report).toContainText('Create the database first, or check its name.');
    await name.fill(profile.database);
    await page.getByRole('button', { name: 'Encryption' }).click();
    await page.getByRole('option', { name: 'Always encrypt', exact: true }).click();
    await check.click();
    await expect(report).toContainText('The server doesn’t support encrypted connections.');
    await page.getByRole('button', { name: 'Encryption' }).click();
    await page.getByRole('option', { name: 'Encrypt when the server offers it' }).click();

    const load = createRequire(import.meta.resolve('@riosoma/testkit'));
    const { Client } = load('pg') as {
      Client: new (options: { connectionString: string }) => {
        connect(): Promise<void>;
        query(text: string, values?: unknown[]): Promise<unknown>;
        end(): Promise<void>;
      };
    };
    const client = new Client({ connectionString: database.url });
    const restricted = `qa_${randomBytes(6).toString('hex')}`;
    await client.connect();
    try {
      await client.query(`CREATE ROLE "${restricted}" LOGIN`);
      await client
        .query("SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS statement", [
          restricted,
          password,
        ])
        .then(async (result) => {
          const statement = (result as { rows: Array<{ statement: string }> }).rows[0]!.statement;
          await client.query(statement);
        });
      await user.fill(restricted);
      await check.click();
      await expect(report).toContainText('Let this account create schemas');
    } finally {
      await client.end();
    }
    await user.fill(profile.user);
    await host.fill(' ');
    await check.click();
    await expect(host).toHaveAttribute('aria-invalid', 'true');
    await host.fill(profile.host);
    await expect(host).not.toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'Connect and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
    const org = `資料 📚 مكتبة ${randomBytes(4).toString('hex')}`;
    await page.getByLabel('Organization name').fill('長'.repeat(121));
    await page.getByLabel('Your name').fill('管理者 📚 مالك');
    await page.getByLabel('Email address').fill(ownerEmail);
    await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page.getByLabel('Organization name')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Organization name').fill(org);
    await page.getByLabel('Organization name').press('Enter');
    await page.getByRole('button', { name: 'Don’t send usage counts' }).click();
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
    await visit(page, `${url}/setup#token=${SETUP_TOKEN}`);
    await expect(page).toHaveURL(`${url}/`);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Email address').fill(ownerEmail);
    await page.getByLabel('Password', { exact: true }).focus();
    await page.keyboard.insertText(ownerPassword);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await installation.stop();
    await database.drop();
    await postgres.stop();
  }
});

async function requestLink(page: Page, next: string) {
  const before = new Set(mailTo(OWNER.email).map((message) => message.text));
  await visit(page, `${base()}/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.getByRole('button', { name: 'Send link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  // Security notices can arrive too, so only a new sign-in link completes this request.
  const mail = await waitForMail(
    (message) =>
      message.to.includes(OWNER.email) &&
      !before.has(message.text) &&
      /https?:\/\/\S+\/sign-in\/link[^\s]*/.test(message.text),
    'the requested sign-in link',
  );
  const link = mail.text.match(/https?:\/\/\S+\/sign-in\/link[^\s]*/)?.[0];
  expect(link).toBeTruthy();
  return link!;
}

test('an emailed sign-in preserves a deep link in another browser and refuses reuse', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const next = '/settings/appearance?theme=nature#colors';
  const link = await requestLink(page, next);
  const other = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  try {
    const opened = await other.newPage();
    await visit(opened, link);
    await expect(opened).toHaveURL(`${base()}${next}`);
    expect(await opened.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await visit(page, link);
    await expect(page.getByRole('heading', { name: 'That link didn’t work' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('expired or was already used');
    expect(new URL(page.url()).hash).toBe('');
  } finally {
    await other.close();
  }
});

test('session expiry keeps a half-filled form after signing back in by keyboard', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New database', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'New database', exact: true });
  const name = `資料 📚 مكتبة ${randomBytes(4).toString('hex')}`;
  await draft.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  // Only this browser's session expires, as it would after its idle deadline.
  const cookie = (await page.context().cookies()).find((item) => item.name === 'rio_session');
  expect(cookie).toBeTruthy();
  await rows(
    "UPDATE rio_app.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
    [createHash('sha256').update(cookie!.value).digest('hex')],
  );
  await draft.getByRole('button', { name: 'Create', exact: true }).click();
  const reauthenticate = page.getByRole('dialog', { name: 'Sign in again' });
  await expect(reauthenticate).toBeVisible();
  await reauthenticate.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await reauthenticate.getByLabel('Password', { exact: true }).press('Enter');
  await expect(reauthenticate).toBeHidden();
  await expect(draft.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
  await draft.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(draft).toBeHidden();
  const stored = await rows<{ name: string }>('SELECT name FROM rio_app.databases WHERE name = $1', [name]);
  expect(stored).toEqual([{ name }]);
});

test('password sign-in refuses external return addresses', async ({ page }) => {
  await signIn(page);
  for (const next of ['https://example.test', '//example.test', '/\\example.test', '/\texample.test']) {
    await page.context().clearCookies();
    await visit(page, `${base()}/sign-in?next=${encodeURIComponent(next)}`);
    await page.getByLabel('Email address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await page.getByLabel('Password', { exact: true }).press('Enter');
    await expect(page).toHaveURL(`${base()}/`);
  }
});

test('a session refetch clears a private draft before adopting another person', async ({ page, browser }) => {
  await signIn(page);
  const member = await invite(page, browser, 'Session Member');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'New database', exact: true }).click();
    const draft = page.getByRole('dialog', { name: 'New database', exact: true });
    const name = `Private draft ${randomBytes(8).toString('hex')}`;
    await draft.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    const document = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      Reflect.set(window, 'sessionDocument', marker);
      return marker;
    });
    const cookie = (await page.context().cookies()).find((item) => item.name === 'rio_session')!;
    await rows(
      "UPDATE rio_app.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
      [createHash('sha256').update(cookie.value).digest('hex')],
    );
    await draft.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sign in again' })).toBeVisible();
    const memberCookie = (await member.context.cookies()).find((item) => item.name === 'rio_session')!;
    await page.context().addCookies([memberCookie]);
    // Expiration removes the old socket, so trigger its organization listener independently.
    await page.evaluate(() => window.dispatchEvent(new Event('organizationChanged')));
    await page.waitForFunction((marker) => Reflect.get(window, 'sessionDocument') !== marker, document, {
      timeout: 5_000,
    });
    await expect(draft).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    expect((await (await page.request.get(`${base()}/api/auth/session`)).json()).user.id).toBe(member.id);
    expect(
      await page
        .locator('input')
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
    ).not.toContain(name);
  } finally {
    await member.context.close();
  }
});

test('an expired grid save signs back in, preserves the edit, and waits for a keyboard retry', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const database = await createDatabase(page, 'Session recovery', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  const grid = await openTable(page, database, 'Records');
  const document = await page.evaluate(() => {
    const marker = crypto.randomUUID();
    Reflect.set(window, 'sessionDocument', marker);
    return marker;
  });
  const cookie = (await page.context().cookies()).find((item) => item.name === 'rio_session')!;
  let expire = true;
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    if (expire) {
      expire = false;
      // Expire at dispatch so background reads cannot open sign-in before the tested edit.
      await rows(
        "UPDATE rio_app.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
        [createHash('sha256').update(cookie.value).digest('hex')],
      );
    }
    await route.continue();
  });
  let commands = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/commands')) commands++;
  });
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
  const input = page.locator('.rio-grid__input');
  const value = 'Retained 東京 📚 مرحبا';
  await input.fill(value);
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Sign in again' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await dialog.getByLabel('Password', { exact: true }).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: value, exact: true })).toBeVisible();
  expect(commands).toBe(1);
  const retry = page.getByRole('button', { name: 'Retry unsaved changes', exact: true });
  await retry.focus();
  const saved = page.waitForResponse((response) => response.url().endsWith('/commands') && response.ok());
  await page.keyboard.press('Enter');
  await saved;
  await expect(retry).toBeHidden();
  expect(await page.evaluate(() => Reflect.get(window, 'sessionDocument'))).toBe(document);
  await grid.getByRole('gridcell', { name: value, exact: true }).dblclick();
  await input.fill('Next edit');
  const next = page.waitForResponse((response) => response.url().endsWith('/commands') && response.ok());
  await input.press('Enter');
  await next;
  await page.reload();
  await expect(grid.getByRole('gridcell', { name: 'Next edit', exact: true })).toBeVisible();
});

test('wrong passwords, long input, and lockout have recoverable messages at phone width', async ({
  page,
}) => {
  await signIn(page);
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('密碼 📚 كلمة مرور'.repeat(150));
  await password.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('This is too long.', { exact: true })).toBeVisible();
  for (let attempt = 0; attempt < 10; attempt++) {
    await password.fill(randomBytes(24).toString('base64url'));
    const response = page.waitForResponse((res) => res.url().endsWith('/api/auth/sign-in'));
    await password.press('Enter');
    expect((await response).status()).toBe(401);
    await expect(page.getByRole('alert')).toContainText('don’t match');
  }
  await password.fill(OWNER.password);
  await password.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Too many wrong passwords.');
  await expect(page.getByRole('alert')).toContainText('15 minutes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const link = await requestLink(page, '/settings/security');
  await visit(page, link);
  await expect(page).toHaveURL(`${base()}/settings/security`);
});

test('expired emailed links explain how to recover without exposing their token', async ({ page }) => {
  await signIn(page);
  const link = await requestLink(page, '/settings/appearance');
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token')!;
  await rows(
    "UPDATE rio_app.login_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
    [createHash('sha256').update(token).digest('hex')],
  );
  await visit(page, link);
  await expect(page.getByRole('alert')).toContainText('expired or was already used');
  await page.getByRole('link', { name: 'Go to sign-in' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp('/sign-in\\?next='));
});

test('authenticator enrollment, wrong codes, recovery codes, and emailed second steps work by keyboard', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/settings/security`);
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up an authenticator app' });
  const secret = (await dialog.getByLabel('Setup key').textContent())!.replace(/\s/g, '');
  const load = createRequire(new URL('../../server/package.json', import.meta.url));
  const { generate } = load('otplib') as {
    generate(options: { secret: string; epoch?: number }): Promise<string>;
  };
  const code = await generate({ secret });
  await dialog.getByLabel('Code from the app').fill(code === '000000' ? '111111' : '000000');
  await dialog.getByLabel('Code from the app').press('Enter');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Code from the app').fill(code);
  await dialog.getByLabel('Code from the app').press('Enter');
  const recovery = page.getByRole('dialog', { name: 'Your recovery codes' });
  await expect(recovery.getByRole('list', { name: 'Recovery codes' }).locator('code')).toHaveCount(10);
  const codes = await recovery
    .getByRole('list', { name: 'Recovery codes' })
    .locator('code')
    .allTextContents();
  expect(codes).toHaveLength(10);
  await recovery.getByRole('button', { name: 'Done', exact: true }).click();
  const link = await requestLink(page, '/settings/appearance?theme=nature');
  await visit(page, link);
  await expect(page.getByRole('heading', { name: 'One more step' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code', { exact: true }).fill(codes[0]!);
  await page.getByLabel('Recovery code', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${base()}/settings/appearance?theme=nature`);
  await page.context().clearCookies();
  await visit(page, `${base()}/sign-in`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await page.getByLabel('Code from your authenticator app').fill(code === '000000' ? '111111' : '000000');
  await page.getByLabel('Code from your authenticator app').press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await page
    .getByLabel('Code from your authenticator app')
    .fill(await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }));
  await page.getByLabel('Code from your authenticator app').press('Enter');
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  await visit(page, `${base()}/settings/security`);
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  const off = page.getByRole('dialog', { name: 'Turn off the authenticator app?' });
  await off.getByRole('radio', { name: 'Recovery code', exact: true }).click();
  await off.getByLabel('Recovery code', { exact: true }).fill(codes[1]!);
  await off.getByLabel('Recovery code', { exact: true }).press('Enter');
  await expect(off).toBeHidden();
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeVisible();
});

async function virtualAuthenticator(page: Page, origin: string) {
  // Conditional prompts stay dormant so the spec chooses the explicit sign-in button.
  await page.addInitScript(() => {
    if (window.PublicKeyCredential)
      Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', {
        value: async () => false,
      });
  });
  if (page.context().browser()!.browserType().name() === 'chromium') {
    const device = await page.context().newCDPSession(page);
    await device.send('WebAuthn.enable');
    const { authenticatorId } = await device.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return async () => {
      await device.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await device.detach();
    };
  }
  // Other engines get the same signed authenticator responses through their credential APIs.
  const authenticator = new TestAuthenticator(origin);
  await page.exposeFunction('registerCredential', (options: CreationOptions) =>
    authenticator.register(options),
  );
  await page.exposeFunction('answerCredential', (options: RequestOptions) => authenticator.answer(options));
  await page.addInitScript(() => {
    // Linux WebKit exposes a capability object, but the signed fixture needs a constructor.
    if (typeof window.PublicKeyCredential !== 'function')
      Object.defineProperty(window, 'PublicKeyCredential', {
        value: class PublicKeyCredential {
          static async isConditionalMediationAvailable() {
            return false;
          }
        },
        configurable: true,
      });
    const encode = (buffer: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buffer)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const decode = (text: string) =>
      Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
        character.charCodeAt(0),
      ).buffer;
    const credential = (data: {
      id: string;
      rawId: string;
      response: Record<string, string | string[]>;
    }) => ({
      ...data,
      rawId: decode(data.rawId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: Object.fromEntries(
        Object.entries(data.response).map(([key, value]) => [
          key,
          key === 'transports' ? value : decode(value as string),
        ]),
      ),
    });
    const bindings = window as unknown as {
      registerCredential(options: unknown): Promise<Parameters<typeof credential>[0]>;
      answerCredential(options: unknown): Promise<Parameters<typeof credential>[0]>;
    };
    Object.defineProperty(navigator, 'credentials', {
      value: {
        create: async ({
          publicKey,
        }: {
          publicKey: { challenge: ArrayBuffer; rp: unknown; user: { id: ArrayBuffer } };
        }) =>
          credential(
            await bindings.registerCredential({
              challenge: encode(publicKey.challenge),
              rp: publicKey.rp,
              user: { id: encode(publicKey.user.id) },
            }),
          ),
        get: async ({ publicKey }: { publicKey: { challenge: ArrayBuffer; rpId: string } }) =>
          credential(
            await bindings.answerCredential({ challenge: encode(publicKey.challenge), rpId: publicKey.rpId }),
          ),
      },
      configurable: true,
    });
  });
  return async () => undefined;
}

test('passkeys register, sign in, recover from a canceled prompt, and protect removal of the last key', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const postgres = await startTestPostgres();
  // A domain-based local installation exercises the same origin checks as a secure deployment.
  // The port stays held until the server listens on it, since anything could take it in between.
  const port = await holdPort();
  const origin = `http://localhost:${port.port}`;
  const fixtureUrl = new URL('../../server/dist/test/fixture.js', import.meta.url).href;
  const { startServer } = (await import(fixtureUrl)) as {
    startServer(
      postgres: TestPostgres,
      prefix: string,
      config: { baseUrl: string; webDir: string; themesDir: string },
    ): Promise<{
      app: { listen(options: { port: number; host: string }): Promise<unknown> };
      owner: { headers: { cookie: string } };
      close(): Promise<void>;
    }>;
  };
  const server = await startServer(postgres, 'qa_passkey', {
    baseUrl: origin,
    webDir: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    themesDir: fileURLToPath(new URL('../../../themes/', import.meta.url)),
  }).catch(async (error: unknown) => {
    await port.release();
    await postgres.stop();
    throw error;
  });
  let stop: () => Promise<void> = async () => undefined;
  try {
    await port.serve(server.app);
    stop = await virtualAuthenticator(page, origin);
    const cookie = server.owner.headers.cookie;
    await page
      .context()
      .addCookies([{ name: 'rio_session', value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, `${origin}/settings/security`);
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a passkey', exact: true });
    const name = `${'鍵'.repeat(45)} 📚 مفتاح`;
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await page.evaluate(() => {
      const original = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async () => {
        navigator.credentials.create = original;
        throw new DOMException('Closed', 'NotAllowedError');
      };
    });
    await dialog.getByLabel('Name', { exact: true }).press('Enter');
    await expect(dialog).toContainText('The passkey prompt closed before it finished.');
    await dialog.getByLabel('Name', { exact: true }).press('Enter');
    const recovery = page.getByRole('dialog', { name: 'Your recovery codes' });
    await expect(recovery.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(
      10,
    );
    await recovery.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await visit(page, `${origin}/sign-in?next=${encodeURIComponent('/settings/security')}`);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin}/settings/security`);
    await page.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
    const removing = page.getByRole('dialog', { name: `Remove ${name}?` });
    await expect(removing).toContainText('It’s your last second step');
    await removing.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(removing).toBeHidden();
    await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await stop();
    await server.close();
    await postgres.stop();
  }
});

async function openInvitation(page: Page, link: string) {
  const current = new URL(page.url());
  const destination = new URL(link);
  // Opening another invitation on this page changes the fragment without replacing the document.
  if (
    current.origin === destination.origin &&
    current.pathname === destination.pathname &&
    current.search === destination.search
  )
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, destination.hash);
  else await visit(page, link);
}

test('new, reused, expired, and revoked invitations explain their state at phone width', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const person = await invite(page, browser, 'Reader 新しい人 📚 شخص جديد One');
  try {
    await person.page.setViewportSize({ width: 390, height: 844 });
    const used = mailTo(person.email)[0]!.text.match(/https?:\/\/\S+\/join#token=[\w-]+/)![0];
    await openInvitation(person.page, used);
    // Invalid invitations explain revoked links along with expired and reused ones.
    await expect(person.page.getByRole('alert')).toHaveText(
      'This invitation link has expired, was revoked, or was already used.  Ask for a new one.',
    );
    const existingEmail = `${randomBytes(12).toString('hex')}@example.test`;
    await asOwner(page, 'POST', '/api/org/invitations', { emails: [existingEmail], kind: 'guest' });
    const pendingMail = await waitForMail(
      (message) => message.to.includes(existingEmail),
      'a pending invitation',
    );
    // An account may join through another route while its invitation is still pending.
    await rows('UPDATE rio_app.users SET email = $1 WHERE id = $2', [existingEmail, person.id]);
    await openInvitation(person.page, pendingMail.text.match(/https?:\/\/\S+\/join#token=[\w-]+/)![0]);
    await person.page.getByLabel('Your name').fill('A different name');
    await person.page.getByLabel('Your name').press('Enter');
    await expect(person.page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    const existing = await asOwner<{ user: { id: string; name: string }; membership: { kind: string } }>(
      person.page,
      'GET',
      '/api/auth/session',
    );
    expect(existing.user).toMatchObject({ id: person.id, name: person.name });
    expect(existing.membership.kind).toBe('member');
    for (const reason of ['expired', 'revoked']) {
      const email = `${randomBytes(12).toString('hex')}@example.test`;
      const result = await asOwner<{ invited: Array<{ id: string }> }>(page, 'POST', '/api/org/invitations', {
        emails: [email],
        kind: 'guest',
      });
      const mail = await waitForMail((message) => message.to.includes(email), 'an invitation');
      const link = mail.text.match(/https?:\/\/\S+\/join#token=[\w-]+/)![0];
      if (reason === 'revoked')
        await asOwner(page, 'DELETE', `/api/org/invitations/${result.invited[0]!.id}`);
      else
        await rows(
          "UPDATE rio_app.invitations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
          [result.invited[0]!.id],
        );
      await openInvitation(person.page, link);
      await expect(person.page.getByRole('alert')).toHaveText(
        'This invitation link has expired, was revoked, or was already used.  Ask for a new one.',
      );
      expect(await person.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await person.context.close();
  }
});

test('server and connection failures keep sign-in input for a retry', async ({ page }) => {
  await signIn(page);
  await page.context().clearCookies();
  await visit(page, `${base()}/sign-in?next=${encodeURIComponent('/settings/security')}`);
  await page.getByLabel('Email address').fill(OWNER.email);
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
  await page.route('**/api/auth/sign-in', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', messageKey: 'errors.internal', userFault: false } }),
    }),
  );
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Something went wrong on the server.');
  await page.unroute('**/api/auth/sign-in');
  await page.route('**/api/auth/sign-in', (route) => route.abort('failed'));
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Check your connection and try again.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(OWNER.password);
  await page.unroute('**/api/auth/sign-in');
  await page.getByLabel('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(`${base()}/settings/security`);
});

test('long email addresses wrap in the sign-in confirmation at phone width', async ({ page }) => {
  await signIn(page);
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/sign-in`);
  const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(60)}`;
  const address = page.getByLabel('Email address');
  await address.fill(`${email}.example`);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Send link', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('This is too long.', { exact: true })).toBeVisible();
  await address.fill(email);
  await expect(address).not.toHaveAttribute('aria-invalid', 'true');
  await address.press('Enter');
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'If ' })).toContainText(email);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Tab and Enter complete password sign-in and keep a deep link', async ({ page }) => {
  await signIn(page);
  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${base()}/settings/security`);
  const email = page.getByLabel('Email address');
  const password = page.getByLabel('Password', { exact: true });
  await expect(email).toBeFocused();
  await page.keyboard.insertText(OWNER.email);
  await page.keyboard.press('Tab');
  await expect(password).toBeFocused();
  await page.keyboard.insertText(OWNER.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${base()}/settings/security`);
});
