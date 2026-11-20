import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../accessibility';
import { startStack, SETUP_TOKEN, type Stack } from '../stack';
import { OWNER } from '../helpers';
import { eicar, standIn } from '../clamd';

test.use({ serviceWorkers: 'block' });

test('saves outside file checks from a deep link with keyboard controls on a phone', async ({ page }) => {
  const stack = await startStack();
  try {
    const owner = await page.request.post(`${stack.baseURL}/api/setup/owner`, {
      headers: { 'x-setup-token': SETUP_TOKEN },
      data: { orgName: OWNER.org, name: OWNER.name, email: OWNER.email, password: OWNER.password },
    });
    expect(owner.ok()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${stack.baseURL}/settings/files#file-checks`);
    await expect(page.getByRole('heading', { name: 'File checks', level: 2 })).toBeVisible();
    const policy = page.getByRole('button', { name: 'Files from outside the organization' });
    await expect(policy).toContainText('Require a scanner');
    await policy.press('Enter');
    await page.getByRole('option', { name: 'Built-in checks only' }).press('Enter');
    const macros = page.getByRole('checkbox', { name: 'Allow macros in outside Office files' });
    await expect(macros).not.toBeChecked();
    await macros.press('Space');
    const save = page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true });
    await save.press('Enter');
    await expect(save).toBeDisabled();
    expect(await (await page.request.get(`${stack.baseURL}/api/org/files/safety`)).json()).toEqual({
      outsideFiles: 'builtInChecksOnly',
      allowOutsideMacros: true,
    });
    await page.reload();
    await expect(policy).toContainText('Built-in checks only');
    await expect(macros).toBeChecked();
    await expect(
      page.getByText(/Built-in checks alone cannot detect known viruses or other malware/),
    ).toBeVisible();
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    expect(
      (
        await new AxeBuilder({ page })
          .include('#file-checks')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await page.close();
    await stack.stop();
  }
});

test('offers scanner detection after creating an owner and permits skipping setup on a phone', async ({
  page,
}) => {
  const stack = await startStack();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await page.goto(`${stack.baseURL}/setup#token=${SETUP_TOKEN}`);
    await page.getByLabel('Organization name').fill(OWNER.org);
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email address').fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Don’t send usage counts' }).click();
    await expect(page.getByRole('heading', { name: 'Virus scanning', level: 1 })).toBeVisible();
    await expect(page.getByText(/new uploads stay in quarantine until a scan passes/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'ClamAV installation instructions' })).toHaveAttribute(
      'href',
      /docs\/install\/docker-compose.md#virus-scanning$/,
    );
    await expect(page.getByRole('link', { name: /return to virus scanning/ })).toHaveAttribute(
      'href',
      '/settings/files#virus-scanning',
    );
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    await page.getByRole('button', { name: 'Skip for now' }).press('Enter');
    await expect(page).toHaveURL(`${stack.baseURL}/`);
  } finally {
    await page.close();
    await stack.stop();
  }
});

test('detects, tests, enables, and disables a scanner from a deep link on a phone', async ({ page }) => {
  const scanner = await standIn();
  const receiver = await standIn();
  let stack: Stack | undefined;
  let scannerClosed = false;
  try {
    stack = await startStack({ clamavApprovedUrls: [scanner.url] });
    const { baseURL } = stack;
    const owner = await page.request.post(`${baseURL}/api/setup/owner`, {
      headers: { 'x-setup-token': SETUP_TOKEN },
      data: { orgName: OWNER.org, name: OWNER.name, email: OWNER.email, password: OWNER.password },
    });
    expect(owner.ok()).toBe(true);
    await page.goto(`${baseURL}/settings/files#virus-scanning`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Virus scanning', level: 2 })).toBeVisible();
    await page.getByLabel('Scanner address', { exact: true }).fill(receiver.url);
    await page.getByRole('button', { name: 'Detect scanner' }).press('Enter');
    await expect(page.getByText(/This scanner address is not approved/)).toBeVisible();
    expect(receiver.received).toHaveLength(0);
    await page.getByLabel('Scanner address', { exact: true }).fill(scanner.url);
    await page.getByRole('button', { name: 'Detect scanner' }).press('Enter');
    await expect(page.getByText('EICAR test signature detected.')).toBeVisible();
    await expect(page.getByText('Reachable', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Test scanner', exact: true }).press('Enter');
    await expect.poll(() => scanner.received.length).toBeGreaterThan(1);
    expect(scanner.received.every((bytes) => bytes.equals(eicar))).toBe(true);
    await expect(page.getByRole('button', { name: 'Turn scanning on' })).toBeEnabled();
    await page.getByRole('button', { name: 'Turn scanning on' }).press('Enter');
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Turn scanning off' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Scanner address', { exact: true })).toHaveValue(scanner.url);
    const allow = page.getByRole('checkbox', { name: 'Allow downloads of files that are too large to scan' });
    await expect(allow).not.toBeChecked();
    await allow.focus();
    await allow.press('Space');
    await expect(allow).toBeChecked();
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    await scanner.close();
    scannerClosed = true;
    await page.getByLabel('Scanner address', { exact: true }).fill(receiver.url);
    await allow.press('Space');
    await expect(allow).not.toBeChecked();
    await expect(page.getByLabel('Scanner address', { exact: true })).toHaveValue(receiver.url);
    const active = await page.request.get(`${baseURL}/api/org/files/scanner`);
    expect((await active.json()).settings).toEqual({
      enabled: true,
      address: scanner.url,
      oversizedPolicy: 'allow',
    });
    expect(receiver.received).toHaveLength(0);
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Discard', exact: true })
      .click();
    await page.getByRole('button', { name: 'Turn scanning off' }).press('Enter');
    await page
      .getByRole('region', { name: 'Save changes', exact: true })
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await expect(
      page
        .getByRole('region', { name: 'Save changes', exact: true })
        .getByRole('button', { name: 'Save', exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Turn scanning on' })).toBeVisible();
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.rio-file-scanner')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await page.close();
    await stack?.stop();
    if (!scannerClosed) await scanner.close();
    await receiver.close();
  }
});
