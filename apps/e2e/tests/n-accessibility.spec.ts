import AxeBuilder from '@axe-core/playwright';
import { join } from 'node:path';
import {
  assertAccessible,
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, offlineMap, OWNER, signIn, visit } from '../helpers';

/**
 * An accessibility and phone layout pass over the app's screens, each opened with records of its
 * own.  Every screen gets axe's WCAG 2.1 AA rules at desktop width and at 375 by 812, and at phone
 * width nothing may scroll sideways except the grid, timelines, wide tables, and a kanban's stacks,
 * and every open dialog has to fit on the screen.  On a phone, the grid, a kanban, and the view
 * switcher are used as a person would, and every control on them is measured.  The checks are
 * soft, so one run lists every problem it finds, and each screen is saved under test-results/a11y
 * to read by eye.
 */

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;

const SIZES = [
  { name: 'desktop', phone: false, viewport: { width: 1280, height: 800 } },
  { name: 'phone', phone: true, viewport: { width: 375, height: 812 } },
] as const;
type Size = (typeof SIZES)[number];

const SHOTS = join(import.meta.dirname, '..', 'test-results', 'a11y');

/**
 * What may scroll sideways on a phone: the grid, timelines and Gantt charts, wide tables, and a
 * kanban's row of stacks, which a phone pages through one stack at a time.
 */
const WIDE = '.rio-grid, .rio-timeline-chart, table, [role="table"], .rio-kanban__board';

/** Everything a pointer can operate, for measuring targets */
const CONTROLS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  ...[
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'slider',
    'spinbutton',
    'combobox',
    'searchbox',
    'textbox',
    'gridcell',
    'columnheader',
  ].map((role) => `[role="${role}"]`),
].join(', ');

/** WCAG 2.2's minimum target size, for every control */
const TARGET_MIN = 24;
/** A comfortable fingertip, for a phone's primary actions */
const TARGET_TOUCH = 44;

const VIEW_TYPES = [
  'kanban',
  'gallery',
  'calendar',
  'form',
  'timeline',
  'gantt',
  'chart',
  'pivot',
  'list',
  'map',
] as const;
type OtherView = (typeof VIEW_TYPES)[number];

const VIEW_NAMES: Record<OtherView, string> = {
  kanban: 'By status',
  gallery: 'Project cards',
  calendar: 'Schedule',
  form: 'Project request',
  timeline: 'Timeline',
  gantt: 'Gantt',
  chart: 'Budget by status',
  pivot: 'Status summary',
  list: 'Project list',
  map: 'Sites',
};

interface Fixture {
  databaseId: string;
  tableId: string;
  gridViewId: string;
  views: Record<OtherView, string>;
  /** The record the card opens, with comments and history */
  recordId: string;
  recordName: string;
  /** A record the undo test changes from its card */
  otherRecordId: string;
  otherRecordName: string;
  dashboardId: string;
  automationId: string;
  formPath: string;
  sharedPath: string;
}

let fixture: Fixture;
/** The owner's session, which each signed-in test's window starts with */
let owner: Cookies;

/** An ID of a kind the helpers don't make, with the same random tail. */
function idOf(prefix: 'cmt' | 'dsh' | 'aut'): string {
  return prefix + newId('rec').slice(3);
}

/** A tile or step ID, which only needs to be unique within its dashboard or automation. */
function shortId(): string {
  return newId('rec').slice(3, 15);
}

/** Where each project's site is, for the map. */
const SITES = {
  Seattle: { lat: 47.6062, lng: -122.3321 },
  Tacoma: { lat: 47.2529, lng: -122.4443 },
  Everett: { lat: 47.979, lng: -122.2021 },
  Bremerton: { lat: 47.5673, lng: -122.6326 },
  Olympia: { lat: 47.0379, lng: -122.9007 },
  'Port Angeles': { lat: 48.1181, lng: -123.4307 },
} as const;

/** A day this many days from today, as a date field holds it. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function run(page: Page, databaseId: string, commands: object[]): Promise<void> {
  const groupId = newId('act');
  const result = await asOwner<{ results: Array<{ status: string; error?: unknown }> }>(
    page,
    'POST',
    `/api/databases/${databaseId}/commands`,
    {
      clientId: newId('cli'),
      commands: commands.map((command) => ({ id: newId('cmd'), groupId, ...command })),
    },
  );
  expect(result.results.filter((item) => item.status === 'rejected')).toEqual([]);
}

/**
 * A harbor authority's projects: a table with a field of most kinds, a view of every type, a
 * dashboard with each kind of tile, comments and history on a record, an automation whose webhook
 * step fails and so leaves a notification, and a public form and a shared view to open signed out.
 */
