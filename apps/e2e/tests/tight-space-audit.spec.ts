import { expect, test } from '@playwright/test';
import { auditTightSpaces, recordLayoutAudit } from '../tight-space-audit';
import { base } from '../base';

test('audits the replacement document when navigation interrupts font readiness', async ({ page }, info) => {
  await page.route('**/layout-origin', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Loading</p>' }),
  );
  await page.route('**/layout-destination', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="clip" style="width:70px;overflow:hidden"><div style="width:200px"><input id="control" aria-label="Name" style="width:150px" /></div></div>',
    }),
  );
  await page.goto(`${base()}/layout-origin`);
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.exposeFunction('layoutAuditStarted', () => started());
  await page.evaluate(() => {
    Object.defineProperty(document.fonts, 'ready', {
      get() {
        void (window as unknown as { layoutAuditStarted(): Promise<void> }).layoutAuditStarted();
        return new Promise<FontFaceSet>(() => {});
      },
    });
  });
  const report = recordLayoutAudit(page, info, 'redirect', page, { reportOnly: true });
  // Navigation deliberately rejects the first document's pending font wait.
  void report.catch(() => {});
  await waiting;
  await page.goto(`${base()}/layout-destination`);
  expect(await report).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'clipped', selector: '#control', related: '#clip' }),
    ]),
  );
});

for (const control of ['input', 'icon']) {
  test(`reports an ancestor-clipped ${control} inside a wider immediate parent`, async ({ page }) => {
    await page.setContent(`
      <style>
        #clip { width: 70px; height: 44px; overflow: hidden; }
        #wide { width: 200px; height: 44px; }
        #control { box-sizing: border-box; width: 150px; height: 40px; }
        svg { width: 16px; height: 16px; }
      </style>
      <div id="clip"><div id="wide">
        ${
          control === 'input'
            ? '<input id="control" aria-label="Name" value="Planning" />'
            : '<button id="control" aria-label="Settings" data-tooltip="Settings"><svg aria-hidden="true"><path d="M0 0h10v10H0z" /></svg></button>'
        }
      </div></div>
    `);
    expect(await auditTightSpaces(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'clipped', selector: '#control', related: '#clip' }),
      ]),
    );
  });
}

test('allows native scrolling to reveal partially visible controls', async ({ page }) => {
  await page.setContent(`
    <style>#scroll { width: 70px; overflow: auto; } #wide { width: 200px; } input { width: 150px; }</style>
    <div id="scroll"><div id="wide"><input aria-label="Name" /></div></div>
  `);
  expect(await auditTightSpaces(page)).toEqual([]);
});

for (const control of ['input', 'icon']) {
  test(`reports an ancestor-clipped ${control} beyond a nested scroll container`, async ({ page }) => {
    await page.setContent(`
      <style>
        #clip { width:70px; overflow:hidden; }
        #scroll { width:200px; overflow:auto; }
        #control { box-sizing:border-box; width:150px; height:40px; }
      </style>
      <div id="clip"><div id="scroll">
        ${
          control === 'input'
            ? '<input id="control" aria-label="Name" />'
            : '<button id="control" aria-label="Settings" data-tooltip="Settings"><svg aria-hidden="true" width="16" height="16"></svg></button>'
        }
      </div></div>
    `);
    expect(await auditTightSpaces(page)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'clipped', selector: '#control', related: '#clip' }),
      ]),
    );
  });
}

test('excludes inactive controls underneath a modal', async ({ page }) => {
  await page.setContent(`
    <div aria-hidden="true" style="width:70px;overflow:hidden">
      <div style="width:200px"><input aria-label="Name" style="width:150px" /></div>
    </div>
    <div role="dialog" aria-modal="true" aria-label="Review">
      <button aria-label="Close" data-tooltip="Close"><svg aria-hidden="true" width="16" height="16"></svg></button>
    </div>
  `);
  expect(await auditTightSpaces(page)).toEqual([]);
});

