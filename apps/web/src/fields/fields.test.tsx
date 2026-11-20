import { useState } from 'react';
import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  FieldMeta,
  LIMITS,
  isSignaturePath,
  type CellValue,
  type FieldType,
  type LocationValue,
  type RowData,
  type SignatureValue,
} from '@riosoma/contracts';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { openDatabase, type DatabaseSession } from '../data';
import { FakeServer } from '../data/testing';
import { mountEditor } from '../grid/editors/mountEditor';
import type { EditorProps } from '../grid/editors/types';
import { createCellRenderer } from '../grid/cells/renderers';
import { formatCell } from '../grid/format';
import { parseText } from '../grid/parse';
import { copyText } from '../grid/clipboard/copy';
import { RecordCard } from '../screens/database/record/RecordCard';
import { FieldTypePicker } from '../screens/database/fields/FieldTypePicker';
import { ButtonOptions } from '../screens/database/fields/ButtonOptions';
import { FilterValueEditor } from '../screens/database/view/FilterValueEditor';
import { AnswerEditor } from '../screens/database/views/form/AnswerEditor';
import { CardValue } from '../screens/database/views/CardValue';
import { buttonTarget } from './buttons';
import { FieldButton } from './FieldButton';
import { JsonInput } from './JsonInput';
import { LocationInput } from './LocationInput';
import { SignatureInput } from './SignatureInput';
import { SignaturePad } from './SignaturePad';
import { strokesPath } from './signature';
import { jsonProblem } from './json';

const ada = 'usr00000000000001';
const collaborators = new Map([[ada, { name: 'Ada Lovelace', email: 'ada@example.com' }]]);
const format = { locale: 'en-US', timeZone: 'UTC', collaborators };
const drawing = { path: 'M10 20l3 -2 4 1', width: 400, height: 150 };
const signed: SignatureValue = { drawing, name: null, signedBy: ada, signedAt: '2026-09-27T15:05:00.000Z' };

afterAll(() => vi.restoreAllMocks());
const sessions: DatabaseSession[] = [];
const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => act(dispose));
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
});

function field(
  type: FieldType,
  options: object = {},
  id = 'fld00000000000001',
  name: string = type,
): FieldMeta {
  return FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options,
  });
}

function record(values: RowData['values']): RowData {
  return {
    id: 'rec00000000000001',
    values,
    createdAt: '2026-09-27T15:05:00.000Z',
    updatedAt: '2026-09-27T15:05:00.000Z',
    createdBy: ada,
    updatedBy: ada,
  };
}

/** A pad laid out at (10, 20), 300 by 100 pixels, as a browser would place it. */
function padCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('.rio-signature-pad__canvas')!;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 300,
    height: 100,
    right: 310,
    bottom: 120,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
  return canvas;
}

function stroke(
  canvas: HTMLCanvasElement,
  pointerType: 'mouse' | 'pen' | 'touch',
  points: Array<[number, number]>,
  pointerId = 1,
) {
  const [first, ...rest] = points;
  fireEvent.pointerDown(canvas, {
    pointerId,
    pointerType,
    button: 0,
    clientX: first![0],
    clientY: first![1],
  });
  for (const [clientX, clientY] of rest)
    fireEvent.pointerMove(canvas, { pointerId, pointerType, clientX, clientY });
  fireEvent.pointerUp(canvas, {
    pointerId,
    pointerType,
    clientX: points.at(-1)![0],
    clientY: points.at(-1)![1],
  });
}