async function seed(page: Page): Promise<Fixture> {
  const databaseId = newId('db');
  const tableId = newId('tbl');
  const gridViewId = newId('viw');
  const field = {
    name: newId('fld'),
    status: newId('fld'),
    start: newId('fld'),
    end: newId('fld'),
    budget: newId('fld'),
    progress: newId('fld'),
    site: newId('fld'),
    contact: newId('fld'),
    notes: newId('fld'),
  };
  const choice = { planned: newId('cho'), active: newId('cho'), done: newId('cho') };
  await asOwner(page, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Harbor Works',
    icon: null,
    color: 'teal',
    table: {
      id: tableId,
      name: 'Projects',
      description: 'Every project the harbor authority has planned, started, or finished.',
      fields: [
        { id: field.name, name: 'Name', type: 'text', options: {} },
        {
          id: field.status,
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              { id: choice.planned, name: 'Planned', color: 'blue' },
              { id: choice.active, name: 'Active', color: 'yellow' },
              { id: choice.done, name: 'Done', color: 'green' },
            ],
          },
        },
        { id: field.start, name: 'Start', type: 'date', options: {} },
        { id: field.end, name: 'End', type: 'date', options: {} },
        { id: field.budget, name: 'Budget', type: 'currency', options: {} },
        { id: field.progress, name: 'Progress', type: 'percent', options: {} },
        { id: field.site, name: 'Site', type: 'location', options: {} },
        { id: field.contact, name: 'Contact', type: 'text', options: {} },
        { id: field.notes, name: 'Notes', type: 'longText', options: {} },
      ],
      view: { id: gridViewId, name: 'All projects' },
      records: [],
    },
  });

  const projects = [
    ['Crane refit', choice.active, -3, 4, 184_000, 0.45, 'Seattle', 'Mara Ellis'],
    ['Pier lighting', choice.planned, 2, 9, 36_500, 0.1, 'Tacoma', 'Jonas Reyes'],
    ['Dock office move', choice.done, -12, -5, 12_800, 1, 'Everett', 'Priya Nair'],
    ['Ferry ramp survey', choice.active, -1, 2, 9_200, 0.6, 'Bremerton', 'Sam Okafor'],
    ['Cold storage wing', choice.planned, 6, 20, 412_000, 0, 'Olympia', 'Lena Ford'],
    ['Tug berth repair', choice.active, -6, 1, 58_000, 0.8, 'Port Angeles', 'Mara Ellis'],
  ] as const;
  const records = projects.map(([name, status, from, to, budget, progress, site, contact]) => ({
    id: newId('rec'),
    values: {
      [field.name]: name,
      [field.status]: status,
      [field.start]: day(from),
      [field.end]: day(to),
      [field.budget]: budget,
      [field.progress]: progress,
      [field.site]: { ...SITES[site], label: site },
      [field.contact]: contact,
      [field.notes]: `${name} is on the harbor board’s list for this season.`,
    },
  }));

  const views = {} as Record<OtherView, string>;
  for (const type of VIEW_TYPES) views[type] = newId('viw');
  const configs: Record<OtherView, object> = {
    kanban: {
      kanban: { stackFieldId: field.status },
      hiddenFieldIds: [field.site, field.notes, field.contact],
    },
    gallery: { gallery: { cardSize: 'medium' }, hiddenFieldIds: [field.site, field.notes] },
    calendar: { calendar: { startFieldId: field.start, endFieldId: field.end, range: 'month' } },
    form: {
      form: {
        title: 'Request a harbor project',
        description: 'Tell the harbor office what needs doing, and someone will follow up within a week.',
        questions: [
          { fieldId: field.name, required: true, label: 'What needs doing?' },
          { fieldId: field.status },
          { fieldId: field.start, label: 'When should it start?' },
          { fieldId: field.budget, help: 'A rough figure is fine.' },
          { fieldId: field.site },
          { fieldId: field.contact, label: 'Your name' },
          { fieldId: field.notes, help: 'Anything the crew should know before they arrive.' },
        ],
      },
    },
    timeline: {
      timeline: { startFieldId: field.start, endFieldId: field.end, groupFieldId: field.status },
    },
    gantt: { gantt: { startFieldId: field.start, endFieldId: field.end, progressFieldId: field.progress } },
    chart: {
      chart: {
        chart: 'column',
        groupBy: { fieldId: field.status },
        value: { fn: 'sum', fieldId: field.budget },
      },
    },
    pivot: {
      pivot: {
        rows: [{ fieldId: field.status }],
        values: [{ fn: 'count' }, { fn: 'sum', fieldId: field.budget }],
      },
    },
    list: { list: { groupFieldId: field.status } },
    map: { map: { locationFieldId: field.site, colorFieldId: field.status } },
  };
  const [card, other] = records;
  const session = (await (await page.request.get(`${base()}/api/auth/session`)).json()) as {
    user: { id: string };
  };
  const dashboardId = idOf('dsh');
  const automationId = idOf('aut');
  await run(page, databaseId, [
    { kind: 'record.create', tableId, records },
    ...VIEW_TYPES.map((type) => ({
      kind: 'view.create',
      view: {
        id: views[type],
        tableId,
        name: VIEW_NAMES[type],
        type,
        config: {
          ...configs[type],
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'named', fieldId: field.name, operator: 'isNotEmpty' }],
          },
        },
      },
    })),
    {
      kind: 'view.update',
      viewId: gridViewId,
      config: {
        summaries: { [field.budget]: 'sum', [field.progress]: 'average', [field.start]: 'earliest' },
        colorRules: [
          {
            id: 'overBudget',
            name: 'Over $100,000',
            target: 'cell',
            condition: { id: 'budget', fieldId: field.budget, operator: 'gt', value: 100_000 },
            color: 'red',
          },
          {
            id: 'finished',
            name: 'Finished',
            target: 'record',
            condition: { id: 'status', fieldId: field.status, operator: 'is', value: choice.done },
            color: 'green',
          },
        ],
        colorScales: [{ fieldId: field.progress, stops: [{ color: 'orange' }, { color: 'green' }] }],
        dataBars: [{ fieldId: field.budget, color: 'blue' }],
      },
    },
    {
      kind: 'comment.create',
      tableId,
      recordId: card!.id,
      comment: {
        id: idOf('cmt'),
        body: `@[${OWNER.name}](${session.user.id}) the crane inspection is booked for Thursday.`,
      },
    },
    {
      kind: 'comment.create',
      tableId,
      recordId: card!.id,
      comment: { id: idOf('cmt'), body: 'The new cable arrived, so the refit can start on time.' },
    },
    {
      kind: 'dashboard.create',
      dashboard: {
        id: dashboardId,
        name: 'Harbor overview',
        config: {
          tiles: [
            {
              id: shortId(),
              kind: 'number',
              title: 'Total budget',
              place: { x: 0, y: 0, w: 4, h: 2 },
              source: { tableId },
              value: { fn: 'sum', fieldId: field.budget },
            },
            {
              id: shortId(),
              kind: 'text',
              title: 'About these numbers',
              place: { x: 4, y: 0, w: 8, h: 2 },
              text: 'Budgets are reviewed by the harbor board every **Monday**.',
            },
            {
              id: shortId(),
              kind: 'chart',
              title: 'Projects by status',
              place: { x: 0, y: 2, w: 6, h: 4 },
              source: { tableId },
              chart: 'column',
              groupBy: { fieldId: field.status },
              value: { fn: 'count' },
            },
            {
              id: shortId(),
              kind: 'records',
              title: 'Every project',
              place: { x: 6, y: 2, w: 6, h: 4 },
              source: { tableId },
              fieldIds: [field.name, field.status, field.budget],
              limit: 10,
            },
          ],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: automationId,
        name: 'Tell the site office',
        config: {
          trigger: { kind: 'recordCreated', tableId },
          steps: [
            {
              id: shortId(),
              kind: 'updateRecord',
              tableId,
              record: 'trigger',
              values: { [field.status]: 'Planned' },
            },
            {
              id: shortId(),
              kind: 'callWebhook',
              // A loopback port nothing listens on, so each run fails.
              url: 'http://127.0.0.1:9/site-office',
              method: 'POST',
              body: `{"project": "{{trigger.record.${field.name}}}"}`,
            },
          ],
        },
      },
    },
  ]);
  // A change after creation gives the record's history something to compare.
  await run(page, databaseId, [
    {
      kind: 'record.update',
      tableId,
      records: [{ id: card!.id, values: { [field.progress]: 0.5, [field.contact]: 'Mara Ellis-Grant' } }],
    },
  ]);
  // Turned on, the automation runs for the next new record and fails at the webhook, which tells the
  // owner through the bell.
  await run(page, databaseId, [{ kind: 'automation.update', automationId, enabled: true }]);
  await run(page, databaseId, [
    {
      kind: 'record.create',
      tableId,
      records: [{ id: newId('rec'), values: { [field.name]: 'Breakwater lights', [field.budget]: 21_000 } }],
    },
  ]);
  await expect
    .poll(async () => (await asOwner<{ count: number }>(page, 'GET', '/api/notifications/unread')).count, {
      message: 'the failed run leaves a notification',
      // Runs start within a second or so, and a slow machine gets room to spare.
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const form = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${views.form}/public-form`);
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${gridViewId}/shared-view`);
  return {
    databaseId,
    tableId,
    gridViewId,
    views,
    recordId: card!.id,
    recordName: projects[0][0],
    otherRecordId: other!.id,
    otherRecordName: projects[1][0],
    dashboardId,
    automationId,
    formPath: form.path,
    sharedPath: shared.path,
  };
}

