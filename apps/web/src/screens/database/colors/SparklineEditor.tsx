import { faXmark, faChartLine } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  Sparkline,
  SparklineType,
  isSparklineField,
  type ColorConfig,
  type FieldMeta,
} from '@riosoma/contracts';
import { Button, Checkbox, ListBoxItem, Select, Switch } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data/types';
import { FieldSelect } from '../view/FieldSelect';
import './sparklines.css';

export function SparklineEditor({
  fields,
  session,
  value,
  onChange,
}: {
  fields: readonly FieldMeta[];
  session?: DatabaseSession;
  value: ColorConfig;
  onChange(patch: Partial<ColorConfig>): void;
}) {
  const { t } = useLingui();
  const available = fields.filter(
    (field) => isSparklineField(field) && !value.sparklines.some((setting) => setting.fieldId === field.id),
  );
  const heading = t({ id: 'views.sparkline.heading', message: 'Sparklines' });
  const types = {
    line: t({ id: 'views.sparkline.line', message: 'Line' }),
    column: t({ id: 'views.sparkline.column', message: 'Column' }),
    winLoss: t({ id: 'views.sparkline.winLoss', message: 'Win and loss' }),
  };
  const highlights = {
    first: t({ id: 'views.sparkline.first', message: 'Highlight first' }),
    last: t({ id: 'views.sparkline.last', message: 'Highlight last' }),
    min: t({ id: 'views.sparkline.min', message: 'Highlight minimum' }),
    max: t({ id: 'views.sparkline.max', message: 'Highlight maximum' }),
  };
  const colors = {
    accent: t({ id: 'views.sparkline.accent', message: 'Accent' }),
    blue: t({ id: 'views.color.name.blue', message: 'Blue' }),
    green: t({ id: 'views.color.name.green', message: 'Green' }),
    red: t({ id: 'views.color.name.red', message: 'Red' }),
    purple: t({ id: 'views.color.name.purple', message: 'Purple' }),
    gray: t({ id: 'views.color.name.gray', message: 'Gray' }),
  };
  return (
    <section className="rio-color-editor__section" aria-label={heading}>
      <h3 className="rio-color-editor__heading">{heading}</h3>
      {value.sparklines.map((setting) => {
        const field = fields.find((field) => field.id === setting.fieldId);
        const schema = session?.getSchema();
        const link =
          field && (field.type === 'lookup' || field.type === 'rollup')
            ? schema?.fieldById.get(field.options.linkFieldId)
            : undefined;
        const linked = link?.type === 'link' ? (schema?.fields.get(link.options.linkedTableId) ?? []) : [];
        const orderFields = linked.filter(
          (field) => field.type !== 'button' && (field.type !== 'formula' || field.options.sortable),
        );
        const change = (patch: Partial<Sparkline>) =>
          onChange({
            sparklines: value.sparklines.map((each) => (each === setting ? { ...setting, ...patch } : each)),
          });
        return (
          <div className="rio-sparkline-setting" role="group" aria-label={field?.name} key={setting.fieldId}>
            <div className="rio-view-row">
              <FieldSelect
                fields={field ? [field, ...available] : available}
                value={setting.fieldId}
                onChange={(fieldId) => change({ fieldId, order: null })}
              />
              <Select
                label={t({ id: 'views.sparkline.type', message: 'Chart type' })}
                selectedKey={setting.type}
                onSelectionChange={(key) => {
                  const parsed = SparklineType.safeParse(key);
                  if (parsed.success) change({ type: parsed.data });
                }}
              >
                {SparklineType.options.map((type) => (
                  <ListBoxItem id={type} key={type}>
                    {types[type]}
                  </ListBoxItem>
                ))}
              </Select>
              <Select
                label={t({ id: 'views.sparkline.color', message: 'Chart color' })}
                selectedKey={setting.color}
                onSelectionChange={(key) => {
                  const parsed = Sparkline.shape.color.safeParse(key);
                  if (parsed.success) change({ color: parsed.data });
                }}
              >
                {Sparkline.shape.color.removeDefault().options.map((color) => (
                  <ListBoxItem id={color} key={color}>
                    {colors[color]}
                  </ListBoxItem>
                ))}
              </Select>
              <Button
                variant="quiet"
                onPress={() => onChange({ sparklines: value.sparklines.filter((each) => each !== setting) })}
                aria-label={t({ id: 'views.sparkline.remove', message: 'Remove sparkline' })}
                icon={faXmark}
              />
            </div>
            <div className="rio-view-row">
              {(['first', 'last', 'min', 'max'] as const).map((point) => (
                <Checkbox
                  key={point}
                  isSelected={setting[point]}
                  onChange={(selected) => change({ [point]: selected })}
                >
                  {highlights[point]}
                </Checkbox>
              ))}
              <Switch isSelected={setting.sharedAxis} onChange={(sharedAxis) => change({ sharedAxis })}>
                {t({ id: 'views.sparkline.sharedAxis', message: 'Shared axis across rows' })}
              </Switch>
            </div>
            {link?.type === 'link' && (
              <div className="rio-view-row">
                <Select
                  label={t({ id: 'views.sparkline.order', message: 'Point order' })}
                  selectedKey={setting.order?.fieldId ?? 'linked'}
                  onSelectionChange={(key) =>
                    change({
                      order:
                        key === 'linked'
                          ? null
                          : { fieldId: String(key), direction: setting.order?.direction ?? 'asc' },
                    })
                  }
                >
                  <ListBoxItem id="linked">
                    {t({ id: 'views.sparkline.linkOrder', message: 'Linked record order' })}
                  </ListBoxItem>
                  {orderFields.map((field) => (
                    <ListBoxItem id={field.id} key={field.id}>
                      {field.name}
                    </ListBoxItem>
                  ))}
                </Select>
                {setting.order && (
                  <Select
                    label={t({ id: 'views.sparkline.direction', message: 'Order direction' })}
                    selectedKey={setting.order.direction}
                    onSelectionChange={(key) => {
                      if (setting.order && (key === 'asc' || key === 'desc'))
                        change({ order: { ...setting.order, direction: key } });
                    }}
                  >
                    <ListBoxItem id="asc">{t({ id: 'views.sort.asc', message: 'Ascending' })}</ListBoxItem>
                    <ListBoxItem id="desc">{t({ id: 'views.sort.desc', message: 'Descending' })}</ListBoxItem>
                  </Select>
                )}
              </div>
            )}
            {(!field || !isSparklineField(field)) && (
              <p className="rio-view-warning" data-invalid>
                {t({ id: 'views.sparkline.invalid', message: 'Choose a field with a list of numbers.' })}
              </p>
            )}
          </div>
        );
      })}
      <div className="rio-view-actions">
        <Button
          isDisabled={!available.length}
          onPress={() => {
            if (available[0])
              onChange({ sparklines: [...value.sparklines, Sparkline.parse({ fieldId: available[0].id })] });
          }}
          aria-label={t({ id: 'views.sparkline.add', message: 'Add sparkline' })}
          icon={faChartLine}
        />
      </div>
    </section>
  );
}
