import { cleanup, createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, formatTimeOfDay } from '@riosoma/contracts';
import { renderField } from '../screens/database/fields/fieldTestUtils';
import { MoreFieldInput } from './MoreFieldInput';
import { parseText } from '../grid/parse';
import { formatCell } from '../grid/format';
import { FilterValueEditor } from '../screens/database/view/FilterValueEditor';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react';
import { FieldButton } from './FieldButton';

const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };
const field = (type: string, options = {}) =>
  FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Value',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
    options,
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('additional field controls', () => {
  it('clears an invalid time draft when an external value arrives', () => {
    const time = field('time', { timeFormat: '24h' });
    if (time.type !== 'time') throw new Error();
    const change = vi.fn();
    const mounted = renderField(
      <MoreFieldInput field={time} value="14:30:00" format={format} onChange={change} />,
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Value' });
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    mounted.rerender(
      <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
        <MoreFieldInput field={time} value="15:45:00" format={format} onChange={change} />
      </I18nProvider>,
    );
    expect(input.value).toBe('15:45:00');
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it('marks an invalid time draft without replacing the stored time', () => {
    const time = field('time', { timeFormat: '24h' });
    if (time.type !== 'time') throw new Error();
    const change = vi.fn();
    renderField(<MoreFieldInput field={time} value="14:30:00" format={format} onChange={change} />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Value' });
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.blur(input);
    expect(change).not.toHaveBeenCalled();
    expect(input.value).toBe('invalid');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')?.split(/\s+/)).toContain(screen.getByRole('alert').id);
    fireEvent.change(input, { target: { value: '15:45' } });
    fireEvent.blur(input);
    expect(change).toHaveBeenCalledWith('15:45:00');
    expect(input.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('keeps typed barcode entry available without camera support', () => {
    const barcode = field('barcode');
    if (barcode.type !== 'barcode') throw new Error();
    const change = vi.fn();
    renderField(<MoreFieldInput field={barcode} value={null} format={format} onChange={change} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '000123' } });
    fireEvent.blur(screen.getByRole('textbox'));
    expect(change).toHaveBeenCalledWith('000123');
    expect(screen.queryByRole('button', { name: 'Scan barcode' })).toBeNull();
  });

  it('releases a camera granted after its editor closes', async () => {
    let grant!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn();
      },
    );
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            grant = resolve;
          }),
      },
    });
    const barcode = field('barcode');
    if (barcode.type !== 'barcode') throw new Error();
    const mounted = renderField(
      <MoreFieldInput field={barcode} value={null} format={format} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    await waitFor(() => expect(grant).toBeTypeOf('function'));
    mounted.unmount();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it('scans camera frames while the preview has not finished starting', async () => {
    const stop = vi.fn();
    const onChange = vi.fn();
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        detect = vi.fn(async () => [{ rawValue: '000987' }]);
      },
    );
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [{ stop }] }) as unknown as MediaStream,
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => {});
    // The preview already holds a frame, but play() never settles.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => new Promise<void>(() => {}));
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    const barcode = field('barcode');
    if (barcode.type !== 'barcode') throw new Error();
    renderField(<MoreFieldInput field={barcode} value={null} format={format} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan barcode' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(stop).toHaveBeenCalled();
  });

  it('round-trips time and currency text through the same rules as imports', () => {
    expect(parseText(field('barcode'), '000123', format)).toEqual({ ok: true, value: '000123' });
    const time = field('time', { timeFormat: '12h' });
    const money = field('multiCurrency');
    expect(parseText(time, formatCell(time, '14:30:00', format), format)).toEqual({
      ok: true,
      value: '14:30:00',
    });
    const value = { amount: 12.5, code: 'EUR' };
    expect(parseText(money, formatCell(money, value, format), format)).toEqual({ ok: true, value });
    const german = { ...format, locale: 'de' };
    expect(parseText(money, formatCell(money, value, german), german)).toEqual({ ok: true, value });
    expect(parseText(field('changeLog'), 'forged', format)).toEqual({ ok: false, reason: 'computed' });
  });

  it('requests an action from a keyboard-accessible button', () => {
    const button = field('button', { action: { kind: 'runScript', scriptId: 'scr00000000000001' } });
    if (button.type !== 'button') throw new Error();
    const run = vi.fn();
    window.addEventListener('rio-button-run', run);
    renderField(
      <FieldButton
        field={button}
        row={{
          id: 'rec00000000000001',
          values: {},
          createdAt: '',
          createdBy: null,
          updatedAt: '',
          updatedBy: null,
        }}
        format={format}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Value' }));
    expect(run).toHaveBeenCalledOnce();
    window.removeEventListener('rio-button-run', run);
  });
});

it.each(['ja', 'ko', 'ar-EG'])(
  'normalizes localized time filters in %s and keeps Enter inside the editor',
  (locale) => {
    const change = vi.fn();
    const submit = vi.fn((event) => event.preventDefault());
    const clock = field('time', { timeFormat: '12h' });
    const i18n = setupI18n({ locale, messages: { [locale]: {} } });
    render(
      <I18nProvider i18n={i18n}>
        <form onSubmit={submit}>
          <FilterValueEditor
            field={clock}
            condition={{ id: 'clock', fieldId: clock.id, operator: 'is' }}
            collaborators={new Map()}
            readOnly={false}
            onChange={change}
          />
        </form>
      </I18nProvider>,
    );
    const control = screen.getByRole('textbox');
    fireEvent.change(control, { target: { value: formatTimeOfDay('14:45:00', locale, '12h') } });
    const enter = createEvent.keyDown(control, { key: 'Enter', cancelable: true });
    fireEvent(control, enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(change).toHaveBeenLastCalledWith('14:45:00');
    expect(submit).not.toHaveBeenCalled();
  },
);

it('uses the default currency when pasting a bare localized amount', () => {
  expect(parseText(field('multiCurrency', { code: 'EUR' }), '12,50', { ...format, locale: 'de' })).toEqual({
    ok: true,
    value: { code: 'EUR', amount: 12.5 },
  });
});

it('formats structured history in the reader time zone without showing an unknown actor id', () => {
  const log = field('changeLog');
  const title = field('text');
  const unknown = 'usr00000000000002';
  const value = [{ at: '2026-09-30T14:00:00Z', actorId: unknown, fieldIds: [title.id] }];
  const shown = formatCell(log, value, {
    ...format,
    timeZone: 'America/Los_Angeles',
    fieldsById: new Map([[title.id, title]]),
  });
  expect(shown).toContain('7:00');
  expect(shown).toContain('Value');
  expect(shown).not.toContain(unknown);
});

it('shows the configured currency precision after editing an amount', () => {
  const money = field('multiCurrency', { precision: 2 });
  if (money.type !== 'multiCurrency') throw new Error();
  const change = vi.fn();
  renderField(<MoreFieldInput field={money} value={null} format={format} onChange={change} />);
  const amount = screen.getByRole('textbox', { name: 'Amount' });
  fireEvent.change(amount, { target: { value: '10.005' } });
  fireEvent.blur(amount);
  expect(change).toHaveBeenLastCalledWith({ code: 'USD', amount: 10.01 });
  expect((amount as HTMLInputElement).value).toBe('10.01');
});
