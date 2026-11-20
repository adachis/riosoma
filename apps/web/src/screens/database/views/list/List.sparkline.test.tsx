import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ColorConfig, FieldMeta, GridConfig, newId, type CellValue } from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { createViewColors } from '../../colors/paint';
import { useViewConfig } from '../../screen/useViewConfig';
import type { ViewComponentProps } from '../types';
import { ListView } from './index';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
});

/**
 * A sparkline replaces its field's text with a chart, so the line's name keeps the words it
 * shows and leaves the chart's label to the line's description.
 */
it('names a line with a sparkline by its visible words, and describes the chart', async () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const base = schema.fields[0]!;
  let position = schema.fields.length;
  const field = (name: string, spec: Record<string, unknown>) =>
    FieldMeta.parse({ ...base, id: newId('field'), name, position: position++, ...spec });
  const status = field('Status', {
    type: 'singleSelect',
    options: { choices: [{ id: 'cho00000000000001', name: 'Ready', color: 'blue' }] },
  });
  const points = field('Points', { type: 'link', options: { linkedTableId: fixture.tableId } });
  const numbers = FieldMeta.parse({ ...field('Numbers', { type: 'json', options: {} }), position: 1 });
  const config = GridConfig.parse({
    hiddenFieldIds: [fixture.numberFieldId],
    sparklines: [{ fieldId: numbers.id }],
  });
  const recordId = (index: number) =>
    `rec${fixture.tableId.slice(3, 10)}${index.toString(36).padStart(7, '0')}`;
  server.seed(
    {
      ...schema,
      fields: [...schema.fields, status, points, numbers],
      views: [{ ...schema.views[0]!, name: 'Tasks', type: 'list', config }],
    },
    new Map([
      [
        fixture.tableId,
        {
          count: 4,
          values: (index: number) =>
            ({
              [fixture.textFieldId]: index === 0 ? 'History' : ['First', 'Second', 'Third'][index - 1],
              [numbers.id]: index === 0 ? '[8,-2,5]' : null,
              [status.id]: index === 0 ? 'cho00000000000001' : null,
              [points.id]: index === 0 ? [1, 2, 3].map(recordId) : null,
            }) as Record<string, CellValue>,
        },
      ],
    ]),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  function Harness() {
    const current = useSchema(session)!;
    const view = current.viewById.get(fixture.viewId)!;
    const fields = current.fields.get(fixture.tableId)!;
    const { config: live, change } = useViewConfig(session, view, fields);
    const format = {
      locale: 'en-US',
      timeZone: 'UTC',
      collaborators: current.collaborators,
      linked: session.linked,
    };
    const props: ViewComponentProps = {
      session,
      table: current.tableById.get(fixture.tableId)!,
      view: { ...view, config: live },
      fields,
      format,
      canEdit: true,
      onConfig: (patch) => change(patch),
      onExpand: vi.fn(),
      colors: createViewColors({
        config: ColorConfig.parse({ sparklines: [{ fieldId: numbers.id }] }),
        fields,
        context: { timeZone: 'UTC' },
        ranges: new Map(),
        label: (rule) => rule.name,
        i18n,
      }),
    };
    return <ListView {...props} />;
  }
  render(
    <I18nProvider i18n={i18n}>
      <Harness />
    </I18nProvider>,
  );
  const line = await screen.findByRole('treeitem', { name: 'History Ready First, Second, Third' });
  const chart = line.querySelector('.rio-sparkline')!;
  expect(chart.getAttribute('aria-label')).toBe('Minimum -2, maximum 8, last 5; trend falling');
  const described = (line.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '');
  expect(described).toContain('Minimum -2, maximum 8, last 5; trend falling');
});
