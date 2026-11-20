import { useEffect, useId, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  checkCellValue,
  isMultiCurrencyValue,
  parseTimeOfDay,
  formatTimeOfDay,
  sameValue,
  type CellValue,
  type FieldMeta,
} from '@riosoma/contracts';
import { Button, ComboBox, ListBoxItem, NumberField, TextField } from '@riosoma/ui';
import { serverMessage } from '../messages/useServerMessage';
import type { FormatContext } from '../grid/format';
import './fields.css';

type MoreField = Extract<FieldMeta, { type: 'barcode' | 'time' | 'multiCurrency' }>;
type Detector = { detect(video: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };

function detectorType(): (new () => Detector) | undefined {
  return (globalThis as typeof globalThis & { BarcodeDetector?: new () => Detector }).BarcodeDetector;
}

/** Shared controls keep camera cleanup and value validation identical in forms and record layouts. */
export function MoreFieldInput({
  field,
  value,
  format,
  labelId,
  autoFocus,
  onChange,
}: {
  field: MoreField;
  value: CellValue;
  format: FormatContext;
  labelId?: string;
  autoFocus?: boolean;
  onChange(value: CellValue): void;
}) {
  const { t, i18n } = useLingui();
  const errorId = useId();
  const [source, setSource] = useState(value);
  const textOf = (current: CellValue) =>
    typeof current === 'string'
      ? field.type === 'time'
        ? formatTimeOfDay(current, format.locale, field.options.timeFormat)
        : current
      : '';
  const [text, setText] = useState(() => textOf(value));
  const [amount, setAmount] = useState(isMultiCurrencyValue(value) ? value.amount : NaN);
  const [code, setCode] = useState(
    isMultiCurrencyValue(value) ? value.code : field.type === 'multiCurrency' ? field.options.code : 'USD',
  );
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  if (!sameValue(source, value)) {
    setSource(value);
    setError('');
    setText(textOf(value));
    setAmount(isMultiCurrencyValue(value) ? value.amount : NaN);
    if (isMultiCurrencyValue(value)) setCode(value.code);
  }
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);

  function save(next: CellValue) {
    const checked = checkCellValue(field, next);
    setError(checked.ok ? '' : serverMessage(i18n, checked.messageKey));
    if (checked.ok && !sameValue(checked.value, value)) onChange(checked.value);
  }

  useEffect(() => {
    if (!scanning) return;
    let active = true;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => stream?.getTracks().forEach((track) => track.stop());
    const failed = () => {
      stop();
      if (active) {
        setScanning(false);
        setError(
          t({
            id: 'fields.barcode.cameraUnavailable',
            message: 'The camera could not scan this barcode.  You can type it instead.',
          }),
        );
      }
    };
    const start = async () => {
      const Constructor = detectorType();
      if (!Constructor) return failed();
      const detector = new Constructor();
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (!active) return stop();
      const preview = video.current;
      if (!preview) return stop();
      preview.srcObject = stream;
      // A camera preview can hold frames while play() is still pending, so scanning starts now
      // and waits for a frame below.  Refused playback still ends the scan.
      preview.play().catch(failed);
      const scan = async () => {
        if (!active) return;
        try {
          if (preview.readyState >= 2) {
            const found = (await detector.detect(preview)).find((item) => item.rawValue !== '');
            if (!active) return;
            if (found) {
              const checked = checkCellValue(field, found.rawValue);
              if (!checked.ok) return failed();
              setText(found.rawValue);
              change.current(checked.value);
              setScanning(false);
              stop();
              return;
            }
          }
          timer = setTimeout(() => {
            void scan();
          }, 150);
        } catch {
          failed();
        }
      };
      void scan();
    };
    void start().catch(failed);
    return () => {
      active = false;
      clearTimeout(timer);
      stop();
    };
  }, [scanning, field, t]);

  return (
    <div
      className="rio-more-field"
      role="group"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : field.name}
    >
      {field.type === 'multiCurrency' ? (
        <>
          <NumberField
            label={t({ id: 'fields.multiCurrency.amount', message: 'Amount' })}
            value={amount}
            autoFocus={autoFocus}
            minValue={field.options.allowNegative ? undefined : 0}
            formatOptions={{ maximumFractionDigits: field.options.precision }}
            onChange={(next) => {
              setAmount(next);
              save(Number.isNaN(next) ? null : { amount: next, code });
            }}
          />
          <ComboBox
            label={t({ id: 'field.currency.code', message: 'Currency' })}
            selectedKey={code}
            onSelectionChange={(key) => {
              if (key === null) return;
              setCode(String(key));
              if (!Number.isNaN(amount)) save({ amount, code: String(key) });
            }}
          >
            {Intl.supportedValuesOf('currency').map((currency) => (
              <ListBoxItem id={currency} key={currency}>
                {currency}
              </ListBoxItem>
            ))}
          </ComboBox>
        </>
      ) : (
        <TextField
          label={labelId ? undefined : field.name}
          aria-labelledby={labelId}
          autoFocus={autoFocus}
          value={text}
          isInvalid={field.type === 'time' && Boolean(error)}
          aria-describedby={field.type === 'time' && error ? errorId : undefined}
          description={
            field.type === 'time'
              ? t({ id: 'fields.time.entry', message: 'Enter a time, such as 14:30 or 2:30 PM.' })
              : undefined
          }
          onChange={setText}
          onBlur={() =>
            save(field.type === 'time' && text ? (parseTimeOfDay(text, format.locale) ?? text) : text)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save(field.type === 'time' && text ? (parseTimeOfDay(text, format.locale) ?? text) : text);
            }
          }}
        />
      )}
      {field.type === 'barcode' &&
        (scanning ? (
          <>
            <video
              className="rio-more-field__camera"
              ref={video}
              muted
              playsInline
              aria-label={t({ id: 'fields.barcode.preview', message: 'Barcode camera preview' })}
            />
            <Button onPress={() => setScanning(false)}>
              {t({ id: 'fields.barcode.stop', message: 'Stop scanning' })}
            </Button>
          </>
        ) : detectorType() && typeof navigator.mediaDevices?.getUserMedia === 'function' ? (
          <Button
            onPress={() => {
              setError('');
              setScanning(true);
            }}
          >
            {t({ id: 'fields.barcode.scan', message: 'Scan barcode' })}
          </Button>
        ) : (
          <p>
            {t({
              id: 'fields.barcode.typed',
              message: 'Type the barcode.  Camera scanning is unavailable in this browser.',
            })}
          </p>
        ))}
      {error && (
        <p id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