/** Signs this window in as the owner, with the session the setup made. */
async function asTheOwner(page: Page): Promise<void> {
  await page.context().addCookies(owner);
}

/** Waits for what a screen loads after its first paint: spinners, busy regions, and entering dialogs. */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('[data-entering], [data-exiting]')).toHaveCount(0);
}

const coveredScreens = new WeakMap<Page, Set<string>>();

async function scan(page: Page, size: Size, screen: string): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const covered = coveredScreens.get(page) ?? new Set<string>();
  coveredScreens.set(page, covered);
  // The shared scanner retains every rule and violation while avoiding auxiliary pages for
  // documents without frames.  It also waits for fonts, styles, and rendering to settle.
  await assertAccessible(page, covered);
  if (size.phone) await fitsPhone(page, screen);
  const name = `${test.info().project.name}-${size.name}-${screen.replace(/[^a-z0-9]+/gi, '-')}`;
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Each rule axe found broken, with the elements that break it and why. */
function violations(results: Awaited<ReturnType<AxeBuilder['analyze']>>): string[] {
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} (${node.failureSummary?.split('\n')[1]?.trim() ?? ''})`).join(', ')}`,
  );
}

/**
 * Every control on the screen is at least 24 by 24, by its own box rather than the space around
 * it, and each of the screen's primary actions is at least 44 by 44.  Controls out of sight don't
 * count: hidden ones, ones scrolled or clipped out of view, and ones a pointer passes through.
 */