describe('signature pad', () => {
  it('records mouse, pen, and touch strokes from pointer events and signs with their path', async () => {
    const onSign = vi.fn();
    renderField(<SignaturePad label="Consent" onSign={onSign} />);
    const canvas = padCanvas();
    expect(screen.getByRole('img', { name: /Signature pad for Consent/ })).toBe(canvas);
    expect(screen.getByRole('button', { name: 'Sign' }).hasAttribute('disabled')).toBe(true);
    stroke(canvas, 'mouse', [
      [20, 30],
      [25, 30],
      [25, 40],
      [25, 40],
    ]);
    // A pen and a finger each start a stroke of their own, and points past the pad's edge stay on it.
    stroke(canvas, 'pen', [
      [110, 70],
      [400, 70],
    ]);
    stroke(canvas, 'touch', [[60, 60]], 2);
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    const path = 'M10 10l5 0 0 10 M100 50l200 0 M50 40l0 0';
    expect(onSign).toHaveBeenCalledWith({ drawing: { path, width: 300, height: 100 }, name: null });
    expect(isSignaturePath(path)).toBe(true);
  });

  it('ignores other mouse buttons, clears the drawing, and signs with a typed name alone', async () => {
    const onSign = vi.fn();
    renderField(<SignaturePad label="Consent" onSign={onSign} />);
    const canvas = padCanvas();
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 2,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 30 });
    expect(screen.getByRole('button', { name: 'Clear drawing' }).hasAttribute('disabled')).toBe(true);
    stroke(canvas, 'mouse', [
      [20, 30],
      [30, 30],
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear drawing' }));
    expect(screen.getByRole('button', { name: 'Sign' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), '  Ada Lovelace {Enter}');
    expect(onSign).toHaveBeenCalledWith({ drawing: null, name: 'Ada Lovelace' });
  });

  it('keeps a long drawing under the limit by keeping fewer of its points', () => {
    const long = Array.from({ length: 12_000 }, (_, i) => ({ x: i % 300, y: (i * 7) % 100 }));
    const path = strokesPath([long]);
    expect(path.length).toBeLessThanOrEqual(LIMITS.signaturePathLength);
    expect(path.startsWith('M0 0l')).toBe(true);
    expect(isSignaturePath(path)).toBe(true);
  });
});

describe('signature field', () => {
  it('shows a signature and who signed it, and can only sign again or remove it', async () => {
    const onChange = vi.fn();
    const item = field('signature') as Extract<FieldMeta, { type: 'signature' }>;
    renderField(<SignatureInput field={item} value={signed} format={format} onChange={onChange} />);
    expect(screen.getByRole('img', { name: /^Signed by Ada Lovelace at Sep 27, 2026/ })).toBeDefined();
    expect(document.querySelector('.rio-signature path')?.getAttribute('d')).toBe(drawing.path);
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign again' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Grace{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ drawing: null, name: 'Grace', signedBy: null }),
    );
    cleanup();
    renderField(<SignatureInput field={item} value={signed} format={format} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove signature' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    cleanup();
    renderField(<SignatureInput field={item} value={signed} format={format} readOnly onChange={onChange} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('JSON input', () => {
  it('finds where broken JSON stops, whichever browser is reading it', () => {
    expect(jsonProblem('{"a": 1}')).toBeNull();
    expect(jsonProblem('{\n  "a": 1,\n  "b": \n}')).toEqual({ line: 4, column: 1 });
    expect(jsonProblem('[1, 2,]')).toEqual({ line: 1, column: 7 });
    expect(jsonProblem("{'a': 1}")).toEqual({ line: 1, column: 2 });
    expect(jsonProblem('"tab\\there, and a backslash \\\\"')).toBeNull();
    expect(jsonProblem('"tab\there"')).toEqual({ line: 1, column: 5 });
    expect(jsonProblem('"bad \\x"')).toEqual({ line: 1, column: 7 });
    expect(jsonProblem('01')).toEqual({ line: 1, column: 2 });
    expect(jsonProblem('true false')).toEqual({ line: 1, column: 6 });
    expect(jsonProblem('')).toEqual({ line: 1, column: 1 });
  });

  it('shows JSON laid out, says where broken JSON stops, and saves it compact', async () => {
    const onChange = vi.fn();
    function Input() {
      const [value, setValue] = useState<string | null>('{"a":[1,2.50]}');
      return (
        <JsonInput
          value={value}
          label="Data"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    renderField(<Input />);
    const box = screen.getByRole('textbox', { name: 'Data' }) as HTMLTextAreaElement;
    expect(box.value).toBe('{\n  "a": [\n    1,\n    2.50\n  ]\n}');
    // React hears a field losing focus as `focusout`.
    fireEvent.change(box, { target: { value: '{\n  "a": 1,\n  "b": \n}' } });
    fireEvent.focusOut(box);
    expect(await screen.findByText(/This isn’t valid JSON\.\s+Check line \d+, column \d+\./)).toBeDefined();
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '{"a": 1, "b": true}' } });
    fireEvent.focusOut(box);
    expect(onChange).toHaveBeenLastCalledWith('{"a":1,"b":true}');
    await waitFor(() => expect(box.value).toBe('{\n  "a": 1,\n  "b": true\n}'));
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.focusOut(box);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('location input', () => {
  function Input({ onChange }: { onChange: (value: LocationValue | null) => void }) {
    const [value, setValue] = useState<LocationValue | null>(null);
    return (
      <LocationInput
        value={value}
        label="Place"
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it('saves a label with typed coordinates and explains coordinates it can’t use', async () => {
    const onChange = vi.fn();
    renderField(<Input onChange={onChange} />);
    const coordinates = screen.getByRole('textbox', { name: 'Latitude, longitude' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Place' }), 'Paris{Enter}');
    expect(screen.getByText('Add coordinates, or use your location, to save this place.')).toBeDefined();
    await userEvent.type(coordinates, '91, 2{Enter}');
    expect(screen.getByText('Latitude runs from -90 to 90, and longitude from -180 to 180.')).toBeDefined();
    await userEvent.clear(coordinates);
    await userEvent.type(coordinates, 'north{Enter}');
    expect(screen.getByText('Type the latitude and longitude, like 40.7128, -74.0060.')).toBeDefined();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.clear(coordinates);
    await userEvent.type(coordinates, '48.85661234, 2.3522{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ lat: 48.856612, lng: 2.3522, label: 'Paris' });
    expect((coordinates as HTMLInputElement).value).toBe('48.856612, 2.3522');
  });

  it('asks for the browser’s location only when the button is pressed', async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
    try {
      const onChange = vi.fn();
      renderField(<Input onChange={onChange} />);
      expect(getCurrentPosition).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Use my location' }));
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      act(() =>
        getCurrentPosition.mock.calls[0]![0]({ coords: { latitude: 40.71281234, longitude: -74.006 } }),
      );
      expect(onChange).toHaveBeenLastCalledWith({ lat: 40.712812, lng: -74.006, label: null });
      await userEvent.click(screen.getByRole('button', { name: 'Use my location' }));
      act(() => getCurrentPosition.mock.calls[1]![1]({ code: 1, PERMISSION_DENIED: 1 }));
      expect(screen.getByText(/didn’t share your location\.\s+Type the coordinates instead\./)).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('buttons', () => {
  const orderId = field('text', {}, 'fld00000000000002', 'Order ID');
  const website = field('url', {}, 'fld00000000000003', 'Website');
  const button = (urlTemplate: string, label = '') =>
    field('button', { label, action: { kind: 'openUrl', urlTemplate } }) as Extract<
      FieldMeta,
      { type: 'button' }
    >;
  const context = { ...format, fieldsById: new Map([orderId, website].map((f) => [f.id, f])) };
  const row = record({ [orderId.id]: 'A/B 7', [website.id]: 'javascript:alert(1)' });

  it('fills links from the record, and refuses missing fields and other schemes', () => {
    expect(buttonTarget(button('https://example.com/orders/{fld00000000000002}'), row, context)).toEqual({
      ok: true,
      url: 'https://example.com/orders/A%2FB%207',
    });
    expect(buttonTarget(button('https://example.com/{fld00000000000099}'), row, context)).toEqual({
      ok: false,
      reason: 'missingField',
      fieldId: 'fld00000000000099',
    });
    expect(buttonTarget(button('{fld00000000000003}'), row, context)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(buttonTarget(button(''), row, context)).toEqual({ ok: false, reason: 'empty' });
  });

  it('draws a link that opens in a new tab, or the label marked unavailable with why', () => {
    renderField(
      <FieldButton
        field={button('https://example.com/orders/{fld00000000000002}', 'Track')}
        row={row}
        format={context}
      />,
    );
    const link = screen.getByRole('link', { name: /Track/ });
    expect(link.getAttribute('href')).toBe('https://example.com/orders/A%2FB%207');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('img', { name: 'Opens in a new tab' })).toBeDefined();
    cleanup();
    renderField(<FieldButton field={button('{fld00000000000003}')} row={row} format={context} showReason />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('button').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('This record doesn’t make a web link for this button.')).toBeDefined();
  });

  it('opens its link from a card without opening the card', async () => {
    const open = vi.fn();
    renderField(
      <div onClick={open}>
        <CardValue
          field={button('https://example.com/{fld00000000000002}', 'Go')}
          value={null}
          format={context}
          row={row}
          focusable={false}
        />
      </div>,
    );
    const link = screen.getByRole('link', { name: /Go/ });
    expect(link.getAttribute('tabindex')).toBe('-1');
    link.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(link);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('grid cells', () => {
  function draw(item: FieldMeta, values: RowData['values'], extra: FieldMeta[] = []) {
    const fieldsById = new Map([item, ...extra].map((f) => [f.id, f]));
    const render = createCellRenderer({ fieldsById, format: { ...format, fieldsById }, rowHeight: 'short' });
    const el = document.createElement('div');
    render(el, {
      row: record(values),
      rowIndex: 0,
      column: { id: item.id, width: 180, edit: 'none' },
      colIndex: 0,
      selected: false,
      active: false,
    });
    return el;
  }

  it('draws a signature as a small drawing named for who signed, and a typed one as the name', () => {
    const item = field('signature');
    const el = draw(item, { [item.id]: signed });
    const image = el.querySelector('[role="img"]')!;
    expect(image.getAttribute('aria-label')).toMatch(/^Signed by Ada Lovelace at Sep 27, 2026/);
    expect(el.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 400 150');
    expect(el.querySelector('path')?.getAttribute('d')).toBe(drawing.path);
    const typed = draw(item, { [item.id]: { ...signed, drawing: null, name: 'Grace' } });
    expect(typed.textContent).toBe('Grace');
    expect(draw(item, {}).childNodes).toHaveLength(0);
  });

  it('draws a button as a link, and one it can’t fill as its label without a link', () => {
    const code = field('text', {}, 'fld00000000000002', 'Code');
    const item = field('button', {
      label: 'Track',
      action: { kind: 'openUrl', urlTemplate: 'https://example.com/{fld00000000000002}' },
    });
    const link = draw(item, { [code.id]: 'x y' }, [code]).querySelector('a')!;
    expect(link.textContent).toBe('Track');
    expect(link.getAttribute('href')).toBe('https://example.com/x%20y');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const missing = draw(item, {});
    expect(missing.querySelector('a')).toBeNull();
    expect(missing.firstElementChild?.getAttribute('aria-disabled')).toBe('true');
    expect(missing.firstElementChild?.getAttribute('title')).toBe(
      'This button uses a field that was deleted.',
    );
  });

  it('draws JSON on one monospace line, a place by its label or coordinates, and a range of days', () => {
    const json = field('json');
    const cell = draw(json, { [json.id]: '{"a":[1,2]}' }).firstElementChild!;
    expect(cell.textContent).toBe('{"a":[1,2]}');
    expect(cell.classList.contains('rio-cell-value--code')).toBe(true);
    const place = field('location');
    expect(draw(place, { [place.id]: { lat: 1.5, lng: -2, label: 'Harbor' } }).textContent).toBe('Harbor');
    expect(draw(place, { [place.id]: { lat: 1.5, lng: -2, label: null } }).textContent).toBe('1.5, -2');
    const range = field('dateRange');
    expect(draw(range, { [range.id]: { start: '2026-09-27', end: '2026-09-30' } }).textContent).toBe(
      'Sep 27, 2026 – Sep 30, 2026',
    );
  });

  it('reads typed and pasted text for each type, and copies places whole', () => {
    const range = field('dateRange');
    expect(parseText(range, 'Sep 27, 2026 – Sep 30, 2026', format)).toEqual({
      ok: true,
      value: { start: '2026-09-27', end: '2026-09-30' },
    });
    expect(parseText(range, '9/30/2026 - 9/27/2026', format)).toEqual({
      ok: false,
      reason: 'data.value.dateRange',
    });
    const timed = field('dateRange', { includeTime: true, timeZone: 'America/New_York' });
    expect(parseText(timed, '2026-09-27 09:00 to 2026-09-27 17:00', format)).toEqual({
      ok: true,
      value: { start: '2026-09-27T13:00:00.000Z', end: '2026-09-27T21:00:00.000Z' },
    });
    const json = field('json');
    expect(parseText(json, '{ "a" : 1 }', format)).toEqual({ ok: true, value: '{"a":1}' });
    expect(parseText(json, '{a:1}', format)).toEqual({ ok: false, reason: 'data.value.notJson' });
    const place = field('location');
    const paris = { lat: 48.8566, lng: 2.3522, label: 'Paris' };
    expect(copyText(place, paris, format)).toBe('Paris (48.8566, 2.3522)');
    expect(formatCell(place, paris, format)).toBe('Paris');
    expect(parseText(place, copyText(place, paris, format), format)).toEqual({ ok: true, value: paris });
    expect(parseText(place, 'Paris', format)).toEqual({ ok: false, reason: 'data.value.location' });
    expect(parseText(field('signature'), 'Ada', format)).toEqual({
      ok: false,
      reason: 'data.value.signature',
    });
    expect(parseText(field('button'), 'x', format)).toEqual({ ok: false, reason: 'computed' });
  });
});

describe('record card', () => {
  function mount(fields: FieldMeta[], values: RowData['values'], readOnly = false) {
    const onChange = vi.fn();
    function Card() {
      const [row, setRow] = useState(record(values));
      return (
        <RecordCard
          fields={fields}
          primaryFieldId={fields[0]!.id}
          row={row}
          format={{ ...format, fieldsById: new Map(fields.map((f) => [f.id, f])) }}
          readOnly={readOnly}
          canEditOptions={false}
          position={null}
          onClose={() => {}}
          onAddOption={() => ''}
          onChange={(id, value) => {
            onChange(id, value);
            setRow((current) => ({ ...current, values: { ...current.values, [id]: value } }));
          }}
        />
      );
    }
    renderField(<Card />);
    return onChange;
  }

  it('edits a date range with two date pickers, and waits while the end comes first', async () => {
    const range = field('dateRange');
    const onChange = mount([field('text', {}, 'fld00000000000009', 'Name'), range], {
      [range.id]: { start: '2026-09-21', end: '2026-09-24' },
    });
    const group = screen.getByRole('group', { name: 'dateRange' });
    expect(within(group).getAllByRole('spinbutton')).toHaveLength(6);
    const user = userEvent.setup();
    const pickers = () => within(group).getAllByRole('button', { name: /Choose a date/ });
    await user.click(pickers()[0]!);
    await user.click(screen.getByRole('button', { name: /Tuesday, September 22, 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith(range.id, { start: '2026-09-22', end: '2026-09-24' });
    await user.click(pickers()[1]!);
    await user.click(screen.getByRole('button', { name: /Monday, September 21, 2026/ }));
    expect(within(group).getByText('The end comes before the start.')).toBeDefined();
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.click(pickers()[1]!);
    await user.click(screen.getByRole('button', { name: /Friday, September 25, 2026/ }));
    expect(onChange).toHaveBeenLastCalledWith(range.id, { start: '2026-09-22', end: '2026-09-25' });
    expect(within(group).queryByText('The end comes before the start.')).toBeNull();
  });

  it('makes a one-day range from the first day chosen', async () => {
    // A picker with nothing chosen opens its calendar on the current month, so hold the clock
    // still to keep the day the test reaches for on screen.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-20T12:00:00Z') });
    try {
      const range = field('dateRange');
      const onChange = mount([field('text', {}, 'fld00000000000009', 'Name'), range], {
        [range.id]: { start: '2026-09-21', end: '2026-09-24' },
      });
      const group = screen.getByRole('group', { name: 'dateRange' });
      const user = userEvent.setup();
      const pickers = () => within(group).getAllByRole('button', { name: /Choose a date/ });
      // Clearing one end clears the range, and choosing a day then makes a range of that one day.
      await user.click(within(group).getAllByRole('button', { name: /Clear/ })[0]!);
      expect(onChange).toHaveBeenLastCalledWith(range.id, null);
      await user.click(pickers()[1]!);
      await user.click(screen.getByRole('button', { name: /Tuesday, September 15, 2026/ }));
      expect(onChange).toHaveBeenLastCalledWith(range.id, { start: '2026-09-15', end: '2026-09-15' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows JSON, signatures, and buttons read-only, and a button even to readers', () => {
    const json = field('json', {}, 'fld00000000000002', 'Data');
    const signature = field('signature', {}, 'fld00000000000003', 'Signed');
    const button = field(
      'button',
      { label: 'Visit', action: { kind: 'openUrl', urlTemplate: 'https://example.com/{fld00000000000002}' } },
      'fld00000000000004',
      'Visit',
    );
    mount(
      [field('text', {}, 'fld00000000000009', 'Name'), json, signature, button],
      {
        [json.id]: '{"a":1}',
        [signature.id]: signed,
      },
      true,
    );
    expect(document.querySelector('.rio-json-view')?.textContent).toBe('{\n  "a": 1\n}');
    expect(screen.getAllByText(/^Signed by Ada Lovelace at Sep 27, 2026/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Visit/ }).getAttribute('href')).toBe(
      'https://example.com/%7B%22a%22%3A1%7D',
    );
  });

  it('saves a location from the card', async () => {
    const place = field('location');
    const onChange = mount([field('text', {}, 'fld00000000000009', 'Name'), place], {});
    await userEvent.type(screen.getByRole('textbox', { name: 'Latitude, longitude' }), '1, 2{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(place.id, { lat: 1, lng: 2, label: null });
  });
});

describe('field settings', () => {
  it('lists each new type with a line on what it holds', async () => {
    renderField(<FieldTypePicker value="text" onChange={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    for (const [name, line] of [
      ['Date range', 'A start and an end date.'],
      ['JSON', 'Structured data, checked on save.'],
      ['Location', 'A place, as coordinates with an optional address.'],
      ['Signature', 'A drawn or typed signature.'],
      ['Button', 'Opens a link made from the record’s fields.'],
    ] as const)
      expect(
        within(
          screen.getByRole('option', {
            name: (accessibleName) => accessibleName === name || accessibleName.startsWith(`${name} `),
          }),
        ).getByText(line),
      ).toBeDefined();
  });

  it('edits a button’s link by field name and says what’s wrong with a link', async () => {
    const onChange = vi.fn();
    const fields = [field('text', {}, 'fld00000000000002', 'Order ID'), field('button')];
    renderField(
      <ButtonOptions
        options={{ action: { kind: 'openUrl', urlTemplate: 'https://example.com/{fld00000000000002}' } }}
        fields={fields}
        fieldId="fld00000000000001"
        onChange={onChange}
      />,
    );
    const link = screen.getByRole('textbox', { name: 'Link' }) as HTMLInputElement;
    expect(link.value).toBe('https://example.com/{Order ID}');
    fireEvent.change(link, { target: { value: 'https://example.com/{Nope}' } });
    expect(screen.getByText('There’s no field named Nope in this table.')).toBeDefined();
    fireEvent.change(link, { target: { value: 'javascript:alert(1)' } });
    expect(
      screen.getByText('Start the link with http:// or https://, or with a field that holds one.'),
    ).toBeDefined();
    fireEvent.change(link, { target: { value: 'https://example.com/' } });
    await userEvent.click(screen.getByRole('button', { name: /Add a field to the link/ }));
    await userEvent.click(screen.getByRole('option', { name: /^Order ID(?: |$)/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      label: '',
      action: { kind: 'openUrl', urlTemplate: 'https://example.com/{Order ID}' },
    });
  });
});

describe('filters and forms', () => {
  it('uses a distance condition only once it has both a distance and a point', async () => {
    const onChange = vi.fn();
    const place = field('location');
    renderField(
      <FilterValueEditor
        field={place}
        condition={{ id: 'c', fieldId: place.id, operator: 'isWithin' }}
        collaborators={collaborators}
        readOnly={false}
        onChange={onChange}
      />,
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'From latitude, longitude' }),
      '48.8566, 2.3522',
    );
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    await userEvent.type(screen.getByRole('textbox', { name: 'Kilometers' }), '25');
    expect(onChange).toHaveBeenLastCalledWith({ lat: 48.8566, lng: 2.3522, km: 25 });
  });

  it('asks a signature question with the pad and a JSON question with its box', async () => {
    const onChange = vi.fn();
    const signature = field('signature');
    renderField(
      <AnswerEditor field={signature} value={null} format={format} labelId="question" onChange={onChange} />,
    );
    expect(screen.getByRole('img', { name: /Signature pad for signature/ })).toBeDefined();
    await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Visitor{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(
      signature.id,
      expect.objectContaining({ drawing: null, name: 'Visitor' }),
    );
    cleanup();
    const json = field('json');
    renderField(
      <>
        <span id="question">Data</span>
        <AnswerEditor field={json} value={null} format={format} labelId="question" onChange={onChange} />
      </>,
    );
    const box = screen.getByRole('textbox', { name: 'Data' });
    fireEvent.change(box, { target: { value: '[1, 2]' } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenLastCalledWith(json.id, '[1,2]');
  });
});

describe('grid editors', () => {
  async function mount(type: FieldType, value: CellValue = null) {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const server = new FakeServer();
    const f = server.createDatabase(1);
    const database = server.database(f.databaseId);
    const item = { ...field(type), tableId: f.tableId };
    database.schema.fields.push(item);
    const row = { ...database.rows(f.tableId).get(f.recordId(0))!, values: { [item.id]: value } };
    database.rows(f.tableId).set(row);
    const session = await openDatabase(f.databaseId, server.deps());
    sessions.push(session);
    const anchor = document.createElement('div');
    document.body.append(anchor);
    const request: EditorProps['request'] = {
      anchor,
      initialText: null,
      row,
      cell: { row: 0, col: 0 },
      column: { id: item.id, width: 180, edit: 'custom' },
      done: vi.fn(),
      cancel: vi.fn(),
    };
    act(() => {
      const dispose = mountEditor(request, {
        field: item,
        session,
        format,
        canEditOptions: false,
        apply: (next) =>
          session.run([
            {
              kind: 'record.update',
              tableId: f.tableId,
              records: [{ id: row.id, values: { [item.id]: next } }],
            },
          ]),
        addOption: () => '',
      });
      disposals.push(() => {
        dispose();
        anchor.remove();
      });
    });
    return { request, saved: () => database.rows(f.tableId).get(row.id)?.values[item.id] };
  }

  it('saves JSON with Ctrl+Enter, and keeps broken JSON open with a message', async () => {
    const f = await mount('json', '{"a":1}');
    const box = (await screen.findByRole('textbox', { name: 'json' })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '{"a":' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(await screen.findByText(/This isn’t valid JSON/)).toBeDefined();
    expect(f.request.done).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '{"a": 2}' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(f.saved()).toBe('{"a":2}'));
    expect(f.request.done).toHaveBeenCalledWith('down');
  });

  it('applies each date range from its pickers without closing, and closes on Done', async () => {
    const f = await mount('dateRange', { start: '2026-09-21', end: '2026-09-24' });
    const user = userEvent.setup();
    const pickers = await screen.findAllByRole('button', { name: /Choose a date/ });
    await user.click(pickers[1]!);
    // The calendar opens over the editor, and choosing in it keeps the editor open.
    await user.click(screen.getByRole('button', { name: /Friday, September 25, 2026/ }));
    await waitFor(() => expect(f.saved()).toEqual({ start: '2026-09-21', end: '2026-09-25' }));
    expect(f.request.cancel).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(f.request.done).toHaveBeenCalledWith('down');
  });

  it('signs with a typed name and saves a place, each closing the editor', async () => {
    const signature = await mount('signature');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada{Enter}');
    await waitFor(() => expect(signature.saved()).toMatchObject({ drawing: null, name: 'Ada' }));
    expect(signature.request.done).toHaveBeenCalledWith('down');
    disposals.splice(0).forEach((dispose) => act(dispose));
    cleanup();
    const place = await mount('location');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Latitude, longitude' }), '1, 2{Enter}');
    await waitFor(() => expect(place.saved()).toEqual({ lat: 1, lng: 2, label: null }));
    expect(place.request.done).toHaveBeenCalledWith('down');
  });
});
