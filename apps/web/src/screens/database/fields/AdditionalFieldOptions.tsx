import { useLingui } from '@lingui/react/macro';
import { DURATION_FORMATS, FieldOptions, RATING_ICONS } from '@riosoma/contracts';
import { ColorSwatchPicker, ComboBox, ListBoxItem, Select, Switch } from '@riosoma/ui';
import { durationText } from '../../../grid/format';
import { ratingIcons } from '../../../grid/ratingIcons';
import type { FieldOptionsFormProps } from './FieldOptionsForm';

export function AdditionalFieldOptions({ type, options, onChange }: FieldOptionsFormProps) {
  const { i18n, t } = useLingui();
  if (type === 'currency' || type === 'multiCurrency' || type === 'percent') {
    const number = FieldOptions[type].parse(options);
    const currency =
      type === 'currency' || type === 'multiCurrency' ? FieldOptions[type].parse(options) : null;
    const names = new Intl.DisplayNames(i18n.locale || 'en-US', { type: 'currency' });
    return (
      <>
        {currency && (
          <ComboBox
            label={t({ id: 'field.currency.code', message: 'Currency' })}
            placeholder={t({ id: 'field.currency.find', message: 'Find a currency' })}
            selectedKey={currency.code}
            onSelectionChange={(key) => {
              if (key !== null) onChange({ ...currency, code: String(key) });
            }}
          >
            {Intl.supportedValuesOf('currency').map((code) => {
              const name = `${code} — ${names.of(code) ?? code}`;
              return (
                <ListBoxItem key={code} id={code} textValue={name}>
                  {name}
                </ListBoxItem>
              );
            })}
          </ComboBox>
        )}
        <Select
          label={t({ id: 'field.number.decimals', message: 'Decimal places' })}
          selectedKey={number.precision}
          onSelectionChange={(key) => {
            if (key !== null) onChange({ ...number, precision: Number(key) });
          }}
        >
          {Array.from({ length: 9 }, (_, precision) => {
            const example = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: precision }).format(
              1,
            );
            return (
              <ListBoxItem key={precision} id={precision}>
                {t({ id: 'field.number.precisionExample', message: `${precision} (${example})` })}
              </ListBoxItem>
            );
          })}
        </Select>
        <Switch
          isSelected={number.allowNegative}
          onChange={(allowNegative) => onChange({ ...number, allowNegative })}
        >
          {t({ id: 'field.number.negative', message: 'Negative numbers' })}
        </Switch>
      </>
    );
  }
  if (type === 'duration') {
    const duration = FieldOptions.duration.parse(options);
    return (
      <Select
        label={t({ id: 'field.duration.format', message: 'Format' })}
        selectedKey={duration.format}
        onSelectionChange={(key) => {
          const result = FieldOptions.duration.safeParse({ format: key });
          if (result.success) onChange(result.data);
        }}
      >
        {DURATION_FORMATS.map((format) => {
          const example = durationText(5415.125, format);
          return (
            <ListBoxItem key={format} id={format}>
              {t({ id: 'field.duration.example', message: `${format} (${example})` })}
            </ListBoxItem>
          );
        })}
      </Select>
    );
  }
  if (type === 'rating') {
    const rating = FieldOptions.rating.parse(options);
    const labels = {
      star: t({ id: 'field.rating.icon.star', message: 'Star' }),
      heart: t({ id: 'field.rating.icon.heart', message: 'Heart' }),
      thumbsUp: t({ id: 'field.rating.icon.thumbsUp', message: 'Thumbs up' }),
      flag: t({ id: 'field.rating.icon.flag', message: 'Flag' }),
      circle: t({ id: 'field.rating.icon.circle', message: 'Circle' }),
    };
    return (
      <>
        <Select
          label={t({ id: 'field.rating.max', message: 'Maximum' })}
          selectedKey={rating.max}
          onSelectionChange={(key) => {
            if (key !== null) onChange({ ...rating, max: Number(key) });
          }}
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map((max) => (
            <ListBoxItem key={max} id={max}>
              {new Intl.NumberFormat(i18n.locale).format(max)}
            </ListBoxItem>
          ))}
        </Select>
        <Select
          label={t({ id: 'field.rating.icon', message: 'Icon' })}
          selectedKey={rating.icon}
          onSelectionChange={(key) => {
            const result = FieldOptions.rating.safeParse({ ...rating, icon: key });
            if (result.success) onChange(result.data);
          }}
        >
          {RATING_ICONS.map((icon) => (
            <ListBoxItem key={icon} id={icon} icon={ratingIcons[icon]}>
              {labels[icon]}
            </ListBoxItem>
          ))}
        </Select>
        <ColorSwatchPicker
          label={t({ id: 'field.rating.color', message: 'Color' })}
          value={rating.color}
          onChange={(color) => onChange({ ...rating, color })}
        />
      </>
    );
  }
  if (type === 'user') {
    const user = FieldOptions.user.parse(options);
    return (
      <>
        <Switch
          isSelected={user.allowMultiple}
          onChange={(allowMultiple) => onChange({ ...user, allowMultiple })}
        >
          {t({ id: 'field.user.multiple', message: 'Allow more than one person' })}
        </Switch>
        <Switch isSelected={user.notify} onChange={(notify) => onChange({ ...user, notify })}>
          {t({ id: 'field.user.notify', message: 'Notify people when they’re added' })}
        </Switch>
      </>
    );
  }
  if (type === 'autoNumber')
    return (
      <p>
        {t({
          id: 'field.autoNumber.note',
          message: 'Numbers each record in the order it was created.  Numbers are never reused.',
        })}
      </p>
    );
  return null;
}