async function targets(page: Page, screen: string, primary: Array<[string, Locator]>): Promise<void> {
  const small = await page.evaluate(
    ({ selector, min }) => {
      const found: string[] = [];
      const apart = (a: DOMRect, b: DOMRect) =>
        a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
      const screenBox = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (element.closest('[aria-hidden="true"], [inert]')) continue;
        const style = getComputedStyle(element);
        if (style.visibility !== 'visible' || style.pointerEvents === 'none') continue;
        const box = element.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1 || apart(box, screenBox)) continue;
        let hidden = false;
        for (let parent = element.parentElement; parent && !hidden; parent = parent.parentElement) {
          const outer = getComputedStyle(parent);
          if (outer.overflowX === 'visible' && outer.overflowY === 'visible' && outer.clipPath === 'none')
            continue;
          const edge = parent.getBoundingClientRect();
          hidden = edge.width <= 1 || edge.height <= 1 || apart(box, edge);
        }
        if (hidden || (box.width >= min && box.height >= min)) continue;
        const name = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
        found.push(
          `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join('.')} “${name}” is ${Math.round(box.width)} by ${Math.round(box.height)}`,
        );
      }
      return found;
    },
    { selector: CONTROLS, min: TARGET_MIN },
  );
  expect.soft(small, `every control on ${screen} is at least ${TARGET_MIN} by ${TARGET_MIN}`).toEqual([]);
  const cramped: string[] = [];
  for (const [label, control] of primary) {
    const box = await control.boundingBox();
    if (!box) cramped.push(`${label} isn’t on the screen`);
    else if (box.width < TARGET_TOUCH - 0.5 || box.height < TARGET_TOUCH - 0.5)
      cramped.push(`${label} is ${Math.round(box.width)} by ${Math.round(box.height)}`);
  }
  expect
    .soft(cramped, `the primary actions on ${screen} are at least ${TARGET_TOUCH} by ${TARGET_TOUCH}`)
    .toEqual([]);
}

/** The header's and the database's actions, which every database screen on a phone shares */
async function sharedActions(page: Page): Promise<Array<[string, Locator]>> {
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Help', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
  await targets(page, 'the personal menu', [
    ['Help', page.getByRole('menuitem', { name: 'Help', exact: true })],
    ['Sign out', page.getByRole('menuitem', { name: 'Sign out', exact: true })],
  ]);
  await page.keyboard.press('Escape');
  const header: Array<[string, Locator]> = [
    ['Menu', page.getByRole('button', { name: 'Menu', exact: true })],
    ['Search', page.getByRole('button', { name: /^Search (?:⌘K|Ctrl\+K)$/ })],
    ['Notifications', page.getByRole('button', { name: /^Notifications/ })],
    ['Personal menu', page.getByRole('button', { name: /: Personal menu$/ })],
    ['AI: Ask Rio', page.getByRole('button', { name: 'AI: Ask Rio', exact: true })],
    ['Undo history', page.getByRole('button', { name: 'Undo history', exact: true })],
    ['Share', page.getByRole('button', { name: 'Share', exact: true })],
    ['Database settings', page.getByRole('button', { name: 'Database settings', exact: true })],
  ];
  const views = page.getByRole('navigation', { name: 'Views' }).getByRole('button');
  const controls = await page.getByRole('toolbar', { name: 'View controls' }).getByRole('button').all();
  return [
    ...header,
    ['the view switcher', views],
    ...controls.map((control, index): [string, Locator] => [`view control ${index + 1}`, control]),
  ];
}

/**
 * Nothing sideways but what's meant to be: no part of the page scrolls sideways or sits scrolled
 * sideways out of view, and nothing runs past the screen's edge, except the grid, timelines, wide
 * tables, and a kanban's stacks.  Every open dialog fits on the screen.
 */
async function fitsPhone(page: Page, screen: string): Promise<void> {
  const problems = await page.evaluate(
    ({ wide }) => {
      const found: string[] = [];
      const width = window.innerWidth;
      const height = window.innerHeight;
      const describe = (element: Element) => {
        const label = element.getAttribute('aria-label');
        const classes = [...element.classList].slice(0, 2).join('.');
        return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${label ? ` “${label}”` : ''}`;
      };
      const meant = (element: Element) => Boolean(element.closest(wide));
      const root = document.scrollingElement ?? document.documentElement;
      if (root.scrollWidth > width) found.push(`the page scrolls sideways by ${root.scrollWidth - width}px`);
      const elements = [...document.body.querySelectorAll('*')];
      const scrollers: Element[] = [];
      for (const element of elements) {
        const style = getComputedStyle(element);
        if (style.display === 'none') continue;
        const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
        if (scrollable && element.scrollWidth > element.clientWidth + 1) {
          scrollers.push(element);
          if (!meant(element) && !element.querySelector(wide))
            found.push(
              `${describe(element)} scrolls sideways by ${element.scrollWidth - element.clientWidth}px`,
            );
        } else if (!scrollable && element.scrollLeft !== 0 && !meant(element)) {
          found.push(`${describe(element)} is scrolled ${element.scrollLeft}px sideways, out of view`);
        }
      }
      // Anything past the right edge is cut off, unless it's inside something that scrolls, or its
      // own box clips it well inside the screen, as a truncated label does.
      const cut: Element[] = [];
      for (const element of elements) {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || box.right <= width + 1) continue;
        if (
          meant(element) ||
          scrollers.some((scroller) => scroller !== element && scroller.contains(element))
        )
          continue;
        if (cut.some((outer) => outer.contains(element))) continue;
        let clip = element.parentElement;
        while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
        if (clip && clip.getBoundingClientRect().right < width - 1) continue;
        if (getComputedStyle(element).visibility === 'hidden') continue;
        cut.push(element);
        found.push(
          `${describe(element)} runs ${Math.round(box.right - width)}px past the edge of the screen`,
        );
      }
      for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
        const box = dialog.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        if (box.left < -1 || box.top < -1 || box.right > width + 1 || box.bottom > height + 1)
          found.push(
            `${describe(dialog)} doesn't fit on the screen: ${Math.round(box.left)}, ${Math.round(box.top)} to ${Math.round(box.right)}, ${Math.round(box.bottom)}`,
          );
      }
      return found;
    },
    { wide: WIDE },
  );
  expect.soft(problems, `${screen} fits a phone`).toEqual([]);
}

