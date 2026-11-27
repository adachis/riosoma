import { createECDH, randomBytes, randomInt } from 'node:crypto';
import { assertAccessible, expect, test } from '../accessibility';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannelPreferences,
  type NotificationCommand,
} from '../../../packages/contracts/src/notification-channels.js';
import { DEFAULT_NOTIFICATION_EMAIL } from '../../../packages/contracts/src/notifications.js';
import { base } from '../base';
import { newId, signIn } from '../helpers';

// Requests must reach the channel fixtures; the installable-app spec covers the real worker.
test.use({ serviceWorkers: 'block' });

test('notification channels work on a phone with keyboard controls and device actions', async ({ page }) => {
  await signIn(page);
  const state: NotificationChannelPreferences = {
    channels: Object.fromEntries(
      NOTIFICATION_CHANNELS.map((channel) => [
        channel,
        Object.fromEntries(
          Object.entries(DEFAULT_NOTIFICATION_EMAIL).map(([kind, email]) => [
            kind,
            channel === 'bell' || (channel === 'email' && email),
          ]),
        ),
      ]),
    ) as NotificationChannelPreferences['channels'],
    digest: { frequency: 'off', hour: 9, timeZone: 'UTC' },
    enabled: Object.fromEntries(
      NOTIFICATION_CHANNELS.map((channel) => [channel, true]),
    ) as NotificationChannelPreferences['enabled'],
    available: { bell: true, email: true, digest: true, push: true, slack: false, teams: false, sms: false },
    devices: [],
    phone: null,
    canAdminister: true,
    canReceiveSms: true,
  };
  const key = createECDH('prime256v1');
  key.generateKeys();
  const publicKey = key.getPublicKey().toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  const deviceId = randomBytes(32).toString('hex');
  const commands: NotificationCommand[] = [];
  await page.addInitScript(
    ({ publicKey, auth }) => {
      let active = false;
      let permissionDenied = true;
      const subscription = {
        endpoint: `${location.origin}/push-device`,
        expirationTime: null,
        toJSON: () => ({ keys: { p256dh: publicKey, auth } }),
        unsubscribe: async () => {
          active = false;
          return true;
        },
      };
      if (!('PushManager' in window)) Object.defineProperty(window, 'PushManager', { value: class {} });
      Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
        value: async () => ({
          pushManager: {
            getSubscription: async () => (active ? subscription : null),
            subscribe: async () => {
              if (permissionDenied) {
                permissionDenied = false;
                throw new DOMException('Notification permission denied', 'NotAllowedError');
              }
              active = true;
              return subscription;
            },
          },
        }),
      });
    },
    { publicKey, auth },
  );
  await page.route('**/api/notifications/preferences', async (route) => {
    if (route.request().method() === 'PUT')
      Object.assign(state.channels.email, route.request().postDataJSON().email);
    await route.fulfill({ json: { email: state.channels.email, emailAvailable: true } });
  });
  await page.route('**/api/notifications/channels', (route) => route.fulfill({ json: state }));
  await page.route('**/api/notifications/commands', async (route) => {
    const command = route.request().postDataJSON() as NotificationCommand;
    commands.push(command);
    switch (command.kind) {
      case 'notifications.preferences':
        for (const [channel, kinds] of Object.entries(command.update.channels ?? {}))
          Object.assign(state.channels[channel as keyof typeof state.channels], kinds);
        if (command.update.digest) state.digest = command.update.digest;
        break;
      case 'notifications.organization':
        Object.assign(state.enabled, command.update.enabled);
        break;
      case 'notifications.connection':
        state.available[command.connection.channel] = true;
        break;
      case 'notifications.disconnect':
        state.available[command.channel] = false;
        break;
      case 'notifications.push.subscribe':
        state.devices = [{ id: deviceId, createdAt: new Date().toISOString() }];
        break;
      case 'notifications.push.unsubscribe':
        state.devices = [];
        break;
      case 'notifications.phone.request':
        state.phone = { number: command.number, verified: false };
        break;
      case 'notifications.phone.verify':
        if (state.phone) state.phone.verified = true;
        break;
      case 'notifications.phone.remove':
        state.phone = null;
        break;
    }
    await route.fulfill({ json: { status: 'applied', actionId: newId('cmd'), publicKey, deviceId } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base()}/settings/notifications#channels`);
  const push = page.getByRole('switch', { name: 'Push: Someone mentions me', exact: true });
  await push.focus();
  await page.keyboard.press('Space');
  await expect(push).toBeChecked();
  await page.getByRole('link', { name: 'Digest schedule' }).click();
  await expect(page).toHaveURL(/#digest$/);
  // A picker's label wraps it, so the label's own text carries every option's name too.  The
  // picker's accessible name, what a screen reader says, is the short one.
  await page.getByRole('combobox', { name: 'Frequency', exact: true }).selectOption('weekly');
  await page.getByRole('combobox', { name: 'Hour', exact: true }).selectOption('14');
  await page.getByLabel('Time zone', { exact: true }).fill('America/Chicago');
  await page.getByLabel('Time zone', { exact: true }).press('Tab');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect
    .poll(() => state.digest)
    .toEqual({ frequency: 'weekly', hour: 14, timeZone: 'America/Chicago' });
  await page.getByRole('link', { name: 'Your devices' }).click();
  expect(commands.some((command) => command.kind === 'notifications.push.prepare')).toBe(false);
  await page.getByRole('button', { name: 'Subscribe this device', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This device could not subscribe.' })).toBeVisible();
  expect(commands.some((command) => command.kind === 'notifications.push.subscribe')).toBe(false);
  await page.getByRole('button', { name: 'Subscribe this device', exact: true }).click();
  await expect(page.getByRole('button', { name: 'This device is subscribed' })).toBeDisabled();
  await page.getByRole('button', { name: /Unsubscribe device added/ }).click();
  await expect(page.getByRole('button', { name: 'Subscribe this device' })).toBeEnabled();
  await page.getByRole('link', { name: 'Organization channels' }).click();
  await page.getByLabel('Bot token', { exact: true }).fill(randomBytes(24).toString('base64url'));
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Disconnect channel' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect channel' }).click();
  await expect(page.getByRole('button', { name: 'Disconnect channel' })).toBeHidden();
  await page.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('sms');
  await page.getByLabel('Account SID').fill(`AC${randomBytes(16).toString('hex')}`);
  await page.getByLabel('Auth token').fill(randomBytes(24).toString('hex'));
  await page.getByLabel('Sending phone number').fill('+12025550101');
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await page.getByRole('link', { name: 'Admin phone' }).click();
  await page.getByLabel('Phone number with country code').fill('+12025550102');
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page
    .getByLabel('Verification code', { exact: true })
    .fill(String(randomInt(0, 1_000_000)).padStart(6, '0'));
  await page.getByRole('button', { name: 'Verify phone', exact: true }).click();
  // The demo host keeps an empty live region on every page, so this names the one that speaks.
  await expect(page.getByRole('status').filter({ hasText: 'Phone verified' })).toHaveText('Phone verified');
  await page.getByRole('button', { name: 'Remove phone' }).click();
  await expect(page.getByText('Phone verified', { exact: true })).toBeHidden();
  await page.locator('#organization').getByText('Push', { exact: true }).click();
  await expect(push).toBeDisabled();
  await page
    .getByRole('region', { name: 'Save changes', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect
    .poll(() => commands.some((command) => command.kind === 'notifications.organization'))
    .toBe(true);
  const channel = page.getByRole('combobox', { name: 'Channel', exact: true });
  await channel.selectOption('teams');
  const signInWithMicrosoft = page.getByRole('button', { name: 'Sign in with Microsoft' });
  await expect(signInWithMicrosoft).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Integrations', exact: true }).last()).toHaveAttribute(
    'href',
    '/settings/integrations',
  );
  await assertAccessible(page);

  state.teamsSignInAvailable = true;
  await page.route('**/api/oauth/start/microsoft-teams?**', async (route) => {
    const next = new URL(route.request().url()).searchParams.get('next');
    expect(next).toBe('/settings/notifications#organization');
    state.available.teams = true;
    // A tenant's default domain makes a long address with nowhere to break.
    state.teamsAccount = {
      name: 'Teams Sender',
      email: 'notifications-sender@exampleorganization.onmicrosoft.test',
    };
    await route.fulfill({
      status: 302,
      headers: { location: '/settings/notifications?connected=microsoft-teams#organization' },
    });
  });
  await page.reload();
  await channel.selectOption('teams');
  await expect(signInWithMicrosoft).toBeEnabled();
  await signInWithMicrosoft.press('Enter');
  const account = page.getByText(
    'Connected as Teams Sender (notifications-sender@exampleorganization.onmicrosoft.test)',
  );
  await expect(account).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  // Nothing in the connections box reaches past its edge, however long the account's address.
  const box = (await page.getByRole('group', { name: 'Delivery connections', exact: true }).boundingBox())!;
  for (const inside of [channel, account, signInWithMicrosoft]) {
    const part = (await inside.boundingBox())!;
    expect(part.x + part.width).toBeLessThanOrEqual(box.x + box.width);
  }
  await assertAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
