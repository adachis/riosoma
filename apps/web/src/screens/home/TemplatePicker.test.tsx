import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fas } from '@fortawesome/free-solid-svg-icons';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChoiceColor, TEMPLATE_CATEGORIES, TemplateCategory, type TemplateSummary } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { TemplatePicker } from './TemplatePicker';
import { renderHome } from './test-support';

const TEMPLATES = join(import.meta.dirname, '../../../../server/src/templates');
const LABELS: Record<TemplateCategory, string> = {
  work: 'Work',
  personal: 'Personal',
  organizations: 'Organizations',
};

/**
 * The starter templates the server offers, read from their source the way the server message test
 * reads the server's keys, so a template the picker can't show fails here.  A template's own
 * settings sit two spaces in, above its tables.
 */
function serverTemplates(): TemplateSummary[] {
  return readdirSync(TEMPLATES)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => readFileSync(join(TEMPLATES, name), 'utf8'))
    .filter((source) => source.includes(': StarterTemplate = {'))
    .map((source) => {
      const setting = (key: string) => {
        const match = new RegExp(`^ {2}${key}:\\s+(['"])(.*)\\1,$`, 'm').exec(source);
        if (!match) throw new Error(`Missing ${key}`);
        return match[2]!;
      };
      return {
        id: setting('id'),
        name: setting('name'),
        description: setting('description'),
        icon: setting('icon'),
        color: ChoiceColor.parse(setting('color')),
        category: TemplateCategory.parse(setting('category')),
        tables: ['Records'],
      };
    });
}

function serve(templates: TemplateSummary[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(templates), { headers: { 'content-type': 'application/json' } }),
    ),
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The options within one template category */
const cardsIn = (element: HTMLElement) => within(element).getAllByRole('option');

it('lists every starter template under its category, each with an icon from the icon set', async () => {
  const templates = serverTemplates();
  expect(templates).toHaveLength(20);
  const icons = new Set(Object.values(fas).map((icon) => icon.iconName as string));
  serve(templates);
  renderHome(<TemplatePicker selected={null} onSelect={vi.fn()} disabled={false} />);
  for (const category of TEMPLATE_CATEGORIES) {
    const section = await screen.findByRole('group', { name: LABELS[category] });
    const members = templates.filter((template) => template.category === category);
    expect(members.length).toBeGreaterThanOrEqual(4);
    expect(cardsIn(section)).toHaveLength(members.length);
    for (const template of members) {
      const card = within(section).getByRole('option', {
        name: (accessibleName) =>
          accessibleName === template.name || accessibleName.startsWith(`${template.name} `),
      });
      expect(card.textContent).toContain(template.description);
      expect(icons.has(template.icon), template.icon).toBe(true);
      expect(card.querySelector('svg')).not.toBeNull();
    }
  }
  for (const category of TEMPLATE_CATEGORIES) {
    const count = templates.filter((template) => template.category === category).length;
    expect(screen.getByRole('button', { name: `${LABELS[category]} (${count})` })).toBeDefined();
  }
  expect(screen.getByRole('searchbox', { name: 'Filter items' })).toBeDefined();
});

it('narrows the list to one category, keeps the choice, and shows everything again', async () => {
  const templates = serverTemplates();
  const personal = templates.filter((template) => template.category === 'personal');
  const onSelect = vi.fn();
  serve(templates);
  renderHome(<TemplatePicker selected={null} onSelect={onSelect} disabled={false} />);
  await userEvent.click(await screen.findByRole('button', { name: /^Work \(/ }));
  await userEvent.click(screen.getByRole('button', { name: /^Organizations \(/ }));
  expect(screen.queryByRole('group', { name: 'Work' })).toBeNull();
  const group = screen.getByRole('listbox', { name: 'Start from a template' });
  expect(cardsIn(group).map((card) => card.querySelector('.rio-listbox-item__label')?.textContent)).toEqual(
    personal.map((template) => template.name),
  );
  await userEvent.click(within(group).getByRole('option', { name: /^Travel planner(?: |$)/ }));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'travel-planner' }));
  await userEvent.click(screen.getByRole('button', { name: /^Work \(/ }));
  await userEvent.click(screen.getByRole('button', { name: /^Organizations \(/ }));
  for (const category of TEMPLATE_CATEGORIES)
    expect(screen.getByRole('group', { name: LABELS[category] })).toBeDefined();
  expect(cardsIn(group)).toHaveLength(templates.length);
});

it('shows one list without a filter when every template shares a category, and reads unknown ones as work', async () => {
  const [first, second] = serverTemplates().filter((template) => template.category === 'work');
  serve([first!, { ...second!, category: 'unknown' as TemplateCategory }]);
  renderHome(<TemplatePicker selected={null} onSelect={vi.fn()} disabled={false} />);
  expect(await screen.findByRole('button', { name: new RegExp(first!.name) })).toBeDefined();
  expect(screen.getByRole('button', { name: new RegExp(second!.name) })).toBeDefined();
  expect(screen.queryByRole('button', { name: /All templates/ })).toBeNull();
  expect(screen.queryByRole('region')).toBeNull();
});

it('filters a short template list by category and chooses a card', async () => {
  const templates = serverTemplates();
  const work = templates.find((template) => template.category === 'work')!;
  const personal = templates.find((template) => template.category === 'personal')!;
  serve([work, personal]);
  const select = vi.fn();
  renderHome(<TemplatePicker selected={null} onSelect={select} disabled={false} />);
  await userEvent.click(await screen.findByRole('button', { name: /Template categories/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Personal(?: |$)/ }));
  expect(screen.queryByRole('button', { name: new RegExp(work.name) })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: new RegExp(personal.name) }));
  expect(select).toHaveBeenCalledWith(personal);
});