function databasePath(...parts: string[]): string {
  return `${base()}/${[fixture.databaseId, ...parts].join('/')}`;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await signIn(page);
  // The default theme, whatever an earlier spec chose, so every run judges the same colors.
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme: 'grove' });
  fixture = await seed(page);
  // Seed once so both widths exercise the long folder picker within their scan time budget
  for (let index = 0; index < 12; index++)
    await createDatabase(page, `Folder choice ${index}`, [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
  owner = await context.cookies();
  await context.close();
});

// Each screen's own worker or update notice has no part in these scans, and motion is left out so
// nothing is caught halfway through an entrance.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const size of SIZES) {
  test.describe(`at ${size.name} width`, () => {
    test.use({ viewport: size.viewport, isMobile: size.phone, hasTouch: size.phone });

    test('the sign-in page, a public form, and a shared view', async ({ page }) => {
      await visit(page, `${base()}/sign-in`);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await scan(page, size, 'the sign-in page');

      await visit(page, `${base()}${fixture.formPath}`);
      await expect(page.getByRole('heading', { name: 'Request a harbor project', level: 1 })).toBeVisible();
      await scan(page, size, 'a public form');

      await visit(page, `${base()}${fixture.sharedPath}`);
      await expect(page.getByRole('grid')).toBeVisible();
      await scan(page, size, 'a shared view');
    });

    test('home and every settings section', async ({ page }) => {
      // Home and ten settings sections, each scanned, take a slower engine most of the default half
      // minute, and more than all of it on a busy machine.
      test.setTimeout(60_000);
      await asTheOwner(page);
      const folderId = newId('act');
      const folderName =
        'OrganizationFoldersAwaitingPlanningReferenceMaterialAndImplementationRequirementsForEveryTeam';
      if (size.phone)
        await asOwner(page, 'POST', '/api/home/commands', {
          id: newId('cmd'),
          action: { kind: 'folder.create', folderId, name: folderName, parentId: null },
        });
      await visit(page, `${base()}/`);
      await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
      await scan(page, size, 'home');
      for (const section of [
        'appearance',
        'language',
        'notifications',
        'security',
        'tokens',
        'people',
        'sso',
        'sign-in-policy',
        'sources',
        'ai',
      ]) {
        await visit(page, `${base()}/settings/${section}`);
        await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
        if (section === 'people') {
          if (size.phone) await expect(page.getByText(folderName, { exact: true })).toBeVisible();
          const databases = page.getByRole('listbox', { name: 'Databases in this folder' });
          await expect(databases).toBeVisible();
          expect(await databases.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
            true,
          );
          await page.getByRole('searchbox', { name: 'Filter items' }).focus();
          await page.keyboard.press('Tab');
          await expect(databases).toBeFocused();
          await page.keyboard.press('ArrowDown');
        }
        await scan(page, size, `the ${section} settings`);
      }
    });

    test('the grid with colors and a summary row, find and replace, undo history, and notifications', async ({
      page,
    }) => {
      await asTheOwner(page);
      await visit(page, databasePath(fixture.tableId, fixture.gridViewId));
      const grid = page.getByRole('grid', { name: 'All projects' });
      const first = grid.getByRole('gridcell', { name: fixture.recordName, exact: true });
      await expect(first).toBeVisible();
      await scan(page, size, 'the grid');

      if (size.phone) {
        // A phone keeps the database's tables, dashboards, and automations in the menu.
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        const menu = page.getByRole('dialog', { name: 'Menu' });
        await expect(menu.getByRole('link', { name: 'Harbor overview' })).toBeVisible();
        await scan(page, size, 'the menu');
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }

      // Arrow keys move the active cell, and the grid says where it has gone.
      await first.click();
      const current = grid.getByRole('gridcell', { selected: true });
      await expect(current).toHaveText(fixture.recordName);
      await page.keyboard.press('ArrowDown');
      await expect(current).toHaveText(fixture.otherRecordName);
      await expect(page.locator('.rio-grid__live')).toHaveText(`Name, row 2: ${fixture.otherRecordName}`);
      await page.keyboard.press('ArrowUp');
      await expect(current).toHaveText(fixture.recordName);
      await expect(page.locator('.rio-grid__live')).toHaveText(`Name, row 1: ${fixture.recordName}`);

      await page.keyboard.press('ControlOrMeta+f');
      const find = page.getByRole('search', { name: 'Find in this view' });
      await find.getByRole('textbox', { name: 'Find' }).fill('re');
      await find.getByRole('button', { name: 'Replace' }).click();
      await expect(find.getByRole('textbox', { name: 'Replace with' })).toBeVisible();
      await expect(find).toContainText(/\d+ (?:of \d+|match)/);
      await scan(page, size, 'find and replace');
      await find.getByRole('button', { name: 'Close find' }).click();

      // A change from this window gives the undo history something to list.
      await visit(page, databasePath(fixture.tableId, fixture.gridViewId, fixture.otherRecordId));
      const card = page.getByRole('dialog', { name: fixture.otherRecordName });
      const saved = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/databases/${fixture.databaseId}/commands`) &&
          (response.request().postData() ?? '').includes('record.update'),
      );
      const contact = card.getByRole('textbox', { name: 'Contact' });
      // The other width may have made this change already, so it swaps between two names.
      await contact.fill((await contact.inputValue()) === 'Jonas Hart' ? 'Jonas Reyes' : 'Jonas Hart');
      await contact.press('Enter');
      expect((await saved).ok()).toBe(true);
      await page.keyboard.press('Escape');
      await expect(card).toBeHidden();
      await page.getByRole('button', { name: 'Undo history' }).click();
      const history = page.getByRole('dialog', { name: 'Undo history' });
      await expect(history.getByRole('option')).not.toHaveCount(0);
      await scan(page, size, 'the undo history');
      await page.keyboard.press('Escape');
      await expect(history).toBeHidden();

      await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
      const notifications = page.getByRole('dialog', { name: 'Notifications' });
      await expect(notifications.getByRole('link').first()).toBeVisible();
      await scan(page, size, 'the notifications');
    });

    test('the record card with comments and history', async ({ page }) => {
      await asTheOwner(page);
      await visit(page, databasePath(fixture.tableId, fixture.gridViewId, fixture.recordId));
      const card = page.getByRole('dialog', { name: fixture.recordName });
      await expect(card.getByText('The new cable arrived')).toBeVisible();
      await scan(page, size, 'the record card’s comments');
      await card.getByRole('tab', { name: 'History' }).click();
      await expect(
        card.getByRole('tabpanel', { name: 'History' }).getByRole('listitem').first(),
      ).toBeVisible();
      await scan(page, size, 'the record card’s history');
    });

    test('every other type of view', async ({ page }) => {
      test.setTimeout(60_000);
      await asTheOwner(page);
      // Use the real English preference, then restore it, instead of intercepting session responses.
      const session = await asOwner<{
        preferences: { locale?: string };
        user: { locale: string };
      }>(page, 'GET', '/api/auth/session');
      await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'en-US' });
      try {
        await offlineMap(page);
        // Switch views in the running app; a full startup for every view only repeats shell work.
        for (const [index, type] of VIEW_TYPES.entries()) {
          if (index === 0) {
            await visit(page, databasePath(fixture.tableId, fixture.views[type]));
          } else {
            const navigation = page.getByRole('navigation', { name: 'Views' });
            if (size.phone) {
              await navigation
                .getByRole('button', { name: VIEW_NAMES[VIEW_TYPES[index - 1]!], exact: true })
                .click();
              const sheet = page.getByRole('dialog', { name: 'Views', exact: true });
              await sheet.getByRole('link', { name: VIEW_NAMES[type], exact: true }).click();
              await expect(sheet).toBeHidden();
            } else {
              await navigation.getByRole('link', { name: VIEW_NAMES[type], exact: true }).click();
            }
          }
          // A phone names the current view on the button that switches views, instead of a tab.
          const views = page.getByRole('navigation', { name: 'Views' });
          if (size.phone)
            await expect(views.getByRole('button', { name: VIEW_NAMES[type], exact: true })).toBeVisible();
          else
            await expect(views.getByRole('link', { name: VIEW_NAMES[type], exact: true })).toHaveAttribute(
              'aria-current',
              'page',
            );
          if (type !== 'form') {
            const active = page
              .getByRole('toolbar', { name: 'View controls' })
              .getByRole('button', { name: /^(Filtered by Name(, 1 filter)?|1 filter)$/ });
            await expect(active).toHaveAttribute('data-active');
            const foreground = await active.evaluate((button) => getComputedStyle(button).color);
            await expect(active.locator('svg')).toHaveCSS('color', foreground);
            await active.focus();
            await expect(page.getByRole('tooltip')).toHaveText('Filtered by Name');
          }
          await scan(page, size, `the ${type} view`);
        }
      } finally {
        await asOwner(page, 'PATCH', '/api/me/preferences', {
          locale: session.preferences.locale ?? session.user.locale,
        });
      }
    });

    test('a dashboard with each kind of tile, and an automation', async ({ page }) => {
      await asTheOwner(page);
      await visit(page, databasePath('dashboards', fixture.dashboardId));
      const dashboard = page.getByRole('region', { name: 'Harbor overview' });
      await expect(dashboard.getByRole('article', { name: 'Every project' })).toContainText('Crane refit');
      await scan(page, size, 'the dashboard');

      await visit(page, databasePath('automations', fixture.automationId));
      await expect(page.getByRole('region', { name: 'When' })).toBeVisible();
      await scan(page, size, 'the automation');
      await page.getByRole('tab', { name: 'Runs' }).click();
      await expect(page.getByRole('tabpanel', { name: 'Runs' }).getByRole('button').first()).toBeVisible();
      await scan(page, size, 'the automation’s runs');
    });
  });
}

test.describe('on a phone', () => {
  const phone = SIZES[1];
  test.use({ viewport: phone.viewport, isMobile: true, hasTouch: true });

  test('the grid, the view switcher, and a kanban are comfortable to use by touch', async ({
    page,
    browserName,
  }) => {
    test.setTimeout(90_000);
    await asTheOwner(page);
    await visit(page, databasePath(fixture.tableId, fixture.gridViewId));
    const grid = page.getByRole('grid', { name: 'All projects' });
    await expect(grid.getByRole('gridcell', { name: fixture.recordName, exact: true })).toBeVisible();
    await settled(page);
    // Every rule axe has, on the grid alone, with nothing let off.
    const results = await new AxeBuilder({ page }).include('[role="grid"]').analyze();
    expect.soft(violations(results), 'the grid has no accessibility problems').toEqual([]);
    await targets(page, 'the grid', await sharedActions(page));

    // One button names the view and opens a sheet of them all, with a search, since there are more
    // than eight.
    const views = page.getByRole('navigation', { name: 'Views' });
    await expect(views.getByRole('link')).toHaveCount(0);
    await views.getByRole('button', { name: 'All projects', exact: true }).tap();
    const sheet = page.getByRole('dialog', { name: 'Views' });
    const links = sheet.getByRole('link');
    await expect(links).toHaveCount(VIEW_TYPES.length + 1);
    await expect(sheet.getByRole('link', { name: 'All projects', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const search = sheet.getByRole('searchbox', { name: 'Find a view' });
    await search.fill('STATUS');
    await expect(links).toHaveText([VIEW_NAMES.kanban, VIEW_NAMES.chart, VIEW_NAMES.pivot]);
    // The sheet also holds the drag layer's always-present announcement region, so pick the count.
    await expect(sheet.getByRole('status').filter({ hasText: /views?$/ })).toHaveText('3 views');
    await search.fill('');
    await expect(links).toHaveCount(VIEW_TYPES.length + 1);
    await scan(page, phone, 'the view switcher');
    await targets(page, 'the view switcher', [
      ...(await links.all()).map((link, index): [string, Locator] => [`view ${index + 1}`, link]),
      ['Add view', sheet.getByRole('button', { name: 'Add view' })],
      ['Close', sheet.getByRole('button', { name: 'Close' })],
    ]);

    // A view made from the sheet opens at once, and the same sheet deletes it again.
    await sheet.getByRole('button', { name: 'Add view' }).tap();
    await page.getByRole('menuitem', { name: 'List', exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(views.getByRole('button', { name: 'List', exact: true })).toBeVisible();
    await views.getByRole('button', { name: 'List', exact: true }).tap();
    await sheet.getByRole('button', { name: 'More for List', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Delete view' }).tap();
    await page
      .getByRole('dialog', { name: 'Delete List?' })
      .getByRole('button', { name: 'Delete view' })
      .tap();
    // Deleting the view that's open goes to another, which closes the sheet.
    await expect(sheet).toBeHidden();
    await views.getByRole('button', { name: 'All projects', exact: true }).tap();
    await expect(sheet.getByRole('link', { name: 'List', exact: true })).toHaveCount(0);
    await sheet.getByRole('link', { name: VIEW_NAMES.kanban, exact: true }).tap();
    await expect(sheet).toBeHidden();

    // The kanban shows one stack across the screen, turned with the arrows or a swipe.
    const stacks = page.getByRole('group', { name: 'Stacks' });
    await expect(stacks).toContainText(/Stack 1 of \d+/);
    const planned = page.getByRole('region', { name: 'Planned' });
    const active = page.getByRole('region', { name: 'Active' });
    const done = page.getByRole('region', { name: 'Done' });
    await expect(planned).toBeInViewport({ ratio: 0.9 });
    expect((await planned.boundingBox())?.width).toBe(phone.viewport.width);
    await expect(planned.getByText(/\d+ records?/)).toBeVisible();
    await settled(page);
    await scan(page, phone, 'the kanban on a phone');
    await targets(page, 'the kanban', [
      ...(await sharedActions(page)),
      ['Previous stack', stacks.getByRole('button', { name: 'Previous stack' })],
      ['Next stack', stacks.getByRole('button', { name: 'Next stack' })],
      ['New card', planned.getByRole('button', { name: 'New card' })],
    ]);
    await stacks.getByRole('button', { name: 'Next stack' }).tap();
    await expect(stacks).toContainText(/Stack 2 of \d+/);
    await expect(active).toBeInViewport({ ratio: 0.9 });
    await expect(page.getByRole('status').filter({ hasText: 'Showing Active' })).toHaveText(
      'Showing Active, 3 records',
    );

    // A card moves to another stack from its menu, and back by a long press and a drag.
    const card = 'Ferry ramp survey';
    await active.getByRole('button', { name: `More for ${card}` }).tap();
    await page.getByRole('menuitem', { name: 'Move to Done' }).tap();
    await expect(active.getByRole('button', { name: labelName(card) })).toHaveCount(0);
    // A swipe scrolls the row of stacks to the third, and the stack it settles on is current.
    await page
      .locator('.rio-kanban__board')
      .evaluate((board) => board.scrollTo({ left: board.clientWidth * 2 }));
    await expect(stacks).toContainText(/Stack 3 of \d+/);
    await expect(done).toBeInViewport({ ratio: 0.9 });
    const moved = done.getByRole('button', { name: labelName(card) });
    await expect(moved).toBeVisible();
    if (browserName === 'chromium') {
      // The stack scrolls on its own, so bring the card into view first, as a person would.
      await moved.scrollIntoViewIfNeeded();
      await expect(moved).toBeInViewport();
      const box = (await moved.boundingBox())!;
      const touch = await page.context().newCDPSession(page);
      const at = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y) }];
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: at(box.x + box.width / 2, box.y + 24),
      });
      const target = page.locator('.rio-kanban__drop-target', { hasText: 'Active' });
      await expect(target).toBeVisible();
      const drop = (await target.boundingBox())!;
      for (const step of [0.5, 1])
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: at(
            box.x + box.width / 2 + (drop.x + drop.width / 2 - box.x - box.width / 2) * step,
            box.y + 24 + (drop.y + drop.height / 2 - box.y - 24) * step,
          ),
        });
      await expect(target).toHaveAttribute('data-drop-target');
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await touch.detach();
    } else {
      // Only Chromium's protocol can hold a finger still and then drag it, so the other engines
      // move the card back through its menu.
      await done.getByRole('button', { name: `More for ${card}` }).tap();
      await page.getByRole('menuitem', { name: 'Move to Active' }).tap();
    }
    await expect(moved).toHaveCount(0);
    await stacks.getByRole('button', { name: 'Previous stack' }).tap();
    await expect(stacks).toContainText(/Stack 2 of \d+/);
    await expect(active.getByRole('button', { name: labelName(card) })).toBeVisible();
  });
});

for (const mode of ['forced-colors', 'rtl'] as const) {
  for (const size of SIZES) {
    test(`${mode} on the main screens at ${size.name} width`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size.viewport);
      await asTheOwner(page);
      await offlineMap(page);
      await visit(page, `${base()}/`);
      const locale = mode === 'rtl' ? 'en-XB' : 'en-US';
      await asOwner(page, 'PATCH', '/api/me/preferences', { locale });
      await page.context().addInitScript((locale) => localStorage.setItem('rio.locale', locale), locale);
      if (mode === 'forced-colors') await page.emulateMedia({ forcedColors: 'active' });
      const paths = [
        '/',
        '/settings/appearance',
        '/settings/language',
        '/settings/notifications',
        '/settings/security',
        '/settings/tokens',
        '/settings/people',
        '/settings/sso',
        '/settings/sign-in-policy',
        '/settings/sources',
        databasePath(fixture.tableId, fixture.gridViewId),
        databasePath(fixture.tableId, fixture.gridViewId, fixture.recordId),
        ...VIEW_TYPES.map((type) => databasePath(fixture.tableId, fixture.views[type])),
        databasePath('dashboards', fixture.dashboardId),
        databasePath('automations', fixture.automationId),
        `${base()}${fixture.formPath}`,
        `${base()}${fixture.sharedPath}`,
      ];
      try {
        for (const path of paths) {
          await visit(page, path.startsWith('http') ? path : `${base()}${path}`);
          await settled(page);
          if (mode === 'rtl') {
            await expect(page.locator('html')).toHaveAttribute('lang', 'en-XB');
            await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
            await expect(page.getByRole('main').first()).toHaveCSS('direction', 'rtl');
            if (path.endsWith('/settings/appearance'))
              await expect(page.getByRole('heading', { level: 1 }).first()).not.toHaveText('Appearance');
          } else {
            expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
            const dialog = page.getByRole('dialog').last();
            const controls = (await dialog.count()) ? dialog : page;
            const control = controls.getByRole('button', { disabled: false }).first();
            await control.focus();
            await expect(control).toBeFocused();
            const focus = await control.evaluate((element) => {
              const style = getComputedStyle(element);
              return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
            });
            expect.soft(focus, `Visible high-contrast focus at ${path}`).toBe(true);
          }
          await scan(page, size, `${mode}-${new URL(page.url()).pathname}`);
        }
        await visit(page, databasePath(fixture.tableId, fixture.gridViewId));
        const first = page.locator('[role="columnheader"][data-rio-column="0"]');
        const second = page.locator('[role="columnheader"][data-rio-column="1"]');
        await expect(first).toBeVisible();
        const a = (await first.boundingBox())!;
        const b = (await second.boundingBox())!;
        if (mode === 'rtl') {
          expect(a.x).toBeGreaterThan(b.x);
          await page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]').click();
          await page.keyboard.press('ArrowLeft');
          await expect(page.locator('[role="gridcell"][data-active]')).toHaveAttribute('data-rio-col', '1');
        } else expect(a.x).toBeLessThan(b.x);
      } finally {
        await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'en-US' });
      }
    });
  }
}
