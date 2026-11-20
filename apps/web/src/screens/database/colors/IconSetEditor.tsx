import { faXmark, faIcons } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  ICON_SET_GLYPHS,
  IconSetType,
  isBarField,
  type ColorConfig,
  type FieldMeta,
} from '@riosoma/contracts';
import { Button, ListBoxItem, NumberField, Select, TextField } from '@riosoma/ui';
import { FieldSelect } from '../view/FieldSelect';
import { iconBandLabel } from './iconLabels';

export function IconSetEditor({
  fields,
  value,
  onChange,
}: {
  fields: readonly FieldMeta[];
  value: ColorConfig;
  onChange: (patch: Partial<ColorConfig>) => void;
}) {
  const { t, i18n } = useLingui();
  const available = fields.filter(
    (field) => isBarField(field) && !value.iconSets.some((set) => set.fieldId === field.id),
  );
  const styles = {
    arrows: t({ id: 'views.color.icons.arrows', message: 'Arrows' }),
    flags: t({ id: 'views.color.icons.flags', message: 'Flags' }),
    ratings: t({ id: 'views.color.icons.ratings', message: 'Ratings' }),
  };
  const heading = t({ id: 'views.color.icons', message: 'Icon sets' });
  return (
    <section className="rio-color-editor__section" aria-label={heading}>
      <h3 className="rio-color-editor__heading">{heading}</h3>
      {value.iconSets.map((set) => {
        const field = fields.find((field) => field.id === set.fieldId);
        const change = (next: typeof set) =>
          onChange({ iconSets: value.iconSets.map((each) => (each === set ? next : each)) });
        return (
          <div className="rio-color-icon-setting" role="group" aria-label={field?.name} key={set.fieldId}>
            <div className="rio-view-row">
              <FieldSelect
                fields={field ? [field, ...available] : available}
                value={set.fieldId}
                onChange={(fieldId) => change({ ...set, fieldId })}
              />
              <Select
                label={t({ id: 'views.color.icons.style', message: 'Icon style' })}
                selectedKey={set.style}
                onSelectionChange={(key) => {
                  const parsed = IconSetType.safeParse(key);
                  if (parsed.success) change({ ...set, style: parsed.data });
                }}
              >
                {IconSetType.options.map((style) => (
                  <ListBoxItem id={style} key={style}>
                    {styles[style]}
                  </ListBoxItem>
                ))}
              </Select>
              <Button
                variant="quiet"
                onPress={() => onChange({ iconSets: value.iconSets.filter((each) => each !== set) })}
                aria-label={t({ id: 'views.color.icons.remove', message: 'Remove icon set' })}
                icon={faXmark}
              />
            </div>
            <div className="rio-view-row">
              <NumberField
                label={t({ id: 'views.color.icons.middleThreshold', message: 'Middle threshold' })}
                value={set.thresholds[0]}
                maxValue={set.thresholds[1]}
                formatOptions={{ maximumFractionDigits: 20 }}
                onChange={(low) => {
                  if (Number.isFinite(low) && low <= set.thresholds[1])
                    change({ ...set, thresholds: [low, set.thresholds[1]] });
                }}
              />
              <NumberField
                label={t({ id: 'views.color.icons.highThreshold', message: 'High threshold' })}
                value={set.thresholds[1]}
                minValue={set.thresholds[0]}
                formatOptions={{ maximumFractionDigits: 20 }}
                onChange={(high) => {
                  if (Number.isFinite(high) && high >= set.thresholds[0])
                    change({ ...set, thresholds: [set.thresholds[0], high] });
                }}
              />
            </div>
            <div className="rio-view-row">
              {([0, 1, 2] as const).map((index) => {
                const band = i18n.number(index + 1);
                return (
                  <div className="rio-color-icon-setting__label" key={index}>
                    <span aria-hidden="true">{ICON_SET_GLYPHS[set.style][index]}</span>
                    <TextField
                      label={t({ id: 'views.color.icons.label', message: `Band ${band} text alternative` })}
                      value={set.labels[index]}
                      placeholder={iconBandLabel(set, index, i18n)}
                      maxLength={100}
                      onChange={(label) => {
                        const labels = [...set.labels] as typeof set.labels;
                        labels[index] = label;
                        change({ ...set, labels });
                      }}
                    />
                  </div>
                );
              })}
            </div>
            {(!field || !isBarField(field)) && (
              <p className="rio-view-warning" data-invalid>
                {t({ id: 'views.color.icons.invalid', message: 'This field can’t have an icon set.' })}
              </p>
            )}
          </div>
        );
      })}
      <div className="rio-view-actions">
        <Button
          isDisabled={!available.length}
          onPress={() => {
            const field = available[0];
            if (field)
              onChange({
                iconSets: [
                  ...value.iconSets,
                  { fieldId: field.id, style: 'arrows', thresholds: [0, 100], labels: ['', '', ''] },
                ],
              });
          }}
          aria-label={t({ id: 'views.color.icons.add', message: 'Add icon set' })}
          icon={faIcons}
        />
      </div>
    </section>
  );
}
