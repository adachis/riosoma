import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect } from '../accessibility';
import { test } from '../sign-in-settings';
import {
  selfSignedCertificate,
  startTestIdp,
  type Answer,
  type TestIdp,
} from '../../server/src/test/saml-idp';
import { base } from '../base';
import { signIn, visit } from '../helpers';

/**
 * SAML single sign-on with the server tests' own identity provider.  An admin sets the provider up
 * from its metadata, and someone new signs in through it and gets an account.  An answer signed
 * with a certificate the provider never published is refused, with a message on the sign-in page.
 *
 * The identity provider answers at an https address on this machine, as a real one would: it reads
 * Riosoma's request and sends back a page with a form that posts its signed answer to Riosoma.  Its
 * certificate is self-signed, so the browsers that sign in through it don't check certificates.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const PROVIDER = 'Harbor ID';
const PERSON = { email: 'rowan.hale@example.test', name: 'Rowan Hale' };

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

let idp: TestIdp;
let server: Server;
/** How the identity provider answers the next sign-in */
let answer: Answer = {};

test.beforeAll(async () => {
  idp = startTestIdp();
  idp.person = {
    nameId: PERSON.email,
    attributes: { email: PERSON.email, givenname: 'Rowan', surname: 'Hale' },
  };
  const tls = selfSignedCertificate('127.0.0.1');
  server = createServer({ key: tls.privateKey, cert: tls.certificate }, (incoming, response) => {
    idp
      .read(new URL(incoming.url ?? '/', idp.ssoUrl).href)
      .then((request) => {
        const relay = request.parameters.get('RelayState');
        const fields = [
          `<input type="hidden" name="SAMLResponse" value="${escapeHtml(idp.answer(request, answer))}">`,
          relay === null ? '' : `<input type="hidden" name="RelayState" value="${escapeHtml(relay)}">`,
        ].join('');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<!doctype html><title>Signing in</title><form method="post" action="${escapeHtml(request.acsUrl)}">${fields}</form><script>document.forms[0].submit()</script>`,
        );
      })
      .catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  idp.ssoUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}/saml/sso`;
});

test.afterAll(async () => {
  await new Promise((done) => server.close(done));
});

test('someone new signs in with a SAML provider, and a wrongly signed answer is refused', async ({
  page,
  browser,
  browserName,
}) => {
  // Riosoma keeps the request it sent in a Secure cookie, which WebKit drops over plain http, even
  // on this machine, and the test server speaks plain http.
  test.skip(browserName === 'webkit', 'WebKit keeps no Secure cookie from the plain http test server.');
  test.setTimeout(60_000);
  await signIn(page);

  // The admin pastes the identity provider's metadata, which fills in its details.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Single sign-on' }).click();
  await page.getByRole('button', { name: 'Add a provider' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a provider' });
  await dialog.getByText('SAML identity provider', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Assertion Consumer Service URL' })).toHaveValue(
    new RegExp(`^${base()}/api/auth/saml/\\w+/acs$`),
  );
  await dialog.getByRole('textbox', { name: 'Button label' }).fill(PROVIDER);
  await dialog.getByRole('textbox', { name: 'Metadata URL or XML' }).fill(idp.metadata());
  await dialog.getByRole('button', { name: 'Load metadata' }).click();
  await expect(
    dialog.getByText('Filled in the identity provider’s details from its metadata.'),
  ).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Identity provider’s entity ID' })).toHaveValue(
    idp.entityId,
  );
  await expect(dialog.getByRole('textbox', { name: 'Sign-in URL' })).toHaveValue(idp.ssoUrl);
  await expect(dialog.getByRole('list', { name: 'Certificates in use' }).getByRole('listitem')).toHaveCount(
    1,
  );
  await dialog.getByText('This identity provider verifies email addresses', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Email domains that may create accounts' }).fill('example.test');
  await dialog.getByText('Create accounts for new people from these domains', { exact: true }).click();
  await expect(
    dialog.getByRole('checkbox', { name: 'Create accounts for new people from these domains' }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const provider = page.getByRole('button', { name: PROVIDER, exact: true });
  await expect(provider).toBeVisible();

  // Someone new, in a browser of their own, signs in through the provider and gets an account.
  answer = {};
  const newcomer = await browser.newContext({ serviceWorkers: 'block', ignoreHTTPSErrors: true });
  const visitor = await newcomer.newPage();
  await visit(visitor, `${base()}/sign-in`);
  await visitor.getByRole('link', { name: `Continue with ${PROVIDER}` }).click();
  await expect(visitor.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  const session = await (await visitor.request.get(`${base()}/api/auth/session`)).json();
  expect(session.user).toMatchObject({ email: PERSON.email, name: PERSON.name });
  await newcomer.close();

  // An answer signed with a key the provider never published doesn't sign anyone in.
  answer = { foreignKey: true };
  const stranger = await browser.newContext({ serviceWorkers: 'block', ignoreHTTPSErrors: true });
  const refused = await stranger.newPage();
  await visit(refused, `${base()}/sign-in`);
  await refused.getByRole('link', { name: `Continue with ${PROVIDER}` }).click();
  await expect(
    refused.getByText(
      /^Riosoma couldn’t confirm the sign-in with the provider\.\s+Try again, and if it keeps happening/,
    ),
  ).toBeVisible();
  expect((await refused.request.get(`${base()}/api/auth/session`)).ok()).toBe(false);
  await stranger.close();
  // Exercise deletion in the UI as well as the independent cleanup fixture.
  await provider.click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: `Delete ${PROVIDER}?` })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(provider).toHaveCount(0);
});
