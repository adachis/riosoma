import { randomBytes } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { base, mailDir } from './base';
import { asOwner, OWNER, visit } from './helpers';
import { readMailbox, type Mail } from './mail';
import { rows } from './sql';

/**
 * Other people, for specs where two people sign in at once: someone the owner invites, who joins
 * from the link in the invitation email in a browser of their own, and the role the owner gives
 * them in a database.  Every invitation goes to a fresh address, so specs never meet each other's
 * people.
 */

export interface Person {
  id: string;
  name: string;
  email: string;
  /** Their own browser, signed in as them */
  context: BrowserContext;
  page: Page;
}

export type Role = 'owner' | 'creator' | 'editor' | 'commenter' | 'reader';

/** Waits for the first message the server sent that matches, and returns it. */
export async function waitForMail(
  match: (mail: Mail) => boolean,
  what: string,
  timeout = 30_000,
): Promise<Mail> {
  let found: Mail | undefined;
  await expect
    .poll(
      () => {
        found = readMailbox(mailDir()).find(match);
        return found !== undefined;
      },
      { message: `the mail catcher got ${what}`, timeout },
    )
    .toBe(true);
  return found!;
}

/** Every message sent to this address so far. */
export function mailTo(address: string): Mail[] {
  return readMailbox(mailDir()).filter((mail) => mail.to.includes(address.toLowerCase()));
}

/**
 * The owner invites someone new by email.  They open the link from the email in a browser of
 * their own, give their name, and join, which signs them in.
 */
export async function invite(
  owner: Page,
  browser: Browser,
  name: string,
  kind: 'member' | 'guest' = 'member',
): Promise<Person> {
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${randomBytes(4).toString('hex')}@example.test`;
  await asOwner(owner, 'POST', '/api/org/invitations', { emails: [email], kind });
  const mail = await waitForMail((message) => message.to.includes(email), `the invitation to ${email}`);
  const link = new RegExp(`${base()}/join#token=[\\w-]+`).exec(mail.text)?.[0];
  expect(link, 'the invitation has a link to join').toBeTruthy();

  // Joining is limited to ten tries per address every fifteen minutes.  Every spec here joins
  // from the same address, so the count starts over for each person.
  await clearJoinAttempts();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await visit(page, link!);
  await expect(page.getByRole('heading', { name: `Join ${OWNER.org}`, level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your name' }).fill(name);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  return { id: await personId(page), name, email, context, page };
}

/** The ID of whoever is signed in on this page. */
export async function personId(page: Page): Promise<string> {
  const session = await page.request.get(`${base()}/api/auth/session`);
  expect(session.ok(), 'the page has a signed-in session').toBe(true);
  return ((await session.json()) as { user: { id: string } }).user.id;
}

/** The owner gives someone a role in a database, or changes the one they have. */
export async function share(owner: Page, databaseId: string, person: Person, role: Role): Promise<void> {
  await asOwner(owner, 'PUT', `/api/databases/${databaseId}/grants`, {
    principal: { kind: 'user', id: person.id },
    role,
  });
}

async function clearJoinAttempts(): Promise<void> {
  const [found] = await rows<{ table_schema: string }>(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'auth_attempts'`,
  );
  await rows(`DELETE FROM "${found!.table_schema}".auth_attempts WHERE key LIKE 'invitation:%'`);
}
