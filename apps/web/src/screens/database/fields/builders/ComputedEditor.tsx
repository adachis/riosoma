import { useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import { formulaBuilder, type FormulaBuilder } from '@riosoma/formula';
import { ListBoxItem, Select, TextArea, TextField } from '@riosoma/ui';
import { checkFormula, formulaDisplay } from '../../../../data/formulas';
import { anchor } from '../../../../demos/anchors';
import { FormulaEditor } from '../FormulaEditor';
import { builderExpression, builderFields, builderFits, initialBuilder, type BuilderKind } from './model';
import './builders.css';

const names = {
  combine: msg({ id: 'field.builder.combine', message: 'Combine text' }),
  difference: msg({ id: 'field.builder.difference', message: 'Date difference' }),
  mapping: msg({ id: 'field.builder.mapping', message: 'If-then mapping' }),
  bucket: msg({ id: 'field.builder.bucket', message: 'Bucket a number' }),
  links: msg({ id: 'field.builder.links', message: 'Pick from links' }),
};

export function ComputedEditor(props: Parameters<typeof FormulaEditor>[0]) {
  const { t, i18n } = useLingui();
  const local = props.fields.filter((field) => field.tableId === props.tableId && field.id !== props.fieldId);
  const checked = checkFormula(
    props.options.expression,
    props.fields,
    props.fieldId,
    props.tables,
    props.tableId,
  );
  const match = 'ast' in checked ? formulaBuilder(checked.ast) : undefined;
  // Text areas normalize carriage returns, so these literals stay escaped in the formula editor.
  const hasCarriageReturn =
    match && Object.values(match).some((value) => typeof value === 'string' && value.includes('\r'));
  const recognized = match && !hasCarriageReturn && builderFits(match, local) ? match : undefined;
  const [builder, setBuilder] = useState<FormulaBuilder | undefined>(() => recognized);
  const [numeric, setNumeric] = useState(() =>
    recognized?.kind === 'bucket'
      ? String(recognized.boundary)
      : recognized?.kind === 'links'
        ? String(recognized.position)
        : '',
  );

  function change(next: FormulaBuilder) {
    setBuilder(next);
    const expression = builderExpression(next);
    const result = checkFormula(expression, props.fields, props.fieldId, props.tables, props.tableId);
    props.onChange({
      ...props.options,
      expression,
      ...('type' in result ? { resultType: result.type } : {}),
    });
  }
  function pick(kind: BuilderKind) {
    const next = recognized?.kind === kind ? recognized : initialBuilder(kind, local);
    setNumeric(
      next.kind === 'bucket' ? String(next.boundary) : next.kind === 'links' ? String(next.position) : '',
    );
    change(next);
  }
  function fieldControl(label: string, key: 'first' | 'second' | 'start' | 'end' | 'field', value: string) {
    if (!builder) return null;
    return (
      <Select
        label={label}
        selectedKey={value || null}
        onSelectionChange={(id) => {
          if (id !== null) change({ ...builder, [key]: String(id) });
        }}
      >
        {builderFields(builder.kind, local).map((field) => (
          <ListBoxItem key={field.id} id={field.id}>
            {field.name}
          </ListBoxItem>
        ))}
      </Select>
    );
  }
  function textControl(label: string, key: 'separator' | 'match' | 'then' | 'otherwise', value: string) {
    return (
      <TextArea
        label={label}
        value={value}
        rows={2}
        maxLength={1000}
        onChange={(value) => {
          if (builder) change({ ...builder, [key]: value });
        }}
      />
    );
  }
  const valid = !builder || (builderFits(builder, local) && 'ast' in checked);
  return (
    <div className="rio-computed-builder">
      <Select
        label={t({ id: 'field.builder.editAs', message: 'Edit as' })}
        selectedKey={builder?.kind ?? 'formula'}
        onSelectionChange={(key) => {
          if (key === 'formula') setBuilder(undefined);
          else if (key && key in names) pick(key as BuilderKind);
        }}
      >
        <ListBoxItem id="formula">{t({ id: 'field.type.formula', message: 'Formula' })}</ListBoxItem>
        {(Object.keys(names) as BuilderKind[]).map((kind) => (
          <ListBoxItem id={kind} key={kind} isDisabled={!builderFields(kind, local).length}>
            {i18n._(names[kind])}
          </ListBoxItem>
        ))}
      </Select>
      {builder ? (
        <>
          {builder.kind === 'combine' && (
            <>
              {fieldControl(t({ id: 'field.builder.first', message: 'First field' }), 'first', builder.first)}
              {textControl(
                t({ id: 'field.builder.separator', message: 'Separator' }),
                'separator',
                builder.separator,
              )}
              {fieldControl(
                t({ id: 'field.builder.second', message: 'Second field' }),
                'second',
                builder.second,
              )}
            </>
          )}
          {builder.kind === 'difference' && (
            <>
              {fieldControl(t({ id: 'field.builder.start', message: 'Start date' }), 'start', builder.start)}
              {fieldControl(t({ id: 'field.builder.end', message: 'End date' }), 'end', builder.end)}
              <Select
                label={t({ id: 'field.builder.unit', message: 'Unit' })}
                selectedKey={builder.unit}
                onSelectionChange={(unit) => {
                  if (unit === 'days' || unit === 'hours' || unit === 'minutes') change({ ...builder, unit });
                }}
              >
                <ListBoxItem id="days">{t({ id: 'field.builder.days', message: 'Days' })}</ListBoxItem>
                <ListBoxItem id="hours">{t({ id: 'field.builder.hours', message: 'Hours' })}</ListBoxItem>
                <ListBoxItem id="minutes">
                  {t({ id: 'field.builder.minutes', message: 'Minutes' })}
                </ListBoxItem>
              </Select>
            </>
          )}
          {(builder.kind === 'mapping' || builder.kind === 'bucket' || builder.kind === 'links') &&
            fieldControl(t({ id: 'field.builder.source', message: 'Source field' }), 'field', builder.field)}
          {builder.kind === 'mapping' &&
            textControl(
              t({ id: 'field.builder.match', message: 'If the value equals' }),
              'match',
              builder.match,
            )}
          {(builder.kind === 'bucket' || builder.kind === 'links') && (
            <TextField
              label={
                builder.kind === 'bucket'
                  ? t({ id: 'field.builder.boundary', message: 'If the number is below' })
                  : t({ id: 'field.builder.position', message: 'Link position (starts at 1)' })
              }
              inputMode={builder.kind === 'bucket' ? 'decimal' : 'numeric'}
              value={numeric}
              isInvalid={!valid}
              onChange={(value) => {
                setNumeric(value);
                const number = value.trim() === '' ? NaN : Number(value);
                change(
                  builder.kind === 'bucket'
                    ? { ...builder, boundary: number }
                    : { ...builder, position: number },
                );
              }}
            />
          )}
          {(builder.kind === 'mapping' || builder.kind === 'bucket') && (
            <>
              {textControl(t({ id: 'field.builder.then', message: 'Then return' }), 'then', builder.then)}
              {textControl(
                t({ id: 'field.builder.otherwise', message: 'Otherwise return' }),
                'otherwise',
                builder.otherwise,
              )}
            </>
          )}
          <TextField
            {...anchor('field.formula.expression')}
            label={t({ id: 'field.formula.expression', message: 'Formula' })}
            value={formulaDisplay(props.options.expression, props.fields, props.tables, props.tableId)}
            isReadOnly
          />
          <p role="status">
            {valid
              ? t({
                  id: 'field.builder.help',
                  message: 'This saves an ordinary formula.  Choose Formula to edit the expression directly.',
                })
              : t({
                  id: 'field.builder.invalid',
                  message: 'Choose compatible fields and enter a valid number.',
                })}
          </p>
        </>
      ) : (
        <FormulaEditor key="formula" {...props} />
      )}
    </div>
  );
}
