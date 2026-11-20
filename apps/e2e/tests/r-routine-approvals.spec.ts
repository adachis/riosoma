import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

const cases = [
  'values',
  'people and signatures',
  'attachments',
  'duplicate choices',
  'quoted attachments',
  'quoted links',
  'quoted people',
  'quoted Unicode attachments',
  'quoted Unicode links',
  'quoted Unicode people',
  'quoted Unicode choices',
  'coded characters',
  'literal codes',
].flatMap((scenario) => [1280, 375].map((width) => ({ scenario, width })));

for (const { scenario, width } of cases) {
  test(`record approvals preserve ${scenario} and refresh stale clicks at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.addInitScript(() => {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak = () => undefined;
      }
    });
    await signIn(page);
    const database = await createDatabase(page, 'Account review', [
      {
        name: 'Accounts',
        fields: [{ name: 'Name', type: 'text' }],
        records: [],
      },
    ]);
    const routineId = 'rtnAAAAAAAAAAAAAA';
    const runId = 'rtrAAAAAAAAAAAAAA';
    const approvalId = 'rtaAAAAAAAAAAAAAA';
    const now = new Date().toISOString();
    const people = scenario === 'people and signatures';
    const attachments = scenario === 'attachments';
    const choices = scenario === 'duplicate choices';
    const quoted = scenario.startsWith('quoted');
    const coded = scenario === 'coded characters' || scenario === 'literal codes';
    const review = people || attachments || quoted || coded;
    const displayValues: Record<string, string[]> = {
      'quoted attachments': [
        'Files',
        '"Contract.pdf (52,113 bytes) [attAAAAAAAAAAAAAA], Scan.pdf" (10 bytes) [attBBBBBBBBBBBBBB]',
        'Contract.pdf (52,113 bytes) [attAAAAAAAAAAAAAA]',
        '"Scan, revised.pdf" (20 bytes) [attCCCCCCCCCCCCCC]',
      ],
      'quoted links': [
        'Related records',
        '"Contract [recDDDDDDDDDDDDDD], Scan" [recEEEEEEEEEEEEEE]',
        'Contract [recDDDDDDDDDDDDDD]',
        '"Scan, revised" [recFFFFFFFFFFFFFF]',
      ],
      'quoted people': [
        'Owner',
        '"Casey <casey@example.test> [usrAAAAAAAAAAAAAA], Morgan" <morgan@example.test> [usrBBBBBBBBBBBBBB]',
        'Casey <casey@example.test> [usrAAAAAAAAAAAAAA]',
        '"Morgan, revised" <morgan@example.test> [usrBBBBBBBBBBBBBB]',
      ],
      'quoted Unicode attachments': [
        'Files',
        '"Contract.pdf \u27EE52\u201A113 bytes\u27EF \u2045attAAAAAAAAAAAAAA\u2046\u201A Scan.pdf" (10 bytes) [attBBBBBBBBBBBBBB]',
        'Contract.pdf (52,113 bytes) [attAAAAAAAAAAAAAA]',
        '"Scan\u201A revised.pdf" (20 bytes) [attCCCCCCCCCCCCCC]',
      ],
      'quoted Unicode links': [
        'Related records',
        '"Contract \u27EE52\u201A113 bytes\u27EF \u2045recDDDDDDDDDDDDDD\u2046\u201A Scan" [recEEEEEEEEEEEEEE]',
        'Contract [recDDDDDDDDDDDDDD]',
        '"Scan\u201A revised" [recFFFFFFFFFFFFFF]',
      ],
      'quoted Unicode people': [
        'Owner',
        '"Casey \u02C2casey@example.test\u02C3 \u2045usrAAAAAAAAAAAAAA\u2046\u201A Morgan" <morgan@example.test> [usrBBBBBBBBBBBBBB]',
        'Casey <casey@example.test> [usrAAAAAAAAAAAAAA]',
        '"Morgan\u201A revised" <morgan@example.test> [usrBBBBBBBBBBBBBB]',
      ],
      'quoted Unicode choices': ['Status', '"A\u201AB"', 'A, B', '"\u2045Approved\u2046"'],
      'coded characters': ['Account', String.raw`x\u28000`, String.raw`x\u{28000}`, String.raw`x\u{28001}`],
      'literal codes': [
        'Account',
        String.raw`x\u005Cu{28000}`,
        String.raw`x\u{28000}`,
        String.raw`x\u005Cu{28001}`,
      ],
    };
    const details =
      quoted || coded
        ? displayValues[scenario]!
        : people
          ? [
              'Owner',
              'Casey <casey.one@example.test> [usrAAAAAAAAAAAAAA]',
              'Casey <casey.two@example.test> [usrBBBBBBBBBBBBBB]',
              'Casey <casey.three@example.test> [usrCCCCCCCCCCCCCC]',
            ]
          : attachments
            ? [
                'Files',
                'Agreement.pdf (10 bytes) [attAAAAAAAAAAAAAA]',
                'Agreement.pdf (10 bytes) [attBBBBBBBBBBBBBB]',
                'Agreement.pdf (20 bytes) [attCCCCCCCCCCCCCC]',
              ]
            : choices
              ? [
                  'Status',
                  'Approved [choAAAAAAAAAAAAAA]',
                  'Approved [choBBBBBBBBBBBBBB]',
                  'Approved [choCCCCCCCCCCCCCC]',
                ]
              : ['Account', '1111', '9999', '2222'];
    const [fieldName, firstValue, secondValue, refreshedValue] = details as [string, string, string, string];
    const routine = {
      id: routineId,
      databaseId: database.id,
      databaseName: 'Account review',
      name: 'Add accounts',
      instructions: 'Add the requested accounts.',
      plan: {
        summary: 'Add accounts',
        steps: [],
        reads: [],
        writes: [database.tables.Accounts!.id],
        sends: [],
        fetches: [],
      },
      schedule: { kind: 'daily', at: '09:00' },
      timeZone: 'UTC',
      locale: 'en-US',
      costCapUsd: 1,
      approvedRecipients: [],
      approvedSites: [],
      owner: { id: '', name: 'Owner' },
      paused: false,
      pausedBecause: null,
      failures: 0,
      nextRunAt: now,
      lastRun: null,
      adminPaused: false,
      waiting: 1,
      tableNames: {},
      fieldNames: {},
      createdAt: now,
      updatedAt: now,
    };
    const approval = {
      id: approvalId,
      routineId,
      runId,
      databaseId: database.id,
      kind: 'plan',
      status: 'pending',
      summary: 'Add accounts',
      steps: [],
      revision: 0,
      email: null,
      sites: [],
      receipt: null,
      messageKey: null,
      createdAt: now,
      decidedAt: null,
      expiresAt: now,
      changes: {
        small: !review,
        deletes: false,
        tables: [
          {
            tableId: database.tables.Accounts!.id,
            tableName: 'Accounts',
            created: 2,
            updated: 0,
            trashed: 0,
            restored: 0,
            trashedNames: [],
            fields: [],
            signaturesCanceled: people ? 1 : 0,
            records: [
              {
                recordId: 'recAAAAAAAAAAAAAA',
                name: 'Acme',
                showId: true,
                kind: 'created',
                fields: [{ fieldId: 'fldAAAAAAAAAAAAAA', fieldName, before: '', after: firstValue }],
              },
              {
                recordId: 'recBBBBBBBBBBBBBB',
                name: 'Acme',
                showId: true,
                kind: 'created',
                fields: [{ fieldId: 'fldAAAAAAAAAAAAAA', fieldName, before: '', after: secondValue }],
              },
            ],
          },
        ],
      },
    };
    const posted: unknown[] = [];
    await page.route('**/api/rio/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/approve')) {
        posted.push(route.request().postDataJSON());
        if (approval.revision === 0) {
          approval.revision = 1;
          approval.changes.small = false;
          approval.changes.tables[0]!.records[0]!.fields[0]!.after = refreshedValue;
          return route.fulfill({
            status: 409,
            json: { error: { code: 'conflict', messageKey: 'routines.approval.stale', userFault: true } },
          });
        }
        approval.status = 'approved';
        return route.fulfill({ json: approval });
      }
      if (path.includes('/routine-approvals/')) return route.fulfill({ json: approval });
      if (path.endsWith('/runs'))
        return route.fulfill({
          json: [
            {
              id: runId,
              routineId,
              trigger: 'manual',
              state: 'done',
              messageKey: null,
              report: '',
              receipt: null,
              activity: [],
              approvals: [approval],
              steps: 1,
              usage: null,
              createdAt: now,
              startedAt: now,
              finishedAt: now,
            },
          ],
        });
      if (path.endsWith(`/${routineId}`)) return route.fulfill({ json: routine });
      if (path.endsWith('/status'))
        return route.fulfill({
          json: {
            enabled: true,
            tiers: ['everyday'],
            autonomy: 'previewBig',
            paused: false,
            diagnose: false,
            routines: true,
            routineRunLimitUsd: 1,
          },
        });
      return route.fulfill({ json: [] });
    });
    await page.route('**/api/notifications**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/unread') || path.endsWith('/read')) return route.fulfill({ json: { count: 1 } });
      return route.fulfill({
        json: {
          next: null,
          notifications: [
            {
              id: 'ntfAAAAAAAAAAAAAA',
              kind: 'routineApproval',
              createdAt: now,
              readAt: null,
              actor: null,
              target: {
                databaseId: database.id,
                databaseName: 'Account review',
                routineId,
                routineName: 'Add accounts',
                approvalId,
              },
            },
          ],
        },
      });
    });
    await page.reload();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const bell = page.getByRole('dialog', { name: 'Notifications' });
    const first = bell.getByText('Acme [recAAAAAAAAAAAAAA]', { exact: true }).locator('..');
    await expect(first).toContainText(`${fieldName}: empty to “${firstValue}”`);
    if (quoted) await expect(first).not.toContainText(`${fieldName}: empty to “${secondValue}”`);
    else await expect(first).not.toContainText(secondValue);
    if (review) {
      if (people) await expect(bell).toContainText('Cancels 1 signature request');
      await expect(bell.getByRole('button', { name: 'Approve changes' })).toHaveCount(0);
    } else {
      await bell.getByRole('button', { name: 'Approve changes' }).click();
      await expect(bell).toContainText(`${fieldName}: empty to “${refreshedValue}”`);
      await expect(bell.getByRole('button', { name: 'Approve changes' })).toHaveCount(0);
    }
    await bell.getByRole('link', { name: 'Review it to approve' }).click();
    await expect(page).toHaveURL(`${base()}/${database.id}/routines/${routineId}`);
    const waiting = page.getByRole('region', { name: 'Waiting for you' });
    await expect(waiting).toContainText('Acme [recAAAAAAAAAAAAAA]');
    await expect(waiting).toContainText(`${fieldName}: empty to “${review ? firstValue : refreshedValue}”`);
    await expect(waiting).toContainText(`${fieldName}: empty to “${secondValue}”`);
    if (review) {
      await waiting.getByRole('button', { name: 'Approve changes' }).click();
      await expect(waiting).toContainText(`${fieldName}: empty to “${refreshedValue}”`);
      await expect(waiting).not.toContainText(firstValue);
      if (people) await expect(waiting).toContainText('Cancels 1 signature request');
    }
    const bounds = await waiting.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(
      (
        await new AxeBuilder({ page })
          .include('.rio-routines__screen')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    const approve = waiting.getByRole('button', { name: 'Approve changes' });
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => posted)
      .toEqual([review ? { revision: 0 } : { oneClick: true, revision: 0 }, { revision: 1 }]);
    await expect(approve).toHaveCount(0);
  });
}
