import { SparklineEditor } from '../colors/SparklineEditor';
import { useId, type CSSProperties } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  CHOICE_COLORS,
  checkCondition,
  COLOR_LIMITS,
  isBarField,
  isScaleField,
  operatorsForField,
  scaleValueFits,
  type ChoiceColor,
  type ColorConfig,
  type ColorRule,
  type ColorScale,
  type ColorStop,
  type DataBar,
  type FieldMeta,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  DatePicker,
  ListBoxItem,
  SegmentedControl,
  Select,
  Switch,
  TextField,
  SortableList,
  SortableItem,
  SortableDropZone,
  moveList,
} from '@riosoma/ui';
import { Icon } from '@riosoma/icons';
import {
  faChartColumn,
  faDroplet,
  faPlus,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { DatabaseSession } from '../../../data';
import { colorNames, conditionWords } from '../colors/labels';
import { lineColor } from '../colors/paint';
import { IconSetEditor } from '../colors/IconSetEditor';
import { FieldSelect } from './FieldSelect';
import { FilterValueEditor } from './FilterValueEditor';
import { ImmediateNumberField } from './ImmediateNumberField';
import { operatorLabels } from './messages';
import { changeField, emptyCollaborators, fitValue, newCondition, type Collaborators } from './filterValues';
import '../colors/colors.css';
import './view.css';

export interface ColorEditorProps {
  fields: readonly FieldMeta[];
  session?: DatabaseSession;
  primaryFieldId?: string;
  collaborators?: Collaborators;
  value: ColorConfig;
  /** Each key given replaces that list */
  onChange: (patch: Partial<ColorConfig>) => void;
}

/** The order new rules take their colors in, so neighbors start out different. */
const NEW_COLORS: readonly ChoiceColor[] = [
  'red',
  'green',
  'yellow',
  'blue',
  'orange',
  'purple',
  'teal',
  'pink',
  'brown',
  'gray',
];

function unusedColor(used: readonly ChoiceColor[]): ChoiceColor {
  return NEW_COLORS.find((color) => !used.includes(color)) ?? 'red';
}

function Swatch({ color }: { color: ChoiceColor }) {
  return (
    <span
      className="rio-color-mark"
      style={
        { '--rio-color-mark': lineColor(color), '--rio-color-mark-line': lineColor(color) } as CSSProperties
      }
      aria-hidden="true"
    />
  );
}

function ColorSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ChoiceColor;
  onChange: (color: ChoiceColor) => void;
}) {
  const { i18n } = useLingui();
  return (
    <span className="rio-color-editor__color">
      <Swatch color={value} />
      <Select
        aria-label={label}
        selectedKey={value}
        onSelectionChange={(key) => {
          const color = CHOICE_COLORS.find((each) => each === key);
          if (color) onChange(color);
        }}
      >
        {CHOICE_COLORS.map((color) => (
          <ListBoxItem key={color} id={color} textValue={i18n._(colorNames[color])}>
            <span className="rio-color-editor__option">
              <Swatch color={color} />
              {i18n._(colorNames[color])}
            </span>
          </ListBoxItem>
        ))}
      </Select>
    </span>
  );
}

