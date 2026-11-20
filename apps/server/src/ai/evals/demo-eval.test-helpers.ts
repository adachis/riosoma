/**
 * A live evaluation of Rio's aggregation tool and plan building against real providers.  It is not a
 * unit test: it costs money and hits the network, so it is skipped unless a provider key is present.
 * It seeds a sales table of a few thousand rows, then runs four prompts through the real provider
 * path and grades each by the resulting state—the answer's numbers against a direct SQL total, or
 * the view and dashboard the plan created.  It runs the product's default everyday model for each
 * provider that has a key, three times each, and reports the pass counts and typical reply times.
 *
 *   Keys arrive as RIOSOMA_DEMO_OPENAI_API_KEY and RIOSOMA_DEMO_ANTHROPIC_API_KEY.  They are never
 *   printed or written anywhere.  Run with:
 *   pnpm --filter @riosoma/server exec tsx src/ai/evals/demo-eval.test-helpers.ts
 */
import { defaultModel } from '@riosoma/ai';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres } from '@riosoma/testkit';
import { newId, type RioBlock } from '@riosoma/contracts';
import { startServer, type ServerFixture } from '../../test/fixture.js';

type Provider = 'openai' | 'anthropic';

const KEYS: Record<Provider, string | undefined> = {
  openai: process.env.RIOSOMA_DEMO_OPENAI_API_KEY?.trim() || undefined,
  anthropic: process.env.RIOSOMA_DEMO_ANTHROPIC_API_KEY?.trim() || undefined,
};
const RUNS = Number(process.env.RIOSOMA_DEMO_EVAL_RUNS) || 3;

const databaseId = newId('database');
const ids = {
  sales: newId('table'),
  title: newId('field'),
  format: newId('field'),
  territory: newId('field'),
  revenue: newId('field'),
  units: newId('field'),
  orderDate: newId('field'),
};
const choices = {
  bluray: newId('choice'),
  dvd: newId('choice'),
  digital: newId('choice'),
  na: newId('choice'),
  eu: newId('choice'),
  apac: newId('choice'),
};
const TITLES = [
  'Nebula Rising',
  'Crimson Harbor',
  'Silent Meridian',
  'Golden Thicket',
  'Hollow Lantern',
  'Velvet Expanse',
  'Amber Cascade',
  'Quiet Zenith',
  'Ivory Current',
  'Marble Horizon',
  'Copper Reverie',
  'Scarlet Tide',
];
const ROWS = 3_000;

interface PromptResult {
  pass: boolean;
  ms: number;
  note: string;
}

function logReport(byPrompt: Map<string, PromptResult[]>): void {
  const line = '-'.repeat(72);
  console.log(`\n${line}\nRIO AGGREGATION AND PLAN EVALUATION\n${line}`);
  for (const [prompt, results] of byPrompt) {
    const passes = results.filter((result) => result.pass).length;
    const times = results.map((result) => result.ms).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)]! : 0;
    console.log(`\n${prompt}`);
    console.log(`  passed ${passes}/${results.length}   typical reply ${(median / 1000).toFixed(1)}s`);
    for (const result of results)
      console.log(`    ${result.pass ? 'PASS' : 'FAIL'}  ${(result.ms / 1000).toFixed(1)}s  ${result.note}`);
  }
  console.log(`\n${line}`);
}

