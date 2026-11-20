import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ColorConfig,
  FieldMeta,
  GridConfig,
  newId,
  type CellValue,
  type FilterGroup,
  type GridConfigPatch,
  type LocationValue,
  type MapSettings as Settings,
  type RowData,
} from '@riosoma/contracts';
import { appConfigQuery } from '../../../../app-config';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { createViewColors } from '../../colors/paint';
import { useViewConfig } from '../../screen/useViewConfig';
import { VIEW_DEFINITIONS } from '../registry';
import type { ViewComponentProps } from '../types';
import { FALLBACK_COLORS } from './colors';
import { MapSettings, MapView } from './index';
import { pinBounds, pinData, placeText, type PinCollection } from './pins';

// The map draws with WebGL, which tests don't have, so a stand-in records what the view asks of it.
const maplibre = vi.hoisted(() => {
  type Handler = (event: unknown) => void;
  class FakeSource {
    data: unknown;
    setData = vi.fn((data: unknown) => {
      this.data = data;
      return Promise.resolve();
    });
    getClusterExpansionZoom = vi.fn(() => Promise.resolve(9));
  }
  class FakeMap {
    static instances: FakeMap[] = [];
    static failing = false;
    options: Record<string, unknown>;
    handlers: Array<{ type: string; layer: string | null; handler: Handler }> = [];
    sources = new Map<string, FakeSource>();
    layers: Array<Record<string, unknown>> = [];
    filters = new Map<string, unknown>();
    canvas = document.createElement('canvas');
    fitBounds = vi.fn();
    easeTo = vi.fn();
    zoomIn = vi.fn();
    zoomOut = vi.fn();
    remove = vi.fn();
    setPaintProperty = vi.fn();
    queryRenderedFeatures = vi.fn((): unknown[] => []);
    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };
    constructor(options: Record<string, unknown>) {
      if (FakeMap.failing) throw new Error('WebGL is not available');
      this.options = options;
      FakeMap.instances.push(this);
    }
    on(type: string, layer: string | Handler, handler?: Handler) {
      if (typeof layer === 'function') this.handlers.push({ type, layer: null, handler: layer });
      else if (handler) this.handlers.push({ type, layer, handler });
      return { unsubscribe: () => undefined };
    }
    emit(type: string, layer: string | null = null, event: unknown = {}) {
      for (const entry of this.handlers)
        if (entry.type === type && entry.layer === layer) entry.handler(event);
    }
    addSource(id: string, source: { data: unknown }) {
      const created = new FakeSource();
      created.data = source.data;
      this.sources.set(id, created);
    }
    addLayer(layer: Record<string, unknown>) {
      this.layers.push(layer);
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    getStyle() {
      return {
        layers: [
          { id: 'water', type: 'fill' },
          { id: 'labels', type: 'symbol', layout: { 'text-font': ['Noto Sans Bold'] } },
        ],
      };
    }
    getCanvas() {
      return this.canvas;
    }
    getZoom() {
      return 3;
    }
    setFilter(layer: string, filter: unknown) {
      this.filters.set(layer, filter);
    }
  }
  return { FakeMap, setWorkerUrl: vi.fn() };
});
vi.mock('maplibre-gl', () => ({ MapLibreMap: maplibre.FakeMap, setWorkerUrl: maplibre.setWorkerUrl }));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  maplibre.FakeMap.instances = [];
  maplibre.FakeMap.failing = false;
});
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
});

const office = 'cho00000000000001';
const home = 'cho00000000000002';
const PARIS: LocationValue = { lat: 48.8566, lng: 2.3522, label: 'Paris' };
const TOKYO: LocationValue = { lat: 35.6762, lng: 139.6503, label: null };
const STYLE = 'https://tiles.example.test/styles/basic';

interface Fields {
  name: string;
  number: string;
  place: string;
  kind: string;
  record(index: number): string;
}

