import { useLingui } from '@lingui/react/macro';
import { NumberField } from '@riosoma/ui';

export function ImmediateNumberField({
  value,
  onChange,
  label,
  readOnly = false,
  minValue,
  maxValue,
}: {
  value: unknown;
  onChange: (value: number | undefined) => void;
  label: string;
  readOnly?: boolean;
  minValue?: number;
  maxValue?: number;
}) {
  const { i18n } = useLingui();
  function report(value: number) {
    if (!readOnly) onChange(Number.isFinite(value) ? value : undefined);
  }
  return (
    <div
      onInputCapture={(event) => {
        if (readOnly || !(event.target instanceof HTMLInputElement)) return;
        // NumberField commits on blur; filters also need each intermediate numeric value.
        const format = new Intl.NumberFormat(i18n.locale);
        const parts = format.formatToParts(-12345.6);
        let text = event.target.value;
        for (let digit = 0; digit <= 9; digit++) text = text.replaceAll(format.format(digit), String(digit));
        for (const part of parts) {
          if (part.type === 'group') text = text.replaceAll(part.value, '');
          if (part.type === 'decimal') text = text.replaceAll(part.value, '.');
          if (part.type === 'minusSign') text = text.replaceAll(part.value, '-');
          if (part.type === 'literal') text = text.replaceAll(part.value, '');
        }
        report(text.trim() === '' ? NaN : Number(text));
      }}
    >
      <NumberField
        aria-label={label}
        value={typeof value === 'number' ? value : NaN}
        onChange={report}
        isDisabled={readOnly}
        minValue={minValue}
        maxValue={maxValue}
        formatOptions={{ useGrouping: false, maximumFractionDigits: 20 }}
      />
    </div>
  );
}
