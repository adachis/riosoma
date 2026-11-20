import { describe, expect, it } from 'vitest';
import { newId, type RioProposal } from '@riosoma/contracts';
import { AppError } from '@riosoma/contracts';
import { fillCommands } from './plans.js';
import { builderSchemas } from './tools.js';

/**
 * The view and dashboard shapes the model fetches on demand, generated from the product's own
 * contracts, and the plan builder that lays dashboards out and names what a wrong plan got wrong.
 */

const shapes = builderSchemas();
const viewText = JSON.stringify(shapes.view);
const dashboardText = JSON.stringify(shapes.dashboard);

function proposal(commands: Record<string, unknown>[]): RioProposal {
  return { databaseId: newId('database'), summary: 'Make changes', steps: ['Make changes'], commands };
}

describe('generated builder schema', () => {
  it('describes every named view type from the contracts', () => {
    // The shared settings and each named view type's own settings, straight from GridConfig.
    for (const marker of ['fieldOrder', 'hiddenFieldIds', 'groupBy', 'dateBucket', 'seriesBy'])
      expect(viewText).toContain(marker);
    for (const marker of ['stackFieldId', 'startFieldId', 'endFieldId']) expect(viewText).toContain(marker);
    // The view type enum comes from the ViewType contract.
    for (const type of ['chart', 'pivot', 'kanban', 'calendar', 'timeline']) expect(viewText).toContain(type);
  });

  it('describes every dashboard tile kind and the value functions', () => {
    for (const kind of ['number', 'chart', 'pivot', 'records', 'text']) expect(dashboardText).toContain(kind);
    // The aggregate vocabulary comes from the Aggregate contract, so the two cannot drift.
    for (const fn of ['count', 'countUnique', 'sum', 'average', 'min', 'max'])
      expect(dashboardText).toContain(fn);
    // Tile placement on the 12-column grid, and a worked example.
    for (const marker of ['place', 'tiles']) expect(dashboardText).toContain(marker);
    expect(shapes.dashboard.example.dashboard.config.tiles.length).toBeGreaterThan(0);
  });
});

describe('validation messages', () => {
  const tableId = newId('table');
  const fieldId = newId('field');

  it('names the path and what is allowed for a bad tile value function', () => {
    let caught: AppError | undefined;
    try {
      fillCommands(
        proposal([
          {
            kind: 'dashboard.create',
            dashboard: {
              name: 'Sales',
              config: {
                tiles: [{ kind: 'number', source: { tableId }, value: { fn: 'total', fieldId: null } }],
              },
            },
          },
        ]),
      );
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.messageKey).toBe('rio.plan.invalid');
    const problems = String(caught!.params?.problems ?? '');
    expect(problems).toContain('tiles[0].value.fn');
    // The message names an allowed option, so the model can correct itself in one round.
    expect(problems).toContain('sum');
  });

  it('names the path for a bad view type', () => {
    let caught: AppError | undefined;
    try {
      fillCommands(
        proposal([{ kind: 'view.create', view: { tableId, name: 'By format', type: 'graph', config: {} } }]),
      );
    } catch (error) {
      caught = error as AppError;
    }
    expect(caught?.messageKey).toBe('rio.plan.invalid');
    expect(String(caught!.params?.problems ?? '')).toContain('view.type');
  });

  it('accepts a well-formed chart view built from the contracts', () => {
    const commands = fillCommands(
      proposal([
        {
          kind: 'view.create',
          view: {
            tableId,
            name: 'Revenue by format',
            type: 'chart',
            config: {
              chart: {
                chart: 'column',
                groupBy: { fieldId, dateBucket: null },
                value: { fn: 'sum', fieldId },
                sort: 'valueDescending',
              },
            },
          },
        },
      ]),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('view.create');
  });
});

describe('automatic dashboard layout', () => {
  const tableId = newId('table');
  const fieldId = newId('field');

  it('places tiles that the model left unplaced without overlap', () => {
    const commands = fillCommands(
      proposal([
        {
          kind: 'dashboard.create',
          dashboard: {
            name: 'Overview',
            config: {
              tiles: [
                { kind: 'number', source: { tableId }, value: { fn: 'sum', fieldId } },
                {
                  kind: 'chart',
                  source: { tableId },
                  groupBy: { fieldId, dateBucket: null },
                  value: { fn: 'sum', fieldId },
                },
                {
                  kind: 'pivot',
                  source: { tableId },
                  pivot: { rows: [{ fieldId, dateBucket: null }], values: [{ fn: 'count', fieldId: null }] },
                },
                { kind: 'text', text: 'Notes' },
              ],
            },
          },
        },
      ]),
    );
    const command = commands[0]!;
    if (command.kind !== 'dashboard.create') throw new Error('expected a dashboard');
    const tiles = command.dashboard.config.tiles;
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.place.w).toBeGreaterThan(0);
      expect(tile.place.x + tile.place.w).toBeLessThanOrEqual(12);
    }
    // No two tiles overlap.
    for (let a = 0; a < tiles.length; a++)
      for (let b = a + 1; b < tiles.length; b++) {
        const first = tiles[a]!.place;
        const second = tiles[b]!.place;
        const apart =
          first.x + first.w <= second.x ||
          second.x + second.w <= first.x ||
          first.y + first.h <= second.y ||
          second.y + second.h <= first.y;
        expect(apart, `tiles ${a} and ${b} overlap`).toBe(true);
      }
  });

  it('keeps a placement the model supplied and flows the rest below it', () => {
    const commands = fillCommands(
      proposal([
        {
          kind: 'dashboard.create',
          dashboard: {
            name: 'Mixed',
            config: {
              tiles: [
                {
                  kind: 'number',
                  source: { tableId },
                  value: { fn: 'count', fieldId: null },
                  place: { x: 0, y: 0, w: 12, h: 3 },
                },
                { kind: 'text', text: 'Below' },
              ],
            },
          },
        },
      ]),
    );
    const command = commands[0]!;
    if (command.kind !== 'dashboard.create') throw new Error('expected a dashboard');
    const [pinned, flowed] = command.dashboard.config.tiles;
    expect(pinned!.place).toMatchObject({ x: 0, y: 0, w: 12, h: 3 });
    expect(flowed!.place.y).toBeGreaterThanOrEqual(3);
  });
});