interface Options {
  count?: number;
  values?(index: number, fields: Fields): Record<string, CellValue>;
  map?: Partial<Settings> | ((fields: Fields) => Partial<Settings>);
  filter?(fields: Fields): FilterGroup;
  /** Leaves the table without location fields */
  noLocations?: boolean;
  canEdit?: boolean;
  /** The view's conditional colors */
  colors?(fields: Fields): Record<string, unknown>;
  /** The server's map style, or `unreadable` when the web app can't read its settings */
  styleUrl?: string | null | 'unreadable';
}

/** Task 1 in Paris at the office, Task 2 in Tokyo with no kind, and Task 3 with no place. */
const standard = (index: number, f: Fields) =>
  [
    { [f.place]: PARIS, [f.kind]: office },
    { [f.place]: TOKYO, [f.kind]: null },
    { [f.place]: null, [f.kind]: home },
  ][index] ?? {};

async function mount(options: Options = {}) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const base = schema.fields[0]!;
  let position = schema.fields.length;
  const field = (name: string, spec: Record<string, unknown>) =>
    FieldMeta.parse({ ...base, id: newId('field'), name, position: position++, ...spec });
  const place = field('Place', { type: 'location', options: {} });
  const kind = field('Kind', {
    type: 'singleSelect',
    options: {
      choices: [
        { id: office, name: 'Office', color: 'blue' },
        { id: home, name: 'Home', color: 'green' },
      ],
    },
  });
  const prefix = fixture.tableId.slice(3, 10);
  const ids: Fields = {
    name: fixture.textFieldId,
    number: fixture.numberFieldId,
    place: place.id,
    kind: kind.id,
    record: (index) => `rec${prefix}${index.toString(36).padStart(7, '0')}`,
  };
  const config = GridConfig.parse({
    map:
      typeof options.map === 'function'
        ? options.map(ids)
        : (options.map ?? { locationFieldId: options.noLocations ? null : place.id, colorFieldId: kind.id }),
    filter: options.filter?.(ids) ?? null,
  });
  server.seed(
    {
      ...schema,
      fields: options.noLocations ? [...schema.fields, kind] : [...schema.fields, place, kind],
      views: [{ ...schema.views[0]!, name: 'Places', type: 'map', config }],
    },
    new Map([
      [
        fixture.tableId,
        {
          count: options.count ?? 3,
          values: (index: number) => ({
            [fixture.textFieldId]: `Task ${index + 1}`,
            [fixture.numberFieldId]: index,
            ...(options.values ?? standard)(index, ids),
          }),
        },
      ],
    ]),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.styleUrl === 'unreadable')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('The server can’t be reached.'));
  else
    client.setQueryData(appConfigQuery.queryKey, {
      map: { styleUrl: options.styleUrl === undefined ? STYLE : options.styleUrl },
    });
  const onExpand = vi.fn();
  const onConfig = vi.fn<(patch: GridConfigPatch) => void>();
  const run = vi.spyOn(session, 'run');
  function Harness() {
    const current = useSchema(session)!;
    const view = current.viewById.get(fixture.viewId)!;
    const fields = current.fields.get(fixture.tableId)!;
    const { config: live, change } = useViewConfig(session, view, fields);
    const props: ViewComponentProps = {
      session,
      table: current.tableById.get(fixture.tableId)!,
      view: { ...view, config: live },
      fields,
      format: {
        locale: 'en-US',
        timeZone: 'UTC',
        collaborators: current.collaborators,
        linked: session.linked,
      },
      canEdit: options.canEdit ?? true,
      onConfig: (patch) => {
        onConfig(patch);
        change(patch);
      },
      onExpand,
      ...(options.colors
        ? {
            colors: createViewColors({
              config: ColorConfig.parse(options.colors(ids)),
              fields,
              context: { timeZone: 'UTC' },
              ranges: new Map(),
              label: (rule) => rule.name,
            }),
          }
        : {}),
    };
    return (
      <>
        <MapSettings {...props} />
        <MapView {...props} />
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        <Harness />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { server, fixture, session, run, onExpand, onConfig, ids };
}

/** Waits for the map, then lets it finish loading its style. */
async function loaded() {
  await waitFor(() => expect(maplibre.FakeMap.instances).toHaveLength(1));
  const map = maplibre.FakeMap.instances[0]!;
  act(() => map.emit('load'));
  await waitFor(() => expect(map.sources.get('rio-records')).toBeDefined());
  return map;
}

function pinsOf(map: InstanceType<typeof maplibre.FakeMap>): PinCollection {
  const source = map.sources.get('rio-records')!;
  return (source.setData.mock.calls.at(-1)?.[0] ?? source.data) as PinCollection;
}

describe('pins from records', () => {
  const location = { id: 'fldplace00000001', type: 'location', options: {} } as unknown as FieldMeta;
  const color = {
    id: 'fldkind000000001',
    type: 'singleSelect',
    options: { choices: [{ id: office, name: 'Office', color: 'purple' }] },
  } as unknown as FieldMeta;
  const row = (id: string, values: Record<string, CellValue>): RowData => ({
    id,
    values,
    createdAt: '',
    createdBy: null,
    updatedAt: '',
    updatedBy: null,
  });

  it('pins each loaded record with a place, colored by its option, and sets aside the rest', () => {
    const rows = [
      row('recaaaaaaaaaaaa1', { [location.id]: PARIS, [color.id]: office }),
      undefined,
      row('recaaaaaaaaaaaa2', { [location.id]: { lat: 91, lng: 0, label: null } }),
      row('recaaaaaaaaaaaa3', { [location.id]: TOKYO, [color.id]: 'cho00000000000099' }),
      row('recaaaaaaaaaaaa4', {}),
    ];
    const { pins, unplaced } = pinData(rows, location, color, (choice) => choice ?? 'accent');
    expect(pins).toEqual({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 0,
          geometry: { type: 'Point', coordinates: [2.3522, 48.8566] },
          properties: { id: 'recaaaaaaaaaaaa1', color: 'purple', fill: 'purple' },
        },
        {
          type: 'Feature',
          id: 3,
          geometry: { type: 'Point', coordinates: [139.6503, 35.6762] },
          properties: { id: 'recaaaaaaaaaaaa3', color: null, fill: 'accent' },
        },
      ],
    });
    expect(unplaced.map((item) => item.id)).toEqual(['recaaaaaaaaaaaa2', 'recaaaaaaaaaaaa4']);
    expect(
      pinData(rows, location, undefined, () => 'x').pins.features.map((pin) => pin.properties.color),
    ).toEqual([null, null]);
    // A color rule that colors a record outranks the color field.
    expect(
      pinData(
        rows,
        location,
        color,
        (choice) => choice ?? 'accent',
        (item) => (item.id === 'recaaaaaaaaaaaa1' ? 'red' : null),
      ).pins.features.map((pin) => pin.properties),
    ).toEqual([
      { id: 'recaaaaaaaaaaaa1', color: 'red', fill: 'red' },
      { id: 'recaaaaaaaaaaaa3', color: null, fill: 'accent' },
    ]);
  });

  it('frames pins in one box, across the 180th meridian when that’s smaller', () => {
    const pin = (lng: number, lat: number) => ({
      type: 'Feature' as const,
      id: 0,
      geometry: { type: 'Point' as const, coordinates: [lng, lat] as [number, number] },
      properties: { id: 'rec', color: null, fill: '' },
    });
    expect(pinBounds([])).toBeNull();
    expect(pinBounds([pin(2.35, 48.85)])).toEqual([
      [2.35, 48.85],
      [2.35, 48.85],
    ]);
    expect(pinBounds([pin(2.35, 48.85), pin(-74, 40.7), pin(139.65, 35.67)])).toEqual([
      [-74, 35.67],
      [139.65, 48.85],
    ]);
    // Tokyo and Honolulu sit closer across the Pacific than across everything else.
    expect(pinBounds([pin(139.65, 35.67), pin(-157.86, 21.31)])).toEqual([
      [139.65, 21.31],
      [202.14, 35.67],
    ]);
  });

  it('reads a place as its label and coordinates', () => {
    expect(placeText(PARIS)).toBe('Paris (48.8566, 2.3522)');
    expect(placeText(TOKYO)).toBe('35.6762, 139.6503');
  });
});