test('allows named links to cross a virtualized scrolling pane boundary', async ({ page }) => {
  await page.setContent(`
    <style>
      #scroll { width:70px; overflow:auto; }
      .rio-grid__viewport { width:200px; }
      .rio-grid__pane { width:70px; overflow:hidden; }
      .rio-grid__cell { width:200px; }
      a { display:block; width:150px; white-space:nowrap; }
    </style>
    <div id="scroll"><div class="rio-grid__viewport"><div class="rio-grid__pane"><div class="rio-grid__cell">
      <a class="rio-cell-value--link" href="#record">PlanningReferenceMaterial</a>
    </div></div></div></div>
  `);
  expect(await auditTightSpaces(page)).toEqual([]);
});

test('allows row actions at a virtualized grid scroll boundary', async ({ page }) => {
  await page.setContent(`
    <style>
      #scroll { width:200px; height:50px; overflow:auto; }
      #spacer { height:200px; }
      .rio-grid__viewport { position:relative; height:50px; overflow:hidden; }
      #row { position:absolute; top:32px; width:200px; height:32px; }
      button { box-sizing:border-box; height:32px; width:44px; }
    </style>
    <div id="scroll"><div id="spacer"><div class="rio-grid__viewport"><div id="row">
      <button class="rio-cell-row-header__action" aria-label="Select row" data-tooltip="Select row"><svg aria-hidden="true" width="16" height="16"></svg></button>
      <button class="rio-cell-row-header__action" aria-label="Expand row" data-tooltip="Expand row"><svg aria-hidden="true" width="16" height="16"></svg></button>
    </div></div></div></div>
  `);
  expect(await auditTightSpaces(page)).toEqual([]);
});

test('keeps unit names and the combined rename or move choice as words', async ({ page }) => {
  await page.setContent(`
    <section class="rio-units__panel"><ul><li class="rio-units__row">
      <button class="rio-units__grow">New projects</button>
      <button class="rio-units__edit">Rename or move</button>
    </li></ul><button id="add">Add unit</button></section>
  `);
  expect((await auditTightSpaces(page)).filter((finding) => finding.kind === 'text-action')).toEqual([
    expect.objectContaining({ selector: '#add' }),
  ]);
});

test('reports overlapping, clipped, wrapped, outside, text, and unnamed controls by selector', async ({
  page,
}) => {
  await page.setContent(`
    <style>
      body { margin: 16px; }
      header { position: relative; width: 400px; height: 90px; }
      button { height: 36px; }
      svg { width: 16px; height: 16px; }
      #overlap-a, #overlap-b { position: absolute; top: 50px; width: 100px; }
      #overlap-a { left: 0; } #overlap-b { left: 50px; }
      .clip { width: 70px; overflow: hidden; white-space: nowrap; }
      #ellipsis { text-overflow: ellipsis; }
      #wrapped { width: 70px; height: auto; }
      #container { width: 50px; height: 45px; }
      #outside { width: 80px; margin-left: 30px; }
    </style>
    <header>
      <button id="text-action">Add folder</button>
      <button id="unnamed"><svg aria-hidden="true"><path d="M0 0h10v10H0z" /></svg></button>
      <button id="tooltip" aria-label="Settings"><svg aria-hidden="true"><path d="M0 0h10v10H0z" /></svg></button>
      <button id="overlap-a">Alpha</button><button id="overlap-b">Beta</button>
    </header>
    <div class="clip"><span id="clipped">PlanningReferenceMaterial</span></div>
    <div id="ellipsis" class="clip">PlanningReferenceMaterial</div>
    <button id="wrapped">Several separate words</button>
    <div id="container"><button id="outside">Continue</button></div>
  `);
  const findings = await auditTightSpaces(page);
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'overlap', selector: '#overlap-a', related: '#overlap-b' }),
      expect.objectContaining({ kind: 'clipped', selector: '#clipped' }),
      expect.objectContaining({ kind: 'wrapped', selector: '#wrapped' }),
      expect.objectContaining({ kind: 'outside', selector: '#outside', related: '#container' }),
      expect.objectContaining({ kind: 'text-action', selector: '#text-action' }),
      expect.objectContaining({ kind: 'unnamed-icon', selector: '#unnamed' }),
      expect.objectContaining({ kind: 'missing-tooltip', selector: '#tooltip' }),
    ]),
  );
  expect(findings.some((finding) => finding.selector === '#ellipsis')).toBe(false);
  const allowed = await auditTightSpaces(page, [
    {
      kind: 'text-action',
      selector: '#text-action',
      reason: 'This specimen exercises the detector.',
    },
  ]);
  expect(allowed.some((finding) => finding.kind === 'text-action')).toBe(false);
  await expect(
    auditTightSpaces(page, [{ kind: 'text-action', selector: '#text-action', reason: '' }]),
  ).rejects.toThrow('needs a reason');
});