function RuleRow({
  rule,
  fields,
  session,
  collaborators,
  describe,
  onChange,
  onRemove,
}: {
  rule: ColorRule;
  fields: readonly FieldMeta[];
  session?: DatabaseSession;
  collaborators: Collaborators;
  describe: (rule: ColorRule) => string;
  onChange: (rule: ColorRule) => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useLingui();
  const warningId = useId();
  const field = fields.find((field) => field.id === rule.condition.fieldId);
  const invalid = !checkCondition(field, rule.condition).valid;
  const words = describe(rule);
  return (
    <div
      className="rio-color-rule"
      role="group"
      aria-label={rule.name.trim() || words}
      aria-describedby={invalid ? warningId : undefined}
    >
      <div className="rio-view-row">
        <ColorSelect
          label={t({ id: 'views.color.rule.color', message: 'Color' })}
          value={rule.color}
          onChange={(color) => onChange({ ...rule, color })}
        />
        <SegmentedControl
          className="rio-view-segments"
          label={t({ id: 'views.color.rule.target', message: 'Apply to' })}
          selectedId={rule.target}
          items={[
            { id: 'cell', label: t({ id: 'views.color.rule.cell', message: 'Cell' }) },
            { id: 'record', label: t({ id: 'views.color.rule.record', message: 'Record' }) },
          ]}
          onChange={(target) => {
            if (target === 'cell' || target === 'record') onChange({ ...rule, target });
          }}
        />
        <div className="rio-color-rule__name">
          <TextField
            aria-label={t({ id: 'views.color.rule.name', message: 'Name' })}
            placeholder={words}
            value={rule.name}
            maxLength={COLOR_LIMITS.nameLength}
            onChange={(name) => onChange({ ...rule, name })}
          />
        </div>
        <Button
          icon={faXmark}
          variant="quiet"
          aria-label={t({ id: 'views.color.rule.remove', message: 'Remove rule' })}
          onPress={onRemove}
        />
      </div>
      <div className="rio-view-row rio-color-rule__condition">
        <span className="rio-view-lead">{t({ id: 'views.color.rule.when', message: 'When' })}</span>
        <FieldSelect
          fields={fields}
          value={rule.condition.fieldId}
          onChange={(id) => {
            const next = fields.find((field) => field.id === id);
            if (next) onChange({ ...rule, condition: changeField(rule.condition, next) });
          }}
        />
        <Select
          aria-label={t({ id: 'views.color.rule.operator', message: 'Condition' })}
          isDisabled={!field}
          selectedKey={rule.condition.operator}
          onSelectionChange={(key) => {
            const operator = field && operatorsForField(field).find((operator) => operator === key);
            if (field && operator)
              onChange({ ...rule, condition: fitValue({ ...rule.condition, operator }, field) });
          }}
        >
          {(field ? operatorsForField(field) : [rule.condition.operator]).map((operator) => (
            <ListBoxItem key={operator} id={operator}>
              {i18n._(operatorLabels[operator])}
            </ListBoxItem>
          ))}
        </Select>
        <div className="rio-view-condition-value">
          {field && (
            <FilterValueEditor
              key={`${field.id}:${rule.condition.operator}`}
              field={field}
              session={session}
              condition={rule.condition}
              collaborators={collaborators}
              readOnly={false}
              onChange={(value) => {
                if (value === undefined) {
                  const { value: _value, ...condition } = rule.condition;
                  onChange({ ...rule, condition });
                } else onChange({ ...rule, condition: { ...rule.condition, value } });
              }}
            />
          )}
        </div>
      </div>
      <div
        className="rio-view-warning"
        data-invalid={invalid || undefined}
        id={warningId}
        aria-hidden={!invalid}
      >
        <Icon icon={faTriangleExclamation} />
        {t({
          id: 'views.color.rule.doesNotApply',
          message: 'This condition doesn’t fit its field, so it colors nothing.',
        })}
      </div>
    </div>
  );
}

function StopValue({
  field,
  stop,
  label,
  onChange,
}: {
  field: FieldMeta | undefined;
  stop: ColorStop;
  label: string;
  onChange: (value: ColorStop['value']) => void;
}) {
  if (field?.type === 'date')
    return (
      <DatePicker
        aria-label={label}
        value={typeof stop.value === 'string' ? stop.value : null}
        onChange={(day) => onChange(day || null)}
      />
    );
  return (
    <ImmediateNumberField
      label={label}
      value={typeof stop.value === 'number' ? stop.value : undefined}
      onChange={(value) => onChange(value ?? null)}
    />
  );
}

function ScaleRow({
  scale,
  fields,
  available,
  onChange,
  onRemove,
}: {
  scale: ColorScale;
  fields: readonly FieldMeta[];
  available: readonly FieldMeta[];
  onChange: (scale: ColorScale) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const field = fields.find((field) => field.id === scale.fieldId);
  const fits =
    !!field &&
    isScaleField(field) &&
    scale.stops.every((stop) => stop.value === null || scaleValueFits(field, stop.value));
  const [low, high] = [scale.stops[0]!, scale.stops.at(-1)!];
  const middle = scale.stops.length === 3 ? scale.stops[1]! : null;
  const stops: Array<{ stop: ColorStop; index: number; color: string; value: string; placeholder: string }> =
    [
      {
        stop: low,
        index: 0,
        color: t({ id: 'views.color.scale.lowColor', message: 'Lowest color' }),
        value: t({ id: 'views.color.scale.lowValue', message: 'Lowest value' }),
        placeholder: t({ id: 'views.color.scale.lowest', message: 'Lowest' }),
      },
      ...(middle
        ? [
            {
              stop: middle,
              index: 1,
              color: t({ id: 'views.color.scale.middleColor', message: 'Middle color' }),
              value: t({ id: 'views.color.scale.middleValue', message: 'Middle value' }),
              placeholder: t({ id: 'views.color.scale.halfway', message: 'Halfway' }),
            },
          ]
        : []),
      {
        stop: high,
        index: scale.stops.length - 1,
        color: t({ id: 'views.color.scale.highColor', message: 'Highest color' }),
        value: t({ id: 'views.color.scale.highValue', message: 'Highest value' }),
        placeholder: t({ id: 'views.color.scale.highest', message: 'Highest' }),
      },
    ];
  const replace = (index: number, stop: ColorStop) =>
    onChange({ ...scale, stops: scale.stops.map((each, i) => (i === index ? stop : each)) });
  return (
    <div className="rio-color-scale" role="group" aria-label={field?.name}>
      <div className="rio-view-row">
        <FieldSelect
          fields={field ? [field, ...available.filter((each) => each.id !== field.id)] : available}
          value={scale.fieldId}
          onChange={(fieldId) => {
            const next = fields.find((each) => each.id === fieldId);
            // Fixed values belong to one kind of field, so a new field starts from the view's range.
            if (next)
              onChange({
                fieldId,
                stops: scale.stops.map((stop) =>
                  stop.value !== null && scaleValueFits(next, stop.value) ? stop : { ...stop, value: null },
                ),
              });
          }}
        />
        <Checkbox
          isSelected={middle !== null}
          onChange={(on) =>
            onChange({
              ...scale,
              stops: on ? [low, { color: 'yellow', value: null }, high] : [low, high],
            })
          }
        >
          {t({ id: 'views.color.scale.middle', message: 'Middle color' })}
        </Checkbox>
        <Button
          icon={faXmark}
          variant="quiet"
          aria-label={t({ id: 'views.color.scale.remove', message: 'Remove color scale' })}
          onPress={onRemove}
        />
      </div>
      {stops.map(({ stop, index, color, value, placeholder }) => (
        <div className="rio-view-row rio-color-scale__stop" key={index}>
          <span className="rio-view-lead">{placeholder}</span>
          <ColorSelect
            label={color}
            value={stop.color}
            onChange={(next) => replace(index, { ...stop, color: next })}
          />
          <div className="rio-color-scale__value">
            <StopValue
              field={field}
              stop={stop}
              label={value}
              onChange={(next) => replace(index, { ...stop, value: next })}
            />
          </div>
        </div>
      ))}
      <p className="rio-color-editor__hint">
        {t({
          id: 'views.color.scale.hint',
          message: 'Leave a value empty to follow the lowest and highest values in the view.',
        })}
      </p>
      <div className="rio-view-warning" data-invalid={!fits || undefined} aria-hidden={fits}>
        <Icon icon={faTriangleExclamation} />
        {t({ id: 'views.color.scale.doesNotApply', message: 'This field can’t have a color scale.' })}
      </div>
    </div>
  );
}

function BarRow({
  bar,
  fields,
  available,
  onChange,
  onRemove,
}: {
  bar: DataBar;
  fields: readonly FieldMeta[];
  available: readonly FieldMeta[];
  onChange: (bar: DataBar) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const field = fields.find((field) => field.id === bar.fieldId);
  const fits = !!field && isBarField(field);
  return (
    <div className="rio-color-bar-setting" role="group" aria-label={field?.name}>
      <div className="rio-view-row">
        <FieldSelect
          fields={field ? [field, ...available.filter((each) => each.id !== field.id)] : available}
          value={bar.fieldId}
          onChange={(fieldId) => onChange({ ...bar, fieldId })}
        />
        <ColorSelect
          label={t({ id: 'views.color.bar.color', message: 'Bar color' })}
          value={bar.color}
          onChange={(color) => onChange({ ...bar, color })}
        />
        <Switch isSelected={bar.showValue} onChange={(showValue) => onChange({ ...bar, showValue })}>
          {t({ id: 'views.color.bar.showValue', message: 'Show the number' })}
        </Switch>
        <Button
          icon={faXmark}
          variant="quiet"
          aria-label={t({ id: 'views.color.bar.remove', message: 'Remove data bar' })}
          onPress={onRemove}
        />
      </div>
      <div className="rio-view-warning" data-invalid={!fits || undefined} aria-hidden={fits}>
        <Icon icon={faTriangleExclamation} />
        {t({ id: 'views.color.bar.doesNotApply', message: 'This field can’t have a data bar.' })}
      </div>
    </div>
  );
}

/**
 * Conditional colors for a view: rules that color cells or whole records, in order, and color
 * scales and data bars for number and date fields.  It works like the filter editor, and every
 * change shows on the view at once.
 */
export function ColorEditor({
  fields,
  session,
  primaryFieldId,
  collaborators = emptyCollaborators,
  value,
  onChange,
}: ColorEditorProps) {
  const { t, i18n } = useLingui();
  const headings = { rules: useId(), scales: useId(), bars: useId() };
  const format = {
    locale: i18n.locale || 'en-US',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    collaborators,
    linked: session?.linked,
  };
  const describe = (rule: ColorRule) =>
    conditionWords(
      rule.condition,
      fields.find((field) => field.id === rule.condition.fieldId),
      format,
      i18n,
    );
  const rules = value.colorRules;
  const firstField = fields.find((field) => field.id === primaryFieldId) ?? fields[0];
  const scaled = new Set(value.colorScales.map((scale) => scale.fieldId));
  const barred = new Set(value.dataBars.map((bar) => bar.fieldId));
  const scaleFields = fields.filter((field) => isScaleField(field) && !scaled.has(field.id));
  const barFields = fields.filter((field) => isBarField(field) && !barred.has(field.id));

  function reorder(from: number, to: number) {
    if (from !== to && from >= 0 && to >= 0 && to < rules.length)
      onChange({ colorRules: [...moveList(rules, from, to)] });
  }

  return (
    <div className="rio-view-editor rio-color-editor">
      <SparklineEditor fields={fields} session={session} value={value} onChange={onChange} />
      <IconSetEditor fields={fields} value={value} onChange={onChange} />
      <section className="rio-color-editor__section" aria-labelledby={headings.rules}>
        <h3 className="rio-color-editor__heading" id={headings.rules}>
          {t({ id: 'views.color.rules', message: 'Rules' })}
        </h3>
        {rules.length === 0 ? (
          <p className="rio-color-editor__hint">
            {t({
              id: 'views.color.rules.none',
              message: 'No rules yet.  The first rule that matches colors each cell or record.',
            })}
          </p>
        ) : null}
        <SortableList
          items={rules.map((rule) => ({
            id: rule.id,
            name: rule.name.trim() || describe(rule),
            handleLabel: t({ id: 'views.color.rule.move', message: 'Move rule' }),
          }))}
          onMove={reorder}
        >
          {rules.map((rule) => (
            <SortableItem id={rule.id} key={rule.id} className="rio-color-editor__entry">
              <RuleRow
                rule={rule}
                fields={fields}
                session={session}
                collaborators={collaborators}
                describe={describe}
                onChange={(next) =>
                  onChange({ colorRules: rules.map((each) => (each.id === rule.id ? next : each)) })
                }
                onRemove={() => onChange({ colorRules: rules.filter((each) => each.id !== rule.id) })}
              />
            </SortableItem>
          ))}
          <SortableDropZone />
        </SortableList>
        <div className="rio-view-actions">
          <Button
            icon={faPlus}
            isDisabled={rules.length >= COLOR_LIMITS.rules || !firstField}
            onPress={() => {
              if (!firstField || rules.length >= COLOR_LIMITS.rules) return;
              onChange({
                colorRules: [
                  ...rules,
                  {
                    id: crypto.randomUUID().replaceAll('-', ''),
                    name: '',
                    target: 'cell',
                    condition: newCondition(firstField),
                    color: unusedColor(rules.map((rule) => rule.color)),
                  },
                ],
              });
            }}
            aria-label={t({ id: 'views.color.rules.add', message: 'Add rule' })}
          />
        </div>
      </section>

      <section className="rio-color-editor__section" aria-labelledby={headings.scales}>
        <h3 className="rio-color-editor__heading" id={headings.scales}>
          {t({ id: 'views.color.scales', message: 'Color scales' })}
        </h3>
        {value.colorScales.map((scale) => (
          <ScaleRow
            key={scale.fieldId}
            scale={scale}
            fields={fields}
            available={scaleFields}
            onChange={(next) =>
              onChange({ colorScales: value.colorScales.map((each) => (each === scale ? next : each)) })
            }
            onRemove={() => onChange({ colorScales: value.colorScales.filter((each) => each !== scale) })}
          />
        ))}
        <div className="rio-view-actions">
          <Button
            icon={faDroplet}
            isDisabled={!scaleFields.length}
            onPress={() => {
              const field = scaleFields[0];
              if (field)
                onChange({
                  colorScales: [
                    ...value.colorScales,
                    {
                      fieldId: field.id,
                      stops: [
                        { color: 'red', value: null },
                        { color: 'green', value: null },
                      ],
                    },
                  ],
                });
            }}
            aria-label={t({ id: 'views.color.scales.add', message: 'Add color scale' })}
          />
        </div>
      </section>

      <section className="rio-color-editor__section" aria-labelledby={headings.bars}>
        <h3 className="rio-color-editor__heading" id={headings.bars}>
          {t({ id: 'views.color.bars', message: 'Data bars' })}
        </h3>
        {value.dataBars.map((bar) => (
          <BarRow
            key={bar.fieldId}
            bar={bar}
            fields={fields}
            available={barFields}
            onChange={(next) =>
              onChange({ dataBars: value.dataBars.map((each) => (each === bar ? next : each)) })
            }
            onRemove={() => onChange({ dataBars: value.dataBars.filter((each) => each !== bar) })}
          />
        ))}
        <div className="rio-view-actions">
          <Button
            icon={faChartColumn}
            isDisabled={!barFields.length}
            onPress={() => {
              const field = barFields[0];
              if (field)
                onChange({
                  dataBars: [...value.dataBars, { fieldId: field.id, color: 'blue', showValue: true }],
                });
            }}
            aria-label={t({ id: 'views.color.bars.add', message: 'Add data bar' })}
          />
        </div>
      </section>
    </div>
  );
}