describe('map setup', () => {
  it('starts a new map at the table’s first location field', () => {
    const table = { primaryFieldId: 'fld00000000000009' } as never;
    const field = (id: string, type: string) => ({ id, type, options: {} }) as unknown as FieldMeta;
    expect(
      VIEW_DEFINITIONS.map.initialConfig(table, [
        field('fld00000000000001', 'text'),
        field('fld00000000000002', 'location'),
        field('fld00000000000003', 'location'),
      ]),
    ).toEqual({ map: { locationFieldId: 'fld00000000000002', colorFieldId: null } });
    expect(VIEW_DEFINITIONS.map.initialConfig(table, [field('fld00000000000001', 'text')])).toEqual({
      map: { locationFieldId: null, colorFieldId: null },
    });
  });

  it('explains that it needs a location field, and adds one', async () => {
    const { run, session, fixture } = await mount({ noLocations: true });
    expect(await screen.findByRole('heading', { name: 'This map needs a location field' })).toBeTruthy();
    expect(screen.getByText('This table has no location fields yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a location field' }));
    expect(run.mock.calls[0]![0].map((command) => command.kind)).toEqual(['field.create', 'view.update']);
    const created = session
      .getSchema()
      .fields.get(fixture.tableId)!
      .find((field) => field.type === 'location')!;
    expect(created.name).toBe('Location');
    expect(session.getSchema().viewById.get(fixture.viewId)!.config.map.locationFieldId).toBe(created.id);
    await waitFor(() => expect(maplibre.FakeMap.instances).toHaveLength(1));
  });

  it('asks someone who can’t change the table to have a location field added', async () => {
    await mount({ noLocations: true, canEdit: false });
    expect(
      await screen.findByText(/no location fields yet\.\s+Someone who can change it can add one\./),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a location field' })).toBeNull();
  });

  it('offers the table’s location fields when the map has none chosen', async () => {
    const { onConfig, ids } = await mount({ map: { locationFieldId: null } });
    expect(await screen.findByRole('heading', { name: 'This map needs a location field' })).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: /Location/ })[0]!);
    await userEvent.click(screen.getByRole('option', { name: 'Place' }));
    expect(onConfig).toHaveBeenLastCalledWith({ map: { locationFieldId: ids.place, colorFieldId: null } });
    await waitFor(() => expect(maplibre.FakeMap.instances).toHaveLength(1));
  });
});