for (const layer of [
  'rio-toast',
  'rio-record-surface--panel',
  'rio-timeline-chart__side',
  'rio-automation-canvas__note',
  'rio-script-panel',
  'rio-assistant__dock',
  'rio-grid-find',
  'rio-demo-card',
])
  test(`audits controls within each ${layer} overlay and excludes covered targets on another layer`, async ({
    page,
  }) => {
    await page.setContent(`
    <style>
      button { width: 100px; height: 44px; }
      #behind, .${layer} { position: absolute; top: 20px; left: 20px; }
      .${layer} { background: white; }
      #toast-a, #toast-b { position: absolute; top: 0; left: 0; }
      #toast-b { left: 50px; }
    </style>
    <button id="behind">Record</button>
    <div class="${layer}"><button id="toast-a">Undo</button><button id="toast-b">Dismiss</button></div>
  `);
    const overlaps = (await auditTightSpaces(page)).filter((finding) => finding.kind === 'overlap');
    expect(overlaps).toEqual([expect.objectContaining({ selector: '#toast-a', related: '#toast-b' })]);
  });

test('keeps proposed object names visible while requiring icons for actions', async ({ page }) => {
  await page.setContent(`
    <header>
      <div class="rio-plan-preview__targets"><button class="rio-button" id="name">New projects</button></div>
      <button id="add">Add a project</button>
    </header>
  `);
  const actions = (await auditTightSpaces(page)).filter((finding) => finding.kind === 'text-action');
  expect(actions).toEqual([expect.objectContaining({ selector: '#add' })]);
});

test('keeps viewport cropping during a scroll lock separate from clipping inside a control', async ({
  page,
}) => {
  await page.setContent(`
    <style>
      html { height: 100%; overflow: hidden; }
      body { margin: 0; }
      #edge { position: absolute; top: calc(100vh - 8px); }
      .clip { width: 70px; overflow: hidden; white-space: nowrap; }
    </style>
    <button id="edge">Certificate settings</button>
    <div class="clip"><span id="clipped">PlanningReferenceMaterial</span></div>
  `);
  const findings = await auditTightSpaces(page);
  expect(findings.some((finding) => finding.kind === 'clipped' && finding.selector === '#edge')).toBe(false);
  expect(findings).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'clipped', selector: '#clipped' })]),
  );
});

test('ignores unpainted controls inside a closed disclosure', async ({ page }) => {
  await page.setContent(`
    <header><details><summary>Import choices</summary>
      <button id="closed-action">Add a source</button>
      <button id="closed-icon" aria-label="Settings"><svg><path d="M0 0h10v10H0z" /></svg></button>
    </details></header>
  `);
  expect(await auditTightSpaces(page)).toEqual([]);
  await page.locator('summary').click();
  expect(await auditTightSpaces(page)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'text-action', selector: '#closed-action' }),
      expect.objectContaining({ kind: 'missing-tooltip', selector: '#closed-icon' }),
    ]),
  );
});