async function seed(server: ServerFixture): Promise<void> {
  const field = (id: string, name: string, type: string, options: unknown = {}) => ({
    id,
    name,
    type,
    description: '',
    options,
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Sales demo',
      table: {
        id: ids.sales,
        name: 'Sales',
        fields: [
          field(ids.title, 'Title', 'text'),
          field(ids.format, 'Format', 'singleSelect', {
            choices: [
              { id: choices.bluray, name: 'Blu-ray', color: 'blue' },
              { id: choices.dvd, name: 'DVD', color: 'gray' },
              { id: choices.digital, name: 'Digital', color: 'green' },
            ],
          }),
          field(ids.territory, 'Territory', 'singleSelect', {
            choices: [
              { id: choices.na, name: 'North America', color: 'blue' },
              { id: choices.eu, name: 'Europe', color: 'green' },
              { id: choices.apac, name: 'Asia Pacific', color: 'orange' },
            ],
          }),
          field(ids.revenue, 'Revenue', 'currency', { code: 'USD' }),
          field(ids.units, 'Units', 'number'),
          field(ids.orderDate, 'Order date', 'date'),
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  if (created.statusCode !== 200) throw new Error(`seed failed: ${created.body}`);
  // Load the rows straight into the physical table, as the large-scan tests do.
  const count = TITLES.length;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, ids.sales)}
      (__id, ${ident(ids.title)}, ${ident(ids.format)}, ${ident(ids.territory)}, ${ident(ids.revenue)}, ${ident(ids.units)}, ${ident(ids.orderDate)})
      SELECT ${'rec'} || n,
        (${TITLES}::text[])[1 + n % ${count}::int],
        (ARRAY[${choices.bluray}, ${choices.dvd}, ${choices.digital}]::text[])[1 + n % 3],
        (ARRAY[${choices.na}, ${choices.eu}, ${choices.apac}]::text[])[1 + (n / 4) % 3],
        -- Title drives the ranking; the month bonus, varied independently, drives the trend.
        ((${count}::int - n % ${count}::int) * 100 + ((n / ${count}::int) % 12 + 1) * 25 + n % 7)::double precision,
        (n % 10) + 1,
        make_date(2026, 1 + (n / ${count}::int) % 12, 1 + (n % 27))
      FROM generate_series(0, ${ROWS - 1}) n`,
  );
}

/** The five highest-earning titles, straight from SQL, as the answer must match. */
async function topTitles(server: ServerFixture): Promise<string[]> {
  const result = await query<{ title: string }>(
    server.pool,
    sql`SELECT ${ident(ids.title)} AS title FROM ${ident(server.schemas.data, ids.sales)}
      WHERE __deleted_at IS NULL GROUP BY 1 ORDER BY sum(${ident(ids.revenue)}) DESC LIMIT 5`,
  );
  return result.rows.map((row) => row.title);
}

/** The month with the highest revenue, as the trend answer should call out. */
async function peakMonth(server: ServerFixture): Promise<string> {
  const result = await query<{ month: number }>(
    server.pool,
    sql`SELECT extract(month FROM ${ident(ids.orderDate)})::int AS month
      FROM ${ident(server.schemas.data, ids.sales)} WHERE __deleted_at IS NULL
      GROUP BY 1 ORDER BY sum(${ident(ids.revenue)}) DESC LIMIT 1`,
  );
  const month = result.rows[0]!.month;
  return new Date(Date.UTC(2026, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

interface AskResult {
  text: string;
  blocks: RioBlock[];
  receipts: RioBlock[];
}

async function ask(
  server: ServerFixture,
  conversationId: string,
  text: string,
  autonomy: 'instant' | 'ask',
): Promise<AskResult> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/rio/conversations/${conversationId}/messages`,
    headers: server.owner.headers,
    payload: { text, locale: 'en-US', context: { databaseId }, autonomy },
  });
  const events = response.body
    .split('\n\n')
    .filter((entry) => entry.startsWith('data: '))
    .map((entry) => JSON.parse(entry.slice(6)) as { type: string; block?: RioBlock; delta?: string });
  const blocks = events.flatMap((event) => (event.type === 'block' && event.block ? [event.block] : []));
  // The reply text streams as deltas, with any text blocks folded in too.
  const textParts = [
    ...events.flatMap((event) => (event.type === 'text' && event.delta ? [event.delta] : [])),
    ...blocks.flatMap((block) => (block.kind === 'text' ? [block.text] : [])),
  ];
  const receipts: RioBlock[] = blocks.filter((block) => block.kind === 'receipt');
  // Apply any plan the model left for approval, collecting its receipt.
  for (const block of blocks) {
    if (block.kind !== 'plan') continue;
    const applied = await server.app.inject({
      method: 'POST',
      url: `/api/rio/plans/${block.planId}/apply`,
      headers: server.owner.headers,
    });
    if (applied.statusCode === 200) receipts.push(applied.json<RioBlock>());
  }
  return { text: textParts.join(''), blocks, receipts };
}