describe('the map', () => {
  it('draws a pin for each place, colored by the color field, framed all at once', async () => {
    const { ids } = await mount();
    const map = await loaded();
    expect(map.options).toMatchObject({ style: STYLE, maplibreLogo: false });
    await waitFor(() => expect(pinsOf(map).features).toHaveLength(2));
    const [paris, tokyo] = pinsOf(map).features;
    expect(paris!.properties).toEqual({
      id: ids.record(0),
      color: 'blue',
      fill: FALLBACK_COLORS.choices.blue,
    });
    expect(tokyo!.properties).toEqual({ id: ids.record(1), color: null, fill: FALLBACK_COLORS.accent });
    expect(map.layers.map((layer) => layer.id)).toEqual([
      'rio-clusters',
      'rio-cluster-counts',
      'rio-pins',
      'rio-selected',
    ]);
    // Cluster counts use a font the style already serves.
    expect(map.layers[1]).toMatchObject({ layout: { 'text-font': ['Noto Sans Bold'] } });
    expect(map.fitBounds).toHaveBeenCalledWith(
      [
        [2.3522, 35.6762],
        [139.6503, 48.8566],
      ],
      { padding: 48, maxZoom: 14, duration: 0 },
    );
  });

  it('is labeled for screen readers, with how to use it and where its list is', async () => {
    await mount();
    const map = await loaded();
    expect(map.options).toMatchObject({
      locale: { 'Map.Title': expect.stringMatching(/^Places map, \d pins?$/) },
    });
    // The label follows the pins as the records arrive.
    await waitFor(() => expect(map.canvas.getAttribute('aria-label')).toBe('Places map, 2 pins'));
    const help = document.getElementById(map.canvas.getAttribute('aria-describedby')!)!;
    expect(help.textContent).toMatch(/^Use the arrow keys to move the map/);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(map.zoomOut).toHaveBeenCalled();
  });

  it('shows a small card for a clicked pin, which opens the record', async () => {
    const { ids, onExpand } = await mount();
    const map = await loaded();
    act(() => map.emit('click', 'rio-pins', { features: [{ properties: { id: ids.record(0) } }] }));
    const card = await screen.findByRole('region', { name: 'Task 1' });
    expect(within(card).getByText('Paris (48.8566, 2.3522)')).toBeTruthy();
    expect(within(card).getByText('Number')).toBeTruthy();
    expect(within(card).getByText('Office')).toBeTruthy();
    expect(map.filters.get('rio-selected')).toEqual([
      'all',
      ['!', ['has', 'point_count']],
      ['==', ['get', 'id'], ids.record(0)],
    ]);
    await userEvent.click(within(card).getByRole('button', { name: 'Open Task 1' }));
    expect(onExpand).toHaveBeenCalledWith(ids.record(0));
    // A click on the map away from any pin puts the card away.
    act(() => map.emit('click', null, { point: { x: 1, y: 1 } }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Task 1' })).toBeNull());
  });

  it('zooms in on a cluster when it’s clicked', async () => {
    await mount();
    const map = await loaded();
    act(() =>
      map.emit('click', 'rio-clusters', {
        features: [{ properties: { cluster_id: 7 }, geometry: { type: 'Point', coordinates: [10, 20] } }],
      }),
    );
    const source = map.sources.get('rio-records')!;
    expect(source.getClusterExpansionZoom).toHaveBeenCalledWith(7);
    await waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [10, 20], zoom: 9 }));
  });

  it('frames every pin again with Fit all', async () => {
    await mount();
    const map = await loaded();
    await waitFor(() => expect(map.fitBounds).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Fit all' }));
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
    expect(map.fitBounds).toHaveBeenLastCalledWith(
      [
        [2.3522, 35.6762],
        [139.6503, 48.8566],
      ],
      { padding: 48, maxZoom: 14 },
    );
  });

  it('pins only the records the view’s filter keeps', async () => {
    await mount({
      filter: (f) => ({
        conjunction: 'and',
        conditions: [{ id: 'kind', fieldId: f.kind, operator: 'is', value: office }],
      }),
    });
    const map = await loaded();
    await waitFor(() => expect(pinsOf(map).features.map((pin) => pin.properties.color)).toEqual(['blue']));
    expect(screen.queryByRole('button', { name: /No location/ })).toBeNull();
  });

  it('counts records with no place in a No location button that lists them', async () => {
    const { ids, onExpand } = await mount();
    await loaded();
    const button = await screen.findByRole('button', { name: 'No location, 1 record' });
    await userEvent.click(button);
    const list = screen.getByRole('dialog', { name: '1 record has no location' });
    await userEvent.click(within(list).getByRole('button', { name: 'Task 3' }));
    expect(onExpand).toHaveBeenCalledWith(ids.record(2));
  });

  it('lists every record and its place a click away, and shows one on the map from there', async () => {
    const { ids, onExpand } = await mount();
    const map = await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'List records and places' }));
    const dialog = screen.getByRole('dialog', { name: 'Records and places' });
    const rows = within(dialog)
      .getAllByRole('row')
      .map((row) =>
        within(row)
          .queryAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows.slice(1)).toEqual([
      ['Paris (48.8566, 2.3522)', 'Office', 'Show on map'],
      ['35.6762, 139.6503', '', 'Show on map'],
      ['No location', 'Home', ''],
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show on map: Task 2' }));
    expect(map.easeTo).toHaveBeenCalledWith({ center: [139.6503, 35.6762], zoom: 12 });
    expect(await screen.findByRole('region', { name: 'Task 2' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Showing Task 2 on the map');
    await userEvent.click(screen.getByRole('button', { name: 'List records and places' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Task 3' }));
    expect(onExpand).toHaveBeenCalledWith(ids.record(2));
  });
});

describe('map colors', () => {
  const busy = (f: Fields) => ({
    colorRules: [
      {
        id: 'busy',
        name: 'Busy',
        target: 'record',
        condition: { id: 'c1', fieldId: f.number, operator: 'gt', value: 0 },
        color: 'red',
      },
    ],
  });

  it('draws a pin in its record’s color from the view’s color rules, over the color field', async () => {
    const { ids } = await mount({ colors: busy });
    const map = await loaded();
    await waitFor(() => expect(pinsOf(map).features).toHaveLength(2));
    expect(pinsOf(map).features.map((pin) => pin.properties)).toEqual([
      { id: ids.record(0), color: 'blue', fill: FALLBACK_COLORS.choices.blue },
      { id: ids.record(1), color: 'red', fill: FALLBACK_COLORS.choices.red },
    ]);
    // The pin's card says what its color means.
    act(() => map.emit('click', 'rio-pins', { features: [{ properties: { id: ids.record(1) } }] }));
    const card = await screen.findByRole('region', { name: 'Task 2' });
    expect(within(card).getByRole('img', { name: 'Busy' })).toBeTruthy();
  });

  it('marks each colored record in the list of places, naming the rule', async () => {
    await mount({ colors: busy, styleUrl: null });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((line) => within(line).queryByRole('img', { name: 'Busy' }) !== null)).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe('maps turned off or unavailable', () => {
  it('lists the records and their places with a calm note when the server turns maps off', async () => {
    await mount({ styleUrl: null });
    expect(
      await screen.findByText(
        'Maps are turned off on this server, so each record’s place is listed instead.',
      ),
    ).toBeTruthy();
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByText('Paris (48.8566, 2.3522)')).toBeTruthy();
    expect(within(table).queryByRole('button', { name: /Show on map/ })).toBeNull();
    expect(maplibre.FakeMap.instances).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Fit all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'List records and places' })).toBeNull();
    expect(screen.getByRole('button', { name: 'No location, 1 record' })).toBeTruthy();
  });

  it('lists them too when the map can’t start, or can’t load its style', async () => {
    maplibre.FakeMap.failing = true;
    await mount();
    expect(
      await screen.findByText('The map couldn’t load here, so each record’s place is listed instead.'),
    ).toBeTruthy();
    cleanup();
    maplibre.FakeMap.failing = false;
    await mount();
    await waitFor(() => expect(maplibre.FakeMap.instances).toHaveLength(1));
    act(() => maplibre.FakeMap.instances[0]!.emit('error'));
    expect(
      await screen.findByText('The map couldn’t load here, so each record’s place is listed instead.'),
    ).toBeTruthy();
  });

  it('lists them with the same note when the app can’t read the server’s map setting', async () => {
    await mount({ styleUrl: 'unreadable' });
    expect(
      await screen.findByText('The map couldn’t load here, so each record’s place is listed instead.'),
    ).toBeTruthy();
    expect(maplibre.FakeMap.instances).toHaveLength(0);
  });

  it('keeps showing the map when a tile fails after its style has loaded', async () => {
    await mount();
    const map = await loaded();
    act(() => {
      map.emit('style.load');
      map.emit('error');
    });
    expect(screen.queryByText(/couldn’t load/)).toBeNull();
    expect(map.remove).not.toHaveBeenCalled();
  });
});

describe('map settings', () => {
  it('saves the location and color fields, offering only fields that fit', async () => {
    const { onConfig, ids } = await mount();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Map settings' }));
    await userEvent.click(screen.getByRole('button', { name: /Color by/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['None', 'Kind']);
    await userEvent.click(screen.getByRole('option', { name: 'None' }));
    expect(onConfig).toHaveBeenLastCalledWith({ map: { locationFieldId: ids.place, colorFieldId: null } });
    const map = maplibre.FakeMap.instances[0]!;
    await waitFor(() => expect(pinsOf(map).features[0]!.properties.color).toBeNull());
    const panel = screen.getByRole('dialog', { name: 'Map settings' });
    await userEvent.click(within(panel).getByRole('button', { name: /Location/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Place']);
  });

  it('disables the settings for people who can’t change the view', async () => {
    await mount({ canEdit: false });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Map settings' }));
    const panel = screen.getByRole('dialog', { name: 'Map settings' });
    for (const button of within(panel).getAllByRole('button'))
      expect(button.hasAttribute('disabled')).toBe(true);
  });
});