interface SchemaView {
  id: string;
  type: string;
  tableId: string;
  config: Record<string, unknown>;
}
interface SchemaDashboard {
  id: string;
  config: { tiles: Array<Record<string, unknown>> };
}

async function schema(
  server: ServerFixture,
): Promise<{ views: SchemaView[]; dashboards: SchemaDashboard[] }> {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/databases/${databaseId}/schema`,
    headers: server.owner.headers,
  });
  const body = response.json<{ views?: SchemaView[]; dashboards?: SchemaDashboard[] }>();
  return { views: body.views ?? [], dashboards: body.dashboards ?? [] };
}

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Whether a tile computes the sum of a field, grouped by another, as the dashboard prompt asks. */
function tileSums(tile: Record<string, unknown>, groupField: string, sumField: string): boolean {
  const value = obj(tile.value);
  const groupBy = obj(tile.groupBy);
  const pivot = obj(tile.pivot);
  const rows = Array.isArray(pivot.rows) ? pivot.rows.map((row) => obj(row).fieldId) : [];
  const groups = groupBy.fieldId === groupField || rows.includes(groupField);
  const sums =
    (value.fn === 'sum' && value.fieldId === sumField) ||
    (Array.isArray(pivot.values) &&
      pivot.values.some((entry) => obj(entry).fn === 'sum' && obj(entry).fieldId === sumField));
  return groups && sums;
}

async function gradeRanking(server: ServerFixture, conversationId: string): Promise<PromptResult> {
  const expected = await topTitles(server);
  const started = Date.now();
  const result = await ask(
    server,
    conversationId,
    'Which five titles earned the most revenue overall?  List them in order.',
    'ask',
  );
  const ms = Date.now() - started;
  if (process.env.RIOSOMA_DEMO_EVAL_DEBUG) console.log(`\n[ranking reply]\n${result.text}\n`);
  const lower = result.text.toLowerCase();
  const found = expected.filter((title) => lower.includes(title.toLowerCase()));
  return {
    pass: found.length === expected.length,
    ms,
    note: `named ${found.length}/5 of [${expected.join(', ')}]`,
  };
}

async function gradeTrend(server: ServerFixture, conversationId: string): Promise<PromptResult> {
  const expected = await peakMonth(server);
  const started = Date.now();
  const result = await ask(
    server,
    conversationId,
    'How did total revenue trend by month across the year?  Note the strongest month.',
    'ask',
  );
  const ms = Date.now() - started;
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  if (process.env.RIOSOMA_DEMO_EVAL_DEBUG) console.log(`\n[trend reply]\n${result.text}\n`);
  const lower = result.text.toLowerCase();
  const mentioned = months.filter((month) => lower.includes(month.slice(0, 3))).length;
  const peak = lower.includes(expected.toLowerCase());
  return {
    pass: peak && mentioned >= 2,
    ms,
    note: `peak ${expected} ${peak ? 'named' : 'missed'}, ${mentioned} months`,
  };
}

async function gradeView(server: ServerFixture, conversationId: string): Promise<PromptResult> {
  const before = new Set((await schema(server)).views.map((view) => view.id));
  const started = Date.now();
  await ask(
    server,
    conversationId,
    "Make a view of this quarter's sales grouped by format, sorted by revenue.",
    'instant',
  );
  const ms = Date.now() - started;
  const view = (await schema(server)).views.find(
    (item) => !before.has(item.id) && item.tableId === ids.sales,
  );
  if (!view) return { pass: false, ms, note: 'no view created' };
  const config = view.config;
  const chart = obj(config.chart);
  const groupsByFormat =
    obj(chart.groupBy).fieldId === ids.format ||
    (Array.isArray(config.groups) && config.groups.some((group) => obj(group).fieldId === ids.format));
  const value = obj(chart.value);
  const byRevenue =
    value.fieldId === ids.revenue ||
    obj(config.chart).sort === 'valueDescending' ||
    (Array.isArray(config.sorts) && config.sorts.some((sort) => obj(sort).fieldId === ids.revenue));
  return {
    pass: groupsByFormat && byRevenue,
    ms,
    note: `${view.type} view, groups by format ${groupsByFormat}, by revenue ${byRevenue}`,
  };
}

async function gradeDashboard(server: ServerFixture, conversationId: string): Promise<PromptResult> {
  const before = new Set((await schema(server)).dashboards.map((dashboard) => dashboard.id));
  const started = Date.now();
  await ask(
    server,
    conversationId,
    'Build a dashboard with total revenue, revenue by format, and units by territory.',
    'instant',
  );
  const ms = Date.now() - started;
  const dashboard = (await schema(server)).dashboards.find((item) => !before.has(item.id));
  if (!dashboard) return { pass: false, ms, note: 'no dashboard created' };
  const tiles = dashboard.config.tiles ?? [];
  const totalRevenue = tiles.some(
    (tile) => obj(tile.value).fn === 'sum' && obj(tile.value).fieldId === ids.revenue && !obj(tile).groupBy,
  );
  const revenueByFormat = tiles.some((tile) => tileSums(tile, ids.format, ids.revenue));
  const unitsByTerritory = tiles.some((tile) => tileSums(tile, ids.territory, ids.units));
  return {
    pass: totalRevenue && revenueByFormat && unitsByTerritory,
    ms,
    note: `${tiles.length} tiles; total ${totalRevenue}, by format ${revenueByFormat}, by territory ${unitsByTerritory}`,
  };
}

const PROMPTS: Array<{
  label: string;
  grade: (server: ServerFixture, conversationId: string) => Promise<PromptResult>;
}> = [
  { label: 'Ranking: top five titles by revenue', grade: gradeRanking },
  { label: 'Trend: revenue by month', grade: gradeTrend },
  { label: 'Build a view grouped by format, sorted by revenue', grade: gradeView },
  { label: 'Build a dashboard of revenue and units', grade: gradeDashboard },
];

async function conversation(server: ServerFixture): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/rio/conversations',
    headers: server.owner.headers,
  });
  return response.json<{ id: string }>().id;
}

async function main(): Promise<void> {
  const providers = (Object.keys(KEYS) as Provider[]).filter((provider) => KEYS[provider]);
  if (!providers.length) {
    console.log(
      'Skipped: no RIOSOMA_DEMO_OPENAI_API_KEY or RIOSOMA_DEMO_ANTHROPIC_API_KEY in the environment.',
    );
    return;
  }
  const kit = await startTestPostgres();
  const server = await startServer(kit, 'demoeval', {
    providerApiKeys: { openai: KEYS.openai, anthropic: KEYS.anthropic },
    routinesPollMs: 0,
  });
  const byPrompt = new Map<string, PromptResult[]>();
  for (const prompt of PROMPTS) byPrompt.set(prompt.label, []);
  try {
    await seed(server);
    for (const provider of providers) {
      const model = defaultModel('everyday', [provider]);
      if (!model) {
        console.log(`No everyday model for ${provider}; skipping.`);
        continue;
      }
      const saved = await server.app.inject({
        method: 'PUT',
        url: '/api/ai/settings',
        headers: server.owner.headers,
        payload: {
          enabled: true,
          providers: [{ providerId: provider }],
          models: { everyday: { providerId: provider, model: model.model }, power: null },
          autonomy: 'ask',
          monthlyBudgetUsd: null,
        },
      });
      if (saved.statusCode !== 200) throw new Error(`settings failed for ${provider}: ${saved.body}`);
      console.log(`\nProvider ${provider}, model ${model.model}:`);
      for (let run = 1; run <= RUNS; run++)
        for (const prompt of PROMPTS) {
          let result: PromptResult;
          try {
            result = await prompt.grade(server, await conversation(server));
          } catch (error) {
            result = { pass: false, ms: 0, note: `error: ${(error as Error).message}` };
          }
          byPrompt.get(prompt.label)!.push(result);
          console.log(
            `  run ${run}  ${result.pass ? 'PASS' : 'FAIL'}  ${(result.ms / 1000).toFixed(1)}s  ${prompt.label} — ${result.note}`,
          );
        }
    }
  } finally {
    logReport(byPrompt);
    await server.close();
    await kit.stop();
  }
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
